import { collection, doc, getDocs, writeBatch } from "firebase/firestore";
import { db } from "../firebase";
import { Article } from "../types";
import { getRequiredAnnotations } from "./annotationConfig";

export function normalizeEmail(email: string): string {
  return email.toLowerCase().trim();
}

export interface AnnotatorContext {
  liveEmails: Set<string>;
  articlesByAssignee: Map<string, Set<string>>;
}

/**
 * Single source of truth for annotator state.
 *
 * Builds TWO structures from /annotators collection (one-shot read):
 *  - liveEmails: set of emails whose annotator doc still exists
 *  - articlesByAssignee: Map<articleId, Set<email>> built from each
 *    annotator.assigned_articles[] array.
 *
 * articlesByAssignee is the AUTHORITATIVE list of real assignees for
 * each article. article.assigned_to is treated as a derived/cached
 * reverse index and will be rebuilt from this map whenever entries
 * exist.
 */
export async function fetchAnnotatorContext(): Promise<AnnotatorContext> {
  const snap = await getDocs(collection(db, "annotators"));
  const liveEmails = new Set<string>();
  const articlesByAssignee = new Map<string, Set<string>>();
  snap.forEach((d) => {
    const data = d.data() as { email?: string; assigned_articles?: unknown };
    const email = typeof data.email === "string" ? normalizeEmail(data.email) : "";
    if (!email) return;
    liveEmails.add(email);
    const articles = Array.isArray(data.assigned_articles) ? data.assigned_articles : [];
    for (const articleId of articles) {
      if (typeof articleId !== "string" || !articleId) continue;
      if (!articlesByAssignee.has(articleId)) articlesByAssignee.set(articleId, new Set());
      articlesByAssignee.get(articleId)!.add(email);
    }
  });
  return { liveEmails, articlesByAssignee };
}

/** Backward-compat helper for callers/tests that still pass Set<string>. */
function toAnnotatorContext(ctx: Set<string> | AnnotatorContext): AnnotatorContext {
  if (ctx instanceof Set) {
    return { liveEmails: ctx, articlesByAssignee: new Map() };
  }
  return ctx;
}

/** @deprecated Prefer fetchAnnotatorContext() — kept for backward compat. */
export async function fetchLiveAnnotatorEmails(): Promise<Set<string>> {
  const ctx = await fetchAnnotatorContext();
  return ctx.liveEmails;
}

export interface ReconcileResult {
  article: Article;
  needsPersist: boolean;
  updates: Partial<Article> | null;
}

