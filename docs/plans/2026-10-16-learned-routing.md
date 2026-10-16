# Learned routing (ruflo port) — implementation plan

**Goal:** Let model-router learn from its own escalations which tier each kind of task needs, by porting the parts of ruflo's model router that hold up, and fix the security holes those parts have in ruflo.

**Architecture:** The keyword rules still place every task first. A Thompson-sampling bandit (`hooks/bandit.ts`) can then move a task one tier up or down, but only when the record in that task's bucket justifies it. The record is a Beta posterior per bucket and model, kept in a validated user-level JSON file (`hooks/learnstore.ts`). Outcomes come for free from the existing escalation handoff: an answer counts as a success and a handoff counts as a failure. A rate-limit ladder (`hooks/budget.ts`) shifts tasks down when a usage window is nearly spent.

**Tech stack:** TypeScript mods API (`claude-code`), the `claude-code/testing` harness, `claude plugin test .` and `claude plugin validate .`.

Source reviewed: `ruvnet/ruflo@main` (2026-10-16), mainly `v3/@claude-flow/cli/src/ruvector/model-router.ts`, `q-learning-router.ts`, `services/learned-routing.ts`, `router-calibrator.ts`, `plugins/ruflo-mods/hooks/route/*` and `plugins/ruflo-mods/hooks/cost/*`. Their self-audit was also read: `docs/reviews/intelligence-system-audit-2026-05-29.md`.

---

## What we take, what we leave

### Take

