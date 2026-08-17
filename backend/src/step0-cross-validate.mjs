// STEP 0 SUPPLEMENTARY CROSS-VALIDATION SCRIPT (READ-ONLY)
// Compares Firestore article_ids vs CSV article_ids + metadata.
// NO WRITES TO FIRESTORE.
//
// Reports:
//   a) Firestore article_ids missing from CSV
//   b) CSV article_ids missing from Firestore
//   c) For matched article_ids: mismatches in headline/source/category (first 10 shown)
//
// Usage: node backend/src/step0-cross-validate.mjs

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

// ---- CSV parse (lightweight) ----
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
  console.log("STEP 0 SUPPLEMENTARY — FIRESTORE ⇄ CSV CROSS-VALIDATION (read-only)");
  console.log("=".repeat(100));
  console.log();

  const csvRows = parseCsv(fs.readFileSync(CSV_PATH, "utf8"));
  console.log(`✅ CSV parsed: ${csvRows.length} data rows`);

  // Build CSV map keyed by article_id
  const csvById = new Map();
  for (const r of csvRows) {
    if (!r.article_id) continue;
    csvById.set(r.article_id, r);
  }
  console.log(`✅ CSV unique article_ids: ${csvById.size}`);

  // Pull all Firestore articles
  console.log(`⌛ Pulling ALL Firestore articles …`);
  const snap = await db.collection("articles").get();
  const fsRows = new Map();
  snap.forEach((d) => fsRows.set(d.id, d.data()));
  console.log(`✅ Firestore articles doc count: ${fsRows.size}`);
  console.log();

  const fsIds = new Set(fsRows.keys());
  const csvIds = new Set(csvById.keys());

  // (a) Firestore IDs missing from CSV
  const fsOnly = [...fsIds].filter((id) => !csvIds.has(id)).sort();
  console.log(`── (a) Firestore article_ids NOT IN CSV (orphans)  — n = ${fsOnly.length}`);
  if (fsOnly.length === 0) {
    console.log("   (none)");
  } else {
    fsOnly.slice(0, 50).forEach((id) => {
      const a = fsRows.get(id);
      console.log(`   - ${id}   status=${a?.status ?? "?"}  category=${a?.category ?? "?"}  annotation_count=${a?.annotation_count ?? "?"}`);
    });
    if (fsOnly.length > 50) console.log(`   … +${fsOnly.length - 50} more (full list on request)`);
  }
  console.log();

  // (b) CSV IDs missing from Firestore
  const csvOnly = [...csvIds].filter((id) => !fsIds.has(id)).sort();
  console.log(`── (b) CSV article_ids NOT IN FIRESTORE  — n = ${csvOnly.length}`);
  if (csvOnly.length === 0) {
    console.log("   (none)");
  } else {
    csvOnly.slice(0, 50).forEach((id) => {
      const a = csvById.get(id);
      console.log(`   - ${id}   source=${a?.source ?? "?"}  category=${a?.category ?? "?"}`);
    });
    if (csvOnly.length > 50) console.log(`   … +${csvOnly.length - 50} more`);
  }
  console.log();

  // (c) Matched articles — metadata mismatches
  const commonIds = [...fsIds].filter((id) => csvIds.has(id));
  console.log(`── (c) Matched articles present in BOTH  — n = ${commonIds.length}`);
  const compare = (a, b) => (a ?? "").trim() === (b ?? "").trim();
  const mismatches = [];
  for (const id of commonIds) {
    const c = csvById.get(id);
    const f = fsRows.get(id);
    const issues = [];
    if (!compare(c.headline, f.headline)) issues.push("headline");
    if (!compare(c.source, f.source)) issues.push("source");
    if (!compare(c.author, f.author)) issues.push("author");
    if (!compare(c.category, f.category)) issues.push("category");
    if (!compare(c.article_type, f.article_type)) issues.push("article_type");
    // text field check is expensive, skip — headline+source+author+category is enough
    if (issues.length > 0) mismatches.push({ id, fields: issues });
    if (mismatches.length > 20) break; // cap display
  }
  // Now count total mismatches across all common (without capping)
  let totalMetaMismatches = 0;
  for (const id of commonIds) {
    const c = csvById.get(id);
    const f = fsRows.get(id);
    const anyDiff =
      !compare(c.headline, f.headline) ||
      !compare(c.source, f.source) ||
      !compare(c.author, f.author) ||
      !compare(c.category, f.category) ||
      !compare(c.article_type, f.article_type);
    if (anyDiff) totalMetaMismatches++;
  }

  console.log(`   Articles with metadata mismatches (total):  ${totalMetaMismatches} of ${commonIds.length}`);
  if (mismatches.length === 0) {
    console.log("   (none — all matched articles have identical metadata)");
  } else {
    console.log(`   First ${mismatches.length} examples:`);
    mismatches.forEach(({ id, fields }) => {
      console.log(`   - ${id}:  diff on [${fields.join(", ")}]`);
    });
  }

  console.log();
  console.log("=".repeat(100));
  console.log("SUMMARY");
  console.log(`  CSV article_ids total:        ${csvIds.size}`);
  console.log(`  Firestore article_ids total:  ${fsIds.size}`);
  console.log(`  Intersection (matched):       ${commonIds.length}`);
  console.log(`  FS-only (orphans):            ${fsOnly.length}`);
  console.log(`  CSV-only (not uploaded):      ${csvOnly.length}`);
  console.log(`  Metadata mismatches:          ${totalMetaMismatches}`);
  console.log("=".repeat(100));
})().catch((e) => {
  console.error("💥 Crash:", e);
  process.exit(1);
});
