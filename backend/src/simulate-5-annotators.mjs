import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import Papa from "papaparse";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const sa = JSON.parse(fs.readFileSync(path.join(root, "service-account.json"), "utf8"));
const app = getApps().length ? getApps()[0] : initializeApp({ credential: cert(sa) });
const db = getFirestore(app);

// ── Formulas (identical to frontend utils) ───────────────────────────
function calculateBiasScore(counts) {
  const n = counts.neutral + counts.slightly + counts.highly;
  if (n === 0) return 0;
  const rawScore = (counts.highly * 2 + counts.slightly * 1 + counts.neutral * 0) / n;
  return parseFloat((rawScore * 2.5).toFixed(2));
}

function calculateFleissKappa(counts) {
  const categories = [counts.neutral, counts.slightly, counts.highly];
  const n = categories.reduce((sum, c) => sum + c, 0);
  if (n < 2) return 0;
  const sumSq = categories.reduce((sum, c) => sum + c * c, 0);
  const Po = (sumSq - n) / (n * (n - 1));
  const p_j = categories.map((c) => c / n);
  const Pe = p_j.reduce((sum, p) => sum + p * p, 0);
  if (Pe === 1) return 1;
  const kappa = (Po - Pe) / (1 - Pe);
  return parseFloat(kappa.toFixed(3));
}

function calculateOverallFleissKappa(allCounts) {
  if (allCounts.length === 0) return 0;
  const categoryMatrix = allCounts.map((c) => [c.neutral, c.slightly, c.highly]);
  const annotatorCounts = categoryMatrix.map((cat) => cat.reduce((sum, count) => sum + count, 0));
  const firstCount = annotatorCounts[0];
  if (firstCount < 2 || annotatorCounts.some((c) => c !== firstCount)) return 0;

  const articleAgreements = categoryMatrix.map((cat) => {
    const n = cat.reduce((s, c) => s + c, 0);
    const sumSq = cat.reduce((s, c) => s + c * c, 0);
    return (sumSq - n) / (n * (n - 1));
  });
  const observedAgreement = articleAgreements.reduce((sum, v) => sum + v, 0) / articleAgreements.length;
  const totalAssignments = firstCount * categoryMatrix.length;
  const categoryProportions = [0, 1, 2].map((idx) =>
    categoryMatrix.reduce((sum, cat) => sum + cat[idx], 0) / totalAssignments
  );
  const expectedAgreement = categoryProportions.reduce((sum, p) => sum + p * p, 0);
  if (expectedAgreement === 1) return 1;
  const kappa = (observedAgreement - expectedAgreement) / (1 - expectedAgreement);
  return parseFloat(kappa.toFixed(3));
}

function sanitizeEmailForDocId(email) {
  return email.toLowerCase().trim().replace(/[^a-zA-Z0-9]/g, "_");
}

console.log("=== STARTING 5-ANNOTATOR TEST SIMULATION ===");

// 1. Get first 20 articles by sequence_number
const articlesSnap = await db.collection("articles")
  .orderBy("sequence_number", "asc")
  .limit(20)
  .get();

if (articlesSnap.size < 20) {
  throw new Error(`Expected at least 20 articles, found ${articlesSnap.size}`);
}

const targetArticles = articlesSnap.docs.map(d => ({ id: d.id, ...d.data() }));
const targetArticleIds = targetArticles.map(a => a.id);
console.log(`Found 20 target articles: seq ${targetArticles[0].sequence_number} to ${targetArticles[19].sequence_number}`);

// 2. Define 5 test annotators
const dummyAnnotators = [
  { email: "test-annotator-1@cuilahore.edu.pk", name: "Test Student 1" },
  { email: "test-annotator-2@cuilahore.edu.pk", name: "Test Student 2" },
  { email: "test-annotator-3@cuilahore.edu.pk", name: "Test Student 3" },
  { email: "test-annotator-4@cuilahore.edu.pk", name: "Test Student 4" },
  { email: "test-annotator-5@cuilahore.edu.pk", name: "Test Student 5" },
];

const annotatorEmails = dummyAnnotators.map(a => a.email);

