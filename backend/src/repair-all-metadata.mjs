import fs from "fs";
import path from "path";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { fileURLToPath } from "url";
import Papa from "papaparse";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SA_PATH = process.env.SERVICE_ACCOUNT_PATH || path.join(root, "service-account.json");

const DRY_RUN = process.argv.includes("--dry-run");
const VERBOSE = process.argv.includes("--verbose") || process.argv.includes("-v");

// ── Admin SDK init ────────────────────────────────────────────────────
if (!fs.existsSync(SA_PATH)) {
  console.error(`\n❌ FATAL: service-account JSON not found at: ${SA_PATH}\n`);
  console.error("HOW TO GET ONE:");
  console.error("  1. Open https://console.firebase.google.com/project/fypresponse-collection/settings/serviceaccounts/adminsdk");
  console.error("  2. Click 'Generate new private key' → save the JSON as 'service-account.json' in the project ROOT.");
  console.error("  3. Re-run this script. Or pass custom path: set SERVICE_ACCOUNT_PATH=C:/my-sa.json && node backend/src/repair-all-metadata.mjs --dry-run\n");
  process.exit(1);
}
const sa = JSON.parse(fs.readFileSync(SA_PATH, "utf8"));
const app = getApps().length ? getApps()[0] : initializeApp({ credential: cert(sa) });
const db = getFirestore(app);

function sleep(ms) {
  return new Promise(res => setTimeout(res, ms));
}

async function retry(label, fn, opts = {}) {
  const maxAttempts = opts.attempts ?? 10;
  const baseDelay = opts.baseDelayMs ?? 2000;
  let lastErr;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const out = await fn();
      if (attempt > 0) console.log(`    ✓ [${label}] retry ${attempt} succeeded`);
      return out;
    } catch (e) {
      lastErr = e;
      const code = e?.code ? String(e.code) : "";
      const msg = e?.message ? String(e.message) : String(e);
      const transient =
        code === "unavailable" ||
        code === "deadline-exceeded" ||
        code === "aborted" ||
        code === "resource-exhausted" ||
        code === "internal" ||
        code === "cancelled" ||
        /offline|network|timeout|connection|socket|reset|rpc/i.test(msg);
      if (!transient) {
        console.error(`\n    ✗ [${label}] NON-TRANSIENT error code=${code}. Aborting.`);
        throw e;
      }
      if (attempt === maxAttempts - 1) {
        console.error(`\n    ✗ [${label}] ${maxAttempts} transient attempts all failed. Last code=${code}`);
        throw e;
      }
      const delay = baseDelay * Math.pow(1.7, attempt);
      const clamped = Math.min(delay, 30000);
      console.warn(`    ⚠ [${label}] transient (code=${code}) on attempt ${attempt + 1}/${maxAttempts} → sleep ${clamped}ms…`);
      await sleep(clamped);
    }
  }
  throw lastErr;
}

function getRequiredAnnotations(article, settings) {
  const a = Number(article?.required_annotators);
  if (Number.isFinite(a) && a > 0 && a < 50) return a;
  const s = Number(settings?.annotators_per_article);
  if (Number.isFinite(s) && s > 0 && s < 50) return s;
  return 3;
}

// ── 1. Fetch base data ────────────────────────────────────────────────
console.log(DRY_RUN
  ? "\n🔧 FULL DATABASE REPAIR — DRY RUN (nothing will be written)\n"
  : "\n🚀 FULL DATABASE REPAIR — WRITING TO FIRESTORE\n");
console.log("Does exactly what the browser 'Sync & Repair' button does, but via Admin SDK (no 'client offline' bug).");
console.log("   1. Rebuild each article: assigned_to / assigned_count, annotated_by / annotation_count, status, bias_score/percent_agreement/final_label");
console.log("   2. Write stats/platform_summary\n");
if (DRY_RUN) console.log("🧪 --dry-run flag: writes are simulated, audit CSV still emitted.\n");

console.log("Fetching annotators + articles + admin settings...");
const [annotatorsSnap, articlesSnap, settingsSnap] = await retry(
  "fetch annotators+articles+settings",
  async () => Promise.all([
    db.collection("annotators").get(),
    db.collection("articles").get(),
    db.collection("admin_config").doc("settings").get(),
  ])
);
const settings = settingsSnap.exists ? settingsSnap.data() : null;
const fallbackRequired = getRequiredAnnotations(null, settings);
console.log(`   Live annotators: ${annotatorsSnap.size}   Articles: ${articlesSnap.size}   Required annotators fallback: ${fallbackRequired}`);

