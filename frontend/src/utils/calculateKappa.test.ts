import { describe, expect, test } from 'vitest'
import { calculateFleissKappa, calculateOverallFleissKappa, calculatePercentAgreement } from './calculateKappa'

describe('calculateFleissKappa', () => {
  test('returns 1 when all annotators agree', () => {
    const result = calculateFleissKappa({ neutral: 10, slightly: 0, highly: 0 })
    expect(result).toBe(1)
  })

  test('returns correct kappa for perfect even split (n=3)', () => {
    // For n=3, annotations split 1,1,1
    const result = calculateFleissKappa({ neutral: 1, slightly: 1, highly: 1 })
    expect(result).toBe(-0.5)
  })

  test('returns correct kappa for mixed annotations', () => {
    // For n=10, annotations split 3,3,4
    const knownResult = calculateFleissKappa({ neutral: 3, slightly: 3, highly: 4 })
    expect(knownResult).toBeCloseTo(-0.111, 3)
  })

  test('returns 0 when there are fewer than 2 annotations', () => {
    const result = calculateFleissKappa({ neutral: 1, slightly: 0, highly: 0 })
    expect(result).toBe(0)
  })
})

describe('calculatePercentAgreement (P_i)', () => {
  test('returns 1.0 for unanimous 5-rater vote', () => {
    expect(calculatePercentAgreement({ neutral: 5, slightly: 0, highly: 0 })).toBe(1)
  })

  test('returns 0.6 for (4,1,0) — strong majority', () => {
    expect(calculatePercentAgreement({ neutral: 4, slightly: 1, highly: 0 })).toBeCloseTo(0.6, 4)
  })

  test('returns 0.4 for (3,2,0) — moderate split', () => {
    expect(calculatePercentAgreement({ neutral: 3, slightly: 2, highly: 0 })).toBeCloseTo(0.4, 4)
  })

  test('returns 0.3 for (3,1,1) — low agreement', () => {
    expect(calculatePercentAgreement({ neutral: 3, slightly: 1, highly: 1 })).toBeCloseTo(0.3, 4)
  })

  test('returns 0.2 for (2,2,1) — maximum disagreement for 5 raters / 3 cats', () => {
    expect(calculatePercentAgreement({ neutral: 2, slightly: 2, highly: 1 })).toBeCloseTo(0.2, 4)
  })

  test('actually varies — is NOT a constant like per-article Fleiss kappa was', () => {
    // Every non-unanimous 5-rater fleiss_kappa = -0.25; P_i gives distinct values
    const p1 = calculatePercentAgreement({ neutral: 4, slightly: 1, highly: 0 }) // 0.60
    const p2 = calculatePercentAgreement({ neutral: 3, slightly: 1, highly: 1 }) // 0.30
    const p3 = calculatePercentAgreement({ neutral: 2, slightly: 2, highly: 1 }) // 0.20
    expect(p1).not.toBeCloseTo(p2, 3)
    expect(p2).not.toBeCloseTo(p3, 3)
    expect(p1 > p2).toBe(true)
    expect(p2 > p3).toBe(true)
  })

  test('returns 0 for fewer than 2 annotations', () => {
    expect(calculatePercentAgreement({ neutral: 1, slightly: 0, highly: 0 })).toBe(0)
  })
})

describe('calculateOverallFleissKappa', () => {
  test('returns 1 when every completed article has perfect agreement', () => {
    const result = calculateOverallFleissKappa([
      { neutral: 5, slightly: 0, highly: 0 },
      { neutral: 0, slightly: 5, highly: 0 },
      { neutral: 0, slightly: 0, highly: 5 },
    ])
    expect(result).toBe(1)
  })

  test('returns 0 when articles do not share the same annotator count', () => {
    const result = calculateOverallFleissKappa([
      { neutral: 5, slightly: 0, highly: 0 },
      { neutral: 4, slightly: 1, highly: 0 },
      { neutral: 3, slightly: 0, highly: 0 },
    ])
    expect(result).toBe(0)
  })
})
