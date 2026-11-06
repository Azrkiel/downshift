import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Route } from '../types'
import { PROBE_EVERY, choose } from './bandit'
import { CRITICAL, TIGHT, isRaised, rungOf, shiftsDown } from './budget'
import { delegating } from './delegate'
import type { Rung } from './budget'
import { handoffOf, protocol, seniorBrief } from './handoff'
import { STATE_FILE, describe, open, record as count, reset } from './learnstore'
import type { Bucket, Files, Store } from './learnstore'
import { LEDGER_KEY, addTo, dayOf, describeLedger, lifetimeLine, parseLedger } from './ledger'
import type { Day } from './ledger'
import { isRedo } from './redo'
import { MODEL_OF, TIERS, judge, juniorOf, modelFor, seniorOf, tierOfModel } from './route'
import type { Tier } from './route'
import { costOf, defaults, longPromptExtra, merge, ratioOf, tokensOf } from './rules'
import type { Rules } from './rules'

const PLUGIN = 'downshift'
const PANE = PLUGIN
const RULE_FILE = '.claude/downshift.json'
/**
 * Outcomes one load of the mod may add per bucket, per kind: no single session
 * can build a record alone. Kinds cap apart so a probe or a redo, the rarer
 * signals, are not lost to the plain answers ahead of them.
 */
const SESSION_CAP = 3
/** Finished runs a load remembers for the redo check. */
const REMEMBERED = 30

const routes = atom({ plugin: 'downshift', key: 'routes' } as const, [])
const isPaused = atom({ plugin: 'downshift', key: 'isPaused' } as const, false)

// What the small model picks between when the keywords place nothing.
const LABEL_OF: Record<Tier, string> = {
  scout: 'looking things up, searching, scraping or summarizing',
  builder: 'writing, changing or testing code',
  architect: 'architecture, planning or a hard judgment call',
}

const NUDGE = {
  id: 'downshift:delegation',
  scope: 'session',
  text: [
    '# Model routing',
    'The user installed the downshift mod, which runs each subagent on the cheapest model that fits its task. Treat that as their standing request to delegate self-contained work through the Agent tool, without naming a `model` yourself:',
    '- Web research, scraping, bulk search and lookups: an Explore or general-purpose agent (runs on haiku).',
    '- Well-specified implementation, fixes and tests: a general-purpose agent (runs on sonnet).',
    '- Architecture, planning and hard judgment calls: a Plan agent, or do it yourself (opus).',
    'Keep small or tightly coupled steps inline: a subagent starts cold, so delegate only where the work is worth briefing.',
  ].join('\n'),
} as const

const ESCALATION = {
  id: 'downshift:escalation',
  scope: 'session',
  text: [
    '# Subagent escalation',
    'A subagent answer that ends with a `## ESCALATION HANDOFF` report means the subagent could not finish and the downshift mod has already dispatched a senior agent on a stronger model with that report. Do not redo the task or dispatch it again: tell the user it was escalated, carry on with work that does not depend on it, and use the senior\'s report when it arrives as a message from the downshift plugin.',
  ].join('\n'),
} as const

/** A subagent the mod is following, from its spawn to the end of its run. */
type Live = {
  /** The task as first given, before the protocol was added and before any handoff. */
  task: string
  description: string
  subagentType: string
  model: string
  parentModel: string
  /** The model an escalation would go to; undefined at the top. */
  senior?: string
  /** The model of the junior this one took over from. */
  tookOverFrom?: string
  /** The learning bucket its outcome counts in; undefined where the mod did not place it by its words. */
  bucket?: Bucket
  /** Spawned by a subagent (a phase manager): that parent, not the mod, takes over a handoff. */
  isNested: boolean
  /** The agent that spawned it; undefined for the main session. */
  parent?: string
  isHandedOver: boolean
  /** Sent a tier down to build that tier's record. */
  isProbe: boolean
}

/** A cheap run that answered: if its task comes back, the answer was not enough. */
type Finished = {
  id: string
  description: string
  prompt: string
  model: string
  bucket?: Bucket
  /** The agent that spawned it; undefined for the main session. */
  parent?: string
}

type OutcomeKind = 'plain' | 'probe' | 'redo'

type Loaded = { rules: Rules; files: string[] }

const dollars = (amount: number) =>
  `${amount < 0 ? '-' : ''}$${Math.abs(amount).toFixed(Math.abs(amount) < 1 ? 3 : 2)}`

