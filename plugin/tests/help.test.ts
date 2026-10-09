import { expect, mock, test } from 'claude-code/testing'
import { announcement } from '../hooks/channel'
import { HELP_TOOL, resetState } from '../hooks/register'

type Harness = { consults: number; prompts: string[]; logs: string[]; registered: any[] }

function wire(on: any, env: Record<string, string>, reply: unknown = { isAnswered: true, text: 'try the cheaper hypothesis' }): Harness {
  resetState()
  mock.env(on, env)
  mock.store(on)
  on('session.start', () => ({ cwd: '/work' }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  const h: Harness = { consults: 0, prompts: [], logs: [], registered: [] }
  on('tool.register', (_$: unknown, e: any) => { h.registered.push(e); return { value: { tool: `mcp__model-escalator__${e.name}` } } as never })
  let n = 0
  on('agent.spawn', (_$: unknown, e: any) => ({ model: e.model ?? 'haiku', agentId: 'a' + ++n }))
  on('tool.call', () => ({ isError: true, result: 'Error: boom', text: 'Error: boom' }) as never)
  on('model.complete', (_$: unknown, e: any) => { h.consults++; h.prompts.push(String(e.prompt)); return { value: reply } as never })
  on('turn.complete', () => ({ text: 'done' }) as never)
  on('ui.log', (_$: unknown, e: any) => { h.logs.push(String(e.message ?? e.text ?? JSON.stringify(e))); return { value: undefined } as never })
  for (const k of ['ui.toast', 'ui.status'] as const) on(k, () => ({ value: undefined }) as never)
  return h
}

async function spawn($: any): Promise<string> {
  const r = await $.agent.spawn({ prompt: 'p', description: 'fix db test', subagentType: 'general-purpose', model: 'haiku' } as never) as { agentId: string }
  return r.agentId
}

const ask = async ($: any, agentId: string | undefined, input: Record<string, unknown> = { problem: 'the migration hangs', tried: 'restarted the db' }): Promise<string> => {
  const r = await $.tool.call({ tool: HELP_TOOL, ...input, ...(agentId ? { agentId } : {}) } as never) as { result?: unknown; text?: string }
  return typeof r.result === 'string' ? r.result : String(r.text ?? '')
}

async function stuck($: any, agentId: string, calls = 12): Promise<string[]> {
  const notes: string[] = []
  for (let i = 0; i < calls; i++) {
    const r = await $.tool.call({ tool: 'Bash', command: 'npm test', agentId } as never) as { context?: readonly string[] }
    for (const c of r.context ?? []) notes.push(c)
  }
  return notes
}

test('the tool is registered in active and observe, with its schema in the prompt list', async ($, on) => {
  const h = wire(on, {})
  await $.session.start({ cwd: '/work' } as never)
  expect(h.registered.length).toBe(1)
  expect(h.registered[0].name).toBe('ask_for_help')
  expect(h.registered[0].isDeferred).toBe(false)
  expect(h.registered[0].inputSchema.required).toEqual(['problem'])
})

test('observe also registers the tool', async ($, on) => {
  const o = wire(on, { MODEL_ESCALATOR_MODE: 'observe' })
  await $.session.start({ cwd: '/work' } as never)
  expect(o.registered.length).toBe(1)
})

test('baseline does not register the tool', async ($, on) => {
  const h = wire(on, { MODEL_ESCALATOR_MODE: 'baseline' })
  await $.session.start({ cwd: '/work' } as never)
  expect(h.registered.length).toBe(0)
})

test('active: a tracked agent gets tagged advice, built from its own words, and the ladder moves past consult', async ($, on) => {
  const h = wire(on, {})
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($)
  const out = await ask($, id)
  expect(out).toMatch(/^\[supervisor:[0-9a-f]{6}\] /)
  expect(out).toContain('try the cheaper hypothesis')
  expect(h.consults).toBe(1)
  expect(h.prompts[0]).toContain('the migration hangs')
  expect(h.prompts[0]).toContain('restarted the db')
  const notes = await stuck($, id)
  expect(notes.some(n => n.includes('Advice from a senior'))).toBe(false)
  expect(notes[0]).toContain('stronger model')
  const report = ((await $.command.run({ command: 'escalator', args: 'report', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } } as never)) as { text: string }).text
  expect(report).toContain('ask 1')
})

test('a second call within the grace window is refused without a new consult', async ($, on) => {
  const h = wire(on, {})
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($)
  await ask($, id)
  const again = await ask($, id)
  expect(again).toContain('already consulted')
  expect(h.consults).toBe(1)
})

test('the lead and untracked agents are told help is not available', async ($, on) => {
  const h = wire(on, {})
  await $.session.start({ cwd: '/work' } as never)
  expect(await ask($, undefined)).toContain('not available')
  expect(await ask($, 'ghost')).toContain('not available')
  expect(h.consults).toBe(0)
})

test('observe: answers neutrally, logs would-consult and never calls the model', async ($, on) => {
  const h = wire(on, { MODEL_ESCALATOR_MODE: 'observe' })
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($)
  const out = await ask($, id)
  expect(out).toContain('noted')
  expect(h.consults).toBe(0)
  expect(h.logs.some(l => l.includes('would consult'))).toBe(true)
})

test('an empty reply falls back to the generic note and still moves the level', async ($, on) => {
  const h = wire(on, {}, { isAnswered: false, reason: 'empty-reply' })
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($)
  const out = await ask($, id)
  expect(out).toContain('three different hypotheses')
  expect(h.consults).toBe(1)
  const notes = await stuck($, id)
  expect(notes[0]).toContain('stronger model')
})

test('a missing problem is still answered', async ($, on) => {
  wire(on, {})
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($)
  expect((await ask($, id, {})).length).toBeGreaterThan(0)
})

test('the announcement mentions the tool', () => {
  expect(announcement('abc123')).toContain('ask_for_help')
})