| From ruflo | Why it's good | How it lands here |
|---|---|---|
| `sampleGamma` / `sampleBeta` (Marsaglia–Tsang) | Correct, small, no dependencies. Their audit measured the bandit as real. | Copied into `bandit.ts` with an injectable `random` and a loop guard. MIT notice added. |
| Per-bucket Beta priors (their ADR-142) | Fixes the "global bandit" flaw, where failures on hard tasks suppress a model on easy ones too. | Buckets are the router's own tiers: `scout`, `builder`, `architect` and `open` (fallback). |
| Discounted Thompson sampling (`priorDecay`) | Lets the bandit recover when a model gets better or worse. | Redone as decay *toward the prior* (`α ← 1 + γ(α−1)`), so no `PRIOR_DECAY_FLOOR` hack is needed. γ = 0.97, which gives about 33 outcomes of memory. |
| Cost-weighted decision (`BANDIT_REWARDS`) | The right idea: a cheap model only has to succeed often enough to pay for its own escalations. | Derived from the mod's price table instead of a hand-tuned table. A cheaper model wins when sampled p(success) > price ratio + margin. |
| Evidence gate (the #2250 fix: `selectedSamples >= 5`) | Keeps cold start identical to the plain rules. | `MIN_EVIDENCE = 5`. With less evidence, the rules' pick stands. |
| Versioned state with forward migration (`migratePriors`) | Reading the state file never throws. | `parse()` validates strictly. An unknown version is never overwritten. |
| Word-boundary keyword matching (their `router-wordboundary` fix) | **This mod has the bug ruflo fixed:** rule-file keywords use `text.includes`, so the example file's `adr` matches "address" and sends it to opus. | `wordPattern()` anchors both ends, including inside multi-word phrases, which ruflo leaves unanchored. |
| Budget ladder with announce-once (`ruflo-mods/hooks/cost`) | Cheap and in-process. Each rung change is announced only once. | Driven by `session.measure` `rateLimits` (five-hour and seven-day windows) instead of USD, since this account is on a subscription. It shifts tasks down instead of refusing spawns. |

### Leave

| From ruflo | Why not |
|---|---|
| `analyzeComplexity` (lexical, scope and uncertainty scores) | Substring indicators (`'add'` matches "address"), word length as a proxy for complexity, and `/might/` matching "mighty". The mod's regex tiers are already better. |
| Uncertainty → escalation gate | Structurally broken by their own account in #2250: it fires on almost every trivial route. The mod's handoff-based escalation is the real signal. |
| `q-learning-router.ts` | Routing is a one-step decision, so Q-learning's discount and next-state machinery mean nothing here. It starts at ε = 1.0, which means random routes while it learns. |
| Neural / KNN / KRR hybrid, `router-calibrator.ts` | Needs embeddings and trained artifacts. The calibrator only corrects that model's scores. |
| OpenRouter provider switching | Would send tasks to non-Anthropic providers. Out of scope, and data leaves the account. |
| A/B recorder, trajectory log, `learningHistory` | Writes prompt text to disk. |
| `priorsById` shadow state | Never read by their selector. Dead weight. |
| Circuit breaker | Covered by the decayed bandit plus escalation. |
| `ruflo-mods` `routeTask` | Picks an agent *type*, not a model, by first match. Weaker than this mod's tiers. |
| `learned-routing.ts` keyword miner | Its scoring is sound, but it needs task words stored on disk. Possible later as an opt-in `/router suggest` that proposes rule-file keywords for the user to approve. Not in this plan. |
| Hard stop (deny spawns at 100%) | Blocks work with no clear way out. The rate limit stops the session anyway. |

### Security issues in the parts we take, and the fix for each

| # | Issue in ruflo | Fix in this port | Task |
|---|---|---|---|
| S1 | State is read from `process.cwd()/.swarm/…`, so a cloned repo can ship a poisoned router state. | State lives only at `~/.claude/model-router-state.json` and is never read from the project. | 6, 8 |
| S2 | Load is `{ ...defaults, ...loaded }` with no validation. NaN or negative shapes poison sampling; the source admits this for `priorDecay`. | `parse()` keeps only known buckets and models, and only numbers that are finite and within `[1, 1000]`. Lookups use `Object.hasOwn`. | 6 |
| S3 | Unlocked read-modify-write loses concurrent increments (ruflo #4217). | Each outcome re-reads the file and applies itself as a delta. Writes in one process are serialized on a promise chain. | 7, 8 |
| S4 | A torn or foreign file is overwritten with defaults, wiping all learning. | A file that exists but won't parse, or has another version, is **never overwritten**. Learning continues in memory, `/router learn` names the problem, and `/router learn reset` is the explicit way out. | 7, 9 |
| S5 | Prompt text is persisted (`learningHistory.task.slice(0,100)`). | Only counts are stored: bucket → model → {alpha, beta}. A test asserts that. | 6 |
| S6 | Reward sign and range bug (audit bug #1: `-r -1.0` recorded as +1.0). | Outcomes are a boolean set by the mod itself, never a parsed number. | 4, 8 |
| S7 | Poisoning by behaviour: a haiku scraper fed hostile page text can be steered into writing `## ESCALATION HANDOFF`, which teaches "haiku fails here". | A per-load cap of 3 counted outcomes per bucket, so one session can't reach `MIN_EVIDENCE` alone. Moves are limited to one tier, never above the session's model, and only for tasks the router placed by its words. Decay heals it, and reset clears it. | 5, 8 |
| S8 | Rule files reach the object prototype. This one is in this mod, found while reviewing: `prices.__proto__` re-prototypes the price table, and agent type `toString` resolves to `Function`. | Null-prototype records in `merge()`, and `Object.hasOwn` for `TIER_OF_AGENT`. | 2 |
| S9 | Unbounded sampling loop on a bad `random` (NaN never meets the accept test). | Rejection loop capped at 1000 iterations. A test drives it with `() => NaN`. | 3 |

Not applicable, because none of that code is taken: MCP loopback CSRF (#4226), witness re-signing (#4201), `Bash(node .claude/*)` permission (#4205).

---

## Flow

```
agent.spawn(e)
   |
   v
[paused?] --yes--> next(e) untouched
   |
   no
   v
[judge(e, rules)] --fork / named model / rule-file pin / fixed type--> keep as today (not learnable)
   |
 placed by words, classifier or fallback  (isLearnable)
   v
[tier -> modelFor(tier, parent)] --would outrank parent--> next(e) untouched
   |
   v
bucket = fallback ? 'open' : tier
   |
   v
[learning = off?] --yes------------------------------------+
   |                                                       |
   no                                                      |
   v                                                       |
[storeOf($)] --no home / unreadable / bad version--> memory-only arms (fresh)
   |                                                       |
   v                                                       |
[choose()]                                                 |
   |- own arm evidence >= 5 and sampled p < ratio(model, senior)
   |        --> senior   "learned: X escalates these"      |
   |- junior arm evidence >= 5 and sampled p > ratio + 0.15
   |        --> junior   "learned: J handles these"        |
   |- junior arm thin and this is the 10th placed task (on + escalate)
   |        --> junior   "probe: trying J"                 |
   '- else  --> rules' model                               |
   |                                                       |
[mode shadow?] --yes--> keep rules' model, reason += "; learned would pick M"
   |                                                       |
   v                                                       v
[budget rung] --critical, or tight and bucket=open--> one tier down "; rate limit R"
   |
   v
next({...e, model, prompt + protocol(senior)})  --> live.set(id, {..., bucket})

turn.complete(agentId)
   |
   v
[live run with bucket?] --no--> today's behaviour only
   |
  yes
   v
[reason = answer?] --aborted / refusal / error--> record nothing (says nothing about the model)
   |
  yes
   v
success = no handoff in answer
   |
   v
[bucket cap reached this load (3)?] --yes--> record nothing
   |
   no
   v
memory: observe(bucket, model, success)
   |
[file trusted?] --no--> memory only
   |
  yes
   v
re-read file --gone/unreadable now--> memory only + toast once
   |
   v
observe on the file's current arms (keeps other sessions' writes) --> write
   |                                                     |
   ok                                              write fails --> memory only + toast once
   v
memory = merged state
   |
   v
(then today's escalation / senior hand-back as before;
 the senior run carries the same bucket, so its answer counts for the senior model)

session.measure(e)
   |
   v
rung = max(percentUsed over windows) -> ok <75 | tight >=75 | critical >=90
   |
[rung above the last announced rung?] --yes--> toast once; back to ok re-arms
```

## File map

| File | Change | Responsibility |
|---|---|---|
| `hooks/route.ts` | modify | Whole-word rule keywords, `isLearnable` on `Verdict`, `juniorOf`, `hasOwn` on fixed agent types |
| `hooks/rules.ts` | modify | Null-prototype records in `merge`, `ratioOf(rules)` price ratio |
| `hooks/bandit.ts` | create | Pure: Beta sampling, `observe` with decay, `evidenceOf`, `choose` |
| `hooks/learnstore.ts` | create | Pure-ish: `parse`, `serialize`, `open`, `record`, `reset`, `describe` over an injected `Files` |
| `hooks/budget.ts` | create | Pure: `rungOf`, `isRaised`, `shiftsDown` |
| `hooks/register.tsx` | modify | Wire learning, budget, `/router learn` |
| `.claude-plugin/plugin.json` | modify | `learning`, `budgetShift` options; version 0.3.0 |
| `tests/bandit.test.ts` | create | bandit unit tests |
| `tests/learnstore.test.ts` | create | store unit tests |
| `tests/budget.test.ts` | create | budget unit tests |
| `tests/router.test.ts` | modify | keyword, prototype, ratio, and hook-level learning tests |
| `THIRD_PARTY_NOTICES.md` | create | MIT notice for the copied sampler |
| `README.md` | modify | Learned routing, rate-limit shift, `/router learn` |

Baseline before starting: `claude plugin test .` → `15 pass, 0 fail`.

---

## Task 0: Spike — the harness can fake disk and env

- [ ] **Step 1:** Add to `tests/router.test.ts` temporarily:

```ts
test('spike: fs and env hooks answer $.fs and $.env', async ($, on) => {
  on('env.get', (_, e) => (e.name === 'USERPROFILE' ? 'C:/home' : undefined))
  on('fs.exists', (_, e) => e.path === 'C:/home/x')
  on('fs.read', () => 'hello')
  on('fs.write', () => undefined)
  expect(await $.env.get('USERPROFILE')).toBe('C:/home')
  expect(await $.fs.exists('C:/home/x')).toBe(true)
  expect(await $.fs.read('C:/home/x')).toBe('hello')
})
```

- [ ] **Step 2:** Run `claude plugin test .`. Expected: `16 pass`.
- [ ] **Step 3:** If it fails, change `learnstore.open/record/reset` callers in Task 8 to accept a `Files` passed through a module-level `let filesFor = ($) => …` that tests replace, and note it in the README's Development section. Otherwise delete the spike test. No commit.

## Task 1: Rule-file keywords match whole words (fixes `adr` → "address")

- [ ] **Step 1: Failing test** in `tests/router.test.ts`:

```ts
test('a rule-file keyword matches whole words only', () => {
  const { rules } = merge(defaults(), JSON.stringify({ keywords: { architect: ['adr', 'wire up'] } }))
  expect(judge(task({ prompt: 'Look up the address' }), rules).tier).toBe('scout')
  expect(judge(task({ prompt: 'Write an ADR for the queue' }), rules).tier).toBe('architect')
  expect(judge(task({ prompt: 'Look up the wire uploader' }), rules).tier).toBe('scout')
})
```

- [ ] **Step 2:** Run `claude plugin test .`. Expected: FAIL. The first assert gets `architect`.
- [ ] **Step 3: Code.** In `hooks/route.ts`, replace `hits`:

```ts
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** A rule-file phrase as a pattern that finds it only as whole words: `adr` finds "adr" but not "address". */
export const wordPattern = (phrase: string) =>
  new RegExp(`(?<![a-z0-9])${escape(phrase)}(?![a-z0-9])`)

const patterns = new Map<string, RegExp>()
const patternOf = (phrase: string) => {
  const known = patterns.get(phrase)
  if (known !== undefined) return known
  const made = wordPattern(phrase)
  patterns.set(phrase, made)

  return made
}

const hits = (text: string, tier: Tier, rules?: Rules) =>
  SIGNALS[tier].filter(signal => signal.test(text)).length +
  (rules?.keywords[tier].filter(word => patternOf(word).test(text)).length ?? 0)
```

- [ ] **Step 4:** Run `claude plugin test .`. Expected: all pass.
- [ ] **Step 5:** `git commit -am "Match rule-file keywords as whole words"`

## Task 2: Rule files cannot reach the object prototype (S8)

- [ ] **Step 1: Failing test:**

```ts
test('a rule file cannot reach the object prototype', () => {
  const { rules } = merge(
    defaults(),
    '{"agents":{"__proto__":"haiku"},"prices":{"__proto__":{"input":0,"output":0}}}',
  )
  expect(Object.getPrototypeOf(rules.prices)).toBe(null)
  expect(judge(task({ subagentType: 'toString', prompt: 'Scrape the web' }), rules).tier).toBe(undefined)
  expect(judge(task({ subagentType: 'constructor', prompt: 'Scrape the web' })).tier).toBe(undefined)
})
```

- [ ] **Step 2:** Run. Expected: FAIL on the prototype assert.
- [ ] **Step 3: Code.** In `hooks/rules.ts`:

```ts
/** A record with no prototype, so a key like `__proto__` or `toString` is only ever a key. */
const bare = <T>(from: Record<string, T>): Record<string, T> =>
  Object.assign(Object.create(null) as Record<string, T>, from)

export const defaults = (): Rules => ({
  agents: bare({}),
  keywords: { scout: [], builder: [], architect: [] },
  prices: bare(PRICES),
})
```

In `merge`, build `rules` with `agents: bare(base.agents)` and `prices: bare(base.prices)`.

In `hooks/route.ts` `judge`, replace the `fixed` line:

```ts
  const fixed = Object.hasOwn(TIER_OF_AGENT, task.subagentType) ? TIER_OF_AGENT[task.subagentType] : undefined
```

and the `ruled` line:

```ts
  const ruled = rules !== undefined && Object.hasOwn(rules.agents, task.subagentType) ? rules.agents[task.subagentType] : undefined
```

- [ ] **Step 4:** Run. Expected: all pass.
- [ ] **Step 5:** `git commit -am "Keep rule-file keys off the object prototype"`

## Task 3: Beta sampling (ported) with a loop guard (S9)

- [ ] **Step 1: Failing test** in a new file, `tests/bandit.test.ts`:

```ts
import { expect, test } from 'claude-code/testing'

import { sampleBeta } from '../hooks/bandit'

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
```

- [ ] **Step 2:** Run. Expected: FAIL, because `../hooks/bandit` doesn't exist.
- [ ] **Step 3: Code.** Create `hooks/bandit.ts`:

```ts
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
```

- [ ] **Step 4:** Create `THIRD_PARTY_NOTICES.md`:

```markdown
# Third-party notices

`hooks/bandit.ts` adapts `sampleGamma` and `sampleBeta` from ruflo
(https://github.com/ruvnet/ruflo, `v3/@claude-flow/cli/src/ruvector/model-router.ts`).

MIT License

Copyright (c) 2024-2026 ruvnet

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

- [ ] **Step 5:** Run. Expected: all pass.
- [ ] **Step 6:** `git add hooks/bandit.ts tests/bandit.test.ts THIRD_PARTY_NOTICES.md && git commit -m "Add Beta sampling for learned routing"`

## Task 4: Outcomes fade toward the prior (S6)

- [ ] **Step 1: Failing test** (append to `tests/bandit.test.ts`; extend the import with `evidenceOf, observe`):

```ts
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
```

- [ ] **Step 2:** Run. Expected: FAIL, because `observe` isn't exported.
- [ ] **Step 3: Code.** Append to `hooks/bandit.ts`:

```ts
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
```

- [ ] **Step 4:** Run. Expected: all pass.
- [ ] **Step 5:** `git commit -am "Fade learned outcomes toward the prior"`

## Task 5: `choose` moves a route at most one tier, on evidence (S7)

- [ ] **Step 1: Failing test** (append; extend the import with `choose`):

```ts
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
```

- [ ] **Step 2:** Run. Expected: FAIL, because `choose` isn't exported.
- [ ] **Step 3: Code.** Append to `hooks/bandit.ts`:

```ts
/** Outcomes an arm needs before its record can move a route. */
export const MIN_EVIDENCE = 5

/** How far past break-even a cheaper model must look: an escalation costs time as well as tokens. */
export const MARGIN = 0.15

export type Choice = { model: string; reason?: string }

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
 * and must clear MARGIN besides.
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
    return sampleBeta(below, random) > ratio(junior, model) + MARGIN
      ? { model: junior, reason: `learned: ${junior} handles these` }
      : { model }
  }

  return probe ? { model: junior, reason: `probe: trying ${junior}` } : { model }
}
```

- [ ] **Step 4:** Run. Expected: all pass. The `alpha: 5, beta: 1` case has evidence 4, below `MIN_EVIDENCE`.
- [ ] **Step 5:** `git commit -am "Choose a learned tier one step from the rules"`

## Task 6: State file parse and serialize (S1, S2, S5)

- [ ] **Step 1: Failing test** in a new file, `tests/learnstore.test.ts`:

```ts
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
        __proto__: { haiku: { alpha: 2, beta: 2 } },
        nonsense: { haiku: { alpha: 2, beta: 2 } },
      },
    }),
  )
  expect('learned' in read).toBe(true)
  if (!('learned' in read)) return
  expect(read.learned.builder).toEqual({ haiku: { alpha: 4, beta: 2 } })
  expect(read.learned.scout).toEqual({})
  expect(Object.keys(read.learned)).toEqual(['scout', 'builder', 'architect', 'open'])
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
```

- [ ] **Step 2:** Run. Expected: FAIL, because the module is missing.
- [ ] **Step 3: Code.** Create `hooks/learnstore.ts`:

```ts
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
```

- [ ] **Step 4:** Run. Expected: all pass.
- [ ] **Step 5:** `git add hooks/learnstore.ts tests/learnstore.test.ts && git commit -m "Parse and write the learned-routing state"`

## Task 7: Open, record, reset (S3, S4)

- [ ] **Step 1: Failing test** (append to `tests/learnstore.test.ts`; extend the import with `open, record, reset, describe` and `type Files`):

```ts
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
```

- [ ] **Step 2:** Run. Expected: FAIL, because `open` isn't exported.
- [ ] **Step 3: Code.** Append to `hooks/learnstore.ts`:

```ts
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
```

- [ ] **Step 4:** Run. Expected: all pass.
- [ ] **Step 5:** `git commit -am "Keep the learned record in a trusted user-level file"`

## Task 8: Wire learning into the router

- [ ] **Step 1: Failing tests** (append to `tests/router.test.ts`; add `import type { On } from 'claude-code'`, extend the imports with `ratioOf` from `../hooks/rules` and `serialize, fresh, parse` from `../hooks/learnstore`):

```ts
const STATE = 'C:/home/.claude/model-router-state.json'

