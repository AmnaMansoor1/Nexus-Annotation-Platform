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

console.log(DRY_RUN ? "SYNC ARTICLE COUNTS — DRY RUN" : "SYNC ARTICLE COUNTS — WRITING");
console.log("Rebuilds assigned_to, assigned_count, annotated_by, annotation_count from LIVE /annotators only.\n");

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

for (const docSnap of articlesSnap.docs) {
  const article = docSnap.data();
  const oldAC = article.assigned_count ?? 0;
  const oldAnnC = article.annotation_count ?? 0;

  const truthAssignees = articlesByAssignee.get(docSnap.id) ?? new Set();
  const rawAssignedTo = Array.isArray(article.assigned_to) ? article.assigned_to : [];
  const rawAnnotatedBy = Array.isArray(article.annotated_by) ? article.annotated_by : [];

  const newAssignedTo = truthAssignees.size > 0
    ? uniqueEmails([...truthAssignees])
    : uniqueEmails(rawAssignedTo, (e) => liveEmails.has(e));
  const newAnnotatedBy = uniqueEmails(rawAnnotatedBy, (e) => liveEmails.has(e));
  const newAC = newAssignedTo.length;
  const newAnnC = newAnnotatedBy.length;

  let newStatus = article.status;
  if (newAnnC >= REQUIRED) newStatus = "complete";
  else if (newAnnC > 0) newStatus = "partial";
  else newStatus = "pending";

  const needsUpdate =
    oldAC !== newAC ||
    oldAnnC !== newAnnC ||
    (article.assigned_to || []).length !== newAssignedTo.length ||
    (article.annotated_by || []).length !== newAnnotatedBy.length ||
    article.status !== newStatus;

  if (!needsUpdate) continue;
  repaired++;

  const updates = {
    assigned_to: newAssignedTo,
    assigned_count: newAC,
    annotated_by: newAnnotatedBy,
    annotation_count: newAnnC,
    status: newStatus,
  };
  if (newAnnC < REQUIRED) {
    updates.bias_score = null;
    updates.fleiss_kappa = null;
    updates.final_label = null;
  }

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
