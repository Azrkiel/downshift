# downshift

**Model routing for Claude Code.**

downshift is a Claude Code mod that runs each subagent on the cheapest model suited to its task, so the same work uses less of your budget or rate limits.

## Install

```
/plugin install downshift --marketplace Azrkiel/downshift-plugin
```

Requires Claude Code 2.1.287 or later.

## Features

- **Automatic model selection:** Sends lookups to Haiku, build work to Sonnet, and architecture and planning to Opus.
- **Escalation:** Hands a stuck task to a stronger model, along with what the first model tried and found.
- **Learned routing:** Adjusts its choices based on how each model has performed on similar work.
- **Rate-limit protection:** Moves tasks to cheaper models as you approach a rate limit.
- **Savings tracking:** Estimates what routing has saved, for the current session and across all sessions.
- **Live view:** Shows each route as it happens in a side pane, with a button to pause routing.
- **Custom rules:** Lets you pin agents to a model, add your own keywords and set your own prices.
- **Configurable:** Lets you turn escalation, learning, delegation prompts and rate-limit protection on or off.

## How it works

1. **Claude starts a subagent.** downshift encourages Claude to delegate self-contained work, so more of it can run on cheaper models.
2. **downshift picks a model.** It looks at the agent type and the wording of the task, then chooses the cheapest model that fits. A subagent never runs on a stronger model than the agent that started it.
3. **The subagent does the work.** If it gets stuck, it writes up what it tried and found, and the next model up takes over from there.
4. **downshift records the result.** A finished task counts in the model's favor. An escalation, or the same task being sent again, counts against it.
5. **Future tasks benefit.** Work moves to a stronger model when a model keeps struggling with it, and to a cheaper model when that model proves reliable. Build work stays on Sonnet or above unless you are close to a rate limit.

## Commands

| Command | What it does |
|---|---|
| `/downshift` | Shows the current status and recent routes |
| `/downshift savings` | Shows estimated savings across all sessions |
| `/downshift pane` | Opens the live view |
| `/downshift on`, `/downshift off` | Resumes or pauses routing |
| `/downshift rules`, `/downshift reload` | Shows or reloads the rule files |
| `/downshift learn`, `/downshift learn reset` | Shows or clears the learned record |

## Settings

- **`fallback`:** the model for a general task whose wording gives no signal. Default `sonnet`.
- **`classifier`:** `rules` uses keywords only. `rules+model` also asks a small model to label tasks the keywords can't place. Default `rules`.
- **`nudge`:** asks Claude to delegate more. Default on.
- **`escalate`:** hands stuck tasks to a stronger model. Default on.
- **`learning`:** `on` lets the record move tasks and tries cheaper models, `shadow` only reports what it would pick, and `off` uses the rules alone. Default `on`.
- **`budgetShift`:** moves tasks a model down as rate limits fill. Default on.

## Rule files

Optional JSON files can pin agents to a model, add keywords and set prices. See `downshift.example.json`. downshift reads `.claude/downshift.json` from your home folder and then from the current project, and the project's file overrides your home file. A project you open can therefore change how its subagents are routed.

## What it changes in your session

**Subagents.** downshift hooks `agent.spawn` and, for the agents it routes, changes two things before the subagent starts: it sets the model, and it adds an escalation protocol to the end of the prompt. It does not set permission modes or answer permission prompts. It leaves alone forks and any call that names its own model. Routing never picks a stronger model than the agent that started the subagent.

**Trying cheaper models.** With `learning` on, every 5th task it places can run one model lower while that model has too little record. Build work is never moved down by learning. Past 75% of a rate-limit window, tasks with no signal run one model lower. Past 90%, every task it places by its wording does.

**Instructions to Claude.** With `nudge` on, downshift adds a system prompt section asking Claude to delegate self-contained work and calling that the user's standing request. It also hooks `tool.describe` to replace the Agent tool's rule against starting subagents unless asked with a delegation policy. Turn `nudge` off to keep Claude Code's original wording. With `escalate` on, it adds a system prompt section explaining escalation reports. Pausing routing removes the delegation changes and the system prompt sections.

**Agents it starts.** When a subagent writes an escalation report, downshift starts a subagent on a stronger model with `agent.spawn`. That subagent gets the original task, the report and, when a stronger model is still available, the escalation protocol.

**Prompts it submits.** The main session did not start that agent, so downshift uses `prompt.submit` to bring back the result. The prompt contains the senior agent's report, or the reason it stopped, plus the models involved and the first 120 characters of the task.

## Files and data

**Writes**

- `~/.claude/downshift-state.json`: success counts per task type and model, with no task text. This is not a settings, build or instructions file, and only `/downshift learn reset` and the learning record write to it.
- Claude Code's plugin store: daily totals for runs, tokens, costs and savings, and how many tasks it has placed.

**Reads**

- The rule files above and `downshift-state.json`.
- The `HOME` and `USERPROFILE` environment variables, only to find your home folder. It reads no API keys, tokens or other credentials.
- Each response's token usage and your session's rate-limit levels, to estimate costs and apply `budgetShift`.

**Network**

downshift makes no network requests of its own and sends nothing to its author. Prompts it changes or submits, and agents it starts, go to Claude through Claude Code as usual. With `classifier` set to `rules+model`, up to 4,000 characters of an unplaced task's description and prompt go to a small Claude model for labeling.

## License

[MIT](LICENSE). Third-party code is credited in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