/** A fake home folder and disk under the router's `$.env` and `$.fs`. */
const disk = (on: On, files: Map<string, string>) => {
  on('env.get', (_, e) => (e.name === 'USERPROFILE' ? 'C:/home' : undefined))
  on('fs.exists', (_, e) => files.has(e.path))
  on('fs.read', (_, e) => {
    const text = files.get(e.path)
    if (text === undefined) throw new Error('ENOENT')

    return text
  })
  on('fs.write', (_, e) => {
    files.set(e.path, e.text)
  })
}

const routed = (on: On) => {
  const seen: (string | undefined)[] = []
  on('agent.spawn', (_, e) => {
    seen.push(e.model)

    return { model: e.model ?? e.parentModel, agentId: `agent_${seen.length}` }
  })

  return seen
}

const learned = (buckets: Partial<ReturnType<typeof fresh>>) =>
  new Map([[STATE, serialize({ ...fresh(), ...buckets })]])

test('prices give the break-even ratio', () => {
  expect(ratioOf(defaults())('haiku', 'sonnet')).toBe(0.5)
  expect(ratioOf(merge(defaults(), '{"prices":{"sonnet":{"input":4,"output":20}}}').rules)('haiku', 'sonnet')).toBe(0.25)
})

test('a record moves a placed task down a tier', async ($, on) => {
  disk(on, learned({ builder: { haiku: { alpha: 31, beta: 1 } } }))
  const seen = routed(on)
  await $.agent.spawn(task({ description: 'Build parser', prompt: 'Implement the parser' }))
  expect(seen).toEqual(['haiku'])
  expect((await $.command.run(REPORT)).text).toContain('learned: haiku handles these')
})

