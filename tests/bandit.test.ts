import { expect, test } from 'claude-code/testing'

import { choose, evidenceOf, observe, sampleBeta } from '../hooks/bandit'

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

const HALF = () => 0.5

test('with no record the rules decide, apart from a probe', () => {
  const base = { model: 'sonnet', junior: 'haiku', senior: 'opus', arms: {}, ratio: () => 0.5, random: seeded(1) }
  expect(choose({ ...base, probe: false })).toEqual({ model: 'sonnet' })
  expect(choose({ ...base, probe: true })).toEqual({ model: 'haiku', reason: 'probe: trying haiku' })
  expect(choose({ ...base, junior: undefined, probe: true })).toEqual({ model: 'sonnet' })
})

test('a record moves a route one tier, never two', () => {
  const base = { model: 'sonnet', junior: 'haiku', senior: 'opus', ratio: HALF, probe: false, random: seeded(2) }
  expect(choose({ ...base, arms: { haiku: { alpha: 31, beta: 1 } } }).model).toBe('haiku')
  expect(choose({ ...base, arms: { haiku: { alpha: 2, beta: 30 } } }).model).toBe('sonnet')
  expect(choose({ ...base, arms: { sonnet: { alpha: 1, beta: 31 } } })).toEqual({
    model: 'opus',
    reason: 'learned: sonnet escalates these',
  })
  // No senior within the session's model: a failing record stays put.
  expect(choose({ ...base, senior: undefined, arms: { sonnet: { alpha: 1, beta: 31 } } }).model).toBe('sonnet')
  // Four outcomes are not enough to move anything.
  expect(choose({ ...base, arms: { haiku: { alpha: 5, beta: 1 } } }).model).toBe('sonnet')
})

test('a cheap junior still has to succeed most of the time', () => {
  // At Haiku 5.5's price the break-even is 5%; a 25% success rate pays on
  // price alone, but three escalations in four cost the user too much time.
  const base = { model: 'sonnet', junior: 'haiku', senior: 'opus', ratio: () => 0.05, probe: false, random: seeded(3) }
  expect(choose({ ...base, arms: { haiku: { alpha: 9, beta: 25 } } }).model).toBe('sonnet')
  expect(choose({ ...base, arms: { haiku: { alpha: 30, beta: 3 } } }).model).toBe('haiku')
})