// Register annotator profiles
for (const ann of dummyAnnotators) {
  const docId = sanitizeEmailForDocId(ann.email);
  await db.collection("annotators").doc(docId).set({
    email: ann.email,
    full_name: ann.name,
    completed: true,
    completed_articles: targetArticleIds,
    assigned_articles: targetArticleIds,
    reliability_score: 100,
    gold_total_count: 2,
    gold_correct_count: 2,
    gold_accuracy: 100,
  });
}
console.log(`Registered ${dummyAnnotators.length} annotators in /annotators`);

// 3. Predefined realistic annotation distribution patterns for the 20 articles
// Patterns include: unanimous neutral, unanimous highly, clear majorities, slight bias, and ties
const labelPatterns = [
  ["neutral", "neutral", "neutral", "neutral", "neutral"], // Seq 1: unanimous neutral (bias=0.00, kappa=1.000, final=neutral, label=0)
  ["highly_manipulative", "highly_manipulative", "highly_manipulative", "highly_manipulative", "highly_manipulative"], // Seq 2: unanimous highly (bias=5.00, kappa=1.000, final=highly, label=1)
  ["slightly_manipulative", "slightly_manipulative", "slightly_manipulative", "slightly_manipulative", "slightly_manipulative"], // Seq 3: unanimous slightly (bias=2.50, kappa=1.000, final=slightly, label=1)
  ["neutral", "neutral", "neutral", "slightly_manipulative", "slightly_manipulative"], // Seq 4: 3-2 majority neutral (bias=1.00, kappa=0.400, final=neutral, label=0)
  ["highly_manipulative", "highly_manipulative", "highly_manipulative", "slightly_manipulative", "slightly_manipulative"], // Seq 5: 3-2 majority highly (bias=4.00, kappa=0.400, final=highly, label=1)
  ["neutral", "neutral", "slightly_manipulative", "slightly_manipulative", "highly_manipulative"], // Seq 6: 2-2-1 TIE (bias=2.00, kappa=-0.250, final=null, label=0)
  ["highly_manipulative", "highly_manipulative", "slightly_manipulative", "slightly_manipulative", "neutral"], // Seq 7: 2-2-1 TIE (bias=3.00, kappa=-0.250, final=null, label=1)
  ["neutral", "neutral", "neutral", "neutral", "highly_manipulative"], // Seq 8: 4-1 majority neutral (bias=1.00, kappa=0.625, final=neutral, label=0)
  ["highly_manipulative", "highly_manipulative", "highly_manipulative", "highly_manipulative", "neutral"], // Seq 9: 4-1 majority highly (bias=4.00, kappa=0.625, final=highly, label=1)
  ["slightly_manipulative", "slightly_manipulative", "slightly_manipulative", "neutral", "neutral"], // Seq 10: 3-2 majority slightly (bias=1.50, kappa=0.400, final=slightly, label=0)
  ["neutral", "neutral", "neutral", "slightly_manipulative", "neutral"], // Seq 11: 4-1 neutral (bias=0.50, kappa=0.625, final=neutral, label=0)
  ["highly_manipulative", "highly_manipulative", "highly_manipulative", "slightly_manipulative", "highly_manipulative"], // Seq 12: 4-1 highly (bias=4.50, kappa=0.625, final=highly, label=1)
  ["slightly_manipulative", "slightly_manipulative", "slightly_manipulative", "slightly_manipulative", "highly_manipulative"], // Seq 13: 4-1 slightly (bias=3.00, kappa=0.625, final=slightly, label=1)
  ["neutral", "slightly_manipulative", "neutral", "slightly_manipulative", "neutral"], // Seq 14: 3-2 neutral (bias=1.00, kappa=0.400, final=neutral, label=0)
  ["highly_manipulative", "slightly_manipulative", "highly_manipulative", "neutral", "highly_manipulative"], // Seq 15: 3-1-1 majority highly (bias=3.50, kappa=0.250, final=highly, label=1)
  ["neutral", "neutral", "neutral", "neutral", "neutral"], // Seq 16: unanimous neutral (bias=0.00, kappa=1.000, final=neutral, label=0)
  ["highly_manipulative", "highly_manipulative", "highly_manipulative", "highly_manipulative", "highly_manipulative"], // Seq 17: unanimous highly (bias=5.00, kappa=1.000, final=highly, label=1)
  ["slightly_manipulative", "slightly_manipulative", "slightly_manipulative", "neutral", "highly_manipulative"], // Seq 18: 3-1-1 slightly (bias=2.50, kappa=0.250, final=slightly, label=1)
  ["neutral", "neutral", "slightly_manipulative", "slightly_manipulative", "slightly_manipulative"], // Seq 19: 3-2 slightly (bias=1.50, kappa=0.400, final=slightly, label=0)
  ["highly_manipulative", "highly_manipulative", "highly_manipulative", "slightly_manipulative", "neutral"], // Seq 20: 3-1-1 highly (bias=3.50, kappa=0.250, final=highly, label=1)
];

