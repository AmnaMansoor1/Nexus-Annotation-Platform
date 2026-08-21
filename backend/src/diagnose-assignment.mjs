// Diagnose why a new annotator gets articles starting at seq N instead of 1.
// Usage: node backend/src/diagnose-assignment.mjs [email]

import fs from "fs";
import path from "path";
import Papa from "papaparse";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "../..");
const email = process.argv[2] || "sp23-bse-200@cuilahore.edu.pk";

function sanitizeEmailForDocId(e) {
  return e.replace(/@/g, "_at_").replace(/\./g, "_dot_");
}

const sa = JSON.parse(fs.readFileSync(path.join(root, "service-account.json"), "utf8"));
const app = getApps().length ? getApps()[0] : initializeApp({ credential: cert(sa) });
const db = getFirestore(app);

const REQUIRED = 5;

const csv = Papa.parse(fs.readFileSync(path.join(root, "annotation_dataset_v6.csv"), "utf8"), {
  header: true,
  skipEmptyLines: true,
}).data;
const seqById = new Map(csv.map((r, i) => [r.article_id, i + 1]));

const snap = await db.collection("articles").get();
const articles = snap.docs
  .map((d) => ({ id: d.id, ...d.data() }))
  .sort((a, b) => (a.sequence_number ?? 0) - (b.sequence_number ?? 0));

const annotatorId = sanitizeEmailForDocId(email);
const annotatorSnap = await db.collection("annotators").doc(annotatorId).get();
const annotator = annotatorSnap.exists ? annotatorSnap.data() : null;

console.log(`\n🔍 ASSIGNMENT DIAGNOSTIC for: ${email}`);
console.log(`   Annotator doc id: ${annotatorId}`);
console.log(`   Doc exists: ${annotatorSnap.exists}\n`);

if (annotator) {
  const assigned = annotator.assigned_articles || [];
  const completed = annotator.completed_articles || [];
  console.log(`Assigned articles (${assigned.length}):`);
  for (const id of assigned) {
    const a = articles.find((x) => x.id === id);
    console.log(
      `  ${id}  seq=${a?.sequence_number ?? "?"}  status=${a?.status ?? "?"}  aC=${a?.assigned_count ?? "?"}  annC=${a?.annotation_count ?? "?"}`
    );
  }
  console.log(`Completed: ${completed.length}\n`);
}

console.log("── First 30 articles by sequence_number (eligibility for NEW assignee) ──");
console.log("seq | article_id   | status   | aC | annC | req | eligible? | skip reason");
console.log("----+--------------+----------+----+------+-----+-----------+------------");

for (const a of articles.slice(0, 30)) {
  const req = typeof a.required_annotations === "number" ? a.required_annotations : REQUIRED;
  let reason = "YES";
  if (a.status !== "pending" && a.status !== "partial") reason = `status=${a.status}`;
  else if (a.assigned_count >= req) reason = `full (aC=${a.assigned_count}>=${req})`;
  else if (a.annotation_count >= req && a.status !== "complete") reason = "consistency ann>=req";
  else if (a.status === "partial" && a.annotation_count === 0) reason = "partial, ann=0";
  else if (a.status === "pending" && a.annotation_count > 0) reason = "pending, ann>0";
  else if ((a.assigned_to || []).includes(email)) reason = "already mine";

  const eligible = reason === "YES" ? "✅" : "❌";
  console.log(
    `${String(a.sequence_number).padStart(3)} | ${a.id.slice(-10).padStart(10)} | ${String(a.status).padEnd(8)} | ${String(a.assigned_count).padStart(2)} | ${String(a.annotation_count).padStart(4)} | ${String(req).padStart(3)} | ${eligible.padEnd(9)} | ${reason}`
  );
}

// Simulate assignment: first 20 eligible by seq
const eligible = [];
for (const a of articles) {
  const req = typeof a.required_annotations === "number" ? a.required_annotations : REQUIRED;
  const okStatus = a.status === "pending" || a.status === "partial";
  if (!okStatus) continue;
  if (a.assigned_count >= req) continue;
  if ((a.assigned_to || []).includes(email)) continue;
  if (a.status === "partial" && a.annotation_count === 0) continue;
  if (a.status === "pending" && a.annotation_count > 0) continue;
  if (a.annotation_count >= req && a.status !== "complete") continue;
  eligible.push(a);
  if (eligible.length >= 20) break;
}

console.log("\n── Simulated NEXT assignment (20 lowest eligible seq) ──");
console.log(
  eligible.map((a) => `seq=${a.sequence_number} ${a.id}`).join("\n") || "(none)"
);
console.log(`\nFirst eligible seq: ${eligible[0]?.sequence_number ?? "N/A"}`);
console.log(`Last eligible seq in batch: ${eligible[eligible.length - 1]?.sequence_number ?? "N/A"}`);

// Count how many seq 1-22 are full
let fullBefore23 = 0;
for (const a of articles) {
  if ((a.sequence_number ?? 0) > 22) break;
  const req = typeof a.required_annotations === "number" ? a.required_annotations : REQUIRED;
  if (a.assigned_count >= req || a.status === "complete") fullBefore23++;
}
console.log(`\nArticles seq 1-22 with assigned_count>=${REQUIRED} or complete: ${fullBefore23} / 22`);
