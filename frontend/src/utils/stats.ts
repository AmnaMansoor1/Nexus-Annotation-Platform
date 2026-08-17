import { doc, updateDoc, increment, setDoc, getDoc, runTransaction } from "firebase/firestore";
import { db } from "../firebase";
import { PlatformSummary } from "../types";

const SUMMARY_PATH = "stats/platform_summary";

export async function ensureSummaryExists() {
  const ref = doc(db, SUMMARY_PATH);
  const snap = await getDoc(ref);
  if (!snap.exists()) {
    const initial: PlatformSummary = {
      totalArticles: 0,
      completedArticles: 0,
      pendingArticles: 0,
      inProgressArticles: 0,
      totalAnnotators: 0,
      completedAnnotators: 0,
      avgBiasScore: 0,
      totalBiasScoreSum: 0,
      needsReview: 0
    };
    await setDoc(ref, initial);
  }
}

export async function updatePlatformStats(updates: Partial<{
  totalArticles: number;
  completedArticles: number;
  pendingArticles: number;
  inProgressArticles: number;
  totalAnnotators: number;
  completedAnnotators: number;
  avgBiasScore: number;
  totalBiasScoreSum: number;
  needsReview: number;
  categoryDistribution?: Record<string, number>;
}>) {
  const ref = doc(db, SUMMARY_PATH);
  const firebaseUpdates: any = {};
  
  // Sanitize category names to remove invalid Firestore field path characters
  const sanitizeCategory = (category: string) => {
    return category.replace(/[~*/[\]]/g, "_");
  };
  
  for (const [key, value] of Object.entries(updates)) {
    if (key === "categoryDistribution" && typeof value === "object") {
      // For category distribution, we use dot notation to increment specific keys
      for (const [category, count] of Object.entries(value)) {
        const sanitizedCategory = sanitizeCategory(category);
        firebaseUpdates[`categoryDistribution.${sanitizedCategory}`] = increment(count as number);
      }
    } else {
      firebaseUpdates[key] = increment(value as number);
    }
  }

  try {
    await updateDoc(ref, firebaseUpdates);
  } catch (e) {
    console.error("Error updating platform stats:", e);
    // If update fails because document doesn't exist, ensure it exists and try again
    await ensureSummaryExists();
    await updateDoc(ref, firebaseUpdates);
  }
}

/**
 * Atomically updates the platform stats when an article transitions to "complete"
 * and has a new bias_score computed.
 *
 * This replaces two separate Firestore operations with a single atomic
 * runTransaction on stats/platform_summary:
 *
 *   1. completedArticles  += 1       (via increment, atomic)
 *   2. totalBiasScoreSum  += biasScore (via increment, atomic)
 *   3. inProgressArticles -= 1 (if old status was "partial")
 *   4. pendingArticles    -= 1 (if old status was "pending")
 *   5. inProgressArticles += 1 (if new status is "partial")
 *   6. avgBiasScore = totalBiasScoreSum / completedArticles (computed inside transaction)
 *
 * COST IMPACT:
 *   BEFORE (buggy): One extra `getDocs(query(status=="complete"))` full-collection
 *     scan EVERY time an article completed. Read cost grew linearly from 1 to N
 *     as the project progressed: avg ~750 reads/call × 1,493 completions
 *     = ~1,120,000 reads = ~$6.72.
 *   AFTER (this function): Exactly 1 transaction on stats doc = 1 read + 1 write
 *     per completion, regardless of dataset size.
 *     = 1,493 reads + 1,493 writes = ~$0.018 total for this step.
 *
 * @param biasScore Newly computed continuous bias score (0.00–5.00) for the
 *                  article just completed. This will be added to the running sum.
 * @param prevStatus The previous `status` of the article before this completion
 *                   ("pending" | "partial" | undefined if unknown). Used to
 *                   atomically decrement pendingArticles/inProgressArticles so
 *                   the stats pie-chart counters stay consistent.
 * @param nextStatus The status this article is transitioning TO as part of this
 *                   save ("partial" on non-final annotations, "complete" on the
 *                   5th). If "partial", inProgressArticles gets +1 atomically
 *                   inside the same transaction. If "complete", completedArticles
 *                   + bias sum/avg get updated atomically.
 * @returns The new avgBiasScore after the transaction (for logging/debugging —
 *          caller typically doesn't need it).
 */
export async function syncBiasScoreAndStatsAtomically(
  biasScore: number,
  prevStatus: "pending" | "partial" | undefined,
  nextStatus: "partial" | "complete" | null
): Promise<number | null> {
  // Skip entirely if there's no status transition (nothing to update atomically).
  // The biasScore is only meaningful on a "complete" transition (5th annotation).
  if (!nextStatus) return null;

  const isCompletion = nextStatus === "complete";
  return runTransaction(db, async (transaction) => {
    const ref = doc(db, SUMMARY_PATH);
    const snap = await transaction.get(ref);
    if (!snap.exists()) {
      // If summary doc is brand-new (edge case right after initial upload),
      // initialize a minimal skeleton so the increments below resolve safely.
      const seed: PlatformSummary = {
        totalArticles: 0, completedArticles: 0, pendingArticles: 0,
        inProgressArticles: 0, totalAnnotators: 0, completedAnnotators: 0,
        avgBiasScore: 0, totalBiasScoreSum: 0, needsReview: 0,
      };
      transaction.set(ref, seed, { merge: true });
    }
    const base = (snap.exists() ? snap.data() : {}) as Partial<PlatformSummary>;

    // Compute the deltas we will atomically apply via increment().
    // Note: increment() is resolved server-side inside the transaction so two
    // simultaneous completions will never double-count.
    const deltas: Record<string, number> = {};
    if (prevStatus === "pending") deltas.pendingArticles = (deltas.pendingArticles ?? 0) - 1;
    if (prevStatus === "partial") deltas.inProgressArticles = (deltas.inProgressArticles ?? 0) - 1;
    if (nextStatus === "partial") deltas.inProgressArticles = (deltas.inProgressArticles ?? 0) + 1;
    if (isCompletion) {
      deltas.completedArticles = (deltas.completedArticles ?? 0) + 1;
      deltas.totalBiasScoreSum = (deltas.totalBiasScoreSum ?? 0) + biasScore;
    }

    // Build the update object — use increment() for numeric counters.
    const upd: any = {};
    for (const [k, v] of Object.entries(deltas)) {
      if (typeof v === "number" && v !== 0) upd[k] = increment(v);
    }

    // Compute new avgBiasScore deterministically AFTER the increments are applied.
    // completedArticles AFTER = (before or 0) + (delta if completion)
    const completedAfter =
      (base.completedArticles ?? 0) + (isCompletion ? 1 : 0);
    const totalSumAfter =
      (base.totalBiasScoreSum ?? 0) + (isCompletion ? biasScore : 0);
    const newAvg =
      completedAfter > 0 ? Math.round((totalSumAfter / completedAfter) * 100) / 100 : 0;
    upd.avgBiasScore = newAvg;

    if (Object.keys(upd).length > 0) {
      transaction.update(ref, upd);
    }
    return newAvg;
  });
}
