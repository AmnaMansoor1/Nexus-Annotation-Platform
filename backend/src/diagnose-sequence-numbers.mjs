
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import Papa from "papaparse";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serviceAccount = JSON.parse(
  fs.readFileSync(path.join(__dirname, "../../service-account.json"), "utf8")
);

const app = getApps().length === 0
  ? initializeApp({ credential: cert(serviceAccount) })
  : getApps()[0];
const db = getFirestore(app);

const csvPath = path.join(__dirname, "../../annotation_dataset_v6.csv");
const csvText = fs.readFileSync(csvPath, "utf8");
const csvRows = Papa.parse(csvText, { header: true, skipEmptyLines: true }).data;
const idToCsvRow = new Map(csvRows.map((r, i) => [r.article_id, i + 1])); // 1-based CSV seq
const csvOrderArticleIds = csvRows.map(r => r.article_id);

console.log(`\n🔬 SEQUENCE NUMBER DIAGNOSTIC\n`);
console.log(`CSV rows parsed: ${csvRows.length}. CSV first id: ${csvOrderArticleIds[0]}, CSV last id: ${csvOrderArticleIds[csvOrderArticleIds.length - 1]}`);

// ─────────────────────────────────────────────────────────────
// 1. TARGETED SAMPLE — specific CSV-ordered positions
// ─────────────────────────────────────────────────────────────
const targetPositions = [1, 2, 3, 40, 42, 100, 1493];
const samples = [];
for (const pos of targetPositions) {
  const expectedId = csvOrderArticleIds[pos - 1];
  if (!expectedId) { samples.push({ pos, expectedId: null, missingInCsv: true }); continue; }
  const doc = await db.collection("articles").doc(expectedId).get();
  if (!doc.exists) { samples.push({ pos, expectedId, inFirestore: false }); continue; }
  const d = doc.data();
  samples.push({
    pos,
    expectedId,
    inFirestore: true,
    sequence_number: d.sequence_number,
    status: d.status,
    assigned_count: d.assigned_count,
    annotation_count: d.annotation_count,
  });
}
console.log("\n📌 TARGETED SAMPLE (by CSV row position):");
console.log("Pos | CSV expected_id          | inFS | sequence_number | status  | aC | annC");
console.log("----+--------------------------+------+-----------------+---------+----+-----");
for (const s of samples) {
  if (s.missingInCsv) console.log(`${String(s.pos).padStart(3)} | (CSV row out of range)`);
  else if (!s.inFirestore) console.log(`${String(s.pos).padStart(3)} | ${s.expectedId.slice(-10).padStart(10)} |  NO  | ——               | ——      | —— | ——`);
  else {
    const seq = (s.sequence_number ?? "UND").toString().padStart(8);
    console.log(`${String(s.pos).padStart(3)} | ${s.expectedId.slice(-10).padStart(10)} | YES  | ${seq}       | ${String(s.status).padEnd(7)} | ${String(s.assigned_count).padStart(2)} | ${String(s.annotation_count).padStart(2)}`);
  }
}

// ─────────────────────────────────────────────────────────────
// 2. FULL SCAN ALL 1,493 ARTICLES — get ALL sequence_number values
//    (uses cursor pagination so it works even if >500 docs)
// ─────────────────────────────────────────────────────────────
console.log("\n🧮 FULL SCAN: reading ALL /articles and inspecting sequence_number...");
let undefinedCount = 0;
let notInteger = 0;
const seqCounts = new Map();
let total = 0;
let min = Infinity;
let max = -Infinity;
let nullStatus = 0;
const outOfOrder = []; // list of {articleId, firestoreSeq, expectedCsvSeq} where they don't match AND firestoreSeq is valid
const assignedSeqSum = { match: 0, mismatch: 0, notOnFirestore: 0 };

