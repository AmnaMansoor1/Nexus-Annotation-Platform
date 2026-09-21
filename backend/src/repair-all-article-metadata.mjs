import fs from "fs";
import path from "path";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const sa = JSON.parse(fs.readFileSync(path.join(root, "service-account.json"), "utf8"));
const app = getApps().length ? getApps()[0] : initializeApp({ credential: cert(sa) });
const db = getFirestore(app);

const REQUIRED = 5;

const annotatorsSnap = await db.collection("annotators").get();
const liveEmails = new Set(
  annotatorsSnap.docs.map((d) => (d.data().email || "").toLowerCase().trim()).filter(Boolean)
);
console.log(`Live annotators: ${liveEmails.size} -> ${[...liveEmails].join(", ")}`);

const articlesSnap = await db.collection("articles").orderBy("sequence_number").get();
console.log(`Total articles: ${articlesSnap.size}\n`);

let repaired = 0;
const batch = db.batch();
let batchCount = 0;

for (const doc of articlesSnap.docs) {
  const a = doc.data();
  const seq = a.sequence_number ?? "?";
  const id = doc.id;

  const rawAssignedTo = Array.isArray(a.assigned_to) ? a.assigned_to : [];
  const rawAnnotatedBy = Array.isArray(a.annotated_by) ? a.annotated_by : [];

  // ── TRUTH 1: assigned_to — build from annotator assigned_articles[] (auth)
  //     else filter raw by liveEmails
  const truthAssignedEmails = new Set();
  for (const ad of annotatorsSnap.docs) {
    const assigned = Array.isArray(ad.data().assigned_articles) ? ad.data().assigned_articles : [];
    if (assigned.includes(id)) {
      const em = (ad.data().email || "").toLowerCase().trim();
      if (em) truthAssignedEmails.add(em);
    }
  }
  const assignedTo =
    truthAssignedEmails.size > 0
      ? [...truthAssignedEmails]
      : rawAssignedTo
          .map((e) => (typeof e === "string" ? e.toLowerCase().trim() : ""))
          .filter((e) => e && liveEmails.has(e));

  // Deduplicate
  const assignedToFinal = [...new Set(assignedTo)];

  // ── TRUTH 2: annotated_by — from ACTUAL /responses subcollection (ground truth)
  //     UNION of raw.annotated_by (live only) AND response docs' annotator_email (LIVE ONLY:
  //     annotator doc MUST still exist in liveEmails set. Deleted annotators' response docs
  //     MUST be physically purged from /responses by the hard-delete flow; we filter them
  //     out here defensively so they can never inflate annotation_count/status,
  //     preventing the 5-annotator completion gate from firing erroneously.)
  const rawLiveAnnotated = rawAnnotatedBy
    .map((e) => (typeof e === "string" ? e.toLowerCase().trim() : ""))
    .filter((e) => e && liveEmails.has(e));

  const responseEmails = [];
  const liveResponseEmails = [];
  try {
    const respSnap = await db.collection("annotations").doc(id).collection("responses").get();
    for (const rd of respSnap.docs) {
      const em = (rd.data().annotator_email || "").toLowerCase().trim();
      if (em) {
        responseEmails.push(em);
        if (liveEmails.has(em)) liveResponseEmails.push(em); // ⭐ live-filtered: deleted annotator responses do not count
      }
    }
  } catch (e) {}

  const annotatedByFinal = [...new Set([...rawLiveAnnotated, ...liveResponseEmails])];

  // ── Counters + status derived from truth
  const assignedCount = assignedToFinal.length;
  const annotationCount = annotatedByFinal.length;
  let status = a.status ?? "pending";
  if (annotationCount >= REQUIRED) status = "complete";
  else if (annotationCount > 0) status = "partial";
  else status = "pending";

  // ── Detect drift
  const oldAC = typeof a.assigned_count === "number" ? a.assigned_count : 0;
  const oldAnnC = typeof a.annotation_count === "number" ? a.annotation_count : 0;
  const oldAssignedToLen = rawAssignedTo.length;
  const oldAnnotatedByLen = rawAnnotatedBy.length;
  const oldStatus = a.status ?? "pending";

  const drift =
    oldAC !== assignedCount ||
    oldAnnC !== annotationCount ||
    oldAssignedToLen !== assignedToFinal.length ||
    oldAnnotatedByLen !== annotatedByFinal.length ||
    oldStatus !== status;

  if (drift) {
    console.log(
      `SEQ ${String(seq).padStart(3)} ${id.slice(0, 12)} ` +
        `│ old: status=${oldStatus} aC=${oldAC} annC=${oldAnnC} at#=${oldAssignedToLen} ab#=${oldAnnotatedByLen} ` +
        `│ NEW: status=${status} aC=${assignedCount} annC=${annotationCount} at#=${assignedToFinal.length} ab#=${annotatedByFinal.length} ` +
        `│ live_responses=${responseEmails.length}`
    );

    const updates = {
      assigned_to: assignedToFinal,
      annotated_by: annotatedByFinal,
      assigned_count: assignedCount,
      annotation_count: annotationCount,
      status,
    };

    // If dropping below 5 annotations, clear any stale scoring
    if (annotationCount < REQUIRED && (a.bias_score != null || a.percent_agreement != null)) {
      updates.bias_score = null;
      updates.percent_agreement = null;
      updates.final_label = null;
      updates.label = null;
      console.log(`  → also clearing stale bias_score/percent_agreement/final_label`);
    }

    batch.set(doc.ref, updates, { merge: true });
    batchCount++;
    repaired++;

    if (batchCount >= 500) {
      await batch.commit();
      console.log(`\nCommitted ${batchCount} repairs so far (batch full)...\n`);
      batchCount = 0;
    }
  }
}

if (batchCount > 0) {
  await batch.commit();
  console.log(`\nFinal batch commit: ${batchCount} articles repaired.`);
}

console.log(`\n✅ DONE. Total articles repaired: ${repaired}/${articlesSnap.size}`);
