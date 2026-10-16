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
  /** True when the task is the router's to place and no rule placed it. */
  isOpen: boolean
  /** True when the router placed it by its words or will by fallback: the only routes learning may move. */
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

  const text = `${task.description}\n${task.prompt}`.slice(0, 6000).toLowerCase()
  const scout = hits(text, 'scout', rules)
  const builder = hits(text, 'builder', rules)
  const architect = hits(text, 'architect', rules)

  // Ties go up: a task under-served costs more than one over-served.
  if (architect > 0 && architect >= builder) {
    return { tier: 'architect', isOpen: false, isLearnable: true, reason: 'architecture words' }
  }
  if (builder > 0) return { tier: 'builder', isOpen: false, isLearnable: true, reason: 'build words' }
  if (scout > 0) return { tier: 'scout', isOpen: false, isLearnable: true, reason: 'lookup words' }

  return { isOpen: true, isLearnable: true, reason: 'no signal' }
}

/** Where a model sits among the families; one the router does not know outranks them all. */
export const rank = (model: string) =>
  /haiku/i.test(model) ? 1 : /sonnet/i.test(model) ? 2 : /opus/i.test(model) ? 3 : 4

/** The tier's model, or undefined where it would outrank the parent's: the router only routes down. */
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
