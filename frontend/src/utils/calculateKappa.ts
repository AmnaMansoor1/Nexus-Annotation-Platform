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
 * Computes P_i — the PERCENT AGREEMENT (observed pairwise agreement) for ONE article.
 *
 * This is the correct per-article inter-rater metric. For 5 raters / 3 categories it
 * varies between 0.2 (maximum disagreement) and 1.0 (unanimous), making it ideal for
 * flagging articles that need adjudication.
 *
 * FORMULA:
 *   P_i = Σ_j [ n_ij × (n_ij − 1) ] / [ n × (n − 1) ]
 *       = (Σ n_ij²  −  n) / (n × (n − 1))        ← equivalent, cheaper to compute
 *
 * EXAMPLE VALUES (n = 5):
 *   (5,0,0) → 1.00  unanimous
 *   (4,1,0) → 0.60  strong majority
 *   (3,2,0) → 0.40  moderate split
 *   (3,1,1) → 0.30  low agreement
 *   (2,2,1) → 0.20  maximum disagreement (for 5 raters / 3 cats)
 *
 * WHY NOT PER-ARTICLE FLEISS' KAPPA?
 *   When n = 5 and there are 3 categories, Fleiss' Kappa collapses to a
 *   mathematical constant: κ = −0.25 for every non-unanimous vote.
 *   Algebraically: kappa = (Po − Pe)/(1 − Pe) = −1/4 for all a+b+c=5, a<5.
 *   It carries zero information per article and must not be stored per-article.
 */
export function calculatePercentAgreement(counts: BiasCounts): number {
  const categories = toCategories(counts);
  const Po = calculateObservedAgreement(categories);
  return parseFloat(Po.toFixed(4));
}

/**
 * @deprecated DO NOT use for per-article storage.
 *
 * For n=5 raters and 3 categories this function returns exactly −0.25 for
 * every non-unanimous article — the chance-adjusted term cancels out and the
 * result is a mathematical constant, not a measurement.
 *
 * Use calculatePercentAgreement() for per-article quality scoring.
 * Use calculateOverallFleissKappa() for dataset-level inter-rater reliability.
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