test('a record moves a placed task up a tier, within the session model', async ($, on) => {
  disk(on, learned({ builder: { sonnet: { alpha: 1, beta: 31 } } }))
  const seen = routed(on)
  await $.agent.spawn(task({ prompt: 'Implement the parser' }))
  await $.agent.spawn(task({ parentModel: SONNET, prompt: 'Implement the parser' }))
  expect(seen).toEqual(['opus', 'sonnet'])
})

test('shadow learning keeps the rules and says what it would pick', { options: { learning: 'shadow' } }, async ($, on) => {
  disk(on, learned({ builder: { haiku: { alpha: 31, beta: 1 } } }))
  const seen = routed(on)
  await $.agent.spawn(task({ prompt: 'Implement the parser' }))
  expect(seen).toEqual(['sonnet'])
  expect((await $.command.run(REPORT)).text).toContain('learned would pick haiku')
})

test('a pinned or fixed agent is never learned', async ($, on) => {
  disk(on, learned({ scout: { haiku: { alpha: 1, beta: 31 } } }))
  const seen = routed(on)
  await $.agent.spawn(task({ subagentType: 'Explore', prompt: 'Find the config' }))
  expect(seen).toEqual(['haiku'])
})

test('answers and handoffs are written to the record', async ($, on) => {
  const files = new Map<string, string>()
  disk(on, files)
  routed(on)
  on('turn.complete', (_, e) => ({ text: e.answer }))

  await $.agent.spawn(task({ prompt: 'Fix the retry test' }))
  await $.turn.complete(ended('agent_1', STUCK, SONNET))
  // The senior's hand-back submits a prompt the harness has no hook for; the
  // record is written before that, so only the record is checked here.
  await $.turn.complete(ended('agent_2', 'Fixed: the clock was never advanced.', OPUS)).catch(() => undefined)

  const saved = parse(files.get(STATE) ?? '')
  expect('learned' in saved).toBe(true)
  if (!('learned' in saved)) return
  expect(saved.learned.builder.opus).toEqual({ alpha: 2, beta: 1 })
  expect((saved.learned.builder.sonnet?.beta ?? 0) > 1.9).toBe(true)
})

