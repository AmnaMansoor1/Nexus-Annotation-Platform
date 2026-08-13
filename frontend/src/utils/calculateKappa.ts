export interface BiasCounts {
  neutral: number;
  slightly: number;
  highly: number;
}

function toCategories(counts: BiasCounts): number[] {
  return [counts.neutral, counts.slightly, counts.highly];
}

function calculateObservedAgreement(categories: number[]): number {
  const n = categories.reduce((sum, count) => sum + count, 0);
  if (n < 2) return 0;

  const sumSq = categories.reduce((sum, count) => sum + count * count, 0);
  return (sumSq - n) / (n * (n - 1));
}

/**
 * Computes Fleiss' Kappa (κ) for inter-rater reliability on ONE article.
 * Uses the observed number of annotations for the article with k=3 categories
 * (neutral, slightly_manipulative, highly_manipulative).
 *
 * FORMULA (per-article κ):
 *   (1) categories  = [N_count, SM_count, HM_count]
 *   (2) n           = sum(categories)                            ← raters per article (default 5)
 *   (3) sumSq       = N² + SM² + HM²
 *   (4) Po          = (sumSq − n) / (n × (n − 1))               ← Observed agreement
 *   (5) p_j         = each category_count / n                    ← category proportions
 *   (6) Pe          = sum( p_j² )                                ← Expected (chance) agreement
 *   (7) κ           = (Po − Pe) / (1 − Pe)                       ← final score, rounded to 3 dec
 *       If Pe = 1  → κ = 1 (perfect agreement, avoids ÷0)
 *       If n  < 2  → κ = 0 (undefined)
 *
 * INTERPRETATION (Landis & Koch, 1977):
 *   κ < 0.0  → Poor         (less than chance)
 *   0.0–0.2  → Slight
 *   0.2–0.4  → Fair
 *   0.4–0.6  → Moderate
 *   0.6–0.8  → Substantial
 *   0.8–1.0  → Almost Perfect
 */
export function calculateFleissKappa(counts: BiasCounts): number {
  const categories = toCategories(counts);
  const n = categories.reduce((sum, count) => sum + count, 0);
  if (n < 2) return 0;

  const p_j = categories.map((count) => count / n);
  const Pe = p_j.reduce((sum, proportion) => sum + proportion * proportion, 0);
  const Po = calculateObservedAgreement(categories);

  if (Pe === 1) return 1;

  const kappa = (Po - Pe) / (1 - Pe);
  return parseFloat(kappa.toFixed(3));
}

/**
 * Computes DATASET-WIDE Fleiss' Kappa across all completed articles (summary level).
 * Aggregates observed and expected agreement across the whole dataset rather
 * than averaging per-article κ values.
 *
 * FORMULA (overall κ):
 *   (1) For each article j ∈ articles, compute Po_j using the per-article formula above.
 *   (2) observedAgreement  = mean( Po_j )                         ← average across articles
 *   (3) For each label category  c ∈ {N, SM, HM}:
 *         p_c = (Σ over articles of count_cj) / (n × N_articles) ← marginal proportion
 *   (4) expectedAgreement  = Σ ( p_c² )                           ← over 3 categories
 *   (5) κ = (observedAgreement − expectedAgreement) / (1 − expectedAgreement)  ← 3 decimals
 *       If expectedAgreement = 1  → κ = 1
 *       If any article has fewer than 2 raters or unequal rater counts → κ = 0
 *
 * EXPORT LOCATION:
 *   Written as the OVERALL_DATASET_KAPPA row in the exported CSV.
 */
export function calculateOverallFleissKappa(allCounts: BiasCounts[]): number {
  if (allCounts.length === 0) return 0;

  const categoryMatrix = allCounts.map(toCategories);
  const annotatorCounts = categoryMatrix.map((categories) =>
    categories.reduce((sum, count) => sum + count, 0)
  );
  const firstAnnotatorCount = annotatorCounts[0];

  if (firstAnnotatorCount < 2 || annotatorCounts.some((count) => count !== firstAnnotatorCount)) {
    return 0;
  }

  const articleAgreements = categoryMatrix.map(calculateObservedAgreement);
  const observedAgreement =
    articleAgreements.reduce((sum, value) => sum + value, 0) / articleAgreements.length;

  const totalAssignments = firstAnnotatorCount * categoryMatrix.length;
  const categoryProportions = [0, 1, 2].map((index) =>
    categoryMatrix.reduce((sum, categories) => sum + categories[index], 0) / totalAssignments
  );
  const expectedAgreement = categoryProportions.reduce(
    (sum, proportion) => sum + proportion * proportion,
    0
  );

  if (expectedAgreement === 1) return 1;

  const kappa = (observedAgreement - expectedAgreement) / (1 - expectedAgreement);
  return parseFloat(kappa.toFixed(3));
}
