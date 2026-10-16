import { expect, test } from 'claude-code/testing'
import type { AgentSpawnInput, TurnCompleteInput } from 'claude-code'

import { handoffOf, protocol, seniorBrief } from '../hooks/handoff'
import { judge, modelFor, seniorOf } from '../hooks/route'
import { costOf, defaults, merge } from '../hooks/rules'

const OPUS = 'claude-opus-5-5'
const SONNET = 'claude-sonnet-5-5'

const task = (over: Partial<AgentSpawnInput>): AgentSpawnInput => ({
  tool_use_id: 'toolu_1',
  prompt: '',
  description: '',
  subagentType: 'general-purpose',
  provider: { plugin: 'engine', tier: 'core' },
  parentModel: OPUS,
  background: false,
  fork: false,
  ...over,
})

const usage = (model: string) => ({
  model,
  input_tokens: 1_000_000,
  output_tokens: 100_000,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
})

const ended = (agentId: string, answer: string, model: string): TurnCompleteInput => ({
  answer,
  durationMs: 1000,
  isAborted: false,
  turnId: `turn_${agentId}`,
  reason: 'answer',
  agentId,
  usage: usage(model),
})

const REPORT = {
  command: 'router',
  args: '',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 120 },
} as const

const STUCK = [
  'I could not fix it.',
  '',
  '## ESCALATION HANDOFF',
  '### What went wrong',
  'The retry test still fails with ETIMEDOUT after both attempts.',
].join('\n')

test('the rules place a task by its words', () => {
  expect(judge(task({ prompt: 'Scrape the pricing table from https://example.com' })).tier).toBe('scout')
  expect(judge(task({ prompt: 'Implement the retry helper and add tests' })).tier).toBe('builder')
  expect(judge(task({ prompt: 'Weigh the trade-offs and propose a system design' })).tier).toBe('architect')
  expect(judge(task({ prompt: 'Design the architecture, then implement it' })).tier).toBe('architect')
  expect(judge(task({ prompt: 'Scrape the site and write a script that parses it' })).tier).toBe('builder')
  expect(judge(task({ prompt: 'Handle it.' })).isOpen).toBe(true)
})

test('the rules leave alone what is not theirs', () => {
  expect(judge(task({ model: 'opus', prompt: 'Scrape the web' })).tier).toBeUndefined()
  expect(judge(task({ fork: true, prompt: 'Scrape the web' })).tier).toBeUndefined()
  expect(judge(task({ subagentType: 'xvant-review-security', prompt: 'Scrape the web' })).tier).toBeUndefined()
  expect(judge(task({ subagentType: 'Explore', prompt: 'anything' })).tier).toBe('scout')
  expect(judge(task({ subagentType: 'Plan', prompt: 'anything' })).tier).toBe('architect')
})

test('the router only routes down, and escalates one tier at a time', () => {
  expect(modelFor('architect', SONNET)).toBeUndefined()
  expect(modelFor('scout', SONNET)).toBe('haiku')
  expect(modelFor('architect', 'claude-fable-5-1')).toBe('opus')
  expect(seniorOf('haiku', OPUS)).toBe('sonnet')
  expect(seniorOf('sonnet', OPUS)).toBe('opus')
  expect(seniorOf('opus', OPUS)).toBeUndefined()
  expect(seniorOf('sonnet', SONNET)).toBeUndefined()
})

test('a rule file places agents, adds keywords and reprices, and names what it misspells', () => {
  const { rules, problems } = merge(
    defaults(),
    JSON.stringify({
      agents: { 'xvant-review-security': 'opus', mine: 'classify', bad: 'gpt' },
      keywords: { scout: ['Pricing Page'], architect: ['rfc'], nope: ['x'] },
      prices: { sonnet: { input: 3, output: 15 } },
    }),
  )

  expect(judge(task({ subagentType: 'xvant-review-security' }), rules).tier).toBe('architect')
  expect(judge(task({ subagentType: 'mine', prompt: 'Read the pricing page' }), rules).tier).toBe('scout')
  expect(judge(task({ prompt: 'Draft the RFC' }), rules).tier).toBe('architect')
  expect(Math.round((rules.prices.sonnet?.cacheRead ?? 0) * 100)).toBe(30)
  expect(rules.prices.sonnet?.output).toBe(15)
  expect(problems.length).toBe(2)
  expect(merge(defaults(), '{ nope').problems).toEqual(['not valid JSON'])
})