const completedArticleScores = [];

// 4. Save response documents and complete each article
for (let i = 0; i < targetArticles.length; i++) {
  const art = targetArticles[i];
  const articleId = art.id;
  const labelsForArt = labelPatterns[i];

  const counts = { neutral: 0, slightly: 0, highly: 0 };

  // Write 5 individual response docs in /annotations/{articleId}/responses/{annotatorDocId}
  for (let r = 0; r < dummyAnnotators.length; r++) {
    const ann = dummyAnnotators[r];
    const lbl = labelsForArt[r];
    if (lbl === "neutral") counts.neutral++;
    else if (lbl === "slightly_manipulative") counts.slightly++;
    else if (lbl === "highly_manipulative") counts.highly++;

    const responseDocId = sanitizeEmailForDocId(ann.email);
    await db.collection("annotations").doc(articleId).collection("responses").doc(responseDocId).set({
      annotator_email: ann.email,
      label: lbl,
      timestamp: Timestamp.now(),
      time_spent_sec: 15 + r * 2,
      is_gold_check: art.is_gold_standard ?? false,
    });
  }

  // Calculate scores
  const biasScore = calculateBiasScore(counts);
  const kappa = calculateFleissKappa(counts);

  // Calculate plurality/majority final_label
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const [topKey, topCount] = entries[0];
  const [, secondCount] = entries[1];
  let finalLabel = null;
  if (topCount > 0 && topCount !== secondCount) {
    if (topKey === "neutral") finalLabel = "neutral";
    else if (topKey === "slightly") finalLabel = "slightly_manipulative";
    else if (topKey === "highly") finalLabel = "highly_manipulative";
  }

  // Calculate binary ground-truth label (FYP locked spec): label=1 iff bias_score >= 2.5
  const binaryLabel = biasScore >= 2.5 ? 1 : 0;

  completedArticleScores.push({
    seq: art.sequence_number,
    id: articleId,
    biasScore,
    kappa,
    finalLabel,
    binaryLabel,
    counts,
  });

  // Update article doc
  await db.collection("articles").doc(articleId).update({
    assigned_to: annotatorEmails,
    assigned_count: 5,
    annotated_by: annotatorEmails,
    annotation_count: 5,
    status: "complete",
    bias_score: biasScore,
    fleiss_kappa: kappa,
    final_label: finalLabel,
    label: binaryLabel,
  });
}

console.log("Completed all 20 articles with 5 annotations each!");

// 5. Update platform summary stats
const totalBiasSum = completedArticleScores.reduce((sum, a) => sum + a.biasScore, 0);
const avgBias = Math.round((totalBiasSum / completedArticleScores.length) * 100) / 100;

await db.collection("stats").doc("platform_summary").set({
  totalArticles: 1493,
  completedArticles: 20,
  inProgressArticles: 0,
  pendingArticles: 1473,
  totalAnnotators: 5,
  completedAnnotators: 5,
  avgBiasScore: avgBias,
  totalBiasScoreSum: totalBiasSum,
  needsReview: 0,
});
console.log("Updated stats/platform_summary!");

