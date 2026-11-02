/**
 * Thompson sampling over each model's success rate within a bucket of tasks.
 *
 * `gamma` and `sampleBeta` are adapted from ruflo
 * (v3/@claude-flow/cli/src/ruvector/model-router.ts, MIT, Copyright (c)
 * 2024-2026 ruvnet; see THIRD_PARTY_NOTICES.md): the random source is passed
 * in, and the rejection loop is capped.
 */

export type Random = () => number

/** Beta(alpha, beta) belief in a model's success rate; Beta(1, 1) knows nothing. */
export type Arm = { alpha: number; beta: number }

export const PRIOR: Arm = { alpha: 1, beta: 1 }

const normal = (random: Random) => {
  const u1 = random() || 1e-12
  const u2 = random()

  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
}

// Marsaglia and Tsang (2000); a shape under 1 is boosted by one and scaled
// back. A random that never satisfies the test (NaN) ends at the mean.
const gamma = (shape: number, random: Random): number => {
  if (shape < 1) return gamma(shape + 1, random) * Math.pow(random() || 1e-12, 1 / shape)
  const d = shape - 1 / 3
  const c = 1 / Math.sqrt(9 * d)

  for (let tries = 0; tries < 1000; tries++) {
    let x = normal(random)
    let v = 1 + c * x
    for (let inner = 0; v <= 0 && inner < 1000; inner++) {
      x = normal(random)
      v = 1 + c * x
    }
    v = v * v * v
    const u = random()
    if (u < 1 - 0.0331 * x ** 4) return d * v
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v
  }

  return d
}

const isShape = (n: number) => Number.isFinite(n) && n > 0

/** A draw from Beta(alpha, beta); 0.5 for a shape that is not a positive finite number. */
export const sampleBeta = (arm: Arm, random: Random) => {
  if (!isShape(arm.alpha) || !isShape(arm.beta)) return 0.5
  const x = gamma(arm.alpha, random)
  const y = gamma(arm.beta, random)

  return Number.isFinite(x / (x + y)) ? x / (x + y) : 0.5
}

/** How much of a bucket's record each new outcome there keeps: about 33 outcomes of memory. */
export const DECAY = 0.97

const fade = (arm: Arm): Arm => ({
  alpha: 1 + DECAY * (arm.alpha - 1),
  beta: 1 + DECAY * (arm.beta - 1),
})

/** One outcome in a bucket: every arm there fades toward the prior, then the model's arm counts it. */
export const observe = (
  arms: Readonly<Record<string, Arm>>,
  model: string,
  isSuccess: boolean,
): Record<string, Arm> => {
  const faded: Record<string, Arm> = {}
  for (const [name, arm] of Object.entries(arms)) faded[name] = fade(arm)
  const arm = faded[model] ?? { ...PRIOR }
  faded[model] = { alpha: arm.alpha + (isSuccess ? 1 : 0), beta: arm.beta + (isSuccess ? 0 : 1) }

  return faded
}

/** The outcomes an arm still remembers. */
export const evidenceOf = (arm: Arm) => arm.alpha + arm.beta - 2

/** Outcomes an arm needs before its record can move a route. */
export const MIN_EVIDENCE = 5

/** How far past break-even a cheaper model must look: an escalation costs time as well as tokens. */
export const MARGIN = 0.15

/**
 * The success rate a cheaper model needs whatever its price: each escalation
 * costs the user a second run's wait, which no price counts. At Haiku 5.5's
 * price the break-even alone would hand sonnet's work to a haiku that
 * escalates three times in four.
 */
export const FLOOR = 0.7

/**
 * How often a placed task tries a junior with too little record. Every outcome
 * in a bucket fades every arm by DECAY, so probes alone hold a junior at
 * 1 / (1 - DECAY^n) outcomes: every 10th peaks at 3.81, which never reaches
 * MIN_EVIDENCE, and every 5th at 7.08, which stays above it between probes.
 */
export const PROBE_EVERY = 5

export type Choice = { model: string; reason?: string; isProbe?: boolean }

export type ChooseInput = {
  /** The rules' model. */
  model: string
  /** One tier down; undefined at the bottom. */
  junior?: string
  /** One tier up within the session's model; undefined where there is none. */
  senior?: string
  arms: Readonly<Record<string, Arm>>
  /** What `cheap` costs as a share of `dear`. */
  ratio: (cheap: string, dear: string) => number
  /** Whether this route may try a junior that has too little record. */
  probe: boolean
  random: Random
}

/**
 * The model a placed task runs on: the rules' pick, unless the bucket's
 * record says the tier above or below is the better buy.
 *
 * Up: running `model` and paying for its escalations costs more than going
 * straight to the senior once p(success) < ratio(model, senior).
 * Down: the junior pays for itself once p(success) > ratio(junior, model),
 * and must clear MARGIN besides, and FLOOR.
 */
export const choose = (input: ChooseInput): Choice => {
  const { model, junior, senior, arms, ratio, probe, random } = input
  const own = arms[model]
  if (
    senior !== undefined &&
    own !== undefined &&
    evidenceOf(own) >= MIN_EVIDENCE &&
    sampleBeta(own, random) < ratio(model, senior)
  ) {
    return { model: senior, reason: `learned: ${model} escalates these` }
  }
  if (junior === undefined) return { model }

  const below = arms[junior]
  if (below !== undefined && evidenceOf(below) >= MIN_EVIDENCE) {
    return sampleBeta(below, random) > Math.max(ratio(junior, model) + MARGIN, FLOOR)
      ? { model: junior, reason: `learned: ${junior} handles these` }
      : { model }
  }

  return probe ? { model: junior, reason: `probe: trying ${junior}`, isProbe: true } : { model }
}