let cursor = null;
const BATCH = 500;
while (true) {
  let q = db.collection("articles").orderBy("__name__").limit(BATCH);
  if (cursor) q = q.startAfter(cursor);
  const snap = await q.get();
  if (snap.empty) break;
  const docs = snap.docs;
  for (const d of docs) {
    total++;
    const data = d.data();
    const seq = data.sequence_number;
    if (data.status === undefined || data.status === null) nullStatus++;
    const csvSeq = idToCsvRow.get(d.id) ?? null;
    if (seq === undefined || seq === null) {
      undefinedCount++;
    } else if (!Number.isInteger(seq)) {
      notInteger++;
    } else {
      if (seq < min) min = seq;
      if (seq > max) max = seq;
      seqCounts.set(seq, (seqCounts.get(seq) ?? 0) + 1);
      if (csvSeq !== null) {
        if (csvSeq === seq) assignedSeqSum.match++;
        else { assignedSeqSum.mismatch++; outOfOrder.push({ articleId: d.id, firestoreSeq: seq, expectedCsvSeq: csvSeq, status: data.status }); }
      } else {
        assignedSeqSum.notOnFirestore++;
      }
    }
  }
  if (docs.length < BATCH) break;
  cursor = docs[docs.length - 1];
}

console.log(`\n✅ Scanned ${total} articles.`);
console.log(`\n── sequence_number integrity ──`);
console.log(`  undefined/null : ${undefinedCount}`);
console.log(`  not integer    : ${notInteger}`);
console.log(`  integer values : ${total - undefinedCount - notInteger}`);
if (total - undefinedCount - notInteger > 0) {
  console.log(`  min value      : ${min}`);
  console.log(`  max value      : ${max}`);
  // Duplicate count
  let duplicates = 0;
  for (const c of seqCounts.values()) if (c > 1) duplicates += (c - 1);
  console.log(`  duplicate uses : ${duplicates} (total assigments over unique values: ${duplicates})`);
  // Distribution buckets
  const buckets = [
    { label: "seq 1..20        ", lo: 1, hi: 20 },
    { label: "seq 21..40       ", lo: 21, hi: 40 },
    { label: "seq 41..60       ", lo: 41, hi: 60 },
    { label: "seq 61..80       ", lo: 61, hi: 80 },
    { label: "seq 81..200      ", lo: 81, hi: 200 },
    { label: "seq 201..500     ", lo: 201, hi: 500 },
    { label: "seq 501..1000    ", lo: 501, hi: 1000 },
    { label: "seq 1001..1493   ", lo: 1001, hi: 1493 },
  ];
  console.log(`\n── distribution buckets (by firestore sequence_number integer) ──`);
  for (const b of buckets) {
    let n = 0;
    for (let s = b.lo; s <= b.hi; s++) n += seqCounts.get(s) ?? 0;
    console.log(`  ${b.label}: ${n}`);
  }
}
console.log(`\n── FIRESTORE seq vs CSV row order ──`);
console.log(`  Perfect matches (firestore seq == CSV row order for same article_id): ${assignedSeqSum.match}`);
console.log(`  Mismatches (firestore seq != CSV row order for same article_id):     ${assignedSeqSum.mismatch}`);
console.log(`  Article IDs in firestore but not in CSV:                               ${assignedSeqSum.notOnFirestore}`);
console.log(`  Articles with status=null/undefined:                                   ${nullStatus}`);

if (assignedSeqSum.mismatch > 0) {
  const sample = outOfOrder.slice(0, 10);
  console.log(`\n⚠️  SAMPLE MISMATCHES (firestoreSeq != expectedCsvSeq):`);
  console.log(`   article_id         | firestoreSeq | expectedCsvSeq | status`);
  for (const s of sample) {
    console.log(`   ${s.articleId.slice(-10).padStart(10)} | ${String(s.firestoreSeq).padStart(12)} | ${String(s.expectedCsvSeq).padStart(14)} | ${s.status ?? ''}`);
  }
}

if (undefinedCount + notInteger === 0 && assignedSeqSum.mismatch === 0) {
  console.log(`\n✅ NO REPAIR NEEDED. sequence_number is 100% intact and matches CSV order 1-1493.`);
} else {
  console.log(`\n⚠️  Repair IS recommended.`);
}
console.log();