const tally = (list: readonly Route[]) =>
  TIERS.map(tier => {
    const model = MODEL_OF[tier]

    return `${model} ${list.filter(route => route.model === model).length}`
  }).join(' · ')

const savedBy = (list: readonly Route[]) =>
  list.reduce((sum, route) => sum + route.saved, 0)

const summary = (list: readonly Route[]) =>
  `${tally(list)} · saved ~${dollars(savedBy(list))}`

const lineOf = (route: Route, width: number) => {
  const spend =
    route.status === 'running'
      ? ''
      : `  ${(route.tokens / 1000).toFixed(1)}k tok  ${route.saved < 0 ? 'lost' : 'saved'} ${dollars(Math.abs(route.saved))}`
  const head = `${route.model.padEnd(7)}${route.status.padEnd(10)}`
  const room = Math.max(8, width - head.length - spend.length)
  const what =
    route.description.length > room
      ? `${route.description.slice(0, room - 1)}…`
      : route.description

  return `${head}${what}${spend}`
}

// Module state: a reload starts both over, and the rule files are read again.
const live = new Map<string, Live>()
let loaded: Promise<Loaded> | undefined

const homeOf = async ($: EngineInterface) =>
  (await $.env.get('USERPROFILE').catch(() => undefined)) ??
  (await $.env.get('HOME').catch(() => undefined))

const filesOf = ($: EngineInterface): Files => ({
  exists: path => $.fs.exists(path),
  read: async path => String(await $.fs.read(path)),
  write: (path, text) => $.fs.write(path, text),
})

/** One load's learning: the record as read, the write queue, and this load's counters. */
type Learning = {
  store?: Promise<Store>
  writing: Promise<unknown>
  /** Placed tasks per bucket, for the probe; what `$.store` holds wins, this covers a store that fails. */
  placed: Map<Bucket, number>
  /** Outcomes counted per bucket and kind, for the cap. */
  counted: Map<string, number>
  /** Runs that answered, newest last, for the redo check. */
  finished: Finished[]
  /** Dollars the long-prompt rate added to each running agent, from its responses. */
  extras: Map<string, number>
  ledgerWrites: Promise<unknown>
}

const learningState = (): Learning => ({
  writing: Promise.resolve(),
  placed: new Map(),
  counted: new Map(),
  finished: [],
  extras: new Map(),
  ledgerWrites: Promise.resolve(),
})

const statePath = (home: string | undefined) => (home === undefined ? '' : `${home}/${STATE_FILE}`)

const storeOf = ($: EngineInterface, state: Learning) =>
  (state.store ??= homeOf($).then(home => open(filesOf($), statePath(home))))

/** Counts a run's outcome, one write at a time, within the per-load cap. */
const learn = async (
  $: EngineInterface,
  state: Learning,
  bucket: Bucket,
  model: string,
  isSuccess: boolean,
  kind: OutcomeKind,
) => {
  const key = `${bucket}/${kind}`
  const seen = state.counted.get(key) ?? 0
  if (seen >= SESSION_CAP) return
  state.counted.set(key, seen + 1)
  state.writing = state.writing
    .then(async () => {
      const before = await storeOf($, state)
      const after = await count(filesOf($), before, bucket, model, isSuccess)
      state.store = Promise.resolve(after)
      if (before.isWritable && !after.isWritable) {
        $.ui.toast(`downshift: learning stays in memory (${after.problem ?? 'unknown'})`)
      }
    })
    .catch(() => undefined)
  await state.writing
}

/** This bucket's placed count, kept across sessions so a run of short ones still reaches a probe. */
const placedCount = async ($: EngineInterface, state: Learning, bucket: Bucket) => {
  const key = `placed.${bucket}`
  const stored = await $.store.get(key).catch(() => undefined)
  const seen =
    (typeof stored === 'number' && Number.isFinite(stored) ? stored : (state.placed.get(bucket) ?? 0)) + 1
  state.placed.set(bucket, seen)
  await $.store.set(key, seen).catch(() => undefined)

  return seen
}

const readLedger = async ($: EngineInterface) =>
  parseLedger(await $.store.get(LEDGER_KEY).catch(() => undefined))