function uniqueEmails(arr: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of arr) {
    const n = normalizeEmail(raw);
    if (!n || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

function filterLive(emails: unknown, live: Set<string>): string[] {
  if (!Array.isArray(emails)) return [];
  return emails.filter(
    (e) => typeof e === "string" && live.has(normalizeEmail(e))
  );
}

/**
 * Rebuild counters/status from truth.
 *
 * Truth priority for assigned_to:
 *   1. ctx.articlesByAssignee.get(article_id)  — if non-empty, use it.
 *      (annotator.assigned_articles[] is authoritative.)
 *   2. Otherwise filter raw.assigned_to by liveEmails only.
 *      (handles articles that nobody was ever actually assigned to.)
 *
 * Truth priority for annotated_by:
 *   (NEW, v3) UNION of:
 *     (a) raw.annotated_by filtered by liveEmails (the annotator-deletion filter,
 *         which alone caused Issue-1 because deleted annotators can still have
 *         valid pre-existing response docs that count toward the 5-annotation
 *         completion branch — see CSV ExportCSV.tsx which also reads the
 *         /responses subcollection, NOT raw.annotated_by).
 *     (b) responseAnnotatorEmails (if supplied) filtered by liveEmails,
 *         derived from the ACTUAL /annotations/{articleId}/responses/ subcollection.
 *         If a callers does not pass responses (e.g. old callers/tests) we
 *         gracefully fall back to (a) alone, preserving backward compat.
 *   This prevents reconcileArticle from wiping a perfectly-valid 4/5 article
 *   to 0/5 (causing the 5th annotator's submission to be treated as #1).
 */
export function reconcileArticle(
  raw: Partial<Article> & { article_id: string },
  ctx: Set<string> | AnnotatorContext,
  requiredAnnotations: number,
  opts?: { responseAnnotatorEmails?: string[] | null }
): ReconcileResult {
  const { liveEmails, articlesByAssignee } = toAnnotatorContext(ctx);

  const rawAssignedTo = Array.isArray(raw.assigned_to) ? raw.assigned_to : [];
  const rawAnnotatedBy = Array.isArray(raw.annotated_by) ? raw.annotated_by : [];

  const truthAssigned = articlesByAssignee.get(raw.article_id) ?? new Set<string>();
  const assignedTo = uniqueEmails(
    truthAssigned.size > 0 ? [...truthAssigned] : filterLive(rawAssignedTo, liveEmails)
  );

  // ── UNION truth for annotated_by (Issue-1 fix) ──────────────────────────
  // RAW article annotated_by is filtered by liveEmails (annotator deletion
  // hygiene). The responses subcollection is the TRUE ground truth of who
  // actually annotated — ExportCSV.tsx reads these same docs directly,
  // WITHOUT liveEmails filtering, so ANY response doc present counts for
  // CSV human_label columns, CSV "5 annotations complete" display, and bias
  // computation. Therefore we MUST include response annotator emails in
  // annotated_by EVEN IF the corresponding annotator doc no longer exists.
  // Not doing so caused reconcileArticle to wipe annotated_by to [ ] after
  // annotator deletion, making the 5th submission be treated as #1 → never
  // fires the scoring branch.
  const rawLiveAnnotated = filterLive(rawAnnotatedBy, liveEmails);
  const responseNormalized =
    Array.isArray(opts?.responseAnnotatorEmails)
      ? (opts!.responseAnnotatorEmails as unknown[])
          .map((e) => (typeof e === "string" ? normalizeEmail(e) : ""))
          .filter((e) => !!e)
      : [];
  const annotatedBy = uniqueEmails([...rawLiveAnnotated, ...responseNormalized]);

  const assignedCount = assignedTo.length;
  const annotationCount = annotatedBy.length;

  let status: Article["status"] = raw.status ?? "pending";
  if (annotationCount >= requiredAnnotations) status = "complete";
  else if (annotationCount > 0) status = "partial";
  else status = "pending";

  const needsScoreClear =
    annotationCount < requiredAnnotations &&
    (raw.bias_score != null || raw.percent_agreement != null || (raw as any).final_label != null || (raw as any).label != null);

  const oldAssignedTo = rawAssignedTo;
  const oldAnnotatedBy = rawAnnotatedBy;
  const oldAssignedCount = typeof raw.assigned_count === "number" ? raw.assigned_count : 0;
  const oldAnnotationCount = typeof raw.annotation_count === "number" ? raw.annotation_count : 0;

  const articleRaw: Partial<Article> & { article_id: string } = {
    ...(raw as any),
    assigned_to: assignedTo,
    annotated_by: annotatedBy,
    assigned_count: assignedCount,
    annotation_count: annotationCount,
    status,
  };
  if (needsScoreClear) {
    (articleRaw as any).bias_score = null;
    (articleRaw as any).fleiss_kappa = null;
    (articleRaw as any).final_label = null;
    (articleRaw as any).label = null;
  }
  const article = articleRaw as Article;

  const countersDrift =
    oldAssignedCount !== assignedCount ||
    oldAnnotationCount !== annotationCount ||
    oldAssignedTo.length !== assignedTo.length ||
    oldAnnotatedBy.length !== annotatedBy.length;
  const statusDrift = raw.status !== status;

  const needsPersist = countersDrift || statusDrift || needsScoreClear;

  if (!needsPersist) {
    return { article, needsPersist: false, updates: null };
  }

  const updates: Partial<Article> = {
    assigned_to: assignedTo,
    annotated_by: annotatedBy,
    assigned_count: assignedCount,
    annotation_count: annotationCount,
    status,
  };
  if (needsScoreClear) {
    (updates as any).bias_score = null;
    (updates as any).fleiss_kappa = null;
    (updates as any).final_label = null;
    (updates as any).label = null;
  }

  return { article, needsPersist: true, updates };
}

export async function persistArticleRepairs(
  repairs: Array<{ articleId: string; updates: Partial<Article> }>
): Promise<number> {
  if (repairs.length === 0) return 0;

  let committed = 0;
  let batch = writeBatch(db);
  let batchCount = 0;

  for (const { articleId, updates } of repairs) {
    batch.set(doc(db, "articles", articleId), updates, { merge: true });
    batchCount++;
    if (batchCount >= 500) {
      await batch.commit();
      committed += batchCount;
      batch = writeBatch(db);
      batchCount = 0;
    }
  }
  if (batchCount > 0) {
    await batch.commit();
    committed += batchCount;
  }
  return committed;
}

/** Reconcile + persist drift for a batch of raw Firestore article payloads. */
export async function healArticles(
  raws: Array<Partial<Article> & { article_id: string }>,
  ctx: Set<string> | AnnotatorContext,
  adminConfig?: { annotators_per_article?: number } | null
): Promise<Article[]> {
  const { liveEmails } = toAnnotatorContext(ctx);

  // ── Responses subcollection reads ─────────────────────────────────────────
  // ONLY read /responses for articles that have known counter drift OR
  // whose annotated_by would be wiped to [] by filterLive (i.e. all their
  // annotated_by emails are from deleted annotators).
  // This avoids 500 concurrent reads on large corpora which exhausted quota.
  // Cap concurrent reads at 20 using a simple semaphore.
  const CONCURRENCY = 20;

  function needsResponseRead(raw: Partial<Article> & { article_id: string }): boolean {
    const required = getRequiredAnnotations(raw, adminConfig);
    const rawAnnotated = Array.isArray(raw.annotated_by) ? raw.annotated_by : [];
    const liveAnnotated = rawAnnotated.filter(
      (e) => typeof e === "string" && liveEmails.has(normalizeEmail(e))
    );
    // If live annotators < stored annotation_count, responses may have more truth
    const counterMismatch = liveAnnotated.length < (typeof raw.annotation_count === "number" ? raw.annotation_count : 0);
    // If article is nearly complete by live count, verify via responses
    const nearComplete = liveAnnotated.length >= required - 1;
    // Always read if status is complete (need to verify scores are still valid)
    const isComplete = raw.status === "complete";
    return counterMismatch || nearComplete || isComplete;
  }

  async function readResponseEmails(articleId: string): Promise<string[]> {
    try {
      const snaps = await getDocs(collection(db, "annotations", articleId, "responses"));
      const emails: string[] = [];
      snaps.forEach((d) => {
        const em = (d.data() as any)?.annotator_email;
        if (typeof em === "string") emails.push(em);
      });
      return emails;
    } catch (readErr: any) {
      console.warn(
        `[healArticles] Could not read responses for article=${articleId}. ` +
        `Falling back to raw.annotated_by. code=${readErr?.code ?? "NO_CODE"}`
      );
      return [];
    }
  }

  // Run up to CONCURRENCY reads in parallel
  async function runBatched<T>(items: T[], fn: (item: T) => Promise<void>): Promise<void> {
    let i = 0;
    async function next(): Promise<void> {
      if (i >= items.length) return;
      const item = items[i++];
      await fn(item);
      return next();
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, next));
  }

  const responseEmailsMap = new Map<string, string[]>();
  const articlesNeedingRead = raws.filter(needsResponseRead);

  if (articlesNeedingRead.length > 0) {
    console.log(`[healArticles] Reading /responses for ${articlesNeedingRead.length}/${raws.length} articles (others skipped — no drift suspected)`);
    await runBatched(articlesNeedingRead, async (raw) => {
      const emails = await readResponseEmails(raw.article_id);
      responseEmailsMap.set(raw.article_id, emails);
    });
  }

  const repairs: Array<{ articleId: string; updates: Partial<Article> }> = [];
  const healed: Article[] = [];

  for (const raw of raws) {
    const required = getRequiredAnnotations(raw, adminConfig);
    const responseEmails = responseEmailsMap.get(raw.article_id) ?? null;
    const result = reconcileArticle(raw, ctx, required, { responseAnnotatorEmails: responseEmails });
    healed.push(result.article);
    if (result.needsPersist && result.updates) {
      repairs.push({ articleId: raw.article_id, updates: result.updates });
    }
  }

  if (repairs.length > 0) {
    console.log(`[healArticles] Self-healing ${repairs.length} article(s) with stale assigned_count/annotation_count`);
    await persistArticleRepairs(repairs);
  }

  return healed;
}
