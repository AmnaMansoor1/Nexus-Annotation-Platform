/**
 * replace-articles.mjs
 *
 * PURPOSE:
 *   1. Delete ALL documents in the "articles" Firestore collection.
 *   2. Re-import ONLY the new CSV  (1500art_final_annotation_dataset.csv).
 *   3. Reset stats/platform_summary to match the fresh import.
 *
 * USAGE:
 *   node backend/src/replace-articles.mjs
 *
 * REQUIREMENTS:
 *   • service-account.json must exist at the project root.
 *   • 1500art_final_annotation_dataset.csv must exist at the project root.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import Papa from "papaparse";
import admin from "firebase-admin";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "../../");

const SERVICE_ACCOUNT_PATH = path.join(ROOT, "service-account.json");
const CSV_PATH = path.join(ROOT, "1500art_final_annotation_dataset.csv");

// ── Guards ─────────────────────────────────────────────────────────────────
if (!fs.existsSync(SERVICE_ACCOUNT_PATH)) {
  console.error("❌ service-account.json not found at project root.");
  process.exit(1);
}
if (!fs.existsSync(CSV_PATH)) {
  console.error("❌ 1500art_final_annotation_dataset.csv not found at project root.");
  process.exit(1);
}

// ── Firebase init ──────────────────────────────────────────────────────────
const serviceAccount = JSON.parse(fs.readFileSync(SERVICE_ACCOUNT_PATH, "utf8"));
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();
const MAX_BATCH = 500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Helpers ────────────────────────────────────────────────────────────────
async function deleteCollection(collRef, batchSize = MAX_BATCH) {
  let totalDeleted = 0;
  while (true) {
    const snap = await collRef.orderBy("__name__").limit(batchSize).get();
    if (snap.empty) break;
    const batch = db.batch();
    snap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
    totalDeleted += snap.size;
    process.stdout.write(`\r   Deleted ${totalDeleted} articles so far...`);
    await sleep(100);
  }
  return totalDeleted;
}

// ── Main ───────────────────────────────────────────────────────────────────
async function main() {
  console.log("\n" + "=".repeat(65));
  console.log("🔄  NEXUS — REPLACE ARTICLES SCRIPT");
  console.log("=".repeat(65));
  console.log("\nThis will:");
  console.log("  ✘ DELETE all existing documents in the 'articles' collection");
  console.log("  ✔ IMPORT 1500art_final_annotation_dataset.csv as the new dataset");
  console.log("  ✔ RESET stats/platform_summary\n");

  // Manual confirmation
  const readline = (await import("readline")).createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const answer = await new Promise((resolve) => {
    readline.question('⚠️  Type "REPLACE" to confirm: ', (a) => resolve(a.trim()));
  });
  readline.close();

  if (answer !== "REPLACE") {
    console.log("\n❌ Aborted. Nothing was changed.\n");
    process.exit(0);
  }

  // ── STEP 1: Wipe articles ──────────────────────────────────────────────
  console.log("\n[1/3] Deleting all existing articles from Firestore...");
  const articlesRef = db.collection("articles");
  const deleted = await deleteCollection(articlesRef);
  console.log(`\n      ✔ Deleted ${deleted} old article documents\n`);

  // ── STEP 2: Parse CSV ─────────────────────────────────────────────────
  console.log("[2/3] Parsing new CSV...");
  const csvFile = fs.readFileSync(CSV_PATH, "utf8");
  const { data: rows, errors } = Papa.parse(csvFile, {
    header: true,
    skipEmptyLines: true,
  });

  if (errors.length > 0) {
    console.error("❌ CSV parse errors:", errors);
    process.exit(1);
  }
  console.log(`      ✔ Parsed ${rows.length} rows\n`);

  // ── STEP 3: Import rows into Firestore ────────────────────────────────
  console.log("[3/3] Importing articles into Firestore...");
  let imported = 0;
  let skipped = 0;
  const categoryDistribution = {};

  for (let i = 0; i < rows.length; i += MAX_BATCH) {
    const chunk = rows.slice(i, Math.min(i + MAX_BATCH, rows.length));
    const batch = db.batch();
    let batchCount = 0;

    for (let j = 0; j < chunk.length; j++) {
      const row = chunk[j];
      const articleId = row.article_id?.trim();
      if (!articleId) { skipped++; continue; }

      const sequenceNumber = i + j + 1; // 1-based, preserves CSV row order

      let mlLabel = null;
      if (row.label === "0" || row.label === 0) mlLabel = 0;
      else if (row.label === "1" || row.label === 1) mlLabel = 1;
      else if (row.ml_label === "0" || row.ml_label === 0) mlLabel = 0;
      else if (row.ml_label === "1" || row.ml_label === 1) mlLabel = 1;

      let humanFinal = null;
      const fl = row.final_label;
      if (fl === "neutral" || fl === "slightly_manipulative" || fl === "highly_manipulative") {
        humanFinal = fl;
      }

      const requiredAnnotations = row.required_annotations
        ? parseInt(row.required_annotations, 10)
        : 3; // default

      const cat = row.category || "Uncategorized";
      categoryDistribution[cat] = (categoryDistribution[cat] || 0) + 1;

      const article = {
        article_id: articleId,
        headline: row.headline || "",
        display_text: row.display_text || row.full_text || row.summary || "",
        source: row.source || "",
        author: row.author || "",
        date_published: row.date_published || "",
        url: row.url || "",
        category: cat,
        article_type: row.article_type || "News Article",
        word_count: parseInt(row.word_count) || 0,
        sequence_number: sequenceNumber,
        status: "pending",
        required_annotations: requiredAnnotations,
        annotation_count: 0,
        annotated_by: [],
        assigned_to: [],
        assigned_count: 0,
        bias_score: null,
        percent_agreement: null,
        label: mlLabel,
        final_label: humanFinal,
        is_gold_standard: row.is_gold_standard === "true" || row.is_gold_standard === "1",
      };
      if (row.gold_expected_label) {
        article.gold_expected_label = row.gold_expected_label;
      }

      batch.set(articlesRef.doc(articleId), article);
      batchCount++;
    }

    await batch.commit();
    imported += batchCount;
    process.stdout.write(`\r   Imported ${imported}/${rows.length} articles...`);
    await sleep(100);
  }
  console.log(`\n      ✔ Imported ${imported} articles, skipped ${skipped} (missing article_id)\n`);

  // ── Reset platform stats ───────────────────────────────────────────────
  await db.doc("stats/platform_summary").set({
    totalArticles: imported,
    completedArticles: 0,
    pendingArticles: imported,
    inProgressArticles: 0,
    totalAnnotators: 0,
    completedAnnotators: 0,
    avgBiasScore: 0,
    needsReview: 0,
    categoryDistribution,
  });
  console.log("      ✔ stats/platform_summary reset\n");

  // ── Final verification ─────────────────────────────────────────────────
  const finalCount = (await articlesRef.count().get()).data().count;
  console.log("=".repeat(65));
  console.log("✅  DONE");
  console.log("=".repeat(65));
  console.log(`\n   Articles now in Firestore: ${finalCount}`);
  console.log(`   Expected:                  ${imported}\n`);
  process.exit(0);
}

main().catch((err) => {
  console.error("\n❌ FATAL:", err);
  process.exit(1);
});