/** Adds to today's totals, one write at a time; a store that fails costs the ledger, never the route. */
const addToLedger = async ($: EngineInterface, state: Learning, delta: Partial<Day>) => {
  const now = await $.clock.now().catch(() => Date.now())
  state.ledgerWrites = state.ledgerWrites
    .then(async () => {
      const ledger = await readLedger($)
      await $.store.set(LEDGER_KEY, addTo(ledger, dayOf(now), delta))
    })
    .catch(() => undefined)
  await state.ledgerWrites
}

/** Takes the newest finished run under the same parent that this new task repeats. */
const takeRedone = (state: Learning, e: { description: string; prompt: string; parentAgentId?: string }) => {
  for (let i = state.finished.length - 1; i >= 0; i--) {
    const one = state.finished[i]
    if (one !== undefined && one.parent === e.parentAgentId && isRedo(one, e)) {
      state.finished.splice(i, 1)

      return one
    }
  }

  return undefined
}

/** A repeated task means the earlier answer fell short: a failed outcome, and a run that saved nothing. */
const countRedo = async (
  $: EngineInterface,
  state: Learning,
  one: Finished,
  isLearning: boolean,
) => {
  if (isLearning && one.bucket !== undefined) {
    await learn($, state, one.bucket, one.model, false, 'redo')
  }
  const route = (await read($, routes)).find(each => each.id === one.id)
  if (route === undefined) return
  const list = await update($, routes, all =>
    all.map(each => (each.id === one.id ? { ...each, status: 'redone' as const, saved: -each.cost } : each)),
  )
  $.ui.status(`downshift: ${summary(list)}`)
  await addToLedger($, state, { saved: -route.cost - route.saved, redone: 1 })
}

const load = async ($: EngineInterface): Promise<Loaded> => {
  const home = await homeOf($)
  const paths = [...(home === undefined ? [] : [`${home}/${RULE_FILE}`]), RULE_FILE]
  let rules = defaults()
  const files: string[] = []

  for (const path of paths) {
    const text = await $.fs.read(path).catch(() => undefined)
    if (typeof text !== 'string') continue
    const merged = merge(rules, text)
    rules = merged.rules
    files.push(
      merged.problems.length === 0 ? path : `${path} (${merged.problems.join('; ')})`,
    )
  }

  return { rules, files }
}
const rulesOf = ($: EngineInterface) => (loaded ??= load($))

const record = async ($: EngineInterface, route: Route) => {
  const list = await update($, routes, all => [...all, route].slice(-200))
  $.ui.status(`downshift: ${summary(list)}`)
}

