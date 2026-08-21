import fs from "fs";
import path from "path";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const sa = JSON.parse(fs.readFileSync(path.join(root, "service-account.json"), "utf8"));
const app = getApps().length ? getApps()[0] : initializeApp({ credential: cert(sa) });
const db = getFirestore(app);

const snap = await db.collection("articles").orderBy("sequence_number").limit(25).get();

console.log("── Seq 1-25: who holds the 5 assignment slots? ──\n");
for (const d of snap.docs) {
  const a = d.data();
  const seq = a.sequence_number;
  const assignees = a.assigned_to || [];
  const marker = assignees.includes("sp23-bse-200@cuilahore.edu.pk") ? " ◀ THIS USER" : "";
  console.log(
    `seq ${String(seq).padStart(3)} | aC=${a.assigned_count} annC=${a.annotation_count} | ${assignees.length} assignees${marker}`
  );
  if (seq <= 5) console.log(`         assignees: ${assignees.join(", ")}`);
}

const annotatorsSnap = await db.collection("annotators").get();
console.log(`\nTotal annotators in Firestore: ${annotatorsSnap.size}`);

let withEarlyArticles = 0;
for (const d of annotatorsSnap.docs) {
  const assigned = d.data().assigned_articles || [];
  if (assigned.length === 0) continue;
  // check if any assigned article is in first 20 by fetching would be slow; skip
}
console.log("(Each article needs 5 annotators before new annotators move to higher seq numbers)");
