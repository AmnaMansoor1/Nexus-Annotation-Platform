import fs from "fs";
import path from "path";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const REQUIRED = 5;
const DRY_RUN = process.argv.includes("--dry-run");

const sa = JSON.parse(fs.readFileSync(path.join(root, "service-account.json"), "utf8"));
const app = getApps().length ? getApps()[0] : initializeApp({ credential: cert(sa) });
const db = getFirestore(app);

console.log(DRY_RUN ? "SYNC ARTICLE COUNTS (v2 — includes responses truth) — DRY RUN" : "SYNC ARTICLE COUNTS (v2 — includes responses truth) — WRITING");
console.log("Rebuilds assigned_to from /annotators (assignee truth) and annotated_by from UNION(/annotators ∩ /annotations/{id}/responses) (annotator-response truth).\n");

const annotatorsSnap = await db.collection("annotators").get();
const liveEmails = new Set();
const articlesByAssignee = new Map();
for (const d of annotatorsSnap.docs) {
  const data = d.data();
  const email = (data.email || "").toLowerCase().trim();
  if (!email) continue;
  liveEmails.add(email);
  const assigned = Array.isArray(data.assigned_articles) ? data.assigned_articles : [];
  for (const articleId of assigned) {
    if (!articleId) continue;
    if (!articlesByAssignee.has(articleId)) articlesByAssignee.set(articleId, new Set());
    articlesByAssignee.get(articleId).add(email);
  }
}
console.log(`Live annotators: ${liveEmails.size}`);
console.log(`Truth-assignees populated for ${articlesByAssignee.size} articles.`);
for (const e of liveEmails) console.log(`  ${e}`);

const articlesSnap = await db.collection("articles").get();
const articleIds = articlesSnap.docs.map((d) => d.id);
console.log(`Total articles: ${articleIds.length}`);

// ── Issue-1 (v2 script): Rebuild annotated_by TRUTH from the
// /annotations/{articleId}/responses subcollection. Annotator deletion +
// filterLive used to wipe annotated_by to [ ] while response docs still
// existed, causing articles with 5 real responses to show 0/5 in article
// metadata → never fire scoring branch → no bias/kappa/final_label.
//
// Fetch all responses for all articles in parallel, build truth map:
//   Map<articleId, Set<annotator_email>>
console.log("Reading responses subcollection for all articles...");
const responsesByArticle = new Map();
const responseBatchSize = 300; // concurrent limit to stay healthy
for (let i = 0; i < articleIds.length; i += responseBatchSize) {
  const slice = articleIds.slice(i, i + responseBatchSize);
  const results = await Promise.all(
    slice.map(async (id) => {
      try {
        const snap = await db.collection(`annotations/${id}/responses`).get();
        const set = new Set();
        snap.forEach((d) => {
          const em = (d.data()?.annotator_email || "").toLowerCase().trim();
          if (em) set.add(em);
        });
        return { id, set };
      } catch (e) {
        // If rules/transient fail for an article, use empty set. The per-article
        // union with raw.annotated_by below means we still capture old data.
        console.warn(`  [warn] Could not read responses for article=${id}:`, e?.code ?? String(e).slice(0, 100));
        return { id, set: new Set() };
      }
    })
  );
  for (const r of results) responsesByArticle.set(r.id, r.set);
  if (i + responseBatchSize < articleIds.length) {
    console.log(`  ... ${i + responseBatchSize}/${articleIds.length}`);
  }
}
console.log(`Responses truth loaded for ${responsesByArticle.size} articles.`);

let repaired = 0;
let batch = db.batch();
let batchCount = 0;

