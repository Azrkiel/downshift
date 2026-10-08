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
- A task with no signal goes to the fallback model (sonnet by default).
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

## Commands

| Command | What it does |
| --- | --- |
| `/router` | Routing state, a tally per model, estimated savings, and the last 15 routes |
| `/router pane` | Opens a live pane of routes with a pause button |
| `/router off`, `/router on` | Pauses and resumes routing for the session |
| `/router rules` | Shows the rule files that loaded and any entries they misspell |
| `/router reload` | Reads the rule files again |

The status line shows a running tally and the savings total.

## Options

Set these in `/config`.

| Option | Default | Meaning |
| --- | --- | --- |
| `fallback` | `sonnet` | The model for a general task with no signal |
| `classifier` | `rules` | `rules` uses keywords only. `rules+model` asks a small model to label tasks the keywords cannot place |
| `nudge` | on | Adds a system prompt section asking the main model to delegate self-contained work |
| `escalate` | on | The escalation handoff described above |

With `nudge` on, the main model delegates more than it otherwise would, and each subagent starts cold. Turn it off to route only the spawns that already happen.

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
- `keywords` adds phrases to a tier (`scout`, `builder`, `architect`).
- `prices` replaces a model family's price, in dollars per million tokens.

## Savings estimate

When a routed subagent finishes, the mod prices its tokens on the model it ran on and on the session's model, and counts the difference as saved. An escalated junior counts as a loss of its full cost.

This is an estimate. It assumes the stronger model would have used the same number of tokens.

## Development

```
claude plugin validate .
claude plugin test .
```

`hooks/route.ts` holds the keyword rules, `hooks/handoff.ts` the escalation protocol and senior brief, `hooks/rules.ts` the rule file and prices, and `hooks/register.tsx` the hooks, commands and pane.

One thing to know before editing the protocol: asking a subagent to report its "thinking" or "reasoning" trips Sonnet 5.5's `reasoning_extraction` safeguard and blocks the run. Ask for what it did, what it found and its assessment instead.
