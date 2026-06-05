/**
 * Computes bias score based on 10 annotations.
 * bias_score = (HM_count×2 + SM_count×1 + N_count×0) / 10 × 2.5
 * This maps 0-2 range to 0-5 scale.
 */
export function calculateBiasScore(counts: { neutral: number; slightly: number; highly: number }): number {
  const n = counts.neutral + counts.slightly + counts.highly;
  if (n === 0) return 0;
  
  const rawScore = (counts.highly * 2 + counts.slightly * 1 + counts.neutral * 0) / n;
  const normalizedScore = rawScore * 2.5;
  
  return parseFloat(normalizedScore.toFixed(2));
}
