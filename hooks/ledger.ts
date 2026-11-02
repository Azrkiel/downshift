/**
 * What routing saved, per UTC day, kept in `$.store` across sessions. Counts
 * and dollars only: no task text.
 *
 * Two sessions writing at the same moment can lose one update, which is
 * acceptable for an estimate.
 */

export const LEDGER_KEY = 'ledger'

const VERSION = 1
const DAY = /^\d{4}-\d{2}-\d{2}$/
const FIELDS = ['runs', 'tokens', 'cost', 'base', 'saved', 'escalated', 'redone'] as const

export type Day = Record<(typeof FIELDS)[number], number>
export type Ledger = { version: typeof VERSION; days: Record<string, Day> }

const zero = (): Day => ({ runs: 0, tokens: 0, cost: 0, base: 0, saved: 0, escalated: 0, redone: 0 })

export const empty = (): Ledger => ({ version: VERSION, days: {} })

export const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10)

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const dayFrom = (value: unknown): Day | undefined => {
  if (!isRecord(value)) return undefined
  const day = zero()
  for (const field of FIELDS) {
    const n = value[field]
    if (typeof n !== 'number' || !Number.isFinite(n)) return undefined
    day[field] = n
  }

  return day
}

/** The ledger the store holds; anything else counts as none, and a bad day is dropped. */
export const parseLedger = (value: unknown): Ledger => {
  const ledger = empty()
  if (!isRecord(value) || value.version !== VERSION || !isRecord(value.days)) return ledger
  for (const [key, raw] of Object.entries(value.days)) {
    const day = DAY.test(key) ? dayFrom(raw) : undefined
    if (day !== undefined) ledger.days[key] = day
  }

  return ledger
}

const plus = (a: Day, b: Partial<Day>): Day => {
  const sum = { ...a }
  for (const field of FIELDS) sum[field] += b[field] ?? 0

  return sum
}

export const addTo = (ledger: Ledger, day: string, delta: Partial<Day>): Ledger => ({
  ...ledger,
  days: { ...ledger.days, [day]: plus(ledger.days[day] ?? zero(), delta) },
})

export const totalOf = (ledger: Ledger) => Object.values(ledger.days).reduce(plus, zero())

const firstDay = (ledger: Ledger) => Object.keys(ledger.days).sort()[0]

const money = (amount: number) => `${amount < 0 ? '-' : ''}$${Math.abs(amount).toFixed(2)}`

const runsOf = (count: number) => `${count} ${count === 1 ? 'run' : 'runs'}`

/** One line for the `/downshift` report; undefined with nothing recorded. */
export const lifetimeLine = (ledger: Ledger) => {
  const first = firstDay(ledger)
  if (first === undefined) return undefined
  const total = totalOf(ledger)

  return `Since ${first}: saved ~${money(total.saved)} over ${runsOf(total.runs)}.`
}

export const describeLedger = (ledger: Ledger) => {
  const first = firstDay(ledger)
  if (first === undefined) return 'Nothing recorded yet.'
  const total = totalOf(ledger)

  return [
    `All sessions since ${first}: saved ~${money(total.saved)} over ${runsOf(total.runs)}.`,
    `Those runs cost ${money(total.cost)}, against ${money(total.base)} on their parents' models, at API list prices.`,
    `${total.escalated} escalated, ${total.redone} redone; both count as a loss of the run's cost.`,
    `${(total.tokens / 1_000_000).toFixed(1)}M tokens. An estimate: it assumes the stronger model would use the same tokens. On a subscription this is usage room, not money.`,
  ].join('\n')
}
