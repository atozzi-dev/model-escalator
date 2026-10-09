import { expect, mock, test } from 'claude-code/testing'
import { resetState } from '../hooks/register'

type Harness = { spawnModels: (string | undefined)[]; spawnPrompts: string[] }

// Wires the fake core: spawns hand back ids, the Bash tool always fails, the lead's steps run on sonnet.
function wire(on: any, env: Record<string, string>): Harness {
  resetState()
  mock.env(on, env)
  mock.store(on)
  on('session.start', () => ({ cwd: '/work' }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  const h: Harness = { spawnModels: [], spawnPrompts: [] }
  let n = 0
  on('agent.spawn', (_$: unknown, e: any) => {
    h.spawnModels.push(e.model)
    h.spawnPrompts.push(e.prompt)
    return { model: e.model ?? 'opus', agentId: 'a' + ++n } as never
  })
  on('tool.call', () => ({ isError: true, result: 'Error: boom', text: 'Error: boom' }) as never)
  on('model.complete', () => ({ value: { isAnswered: true, text: 'advice' } }) as never)
  on('turn.complete', () => ({ text: 'done' }) as never)
  on('turn.step', async function* (_$: unknown, e: any) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn',
      usage: { model: e.model, input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } as never
  })
  on('ui.log', () => ({ value: undefined }) as never)
  for (const k of ['ui.toast', 'ui.status'] as const) on(k, () => ({ value: undefined }) as never)
  return h
}

// A fork inherits the parent's model and context: the engine sets fork and ignores model.
async function fork($: any, prompt = 'continue the refactor'): Promise<string> {
  const r = await $.agent.spawn({ prompt, description: 'fork', subagentType: 'fork', model: 'haiku', fork: true } as never) as { agentId: string }
  return r.agentId
}

async function normal($: any, model = 'haiku'): Promise<string> {
  const r = await $.agent.spawn({ prompt: 'p', description: 'fix db test', subagentType: 'general-purpose', model } as never) as { agentId: string }
  return r.agentId
}

async function stuck($: any, agentId: string, calls = 12): Promise<string[]> {
  const notes: string[] = []
  for (let i = 0; i < calls; i++) {
    const r = await $.tool.call({ tool: 'Bash', command: 'npm test', agentId } as never) as { context?: readonly string[] }
    for (const c of r.context ?? []) notes.push(c)
  }
  return notes
}

const escalator = async ($: any) =>
  (await $.command.run({ command: 'escalator', args: 'report', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } } as never) as { text: string }).text

test('fork spawn keeps its prompt and model, even in baseline mode', async ($, on) => {
  const h = wire(on, { MODEL_ESCALATOR_MODE: 'baseline', MODEL_ESCALATOR_BASELINE: 'sonnet' })
  await $.session.start({ cwd: '/work' } as never)
  await fork($)
  expect(h.spawnPrompts[0]).toBe('continue the refactor')
  expect(h.spawnModels[0]).toBe('haiku')
})

test('fork spawn gets no supervision announcement in active mode', async ($, on) => {
  const h = wire(on, {})
  await $.session.start({ cwd: '/work' } as never)
  await fork($)
  expect(h.spawnPrompts[0]).toBe('continue the refactor')
  expect(h.spawnModels[0]).toBe('haiku')
})

test('fork is never nudged, consulted or swapped, even when its tool calls keep failing', async ($, on) => {
  wire(on, {})
  await $.session.start({ cwd: '/work' } as never)
  const id = await fork($)
  const notes = await stuck($, id, 30)
  expect(notes.length).toBe(0)
  expect(await escalator($)).toContain('Interventions: none')
})

test('a normal spawn is still tracked and nudged', async ($, on) => {
  const h = wire(on, {})
  await $.session.start({ cwd: '/work' } as never)
  const id = await normal($)
  expect(h.spawnPrompts[0]!.startsWith('p\n\n')).toBe(true)
  const notes = await stuck($, id)
  expect(notes.length).toBeGreaterThan(0)
})
