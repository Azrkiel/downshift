import type { Rules } from './rules'

export type Tier = 'scout' | 'builder' | 'architect'

export const TIERS: readonly Tier[] = ['scout', 'builder', 'architect']

export const MODEL_OF: Record<Tier, string> = {
  scout: 'haiku',
  builder: 'sonnet',
  architect: 'opus',
}

// Agent types whose job is the same whatever the prompt says.
const TIER_OF_AGENT: Record<string, Tier> = {
  Explore: 'scout',
  'claude-code-guide': 'scout',
  'statusline-setup': 'scout',
  Plan: 'architect',
}

// Catch-all types: the prompt decides. Any other type (a custom agent, a
// plugin's) keeps the model its own definition names, unless a rule file
// places it.
const CLASSIFIED = new Set(['general-purpose', 'claude'])

const SIGNALS: Record<Tier, readonly RegExp[]> = {
  scout: [
    /\bscrap(e|es|ing|er)\b/,
    /\bcrawl(s|ing|er)?\b/,
    /\b(web|internet|online)\b/,
    /\bhttps?:\/\//,
    /\b(fetch|download)(es|ing|s)?\b/,
    /\b(look ?up|search(es|ing)? for|find (all|every|where|which|out))\b/,
    /\b(grep|locate|list (all|every|the)|inventory|enumerate)\b/,
    /\bsummari[sz](e|es|ing)\b/,
    /\b(extract|gather|collect)(s|ing)?\b/,
    /\b(docs|documentation|changelog|release notes)\b/,
    /\bread[- ]only\b/,
  ],
  builder: [
    /\b(implement|build|code|write|create|add)(s|ing)?\b/,
    /\b(fix|patch|repair)(es|ing)?\b/,
    /\b(refactor|rename|migrate|port|upgrade)(s|ing)?\b/,
    /\b(edit|modify|update|change)(s|ing)?\b/,
    /\b(tests?|tdd|lint|typecheck|compile)\b/,
    /\b(script|function|component|endpoint|module)\b/,
  ],
  architect: [
    /\barchitect(ure|ural|ing)?\b/,
    /\b(system|api|schema|data model) design\b/,
    /\bdesign (a|an|the) (system|architecture|api|schema|approach|strategy)\b/,
    /\btrade-?offs?\b/,
    /\b(implementation|migration|rollout) (plan|strategy)\b/,
    /\broot cause\b/,
    /\b(security|threat) (review|audit|model)\b/,
    /\b(race condition|deadlock|concurrency)\b/,
    /\b(adversarial|pressure-test|critique)\b/,
    /\bjudg(e|ment)\b/,
  ],
}

/**
 * Syntax that essentially cannot occur in prose: a task that carries it is
 * code work even when no build word says so. Adapted from freellmapi
 * (server/src/lib/task-type.ts, MIT, Copyright (c) 2026 Tashfeen Ahmed; see
 * THIRD_PARTY_NOTICES.md), whose history is the reason none of these is a bare
 * word: matching `class` or `function` sent "What class of animals are
 * dolphins?" to code. Case-sensitive, so they run on the original text.
 */