function uniqueEmails(arr, predicate) {
  const seen = new Set();
  const out = [];
  for (const raw of arr) {
    const n = (raw || "").toLowerCase().trim();
    if (!n || seen.has(n)) continue;
    if (predicate && !predicate(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

// ── Pure score helpers (mirrors frontend/src/utils/{calculateBiasScore,calculateKappa}.ts)
// Included inline here so the backend repair script is self-contained (no ts-node
// needed, no cross-module imports between frontend/backend).
function calculateBiasScorePure(counts) {
  const n = counts.neutral + counts.slightly + counts.highly;
  if (n === 0) return 0;
  const raw = (counts.highly * 2 + counts.slightly * 1 + counts.neutral * 0) / n;
  return parseFloat((raw * 2.5).toFixed(2));
}
function calculateFleissKappaPure(counts) {
  const cats = [counts.neutral, counts.slightly, counts.highly];
  const n = cats.reduce((s, c) => s + c, 0);
  if (n < 2) return 0;
  const sumSq = cats.reduce((s, c) => s + c * c, 0);
  const Po = (sumSq - n) / (n * (n - 1));
  const pj = cats.map((c) => c / n);
  const Pe = pj.reduce((s, p) => s + p * p, 0);
  if (Pe === 1) return 1;
  const k = (Po - Pe) / (1 - Pe);
  return parseFloat(k.toFixed(3));
}
function finalLabelFromCounts(counts) {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const [topK, topC] = entries[0];
  const [_sk, secC] = entries[1] ?? ["", 0];
  if (topC === 0 || topC === secC) return null; // no majority / tie
  const map = { neutral: "neutral", slightly: "slightly_manipulative", highly: "highly_manipulative" };
  return map[topK] ?? null;
}

for (const docSnap of articlesSnap.docs) {
  const article = docSnap.data();
  const oldAC = article.assigned_count ?? 0;
  const oldAnnC = article.annotation_count ?? 0;

  const truthAssignees = articlesByAssignee.get(docSnap.id) ?? new Set();
  const rawAssignedTo = Array.isArray(article.assigned_to) ? article.assigned_to : [];
  const rawAnnotatedBy = Array.isArray(article.annotated_by) ? article.annotated_by : [];
  const responseAnnotators = responsesByArticle.get(docSnap.id) ?? new Set();

  const newAssignedTo = truthAssignees.size > 0
    ? uniqueEmails([...truthAssignees])
    : uniqueEmails(rawAssignedTo, (e) => liveEmails.has(e));
  const rawLiveAnnotated = uniqueEmails(rawAnnotatedBy, (e) => liveEmails.has(e));
  // Issue-1 (v2): response annotators count WITHOUT the liveEmails filter.
  // ExportCSV reads the same response docs unfiltered → deleted annotators'
  // responses STILL appear in CSV human_label columns and DO count for bias.
  // If we filtered responseAnnotators by liveEmails, we'd still have the
  // "annotated_by=[ ] vs 5 real responses" drift that broke the scoring gate.
  const responseNormalized = uniqueEmails([...responseAnnotators]);
  const newAnnotatedBy = uniqueEmails([...rawLiveAnnotated, ...responseNormalized]);
  const newAC = newAssignedTo.length;
  const newAnnC = newAnnotatedBy.length;

  let newStatus = article.status;
  if (newAnnC >= REQUIRED) newStatus = "complete";
  else if (newAnnC > 0) newStatus = "partial";
  else newStatus = "pending";

  const needsBaseUpdate =
    oldAC !== newAC ||
    oldAnnC !== newAnnC ||
    (article.assigned_to || []).length !== newAssignedTo.length ||
    (article.annotated_by || []).length !== newAnnotatedBy.length ||
    article.status !== newStatus;

  const updates = {
    assigned_to: newAssignedTo,
    assigned_count: newAC,
    annotated_by: newAnnotatedBy,
    annotation_count: newAnnC,
    status: newStatus,
  };

  let needScoreWrite = false;
  const oldBias = article.bias_score ?? null;
  const oldKappa = article.fleiss_kappa ?? null;
  const oldFinal = (article.final_label ?? null);

  if (newAnnC < REQUIRED) {
    updates.bias_score = null;
    updates.fleiss_kappa = null;
    updates.final_label = null;
    needScoreWrite = oldBias !== null || oldKappa !== null || oldFinal !== null;
  } else {
    // ── Issue-1 (v2 repair): Articles that were drifted to 0/5 never went
    // through the 5th-annotation scoring transaction, so their
    // bias_score/kappa/final_label are still null even though their
    // annotation_count is now correctly 5+. Recompute them from actual
    // response labels here.
    const anyScoreMissing =
      oldBias == null || oldKappa == null || oldFinal == null;
    if (anyScoreMissing) {
      const counts = { neutral: 0, slightly: 0, highly: 0 };
      try {
        const respSnap = await db.collection(`annotations/${docSnap.id}/responses`).get();
        for (const rd of respSnap.docs) {
          const lbl = (rd.data()?.label || "").toString();
          if (lbl === "neutral") counts.neutral++;
          else if (lbl === "slightly_manipulative") counts.slightly++;
          else if (lbl === "highly_manipulative") counts.highly++;
        }
      } catch (e) {
        console.warn(
          `  [warn] Could not re-read responses for score recompute on ${docSnap.id}:`,
          e?.code ?? String(e).slice(0, 100)
        );
      }
      const totalCounted = counts.neutral + counts.slightly + counts.highly;
      if (totalCounted >= REQUIRED) {
        updates.bias_score = calculateBiasScorePure(counts);
        updates.fleiss_kappa = calculateFleissKappaPure(counts);
        updates.final_label = finalLabelFromCounts(counts);
        needScoreWrite = true;
      } else {
        // Not enough valid-labelled responses (unexpected). Leave null.
        updates.bias_score = oldBias;
        updates.fleiss_kappa = oldKappa;
        updates.final_label = oldFinal;
      }
    } else {
      // Already set and valid. Keep existing values, no write needed for scores.
      updates.bias_score = oldBias;
      updates.fleiss_kappa = oldKappa;
      updates.final_label = oldFinal;
    }
  }

  // Optional verbose reporting: print whenever a score was (re)computed in dry-run.
  if (needScoreWrite && docSnap.data().sequence_number <= 20) {
    console.log(
      `  [score-recompute] seq ${article.sequence_number} ${docSnap.id}: ` +
      `bias ${String(oldBias)}→${String(updates.bias_score)}, ` +
      `kappa ${String(oldKappa)}→${String(updates.fleiss_kappa)}, ` +
      `final_label ${String(oldFinal)}→${String(updates.final_label)}`
    );
  }

  const needsUpdate = needsBaseUpdate || needScoreWrite;

  if (!needsUpdate) continue;
  repaired++;

  if (docSnap.data().sequence_number <= 20 && (oldAC !== newAC || oldAnnC !== newAnnC)) {
    console.log(
      `  seq ${article.sequence_number} ${docSnap.id}: aC ${oldAC}→${newAC}, annC ${oldAnnC}→${newAnnC}, status→${newStatus}`
    );
  }

  if (!DRY_RUN) {
    batch.set(docSnap.ref, updates, { merge: true });
    batchCount++;
    if (batchCount >= 500) {
      await batch.commit();
      batch = db.batch();
      batchCount = 0;
    }
  }
}

if (!DRY_RUN && batchCount > 0) await batch.commit();

console.log(`\n${DRY_RUN ? "Would repair" : "Repaired"} ${repaired} articles.`);
