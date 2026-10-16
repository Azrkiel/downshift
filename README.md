# model-router

A Claude Code mod that runs each subagent on the cheapest model that fits its task, and brings in a stronger model when the cheaper one gets stuck.

| Tier | Model | Typical work |
| --- | --- | --- |
| Scout | haiku | Web lookups, scraping, search, summaries, `Explore` agents |
| Builder | sonnet | Implementing, fixing, refactoring, tests |
| Architect | opus | Architecture, planning, root-cause and security work, `Plan` agents |

The mods API is early access, so a Claude Code update can change it. Run `claude plugin validate` on this folder after an update.

## Install

Clone the repo, then point Claude Code at the folder.

For one session:

```
claude --plugin-dir /path/to/model-router
```

For every session, add the folder to the `env` block of `~/.claude/settings.json`:

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "/path/to/model-router"
  }
}
```

Separate several folders with `;` on Windows and `:` elsewhere.

## How routing works

The mod hooks `agent.spawn` and sets the subagent's model before it starts.

- `Explore`, `claude-code-guide` and `statusline-setup` agents go to haiku. `Plan` goes to opus.
- `general-purpose` and `claude` agents are placed by the words in their prompt. Architecture words beat build words on a tie, and any build word beats lookup words.
- A task with no signal words but with code in it (a fenced block, a stack trace, `file.ts:12`, a definition) goes to sonnet. The markers are syntax only, so prose such as "what class of animals" never counts.
- A task with no signal at all goes to the fallback model (sonnet by default).
- The router only routes down. A sonnet session never spawns opus.
- Forks, calls that name a `model`, and custom agents are left alone. A custom agent keeps the model in its own definition unless a rule file places it.

## Escalation handoff

A subagent routed to haiku or sonnet gets a short protocol at the end of its prompt. If it hits a wall (the same failure after two different approaches, a root cause it cannot find, a decision it lacks context for), it stops and ends its answer with a `## ESCALATION HANDOFF` report:

- the task as it understood it
- what it did
- the approaches it tried and how each turned out
- what worked, and why
- what went wrong
- its current assessment of the problem
- the challenge it could not get past
- where it would look next
- the state it left behind

The mod then starts the same agent type one tier up (haiku to sonnet, sonnet to opus) with the original task and that report. The senior treats the report as evidence to check, finishes the task, and says which of the junior's findings held up. Its answer is delivered to the main session as a message from the plugin.

A run escalates once, and never above the session's own model.

## Learned routing

The rules still place every task. The mod then keeps a record, per bucket (`scout`, `builder`, `architect`, and `open` for fallback tasks), of how each model did: an answer counts as a success, an escalation handoff as a failure. Interrupts, refusals and API errors count for nothing, and so does a run with nobody above it to hand over to, since it could only ever succeed.

- Once a model has about five outcomes in a bucket, the record can move a task **one tier**: down when the cheaper model succeeds often enough to pay for its escalations (by the price table, plus a 15-point margin, and at least 70% of the time, since every escalation costs a second run's wait), up when the rules' model escalates so often that going straight to the senior is cheaper. Never above the session's model.
- Every 10th placed task in a bucket tries the tier below while that tier has too little record, and only while escalation is on to catch it.
- Old outcomes fade (about the last 33 count), so the record follows model changes.
- Rule-file pins, `Explore`/`Plan`, custom agents and calls that name a model are never moved.
- One load of the mod adds at most three outcomes per bucket, so a single session, or a subagent tricked by a web page into writing a handoff, cannot build a record on its own.

The record is `~/.claude/model-router-state.json`: counts only, no task text, never read from a project. A file that will not parse, or has a newer version, is left untouched and learning stays in memory; `/router learn` says why and `/router learn reset` starts over.

Set `learning` to `shadow` to keep the record without acting on it (the report says what it would pick), or `off`.

## Rate-limit downshift

Past 75% of a rate-limit window, tasks with no signal run one tier down; past 90%, every task the router places by its words does. Each step is announced once. Turn it off with `budgetShift`.

## Commands

| Command | What it does |
| --- | --- |
| `/router` | Routing state, a tally per model, estimated savings, and the last 15 routes |
| `/router pane` | Opens a live pane of routes with a pause button |
| `/router off`, `/router on` | Pauses and resumes routing for the session |
| `/router rules` | Shows the rule files that loaded and any entries they misspell |
| `/router reload` | Reads the rule files again |
| `/router learn` | The learned record: each model's success rate per bucket, and how many outcomes it rests on |
| `/router learn reset` | Starts the learned record over, in the file too |

The status line shows a running tally and the savings total.

## Options

Set these in `/config`.

| Option | Default | Meaning |
| --- | --- | --- |
| `fallback` | `sonnet` | The model for a general task with no signal |
| `classifier` | `rules` | `rules` uses keywords only. `rules+model` asks a small model to label tasks the keywords cannot place |
| `nudge` | on | Asks the main model to delegate self-contained work: a system prompt section, and the Agent tool's "do not spawn agents unless the user asks" rule replaced by that request |
| `escalate` | on | The escalation handoff described above |
| `learning` | `on` | `on`, `shadow` or `off`; see Learned routing |
| `budgetShift` | on | The rate-limit downshift |

Routing only reaches subagents: whatever the main model does itself runs on the session's model. Claude Code's own Agent tool description tells the main model not to spawn agents unless the user asks, and that rule outranks a system prompt section. Before the mod rewrote it, 362 sessions (test runs included) held 19 spawns in all. With `nudge` on, the main model delegates more, and each subagent starts cold. Turn it off to route only the spawns that already happen.

## Rule file

The mod reads `~/.claude/model-router.json`, then `.claude/model-router.json` in the project. The project file wins. See `model-router.example.json`.

```json
{
  "agents": { "my-scraper-agent": "haiku", "my-general-agent": "classify" },
  "keywords": { "scout": ["pricing page"], "architect": ["rfc"] },
  "prices": { "sonnet": { "input": 2, "output": 10 } }
}
```

- `agents` pins an agent type to `haiku`, `sonnet` or `opus`. `classify` routes it by its prompt.
- `keywords` adds phrases to a tier (`scout`, `builder`, `architect`). They match whole words: `adr` finds "ADR" but not "address".
- `prices` replaces a model family's price, in dollars per million tokens.

## Savings estimate

When a routed subagent finishes, the mod prices its tokens on the model it ran on and on the session's model, and counts the difference as saved. An escalated junior counts as a loss of its full cost.

This is an estimate. It assumes the stronger model would have used the same number of tokens.

## Development

```
claude plugin validate .
claude plugin test .
```

`hooks/route.ts` holds the keyword rules, `hooks/handoff.ts` the escalation protocol and senior brief, `hooks/rules.ts` the rule file and prices, `hooks/bandit.ts` the Thompson sampler and the learned choice, `hooks/learnstore.ts` the learned record's file, `hooks/budget.ts` the rate-limit ladder, and `hooks/register.tsx` the hooks, commands and pane.

`hooks/bandit.ts` adapts ruflo's Beta sampler and `hooks/route.ts` freellmapi's code markers, both under MIT; see `THIRD_PARTY_NOTICES.md`.

In tests, `fs.*`, `env.get` and `agent.list` hooks answer `{ value }` (or `{ deny }`), and the plugin's paths reach them with backslashes on Windows. Any function that takes `$` must be declared at the top of its file.

One thing to know before editing the protocol: asking a subagent to report its "thinking" or "reasoning" trips Sonnet 5.5's `reasoning_extraction` safeguard and blocks the run. Ask for what it did, what it found and its assessment instead.
