/**
 * Computes continuous bias score from the collected annotations for one article.
 *
 * FORMULA:
 *   raw        = (HM_count × 2 + SM_count × 1 + N_count × 0) / n       → 0.0 – 2.0
 *   bias_score = roundTo2Decimals(raw × 2.5)                            → 0.00 – 5.00 (CONTINUOUS)
 *
 * WHERE:
 *   HM = Highly Manipulative count (weight = 2)
 *   SM = Slightly Manipulative count (weight = 1)
 *   N  = Neutral count (weight = 0)
 *   n  = HM + SM + N  (total annotators, default 5)
 *
 * FYP REGRESSION CONTEXT:
 *   The output is kept as a CONTINUOUS 2-decimal float (0.00–5.00) because
 *   the model is trained as a regression task. Report targets:
 *     • MAE  ≤ 0.50
 *     • RMSE ≤ 0.70
 *   Rounding to integers would convert this to ordinal classification and
 *   would break direct comparability against MAE/RMSE metrics defined above.
 */
export function calculateBiasScore(counts: { neutral: number; slightly: number; highly: number }): number {
  const n = counts.neutral + counts.slightly + counts.highly;
  if (n === 0) return 0;

  const rawScore = (counts.highly * 2 + counts.slightly * 1 + counts.neutral * 0) / n;
  const normalizedScore = rawScore * 2.5;

  return parseFloat(normalizedScore.toFixed(2));
}
