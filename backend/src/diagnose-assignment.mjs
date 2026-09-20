import fs from "fs";
import path from "path";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const sa = JSON.parse(fs.readFileSync(path.join(root, "service-account.json"), "utf8"));
const app = getApps().length ? getApps()[0] : initializeApp({ credential: cert(sa) });
const db = getFirestore(app);

const annotatorsSnap = await db.collection("annotators").get();
const liveEmails = new Set(annotatorsSnap.docs.map((d) => (d.data().email || "").toLowerCase().trim()));

console.log("=== Annotator Profiles ===");
for (const d of annotatorsSnap.docs) {
  const a = d.data();
  const assigned = Array.isArray(a.assigned_articles) ? a.assigned_articles : [];
  const completed = Array.isArray(a.completed_articles) ? a.completed_articles : [];
  console.log(`  ${a.email}`);
  console.log(`    assigned_articles (${assigned.length}): ${assigned.join(", ")}`);
  console.log(`    completed_articles (${completed.length}): ${completed.join(", ")}`);
}
console.log();

const snap = await db.collection("articles").orderBy("sequence_number").get();
console.log("=== All Articles: seq | status | aC | annC | at# | ab# | live_resp# | stale_at# ===");
console.log("seq  status      aC annC  at#  ab#  resp  stale_at  article_id");
console.log("---  ----------  -- ----  ---  ---  ----  --------  ----------");

for (const d of snap.docs) {
  const a = d.data();
  const seq = a.sequence_number ?? "?";
  const status = a.status ?? "(null)";
  const aC = typeof a.assigned_count === "number" ? a.assigned_count : 0;
  const annC = typeof a.annotation_count === "number" ? a.annotation_count : 0;
  const at = Array.isArray(a.assigned_to) ? a.assigned_to : [];
  const ab = Array.isArray(a.annotated_by) ? a.annotated_by : [];
  const staleAt = at.filter((e) => !liveEmails.has(String(e).toLowerCase().trim())).length;

  let liveResp = 0;
  try {
    const respSnap = await db.collection("annotations").doc(d.id).collection("responses").get();
    liveResp = respSnap.docs.filter((r) => {
      const e = (r.data().annotator_email || "").toLowerCase().trim();
      return liveEmails.has(e);
    }).length;
  } catch {}

  const flag =
    (annC !== liveResp) ? "⚠ annC≠liveResp" :
    (aC !== at.length) ? "⚠ aC≠at#" :
    "";

  console.log(
    `${String(seq).padStart(3)}  ${String(status).padEnd(10)}  ${String(aC).padStart(2)} ${String(annC).padStart(4)}  ${String(at.length).padStart(3)}  ${String(ab.length).padStart(3)}  ${String(liveResp).padStart(4)}  ${String(staleAt).padStart(8)}  ${d.id.slice(0,12)}  ${flag}`
  );
}
