# model-router

model-router is a Claude Code mod that runs each subagent on the cheapest model suited to its task, so the same work uses less of your budget or rate limits.

## How it works

When Claude starts a subagent, model-router looks at the task and picks a model:

| Model | Used for |
| --- | --- |
| Haiku | Web lookups, search and summaries |
| Sonnet | Implementation, fixes and tests |
| Opus | Architecture, planning and hard judgment calls |

If a subagent gets stuck, it writes up what it tried and found, and a stronger model takes over from there.

model-router learns from results over time. When one model keeps struggling with a kind of task, that work moves to a stronger model. When a cheaper model proves reliable, it can take on more of the work, except for build work, which stays on Sonnet or above.

As you approach a rate limit, model-router shifts tasks to cheaper models to make your remaining usage last longer.

It also estimates what routing has saved, which you can check at any time with `/router savings`.