// 6. Generate CSV Export identical to ExportCSV.tsx
const allArticlesSnap = await db.collection("articles").orderBy("sequence_number", "asc").get();
const allArticles = allArticlesSnap.docs.map(d => ({ id: d.id, ...d.data() }));

const exportRows = [];
const completedCountsArray = [];

for (const art of allArticles) {
  const row = {};
  row.sequence_number = art.sequence_number ?? "";
  row.article_id = art.id;
  row.headline = art.headline ?? "";
  row.source = art.source ?? "";
  row.author = art.author ?? "";
  row.date_published = art.date_published ?? "";
  row.url = art.url ?? "";
  row.category = art.category ?? "";
  row.article_type = art.article_type ?? "";
  row.word_count = art.word_count ?? 0;
  row.display_text = art.display_text ?? "";
  row.status = art.status ?? "pending";
  row.label = (art.label === 0 || art.label === 1) ? art.label : "";
  row.bias_score = art.status === "complete" ? (art.bias_score ?? "") : "";
  row.fleiss_kappa = art.status === "complete" ? (art.fleiss_kappa ?? "") : "";
  row.total_annotations = art.annotation_count ?? 0;
  row.human_label = art.final_label ?? "";

  // Annotator slots 1..5
  let resps = [];
  if (art.annotation_count > 0) {
    const respSnap = await db.collection("annotations").doc(art.id).collection("responses").get();
    resps = respSnap.docs.map(d => d.data());
  }

  for (let i = 1; i <= 5; i++) {
    const r = resps[i - 1];
    row[`ann_${i}_student_id`] = r ? (r.annotator_email ?? "") : "";
    row[`ann_${i}_label`] = r ? (r.label ?? "") : "";
  }

  exportRows.push(row);

  if (art.status === "complete" && art.annotation_count === 5) {
    const c = { neutral: 0, slightly: 0, highly: 0 };
    for (const r of resps) {
      if (r.label === "neutral") c.neutral++;
      else if (r.label === "slightly_manipulative") c.slightly++;
      else if (r.label === "highly_manipulative") c.highly++;
    }
    completedCountsArray.push(c);
  }
}

// Compute dataset-wide Fleiss' Kappa summary row
const overallKappa = calculateOverallFleissKappa(completedCountsArray);
const summaryRow = {
  sequence_number: "",
  article_id: "OVERALL_DATASET_KAPPA",
  headline: `Dataset-wide Fleiss' Kappa across ${completedCountsArray.length} currently complete articles (n=5 raters each)`,
  source: "",
  author: "",
  date_published: "",
  url: "",
  category: "",
  article_type: "",
  word_count: completedCountsArray.length,
  display_text: "",
  status: "summary",
  label: "",
  bias_score: "",
  fleiss_kappa: overallKappa,
  total_annotations: completedCountsArray.length,
  human_label: "",
  ann_1_student_id: "",
  ann_1_label: "",
  ann_2_student_id: "",
  ann_2_label: "",
  ann_3_student_id: "",
  ann_3_label: "",
  ann_4_student_id: "",
  ann_4_label: "",
  ann_5_student_id: "",
  ann_5_label: "",
};
exportRows.push(summaryRow);

const csvContent = Papa.unparse(exportRows);
const exportFilePath = path.join(root, "TEST_SIMULATION_EXPORT.csv");
fs.writeFileSync(exportFilePath, csvContent, "utf8");
console.log(`Saved exported CSV to: ${exportFilePath}`);

console.log("\n=== COMPLETED ARTICLES SAMPLE (First 7) ===");
for (let i = 0; i < 7; i++) {
  const item = completedArticleScores[i];
  console.log(`Seq ${item.seq} (${item.id}): bias_score=${item.biasScore} | kappa=${item.kappa} | final_label=${item.finalLabel || "(TIE/NULL)"} | label=${item.binaryLabel} | counts=${JSON.stringify(item.counts)}`);
}

console.log("\n=== OVERALL DATASET KAPPA SUMMARY ROW ===");
console.log(`overall_kappa: ${overallKappa} across ${completedCountsArray.length} complete articles`);

process.exit(0);
