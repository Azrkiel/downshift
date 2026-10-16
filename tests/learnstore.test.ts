import { expect, test } from 'claude-code/testing'

import { describe, fresh, open, parse, record, reset, serialize } from '../hooks/learnstore'
import type { Files } from '../hooks/learnstore'

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

const PATH = 'C:/home/.claude/model-router-state.json'

const memory = (initial: Record<string, string> = {}) => {
  const disk = new Map(Object.entries(initial))
  const files: Files = {
    exists: async path => disk.has(path),
    read: async path => {
      const text = disk.get(path)
      if (text === undefined) throw new Error('ENOENT')

      return text
    },
    write: async (path, text) => {
      disk.set(path, text)
    },
  }

  return { disk, files }
}

test('an outcome is added to what the file holds now', async () => {
  const { disk, files } = memory()
  const store = await open(files, PATH)
  expect(store.isWritable).toBe(true)
  // Another session writes after this one opened.
  disk.set(PATH, serialize({ ...fresh(), builder: { haiku: { alpha: 5, beta: 1 } } }))
  const after = await record(files, store, 'builder', 'sonnet', true)
  const saved = parse(disk.get(PATH) ?? '')
  expect('learned' in saved && saved.learned.builder.sonnet).toEqual({ alpha: 2, beta: 1 })
  expect('learned' in saved && saved.learned.builder.haiku).toEqual({ alpha: 1 + 0.97 * 4, beta: 1 })
  expect(after.learned.builder.haiku).toEqual({ alpha: 1 + 0.97 * 4, beta: 1 })
})

test('a file that will not parse is never overwritten', async () => {
  const { disk, files } = memory({ [PATH]: 'garbage' })
  const store = await open(files, PATH)
  expect(store.isWritable).toBe(false)
  expect(store.problem).toBe('not valid JSON')
  const after = await record(files, store, 'scout', 'haiku', false)
  expect(disk.get(PATH)).toBe('garbage')
  expect(after.learned.scout.haiku).toEqual({ alpha: 1, beta: 2 })
  expect(describe(after).join('\n')).toContain('memory only: not valid JSON')
})

test('reset starts the file over, and no home folder means memory only', async () => {
  const { disk, files } = memory({ [PATH]: 'garbage' })
  const store = await reset(files, PATH)
  expect(store.isWritable).toBe(true)
  expect(parse(disk.get(PATH) ?? '')).toEqual({ learned: fresh() })
  expect((await open(files, '')).isWritable).toBe(false)
})
