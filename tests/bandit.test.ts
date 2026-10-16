import { expect, test } from 'claude-code/testing'

import { evidenceOf, observe, sampleBeta } from '../hooks/bandit'

// mulberry32: a seeded generator, so draws are the same on every run.
export const seeded = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t

  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

test('Beta draws centre on the mean and stay in [0, 1]', () => {
  const random = seeded(7)
  let sum = 0
  for (let i = 0; i < 5000; i++) {
    const x = sampleBeta({ alpha: 8, beta: 2 }, random)
    expect(x >= 0 && x <= 1).toBe(true)
    sum += x
  }
  expect(Math.abs(sum / 5000 - 0.8) < 0.02).toBe(true)
  const small = sampleBeta({ alpha: 0.5, beta: 0.5 }, random)
  expect(small >= 0 && small <= 1).toBe(true)
})

test('a bad shape or a broken random still answers', () => {
  expect(sampleBeta({ alpha: Number.NaN, beta: 1 }, Math.random)).toBe(0.5)
  expect(sampleBeta({ alpha: -1, beta: 1 }, Math.random)).toBe(0.5)
  expect(Number.isFinite(sampleBeta({ alpha: 2, beta: 2 }, () => Number.NaN))).toBe(true)
})

test('an outcome fades the bucket toward the prior, then counts for its model', () => {
  const arms = observe({ haiku: { alpha: 11, beta: 1 } }, 'sonnet', true)
  expect(arms.haiku?.alpha).toBe(1 + 0.97 * 10)
  expect(arms.haiku?.beta).toBe(1)
  expect(arms.sonnet).toEqual({ alpha: 2, beta: 1 })
  expect(observe({}, 'haiku', false).haiku).toEqual({ alpha: 1, beta: 2 })
})

test('evidence saturates near 33 outcomes', () => {
  let arms = {}
  for (let i = 0; i < 500; i++) arms = observe(arms, 'haiku', true)
  const seen = evidenceOf((arms as Record<string, { alpha: number; beta: number }>).haiku ?? { alpha: 1, beta: 1 })
  expect(seen > 32 && seen < 34).toBe(true)
})
