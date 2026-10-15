import { collection, query, where, getDocs, doc, getDoc, limit, orderBy, runTransaction, increment, arrayUnion } from "firebase/firestore";
import { db } from "../firebase";
import { Article, AdminConfig } from "../types";
import { getRequiredAnnotations } from "./annotationConfig";
import { fetchAnnotatorContext, healArticles, AnnotatorContext } from "./reconcileArticle";

// Spread concurrent logins across a random window to reduce Firestore contention
const randomDelay = (min = 100, max = 800) =>
  new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * (max - min + 1) + min)));

const NON_RESPONSIVE_BUFFER = 2;

function normalizeArticle(data: any): Article {
  const statusVal = data?.status;
  const assignedCountVal = data?.assigned_count;
  const annotationCountVal = data?.annotation_count;
  return {
    ...(data || {}),
    assigned_to: Array.isArray(data?.assigned_to) ? data.assigned_to : [],
    annotated_by: Array.isArray(data?.annotated_by) ? data.annotated_by : [],
    is_gold_standard: !!data?.is_gold_standard,
    assigned_count: typeof assignedCountVal === "number" ? assignedCountVal : 0,
    annotation_count: typeof annotationCountVal === "number" ? annotationCountVal : 0,
    status: (statusVal === "pending" || statusVal === "partial" || statusVal === "complete") ? statusVal : "pending",
  } as Article;
}

function priorityCmp(a: Article, b: Article): number {
  const aStatus = a.status === "partial" ? 0 : a.status === "pending" ? 1 : 2;
  const bStatus = b.status === "partial" ? 0 : b.status === "pending" ? 1 : 2;
  if (aStatus !== bStatus) return aStatus - bStatus;
  if ((b.annotation_count ?? 0) !== (a.annotation_count ?? 0)) {
    return (b.annotation_count ?? 0) - (a.annotation_count ?? 0);
  }
  return ((a as any).sequence_number ?? 0) - ((b as any).sequence_number ?? 0);
}

export function isEligible(article: Article, email: string, requiredAnnotations: number): { ok: boolean; reason?: string } {
  const okStatus = article.status === "pending" || article.status === "partial";
  if (!okStatus) return { ok: false, reason: `status=${article.status}` };

  if (article.annotation_count >= requiredAnnotations && article.status !== "complete") {
    return { ok: false, reason: `consistency-err: status=${article.status} but annotation_count=${article.annotation_count}>=${requiredAnnotations}` };
  }
  if (article.status === "partial" && article.annotation_count === 0) {
    return { ok: false, reason: `consistency-err: status=partial but annotation_count=0` };
  }
  if (article.status === "pending" && article.annotation_count > 0) {
    return { ok: false, reason: `consistency-err: status=pending but annotation_count=${article.annotation_count}>0` };
  }

  const annStillNeeded = article.annotation_count < requiredAnnotations;
  const hardCap = annStillNeeded ? requiredAnnotations + NON_RESPONSIVE_BUFFER : requiredAnnotations;
  if (article.assigned_count >= hardCap) {
    return { ok: false, reason: `assigned_count=${article.assigned_count}>=cap=${hardCap}` };
  }

  const emailNorm = email.toLowerCase().trim();
  const assignedList = Array.isArray(article.assigned_to)
    ? article.assigned_to.map(e => String(e).toLowerCase().trim()) : [];
  if (assignedList.includes(emailNorm)) return { ok: false, reason: "already-assigned-to-me" };

  const annotatedList = Array.isArray(article.annotated_by)
    ? article.annotated_by.map(e => String(e).toLowerCase().trim()) : [];
  if (annotatedList.includes(emailNorm)) return { ok: false, reason: "already-annotated-by-me" };

  return { ok: true };
}

export interface SequentialSelectionResult {
  selected: string[];
  skipped_inconsistent: string[];
}