export const register: Register = (on, options) => {
  const fallback = tierOfModel(String(options.fallback ?? 'sonnet')) ?? 'builder'
  const hasModelClassifier = options.classifier === 'rules+model'
  const hasNudge = options.nudge !== false
  const hasEscalation = options.escalate !== false
  const learning = options.learning === 'off' || options.learning === 'shadow' ? options.learning : 'on'

  // Per load, so each reload (and each test) starts with fresh counters and a
  // freshly read record.
  const state = learningState()
  const hasBudgetShift = options.budgetShift !== false
  // The fullest rate-limit window's rung, and the highest one announced since it was last ok.
  let rung: Rung = 'ok'
  let told: Rung = 'ok'

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'downshift',
      description:
        'Model routing: report, `savings`, `pane`, `on`, `off`, `rules`, `reload`, `learn`, `learn reset`',
    })
    void rulesOf($)

    return next(e)
  })

  on('command.run', { command: 'downshift' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()

    if (arg === 'off' || arg === 'on') {
      await update($, isPaused, () => arg === 'off')
      $.ui.status(arg === 'off' ? 'downshift: paused' : undefined)
      // The Agent tool's wording follows the pause from the next turn.
      $.ui.invalidate('tool.describe')

      return { text: `Model routing is ${arg}.` }
    }
    if (arg === 'pane') {
      await $.ui.open({ id: PANE, title: 'Downshift' })

      return { text: 'Downshift pane opened.' }
    }
    if (arg === 'savings') {
      return { text: describeLedger(await readLedger($)) }
    }
    if (arg === 'learn' || arg === 'learn reset') {
      if (arg === 'learn reset') {
        state.store = Promise.resolve(await reset(filesOf($), statePath(await homeOf($))))
      }

      return {
        text: [
          `Learning is ${learning}${learning === 'on' ? `, probing every ${PROBE_EVERY}th placed task while escalation is on` : ''}.`,
          'Success rate per bucket and model, with the outcomes it rests on (older ones fade):',
          ...describe(await storeOf($, state)),
        ].join('\n'),
      }
    }
    if (arg === 'reload' || arg === 'rules') {
      if (arg === 'reload') loaded = undefined
      const { rules, files } = await rulesOf($)
      const words = TIERS.map(tier => `${tier} ${rules.keywords[tier].length}`).join(', ')

      return {
        text: [
          files.length === 0
            ? `No rule file found. Looked for ~/${RULE_FILE} and ./${RULE_FILE}.`
            : `Rule files, later over earlier:\n${files.map(file => `  ${file}`).join('\n')}`,
          `Agent rules: ${Object.entries(rules.agents).map(([agent, tier]) => `${agent} -> ${tier === 'classify' ? tier : MODEL_OF[tier]}`).join(', ') || 'none'}`,
          `Extra keywords: ${words}`,
          `Prices ($/MTok in, out): ${Object.entries(rules.prices).map(([family, price]) => `${family} ${price.input}/${price.output}`).join(', ')}`,
        ].join('\n'),
      }
    }

    const list = await read($, routes)
    const lifetime = lifetimeLine(await readLedger($))

    return {
      text: [
        `Model routing is ${(await read($, isPaused)) ? 'off' : 'on'}. ${summary(list)}`,
        ...(lifetime === undefined ? [] : [lifetime]),
        `Fallback ${MODEL_OF[fallback]}, classifier ${hasModelClassifier ? 'rules+model' : 'rules'}, nudge ${hasNudge ? 'on' : 'off'}, escalation ${hasEscalation ? 'on' : 'off'}, learning ${learning}.`,
        'Savings are an estimate: the same tokens priced on the parent model, less what the run cost.',
        ...(list.length === 0
          ? ['No subagent routed yet.']
          : list.slice(-15).map(route => `  ${lineOf(route, 100)} (${route.reason})`)),
      ].join('\n'),
    }
  })

  on('agent.spawn', async ($, e, next) => {
    if (await read($, isPaused)) return next(e)

    // Before routing, so a repeat that names its own model counts too.
    if (!e.fork) {
      const redone = takeRedone(state, e)
      if (redone !== undefined) await countRedo($, state, redone, learning !== 'off')
    }

    const { rules } = await rulesOf($)
    const verdict = judge(e, rules)
    let tier = verdict.tier
    let reason = verdict.reason

    if (verdict.isOpen && hasModelClassifier) {
      const label = await $.model.classify(
        `${e.description}\n${e.prompt}`.slice(0, 4000),
        TIERS.map(one => LABEL_OF[one]),
      )
      tier = TIERS.find(one => LABEL_OF[one] === label)
      reason = tier === undefined ? reason : 'classified'
    }
    if (verdict.isOpen && tier === undefined) {
      tier = fallback
      reason = 'fallback'
    }

    let model = tier === undefined ? undefined : modelFor(tier, e.parentModel)
    if (model === undefined) return next(e)

    // Only what the mod placed by its words, or by fallback, learns: a rule
    // file, a fixed agent type or a named model is someone's choice.
    const bucket: Bucket | undefined =
      !verdict.isLearnable || tier === undefined ? undefined : reason === 'fallback' ? 'open' : tier

    let isProbe = false
    if (bucket !== undefined && learning !== 'off') {
      const seen = await placedCount($, state, bucket)
      const pick = choose({
        model,
        // Build work stays on its model: the record may move it up, never down.
        junior: bucket === 'builder' ? undefined : juniorOf(model),
        senior: seniorOf(model, e.parentModel),
        arms: (await storeOf($, state)).learned[bucket],
        ratio: ratioOf(rules),
        // A probe needs an escalation to catch it, and a teammate has none.
        probe: learning === 'on' && hasEscalation && e.isTeammate !== true && seen % PROBE_EVERY === 0,
        random: Math.random,
      })
      if (learning === 'on' && pick.reason !== undefined) {
        model = pick.model
        reason = pick.reason
        isProbe = pick.isProbe === true
      } else if (pick.model !== model) {
        reason = `${reason}; learned would pick ${pick.model}`
      }
    }

    // Last, so a learned move up never outlasts a nearly spent window.
    if (bucket !== undefined && hasBudgetShift && shiftsDown(rung, bucket)) {
      const lower = juniorOf(model)
      if (lower !== undefined) {
        model = lower
        reason = `${reason}; rate limit ${rung}`
      }
    }

    // A teammate idles between turns and answers by message: no handoff there.
    const senior =
      hasEscalation && e.isTeammate !== true ? seniorOf(model, e.parentModel) : undefined
    const isNested = e.parentAgentId !== undefined
    const started = await next({
      ...e,
      model,
      prompt: senior === undefined ? e.prompt : e.prompt + protocol(senior, isNested ? 'parent' : 'mod'),
    })
    if (started.deny !== undefined) return started

    if (started.agentId !== undefined) {
      live.set(started.agentId, {
        task: e.prompt,
        description: e.description,
        subagentType: e.subagentType,
        model,
        parentModel: e.parentModel,
        senior,
        bucket,
        isNested,
        parent: e.parentAgentId,
        isHandedOver: false,
        isProbe,
      })
    }
    await record($, {
      id: started.agentId ?? e.tool_use_id,
      agent: e.subagentType,
      description: e.description,
      model,
      reason,
      status: 'running',
      tokens: 0,
      cost: 0,
      saved: 0,
    })

    return started
  }).catch(($, e, next) => next(e))

  // The long-prompt rate depends on each request, and `turn.complete` has only
  // the sum. This hook sees every response of the session, so it only reads, and
  // never lets its own accounting break a stream.
  on('turn.step', async function* ($, e, next) {
    const response = yield* next(e)
    const agent = e.agentId
    if (agent === undefined || response.usage === null || !live.has(agent)) return response
    try {
      const { rules } = await rulesOf($)
      const extra = longPromptExtra(response.usage, response.usage.model, rules)
      if (extra > 0) state.extras.set(agent, (state.extras.get(agent) ?? 0) + extra)
    } catch {
      // A missing surcharge only makes the estimate a little high.
    }

    return response
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    const one = e.agentId === undefined ? undefined : live.get(e.agentId)
    if (e.agentId === undefined || one === undefined || one.isHandedOver) return done

    const handoff =
      e.reason === 'answer' && one.senior !== undefined ? handoffOf(e.answer) : undefined
    const { rules } = await rulesOf($)
    const extra = state.extras.get(e.agentId) ?? 0
    state.extras.delete(e.agentId)
    const cost = (e.usage === undefined ? 0 : (costOf(e.usage, one.model, rules) ?? 0)) + extra
    const base = e.usage === undefined ? undefined : costOf(e.usage, one.parentModel, rules)
    // An escalated run bought a report, not the task: its cost is the loss.
    const saved = handoff !== undefined ? -cost : base === undefined ? 0 : base - cost
    const tokens = e.usage === undefined ? 0 : tokensOf(e.usage)
    const status: Route['status'] =
      handoff !== undefined ? 'escalated' : e.reason === 'answer' ? 'done' : 'failed'
    const isFirstEnd = (await read($, routes)).some(
      route => route.id === e.agentId && route.status === 'running',
    )

    const list = await update($, routes, all =>
      all.map(route =>
        route.id === e.agentId
          ? {
              ...route,
              status,
              tokens: route.tokens + tokens,
              cost: route.cost + cost,
              saved: route.saved + saved,
            }
          : route,
      ),
    )
    $.ui.status(`downshift: ${summary(list)}`)
    await addToLedger($, state, {
      runs: isFirstEnd ? 1 : 0,
      tokens,
      cost,
      base: base ?? cost,
      saved,
      escalated: handoff !== undefined ? 1 : 0,
    })

    // Only a run that could have handed over can be blamed for a repeat, and a
    // senior's task coming back says nothing about the model it took over from.
    if (
      e.reason === 'answer' &&
      handoff === undefined &&
      one.senior !== undefined &&
      one.tookOverFrom === undefined
    ) {
      const others = state.finished.filter(each => each.id !== e.agentId)
      state.finished = [
        ...others,
        {
          id: e.agentId,
          description: one.description,
          prompt: one.task,
          model: one.model,
          bucket: one.bucket,
          parent: one.parent,
        },
      ].slice(-REMEMBERED)
    }

    // An answer is a success, a handoff a failure; an interrupt, a refusal or
    // an API error says nothing about the model. A run with nobody to hand
    // over to could only ever succeed, so it says nothing either.
    if (
      one.bucket !== undefined &&
      one.senior !== undefined &&
      learning !== 'off' &&
      e.reason === 'answer'
    ) {
      await learn($, state, one.bucket, one.model, handoff === undefined, one.isProbe ? 'probe' : 'plain')
    }

    // A worker's parent reads its handoff and re-dispatches it; the mod
    // could only hand the senior's answer to the main session.
    if (handoff !== undefined && one.isNested) {
      one.isHandedOver = true

      return done
    }

    if (handoff !== undefined && one.senior !== undefined) {
      one.isHandedOver = true
      const model = one.senior
      const above = seniorOf(model, one.parentModel)
      const description = `Senior takeover: ${one.description}`.slice(0, 80)
      const started = await $.agent.spawn({
        prompt:
          seniorBrief(one.task, handoff, one.model) +
          (above === undefined ? '' : protocol(above)),
        description,
        subagentType: one.subagentType,
        model,
      })

      if (started.deny !== undefined) {
        $.ui.toast(`downshift: could not escalate "${one.description}" to ${model}`)

        return done
      }

      // Core answers the id; where a hook answered the spawn in its place, the
      // agent list still names the run this plugin started.
      const seniorId =
        started.agentId ??
        (await $.agent.list().catch(() => []))
          .filter(agent => agent.spawnedBy === PLUGIN && agent.description === description)
          .at(-1)?.id

      if (seniorId !== undefined) {
        live.set(seniorId, {
          task: one.task,
          description,
          subagentType: one.subagentType,
          model,
          parentModel: one.parentModel,
          senior: above,
          tookOverFrom: one.model,
          bucket: one.bucket,
          isNested: false,
          isHandedOver: false,
          isProbe: false,
        })
      }
      await record($, {
        id: seniorId ?? `senior-of-${e.agentId}`,
        agent: one.subagentType,
        description,
        model,
        reason: `escalated from ${one.model}`,
        status: 'running',
        tokens: 0,
        cost: 0,
        saved: 0,
      })
      $.ui.toast(`downshift: ${one.model} handed "${one.description}" to ${model}`)

      return done
    }

    // The main loop never called this agent, so nothing else brings it the answer.
    if (one.tookOverFrom !== undefined) {
      await $.prompt.submit({
        text:
          e.reason === 'answer'
            ? `The senior agent (${one.model}) finished the task the ${one.tookOverFrom} subagent escalated ("${one.task.slice(0, 120)}"). Its report:\n\n${e.answer}`
            : `The senior agent (${one.model}) that took over the escalated task "${one.task.slice(0, 120)}" ended without an answer (${e.reason}). The task is still open.`,
      })
    }

    return done
  })

  on('session.measure', async ($, e, next) => {
    const result = await next(e)
    if (!hasBudgetShift) return result
    rung = rungOf(e.rateLimits)
    if (rung === 'ok') told = 'ok'
    if (isRaised(told, rung)) {
      told = rung
      $.ui.toast(
        rung === 'critical'
          ? `downshift: a rate-limit window is past ${CRITICAL}%; every placed task runs a tier down`
          : `downshift: a rate-limit window is past ${TIGHT}%; tasks with no signal run a tier down`,
      )
    }

    return result
  })

  // Claude Code's Agent tool forbids unasked spawns, which outranks the nudge
  // and leaves nothing to route; the user's install is the ask.
  on('tool.describe', { tool: 'Agent' }, async ($, e, next) => {
    const described = await next(e)
    if (!hasNudge || (await read($, isPaused))) return described

    return { ...described, description: delegating(described.description) }
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!e.tools.includes('Agent') || (await read($, isPaused))) return composed

    return {
      sections: [
        ...composed.sections,
        ...(hasNudge ? [NUDGE] : []),
        ...(hasEscalation ? [ESCALATION] : []),
      ],
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const list = await read($, routes)
    const paused = await read($, isPaused)
    const room = Math.max(1, (e.viewport?.rows ?? 24) - 6)
    const width = Math.max(30, e.props.bodyColumns)

    return (
      <Box flexDirection="column">
        <Text bold>{summary(list)}</Text>
        <Box>
          <Button
            key="pause"
            label={paused ? 'Resume routing' : 'Pause routing'}
            onPress={() => update($, isPaused, now => !now)}
          />
        </Box>
        {list.length === 0 && <Text dimColor>No subagent routed yet.</Text>}
        {list.slice(-room).map(route => (
          <Text
            dimColor={route.status === 'done'}
            color={
              route.status === 'escalated' || route.status === 'failed' || route.status === 'redone'
                ? 'yellow'
                : undefined
            }
            wrap="truncate-end"
          >
            {lineOf(route, width)}
          </Text>
        ))}
      </Box>
    )
  })
}
