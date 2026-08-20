// FULL SEQUENCE REPAIR — fixes CSV order + orphan articles in one run.
//
// 1. Loads annotation_dataset_v6.csv row order → sequence_number 1..N for CSV articles.
// 2. Finds Firestore-only articles (not in CSV) and moves them to the end (N+1, N+2, …).
// 3. Writes only { sequence_number } with merge:true — no other fields touched.
//
// Usage: node backend/src/repair-sequence-full.mjs
// Dry-run: node backend/src/repair-sequence-full.mjs --dry-run

import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const SERVICE_ACCOUNT_PATH = path.join(PROJECT_ROOT, "service-account.json");
const CSV_PATH = path.join(PROJECT_ROOT, "annotation_dataset_v6.csv");
const DRY_RUN = process.argv.includes("--dry-run");

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

const serviceAccount = JSON.parse(fs.readFileSync(SERVICE_ACCOUNT_PATH, "utf8"));
const app = getApps().length === 0
  ? initializeApp({ credential: cert(serviceAccount) })
  : getApps()[0];
const db = getFirestore(app);

(async () => {
  console.log("=".repeat(100));
  console.log(DRY_RUN
    ? "FULL SEQUENCE REPAIR — DRY RUN (no writes)"
    : "FULL SEQUENCE REPAIR — WILL WRITE TO FIRESTORE");
  console.log("Source of truth: annotation_dataset_v6.csv row order");
  console.log("=".repeat(100));
  console.log();

  const csvRows = parseCsv(fs.readFileSync(CSV_PATH, "utf8"));
  const csvSeqById = new Map();
  csvRows.forEach((r, idx) => {
    if (!r.article_id) return;
    csvSeqById.set(r.article_id, idx + 1);
  });
  const csvMaxSeq = csvRows.length;

  console.log(`CSV rows: ${csvRows.length}, unique IDs: ${csvSeqById.size}`);

  const snap = await db.collection("articles").get();
  const fsIds = snap.docs.map((d) => d.id);
  console.log(`Firestore articles: ${fsIds.length}`);

  const orphans = fsIds.filter((id) => !csvSeqById.has(id)).sort();
  const csvInFs = fsIds.filter((id) => csvSeqById.has(id));

  console.log(`CSV articles in Firestore: ${csvInFs.length}`);
  console.log(`Orphans (Firestore-only, will move to end): ${orphans.length}`);
  if (orphans.length > 0) {
    orphans.forEach((id, i) => {
      const oldSeq = snap.docs.find((d) => d.id === id)?.data()?.sequence_number;
      console.log(`  ${id}  old_seq=${oldSeq ?? "?"}  →  new_seq=${csvMaxSeq + 1 + i}`);
    });
  }
  console.log();

  const writes = [];

  for (const id of csvInFs) {
    const newSeq = csvSeqById.get(id);
    const oldSeq = snap.docs.find((d) => d.id === id)?.data()?.sequence_number;
    if (oldSeq !== newSeq) {
      writes.push({ id, newSeq, oldSeq, kind: "csv" });
    }
  }

  orphans.forEach((id, i) => {
    const newSeq = csvMaxSeq + 1 + i;
    const oldSeq = snap.docs.find((d) => d.id === id)?.data()?.sequence_number;
    if (oldSeq !== newSeq) {
      writes.push({ id, newSeq, oldSeq, kind: "orphan" });
    }
  });

  writes.sort((a, b) => a.newSeq - b.newSeq);

  console.log(`Documents needing update: ${writes.length}`);
  console.log(`  CSV rewrites: ${writes.filter((w) => w.kind === "csv").length}`);
  console.log(`  Orphan moves: ${writes.filter((w) => w.kind === "orphan").length}`);
  console.log();

  if (writes.length === 0) {
    console.log("✅ Nothing to update — sequence numbers already match CSV order.");
    process.exit(0);
  }

  console.log("── Preview: first 10 writes ──");
  writes.slice(0, 10).forEach(({ id, newSeq, oldSeq, kind }) => {
    console.log(`  [${kind}] ${id}  ${oldSeq ?? "null"} → ${newSeq}`);
  });
  console.log();

  console.log("── Preview: last 10 writes ──");
  writes.slice(-10).forEach(({ id, newSeq, oldSeq, kind }) => {
    console.log(`  [${kind}] ${id}  ${oldSeq ?? "null"} → ${newSeq}`);
  });
  console.log();

  if (DRY_RUN) {
    console.log("DRY RUN complete — no writes committed.");
    process.exit(0);
  }

  console.log("⚠️  Committing in 3 seconds — Ctrl+C to abort");
  await new Promise((r) => setTimeout(r, 3000));

  let batch = db.batch();
  let batchCount = 0;
  let committed = 0;
  const MAX_BATCH = 500;

  for (const w of writes) {
    if (batchCount >= MAX_BATCH) {
      await batch.commit();
      committed += batchCount;
      console.log(`  ✅ Committed batch (${committed}/${writes.length})`);
      batch = db.batch();
      batchCount = 0;
    }
    batch.set(db.collection("articles").doc(w.id), { sequence_number: w.newSeq }, { merge: true });
    batchCount++;
  }
  if (batchCount > 0) {
    await batch.commit();
    committed += batchCount;
  }

  console.log();
  console.log(`✅ REPAIR COMPLETE. Updated ${committed} documents.`);
  console.log("Run: node backend/src/diagnose-sequence-numbers.mjs  to verify.");
  console.log("=".repeat(100));
})().catch((e) => {
  console.error("💥 Crash:", e);
  process.exit(1);
});
