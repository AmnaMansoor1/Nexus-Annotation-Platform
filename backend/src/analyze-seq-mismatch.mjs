import fs from "fs";
import path from "path";
import Papa from "papaparse";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const sa = JSON.parse(fs.readFileSync(path.join(root, "service-account.json"), "utf8"));
const app = getApps().length ? getApps()[0] : initializeApp({ credential: cert(sa) });
const db = getFirestore(app);

const csv = Papa.parse(fs.readFileSync(path.join(root, "annotation_dataset_v6.csv"), "utf8"), {
  header: true,
  skipEmptyLines: true,
}).data;
const csvIds = csv.map((r) => r.article_id);
const csvSet = new Set(csvIds);

const snap = await db.collection("articles").get();
const articles = snap.docs.map((d) => ({ id: d.id, seq: d.data().sequence_number, status: d.data().status }));
articles.sort((a, b) => a.seq - b.seq);

const fsOnly = articles.filter((a) => !csvSet.has(a.id));
const csvOnly = csvIds.filter((id) => !articles.some((a) => a.id === id));

const offsets = {};
for (const a of articles) {
  const csvRow = csvIds.indexOf(a.id);
  if (csvRow >= 0) {
    const off = a.seq - (csvRow + 1);
    offsets[off] = (offsets[off] || 0) + 1;
  }
}

const lexIds = [...articles.map((a) => a.id)].sort();
const lexMatch = articles.every((a, i) => a.id === lexIds[i]);

const csvOrderIds = csvIds.filter((id) => csvSet.has(id) && articles.some((a) => a.id === id));
const fsInCsv = articles.filter((a) => csvSet.has(a.id));
const csvOrderMatch = fsInCsv.every((a, i) => a.id === csvOrderIds[i]);

console.log("Firestore articles:", articles.length);
console.log("CSV rows:", csvIds.length);
console.log("Firestore-only (not in CSV):", fsOnly.map((a) => `${a.id} seq=${a.seq} status=${a.status}`));
console.log("CSV-only (not in Firestore):", csvOnly);
console.log("Offset distribution (firestoreSeq - csvRow):", offsets);
console.log("Seq order == lexicographic article_id?", lexMatch);
console.log("Seq order == CSV row order?", csvOrderMatch);
console.log("\nFirst 10 by firestore seq:", articles.slice(0, 10).map((a) => `${a.seq}:${a.id.slice(-8)} csvRow=${csvIds.indexOf(a.id)+1||'NA'}`));
