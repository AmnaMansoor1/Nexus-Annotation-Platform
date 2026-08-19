# Firestore Index Recommendations

To ensure optimal performance for your annotation platform, the following composite index must exist in your Firebase Console.

## ✅ DEPLOYED INDEX (Strategy A — Sequential Eligibility)
- **Collection**: `articles`
- **Fields** (in this exact order):
  1. `status` (Ascending)
  2. `sequence_number` (Ascending)
- **Query Scope**: Collection
- **Purpose**: Powers Strategy A assignment query:
  ```
  where("status", "in", ["pending", "partial"])
  orderBy("sequence_number", "asc")
  limit(100)
  ```
- **Cost Impact (with this index active)**: ~100 reads per first-time student assignment, vs ~500 reads per assignment via Strategy B fallback (client-side filter on 500 documents). ~5× cheaper per new student.

## Verify Index Exists
Run this command and confirm it matches exactly (note: `__name__ ASC` is auto-appended by Firestore, do NOT add it manually):
```bash
firebase firestore:indexes
```

Expected output:
```json
{
  "indexes": [
    {
      "collectionGroup": "articles",
      "queryScope": "COLLECTION",
      "fields": [
        { "fieldPath": "status", "order": "ASCENDING" },
        { "fieldPath": "sequence_number", "order": "ASCENDING" },
        { "fieldPath": "__name__", "order": "ASCENDING" }
      ],
      "density": "SPARSE_ALL"
    }
  ],
  "fieldOverrides": []
}
```

## How to Deploy (if missing)
The local `firestore.indexes.json` in this repo matches the spec above. To deploy it:
```bash
firebase deploy --only firestore:indexes
```

## Expected Concurrency:
Your platform should handle **500+ concurrent annotators** comfortably with these optimizations:
- Vercel auto-scales the frontend
- Firestore auto-scales the backend
- We've added jitter to avoid thundering herd
- We use batched writes for better throughput
- Optimistic UI updates improve perceived performance
- LocalStorage assignment caching avoids ~600 redundant reads per student session
