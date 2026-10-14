/**
 * fix-annotator-completed-flag.mjs
 *
 * Fixes annotators who submitted >= 20 articles but whose `completed` flag
 * was never set to true (due to the race condition / transaction drop during
 * the lab session). Also sets `completed` = false for anyone with < 20.
 *
 * Usage:
 *   node backend/src/fix-annotator-completed-flag.mjs            # live run
 *   node backend/src/fix-annotator-completed-flag.mjs --dry-run  # preview only
 *
 * Requirements: service-account.json at project root.
 */

import fs from 'fs';
import path from 'path';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DRY_RUN = process.argv.includes('--dry-run');
const REQUIRED_COMPLETED = 20; // articles needed to be marked completed

const saPath = path.join(root, 'service-account.json');
if (!fs.existsSync(saPath)) {
  console.error('ERROR: service-account.json not found at ' + saPath);
  process.exit(1);
}
const sa = JSON.parse(fs.readFileSync(saPath, 'utf8'));
const app = getApps().length ? getApps()[0] : initializeApp({ credential: cert(sa) });
const db = getFirestore(app);

console.log(DRY_RUN ? '=== FIX ANNOTATOR COMPLETED FLAG (DRY RUN) ===' : '=== FIX ANNOTATOR COMPLETED FLAG (WRITING) ===');
console.log(`Threshold: completed_articles.length >= ${REQUIRED_COMPLETED} → completed=true\n`);

const snap = await db.collection('annotators').get();
console.log(`Found ${snap.size} annotators.\n`);

let needFix = 0;
let alreadyCorrect = 0;
let batch = db.batch();
let batchCount = 0;

for (const docSnap of snap.docs) {
  const data = docSnap.data();
  const email = data.email || docSnap.id;
  const completedArticles = Array.isArray(data.completed_articles) ? data.completed_articles : [];
  const currentFlag = !!data.completed;
  const shouldBeCompleted = completedArticles.length >= REQUIRED_COMPLETED;

  if (currentFlag === shouldBeCompleted) {
    alreadyCorrect++;
    continue;
  }

  needFix++;
  console.log(
    `  ${shouldBeCompleted ? '✅ SET completed=true ' : '⚠️  SET completed=false'} | ${email.padEnd(42)} | completed_articles=${completedArticles.length} | was: completed=${currentFlag}`
  );

  if (!DRY_RUN) {
    batch.set(docSnap.ref, { completed: shouldBeCompleted }, { merge: true });
    batchCount++;
    if (batchCount >= 400) {
      await batch.commit();
      batch = db.batch();
      batchCount = 0;
    }
  }
}

if (!DRY_RUN && batchCount > 0) {
  await batch.commit();
}

console.log(`\n--- Results ---`);
console.log(`  Already correct : ${alreadyCorrect}`);
console.log(`  Fixed           : ${needFix}`);
console.log(DRY_RUN ? '\nDRY RUN — nothing written.' : '\nAll changes written to Firestore.');
console.log('=== DONE ===');
process.exit(0);
