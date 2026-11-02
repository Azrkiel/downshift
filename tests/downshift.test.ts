import { expect, test } from 'claude-code/testing'
import type { AgentSpawnInput, On, TurnCompleteInput } from 'claude-code'

import { delegating } from '../hooks/delegate'
import { handoffOf, protocol, seniorBrief } from '../hooks/handoff'
import { judge, modelFor, seniorOf } from '../hooks/route'
import { fresh, parse, serialize } from '../hooks/learnstore'
import { costOf, defaults, longPromptExtra, merge, ratioOf } from '../hooks/rules'

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
  command: 'downshift',
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

test('the mod only routes down, and escalates one tier at a time', () => {
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

test('/downshift off pauses routing and on resumes it', async ($, on) => {
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
  expect((await $.command.run({ ...REPORT, args: 'rules' })).text).toContain('haiku 0.1/0.5')
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
      plugin: 'downshift',
      surface,
      component: 'Pane',
      requestId: 'downshift',
      props: {
        title: 'Downshift',
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

const STATE = 'C:/home/.claude/downshift-state.json'

/** A fake home folder and disk under the mod's `$.env` and `$.fs`; paths arrive with either slash. */
const disk = (on: On, files: Map<string, string>) => {
  const key = (path: string) => path.replace(/\\/g, '/')
  on('env.get', (_, e) => ({ value: e.name === 'USERPROFILE' ? 'C:/home' : undefined }))
  on('fs.exists', (_, e) => ({ value: files.has(key(e.path)) }))
  on('fs.read', (_, e) => {
    const text = files.get(key(e.path))

    return text === undefined ? { deny: 'ENOENT' } : { value: text }
  })
  on('fs.write', (_, e) => {
    files.set(key(e.path), e.text)

    return { value: undefined }
  })
}

const routed = (on: On) => {
  const seen: (string | undefined)[] = []
  on('agent.spawn', (_, e) => {
    seen.push(e.model)

    return { model: e.model ?? e.parentModel, agentId: `agent_${seen.length}` }
  })

  return seen
}

const learned = (buckets: Partial<ReturnType<typeof fresh>>) =>
  new Map([[STATE, serialize({ ...fresh(), ...buckets })]])

test('prices give the break-even ratio', () => {
  expect(ratioOf(defaults())('haiku', 'sonnet')).toBe(0.05)
  expect(ratioOf(defaults())('sonnet', 'opus')).toBe(0.5)
  expect(ratioOf(merge(defaults(), '{"prices":{"sonnet":{"input":4,"output":20}}}').rules)('haiku', 'sonnet')).toBe(0.025)
})

test('a record moves a placed task down a tier', async ($, on) => {
  disk(on, learned({ open: { haiku: { alpha: 31, beta: 1 } } }))
  const seen = routed(on)
  await $.agent.spawn(task({ description: 'Misc', prompt: 'Handle it.' }))
  expect(seen).toEqual(['haiku'])
  expect((await $.command.run(REPORT)).text).toContain('learned: haiku handles these')
})

test('build work never moves down to haiku, by record or by probe', async ($, on) => {
  disk(on, learned({ builder: { haiku: { alpha: 31, beta: 1 } } }))
  storeOn(on)
  const seen = routed(on)
  for (let i = 0; i < 10; i++) await $.agent.spawn(task({ prompt: 'Implement the parser' }))
  expect(seen.every(model => model === 'sonnet')).toBe(true)
})

test('a record moves a placed task up a tier, within the session model', async ($, on) => {
  disk(on, learned({ builder: { sonnet: { alpha: 1, beta: 31 } } }))
  const seen = routed(on)
  await $.agent.spawn(task({ prompt: 'Implement the parser' }))
  await $.agent.spawn(task({ parentModel: SONNET, prompt: 'Implement the parser' }))
  expect(seen).toEqual(['opus', 'sonnet'])
})

test('shadow learning keeps the rules and says what it would pick', { options: { learning: 'shadow' } }, async ($, on) => {
  disk(on, learned({ open: { haiku: { alpha: 31, beta: 1 } } }))
  const seen = routed(on)
  await $.agent.spawn(task({ prompt: 'Handle it.' }))
  expect(seen).toEqual(['sonnet'])
  expect((await $.command.run(REPORT)).text).toContain('learned would pick haiku')
})

test('a pinned or fixed agent is never learned', async ($, on) => {
  disk(on, learned({ scout: { haiku: { alpha: 1, beta: 31 } } }))
  const seen = routed(on)
  await $.agent.spawn(task({ subagentType: 'Explore', prompt: 'Find the config' }))
  expect(seen).toEqual(['haiku'])
})

test('answers and handoffs are written to the record', async ($, on) => {
  const files = new Map<string, string>()
  disk(on, files)
  routed(on)
  on('turn.complete', (_, e) => ({ text: e.answer }))
  // A spawn the plugin makes itself gets its id back from the agent list.
  on('agent.list', () => ({ value: [
    { id: 'agent_2', description: 'Senior takeover: ', type: 'general-purpose', status: 'running', spawnedBy: 'downshift' },
  ] }))

  await $.agent.spawn(task({ prompt: 'Fix the retry test' }))
  await $.turn.complete(ended('agent_1', STUCK, SONNET))
  // The senior's hand-back submits a prompt the harness has no hook for; the
  // record is written before that, so only the record is checked here.
  await $.turn.complete(ended('agent_2', 'Fixed: the clock was never advanced.', OPUS)).catch(() => undefined)

  const saved = parse(files.get(STATE) ?? '')
  expect('learned' in saved).toBe(true)
  if (!('learned' in saved)) return
  expect(saved.learned.builder.sonnet).toEqual({ alpha: 1, beta: 2 })
  // Opus had nobody to hand over to, so its answer could not have failed: not counted.
  expect(saved.learned.builder.opus).toBeUndefined()
})

test('a run that cannot escalate is not counted', { options: { escalate: false } }, async ($, on) => {
  const files = new Map<string, string>()
  disk(on, files)
  routed(on)
  on('turn.complete', (_, e) => ({ text: e.answer }))
  await $.agent.spawn(task({ prompt: 'Implement the parser' }))
  await $.turn.complete(ended('agent_1', 'Done.', SONNET))
  expect(files.has(STATE)).toBe(false)
})

test('one load counts at most three outcomes per bucket', async ($, on) => {
  const files = new Map<string, string>()
  disk(on, files)
  routed(on)
  on('turn.complete', (_, e) => ({ text: e.answer }))
  for (let i = 1; i <= 4; i++) {
    await $.agent.spawn(task({ prompt: 'Implement the parser' }))
    await $.turn.complete(ended(`agent_${i}`, 'Done.', SONNET))
  }
  const saved = parse(files.get(STATE) ?? '')
  const sonnet = 'learned' in saved ? saved.learned.builder.sonnet : undefined
  expect(sonnet !== undefined && Math.abs(sonnet.alpha - 1 - (1 + 0.97 + 0.97 ** 2)) < 1e-9).toBe(true)
})

test('an untrusted record file is left alone', async ($, on) => {
  const files = new Map([[STATE, 'garbage']])
  disk(on, files)
  routed(on)
  on('turn.complete', (_, e) => ({ text: e.answer }))
  await $.agent.spawn(task({ prompt: 'Implement the parser' }))
  await $.turn.complete(ended('agent_1', 'Done.', SONNET))
  expect(files.get(STATE)).toBe('garbage')
  expect((await $.command.run({ ...REPORT, args: 'learn' })).text).toContain('not valid JSON')
  await $.command.run({ ...REPORT, args: 'learn reset' })
  expect(parse(files.get(STATE) ?? '')).toEqual({ learned: fresh() })
})

/** A fake `$.store`, so a test can seed what an earlier session left. */
const storeOn = (on: On, values: Map<string, unknown> = new Map()) => {
  on('store.get', (_, e) => ({ value: values.get(e.key) }))
  on('store.set', (_, e) => {
    values.set(e.key, e.value)

    return { value: undefined }
  })

  return values
}

test('every fifth placed task in a bucket probes the tier below', async ($, on) => {
  storeOn(on)
  const seen = routed(on)
  for (let i = 0; i < 10; i++) await $.agent.spawn(task({ prompt: 'Handle it.' }))
  expect(seen.filter(model => model === 'haiku').length).toBe(2)
  expect(seen[4]).toBe('haiku')
  expect(seen[9]).toBe('haiku')
})

test('the probe count carries over from earlier sessions', async ($, on) => {
  const values = storeOn(on, new Map([['placed.open', 4]]))
  const seen = routed(on)
  await $.agent.spawn(task({ prompt: 'Handle it.' }))
  expect(seen).toEqual(['haiku'])
  expect(values.get('placed.open')).toBe(5)
})

test('with no store the probe count still runs for the load', async ($, on) => {
  on('store.get', () => ({ deny: 'no store' }))
  on('store.set', () => ({ deny: 'no store' }))
  const seen = routed(on)
  for (let i = 0; i < 5; i++) await $.agent.spawn(task({ prompt: 'Handle it.' }))
  expect(seen[4]).toBe('haiku')
})

test('a probe is counted even after the plain outcomes hit their cap', async ($, on) => {
  const files = new Map<string, string>()
  disk(on, files)
  storeOn(on)
  routed(on)
  on('turn.complete', (_, e) => ({ text: e.answer }))
  for (let i = 1; i <= 5; i++) {
    await $.agent.spawn(task({ prompt: 'Handle it.' }))
    await $.turn.complete(ended(`agent_${i}`, 'Done.', 'claude-haiku-5-5'))
  }
  const saved = parse(files.get(STATE) ?? '')
  const haiku = 'learned' in saved ? saved.learned.open.haiku : undefined
  expect(haiku).toEqual({ alpha: 2, beta: 1 })
})

test('no probe without an escalation to catch it', { options: { escalate: false } }, async ($, on) => {
  storeOn(on)
  const seen = routed(on)
  for (let i = 0; i < 10; i++) await $.agent.spawn(task({ prompt: 'Handle it.' }))
  expect(seen.includes('haiku')).toBe(false)
})

const LONG_TASK =
  'Implement the signin signout and settings pages in the web app, then add tests covering each route and run the suite'

test('a task sent again under the same parent counts against the model that answered it', async ($, on) => {
  const files = new Map<string, string>()
  disk(on, files)
  const values = storeOn(on)
  const seen = routed(on)
  on('turn.complete', (_, e) => ({ text: e.answer }))

  await $.agent.spawn(task({ description: 'T3 pages', prompt: LONG_TASK }))
  await $.turn.complete(ended('agent_1', 'Done.', SONNET))
  await $.agent.spawn(task({ description: 'T3 pages (retry)', prompt: LONG_TASK }))
  await $.agent.spawn(task({ description: 'T3 pages (retry)', prompt: LONG_TASK }))

  expect(seen.length).toBe(3)
  const saved = parse(files.get(STATE) ?? '')
  const sonnet = 'learned' in saved ? saved.learned.builder.sonnet : undefined
  // One success faded, then one failure: the third spawn does not count the run twice.
  expect(sonnet?.beta).toBe(2)
  const report = (await $.command.run(REPORT)).text ?? ''
  expect(report).toContain('redone')
  // The $3 run bought nothing, the same as an escalated one.
  expect(report).toContain('saved ~-$3.00')
  expect((values.get('ledger') as { days: Record<string, { redone: number; saved: number }> }).days).toBeDefined()
  expect((await $.command.run({ ...REPORT, args: 'savings' })).text).toContain('1 redone')
})

test('a call that names a model still counts as a redo', async ($, on) => {
  const files = new Map<string, string>()
  disk(on, files)
  storeOn(on)
  routed(on)
  on('turn.complete', (_, e) => ({ text: e.answer }))
  await $.agent.spawn(task({ description: 'T3 pages', prompt: LONG_TASK }))
  await $.turn.complete(ended('agent_1', 'Done.', SONNET))
  await $.agent.spawn(task({ description: 'T3 pages', prompt: LONG_TASK, model: 'opus' }))
  const saved = parse(files.get(STATE) ?? '')
  expect('learned' in saved ? saved.learned.builder.sonnet?.beta : undefined).toBe(2)
})

test('a parallel twin or another parent is not a redo', async ($, on) => {
  const files = new Map<string, string>()
  disk(on, files)
  storeOn(on)
  routed(on)
  on('turn.complete', (_, e) => ({ text: e.answer }))
  // Still running when its twin starts: nothing finished to redo.
  await $.agent.spawn(task({ description: 'T3 pages', prompt: LONG_TASK }))
  await $.agent.spawn(task({ description: 'T3 pages', prompt: LONG_TASK }))
  await $.turn.complete(ended('agent_1', 'Done.', SONNET))
  // A different manager's worker has the same words but is someone else's call.
  await $.agent.spawn(task({ parentAgentId: 'manager_1', description: 'T3 pages', prompt: LONG_TASK }))
  const saved = parse(files.get(STATE) ?? '')
  expect('learned' in saved ? saved.learned.builder.sonnet?.beta : undefined).toBe(1)
  expect(((await $.command.run(REPORT)).text ?? '').includes('redone')).toBe(false)
})

test('an escalated run is not also a redo', async ($, on) => {
  const files = new Map<string, string>()
  disk(on, files)
  storeOn(on)
  routed(on)
  on('turn.complete', (_, e) => ({ text: e.answer }))
  await $.agent.spawn(task({ parentAgentId: 'manager_1', description: 'T3 pages', prompt: LONG_TASK }))
  await $.turn.complete(ended('agent_1', STUCK, SONNET))
  // The manager re-dispatches as the protocol tells it to.
  await $.agent.spawn(task({ parentAgentId: 'manager_1', description: 'T3 pages', prompt: LONG_TASK, model: 'opus' }))
  const saved = parse(files.get(STATE) ?? '')
  expect('learned' in saved ? saved.learned.builder.sonnet?.beta : undefined).toBe(2)
})

const longUsage = {
  model: 'claude-haiku-5-5',
  input_tokens: 10,
  output_tokens: 1_000_000,
  cache_read_input_tokens: 90_000,
  cache_creation_input_tokens: 10_000,
}

test('Haiku long-prompt pricing counts cache tokens and applies to one response', () => {
  const rules = defaults()
  const base = costOf(longUsage, 'haiku', rules) ?? 0
  expect(Math.abs(longPromptExtra(longUsage, 'claude-haiku-5-5', rules) - base * 4) < 1e-9).toBe(true)
  expect(longPromptExtra({ ...longUsage, input_tokens: 0 }, 'claude-haiku-5-5', rules)).toBe(0)
  expect(longPromptExtra(longUsage, SONNET, rules)).toBe(0)
})

test('a routed Haiku run pays the long-prompt rate per response', async ($, on) => {
  storeOn(on)
  on('agent.spawn', (_, e) => ({ model: e.model ?? e.parentModel, agentId: 'agent_1' }))
  on('turn.step', async function* (_, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: 'Found it.',
      toolUses: [],
      stopReason: 'end_turn' as const,
      usage: longUsage,
    }
  })
  on('turn.complete', (_, e) => ({ text: e.answer }))

  await $.agent.spawn(task({ description: 'Find config', prompt: 'Find the config' , subagentType: 'Explore' }))
  const stream = $.turn.step({ turnId: 'turn_1', index: 0, model: 'haiku', messageCount: 1, agentId: 'agent_1' })
  for await (const _chunk of stream) void _chunk
  await $.turn.complete({ ...ended('agent_1', 'Found it.', 'claude-haiku-5-5'), usage: longUsage })

  const report = (await $.command.run(REPORT)).text ?? ''
  // 1M output is $0.50 at the short rate and $2.50 at the long one: $20 on opus, so $17.5x saved, not $19.5x.
  expect(report).toContain('saved ~$17.')
})

test('the ledger keeps what was saved across sessions', async ($, on) => {
  const earlier = { version: 1, days: { '2026-10-30': { runs: 1, tokens: 1, cost: 1, base: 3, saved: 2, escalated: 0, redone: 0 } } }
  const values = storeOn(on, new Map<string, unknown>([['ledger', earlier]]))
  on('agent.spawn', (_, e) => ({ model: e.model ?? e.parentModel, agentId: 'agent_1' }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  await $.agent.spawn(task({ description: 'Build helper', prompt: 'Implement the parser' }))
  await $.turn.complete(ended('agent_1', 'Done.', SONNET))

  const text = (await $.command.run({ ...REPORT, args: 'savings' })).text ?? ''
  expect(text).toContain('saved ~$5.00')
  expect(text).toContain('since 2026-10-30')
  expect((await $.command.run(REPORT)).text).toContain('Since 2026-10-30')
  expect(Object.keys((values.get('ledger') as { days: object }).days).length >= 1).toBe(true)
})

test('a store that fails leaves routing and the session report working', async ($, on) => {
  on('store.get', () => ({ deny: 'no store' }))
  on('store.set', () => ({ deny: 'no store' }))
  on('agent.spawn', (_, e) => ({ model: e.model ?? e.parentModel, agentId: 'agent_1' }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  await $.agent.spawn(task({ description: 'Build helper', prompt: 'Implement the parser' }))
  await $.turn.complete(ended('agent_1', 'Done.', SONNET))
  expect((await $.command.run(REPORT)).text).toContain('saved ~$3.00')
  expect((await $.command.run({ ...REPORT, args: 'savings' })).text).toContain('Nothing recorded yet')
})

const measure = (percentUsed: number) => ({
  context: { window: 200_000 },
  rateLimits: [{ kind: 'five_hour', percentUsed }],
  changed: ['rateLimits' as const],
})

test('a nearly spent window moves placed tasks a tier down', async ($, on) => {
  const seen = routed(on)
  on('session.measure', (_, e) => ({ changed: e.changed }))
  await $.session.measure(measure(80))
  await $.agent.spawn(task({ prompt: 'Handle it.' }))
  await $.agent.spawn(task({ prompt: 'Implement the parser' }))
  await $.session.measure(measure(95))
  await $.agent.spawn(task({ prompt: 'Implement the parser' }))
  await $.agent.spawn(task({ subagentType: 'Plan', prompt: 'Plan it' }))
  expect(seen).toEqual(['haiku', 'sonnet', 'haiku', 'opus'])
})

test('rate-limit protection can be turned off', { options: { budgetShift: false } }, async ($, on) => {
  const seen = routed(on)
  on('session.measure', (_, e) => ({ changed: e.changed }))
  await $.session.measure(measure(95))
  await $.agent.spawn(task({ prompt: 'Implement the parser' }))
  expect(seen).toEqual(['sonnet'])
})

test('code in a task with no signal words places it with the builders', () => {
  expect(judge(task({ prompt: 'Traceback (most recent call last):\n  File "app.py", line 3' })).tier).toBe('builder')
  expect(judge(task({ prompt: 'See src/router.ts:214 and handle it' })).tier).toBe('builder')
  expect(judge(task({ prompt: 'Handle this:\n```\nx = 1\n```' })).isLearnable).toBe(true)
  // Prose that merely mentions code words is not code.
  expect(judge(task({ prompt: 'What class of animals are dolphins?' })).isOpen).toBe(true)
  expect(judge(task({ prompt: 'It costs\n$ 20 per seat' })).isOpen).toBe(true)
  // Words still decide first: a lookup that quotes code stays a lookup.
  expect(judge(task({ prompt: 'Find where `const x = 1` is set:\n```\nconst x = 1\n```' })).tier).toBe('scout')
})

test('Haiku is priced as Haiku 5.5', () => {
  // 1M input at $0.10 and 100k output at $0.50 per million.
  expect(Math.abs((costOf(usage('claude-haiku-5-5'), 'claude-haiku-5-5', defaults()) ?? 0) - 0.15) < 1e-9).toBe(true)
})

const AGENT_TOOL = [
  'Launch a new agent to handle complex, multi-step tasks.',
  '',
  '**Do not spawn agents unless the user asks.** Each spawn starts cold. Only use this tool when the user explicitly says to use a subagent, or names one of the available agent types.',
  '',
  'When using the Agent tool, specify a subagent_type.',
].join('\n')

test('the Agent tool asks for delegation instead of forbidding it', () => {
  const text = delegating(AGENT_TOOL)
  expect(text.includes('Do not spawn agents unless the user asks')).toBe(false)
  expect(text.includes('Only use this tool when the user explicitly says')).toBe(false)
  expect(text).toContain('downshift')
  expect(text).toContain('When using the Agent tool, specify a subagent_type.')
  // A description without the rule gets the policy added, not lost.
  expect(delegating('Launch a new agent.')).toContain('downshift')
})

test('the mod rewrites only the Agent tool, and only with the nudge on', async ($, on) => {
  on('tool.describe', (_, e) => ({ description: e.description }))
  const provider = { plugin: 'engine', tier: 'core' } as const
  expect((await $.tool.describe({ tool: 'Agent', description: AGENT_TOOL, provider })).description).toContain('downshift')
  expect((await $.tool.describe({ tool: 'Bash', description: AGENT_TOOL, provider })).description).toBe(AGENT_TOOL)
})

test('with the nudge off the Agent tool keeps its own words', { options: { nudge: false } }, async ($, on) => {
  on('tool.describe', (_, e) => ({ description: e.description }))
  const provider = { plugin: 'engine', tier: 'core' } as const
  expect((await $.tool.describe({ tool: 'Agent', description: AGENT_TOOL, provider })).description).toBe(AGENT_TOOL)
})

test('a worker under a manager hands a stuck task back to its parent', async ($, on) => {
  const spawns: { model?: string; prompt: string }[] = []
  on('agent.spawn', (_, e) => {
    spawns.push({ model: e.model, prompt: e.prompt })

    return { model: e.model ?? e.parentModel, agentId: `agent_${spawns.length}` }
  })
  on('turn.complete', (_, e) => ({ text: e.answer }))

  await $.agent.spawn(task({ parentAgentId: 'manager_1', prompt: 'Fix the retry test' }))
  expect(spawns[0]?.prompt).toContain('the agent that spawned you')
  expect(spawns[0]?.prompt.includes('dispatched automatically')).toBe(false)

  await $.turn.complete(ended('agent_1', STUCK, SONNET))
  // No takeover: the mod cannot deliver a senior's answer to a subagent.
  expect(spawns.length).toBe(1)
  expect((await $.command.run(REPORT)).text).toContain('escalated')
})