test('one load counts at most three outcomes per bucket', async ($, on) => {
  const files = new Map<string, string>()
  disk(on, files)
  routed(on)
  on('turn.complete', (_, e) => ({ text: e.answer }))
  for (let i = 1; i <= 4; i++) {
    await $.agent.spawn(task({ prompt: 'Implement the parser' }))
    await $.turn.complete(ended(`agent_${i}`, 'Done.', SONNET))
  }
  const saved = parse(files.get(STATE) ?? '')
  const sonnet = 'learned' in saved ? saved.learned.builder.sonnet : undefined
  expect(sonnet !== undefined && Math.abs(sonnet.alpha - 1 - (1 + 0.97 + 0.97 ** 2)) < 1e-9).toBe(true)
})

test('an untrusted record file is left alone', async ($, on) => {
  const files = new Map([[STATE, 'garbage']])
  disk(on, files)
  routed(on)
  on('turn.complete', (_, e) => ({ text: e.answer }))
  await $.agent.spawn(task({ prompt: 'Implement the parser' }))
  await $.turn.complete(ended('agent_1', 'Done.', SONNET))
  expect(files.get(STATE)).toBe('garbage')
  expect((await $.command.run({ ...REPORT, args: 'learn' })).text).toContain('not valid JSON')
  await $.command.run({ ...REPORT, args: 'learn reset' })
  expect(parse(files.get(STATE) ?? '')).toEqual({ learned: fresh() })
})

test('every tenth placed task in a bucket probes the tier below', async ($, on) => {
  const seen = routed(on)
  for (let i = 0; i < 10; i++) await $.agent.spawn(task({ prompt: 'Implement the parser' }))
  expect(seen.filter(model => model === 'haiku').length).toBe(1)
  expect(seen[9]).toBe('haiku')
})

test('no probe without an escalation to catch it', { options: { escalate: false } }, async ($, on) => {
  const seen = routed(on)
  for (let i = 0; i < 10; i++) await $.agent.spawn(task({ prompt: 'Implement the parser' }))
  expect(seen.includes('haiku')).toBe(false)
})
```

- [ ] **Step 2:** Run. Expected: FAIL. The options are unknown, and `ratioOf` and the learning don't exist yet.
- [ ] **Step 3: Code — `hooks/rules.ts`.** Append:

```ts
/** What `cheap` costs as a share of `dear`, by input price; 0.5 where either has no price. */
export const ratioOf = (rules: Rules) => (cheap: string, dear: string) => {
  const a = rules.prices[cheap]?.input
  const b = rules.prices[dear]?.input

  return a === undefined || b === undefined || b <= 0 ? 0.5 : Math.min(1, Math.max(0, a / b))
}
```

- [ ] **Step 4: Code — `hooks/route.ts`.** Add `isLearnable` to `Verdict`:

```ts
export type Verdict = {
  /** The tier the rules placed the task in; absent when they left it alone or found no signal. */
  tier?: Tier
  /** True when the task is the router's to place and no rule placed it. */
  isOpen: boolean
  /** True when the router placed it by its words or will by fallback: the only routes learning may move. */
  isLearnable: boolean
  reason: string
}
```

In `judge`, every early return (fork, named model, rule file, fixed type, own definition) gets `isLearnable: false`. The three word returns and the `no signal` return get `isLearnable: true`. Then add below `seniorOf`:

```ts
/** The model one tier below, for a probe or a learned route; undefined at the bottom. */
export const juniorOf = (model: string) =>
  TIERS.map(tier => MODEL_OF[tier]).find(one => rank(one) === rank(model) - 1)
