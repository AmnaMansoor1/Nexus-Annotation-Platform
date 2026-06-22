# Firestore Index Recommendations

To ensure optimal performance for your annotation platform, create the following composite indexes in your Firebase Console:

## 1. Article Eligibility Query (Main)
- **Collection**: `articles`
- **Fields**:
  1. `status` (Ascending)
  2. `assigned_count` (Ascending)
  3. `article_id` (Ascending)
- **Query Scope**: Collection

## 2. Article Eligibility Query (Secondary)
- **Collection**: `articles`
- **Fields**:
  1. `status` (Ascending)
  2. `assigned_count` (Ascending)
  3. `date_published` (Ascending)
- **Query Scope**: Collection

## 3. Status-based Article Query
- **Collection**: `articles`
- **Fields**:
  1. `status` (Ascending)
- **Query Scope**: Collection (single-field index is auto-created)

## How to Create Indexes:
1. Go to the [Firebase Console](https://console.firebase.google.com)
2. Select your project
3. Go to **Firestore Database** > **Indexes**
4. Click **Add Index**
5. For each recommendation above:
   - Select the collection
   - Add the fields in order
   - Set the scope to "Collection"
6. Click **Create**

## Expected Concurrency:
Your platform should handle **500+ concurrent annotators** comfortably with these optimizations:
- Vercel auto-scales the frontend
- Firestore auto-scales the backend
- We've added jitter to avoid thundering herd
- We use batched writes for better throughput
- Optimistic UI updates improve perceived performance
