import type { ModelUsage } from 'claude-code'

import { TIERS, tierOfModel } from './route'
import type { Tier } from './route'

/** Dollars per million tokens. */
export type Price = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export type Rules = {
  /** An agent type's tier, or `classify` to place it by its prompt's words. */
  agents: Record<string, Tier | 'classify'>
  /** Lowercase phrases that count toward a tier beside the built-in ones. */
  keywords: Record<Tier, string[]>
  /** By model family (`haiku`, `sonnet`, `opus`, `fable`). */
  prices: Record<string, Price>
}

// First-party API list prices; a rule file's `prices` replaces a family's.
const PRICES: Record<string, Price> = {
  haiku: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  sonnet: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  opus: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  fable: { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
}

export const defaults = (): Rules => ({
  agents: {},
  keywords: { scout: [], builder: [], architect: [] },
  prices: { ...PRICES },
})

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const priceOf = (value: unknown): Price | undefined => {
  if (!isRecord(value)) return undefined
  const { input, output, cacheRead, cacheWrite } = value
  if (typeof input !== 'number' || typeof output !== 'number') return undefined

  return {
    input,
    output,
    cacheRead: typeof cacheRead === 'number' ? cacheRead : input * 0.1,
    cacheWrite: typeof cacheWrite === 'number' ? cacheWrite : input * 1.25,
  }
}

/**
 * Lays one rule file's JSON over `base`, entry by entry; what it misspells is
 * left out and named in `problems`, the rest still applies.
 */
export const merge = (base: Rules, json: string): { rules: Rules; problems: string[] } => {
  const problems: string[] = []
  const rules: Rules = {
    agents: { ...base.agents },
    keywords: {
      scout: [...base.keywords.scout],
      builder: [...base.keywords.builder],
      architect: [...base.keywords.architect],
    },
    prices: { ...base.prices },
  }

  let file: unknown
  try {
    file = JSON.parse(json)
  } catch {
    return { rules, problems: ['not valid JSON'] }
  }
  if (!isRecord(file)) return { rules, problems: ['not a JSON object'] }

  for (const [agent, model] of Object.entries(isRecord(file.agents) ? file.agents : {})) {
    const tier = model === 'classify' ? 'classify' : tierOfModel(String(model))
    if (tier === undefined) problems.push(`agents.${agent}: "${String(model)}" is not haiku, sonnet, opus or classify`)
    else rules.agents[agent] = tier
  }

  for (const [key, words] of Object.entries(isRecord(file.keywords) ? file.keywords : {})) {
    const tier = TIERS.find(one => one === key) ?? tierOfModel(key)
    if (tier === undefined || !Array.isArray(words)) {
      problems.push(`keywords.${key}: expected a list under scout, builder or architect`)
      continue
    }
    for (const word of words) {
      if (typeof word === 'string' && word.trim() !== '') {
        rules.keywords[tier].push(word.trim().toLowerCase())
      }
    }
  }

  for (const [family, value] of Object.entries(isRecord(file.prices) ? file.prices : {})) {
    const price = priceOf(value)
    if (price === undefined) problems.push(`prices.${family}: expected { input, output } in dollars per million tokens`)
    else rules.prices[family.toLowerCase()] = price
  }

  return { rules, problems }
}

export const tokensOf = (usage: ModelUsage) =>
  usage.input_tokens +
  usage.output_tokens +
  usage.cache_read_input_tokens +
  usage.cache_creation_input_tokens

/** What the usage costs on a model, in dollars; undefined for a family with no price. */
export const costOf = (usage: ModelUsage, model: string, rules: Rules) => {
  const family = Object.keys(rules.prices).find(one => model.toLowerCase().includes(one))
  const price = family === undefined ? undefined : rules.prices[family]
  if (price === undefined) return undefined

  return (
    (usage.input_tokens * price.input +
      usage.output_tokens * price.output +
      usage.cache_read_input_tokens * price.cacheRead +
      usage.cache_creation_input_tokens * price.cacheWrite) /
    1_000_000
  )
}
