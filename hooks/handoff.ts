const HEADING = '## ESCALATION HANDOFF'
const MARKER = /^##\s*ESCALATION HANDOFF\b/m

/**
 * Who takes over a stuck run: the mod itself for a subagent of the main
 * session, the spawning agent for a worker under a subagent (a phase manager),
 * since the mod can deliver a senior's answer only to the main session.
 */
export type Handler = 'mod' | 'parent'

const HANDS_OVER: Record<Handler, string> = {
  mod:
    'Writing that heading hands the task over: the senior is dispatched automatically with your report, so nobody needs to re-dispatch it.',
  parent:
    'Writing that heading hands the task back to the agent that spawned you, which passes it with your report to the senior.',
}

/** What a routed subagent's prompt ends with while a stronger model is on call above it. */
export const protocol = (senior: string, handler: Handler = 'mod') =>
  [
    '',
    '---',
    `Escalation protocol (downshift). You are the first engineer on this task, and a senior engineer on a stronger model (${senior}) is on call. Work the task properly first. If you hit a wall you cannot get past (the same failure after two real attempts at different approaches, a root cause you cannot find, a decision you lack the context to judge), stop there: do not guess, and do not present a partial fix as done. End your final answer with this report, filled in honestly and specifically, with file paths, commands and exact error text:`,
    '',
    HEADING,
    '### The task as I understood it',
    '### What I did',
    '(each step taken and file touched, in order)',
    '### Approaches tried and how each turned out',
    '(for each: what you tried, what you expected, the exact error or result you got)',
    '### What worked, and why',
    '### What went wrong',
    '### My current assessment',
    '(your best explanation of the problem, the evidence for it, and what you ruled out)',
    '### The challenge I could not get past',
    '### Where I would look next',
    '### State I am leaving behind',
    '(files changed, anything half-done, anything that should be reverted)',
    '',
    `${HANDS_OVER[handler]} Do not escalate work you can finish, and do not use it for a missing permission or a question only the user can answer: say those plainly instead.`,
  ].join('\n')

/** The junior's report, from its heading on; undefined when the answer did not escalate. */
export const handoffOf = (answer: string) => {
  const at = answer.search(MARKER)

  return at === -1 ? undefined : answer.slice(at).trim()
}

/** The prompt the senior runs with: the task as first given, then the junior's report. */
export const seniorBrief = (task: string, handoff: string, junior: string) =>
  [
    `You are the senior engineer taking over a task that a junior engineer (running on ${junior}) could not finish. Their handoff report is below, after the original task.`,
    '',
    'Read the report as a colleague\'s notes: evidence to use, not conclusions to trust. Build on what they showed works, do not repeat an attempt they showed fails, and check for yourself any claim the fix depends on, since their diagnosis is where they got stuck. Look at the state they left behind before changing anything, and revert what they marked as half-done if it is in your way.',
    '',
    'Finish the original task. In your final answer say what the actual problem was, what you changed, and which of the junior\'s findings held up and which did not, so the next task goes better.',
    '',
    '## Original task',
    task,
    '',
    handoff.replace(MARKER, "## Junior's handoff"),
  ].join('\n')
