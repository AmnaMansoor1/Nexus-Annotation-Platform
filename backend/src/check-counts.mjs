import fs from "fs";
import path from "path";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const sa = JSON.parse(fs.readFileSync(path.join(root, "service-account.json"), "utf8"));
const app = getApps().length ? getApps()[0] : initializeApp({ credential: cert(sa) });
const db = getFirestore(app);

const annotators = await db.collection("annotators").get();
console.log(`Annotators in DB: ${annotators.size}`);
for (const d of annotators.docs) {
  console.log(`  ${d.data().email || d.id}`);
}

const snap = await db.collection("articles").orderBy("sequence_number").limit(25).get();
console.log("\n── Seq 1-25: Firestore counters vs actual subcollection responses ──");
console.log("seq | article_id   | aC | annC | assigned_to# | annotated_by# | live_responses# | stale assignees");
console.log("----+--------------+----+------+--------------+---------------+-----------------+------------------");

const liveEmails = new Set(annotators.docs.map((d) => (d.data().email || "").toLowerCase().trim()));

for (const d of snap.docs) {
  const a = d.data();
  const assignedTo = a.assigned_to || [];
  const annotatedBy = a.annotated_by || [];
  const staleAssignees = assignedTo.filter((e) => !liveEmails.has(e.toLowerCase().trim()));

  const respSnap = await db.collection("annotations").doc(d.id).collection("responses").get();
  const liveResponses = respSnap.docs.filter((r) => {
    const e = (r.data().annotator_email || "").toLowerCase().trim();
    return liveEmails.has(e);
  });

  console.log(
    `${String(a.sequence_number).padStart(3)} | ${d.id.slice(-10).padStart(10)} | ${String(a.assigned_count).padStart(2)} | ${String(a.annotation_count).padStart(4)} | ${String(assignedTo.length).padStart(12)} | ${String(annotatedBy.length).padStart(13)} | ${String(liveResponses.length).padStart(15)} | ${staleAssignees.length > 0 ? staleAssignees.join(";") : "-"}`
  );
}
