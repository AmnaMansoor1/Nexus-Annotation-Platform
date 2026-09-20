/**
 * purge-orphan-responses.mjs
 *
 * One-time cleanup script: walks ALL /annotations/{articleId}/responses
 * subcollections and PHYSICALLY DELETES any response doc whose
 * annotator_email is NOT present in the live /annotators collection.
 *
 * After purging, rebuilds article metadata (annotated_by, annotation_count,
 * status, assigned_to, assigned_count, bias_score, fleiss_kappa,
 * final_label, label) from the REMAINING live-annotator responses only.
 *
 * This script is idempotent — running it twice produces the same result.
 *
 * Usage:
 *   node backend/src/purge-orphan-responses.mjs --dry-run   ← preview only
 *   node backend/src/purge-orphan-responses.mjs             ← write to Firestore
 *
 * Why this script exists:
 *   The AnnotatorsTable.tsx hardDeleteAnnotator() function (frontend) now
 *   physically deletes all response docs for an annotator when they are
 *   hard-deleted. However, annotators deleted BEFORE this fix was deployed
 *   may still have orphan response docs sitting in Firestore. This script
 *   does a one-time sweep to find and remove them all.
 *
 *   After this script runs, the live-filter inside reconcileArticle.ts /
 *   healArticles() provides ongoing protection — even if a stray response
 *   doc ever reappears, it is excluded from annotation_count automatically.
 */

import fs from "fs";
import path from "path";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const REQUIRED = 5;
const DRY_RUN = process.argv.includes("--dry-run");

const sa = JSON.parse(fs.readFileSync(path.join(root, "service-account.json"), "utf8"));
const app = getApps().length ? getApps()[0] : initializeApp({ credential: cert(sa) });
const db = getFirestore(app);

console.log(`\n🔍 purge-orphan-responses.mjs  [${DRY_RUN ? "DRY RUN — no writes" : "WRITE MODE"}]\n`);

// ── Step 1: Build liveEmails + articlesByAssignee from /annotators ───────────
const annotatorsSnap = await db.collection("annotators").get();
const liveEmails = new Set();
const articlesByAssignee = new Map(); // articleId → Set<email>

for (const d of annotatorsSnap.docs) {
  const data = d.data();
  const email = (data.email || "").toLowerCase().trim();
  if (!email) continue;
  liveEmails.add(email);
  const assigned = Array.isArray(data.assigned_articles) ? data.assigned_articles : [];
  for (const articleId of assigned) {
    if (!articleId) continue;
    if (!articlesByAssignee.has(articleId)) articlesByAssignee.set(articleId, new Set());
    articlesByAssignee.get(articleId).add(email);
  }
}

console.log(`✅ Live annotators (${liveEmails.size}):`);
for (const e of [...liveEmails].sort()) console.log(`   ${e}`);
console.log();

// ── Score helpers (identical to repair-all-article-metadata.mjs) ─────────────
function calculateBiasScore(counts) {
  const n = counts.neutral + counts.slightly + counts.highly;
  if (n === 0) return 0;
  const raw = (counts.highly * 2 + counts.slightly * 1) / n;
  return parseFloat((raw * 2.5).toFixed(2));
}

function calculateFleissKappa(counts) {
  const cats = [counts.neutral, counts.slightly, counts.highly];
  const n = cats.reduce((s, c) => s + c, 0);
  if (n < 2) return 0;
  const sumSq = cats.reduce((s, c) => s + c * c, 0);
  const Po = (sumSq - n) / (n * (n - 1));
  const pj = cats.map(c => c / n);
  const Pe = pj.reduce((s, p) => s + p * p, 0);
  if (Pe === 1) return 1;
  return parseFloat(((Po - Pe) / (1 - Pe)).toFixed(3));
}

function computeFinalLabel(counts) {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const [topK, topC] = entries[0];
  const [, secC] = entries[1] ?? ["", 0];
  if (topC === 0 || topC === secC) return null;
  const map = { neutral: "neutral", slightly: "slightly_manipulative", highly: "highly_manipulative" };
  return map[topK] ?? null;
}

// ── Step 2: Scan all articles ─────────────────────────────────────────────────
const articlesSnap = await db.collection("articles").orderBy("sequence_number").get();
console.log(`📚 Total articles to scan: ${articlesSnap.size}\n`);

let totalResponsesDeleted = 0;
let totalArticlesUpdated = 0;
let totalArticlesSkipped = 0;
const orphanEmailsSeen = new Set();

// Batch infrastructure
let batch = db.batch();
let batchCount = 0;
const MAX_BATCH = 400;

async function flushBatch() {
  if (batchCount === 0 || DRY_RUN) return;
  await batch.commit();
  batch = db.batch();
  batchCount = 0;
}

