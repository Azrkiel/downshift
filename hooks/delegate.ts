/**
 * Claude Code's own Agent tool description forbids spawning a subagent unless
 * the user asks. That rule is more specific than the delegation nudge, so it
 * wins: the main model does the work itself and nothing is left to route.
 * Installing this mod with the nudge on is the user's ask, so the rule is
 * replaced by the policy the user chose.
 */

const POLICY = [
  "**Delegation: the user's standing request, through the downshift mod.**",
  'Delegate self-contained work without waiting to be asked. The mod runs each subagent on the cheapest model that fits (haiku for web research, search and lookups; sonnet for well-specified implementation, fixes and tests) and escalates one that gets stuck, so delegating saves the user usage.',
  'Delegate when the task can be briefed in a paragraph and does not need this conversation: a web or codebase search, bulk reading or summarizing, an implementation step with clear acceptance criteria.',
  'Keep small steps, tightly coupled edits and judgment calls inline. Do not name a `model`; the mod picks it.',
].join(' ')

// The rule's line, and its closing sentence in case a later version splits it off.
const RULE = /^.*\bDo not spawn agents unless the user asks\b.*$/m
const ONLY_WHEN_ASKED = /\s*Only use this tool when the user explicitly says[^.\n]*\./

/** The Agent tool's description with its ban on unasked spawns replaced by the user's delegation policy. */
export const delegating = (description: string) => {
  const freed = description.replace(ONLY_WHEN_ASKED, '')

  return RULE.test(freed) ? freed.replace(RULE, POLICY) : `${freed}\n\n${POLICY}`
}