export function selectArticlesSequentially(
  articles: Article[],
  email: string,
  requiredAnnotations: number,
  maxToSelect: number
): SequentialSelectionResult {
  const skipped_inconsistent: string[] = [];
  const eligible: Article[] = [];
  const sorted = [...articles].sort(priorityCmp);

  for (const article of sorted) {
    const check = isEligible(article, email, requiredAnnotations);
    if (!check.ok) {
      if (check.reason?.startsWith("consistency-err")) {
        skipped_inconsistent.push(article.article_id);
      }
      continue;
    }
    eligible.push(article);
    if (eligible.length >= maxToSelect * 2) break;
  }

  const selected = eligible.slice(0, maxToSelect).map(a => a.article_id);
  return { selected, skipped_inconsistent };
}

/**
 * Atomically claims an assignment slot for one article.
 *
 * Uses runTransaction so the READ + eligibility-check + WRITE are a single
 * atomic operation. Two users racing on the same article will serialize:
 * the second writer re-reads after the first commit and only writes if the
 * slot is still open (assigned_count still below cap).
 *
 * Returns true when the slot was successfully claimed, false when the article
 * was already full by the time the transaction ran (caller should skip it).
 */
async function claimAssignmentSlot(
  articleId: string,
  email: string,
  adminConfig: AdminConfig | null
): Promise<boolean> {
  const articleRef = doc(db, "articles", articleId);
  try {
    return await runTransaction(db, async (tx) => {
      const snap = await tx.get(articleRef);
      if (!snap.exists()) return false;

      const current = normalizeArticle(snap.data());
      const required = getRequiredAnnotations(current, adminConfig);
      const check = isEligible(current, email, required);
      if (!check.ok) {
        // Slot gone by the time we got here — don't write
        console.log(`[claimSlot] ${articleId} no longer eligible (${check.reason}), skipping.`);
        return false;
      }

      tx.update(articleRef, {
        assigned_count: increment(1),
        assigned_to: arrayUnion(email),
      });
      return true;
    });
  } catch (err) {
    console.warn(`[claimSlot] Transaction failed for ${articleId}:`, err);
    return false;
  }
}

