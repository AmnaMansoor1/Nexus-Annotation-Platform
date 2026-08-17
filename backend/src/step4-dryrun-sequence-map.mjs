// STEP 4 DRY-RUN — sequence_number mapping preview (READ-ONLY)
// Source of order = annotation_dataset_v6.csv ROW ORDER.
// sequence_number = csvRowIndex + 1.
// Maps: article_id -> sequence_number, and validates that the article_id exists in Firestore.
//
// NO WRITES TO FIRESTORE EVER IN THIS SCRIPT.
//
// Usage: node backend/src/step4-dryrun-sequence-map.mjs

import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
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
  console.log("STEP 4 DRY-RUN — sequence_number MAPPING PREVIEW (READ-ONLY)");
  console.log("Source of truth: annotation_dataset_v6.csv row order.   sequence_number = csvRowIndex + 1");
  console.log("=".repeat(100));
  console.log();

  const csvRows = parseCsv(fs.readFileSync(CSV_PATH, "utf8"));
  console.log(`✅ CSV rows loaded: ${csvRows.length}`);

  // Build the CSV→sequence number mapping (1,493 rows → 1..1,493)
  const csvSeqById = new Map(); // article_id -> sequence_number
  csvRows.forEach((r, idx) => {
    if (!r.article_id) return;
    csvSeqById.set(r.article_id, idx + 1); // 1-indexed
  });
  console.log(`✅ CSV unique IDs: ${csvSeqById.size}`);
  console.log();

  // Pull all Firestore articles by ID to validate set intersection
  console.log(`⌛ Pulling ALL Firestore article IDs for membership check …`);
  const snap = await db.collection("articles").get();
  const fsIds = new Set();
  snap.forEach((d) => fsIds.add(d.id));
  console.log(`✅ Firestore articles loaded: ${fsIds.size}`);
  console.log();

  const common = [...csvSeqById.keys()].filter((id) => fsIds.has(id));
  const orphanCsvOnly = [...csvSeqById.keys()].filter((id) => !fsIds.has(id));
  const orphanFsOnly = [...fsIds].filter((id) => !csvSeqById.has(id));

  console.log(`Intersection (will get sequence_number assigned):  ${common.length}`);
  console.log(`CSV-only IDs (NO write planned):                    ${orphanCsvOnly.length}`);
  console.log(`Firestore-only IDs (NO sequence_number set):        ${orphanFsOnly.length}`);
  console.log();

  // Build the dry-run list sorted by sequence_number = CSV row order
  const plan = common
    .map((id) => ({ id, seq: csvSeqById.get(id) }))
    .sort((a, b) => a.seq - b.seq);

  // ── Preview: first 10 ──
  console.log("── First 10 sequence assignments (sequence_number → article_id) ──");
  plan.slice(0, 10).forEach(({ seq, id }) => {
    const row = csvRows[seq - 1];
    const headline = (row?.headline ?? "").replace(/\s+/g, " ").slice(0, 50).padEnd(52);
    console.log(`  sequence_number ${String(seq).padStart(4)}  →  article_id=${id.padEnd(12)}  headline="${headline}…"`);
  });
  console.log();

  // ── Preview: last 10 ──
  console.log("── Last 10 sequence assignments (sequence_number → article_id) ──");
  plan.slice(-10).forEach(({ seq, id }) => {
    const row = csvRows[seq - 1];
    const headline = (row?.headline ?? "").replace(/\s+/g, " ").slice(0, 50).padEnd(52);
    console.log(`  sequence_number ${String(seq).padStart(4)}  →  article_id=${id.padEnd(12)}  headline="${headline}…"`);
  });
  console.log();

  // ── Sample: 5 random from middle (deterministic seed 42 reproducible) ──
  function mulberry32(seed) {
    return function () {
      let t = (seed += 0x6d2b79f5);
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const rand = mulberry32(42);
  const midN = 5;
  const midStart = Math.floor(plan.length / 2);
  const midSample = [];
  for (let i = 0; i < midN; i++) {
    const offset = Math.floor(rand() * plan.length);
    midSample.push(plan[offset]);
  }
  midSample.sort((a, b) => a.seq - b.seq);
  console.log(`── ${midN} deterministic mid-range sample (seed=42) ──`);
  midSample.forEach(({ seq, id }) => {
    const row = csvRows[seq - 1];
    const headline = (row?.headline ?? "").replace(/\s+/g, " ").slice(0, 50).padEnd(52);
    console.log(`  sequence_number ${String(seq).padStart(4)}  →  article_id=${id.padEnd(12)}  headline="${headline}…"`);
  });
  console.log();

  // ── Summary stats on the scope of future write (NOT executed) ──
  console.log("=".repeat(100));
  console.log("FUTURE WRITE SCOPE — if approved (NOT executed in this run):");
  console.log(`  - Docs to be written with sequence_number field:  ${plan.length}`);
  console.log(`  - sequence_number range:                          1 → ${plan[plan.length - 1]?.seq ?? 0}`);
  console.log(`  - Firestore-only orphans (no write):              ${orphanFsOnly.length}`);
  orphanFsOnly.slice(0, 20).forEach((id) =>
    console.log(`      orphan id: ${id}`)
  );
  if (orphanFsOnly.length > 20) console.log(`      … +${orphanFsOnly.length - 20} more`);
  console.log(`  - CSV-only rows (no Firestore doc → skip):        ${orphanCsvOnly.length}`);
  orphanCsvOnly.slice(0, 5).forEach((id) => console.log(`      csv only id: ${id}`));
  console.log();
  console.log("  >>> THIS SCRIPT DID NOT WRITE ANYTHING TO FIRESTORE. <<<");
  console.log("=".repeat(100));
})().catch((e) => {
  console.error("💥 Crash:", e);
  process.exit(1);
});
