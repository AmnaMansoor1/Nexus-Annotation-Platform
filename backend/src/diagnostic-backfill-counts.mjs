import fs from "fs"; import path from "path";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { fileURLToPath } from "url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const sa = JSON.parse(fs.readFileSync(path.join(root, "service-account.json"), "utf8"));
const app = getApps().length ? getApps()[0] : initializeApp({ credential: cert(sa) });
const db = getFirestore(app);
const DEFAULT_REQUIRED_ANNOTATIONS = 5;

const annotatorsSnap = await db.collection("annotators").get();
const liveEmails = new Set();
for (const d of annotatorsSnap.docs) {
  const e = (d.data().email || "").toLowerCase().trim();
  if (e) liveEmails.add(e);
}

const articlesSnap = await db.collection("articles").get();
console.log("Total articles:", articlesSnap.size);
console.log("Live annotators:", liveEmails.size);
console.log("DEFAULT_REQUIRED_ANNOTATIONS threshold:", DEFAULT_REQUIRED_ANNOTATIONS);

let needsBackfill = 0;
let completeButMissingScores = 0;
let partialWith5PlusResponses = 0;
let alreadyConsistent = 0;
const samples = [];

for (const doc of articlesSnap.docs) {
  const a = doc.data();
  const seq = a.sequence_number ?? null;

  const responsesSnap = await db.collection("annotations").doc(doc.id).collection("responses").get();
  const responsesAll = responsesSnap.docs.map(d => d.data());
  const responsesLive = responsesAll.filter(r => {
    const e = (r.annotator_email || "").toLowerCase().trim();
    return !!e && liveEmails.has(e);
  });
  const annotatorEmails = new Set(
    responsesLive.map(r => (r.annotator_email || "").toLowerCase().trim()).filter(Boolean)
  );
  const distinctLiveResponses = annotatorEmails.size;

  const storedAC = typeof a.annotation_count === "number" ? a.annotation_count : 0;
  const storedStatus = a.status ?? "pending";
  const storedBias = a.bias_score;
  const storedKappa = a.fleiss_kappa;
  const storedFinalLabel = a.final_label;
  const scoresMissing = storedBias == null || storedKappa == null || storedFinalLabel == null;

  const qualifiesForBackfill = distinctLiveResponses >= DEFAULT_REQUIRED_ANNOTATIONS;
  const inconsistent = qualifiesForBackfill &&
    (storedStatus !== "complete" || scoresMissing);

  if (inconsistent) {
    needsBackfill++;
    if (storedStatus !== "complete") partialWith5PlusResponses++;
    if (storedStatus === "complete" && scoresMissing) completeButMissingScores++;
    if (samples.length < 10) {
      samples.push({
        seq, id: doc.id,
        distinctLiveResponses,
        storedStatus, storedAC,
        bias: storedBias, kappa: storedKappa, final_label: storedFinalLabel,
        responsesLen: responsesLive.length,
      });
    }
  } else if (qualifiesForBackfill) {
    alreadyConsistent++;
  }
}

console.log("\n================= BACKFILL DIAGNOSTIC REPORT =================");
console.log(`Articles that genuinely have >= 5 live responses:`);
console.log(`  Already consistent (status=complete + all scores present): ${alreadyConsistent}`);
console.log(`  NEEDS BACKFILL: ${needsBackfill}`);
console.log(`    (status != "complete" despite >= 5 responses)           : ${partialWith5PlusResponses}`);
console.log(`    (status == "complete" but bias/kappa/final_label MISSING): ${completeButMissingScores}`);
console.log(`\nFirst 10 backfill candidates (seq, id, distinct-live-responses, status, ac, has_bias, has_kappa, has_final_label):`);
for (const s of samples) {
  console.log(`  seq=${s.seq} id=${s.id} distinctLiveRes=${s.distinctLiveResponses} storedStatus=${s.storedStatus} storedAC=${s.storedAC} bias=${s.bias != null ? "Y" : "N"} kappa=${s.kappa != null ? "Y" : "N"} final_label=${s.final_label != null ? s.final_label : "MISSING"} responsesLen=${s.responsesLen}`);
}
console.log("==============================================================");
console.log("\nBACKFILL NEEDED COUNT FOR YOUR APPROVAL:", needsBackfill);
process.exit(0);
