# model-router

A Claude Code mod that runs each subagent on the cheapest model suited to its task, and hands the task to a stronger model when the cheaper one gets stuck.

| Tier | Model | Typical work |
| --- | --- | --- |
| Scout | Haiku | Web lookups, scraping, search, summaries |
| Builder | Sonnet | Implementation, fixes, refactoring, tests |
| Architect | Opus | Architecture, planning, root-cause and security work |

## Installation

Add the mod's folder to the `env` block of `~/.claude/settings.json`. Separate multiple folders with `;` on Windows and `:` elsewhere.

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "/path/to/model-router"
  }
}
```

To load it for a single session, run `claude --plugin-dir /path/to/model-router`.

## Routing

The mod sets a subagent's model before it starts:

- `Explore`, `claude-code-guide` and `statusline-setup` agents run on Haiku, and `Plan` agents run on Opus.
- `general-purpose` and `claude` agents are placed by the words in their prompt. Architecture terms take priority over build terms on a tie, and any build term takes priority over lookup terms.
- A task with no signal words that contains code, such as a fenced block, a stack trace or a `file.ts:12` reference, runs on Sonnet.
- A task with no signal at all runs on the fallback model, which is Sonnet by default.

A subagent never runs above the model of the agent that spawned it. Forks, calls that name a model, and custom agents keep their own model unless a rule file places them.

The mod also asks the main model to delegate self-contained work to subagents. Work the main model does itself runs on the session's model.

## Escalation

A subagent on Haiku or Sonnet is told to stop if it hits a wall, and to end its answer with a `## ESCALATION HANDOFF` report covering what it tried, what it found and where it would look next.

The mod then starts the same agent type one tier up, with the original task and the report, and delivers the result to the main session. A run escalates once.

A worker spawned by another subagent returns its report to that subagent, which re-dispatches the task one tier up.

## Learned routing

The mod records how each model performs in four buckets: `scout`, `builder`, `architect`, and `open` for tasks placed by the fallback.

| Event | Recorded as |
| --- | --- |
| The subagent answers | Success |
| The subagent writes an escalation handoff | Failure |
| The same parent sends the same task again after an answer | Failure |
| An interrupt, refusal or API error | Nothing |
| A run with no higher tier to hand over to | Nothing |

Two tasks count as the same when their descriptions match, ignoring words such as "retry", and at least half of their prompt words overlap.

Once a model has about five outcomes in a bucket, the record can move a task one tier:

- **Up**, when the placed model escalates so often that starting on the senior model costs less. A task never moves above the session's model.
- **Down**, when the cheaper model's success rate covers the cost of its escalations by a 15-point margin and is at least 70%.

Build work stays on its model: the `builder` bucket can move up, but it never moves down and is never probed. In the `open` and `architect` buckets, every fifth placed task tries the tier below while that tier has too little record. Probes run only while escalation is enabled.

Older outcomes fade, so roughly the last 33 outcomes in a bucket count. Each session adds at most three outcomes per bucket for each kind of signal. Rule-file pins, `Explore` and `Plan` agents, custom agents and calls that name a model are never moved.

The record is stored in `~/.claude/model-router-state.json` and contains counts only, with no task text.

## Rate-limit downshift

Past 75% of a rate-limit window, tasks with no signal run one tier down. Past 90%, every task the router places by its words runs one tier down. Each step is announced once.

## Savings estimate

When a routed subagent finishes, the mod prices its tokens on the model it ran on and on the model of the agent that spawned it, and counts the difference as saved. An escalated or repeated run counts as a loss of its full cost. Haiku 5.5's higher rate for prompts over 100,000 tokens is applied per response.

Totals are kept per day across sessions. The figures are estimates at API list prices and assume the stronger model would have used the same number of tokens. On a subscription they represent usage capacity rather than money.

## Commands

| Command | Description |
| --- | --- |
| `/router` | Routing state, per-model tally, estimated savings and the last 15 routes |
| `/router savings` | Savings across all sessions |
| `/router pane` | Opens a live pane of routes with a pause button |
| `/router off`, `/router on` | Pauses or resumes routing for the session |
| `/router rules` | Lists the loaded rule files and any invalid entries |
| `/router reload` | Reads the rule files again |
| `/router learn` | Each model's success rate per bucket and the outcomes behind it |
| `/router learn reset` | Clears the learned record |

The status line shows a running tally and the session's savings.

## Options

Set these in `/config`.

| Option | Default | Description |
| --- | --- | --- |
| `fallback` | `sonnet` | Model for a general task with no signal |
| `classifier` | `rules` | `rules` uses keywords only. `rules+model` asks a small model to label tasks the keywords cannot place |
| `nudge` | on | Asks the main model to delegate self-contained work |
| `escalate` | on | Enables the escalation handoff |
| `learning` | `on` | `on` acts on the record, `shadow` keeps the record and reports what it would pick, `off` uses the rules alone |
| `budgetShift` | on | Enables the rate-limit downshift |

## Rule file

The mod reads `~/.claude/model-router.json`, then `.claude/model-router.json` in the project. The project file takes priority.

```json
{
  "agents": { "my-scraper-agent": "haiku", "my-general-agent": "classify" },
  "keywords": { "scout": ["pricing page"], "architect": ["rfc"] },
  "prices": { "sonnet": { "input": 2, "output": 10 } }
}
```

- `agents` pins an agent type to `haiku`, `sonnet` or `opus`. `classify` routes it by its prompt.
- `keywords` adds whole-word phrases to a tier: `scout`, `builder` or `architect`.
- `prices` replaces a model family's price, in dollars per million tokens.

## Third-party code

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
