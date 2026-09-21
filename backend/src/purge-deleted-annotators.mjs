/**
 * purge-deleted-annotators.mjs
 *
 * Deletes all /annotations/{articleId}/responses/{docId} documents that
 * belong to a known-deleted annotator, then recomputes article metadata
 * (annotated_by, annotation_count, status, bias_score, percent_agreement, etc.)
 * using the live annotators only.
 *
 * Usage:
 *   node backend/src/purge-deleted-annotators.mjs --dry-run    <- preview
 *   node backend/src/purge-deleted-annotators.mjs              <- write
 *
 * DELETED ANNOTATORS (not in /annotators collection any more):
 *   sp23-bse-017@cuilahore.edu.pk
 *   sp23-bse-018@cuilahore.edu.pk
 *   sp23-bse-200@cuilahore.edu.pk
 */
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

// ── Step 1: Determine who is deleted (not in /annotators) ──────────────────
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
console.log(`Live annotators (${liveEmails.size}):`);
for (const e of liveEmails) console.log(`  ${e}`);

// Hard-code deleted accounts for extra safety
const DELETED_EMAILS = new Set([
  "sp23-bse-017@cuilahore.edu.pk",
  "sp23-bse-018@cuilahore.edu.pk",
  "sp23-bse-200@cuilahore.edu.pk",
]);
console.log(`\nDeleted emails to purge (${DELETED_EMAILS.size}):`);
for (const e of DELETED_EMAILS) console.log(`  ${e}`);
console.log();

// ── Score helpers ────────────────────────────────────────────────────────────
function calculateBiasScore(counts) {
  const n = counts.neutral + counts.slightly + counts.highly;
  if (n === 0) return 0;
  const raw = (counts.highly * 2 + counts.slightly * 1) / n;
  return parseFloat((raw * 2.5).toFixed(2));
}
function calculatePercentAgreement(counts) {
  const cats = [counts.neutral, counts.slightly, counts.highly];
  const n = cats.reduce((s, c) => s + c, 0);
  if (n < 2) return 0;
  const sumSq = cats.reduce((s, c) => s + c * c, 0);
  return parseFloat(((sumSq - n) / (n * (n - 1))).toFixed(4));
}
function finalLabel(counts) {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const [topK, topC] = entries[0];
  const [, secC] = entries[1] ?? ["", 0];
  if (topC === 0 || topC === secC) return null;
  const map = { neutral: "neutral", slightly: "slightly_manipulative", highly: "highly_manipulative" };
  return map[topK] ?? null;
}

// ── Step 2: Scan all articles ───────────────────────────────────────────────
const articlesSnap = await db.collection("articles").get();
console.log(`Total articles: ${articlesSnap.size}`);

let responseDocsDeleted = 0;
let articlesUpdated = 0;
let batch = db.batch();
let batchCount = 0;

async function commitBatch() {
  if (batchCount === 0 || DRY_RUN) return;
  await batch.commit();
  batch = db.batch();
  batchCount = 0;
}

for (const articleDoc of articlesSnap.docs) {
  const articleId = articleDoc.id;
  const articleData = articleDoc.data();
  const seq = articleData.sequence_number ?? "?";

  // Read all responses for this article
  const respSnap = await db.collection(`annotations/${articleId}/responses`).get();
  if (respSnap.empty) continue;

  const docsToDelete = [];
  const keepEmails = [];

  for (const rd of respSnap.docs) {
    const rdData = rd.data();
    const em = (rdData.annotator_email || rd.id).toLowerCase().trim();
    if (DELETED_EMAILS.has(em)) {
      docsToDelete.push({ ref: rd.ref, id: rd.id, email: em });
    } else {
      keepEmails.push({ email: em, label: (rdData.label || "").toString() });
    }
  }

  if (docsToDelete.length === 0) continue;

  console.log(`\nSeq ${String(seq).padStart(3)} | ${articleId} | Deleting ${docsToDelete.length} response doc(s):`);
  for (const d of docsToDelete) {
    console.log(`   DELETE /annotations/${articleId}/responses/${d.id}  (${d.email})`);
    responseDocsDeleted++;
    if (!DRY_RUN) {
      batch.delete(d.ref);
      batchCount++;
    }
  }

  // Recompute article metadata using only kept responses
  const newAnnotatedBy = keepEmails.map(r => r.email).slice(0, REQUIRED);
  const newAnnotationCount = newAnnotatedBy.length;

  const truthAssignees = articlesByAssignee.get(articleId) ?? new Set();
  const rawAssigned = Array.isArray(articleData.assigned_to) ? articleData.assigned_to : [];
  const newAssignedTo = truthAssignees.size > 0
    ? [...truthAssignees].filter(e => liveEmails.has(e))
    : rawAssigned.filter(e => liveEmails.has(e.toLowerCase().trim()));
  const newAssignedCount = newAssignedTo.length;

  let newStatus;
  if (newAnnotationCount >= REQUIRED) newStatus = "complete";
  else if (newAnnotationCount > 0) newStatus = "partial";
  else newStatus = "pending";

  // Scores: recompute only if we still have enough responses
  let newBias = null, newPercentAgreement = null, newFinalLabel = null, newLabel = null;
  if (newAnnotationCount === REQUIRED) {
    const counts = { neutral: 0, slightly: 0, highly: 0 };
    for (const { label } of keepEmails.slice(0, REQUIRED)) {
      if (label === "neutral") counts.neutral++;
      else if (label === "slightly_manipulative") counts.slightly++;
      else if (label === "highly_manipulative") counts.highly++;
    }
    const total = counts.neutral + counts.slightly + counts.highly;
    if (total === REQUIRED) {
      newBias = calculateBiasScore(counts);
      newPercentAgreement = calculatePercentAgreement(counts);
      newFinalLabel = finalLabel(counts);
      newLabel = newBias >= 2.5 ? 1 : 0;
    }
  }

  const update = {
    annotated_by: newAnnotatedBy,
    annotation_count: newAnnotationCount,
    assigned_to: newAssignedTo,
    assigned_count: newAssignedCount,
    status: newStatus,
    bias_score: newBias,
    percent_agreement: newPercentAgreement,
    final_label: newFinalLabel,
    label: newLabel,
  };

  const oldAnnC = articleData.annotation_count ?? 0;
  const oldStatus = articleData.status ?? "?";
  console.log(`   UPDATE: annotation_count ${oldAnnC}→${newAnnotationCount}, status ${oldStatus}→${newStatus}`);
  articlesUpdated++;

  if (!DRY_RUN) {
    batch.set(articleDoc.ref, update, { merge: true });
    batchCount++;
    if (batchCount >= 400) await commitBatch();
  }
}

await commitBatch();

console.log(`\n=== DONE ===`);
console.log(DRY_RUN ? "[DRY RUN — no writes made]" : "[WRITE mode — changes committed to Firestore]");
console.log(`Response docs ${DRY_RUN ? "would be" : ""} deleted: ${responseDocsDeleted}`);
console.log(`Articles ${DRY_RUN ? "would be" : ""} updated: ${articlesUpdated}`);