const liveEmails = new Set();
const articlesByAssignee = new Map();
for (const d of annotatorsSnap.docs) {
  const data = d.data();
  const email = (data.email || "").toLowerCase().trim();
  if (!email) continue;
  liveEmails.add(email);
  const assigned = Array.isArray(data.assigned_articles) ? data.assigned_articles : [];
  for (const id of assigned) {
    if (!id) continue;
    if (!articlesByAssignee.has(id)) articlesByAssignee.set(id, new Set());
    articlesByAssignee.get(id).add(email);
  }
}
console.log(`   Assignee truth (from /annotators): ${articlesByAssignee.size} article slots`);

// ── 2. Physical responses truth (v2) ──────────────────────────────────
console.log("\nReading physical /annotations/{articleId}/responses subcollections (annotated-by TRUTH)...");
const articleIds = articlesSnap.docs.map(d => d.id);
const responsesByArticle = new Map();
const SLICE = 200;
for (let i = 0; i < articleIds.length; i += SLICE) {
  const slice = articleIds.slice(i, i + SLICE);
  const res = await Promise.all(
    slice.map(id =>
      retry(`read responses article=${id}`, async () => {
        const snap = await db.collection(`annotations/${id}/responses`).get();
        const set = new Set();
        snap.forEach(d => {
          const em = (d.data()?.annotator_email || "").toLowerCase().trim();
          if (em && liveEmails.has(em)) set.add(em);
        });
        return { id, set };
      }, { attempts: 5, baseDelayMs: 1500 })
    )
  );
  for (const r of res) responsesByArticle.set(r.id, r.set);
  console.log(`   responses scan: ${Math.min(i + SLICE, articleIds.length)}/${articleIds.length}`);
}
console.log(`   Responses truth loaded for ${responsesByArticle.size} articles.`);

// ── 3. Iterate every article, build diffs, write in batches of 200 ────
const BATCH = 200;
let batch = db.batch();
let batchWrites = 0;
let repaired = 0;
let totalAssignmentSlotsFreed = 0;
let statusFlips = { pending: 0, partial: 0, complete: 0 };
const auditRows = [];

