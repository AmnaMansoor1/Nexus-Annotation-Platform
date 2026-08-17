// STEP 4 WRITE — sequence_number migration (ACTUALLY WRITES TO FIRESTORE)
// Source of order = annotation_dataset_v6.csv ROW ORDER.
// sequence_number = csvRowIndex + 1.
//
// ONLY writes the sequence_number field; all other fields are untouched.
// Uses batched writes (500/write-batch) for throughput.
//
// Usage: node backend/src/step4-write-sequence-number.mjs

import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const SERVICE_ACCOUNT_PATH = path.join(PROJECT_ROOT, "service-account.json");
const CSV_PATH = path.join(PROJECT_ROOT, "annotation_dataset_v6.csv");

const serviceAccount = JSON.parse(fs.readFileSync(SERVICE_ACCOUNT_PATH, "utf8"));
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const [headerLine, ...rows] = lines;
  const headers = splitCsvRow(headerLine);
  return rows.map((r) => {
    const cells = splitCsvRow(r);
    const obj = {};
    headers.forEach((h, i) => (obj[h] = cells[i] ?? ""));
    return obj;
  });
}
function splitCsvRow(row) {
  const out = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < row.length; i++) {
    const ch = row[i];
    if (ch === '"') {
      inQ = !inQ;
    } else if (ch === "," && !inQ) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

(async () => {
  console.log("=".repeat(100));
  console.log("STEP 4 WRITE — sequence_number MIGRATION (WILL WRITE TO FIRESTORE)");
  console.log("Source of truth: annotation_dataset_v6.csv row order.   sequence_number = csvRowIndex + 1");
  console.log("=".repeat(100));
  console.log();

  const csvRows = parseCsv(fs.readFileSync(CSV_PATH, "utf8"));
  console.log(`✅ CSV rows loaded: ${csvRows.length}`);

  const csvSeqById = new Map();
  csvRows.forEach((r, idx) => {
    if (!r.article_id) return;
    csvSeqById.set(r.article_id, idx + 1);
  });
  console.log(`✅ CSV unique IDs: ${csvSeqById.size}`);
  console.log();

  console.log(`⌛ Pulling ALL Firestore article IDs for membership check …`);
  const snap = await db.collection("articles").get();
  const fsDocs = new Map();
  snap.forEach((d) => fsDocs.set(d.id, d));
  console.log(`✅ Firestore articles loaded: ${fsDocs.size}`);
  console.log();

  const toWrite = [];
  for (const [id, docSnap] of fsDocs.entries()) {
    if (!csvSeqById.has(id)) continue;
    const data = docSnap.data();
    const existingSeq = data?.sequence_number;
    toWrite.push({
      id,
      seq: csvSeqById.get(id),
      existedBefore: typeof existingSeq === "number",
      oldValue: existingSeq ?? null,
    });
  }

  toWrite.sort((a, b) => a.seq - b.seq);
  const orphanCsvOnly = [...csvSeqById.keys()].filter((id) => !fsDocs.has(id));
  const orphanFsOnly = [...fsDocs.keys()].filter((id) => !csvSeqById.has(id));

  console.log(`Docs that will get sequence_number:       ${toWrite.length}`);
  console.log(`  - Already had sequence_number (overwrite):${toWrite.filter((w) => w.existedBefore).length}`);
  console.log(`  - Brand-new field:                         ${toWrite.filter((w) => !w.existedBefore).length}`);
  console.log(`Firestore-only orphans (no write):          ${orphanFsOnly.length}`);
  console.log(`CSV-only rows (no Firestore doc → skip):    ${orphanCsvOnly.length}`);
  console.log();

  if (toWrite.length === 0) {
    console.log("Nothing to write. Exiting.");
    process.exit(0);
  }

  const seqValues = toWrite.map((w) => w.seq);
  const minSeq = Math.min(...seqValues);
  const maxSeq = Math.max(...seqValues);
  const uniqueSeqs = new Set(seqValues);
  console.log(`sequence_number range:  ${minSeq} → ${maxSeq}`);
  console.log(`Unique sequence values: ${uniqueSeqs.size} / ${toWrite.length} total`);
  console.log();

  console.log("── Preview: first 10 writes ──");
  toWrite.slice(0, 10).forEach(({ id, seq, oldValue }) => {
    const tag = oldValue === null ? "NEW" : `OVERWRITE (was ${oldValue})`;
    console.log(`  sequence_number ${String(seq).padStart(4)}  →  article_id=${id.padEnd(12)}  [${tag}]`);
  });
  console.log();

  console.log("── Preview: last 10 writes ──");
  toWrite.slice(-10).forEach(({ id, seq, oldValue }) => {
    const tag = oldValue === null ? "NEW" : `OVERWRITE (was ${oldValue})`;
    console.log(`  sequence_number ${String(seq).padStart(4)}  →  article_id=${id.padEnd(12)}  [${tag}]`);
  });
  console.log();

  console.log("⚠️  ABOUT TO COMMIT WRITES IN 3 SECONDS — PRESS CTRL+C TO ABORT ⚠️");
  await new Promise((r) => setTimeout(r, 3000));

  let committed = 0;
  let batch = db.batch();
  let batchCount = 0;
  const MAX_BATCH = 500;

  for (const w of toWrite) {
    if (batchCount >= MAX_BATCH) {
      await batch.commit();
      console.log(`  ✅ Committed intermediate batch of ${batchCount} writes (total so far: ${committed})`);
      batch = db.batch();
      batchCount = 0;
    }
    const ref = db.collection("articles").doc(w.id);
    batch.set(ref, { sequence_number: w.seq }, { merge: true });
    batchCount++;
    committed++;
  }

  if (batchCount > 0) {
    await batch.commit();
    console.log(`  ✅ Committed final batch of ${batchCount} writes`);
  }

  console.log();
  console.log("=".repeat(100));
  console.log(`✅ MIGRATION COMPLETE. Committed ${committed} document writes in total.`);
  console.log("=".repeat(100));
  console.log();
  console.log("Verifying writes...");

  const verifySnap = await db.collection("articles").get();
  let seqPresent = 0;
  let seqMissing = 0;
  const seenSeqs = new Set();
  const gaps = [];
  const duplicates = [];
  const verifyResults = new Map();

  verifySnap.forEach((d) => {
    const data = d.data();
    const seq = data?.sequence_number;
    const id = d.id;
    if (typeof seq === "number") {
      seqPresent++;
      if (seenSeqs.has(seq)) duplicates.push({ id, seq });
      seenSeqs.add(seq);
      verifyResults.set(id, seq);
    } else {
      seqMissing++;
    }
  });

  for (let i = minSeq; i <= maxSeq; i++) {
    if (!seenSeqs.has(i)) gaps.push(i);
  }

  console.log();
  console.log("── VERIFICATION REPORT ──");
  console.log(`  Firestore docs read:                   ${verifySnap.size}`);
  console.log(`  Docs WITH sequence_number:             ${seqPresent}`);
  console.log(`  Docs WITHOUT sequence_number:          ${seqMissing}`);
  console.log(`  Expected range:                        ${minSeq} → ${maxSeq}  (${maxSeq - minSeq + 1} values)`);
  console.log(`  Unique sequence values found:          ${seenSeqs.size}`);
  console.log(`  Gaps detected:                         ${gaps.length}`);
  if (gaps.length > 0) {
    const gapStr = gaps.length <= 50 ? gaps.join(", ") : gaps.slice(0, 50).join(", ") + ` … +${gaps.length - 50} more`;
    console.log(`    Gaps: [${gapStr}]`);
  }
  console.log(`  Duplicate sequences detected:          ${duplicates.length}`);
  if (duplicates.length > 0) {
    duplicates.slice(0, 10).forEach(({ id, seq }) => {
      console.log(`    DUP: seq=${seq}  article_id=${id}`);
    });
    if (duplicates.length > 10) console.log(`    … +${duplicates.length - 10} more`);
  }

  const spotCheckIds = toWrite.slice(0, 5).map((w) => w.id);
  console.log();
  console.log("── Spot-check (first 5 from CSV row-order) ──");
  spotCheckIds.forEach((id) => {
    const expected = csvSeqById.get(id);
    const actual = verifyResults.get(id);
    const status = expected === actual ? "✅" : "❌ MISMATCH";
    console.log(`  ${status} article_id=${id.padEnd(12)} expected_seq=${expected} actual_seq=${actual}`);
  });

  console.log();
  if (seqMissing === 0 && gaps.length === 0 && duplicates.length === 0) {
    console.log("🎉 ALL VERIFICATION CHECKS PASSED.");
  } else {
    console.log("⚠️  VERIFICATION FOUND ISSUES — review above before proceeding.");
  }
  console.log("=".repeat(100));
})().catch((e) => {
  console.error("💥 Crash:", e);
  process.exit(1);
});