const CODE_MARKERS: readonly RegExp[] = [
  /```/,
  // A shell prompt and a command-looking word; the word keeps "$ 20 per seat" out.
  /^[ \t]*\$[ \t]+[a-z][\w./-]*(?=[ \t]|$)/m,
  /\b(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=/,
  /\bfunction\s*\*?\s*[A-Za-z_$][\w$]*\s*\(/,
  /\bdef\s+[A-Za-z_]\w*\s*\(/,
  /^[ \t]*class\s+[A-Za-z_$][\w$]*\s*[({:]/m,
  /\bclass\s+[A-Za-z_$][\w$]*\s+extends\s+[A-Za-z_$][\w$]*/,
  /\bimport\s*\{/,
  /\bimport\s[^\n;]{0,200}?\bfrom\s*['"][^'"\n]+['"]/,
  /^[ \t]*from\s+[A-Za-z_.][\w.]*\s+import\s+\S/m,
  /\brequire\s*\(\s*['"]/,
  /^[ \t]*#\s*include\s*[<"]/m,
  // A source file next to a line number: `src/router.ts:214`.
  /\b[\w./-]+\.(?:[jt]sx?|mjs|cjs|py|rb|go|rs|java|kt|swift|php|cs|cpp|cc|hpp|sh|sql|css|scss|html|vue|svelte|ya?ml|json|toml)\s*:\s*\d+/,
  /\b[A-Za-z_][\w./-]*\.[ch]\s*:\s*\d+/,
  // Stack frames: V8, then Python.
  /^\s*at\s+\S.*\(.*:\d+:\d+\)/m,
  /^\s*File\s+"[^"\n]+",\s*line\s+\d+/m,
  /\bTraceback\s+\(most recent call last\)/,
]

const hasCode = (text: string) => CODE_MARKERS.some(marker => marker.test(text))

export type Task = {
  subagentType: string
  description: string
  prompt: string
  model?: string
  parentModel: string
  fork: boolean
}

export type Verdict = {
  /** The tier the rules placed the task in; absent when they left it alone or found no signal. */
  tier?: Tier
  /** True when the task is the mod's to place and no rule placed it. */
  isOpen: boolean
  /** True when the mod placed it by its words or will by fallback: the only routes learning may move. */
  isLearnable: boolean
  reason: string
}

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

/** Places a task by its agent type, then by the words of its prompt; a rule file's entries come first. */
export const judge = (task: Task, rules?: Rules): Verdict => {
  if (task.fork) return { isOpen: false, isLearnable: false, reason: 'a fork inherits its parent' }
  if (task.model !== undefined) {
    return { isOpen: false, isLearnable: false, reason: `the call named ${task.model}` }
  }

  const ruled =
    rules !== undefined && Object.hasOwn(rules.agents, task.subagentType)
      ? rules.agents[task.subagentType]
      : undefined
  if (ruled !== undefined && ruled !== 'classify') {
    return { tier: ruled, isOpen: false, isLearnable: false, reason: 'rule file' }
  }

  const fixed = Object.hasOwn(TIER_OF_AGENT, task.subagentType)
    ? TIER_OF_AGENT[task.subagentType]
    : undefined
  if (ruled === undefined && fixed !== undefined) {
    return { tier: fixed, isOpen: false, isLearnable: false, reason: `${task.subagentType} agent` }
  }
  if (ruled === undefined && !CLASSIFIED.has(task.subagentType)) {
    return { isOpen: false, isLearnable: false, reason: 'its own definition decides' }
  }

  const original = `${task.description}\n${task.prompt}`.slice(0, 6000)
  const text = original.toLowerCase()
  const scout = hits(text, 'scout', rules)
  const builder = hits(text, 'builder', rules)
  const architect = hits(text, 'architect', rules)

  // Ties go up: a task under-served costs more than one over-served.
  if (architect > 0 && architect >= builder) {
    return { tier: 'architect', isOpen: false, isLearnable: true, reason: 'architecture words' }
  }
  if (builder > 0) return { tier: 'builder', isOpen: false, isLearnable: true, reason: 'build words' }
  if (scout > 0) return { tier: 'scout', isOpen: false, isLearnable: true, reason: 'lookup words' }
  // No words, but code: a stack trace or a `file.ts:12` is build work, and must
  // not fall to the fallback (or to the rate-limit protection that tasks there get).
  if (hasCode(original)) return { tier: 'builder', isOpen: false, isLearnable: true, reason: 'code in the task' }

  return { isOpen: true, isLearnable: true, reason: 'no signal' }
}

/** Where a model sits among the families; one the mod does not know outranks them all. */
export const rank = (model: string) =>
  /haiku/i.test(model) ? 1 : /sonnet/i.test(model) ? 2 : /opus/i.test(model) ? 3 : 4

/** The tier's model, or undefined where it would outrank the parent's: the mod only routes down. */
export const modelFor = (tier: Tier, parentModel: string) =>
  rank(MODEL_OF[tier]) > rank(parentModel) ? undefined : MODEL_OF[tier]

/** The model one tier above, for an escalation; undefined at the top or where it would outrank the parent's. */
export const seniorOf = (model: string, parentModel: string) => {
  const senior = TIERS.map(tier => MODEL_OF[tier]).find(one => rank(one) === rank(model) + 1)

  return senior === undefined || rank(senior) > rank(parentModel) ? undefined : senior
}

/** The model one tier below, for a probe or a learned route; undefined at the bottom. */
export const juniorOf = (model: string) =>
  TIERS.map(tier => MODEL_OF[tier]).find(one => rank(one) === rank(model) - 1)

export const tierOfModel = (model: string): Tier | undefined =>
  TIERS.find(tier => MODEL_OF[tier] === model)
