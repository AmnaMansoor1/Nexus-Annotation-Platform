/**
 * Computes Fleiss' Kappa for inter-rater reliability.
 * Given N=10 annotators, k=3 categories (neutral, slightly, highly)
 * κ = (P_o - P_e) / (1 - P_e)
 */
export function calculateFleissKappa(counts: { neutral: number; slightly: number; highly: number }): number {
  const n = counts.neutral + counts.slightly + counts.highly; // Should be 10
  if (n < 2) return 0;

  const categories = [counts.neutral, counts.slightly, counts.highly];
  
  // P_e: sum(p_j^2) where p_j is the proportion of all assignments to category j
  const p_j = categories.map(count => count / n);
  const Pe = p_j.reduce((acc, p) => acc + p * p, 0);

  // P_o: Observed agreement
  // For a single article with n annotators:
  // P_i = (sum(n_ij^2) - n) / (n * (n - 1))
  const sumSq = categories.reduce((acc, count) => acc + count * count, 0);
  const Po = (sumSq - n) / (n * (n - 1));

  if (Pe === 1) return 1; // Perfect agreement
  
  const kappa = (Po - Pe) / (1 - Pe);
  return parseFloat(kappa.toFixed(3));
}
