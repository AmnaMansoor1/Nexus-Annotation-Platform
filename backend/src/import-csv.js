
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import Papa from "papaparse";

// --- CONFIGURATION ---
// 1. Download your Firebase Admin Service Account:
//    - Go to Firebase Console → Project Settings → Service Accounts
//    - Click "Generate New Private Key"
//    - Save it as `service-account.json` in your project root
// 2. Run this script with: node backend/src/import-csv.js
// --------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const csvPath = path.join(__dirname, "../../annotation_dataset_v6.csv");

async function importArticles() {
  console.log("🚀 Starting import...");
  
  // 1. Read and parse CSV
  console.log("📖 Reading CSV file...");
  const csvFile = fs.readFileSync(csvPath, "utf8");
  const parseResult = Papa.parse(csvFile, {
    header: true,
    skipEmptyLines: true,
  });

  if (parseResult.errors.length > 0) {
    console.error("❌ CSV Parsing Errors:", parseResult.errors);
    return;
  }

  console.log(`✅ Parsed ${parseResult.data.length} rows`);

  // 2. Mock Firestore (replace with real code when you have service account)
  // For now, let's just save a sample of the data to a JSON file
  // To use real Firestore:
  // import admin from "firebase-admin";
  // import serviceAccount from "../../service-account.json" assert { type: "json" };
  // admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  // const db = admin.firestore();
  // Then loop and batch add to db.collection("articles")
  
  console.log("💾 Saving sample to sample-output.json...");
  fs.writeFileSync(
    path.join(__dirname, "../../sample-output.json"),
    JSON.stringify(parseResult.data.slice(0, 10), null, 2)
  );

  console.log("✅ Done! To import to Firestore, add your service-account.json");
}

importArticles().catch((err) => {
  console.error("❌ Import failed:", err);
});
