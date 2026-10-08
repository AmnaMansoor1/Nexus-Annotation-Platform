/**
 * rebuild-platform-summary.mjs
 *
 * Rebuilds the stats/platform_summary Firestore document from live data
 * using Firebase Admin SDK. Run this script from the command line when the
 * browser-based "Sync Statistics" hangs (large collections can silently
 * stall the browser Firestore WebChannel).
 *
 * Usage:
 *   node backend/src/rebuild-platform-summary.mjs
 *   node backend/src/rebuild-platform-summary.mjs --dry-run
 *
 * Requirements: service-account.json at the project root.
 */

import fs from 'fs';
import path from 'path';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DRY_RUN = process.argv.includes('--dry-run');
const REQUIRED = 5;

const saPath = path.join(root, 'service-account.json');
if (!fs.existsSync(saPath)) {
  console.error('ERROR: service-account.json not found at ' + saPath);
  process.exit(1);
}
const sa = JSON.parse(fs.readFileSync(saPath, 'utf8'));
const app = getApps().length ? getApps()[0] : initializeApp({ credential: cert(sa) });
const db = getFirestore(app);

console.log(DRY_RUN ? '=== REBUILD PLATFORM SUMMARY (DRY RUN) ===' : '=== REBUILD PLATFORM SUMMARY (WRITING) ===');

process.stdout.write('Fetching annotators... ');
const annotatorsSnap = await db.collection('annotators').get();
console.log(annotatorsSnap.size + ' found.');

let completedAnnotators = 0;
const annotators = [];
for (const d of annotatorsSnap.docs) {
  const a = d.data();
  annotators.push(a);
  if (Array.isArray(a.completed_articles) && a.completed_articles.length >= 20) completedAnnotators++;
}

process.stdout.write('Fetching articles... ');
const articlesSnap = await db.collection('articles').get();
console.log(articlesSnap.size + ' found.\n');

let totalArticles = 0, completedArticles = 0, inProgressArticles = 0, needsReview = 0;
let biasScoreSum = 0, biasScoreCount = 0;
const categoryDistribution = {};

for (const docSnap of articlesSnap.docs) {
  const a = docSnap.data();
  totalArticles++;
  const status = a.status || 'pending';
  const annCount = typeof a.annotation_count === 'number' ? a.annotation_count : 0;
  if (status === 'complete') {
    completedArticles++;
    if (typeof a.bias_score === 'number' && Number.isFinite(a.bias_score)) {
      biasScoreSum += a.bias_score;
      biasScoreCount++;
    }
  } else if (status === 'partial' || annCount > 0) {
    inProgressArticles++;
    if (annCount >= REQUIRED) needsReview++;
  }
  const cat = a.category || 'Uncategorized';
  categoryDistribution[cat] = (categoryDistribution[cat] || 0) + 1;
}

const pendingArticles = Math.max(0, totalArticles - completedArticles - inProgressArticles);
const avgBiasScore = biasScoreCount > 0 ? Math.round((biasScoreSum / biasScoreCount) * 100) / 100 : 0;

const summary = {
  totalArticles,
  completedArticles:  Math.max(0, completedArticles),
  inProgressArticles: Math.max(0, inProgressArticles),
  pendingArticles:    Math.max(0, pendingArticles),
  totalAnnotators:    annotators.length,
  completedAnnotators,
  avgBiasScore,
  totalBiasScoreSum:  biasScoreSum,
  needsReview:        Math.max(0, needsReview),
  categoryDistribution,
  lastSyncedAt:       new Date().toISOString(),
};

console.log('--- Computed Platform Summary ---');
console.log('  Total Articles:   ' + summary.totalArticles);
console.log('  Fully Annotated:  ' + summary.completedArticles);
console.log('  In Progress:      ' + summary.inProgressArticles);
console.log('  Pending:          ' + summary.pendingArticles);
console.log('  Needs Review:     ' + summary.needsReview);
console.log('  Total Annotators: ' + summary.totalAnnotators);
console.log('  Completed (>=20): ' + summary.completedAnnotators);
console.log('  Avg Bias Score:   ' + summary.avgBiasScore);
console.log('');

if (DRY_RUN) {
  console.log('DRY RUN -- not writing to Firestore.');
} else {
  process.stdout.write('Writing stats/platform_summary... ');
  await db.doc('stats/platform_summary').set(summary);
  console.log('done.');
}

console.log('=== DONE ===');
process.exit(0);
