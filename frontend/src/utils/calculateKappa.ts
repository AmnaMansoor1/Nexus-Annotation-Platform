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
 * Computes Fleiss' Kappa for inter-rater reliability on one article.
 * Uses the observed number of annotations for the article, k=3 categories
 * (neutral, slightly, highly).
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
 * Computes dataset-wide Fleiss' Kappa across completed articles.
 * All included articles must have the same number of annotators.
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
