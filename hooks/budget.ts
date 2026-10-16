import type { Bucket } from './learnstore'

/** Adapted from ruflo-mods' cost ladder: a rung is told once on the way up. */
export type Rung = 'ok' | 'tight' | 'critical'

export const TIGHT = 75
export const CRITICAL = 90

const ORDER: Record<Rung, number> = { ok: 0, tight: 1, critical: 2 }

/** The rung of the fullest rate-limit window. */
export const rungOf = (limits: readonly { percentUsed: number }[]): Rung => {
  const top = Math.max(0, ...limits.map(limit => limit.percentUsed).filter(Number.isFinite))

  return top >= CRITICAL ? 'critical' : top >= TIGHT ? 'tight' : 'ok'
}

export const isRaised = (from: Rung, to: Rung) => ORDER[to] > ORDER[from]

/** Whether the rung moves a route one tier down: tight moves the fallback's tasks, critical every placed one. */
export const shiftsDown = (rung: Rung, bucket: Bucket) =>
  rung === 'critical' || (rung === 'tight' && bucket === 'open')