test('a run is priced by its model family', () => {
  expect(costOf(usage(OPUS), OPUS, defaults())).toBe(6)
  expect(costOf(usage(OPUS), 'sonnet', defaults())).toBe(3)
  expect(costOf(usage(OPUS), 'some-other-model', defaults())).toBeUndefined()
})

test('a handoff is found in an answer and carried whole into the senior brief', () => {
  expect(handoffOf('All done, tests pass.')).toBeUndefined()
  const handoff = handoffOf(STUCK) ?? ''
  expect(handoff.startsWith('## ESCALATION HANDOFF')).toBe(true)

  const brief = seniorBrief('Fix the retry test', handoff, 'sonnet')
  expect(brief).toContain('## Original task\nFix the retry test')
  expect(brief).toContain("## Junior's handoff")
  expect(brief).toContain('ETIMEDOUT')
  // The senior must not read its own brief as an escalation.
  expect(handoffOf(brief)).toBeUndefined()
  expect(handoffOf(protocol('opus'))).toBeDefined()
})

test('a spawn runs on the model its task fits', async ($, on) => {
  const seen: (string | undefined)[] = []
  on('agent.spawn', (_, e) => {
    seen.push(e.model)

    return { model: e.model ?? e.parentModel, agentId: `agent_${seen.length}` }
  })

  await $.agent.spawn(task({ description: 'Scrape docs', prompt: 'Fetch the changelog from the web' }))
  await $.agent.spawn(task({ description: 'Build helper', prompt: 'Implement the parser and fix the tests' }))
  await $.agent.spawn(task({ description: 'Misc', prompt: 'Handle it.' }))
  await $.agent.spawn(task({ subagentType: 'xvant-review-verifier', prompt: 'Scrape the web' }))
  await $.agent.spawn(task({ parentModel: SONNET, prompt: 'Propose a system design' }))

  expect(seen).toEqual(['haiku', 'sonnet', 'sonnet', undefined, undefined])
})

test('/router off pauses routing and on resumes it', async ($, on) => {
  const seen: (string | undefined)[] = []
  on('agent.spawn', (_, e) => {
    seen.push(e.model)

    return { model: e.model ?? e.parentModel }
  })

  await $.command.run({ ...REPORT, args: 'off' })
  await $.agent.spawn(task({ prompt: 'Scrape the web' }))
  await $.command.run({ ...REPORT, args: 'on' })
  await $.agent.spawn(task({ prompt: 'Scrape the web' }))

  expect(seen).toEqual([undefined, 'haiku'])
  expect((await $.command.run(REPORT)).text).toContain('haiku 1')
  expect((await $.command.run({ ...REPORT, args: 'rules' })).text).toContain('haiku 1/5')
})

test('the fallback option decides a task with no signal', { options: { fallback: 'haiku' } }, async ($, on) => {
  const seen: (string | undefined)[] = []
  on('agent.spawn', (_, e) => {
    seen.push(e.model)

    return { model: e.model ?? e.parentModel }
  })

  await $.agent.spawn(task({ prompt: 'Handle it.' }))

  expect(seen).toEqual(['haiku'])
})

test('a routed subagent is told how to escalate, except where nobody is above it', async ($, on) => {
  const prompts: string[] = []
  on('agent.spawn', (_, e) => {
    prompts.push(e.prompt)

    return { model: e.model ?? e.parentModel, agentId: `agent_${prompts.length}` }
  })

  await $.agent.spawn(task({ prompt: 'Implement the parser' }))
  await $.agent.spawn(task({ subagentType: 'Plan', prompt: 'Plan it' }))
  await $.agent.spawn(task({ parentModel: SONNET, prompt: 'Implement the parser' }))

  expect(prompts[0]).toContain('## ESCALATION HANDOFF')
  expect(prompts[0]).toContain('(opus)')
  expect(prompts[1]).toBe('Plan it')
  expect(prompts[2]).toBe('Implement the parser')
})

test('escalation off leaves the prompt as given', { options: { escalate: false } }, async ($, on) => {
  const prompts: string[] = []
  on('agent.spawn', (_, e) => {
    prompts.push(e.prompt)

    return { model: e.model ?? e.parentModel, agentId: 'agent_1' }
  })

  await $.agent.spawn(task({ prompt: 'Implement the parser' }))

  expect(prompts).toEqual(['Implement the parser'])
})

