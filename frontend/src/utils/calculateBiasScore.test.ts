import { describe, expect, test } from 'vitest'
import { calculateBiasScore } from './calculateBiasScore'

describe('calculateBiasScore', () => {
  test('returns 0 when all annotations are neutral', () => {
    const result = calculateBiasScore({ neutral: 10, slightly: 0, highly: 0 })
    expect(result).toBe(0)
  })

  test('returns 2.5 when all annotations are slightly manipulative', () => {
    const result = calculateBiasScore({ neutral: 0, slightly: 10, highly: 0 })
    expect(result).toBe(2.5)
  })

  test('returns 5 when all annotations are highly manipulative', () => {
    const result = calculateBiasScore({ neutral: 0, slightly: 0, highly: 10 })
    expect(result).toBe(5)
  })

  test('returns correct score for mixed annotations', () => {
    const result = calculateBiasScore({ neutral: 4, slightly: 3, highly: 3 })
    expect(result).toBeCloseTo(2.25, 2)
  })

  test('returns 0 when no annotations are present', () => {
    const result = calculateBiasScore({ neutral: 0, slightly: 0, highly: 0 })
    expect(result).toBe(0)
  })
})

