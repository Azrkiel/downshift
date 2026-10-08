import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Route } from '../types'
import { handoffOf, protocol, seniorBrief } from './handoff'
import { MODEL_OF, TIERS, judge, modelFor, seniorOf, tierOfModel } from './route'
import type { Tier } from './route'
import { costOf, defaults, merge, tokensOf } from './rules'
import type { Rules } from './rules'

const PLUGIN = 'model-router'
const PANE = PLUGIN
const RULE_FILE = '.claude/model-router.json'

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

const load = async ($: EngineInterface): Promise<Loaded> => {
  const home =
    (await $.env.get('USERPROFILE').catch(() => undefined)) ??
    (await $.env.get('HOME').catch(() => undefined))
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

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'router',
      description:
        'Model routing: report, `pane`, `on`, `off`, `rules`, `reload`',
    })
    void rulesOf($)

    return next(e)
  })

  on('command.run', { command: 'router' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()

    if (arg === 'off' || arg === 'on') {
      await update($, isPaused, () => arg === 'off')
      $.ui.status(arg === 'off' ? 'router: paused' : undefined)

      return { text: `Model routing is ${arg}.` }
    }
    if (arg === 'pane') {
      await $.ui.open({ id: PANE, title: 'Model router' })

      return { text: 'Model router pane opened.' }
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
        `Fallback ${MODEL_OF[fallback]}, classifier ${hasModelClassifier ? 'rules+model' : 'rules'}, nudge ${hasNudge ? 'on' : 'off'}, escalation ${hasEscalation ? 'on' : 'off'}.`,
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

    const model = tier === undefined ? undefined : modelFor(tier, e.parentModel)
    if (model === undefined) return next(e)

    // A teammate idles between turns and answers by message: no handoff there.
    const senior =
      hasEscalation && e.isTeammate !== true ? seniorOf(model, e.parentModel) : undefined
    const started = await next({
      ...e,
      model,
      prompt: senior === undefined ? e.prompt : e.prompt + protocol(senior),
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
    const status =
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