```

- [ ] **Step 5: Code — `.claude-plugin/plugin.json`.** Add to `userConfig` and set `"version": "0.3.0"`:

```json
    "learning": {
      "type": "string",
      "title": "Learned routing",
      "description": "on: each bucket's record of answers and escalations can move a task one tier, and every 10th placed task tries the tier below. shadow: the record is kept and the report says what it would pick. off: rules only.",
      "options": ["on", "shadow", "off"],
      "default": "on"
    },
    "budgetShift": {
      "type": "boolean",
      "title": "Rate-limit downshift",
      "description": "Past 75% of a rate-limit window, tasks with no signal run one tier down; past 90%, every task the router places by its words does.",
      "default": true
    }
```

- [ ] **Step 6: Code — `hooks/register.tsx`.** Imports:

```tsx
import { choose } from './bandit'
import { STATE_FILE, describe, open, record, reset } from './learnstore'
import type { Bucket, Files, Store } from './learnstore'
import { MODEL_OF, TIERS, judge, juniorOf, modelFor, seniorOf, tierOfModel } from './route'
import { costOf, defaults, merge, ratioOf, tokensOf } from './rules'
```

Constants below `RULE_FILE`:

```tsx
/** Every Nth placed task in a bucket may try the tier below while that tier has too little record. */
const PROBE_EVERY = 10
/** Outcomes one load of the mod may add per bucket: no single session can build a record alone. */
const SESSION_CAP = 3
```

Add `bucket?: Bucket` to `Live`. Replace the home lookup in `load` with a shared helper at module level, under `let loaded`:

```tsx
const homeOf = async ($: EngineInterface) =>
  (await $.env.get('USERPROFILE').catch(() => undefined)) ??
  (await $.env.get('HOME').catch(() => undefined))

const filesOf = ($: EngineInterface): Files => ({
  exists: path => $.fs.exists(path),
  read: async path => String(await $.fs.read(path)),
  write: (path, text) => $.fs.write(path, text),
})
```

The learning state goes **inside `register`**, before the first `on(...)`. Each load, and each test, must start with fresh counters and a freshly read record. At module level, `placed` and the cached `store` would carry over from one test to the next.

```tsx
let store: Promise<Store> | undefined
let writing: Promise<unknown> = Promise.resolve()
const placed = new Map<Bucket, number>()
const counted = new Map<Bucket, number>()

const storeOf = ($: EngineInterface) =>
  (store ??= homeOf($).then(home => open(filesOf($), home === undefined ? '' : `${home}/${STATE_FILE}`)))

/** Counts a run's outcome, one write at a time, within the per-load cap. */
const learn = async ($: EngineInterface, bucket: Bucket, model: string, isSuccess: boolean) => {
  const count = counted.get(bucket) ?? 0
  if (count >= SESSION_CAP) return
  counted.set(bucket, count + 1)
  writing = writing
    .then(async () => {
      const before = await storeOf($)
      const after = await record(filesOf($), before, bucket, model, isSuccess)
      store = Promise.resolve(after)
      if (before.isWritable && !after.isWritable) {
        $.ui.toast(`router: learning stays in memory (${after.problem ?? 'unknown'})`)
      }
    })
    .catch(() => undefined)
  await writing
}
```

`load` begins with `const home = await homeOf($)`. In `register`, read the options:

```tsx
  const learning = options.learning === 'off' || options.learning === 'shadow' ? options.learning : 'on'
```

Replace the `agent.spawn` handler from `const model = tier === undefined ? …` down to `const senior =` with:

```tsx
    let model = tier === undefined ? undefined : modelFor(tier, e.parentModel)
    if (model === undefined) return next(e)

    // Only what the router placed by its words, or by fallback, learns: a rule
    // file, a fixed agent type or a named model is someone's choice.
    const bucket: Bucket | undefined =
      !verdict.isLearnable || tier === undefined ? undefined : reason === 'fallback' ? 'open' : tier

    if (bucket !== undefined && learning !== 'off') {
      const seen = (placed.get(bucket) ?? 0) + 1
      placed.set(bucket, seen)
      const pick = choose({
        model,
        junior: juniorOf(model),
        senior: seniorOf(model, e.parentModel),
        arms: (await storeOf($)).learned[bucket],
        ratio: ratioOf(rules),
        probe: learning === 'on' && hasEscalation && seen % PROBE_EVERY === 0,
        random: Math.random,
      })
      if (learning === 'on' && pick.reason !== undefined) {
        model = pick.model
        reason = pick.reason
      } else if (pick.model !== model) {
        reason = `${reason}; learned would pick ${pick.model}`
      }
    }
```

Add `bucket` to the junior's `live.set({...})`, and `bucket: one.bucket` to the senior's `live.set({...})`. In `turn.complete`, directly after `const status = …`:

```tsx
    // An answer is a success, a handoff a failure; an interrupt, a refusal or
    // an API error says nothing about the model.
    if (one.bucket !== undefined && learning !== 'off' && e.reason === 'answer') {
      await learn($, one.bucket, one.model, handoff === undefined)
    }
