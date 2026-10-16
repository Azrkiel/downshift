import { expect, test } from 'claude-code/testing'

import { fresh, parse, serialize } from '../hooks/learnstore'

test('a state file keeps only known buckets, models and sane numbers', () => {
  const read = parse(
    JSON.stringify({
      version: 1,
      buckets: {
        builder: {
          haiku: { alpha: 4, beta: 2 },
          sonnet: { alpha: Number.NaN, beta: 1 },
          opus: { alpha: -3, beta: 1 },
          'gpt-x': { alpha: 2, beta: 2 },
        },
        scout: { haiku: { alpha: 1e9, beta: 1 } },
        // Computed, so it is an own key in the JSON rather than the literal's prototype.
        ['__proto__']: { haiku: { alpha: 2, beta: 2 } },
        nonsense: { haiku: { alpha: 2, beta: 2 } },
      },
    }),
  )
  expect('learned' in read).toBe(true)
  if (!('learned' in read)) return
  expect(read.learned.builder).toEqual({ haiku: { alpha: 4, beta: 2 } })
  expect(read.learned.scout).toEqual({})
  expect(Object.keys(read.learned)).toEqual(['scout', 'builder', 'architect', 'open'])
  expect(Object.getPrototypeOf(read.learned)).toBe(Object.prototype)
})

test('a state file in another shape is a problem, not a state', () => {
  expect(parse('{oops')).toEqual({ problem: 'not valid JSON' })
  expect(parse('[]')).toEqual({ problem: 'not a JSON object' })
  expect(parse('{"version":2,"buckets":{}}')).toEqual({ problem: 'version 2, expected 1' })
})

test('the state written holds counts and nothing else', () => {
  const text = serialize({ ...fresh(), builder: { haiku: { alpha: 2, beta: 1 } } })
  expect(JSON.parse(text)).toEqual({
    version: 1,
    buckets: { scout: {}, builder: { haiku: { alpha: 2, beta: 1 } }, architect: {}, open: {} },
  })
})