test('a stuck junior hands over to the senior with its report', async ($, on) => {
  const spawns: { model?: string; prompt: string }[] = []
  on('agent.spawn', (_, e) => {
    spawns.push({ model: e.model, prompt: e.prompt })

    return { model: e.model ?? e.parentModel, agentId: `agent_${spawns.length}` }
  })
  on('turn.complete', (_, e) => ({ text: e.answer }))

  await $.agent.spawn(task({ description: 'Fix retry test', prompt: 'Fix the retry test' }))
  await $.turn.complete(ended('agent_1', STUCK, SONNET))

  expect(spawns.length).toBe(2)
  expect(spawns[1]?.model).toBe('opus')
  expect(spawns[1]?.prompt).toContain('## Original task\nFix the retry test')
  expect(spawns[1]?.prompt).toContain('ETIMEDOUT')
  // Nobody is above opus here, so the senior gets no protocol of its own.
  expect(handoffOf(spawns[1]?.prompt ?? '')).toBeUndefined()

  const report = (await $.command.run(REPORT)).text ?? ''
  expect(report).toContain('escalated')
  expect(report).toContain('Senior takeover: Fix retry test')
  // The junior's $3 run bought only a report.
  expect(report).toContain('saved ~-$3.00')

  // A second end of the same run does not escalate twice.
  await $.turn.complete(ended('agent_1', STUCK, SONNET))
  expect(spawns.length).toBe(2)
})

test('a junior that finishes is not escalated', async ($, on) => {
  let spawns = 0
  on('agent.spawn', (_, e) => {
    spawns += 1

    return { model: e.model ?? e.parentModel, agentId: `agent_${spawns}` }
  })
  on('turn.complete', (_, e) => ({ text: e.answer }))

  await $.agent.spawn(task({ prompt: 'Fix the retry test' }))
  await $.turn.complete(ended('agent_1', 'Fixed: the mock clock was never advanced.', SONNET))

  expect(spawns).toBe(1)
})

test('a finished run counts what it saved against the parent model', async ($, on) => {
  on('agent.spawn', (_, e) => ({ model: e.model ?? e.parentModel, agentId: 'agent_1' }))
  on('turn.complete', (_, e) => ({ text: e.answer }))

  await $.agent.spawn(task({ description: 'Build helper', prompt: 'Implement the parser' }))
  await $.turn.complete(ended('agent_1', 'Done.', SONNET))

  const report = await $.command.run(REPORT)
  expect(report.text).toContain('saved ~$3.00')
  expect(report.text).toContain('done')
})

test('the pane lists the routes on every surface', async ($, on) => {
  on('agent.spawn', (_, e) => ({ model: e.model ?? e.parentModel, agentId: 'agent_1' }))
  await $.agent.spawn(task({ description: 'Scrape docs', prompt: 'Scrape the web' }))

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'model-router',
      surface,
      component: 'Pane',
      requestId: 'model-router',
      props: {
        title: 'Model router',
        isFocused: false,
        bodyColumns: 60,
        placement: 'dock',
        scroll: { offset: 0, bodyRows: 20 },
        view: {},
      },
    })
    expect(await ui.find({ type: 'Text', text: /Scrape docs/ })).toBeDefined()
    await ui.press({ key: 'pause' })
    expect((await ui.find({ key: 'pause' }))?.text).toContain('Resume')
    await ui.press({ key: 'pause' })
    await ui.unmount()
  }
})

test('a rule-file keyword matches whole words only', () => {
  const { rules } = merge(defaults(), JSON.stringify({ keywords: { architect: ['adr', 'wire up'] } }))
  expect(judge(task({ prompt: 'Look up the address' }), rules).tier).toBe('scout')
  expect(judge(task({ prompt: 'Write an ADR for the queue' }), rules).tier).toBe('architect')
  expect(judge(task({ prompt: 'Look up the wire uploader' }), rules).tier).toBe('scout')
})

test('a rule file cannot reach the object prototype', () => {
  const { rules } = merge(
    defaults(),
    '{"agents":{"__proto__":"haiku"},"prices":{"__proto__":{"input":0,"output":0}}}',
  )
  expect(Object.getPrototypeOf(rules.prices)).toBe(null)
  expect(judge(task({ subagentType: 'toString', prompt: 'Scrape the web' }), rules).tier).toBe(undefined)
  expect(judge(task({ subagentType: 'constructor', prompt: 'Scrape the web' })).tier).toBe(undefined)
})
