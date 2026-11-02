/**
 * Whether a new task is an earlier one sent again: a sign the earlier answer
 * was not good enough, which a run that never says it is stuck cannot report.
 *
 * Prompt overlap alone is not enough: a batch from one template ("Audit R+RT
 * findings", "Audit T+B findings") overlaps nearly word for word. So the names
 * must match too, once retry words are out of them.
 */

const RETRY = /\b(retry|retrying|retried|redo|again|second attempt|2nd attempt)\b/g
/** Fewer words than this says too little to tell two tasks apart. */
const MIN_WORDS = 8
const MIN_OVERLAP = 0.5

const label = (text: string) =>
  text.toLowerCase().replace(RETRY, ' ').replace(/[^a-z0-9]+/g, ' ').trim()

const wordsOf = (text: string) => new Set(text.toLowerCase().match(/[a-z0-9_./-]{3,}/g) ?? [])

export type Task = { description: string; prompt: string }

export const isRedo = (before: Task, after: Task) => {
  const name = label(before.description)
  if (name === '' || name !== label(after.description)) return false

  const a = wordsOf(before.prompt)
  const b = wordsOf(after.prompt)
  if (a.size < MIN_WORDS || b.size < MIN_WORDS) return false
  const shared = [...a].filter(word => b.has(word)).length

  return shared / (a.size + b.size - shared) >= MIN_OVERLAP
}