export async function assignArticlesForAnnotator(email: string, targetCount = 20): Promise<string[]> {
  console.log("[assignArticlesForAnnotator] Starting for email:", email, "targetCount:", targetCount);

  // Spread concurrent logins to reduce Firestore read contention
  await randomDelay(100, 800);

  const emailNorm = email.toLowerCase().trim();
  let adminConfig: AdminConfig | null = null;
  try {
    const adminDoc = await getDoc(doc(db, "admin_config", "settings"));
    if (adminDoc.exists()) adminConfig = adminDoc.data() as AdminConfig;
  } catch (err) {
    console.warn("[assignArticlesForAnnotator] Could not load admin settings, using defaults.", err);
  }

  const articlesRef = collection(db, "articles");
  let eligibleArticles: Article[] = [];
  const allHealedById = new Map<string, Article>();

  // Load annotator context for self-heal
  let annotatorCtx: AnnotatorContext;
  try {
    annotatorCtx = await fetchAnnotatorContext();
    console.log("[assignArticlesForAnnotator] Live annotators:", annotatorCtx.liveEmails.size,
      "| Truth-assignees for", annotatorCtx.articlesByAssignee.size, "articles.");
  } catch (err) {
    console.warn("[assignArticlesForAnnotator] Could not load live annotators; skipping self-heal.", err);
    annotatorCtx = { liveEmails: new Set(), articlesByAssignee: new Map() };
  }

  async function healDocSnaps(
    docs: Array<{ id: string; data: () => Record<string, unknown> }>
  ): Promise<Article[]> {
    const raws = docs.map((d) => ({
      ...(d.data() as Partial<Article>),
      article_id: (d.data().article_id as string) || d.id,
    }));
    return healArticles(raws, annotatorCtx, adminConfig);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // STRATEGY A (PRIMARY) — composite index: status + sequence_number
  // Filters server-side so we only read pending/partial articles.
  // ─────────────────────────────────────────────────────────────────────────
  try {
    console.log("[assignArticlesForAnnotator] Strategy A: status filter + sequence_number order");
    const strategyASnap = await getDocs(query(
      articlesRef,
      where("status", "in", ["pending", "partial"]),
      orderBy("sequence_number", "asc"),
      limit(100)
    ));
    console.log("[assignArticlesForAnnotator] Strategy A returned", strategyASnap.size, "docs");

    const healedBatch = await healDocSnaps(strategyASnap.docs);
    for (const a of healedBatch) allHealedById.set(a.article_id, a);

    const inconsistencies: string[] = [];
    const candidates: Article[] = [];
    for (const article of healedBatch) {
      const required = getRequiredAnnotations(article, adminConfig);
      const check = isEligible(article, email, required);
      if (!check.ok) {
        if (check.reason?.startsWith("consistency-err")) {
          inconsistencies.push(`${article.article_id}(seq=${(article as any).sequence_number}): ${check.reason}`);
        }
        continue;
      }
      candidates.push(article);
    }

    if (inconsistencies.length > 0) {
      console.warn("[assignArticlesForAnnotator] Strategy A skipped", inconsistencies.length,
        "inconsistent:", inconsistencies.slice(0, 3));
    }

    candidates.sort(priorityCmp);
    eligibleArticles = candidates.slice(0, targetCount);
    console.log("[assignArticlesForAnnotator] Strategy A eligible:", eligibleArticles.length, "/", candidates.length);
  } catch (err) {
    console.warn("[assignArticlesForAnnotator] Strategy A failed (index missing?):", err);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // STRATEGY B (TRUE FALLBACK) — no composite index required.
  // Omits orderBy so Firestore can serve this with only single-field indexes.
  // Results are sorted client-side by priorityCmp after healing.
  // ─────────────────────────────────────────────────────────────────────────
  if (eligibleArticles.length < targetCount) {
    try {
      console.log("[assignArticlesForAnnotator] Strategy B fallback (no orderBy — index-free)");
      const fallbackSnap = await getDocs(query(
        articlesRef,
        where("status", "in", ["pending", "partial"]),
        // ← NO orderBy here: avoids the composite (status + sequence_number)
        //   index requirement so this works even while the index is building
        limit(200)   // fetch more since we sort client-side
      ));
      console.log("[assignArticlesForAnnotator] Strategy B returned", fallbackSnap.size, "docs");

      const healedFallback = await healDocSnaps(fallbackSnap.docs);
      for (const a of healedFallback) allHealedById.set(a.article_id, a);

      const alreadySeen = new Set(eligibleArticles.map(a => a.article_id));
      const inconsistencies: string[] = [];
      for (const article of healedFallback) {
        if (eligibleArticles.length >= targetCount) break;
        if (alreadySeen.has(article.article_id)) continue;
        const required = getRequiredAnnotations(article, adminConfig);
        const check = isEligible(article, email, required);
        if (!check.ok) {
          if (check.reason?.startsWith("consistency-err")) {
            inconsistencies.push(`${article.article_id}: ${check.reason}`);
          }
          continue;
        }
        eligibleArticles.push(article);
        alreadySeen.add(article.article_id);
      }

      if (inconsistencies.length > 0) {
        console.warn("[assignArticlesForAnnotator] Strategy B skipped", inconsistencies.length, "inconsistent");
      }
      console.log("[assignArticlesForAnnotator] Strategy B total eligible:", eligibleArticles.length);
    } catch (err2) {
      console.warn("[assignArticlesForAnnotator] Strategy B also failed:", err2);
    }
  }

  console.log("[assignArticlesForAnnotator] Total eligible:", eligibleArticles.length);

  // ── Merge already-assigned articles from healed + annotator truth ─────────
  const alreadyMineFromHealed = [...allHealedById.values()]
    .filter((a) =>
      (a.assigned_to || []).some((e) => typeof e === "string" && e.toLowerCase().trim() === emailNorm)
    );

  const alreadyMineFromTruthIds = annotatorCtx.articlesByAssignee.size > 0
    ? [...annotatorCtx.articlesByAssignee.entries()]
        .filter(([, emails]) => emails.has(emailNorm))
        .map(([articleId]) => articleId)
    : [];

  const alreadyMineFromTruth: Article[] = [];
  if (alreadyMineFromTruthIds.length > 0) {
    const missing = alreadyMineFromTruthIds.filter((id) => !allHealedById.has(id));
    if (missing.length > 0) {
      try {
        const snaps = await Promise.all(missing.map((id) => getDoc(doc(db, "articles", id))));
        for (const snap of snaps) {
          if (snap.exists()) {
            const raw = { ...(snap.data() as Partial<Article>), article_id: snap.id };
            const healedArr = annotatorCtx.liveEmails.size > 0 || annotatorCtx.articlesByAssignee.size > 0
              ? await healArticles([raw], annotatorCtx, adminConfig)
              : [normalizeArticle(raw)];
            const healed = healedArr[0];
            allHealedById.set(healed.article_id, healed);
          }
        }
      } catch (e) {
        console.warn("[assignArticlesForAnnotator] Could not fetch already-assigned articles:", e);
      }
    }
    for (const id of alreadyMineFromTruthIds) {
      const a = allHealedById.get(id);
      if (a) alreadyMineFromTruth.push(a);
    }
  }

  const alreadyMineMap = new Map<string, Article>();
  for (const a of alreadyMineFromHealed) alreadyMineMap.set(a.article_id, a);
  for (const a of alreadyMineFromTruth) alreadyMineMap.set(a.article_id, a);

  const alreadyMineArticles = [...alreadyMineMap.values()]
    .sort((a, b) => ((a as any).sequence_number ?? 0) - ((b as any).sequence_number ?? 0));

  const alreadyMineIds = alreadyMineArticles.map((a) => a.article_id);
  const alreadyMineSet = new Set(alreadyMineIds);

  eligibleArticles.sort(priorityCmp);
  const newSlotsNeeded = Math.max(0, targetCount - alreadyMineIds.length);
  const newToAssign = eligibleArticles
    .filter((a) => !alreadyMineSet.has(a.article_id))
    .slice(0, newSlotsNeeded);

  const selectedArticles = [...alreadyMineArticles, ...newToAssign].slice(0, targetCount);
  const selectedIds = selectedArticles.map((a) => a.article_id);
  const idsNeedingWrite = newToAssign.map((a) => a.article_id);

  if (selectedIds.length === 0) {
    console.warn("[assignArticlesForAnnotator] ❌ NO ELIGIBLE ARTICLES FOUND.");
    return [];
  }

  console.log("[assignArticlesForAnnotator] Selected:", selectedIds.length,
    "| New to write:", idsNeedingWrite.length, "| Already mine:", alreadyMineIds.length);

  // ── Atomic per-article claim (prevents race condition) ─────────────────────
  // Each article is claimed in its own runTransaction. If two users race on
  // the same article, the second transaction re-reads after the first commits
  // and only writes if the slot is still below the cap.
  if (idsNeedingWrite.length > 0) {
    console.log("[assignArticlesForAnnotator] Claiming", idsNeedingWrite.length, "slots atomically...");
    const successfulIds: string[] = [...alreadyMineIds];

    await Promise.all(
      idsNeedingWrite.map(async (articleId) => {
        const claimed = await claimAssignmentSlot(articleId, email, adminConfig);
        if (claimed) {
          successfulIds.push(articleId);
        } else {
          console.log(`[assignArticlesForAnnotator] Slot for ${articleId} was taken by concurrent user — skipped.`);
        }
      })
    );

    console.log("[assignArticlesForAnnotator] ✅ Claimed", successfulIds.length - alreadyMineIds.length,
      "new slots (", idsNeedingWrite.length - (successfulIds.length - alreadyMineIds.length), "lost to race).");
    return successfulIds.slice(0, targetCount);
  }

  console.log("[assignArticlesForAnnotator] ✅ DONE. Returning", selectedIds.length, "articles.");
  return selectedIds;
}
