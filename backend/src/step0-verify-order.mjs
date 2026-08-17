// STEP 0 — READ-ONLY VERIFICATION SCRIPT
// Compares: Firestore articles ordered by __name__ (document ID) vs annotation_dataset_v6.csv row order.
// NO WRITES TO FIRESTORE EVER.
//
// Usage from project root:
//   node backend/src/step0-verify-order.mjs
//
// Produces: first-20 / last-20 / random-20 side-by-side article_id lists + a PASS/FAIL verdict.

import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");

const SERVICE_ACCOUNT_PATH = path.join(PROJECT_ROOT, "service-account.json");
const CSV_PATH = path.join(PROJECT_ROOT, "annotation_dataset_v6.csv");

if (!fs.existsSync(SERVICE_ACCOUNT_PATH)) {
  console.error("❌ service-account.json not found at:", SERVICE_ACCOUNT_PATH);
  process.exit(1);
}
if (!fs.existsSync(CSV_PATH)) {
  console.error("❌ annotation_dataset_v6.csv not found at:", CSV_PATH);
  process.exit(1);
}

// Init Firebase Admin (read-only use here)
const serviceAccount = JSON.parse(fs.readFileSync(SERVICE_ACCOUNT_PATH, "utf8"));
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

// ---------- CSV parse (minimal, first column only = article_id) ----------
function parseCsvArticleIdsFromRaw(csvText) {
  const lines = csvText.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const [headerLine, ...rows] = lines;
  // Find which column is article_id
  const headers = splitCsvRow(headerLine);
  const articleIdIdx = headers.indexOf("article_id");
  if (articleIdIdx === -1) {
    throw new Error(`Could not find article_id column in CSV header. Headers: ${headers.join(" | ")}`);
  }
  return rows.map((r) => splitCsvRow(r)[articleIdIdx]);
}
// Handles commas-inside-quotes (CSV standard)
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

// ---------- Deterministic sample indices (so you can reproduce / eyeball) ----------
function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function pickSample(array, n, seed = 42) {
  const rand = mulberry32(seed);
  const idxs = [];
  for (let i = 0; i < array.length; i++) idxs.push(i);
  // partial Fisher-Yates
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(rand() * (array.length - i));
    [idxs[i], idxs[j]] = [idxs[j], idxs[i]];
  }
  return idxs.slice(0, n).sort((a, b) => a - b);
}

// ---------- Main ----------
(async () => {
  console.log("=".repeat(100));
  console.log("STEP 0 VERIFICATION — Firestore __name__ order ↔ CSV row order");
  console.log("CSV file:", CSV_PATH);
  console.log("=".repeat(100));
  console.log();

  const csvIds = parseCsvArticleIdsFromRaw(fs.readFileSync(CSV_PATH, "utf8"));
  console.log(`✅ CSV parsed. Row count (article IDs extracted): ${csvIds.length}`);

  // Fetch ALL articles from Firestore ordered by document ID (__name__ asc)
  console.log(`⌛ Pulling ALL articles from Firestore, ordered by doc ID …`);
  const snapshot = await db.collection("articles").orderBy("__name__", "asc").get();
  const fsIds = snapshot.docs.map((d) => d.id);
  console.log(`✅ Firestore pulled. Doc count: ${fsIds.length}`);
  console.log();

  if (fsIds.length !== csvIds.length) {
    console.warn(`⚠️  COUNT MISMATCH — CSV has ${csvIds.length}, Firestore has ${fsIds.length}`);
  }

  const commonLen = Math.min(csvIds.length, fsIds.length);

  // ---------- Diff per position ----------
  let mismatches = 0;
  const firstMismatchIdx = (() => {
    for (let i = 0; i < commonLen; i++) {
      if (csvIds[i] !== fsIds[i]) {
        mismatches++;
        if (mismatches === 1) return i;
      }
    }
    return -1;
  })();
  // Recompute total mismatches (count all)
  mismatches = 0;
  for (let i = 0; i < commonLen; i++) if (csvIds[i] !== fsIds[i]) mismatches++;

  // ---------- Helper: side-by-side block ----------
  function block(label, indices) {
    const rows = [
      `── ${label} ──`,
      String("idx").padEnd(5) +
        "  " +
        String("CSV").padEnd(14) +
        "  " +
        String("Firestore").padEnd(14) +
        "  match",
      "─".repeat(5 + 2 + 14 + 2 + 14 + 2 + 6),
    ];
    for (const i of indices) {
      const a = csvIds[i] ?? "<none>";
      const b = fsIds[i] ?? "<none>";
      const ok = a === b ? "✅" : "❌";
      rows.push(String(i).padEnd(5) + "  " + a.padEnd(14) + "  " + b.padEnd(14) + "  " + ok);
    }
    return rows.join("\n");
  }

  const firstRange = Array.from({ length: 20 }, (_, i) => i);
  const lastStart = Math.max(0, commonLen - 20);
  const lastRange = Array.from({ length: 20 }, (_, i) => lastStart + i);
  const sampleN = Math.min(20, commonLen);
  const sampleRange = pickSample(Array.from({ length: commonLen }, (_, i) => i), sampleN, 12345);

  console.log(block("FIRST 20 POSITIONS (idx 0..19)", firstRange));
  console.log();
  console.log(block(`LAST 20 POSITIONS (idx ${lastStart}..${lastStart + 19})`, lastRange));
  console.log();
  console.log(block(`RANDOM SAMPLE (n=${sampleRange.length}, seed=12345, sorted for readability)`, sampleRange));
  console.log();

  console.log("=".repeat(100));
  console.log("VERDICT:");
  console.log(`  Total positions compared:  ${commonLen} of ${csvIds.length} CSV / ${fsIds.length} Firestore`);
  console.log(`  Total mismatches:          ${mismatches}`);
  console.log(`  First mismatch at index:   ${firstMismatchIdx === -1 ? "— none —" : firstMismatchIdx}`);
  if (mismatches === 0) {
    console.log();
    console.log("🎉 PASS: Firestore __name__ order == CSV row order for every matched position.");
    console.log("   sequence_number = csv_row_index + 1 is safe to derive from CSV + write to FS.");
  } else {
    console.log();
    console.log("🛑 FAIL: " + mismatches + " position mismatches detected.");
    console.log("   DO NOT write sequence_number until ordering source is reconfirmed.");
    console.log("   (See the ❌ rows above.)");
    process.exitCode = 2;
  }
  console.log("=".repeat(100));
})().catch((err) => {
  console.error("💥 Script crashed:", err);
  process.exit(1);
});
