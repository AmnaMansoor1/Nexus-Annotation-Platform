import fs from "fs";
import path from "path";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const sa = JSON.parse(fs.readFileSync(path.join(root, "service-account.json"), "utf8"));
const app = getApps().length ? getApps()[0] : initializeApp({ credential: cert(sa) });
const db = getFirestore(app);

const a = await db.collection("articles").get();
let at = 0, ac = 0, ab = 0, an = 0, any = 0;
let nonPending = 0;
let nonNullScores = 0;
const samples = [];

for (const d of a.docs) {
  const x = d.data();
  const tl = Array.isArray(x.assigned_to) ? x.assigned_to.length : 0;
  const cv = typeof x.assigned_count === "number" ? x.assigned_count : 0;
  const bl = Array.isArray(x.annotated_by) ? x.annotated_by.length : 0;
  const nv = typeof x.annotation_count === "number" ? x.annotation_count : 0;

  if (tl > 0) at++;
  if (cv > 0) ac++;
  if (bl > 0) ab++;
  if (nv > 0) an++;

  if (x.status !== "pending") nonPending++;
  if (x.bias_score != null || x.fleiss_kappa != null || x.final_label != null) nonNullScores++;

  if (tl > 0 || cv > 0 || bl > 0 || nv > 0 || x.status !== "pending" || x.bias_score != null || x.fleiss_kappa != null || x.final_label != null) {
    any++;
    if (samples.length < 10) {
      samples.push({ seq: x.sequence_number, id: d.id, tl, cv, bl, nv, status: x.status });
    }
  }
}

const annotatorsSnap = await db.collection("annotators").get();

console.log("=== ARTICLE STATE & FRESH-START AUDIT ===");
console.log("Total articles:", a.size);
console.log(`assigned_to.len>0:${at}  assigned_count>0:${ac}  annotated_by.len>0:${ab}  annotation_count>0:${an}  ANY-drift:${any}`);
console.log(`non_pending_status:${nonPending}  non_null_scores:${nonNullScores}  active_annotators_in_db:${annotatorsSnap.size}`);
console.log("Samples:", samples.length === 0 ? "(empty - 100% clean)" : samples.map(s => `seq${s.seq}[at=${s.tl},ac=${s.cv},ab=${s.bl},an=${s.nv},st=${s.status}]`).join("  "));

process.exit(0);
