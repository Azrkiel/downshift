# downshift

**Model routing for Claude Code.**

downshift is a Claude Code mod that runs each subagent on the cheapest model suited to its task, so the same work uses less of your budget or rate limits.

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
