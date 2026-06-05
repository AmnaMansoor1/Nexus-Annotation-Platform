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
  needsReview: number;
  categoryDistribution?: Record<string, number>;
}>) {
  const ref = doc(db, SUMMARY_PATH);
  const firebaseUpdates: any = {};
  
  for (const [key, value] of Object.entries(updates)) {
    if (key === "categoryDistribution" && typeof value === "object") {
      // For category distribution, we use dot notation to increment specific keys
      for (const [category, count] of Object.entries(value)) {
        firebaseUpdates[`categoryDistribution.${category}`] = increment(count as number);
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
 * Recalculates average bias score across all completed articles
 * This is slightly more expensive but ensures accuracy
 */
export async function syncAverageBiasScore(newScore: number, totalRated: number) {
  await runTransaction(db, async (transaction) => {
    const ref = doc(db, SUMMARY_PATH);
    const snap = await transaction.get(ref);
    if (!snap.exists()) return;

    const data = snap.data() as PlatformSummary;
    const currentAvg = data.avgBiasScore || 0;
    const currentTotal = totalRated - 1; // Number of articles before this one

    const newAvg = ((currentAvg * currentTotal) + newScore) / totalRated;
    transaction.update(ref, { avgBiasScore: parseFloat(newAvg.toFixed(2)) });
  });
}