function unique(emails, pred) {
  const seen = new Set();
  const out = [];
  for (const raw of emails) {
    const n = (raw || "").toLowerCase().trim();
    if (!n || seen.has(n)) continue;
    if (pred && !pred(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

async function commitBatch(label) {
  if (batchWrites === 0) return;
  if (DRY_RUN) {
    console.log(`   🧪 [DRY-RUN] would commit batch (${batchWrites} writes) ${label}`);
  } else {
    await retry(`batch.commit ${label} (${batchWrites} writes)`, async () => batch.commit(), { attempts: 10, baseDelayMs: 2500 });
  }
  batch = db.batch();
  batchWrites = 0;
}

console.log(`\nRepairing ${articleIds.length} articles in batches of ${BATCH}...`);
for (let i = 0; i < articlesSnap.docs.length; i++) {
  const d = articlesSnap.docs[i];
  const art = d.data();
  const required = getRequiredAnnotations(art, settings);

  const oldAssignedTo = Array.isArray(art.assigned_to) ? art.assigned_to : [];
  const oldAnnotatedBy = Array.isArray(art.annotated_by) ? art.annotated_by : [];
  const oldAssignedCount = Number(art.assigned_count) || 0;
  const oldAnnotationCount = Number(art.annotation_count) || 0;

  const truthAssignees = articlesByAssignee.get(d.id) || new Set();
  const truthAnnotators = responsesByArticle.get(d.id) || new Set();

  // Assignees: prefer truth (from annotator docs), else filter old list
  const newAssignedTo = truthAssignees.size > 0
    ? unique([...truthAssignees])
    : unique(oldAssignedTo, e => liveEmails.has(e));
  // Annotated-by: UNION(truth responses, old.annotated_by) filtered to live emails.
  //   This survives any single read-transient. The truth sets already filtered.
  const unionAnnotators = new Set([...truthAnnotators, ...oldAnnotatedBy.filter(e => liveEmails.has((e || "").toLowerCase().trim())).map(e => (e || "").toLowerCase().trim())]);
  const newAnnotatedBy = unique([...unionAnnotators]);
  const newAssignedCount = newAssignedTo.length;
  const newAnnotationCount = newAnnotatedBy.length;

  let status = art.status;
  if (newAnnotationCount >= required) status = "complete";
  else if (newAnnotationCount > 0) status = "partial";
  else status = "pending";

  const slotsFreed = Math.max(0, (oldAssignedCount - newAssignedCount) + (oldAnnotationCount - newAnnotationCount));
  const needsRepair =
    oldAssignedCount !== newAssignedCount ||
    oldAnnotationCount !== newAnnotationCount ||
    oldAssignedTo.length !== newAssignedTo.length ||
    oldAnnotatedBy.length !== newAnnotatedBy.length ||
    status !== art.status ||
    (newAnnotationCount < required && (art.bias_score !== null || art.percent_agreement !== null || art.final_label !== null || (art.label !== null && art.label !== undefined)));

  const updates = {
    assigned_to: newAssignedTo,
    assigned_count: newAssignedCount,
    annotated_by: newAnnotatedBy,
    annotation_count: newAnnotationCount,
    status,
  };
  if (newAnnotationCount < required) {
    if (art.bias_score !== null) updates.bias_score = null;
    if (art.percent_agreement !== null) updates.percent_agreement = null;
    if (art.final_label !== null) updates.final_label = null;
    if (art.label !== null && art.label !== undefined) updates.label = null;
  }
  // Always updated timestamp for audit (merge-only set; safe even if no-op)
  updates._last_metadata_repair_at = FieldValue.serverTimestamp();

  if (needsRepair) {
    repaired++;
    totalAssignmentSlotsFreed += slotsFreed;
    statusFlips[status] = (statusFlips[status] || 0) + 1;
    if (VERBOSE) {
      console.log(`   repair seq=${art.sequence_number ?? d.id.slice(0, 8)}: ` +
        `annotated_by ${oldAnnotatedBy.length}→${newAnnotatedBy.length}, ` +
        `assigned ${oldAssignedCount}→${newAssignedCount}, status ${art.status}→${status}`);
    }
    batch.set(db.collection("articles").doc(d.id), updates, { merge: true });
    batchWrites++;
    auditRows.push({
      article_id: d.id,
      sequence_number: art.sequence_number ?? "",
      category: art.category ?? "",
      old_status: art.status,
      new_status: status,
      old_assigned_count: oldAssignedCount,
      new_assigned_count: newAssignedCount,
      old_annotation_count: oldAnnotationCount,
      new_annotation_count: newAnnotationCount,
      required,
      slots_freed: slotsFreed,
      deleted_assignees: JSON.stringify(oldAssignedTo.filter(e => !newAssignedTo.includes((e || "").toLowerCase().trim()))),
      deleted_annotators: JSON.stringify(oldAnnotatedBy.filter(e => !newAnnotatedBy.includes((e || "").toLowerCase().trim()))),
    });
  }
  if (batchWrites >= BATCH) {
    await commitBatch(`#${repaired} repaired so far (articles ${i + 1}/${articlesSnap.size})`);
    console.log(`   progress: ${i + 1}/${articlesSnap.size} articles, ${repaired} repaired, slots freed=${totalAssignmentSlotsFreed}`);
  }
  if ((i + 1) % 1000 === 0 || i === articlesSnap.size - 1) {
    console.log(`   progress: ${i + 1}/${articlesSnap.size} articles, ${repaired} repaired, slots freed=${totalAssignmentSlotsFreed}`);
  }
}
await commitBatch("final article writes");

// ── 4. Rebuild stats/platform_summary ─────────────────────────────────
console.log("\nBuilding stats/platform_summary...");
let completedAnnotators = 0;
for (const d of annotatorsSnap.docs) {
  const arr = Array.isArray(d.data()?.completed_articles) ? d.data().completed_articles : [];
  if (arr.length >= 20) completedAnnotators++;
}
// Re-derive final article state (DRY_RUN or not, use the in-memory repaired projection for correctness):
const finalArticles = [];
for (let i = 0; i < articlesSnap.docs.length; i++) {
  const d = articlesSnap.docs[i];
  const art = d.data();
  const required = getRequiredAnnotations(art, settings);
  const truthAssignees = articlesByAssignee.get(d.id) || new Set();
  const truthAnnotators = responsesByArticle.get(d.id) || new Set();
  const newAssignedTo = truthAssignees.size > 0
    ? unique([...truthAssignees])
    : unique((Array.isArray(art.assigned_to) ? art.assigned_to : []), e => liveEmails.has(e));
  const unionAnnotators = new Set([
    ...truthAnnotators,
    ...(Array.isArray(art.annotated_by) ? art.annotated_by : []).filter(e => liveEmails.has((e || "").toLowerCase().trim())).map(e => (e || "").toLowerCase().trim()),
  ]);
  const newAnnotatedBy = unique([...unionAnnotators]);
  const newAnnotationCount = newAnnotatedBy.length;
  let status = art.status;
  if (newAnnotationCount >= required) status = "complete";
  else if (newAnnotationCount > 0) status = "partial";
  else status = "pending";
  finalArticles.push({
    ...art,
    annotation_count: newAnnotationCount,
    assigned_count: newAssignedTo.length,
    status,
  });
}
const completed = finalArticles.filter(a => a.status === "complete");
const partial = finalArticles.filter(a => a.status === "partial");
const pending = finalArticles.filter(a => a.status === "pending");
const catDist = {};
for (const a of finalArticles) {
  const c = a.category || "Uncategorized";
  catDist[c] = (catDist[c] || 0) + 1;
}
const biasSum = completed.reduce((s, a) => s + (Number.isFinite(Number(a.bias_score)) ? Number(a.bias_score) : 0), 0);
const avgBias = completed.length > 0 ? Math.round((biasSum / completed.length) * 100) / 100 : 0;
const needsReview = partial.filter(a => {
  const required = getRequiredAnnotations(a, settings);
  return a.annotation_count >= required;
}).length;

const summary = {
  totalArticles: finalArticles.length,
  completedArticles: completed.length,
  inProgressArticles: partial.length,
  pendingArticles: pending.length,
  totalAnnotators: annotatorsSnap.size,
  completedAnnotators,
  avgBiasScore: avgBias,
  totalBiasScoreSum: biasSum,
  needsReview,
  categoryDistribution: catDist,
  last_repair_run_at: FieldValue.serverTimestamp(),
  repaired_articles_count: repaired,
  slots_freed: totalAssignmentSlotsFreed,
};

if (DRY_RUN) {
  console.log("🧪 [DRY-RUN] Would write stats/platform_summary:");
  console.log(JSON.stringify(summary, null, 2));
} else {
  await retry("write stats/platform_summary", async () =>
    db.collection("stats").doc("platform_summary").set(summary)
  , { attempts: 10, baseDelayMs: 2000 });
  console.log("✅ stats/platform_summary written.");
}

// ── 5. Write audit CSV ────────────────────────────────────────────────
const csvPath = path.join(root, `backend/logs/metadata-repair-audit-${new Date().toISOString().replace(/[:.]/g, "-")}.csv`);
fs.mkdirSync(path.dirname(csvPath), { recursive: true });
fs.writeFileSync(csvPath, Papa.unparse(auditRows));
console.log(`\n📄 Audit CSV with ${auditRows.length} repaired-article rows: ${csvPath}`);

// ── Summary ───────────────────────────────────────────────────────────
console.log(`\n🎉 ${DRY_RUN ? "DRY RUN SUMMARY — nothing written to Firestore" : "REPAIR COMPLETE"}`);
console.log(`   Articles scanned          : ${articlesSnap.size}`);
console.log(`   Articles mutated          : ${repaired}`);
console.log(`     → flipped to pending    : ${statusFlips.pending || 0}`);
console.log(`     → flipped to partial    : ${statusFlips.partial || 0}`);
console.log(`     → flipped to complete   : ${statusFlips.complete || 0}`);
console.log(`   Ghost slots freed         : ${totalAssignmentSlotsFreed}`);
console.log(`   Live annotators           : ${liveEmails.size}`);
console.log(`\n   Final article totals:`);
console.log(`     pending   : ${pending.length}`);
console.log(`     partial   : ${partial.length}`);
console.log(`     complete  : ${completed.length}`);
console.log(`     avg bias  : ${avgBias} (n=${completed.length})`);
console.log(`     needsReview : ${needsReview} (partial flagged but count≥required)`);
console.log(`\n👉 Next: visit /admin — dashboard will now load (stats doc exists). Then login as annotator.`);
console.log("👉 To test assignment logic, use: node backend/src/diagnose-assignment.mjs\n");
