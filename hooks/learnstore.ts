import type { Arm } from './bandit'
import { evidenceOf, observe } from './bandit'

/** Where the record lives under the home folder; never read from a project. */
export const STATE_FILE = '.claude/model-router-state.json'

const VERSION = 1

export const BUCKETS = ['scout', 'builder', 'architect', 'open'] as const
export type Bucket = (typeof BUCKETS)[number]

const MODELS = ['haiku', 'sonnet', 'opus'] as const

/** Largest shape a file may hold; decay keeps real ones near 34. */
const MAX_SHAPE = 1000

/** Per bucket, per model, a Beta belief in its success rate. Counts only: no task text. */
export type Learned = Record<Bucket, Record<string, Arm>>

export const fresh = (): Learned => ({ scout: {}, builder: {}, architect: {}, open: {} })

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isShape = (n: unknown): n is number =>
  typeof n === 'number' && Number.isFinite(n) && n >= 1 && n <= MAX_SHAPE

const own = (record: Record<string, unknown>, key: string) =>
  Object.hasOwn(record, key) ? record[key] : undefined

/** The record a file holds, or why it is not trusted: only known buckets, models and sane numbers get through. */
export const parse = (text: string): { learned: Learned } | { problem: string } => {
  let file: unknown
  try {
    file = JSON.parse(text)
  } catch {
    return { problem: 'not valid JSON' }
  }
  if (!isRecord(file)) return { problem: 'not a JSON object' }
  const version = own(file, 'version')
  if (version !== VERSION) return { problem: `version ${String(version)}, expected ${VERSION}` }

  const learned = fresh()
  const buckets = own(file, 'buckets')
  if (!isRecord(buckets)) return { learned }
  for (const bucket of BUCKETS) {
    const arms = own(buckets, bucket)
    if (!isRecord(arms)) continue
    for (const model of MODELS) {
      const arm = own(arms, model)
      if (!isRecord(arm)) continue
      const alpha = own(arm, 'alpha')
      const beta = own(arm, 'beta')
      if (isShape(alpha) && isShape(beta)) learned[bucket][model] = { alpha, beta }
    }
  }

  return { learned }
}

export const serialize = (learned: Learned) =>
  `${JSON.stringify({ version: VERSION, buckets: learned }, null, 2)}\n`