```

- [ ] **Step 7:** Run `claude plugin test .`. Expected: all pass. The old tests still pass, because cold start without a record equals the rules and the first probe is the tenth task.
- [ ] **Step 8:** Run `claude plugin validate .`. Expected: valid.
- [ ] **Step 9:** `git commit -am "Learn each bucket's tier from answers and escalations"`

## Task 9: `/router learn` and `/router learn reset`

The tests for this are already in Task 8 ("an untrusted record file is left alone"). If they passed there, it's because this step landed with it. Otherwise:

- [ ] **Step 1:** In the `command.run` handler, before the `reload`/`rules` branch:

```tsx
    if (arg === 'learn' || arg === 'learn reset') {
      if (arg === 'learn reset') {
        const home = await homeOf($)
        store = Promise.resolve(await reset(filesOf($), home === undefined ? '' : `${home}/${STATE_FILE}`))
      }

      return {
        text: [
          `Learning is ${learning}${learning === 'on' ? `, probing every ${PROBE_EVERY}th placed task while escalation is on` : ''}.`,
          'Success rate per bucket and model, with the outcomes it rests on (older ones fade):',
          ...describe(await storeOf($)),
        ].join('\n'),
      }
    }
```

Change the command description to `'Model routing: report, \`pane\`, \`on\`, \`off\`, \`rules\`, \`reload\`, \`learn\`, \`learn reset\`'`. In the main report's options line, add `learning ${learning}`.

- [ ] **Step 2:** Run. Expected: all pass.
- [ ] **Step 3:** `git commit -am "Show and reset the learned record"`

## Task 10: Rate-limit ladder (pure)

- [ ] **Step 1: Failing test** in a new file, `tests/budget.test.ts`:

```ts
import { expect, test } from 'claude-code/testing'

import { isRaised, rungOf, shiftsDown } from '../hooks/budget'

test('the fullest window sets the rung', () => {
  expect(rungOf([])).toBe('ok')
  expect(rungOf([{ percentUsed: 74.9 }])).toBe('ok')
  expect(rungOf([{ percentUsed: 20 }, { percentUsed: 75 }])).toBe('tight')
  expect(rungOf([{ percentUsed: 90 }])).toBe('critical')
  expect(rungOf([{ percentUsed: Number.NaN }])).toBe('ok')
})

test('tight shifts only unplaced tasks, critical every placed one', () => {
  expect(shiftsDown('tight', 'open')).toBe(true)
  expect(shiftsDown('tight', 'builder')).toBe(false)
  expect(shiftsDown('critical', 'builder')).toBe(true)
  expect(shiftsDown('ok', 'open')).toBe(false)
  expect(isRaised('ok', 'tight')).toBe(true)
  expect(isRaised('critical', 'tight')).toBe(false)
})
```

- [ ] **Step 2:** Run. Expected: FAIL, because the module is missing.
- [ ] **Step 3: Code.** Create `hooks/budget.ts`:

```ts
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
```

- [ ] **Step 4:** Run. Expected: all pass.
- [ ] **Step 5:** `git add hooks/budget.ts tests/budget.test.ts && git commit -m "Add the rate-limit ladder"`

## Task 11: Wire the ladder

- [ ] **Step 1: Failing test** (append to `tests/router.test.ts`):

```ts
const measure = (percentUsed: number) => ({
  context: { window: 200_000 },
  rateLimits: [{ kind: 'five_hour', percentUsed }],
  changed: ['rateLimits' as const],
})

test('a nearly spent window moves placed tasks a tier down', async ($, on) => {
  const seen = routed(on)
  on('session.measure', (_, e) => ({ changed: e.changed }))
  await $.session.measure(measure(80))
  await $.agent.spawn(task({ prompt: 'Handle it.' }))
  await $.agent.spawn(task({ prompt: 'Implement the parser' }))
  await $.session.measure(measure(95))
  await $.agent.spawn(task({ prompt: 'Implement the parser' }))
  await $.agent.spawn(task({ subagentType: 'Plan', prompt: 'Plan it' }))
  expect(seen).toEqual(['haiku', 'sonnet', 'haiku', 'opus'])
})

test('the downshift can be turned off', { options: { budgetShift: false } }, async ($, on) => {
  const seen = routed(on)
  on('session.measure', (_, e) => ({ changed: e.changed }))
  await $.session.measure(measure(95))
  await $.agent.spawn(task({ prompt: 'Implement the parser' }))
  expect(seen).toEqual(['sonnet'])
})
```

- [ ] **Step 2:** Run. Expected: FAIL. The first test gets `sonnet` where it expects `haiku`.
- [ ] **Step 3: Code — `hooks/register.tsx`.** Import:

```tsx
import { CRITICAL, TIGHT, isRaised, rungOf, shiftsDown } from './budget'
import type { Rung } from './budget'
```

State beside `placed`, inside `register`:

```tsx
let rung: Rung = 'ok'
let told: Rung = 'ok'
```

In `register`: `const hasBudgetShift = options.budgetShift !== false`. In `agent.spawn`, directly after the learning block:

```tsx
    // Last, so a learned move up never outlasts a nearly spent window.
    if (bucket !== undefined && hasBudgetShift && shiftsDown(rung, bucket)) {
      const lower = juniorOf(model)
      if (lower !== undefined) {
        model = lower
        reason = `${reason}; rate limit ${rung}`
      }
    }
```

A new hook:

```tsx
  on('session.measure', async ($, e, next) => {
    const result = await next(e)
    if (!hasBudgetShift) return result
    rung = rungOf(e.rateLimits)
    if (rung === 'ok') told = 'ok'
    if (isRaised(told, rung)) {
      told = rung
      $.ui.toast(
        rung === 'critical'
          ? `router: a rate-limit window is past ${CRITICAL}%; every placed task runs a tier down`
          : `router: a rate-limit window is past ${TIGHT}%; tasks with no signal run a tier down`,
      )
    }

    return result
  })
