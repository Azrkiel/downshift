import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Route } from '../types'
import { choose } from './bandit'
import { CRITICAL, TIGHT, isRaised, rungOf, shiftsDown } from './budget'
import { delegating } from './delegate'
import type { Rung } from './budget'
import { handoffOf, protocol, seniorBrief } from './handoff'
import { STATE_FILE, describe, open, record as count, reset } from './learnstore'
import type { Bucket, Files, Store } from './learnstore'
import { MODEL_OF, TIERS, judge, juniorOf, modelFor, seniorOf, tierOfModel } from './route'
import type { Tier } from './route'
import { costOf, defaults, merge, ratioOf, tokensOf } from './rules'
import type { Rules } from './rules'

const PLUGIN = 'model-router'
const PANE = PLUGIN
const RULE_FILE = '.claude/model-router.json'
/** Every Nth placed task in a bucket may try the tier below while that tier has too little record. */
const PROBE_EVERY = 10
/** Outcomes one load of the mod may add per bucket: no single session can build a record alone. */
const SESSION_CAP = 3

const routes = atom({ plugin: 'model-router', key: 'routes' } as const, [])
const isPaused = atom({ plugin: 'model-router', key: 'isPaused' } as const, false)

// What the small model picks between when the keywords place nothing.
const LABEL_OF: Record<Tier, string> = {
  scout: 'looking things up, searching, scraping or summarizing',
  builder: 'writing, changing or testing code',
  architect: 'architecture, planning or a hard judgment call',
}

const NUDGE = {
  id: 'model-router:delegation',
  scope: 'session',
  text: [
    '# Model routing',
    'The user installed the model-router mod, which runs each subagent on the cheapest model that fits its task. Treat that as their standing request to delegate self-contained work through the Agent tool, without naming a `model` yourself:',
    '- Web research, scraping, bulk search and lookups: an Explore or general-purpose agent (runs on haiku).',
    '- Well-specified implementation, fixes and tests: a general-purpose agent (runs on sonnet).',
    '- Architecture, planning and hard judgment calls: a Plan agent, or do it yourself (opus).',
    'Keep small or tightly coupled steps inline: a subagent starts cold, so delegate only where the work is worth briefing.',
  ].join('\n'),
} as const

const ESCALATION = {
  id: 'model-router:escalation',
  scope: 'session',
  text: [
    '# Subagent escalation',
    'A subagent answer that ends with a `## ESCALATION HANDOFF` report means the subagent could not finish and the model-router mod has already dispatched a senior agent on a stronger model with that report. Do not redo the task or dispatch it again: tell the user it was escalated, carry on with work that does not depend on it, and use the senior\'s report when it arrives as a message from the model-router plugin.',
  ].join('\n'),
} as const

/** A subagent the router is following, from its spawn to the end of its run. */
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
  /** The learning bucket its outcome counts in; undefined where the router did not place it by its words. */
  bucket?: Bucket
  /** Spawned by a subagent (a phase manager): that parent, not the router, takes over a handoff. */
  isNested: boolean
  isHandedOver: boolean
}

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
  /** Placed tasks per bucket, for the probe. */
  placed: Map<Bucket, number>
  /** Outcomes counted per bucket, for the cap. */
  counted: Map<Bucket, number>
}

const learningState = (): Learning => ({
  writing: Promise.resolve(),
  placed: new Map(),
  counted: new Map(),
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
) => {
  const seen = state.counted.get(bucket) ?? 0
  if (seen >= SESSION_CAP) return
  state.counted.set(bucket, seen + 1)
  state.writing = state.writing
    .then(async () => {
      const before = await storeOf($, state)
      const after = await count(filesOf($), before, bucket, model, isSuccess)
      state.store = Promise.resolve(after)
      if (before.isWritable && !after.isWritable) {
        $.ui.toast(`router: learning stays in memory (${after.problem ?? 'unknown'})`)
      }
    })
    .catch(() => undefined)
  await state.writing
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
  $.ui.status(`router: ${summary(list)}`)
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
      name: 'router',
      description:
        'Model routing: report, `pane`, `on`, `off`, `rules`, `reload`, `learn`, `learn reset`',
    })
    void rulesOf($)

    return next(e)
  })

  on('command.run', { command: 'router' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()

    if (arg === 'off' || arg === 'on') {
      await update($, isPaused, () => arg === 'off')
      $.ui.status(arg === 'off' ? 'router: paused' : undefined)
      // The Agent tool's wording follows the pause from the next turn.
      $.ui.invalidate('tool.describe')

      return { text: `Model routing is ${arg}.` }
    }
    if (arg === 'pane') {
      await $.ui.open({ id: PANE, title: 'Model router' })

      return { text: 'Model router pane opened.' }
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

    return {
      text: [
        `Model routing is ${(await read($, isPaused)) ? 'off' : 'on'}. ${summary(list)}`,
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

    // Only what the router placed by its words, or by fallback, learns: a rule
    // file, a fixed agent type or a named model is someone's choice.
    const bucket: Bucket | undefined =
      !verdict.isLearnable || tier === undefined ? undefined : reason === 'fallback' ? 'open' : tier

    if (bucket !== undefined && learning !== 'off') {
      const seen = (state.placed.get(bucket) ?? 0) + 1
      state.placed.set(bucket, seen)
      const pick = choose({
        model,
        junior: juniorOf(model),
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
      prompt: senior === undefined ? e.prompt : e.prompt + protocol(senior, isNested ? 'parent' : 'router'),
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
        isHandedOver: false,
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

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    const one = e.agentId === undefined ? undefined : live.get(e.agentId)
    if (e.agentId === undefined || one === undefined || one.isHandedOver) return done

    const handoff =
      e.reason === 'answer' && one.senior !== undefined ? handoffOf(e.answer) : undefined
    const { rules } = await rulesOf($)
    const cost = e.usage === undefined ? 0 : (costOf(e.usage, one.model, rules) ?? 0)
    const base = e.usage === undefined ? undefined : costOf(e.usage, one.parentModel, rules)
    // An escalated run bought a report, not the task: its cost is the loss.
    const saved = handoff !== undefined ? -cost : base === undefined ? 0 : base - cost
    const tokens = e.usage === undefined ? 0 : tokensOf(e.usage)
    const status: Route['status'] =
      handoff !== undefined ? 'escalated' : e.reason === 'answer' ? 'done' : 'failed'

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
    $.ui.status(`router: ${summary(list)}`)

    // An answer is a success, a handoff a failure; an interrupt, a refusal or
    // an API error says nothing about the model. A run with nobody to hand
    // over to could only ever succeed, so it says nothing either.
    if (
      one.bucket !== undefined &&
      one.senior !== undefined &&
      learning !== 'off' &&
      e.reason === 'answer'
    ) {
      await learn($, state, one.bucket, one.model, handoff === undefined)
    }

    // A worker's parent reads its handoff and re-dispatches it; the router
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
        $.ui.toast(`router: could not escalate "${one.description}" to ${model}`)

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
      $.ui.toast(`router: ${one.model} handed "${one.description}" to ${model}`)

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
          ? `router: a rate-limit window is past ${CRITICAL}%; every placed task runs a tier down`
          : `router: a rate-limit window is past ${TIGHT}%; tasks with no signal run a tier down`,
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
              route.status === 'escalated' || route.status === 'failed'
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
