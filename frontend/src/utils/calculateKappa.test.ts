import { describe, expect, test } from 'vitest'
import { calculateFleissKappa } from './calculateKappa'

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