for (const articleDoc of articlesSnap.docs) {
  const articleId = articleDoc.id;
  const articleData = articleDoc.data();
  const seq = articleData.sequence_number ?? "?";

  // Read responses
  const respSnap = await db.collection("annotations").doc(articleId).collection("responses").get();
  if (respSnap.empty) {
    totalArticlesSkipped++;
    continue;
  }

  const orphanDocs = [];   // response docs to DELETE
  const liveResponses = []; // { email, label } for remaining live annotators

  for (const rd of respSnap.docs) {
    const rdData = rd.data();
    const rawEmail = typeof rdData.annotator_email === "string"
      ? rdData.annotator_email
      : rd.id; // fallback: doc ID is sometimes the sanitized email
    const em = rawEmail.toLowerCase().trim();
    if (!em) continue;

    if (liveEmails.has(em)) {
      liveResponses.push({ email: em, label: (rdData.label || "").toString() });
    } else {
      orphanDocs.push({ ref: rd.ref, id: rd.id, email: em });
      orphanEmailsSeen.add(em);
    }
  }

  // Nothing to purge for this article
  if (orphanDocs.length === 0) {
    totalArticlesSkipped++;
    continue;
  }

  console.log(`SEQ ${String(seq).padStart(4)} | ${articleId}`);
  for (const od of orphanDocs) {
    console.log(`  🗑️  DELETE /annotations/${articleId}/responses/${od.id}  (${od.email})`);
    totalResponsesDeleted++;
    if (!DRY_RUN) {
      batch.delete(od.ref);
      batchCount++;
    }
  }

  // ── Rebuild article metadata from live responses only ─────────────────────
  // Deduplicate: each annotator counted at most once
  const seenEmails = new Set();
  const uniqueLiveResponses = [];
  for (const r of liveResponses) {
    if (!seenEmails.has(r.email)) {
      seenEmails.add(r.email);
      uniqueLiveResponses.push(r);
    }
  }

  const newAnnotatedBy = uniqueLiveResponses.map(r => r.email);
  const newAnnotationCount = newAnnotatedBy.length;

  // assigned_to: prefer annotator-doc truth, fall back to live-filtered article field
  const truthAssignees = articlesByAssignee.get(articleId) ?? new Set();
  const rawAssignedTo = Array.isArray(articleData.assigned_to) ? articleData.assigned_to : [];
  const newAssignedTo = truthAssignees.size > 0
    ? [...truthAssignees].filter(e => liveEmails.has(e))
    : rawAssignedTo.filter(e => typeof e === "string" && liveEmails.has(e.toLowerCase().trim()));
  // Deduplicate
  const newAssignedToFinal = [...new Set(newAssignedTo)];
  const newAssignedCount = newAssignedToFinal.length;

  // Status
  let newStatus;
  if (newAnnotationCount >= REQUIRED) newStatus = "complete";
  else if (newAnnotationCount > 0) newStatus = "partial";
  else newStatus = "pending";

  // Scores: only when exactly REQUIRED live responses remain
  let newBiasScore = null;
  let newFleissKappa = null;
  let newFinalLabel = null;
  let newLabel = null;

  if (newAnnotationCount === REQUIRED) {
    const counts = { neutral: 0, slightly: 0, highly: 0 };
    for (const { label } of uniqueLiveResponses.slice(0, REQUIRED)) {
      if (label === "neutral") counts.neutral++;
      else if (label === "slightly_manipulative") counts.slightly++;
      else if (label === "highly_manipulative") counts.highly++;
    }
    const total = counts.neutral + counts.slightly + counts.highly;
    if (total === REQUIRED) {
      newBiasScore = calculateBiasScore(counts);
      newFleissKappa = calculateFleissKappa(counts);
      newFinalLabel = computeFinalLabel(counts);
      newLabel = newBiasScore >= 2.5 ? 1 : 0;
    }
  }

  const oldAnnC = typeof articleData.annotation_count === "number" ? articleData.annotation_count : 0;
  const oldStatus = articleData.status ?? "?";

  console.log(`  📝 REBUILD: status ${oldStatus}→${newStatus}  annotation_count ${oldAnnC}→${newAnnotationCount}`);
  if (newBiasScore !== null) {
    console.log(`  ⚡ SCORES: bias_score=${newBiasScore} fleiss_kappa=${newFleissKappa} final_label=${newFinalLabel}`);
  } else if (oldAnnC >= REQUIRED) {
    console.log(`  🚫 SCORES CLEARED (dropped below ${REQUIRED} live annotations)`);
  }

  totalArticlesUpdated++;

  if (!DRY_RUN) {
    batch.set(articleDoc.ref, {
      annotated_by: newAnnotatedBy,
      annotation_count: newAnnotationCount,
      assigned_to: newAssignedToFinal,
      assigned_count: newAssignedCount,
      status: newStatus,
      bias_score: newBiasScore,
      fleiss_kappa: newFleissKappa,
      final_label: newFinalLabel,
      label: newLabel,
    }, { merge: true });
    batchCount++;
    if (batchCount >= MAX_BATCH) await flushBatch();
  }
}

await flushBatch();

// ── Final report ──────────────────────────────────────────────────────────────
console.log(`\n${"─".repeat(60)}`);
console.log(`✅ DONE  [${DRY_RUN ? "DRY RUN — no writes committed" : "WRITE MODE — changes committed"}]`);
console.log(`\n  Response docs ${DRY_RUN ? "WOULD BE deleted" : "DELETED"}: ${totalResponsesDeleted}`);
console.log(`  Articles ${DRY_RUN ? "WOULD BE updated" : "updated"} (metadata rebuilt): ${totalArticlesUpdated}`);
console.log(`  Articles with no orphan docs (skipped): ${totalArticlesSkipped}`);

if (orphanEmailsSeen.size > 0) {
  console.log(`\n  Orphan annotator emails found in response docs (these are not in /annotators):`);
  for (const e of [...orphanEmailsSeen].sort()) console.log(`    ${e}`);
  console.log();
  if (DRY_RUN) {
    console.log(`  ℹ️  To apply these deletions, run without --dry-run:`);
    console.log(`     node backend/src/purge-orphan-responses.mjs`);
  }
} else {
  console.log(`\n  🎉 No orphan response docs found — Firestore is clean!`);
}
