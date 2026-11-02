# Learning and ledger fixes

**Goal:** make learned down-moves reachable, give learning a failure signal beyond self-reported escalation, and report savings that are correctly priced and kept across sessions.

**Architecture:** three small pure modules or additions (`hooks/redo.ts`, `hooks/ledger.ts`, a surcharge helper in `hooks/rules.ts`) wired into the existing hooks in `hooks/register.tsx`. The learned record's file format does not change. Counters and the ledger live in `$.store`.

**Tech stack:** TypeScript mods API, `claude plugin test`, `claude plugin validate`.

## Evidence

- Probe every 10 with `DECAY = 0.97` peaks at 3.81 remembered outcomes, under `MIN_EVIDENCE = 5`. Every 5 peaks at 7.08 and stays above 5 between probes.
- `~/.claude/model-router-state.json`: `builder/sonnet` about 24 outcomes, `builder/haiku` about 2.
- `placed` resets per load, so a session with under 10 tasks in a bucket never probes, and `SESSION_CAP = 3` usually drops the 10th task's outcome.
- Past sessions, 213 routable spawns: prompt word overlap alone flags templated batches ("Audit R+RT" vs "Audit T+B", overlap 0.88). Requiring equal descriptions after removing retry words leaves 6 pairs, all real re-dispatches (3%, against 1% escalations).
- Pricing docs: Haiku 5.5 over 100K prompt tokens, counting cache reads and writes, is 5x (input $0.50, output $2.50, cache read $0.05, cache write $0.625). The rate depends on each request, and `turn.complete` only has the sum, so it needs `turn.step`.

## Flow

```
agent.spawn ──> redo check: same parent, same description, prompt overlap >= 0.5?
   │                 │ yes: earlier run -> status "redone", saved = -cost,
   │                 │      learn(failure, cap "redo"), ledger correction
   │                 v
   │            judge -> choose(probe = persisted placed count % 5 == 0)
   │                 │ store unavailable: in-memory count
   v                 v
 run ──> turn.step (each response): haiku and prompt > 100K -> add 4x cost to extras[agent]
   │
   v
turn.complete: cost = costOf(sum) + extras
   ├─ answer, no handoff -> learn(success, cap "plain" or "probe"), remember for redo check
   ├─ handoff            -> learn(failure, same cap), saved = -cost, escalate
   ├─ abort/error        -> no learning
   └─ every end          -> ledger add (store failure: ignored, session tally still shown)

/router savings -> ledger totals; unreadable ledger -> starts empty
```

## Files

| File | Change |
| --- | --- |
| `hooks/bandit.ts` | Export `PROBE_EVERY = 5`; `Choice.isProbe` |
| `hooks/rules.ts` | `longPromptExtra`; fix the "rarely" comment |
| `hooks/redo.ts` (new) | `isRedo`: pure comparison of two tasks |
| `hooks/ledger.ts` (new) | Per-day totals: parse, add, total, describe |
| `hooks/register.tsx` | Persisted probe counter, separate caps, redo check, `turn.step` hook, ledger writes, `/router savings` |
| `types/index.d.ts` | `RouteStatus` gains `redone` |
| `tests/*` | Tests below; the "every tenth" test becomes "every fifth" |
| `README.md`, `.claude-plugin/plugin.json` | Docs, version 0.4.0 |

## Task 1: pricing

- [x] Test in `tests/router.test.ts`: `longPromptExtra` is 0 under 100K, 0 for sonnet over 100K, and 4x `costOf` for haiku over 100K with cache tokens counted.
- [x] Add to `hooks/rules.ts`:

```ts
const LONG_PROMPT = 100_000
const LONG_FACTOR = 5

/** What Haiku 5.5's long-prompt rate adds to one response; a prompt's length counts its cache tokens. */
export const longPromptExtra = (usage: ModelUsage, model: string, rules: Rules) => {
  if (!model.toLowerCase().includes('haiku')) return 0
  const prompt = usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens
  return prompt <= LONG_PROMPT ? 0 : (costOf(usage, model, rules) ?? 0) * (LONG_FACTOR - 1)
}
```

- [x] In `register.tsx`, a `turn.step` generator forwards the stream unchanged and adds `longPromptExtra(response.usage, response.usage.model, rules)` to `extras` for agents in `live`. `turn.complete` adds and clears it. Expected: a test with one long haiku step reports the higher cost.

## Task 2: ledger

- [x] Test: `addTo` sums per day, `parseLedger` returns empty for junk, wrong versions and bad numbers, `describeLedger` gives totals and the first day.
- [x] `hooks/ledger.ts`: `Day = { runs, tokens, cost, base, saved, escalated, redone }`, `Ledger = { version: 1, days: Record<string, Day> }`, under `$.store` key `ledger`. Counts and dollars only, never task text.
- [x] `register.tsx`: each `turn.complete` of a live run adds its delta through one write queue. `/router savings` prints totals; `/router` adds one lifetime line. Store failures are swallowed so routing never depends on them.
- [x] Limit: two sessions writing at the same moment can lose one update. Acceptable for an estimate.

## Task 3: redo signal

- [x] Test `isRedo`: `T3 signin` vs `T3 signin (retry)` with the same prompt is true; `Audit R+RT findings` vs `Audit T+B findings` with near-identical prompts is false; same description with an unrelated prompt is false; prompts under 8 words are false.
- [x] `hooks/redo.ts`:

```ts
const RETRY = /\b(retry|retrying|retried|redo|again|second attempt|2nd attempt)\b/g
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
```

- [x] `register.tsx`: remember the last 30 runs per load that answered with no handoff, had a `senior`, and were not takeovers, with their parent. At `agent.spawn`, before routing and also for calls that name a model, a match under the same parent is removed from the list and counts one failure outcome under its own cap. Its route becomes `redone`, `saved = -cost`, and the ledger is corrected. A run with no senior cannot have been a cheap-model failure, so it is not remembered.
- [x] Tests: a re-dispatch writes a failure to the record and shows `redone`; a parallel call while the first is running does not count; another parent does not count; a third matching spawn does not count the same run twice.

## Task 4: probes

- [x] Test in `tests/bandit.test.ts`: repeated `observe` with one junior outcome per `PROBE_EVERY` keeps `evidenceOf(junior) >= MIN_EVIDENCE` at steady state.
- [x] Test in `tests/router.test.ts`: the 5th placed task probes; a stored count of 4 makes a new load's first task probe; a probe's outcome is written after `SESSION_CAP` plain outcomes.
- [x] `bandit.ts`: `export const PROBE_EVERY = 5`; `choose` returns `isProbe: true` on a probe.
- [x] `register.tsx`: the placed count reads and writes `$.store` key `placed.<bucket>`, falling back to memory. `learn` takes a kind (`plain`, `probe`, `redo`), each capped at 3 per bucket per load. `Live` carries `isProbe`.

## Task 5: docs and checks

- [x] README: learned routing, commands, savings estimate. `plugin.json` 0.4.0.
- [x] `claude plugin validate .` passes and `claude plugin test .` passes in full.

## Risks

- Probing is more frequent: 1 in 5 tasks in the `open` and `architect` buckets run a tier down until the junior has 5 remembered outcomes. That is the intended cost of learning, and it can be stopped with `learning: shadow` or `off`. Decided after review: the `builder` bucket stays on sonnet and is never probed or moved down, and Haiku keeps its default `medium` effort.
- A redo can have causes other than bad work, such as a changed requirement. The equal description and overlap test keeps this rare, and old outcomes fade.
- Not done: routing a detected redo a tier up automatically, and test-failure signals. Neither is needed to fix the record, and both add new behaviour.
