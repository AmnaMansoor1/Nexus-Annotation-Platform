// Find annotator doc + full assignment trace for an email.
import fs from "fs";
import path from "path";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const email = (process.argv[2] || "sp23-bse-200@cuilahore.edu.pk").toLowerCase().trim();

function sanitizeEmailForDocId(e) {
  let x = e.toLowerCase().trim();
  x = x
    .replaceAll("/", "_SLASH_")
    .replaceAll("\\", "_BSLASH_")
    .replaceAll("..", "_DOTDOT_")
    .replaceAll("~", "_TILDE_")
    .replaceAll("*", "_STAR_")
    .replaceAll("[", "_LSQB_")
    .replaceAll("]", "_RSQB_")
    .replaceAll("#", "_HASH_")
    .replaceAll("?", "_QMARK_")
    .replaceAll("%", "_PCT_");
  if (x.startsWith(".") || x.startsWith("_") || x.startsWith("-")) x = "u_" + x;
  x = x.replace(/\.$/g, "_DOT");
  return x;
}

const sa = JSON.parse(fs.readFileSync(path.join(root, "service-account.json"), "utf8"));
const app = getApps().length ? getApps()[0] : initializeApp({ credential: cert(sa) });
const db = getFirestore(app);

const docId = sanitizeEmailForDocId(email);
console.log(`Email: ${email}`);
console.log(`Annotator doc id: ${docId}`);

const annotatorSnap = await db.collection("annotators").doc(docId).get();
if (!annotatorSnap.exists) {
  console.log("Annotator doc NOT FOUND. Searching all annotators for partial email match...");
  const all = await db.collection("annotators").get();
  const matches = all.docs.filter((d) => {
    const e = (d.data().email || "").toLowerCase();
    return e.includes("sp23-bse-200") || e.includes("cuilahore");
  });
  for (const d of matches) {
    console.log(`  Found: ${d.id}  email=${d.data().email}`);
  }
} else {
  const data = annotatorSnap.data();
  console.log(`Annotator doc FOUND`);
  console.log(`  assigned_articles (${(data.assigned_articles || []).length}):`, data.assigned_articles);
  console.log(`  completed_articles (${(data.completed_articles || []).length}):`, data.completed_articles);

  const articlesSnap = await db.collection("articles").get();
  const byId = new Map(articlesSnap.docs.map((d) => [d.id, d.data()]));

  console.log("\n── Assigned articles with sequence_number ──");
  const assigned = data.assigned_articles || [];
  const seqs = assigned.map((id) => {
    const a = byId.get(id);
    return { id, seq: a?.sequence_number, status: a?.status, aC: a?.assigned_count, annC: a?.annotation_count };
  }).sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));

  for (const s of seqs) {
    console.log(`  seq=${String(s.seq).padStart(4)}  ${s.id}  status=${s.status}  aC=${s.aC}  annC=${s.annC}`);
  }
  if (seqs.length) {
    console.log(`\n  Lowest seq assigned: ${seqs[0].seq}`);
    console.log(`  Highest seq assigned: ${seqs[seqs.length - 1].seq}`);
  }
}

// Articles where this email is in assigned_to
const withEmail = [];
const allArticles = await db.collection("articles").get();
for (const d of allArticles.docs) {
  const data = d.data();
  if ((data.assigned_to || []).includes(email)) {
    withEmail.push({ id: d.id, seq: data.sequence_number, status: data.status, aC: data.assigned_count });
  }
}
withEmail.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
console.log(`\n── Articles with email in assigned_to (${withEmail.length}) ──`);
for (const a of withEmail.slice(0, 25)) {
  console.log(`  seq=${String(a.seq).padStart(4)}  ${a.id}  aC=${a.aC}`);
}
if (withEmail.length > 25) console.log(`  ... +${withEmail.length - 25} more`);
