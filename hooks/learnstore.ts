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

/** The file system calls the store makes; `$.fs` in the mod, a Map in tests. */
export type Files = {
  exists: (path: string) => Promise<boolean>
  read: (path: string) => Promise<string>
  write: (path: string, text: string) => Promise<void>
}

/** The record in memory, and whether the file under it may be written. */
export type Store = { learned: Learned; path: string; isWritable: boolean; problem?: string }

const memoryOnly = (path: string, problem: string, learned = fresh()): Store => ({
  learned,
  path,
  isWritable: false,
  problem,
})

/** Reads the record; a file that exists but is not trusted is left as it is, and learning stays in memory. */
export const open = async (files: Files, path: string): Promise<Store> => {
  if (path === '') return memoryOnly(path, 'no home folder')
  try {
    if (!(await files.exists(path))) return { learned: fresh(), path, isWritable: true }
    const read = parse(await files.read(path))

    return 'learned' in read
      ? { learned: read.learned, path, isWritable: true }
      : memoryOnly(path, read.problem)
  } catch (error) {
    return memoryOnly(path, `unreadable (${String(error)})`)
  }
}

/**
 * Counts one outcome in memory and, while the file is trusted, in the file as
 * it stands now, so what another session wrote since is kept.
 */
export const record = async (
  files: Files,
  store: Store,
  bucket: Bucket,
  model: string,
  isSuccess: boolean,
): Promise<Store> => {
  const learned = { ...store.learned, [bucket]: observe(store.learned[bucket], model, isSuccess) }
  if (!store.isWritable) return { ...store, learned }

  const now = await open(files, store.path)
  if (!now.isWritable) return memoryOnly(store.path, now.problem ?? 'unreadable', learned)
  const merged = { ...now.learned, [bucket]: observe(now.learned[bucket], model, isSuccess) }
  try {
    await files.write(store.path, serialize(merged))

    return { ...store, learned: merged }
  } catch (error) {
    return memoryOnly(store.path, `not writable (${String(error)})`, learned)
  }
}

/** Starts the record over, in the file too: the one way past a file that is not trusted. */
export const reset = async (files: Files, path: string): Promise<Store> => {
  if (path === '') return memoryOnly(path, 'no home folder')
  try {
    await files.write(path, serialize(fresh()))

    return { learned: fresh(), path, isWritable: true }
  } catch (error) {
    return memoryOnly(path, `not writable (${String(error)})`)
  }
}

const rate = (arm: Arm) =>
  `${Math.round(((arm.alpha - 1) / evidenceOf(arm)) * 100)}% of ${evidenceOf(arm).toFixed(1)}`

/** The record as `/router learn` shows it: per bucket, each model's success rate and how much it rests on. */
export const describe = (store: Store) => [
  store.path === ''
    ? 'State: memory only (no home folder found).'
    : `State: ${store.path}${store.isWritable ? '' : ` (memory only: ${store.problem ?? 'unknown'})`}`,
  ...BUCKETS.map(
    bucket =>
      `  ${bucket.padEnd(10)}${MODELS.map(model => {
        const arm = store.learned[bucket][model]

        return `${model} ${arm === undefined || evidenceOf(arm) < 0.05 ? '-' : rate(arm)}`
      }).join(' · ')}`,
  ),
]