```

- [ ] **Step 4:** Run. Expected: all pass.
- [ ] **Step 5:** `git commit -am "Route a tier down when a rate-limit window is nearly spent"`

## Task 12: Docs, final checks

- [ ] **Step 1:** In `README.md`, after "Escalation handoff", add:

```markdown
## Learned routing

The rules still place every task. The mod then keeps a record, per bucket (`scout`, `builder`, `architect`, and `open` for fallback tasks), of how each model did: an answer counts as a success, an escalation handoff as a failure. Interrupts, refusals and API errors count for nothing.

- Once a model has about five outcomes in a bucket, the record can move a task **one tier**: down when the cheaper model succeeds often enough to pay for its escalations (by the price table, plus a 15-point margin), up when the rules' model escalates so often that going straight to the senior is cheaper. Never above the session's model.
- Every 10th placed task in a bucket tries the tier below while that tier has too little record, and only while escalation is on to catch it.
- Old outcomes fade (about the last 33 count), so the record follows model changes.
- Rule-file pins, `Explore`/`Plan`, custom agents and calls that name a model are never moved.
- One load of the mod adds at most three outcomes per bucket, so a single session, or a subagent tricked by a web page into writing a handoff, cannot build a record on its own.

The record is `~/.claude/model-router-state.json`: counts only, no task text, never read from a project. A file that will not parse, or has a newer version, is left untouched and learning stays in memory; `/router learn` says why and `/router learn reset` starts over.

Set `learning` to `shadow` to keep the record without acting on it (the report says what it would pick), or `off`.

## Rate-limit downshift

Past 75% of a rate-limit window, tasks with no signal run one tier down; past 90%, every task the router places by its words does. Each step is announced once. Turn it off with `budgetShift`.
```

Add `/router learn` and `/router learn reset` rows to the Commands table, and `learning` and `budgetShift` rows to the Options table. Add `hooks/bandit.ts`, `hooks/learnstore.ts` and `hooks/budget.ts` to the Development paragraph. Add a line: "`hooks/bandit.ts` adapts ruflo's Beta sampler under MIT; see `THIRD_PARTY_NOTICES.md`."

- [ ] **Step 2:** `claude plugin validate .` → valid. `claude plugin test .` → all pass, with 0 fail. Expected count: 15 old + 1 + 1 + 2 + 2 + 2 + 3 + 3 + 10 + 2 + 2 = **43**.
- [ ] **Step 3:** Live smoke test in a new session: `/router learn` shows `State: C:\Users\jiang/.claude/model-router-state.json` with empty buckets. Spawn one general-purpose task, let it finish, and run `/router learn` again. Expected: one bucket shows `sonnet 100% of 1.0`.
- [ ] **Step 4:** `git commit -am "Document learned routing and the rate-limit downshift"`. Do **not** push without the user's go-ahead.

---

## Self-review

- **Coverage:** Every row in "Take" maps to a task: sampler → 3, buckets and decay → 4 and 6, cost decision and evidence gate → 5, versioned state → 6 and 7, word boundaries → 1, budget ladder → 10 and 11. Every security row S1–S9 names its task, and each has an asserting test except S1 (path construction, checked by the Task 12 smoke test) and S7's one-tier bound (Task 5 test).
- **Placeholders:** None. Task 0's fallback is concrete, and Task 9 notes that its code may already be in place from Task 8's tests.
- **Names:** `Bucket`/`Files`/`Store` (learnstore), `Arm`/`choose`/`observe`/`evidenceOf`/`sampleBeta` (bandit), `ratioOf` (rules), `juniorOf`/`isLearnable`/`wordPattern` (route), `rungOf`/`isRaised`/`shiftsDown`/`Rung` (budget). They are used the same way in every task.
- **Risk to check during execution:** `$.fs.read` returns `string | FsBytes`. `filesOf` wraps it in `String()`, which is fine for text reads. If the harness answers `fs.read` hooks differently from `$.fs.read`, Task 0 catches it.
- **Open decision for the user:** the `learning` default. The plan ships `on`, which is safe at cold start: it behaves the same as the rules plus one probe in ten. `shadow` is the cautious alternative for the first week.

---

## Execution notes (2026-10-16)

Executed on branch `learned-routing`. Deviations from the plan above:

- **Harness (Task 0):** the test `$` has no `fs`/`env` nouns, so the spike ran through the plugin instead. `fs.*`, `env.get` and `agent.list` hooks must answer `{ value }` (a missing file is `{ deny }`), and paths reach them with backslashes. `disk()` normalizes them.
- **Loader rule:** a function that receives `$` must be declared at the top of the file. `storeOf` and `learn` are therefore top-level and take a per-load `Learning` object, created inside `register`, so state still resets per load and per test.
- **Senior id in tests:** a spawn the plugin makes itself gets no `agentId` from the harness. The record test answers `agent.list` so the senior is followed.
- **Observable failure only (new):** an outcome counts only when the run had a senior to hand over to (`one.senior !== undefined`). Without this, runs with escalation off, teammates and top-of-session runs would record successes only, inflate that model's arm, and pull other buckets down to it. One added test covers it, so the final count is **44**, not 43.
- **No probe for teammates (new):** a teammate has no handoff to catch a probe.
- **Test fix:** the parse test now uses a computed `['__proto__']` key; the literal `__proto__:` set the object's prototype and never reached the JSON.
- **Pre-existing type error fixed:** `status` in `turn.complete` is now annotated `Route['status']`. `tsc --noEmit` is clean.
