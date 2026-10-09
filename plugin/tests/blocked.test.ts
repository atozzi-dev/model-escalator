import { expect, mock, test } from 'claude-code/testing'
import { resetState } from '../hooks/register'
import { allowedMax, isModelRefusal, newAgent, observe, pickSenior, refuseTier, revertSwap, usableTier } from '../hooks/detector'
import { DEFAULT_CONFIG } from '../hooks/config'
import { parseSnapshot } from '../hooks/state'

type Drainable = { result: Promise<unknown> } & AsyncIterable<unknown>
const drain = async (st: Drainable) => { for await (const _ of st) { /* chunks */ } return st.result }

const SONNET = 'claude-sonnet-5-5'
const answered = { isAnswered: true, text: 'advice', usage: { input_tokens: 10, output_tokens: 5 } }
const apiError = (status: number, error: string) => ({ isAnswered: false, reason: 'api-error', status, error, usage: { input_tokens: 0, output_tokens: 0 } })

type Harness = {
  stepModels: string[]; toasts: string[]; logs: string[]; calls: { model: string; maxTokens: number }[]
  // The fake engine answers a request that names `bad` with no response at all (a hook that throws is skipped by the test kit for good, so a thrown error cannot be simulated).
  bad?: string; failure: 'null'
  // Answers of $.model.complete: the probe (maxTokens 1) and the senior consults.
  probe: unknown; senior: (model: string) => unknown
}

// Fake core under the plugin: spawn, failing tool, a model that refuses one id, senior and probe calls.
function wire(on: any): Harness {
  resetState()
  mock.env(on, {})
  mock.store(on)
  on('session.start', () => ({ cwd: '/work' }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  const h: Harness = { stepModels: [], toasts: [], logs: [], calls: [], failure: 'null', probe: apiError(404, 'model_not_found'), senior: () => answered }
  let n = 0
  on('agent.spawn', (_$: unknown, e: any) => ({ model: e.model ?? 'haiku', agentId: 'a' + ++n }))
  on('tool.call', () => ({ isError: true, result: 'Error: boom', text: 'Error: boom' }) as never)
  on('model.complete', (_$: unknown, e: any) => {
    h.calls.push({ model: String(e.model), maxTokens: e.maxTokens })
    return { value: e.maxTokens === 1 ? h.probe : h.senior(String(e.model)) } as never
  })
  on('turn.complete', () => ({ text: 'done' }) as never)
  on('turn.step', async function* (_$: unknown, e: any) {
    h.stepModels.push(e.model)
    if (h.bad && e.model === h.bad) {
      return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: null, usage: null } as never
    }
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn',
      usage: { model: e.model, input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } as never
  })
  on('ui.log', (_$: unknown, e: any) => { h.logs.push(String(e.message ?? e.text ?? JSON.stringify(e))); return { value: undefined } as never })
  on('ui.toast', (_$: unknown, e: any) => { h.toasts.push(String(e.message ?? e.text ?? JSON.stringify(e))); return { value: undefined } as never })
  on('ui.status', () => ({ value: undefined }) as never)
  return h
}

async function spawn($: any, model = 'haiku'): Promise<string> {
  const r = await $.agent.spawn({ prompt: 'p', description: 'fix db test', subagentType: 'general-purpose', model } as never) as { agentId: string }
  return r.agentId
}

async function stuck($: any, agentId: string, calls: number): Promise<string[]> {
  const notes: string[] = []
  for (let i = 0; i < calls; i++) {
    const r = await $.tool.call({ tool: 'Bash', command: 'npm test', agentId } as never) as { context?: readonly string[] }
    for (const c of r.context ?? []) notes.push(c)
  }
  return notes
}

const step = ($: any, agentId: string, model = 'haiku') =>
  drain($.turn.step({ turnId: 't', index: 0, model, messageCount: 3, agentId } as never) as never)

// An agent swapped up to sonnet whose first request on it is refused by the engine.
async function refusedSwap($: any, h: Harness): Promise<string> {
  await $.session.start({ cwd: '/work' } as never)
  h.bad = SONNET
  const id = await spawn($)
  await stuck($, id, 12)
  return id
}

test('a refused swap target keeps the agent working on its previous model', async ($, on) => {
  const h = wire(on)
  const id = await refusedSwap($, h)
  await step($, id)
  // The refused request is sent again on the previous model within the same step (the test kit reports the
  // first attempt's result for the chain, so the second one is checked through the models the core saw).
  expect(h.stepModels).toEqual([SONNET, 'haiku'])
  expect(h.calls.filter((c) => c.maxTokens === 1)).toHaveLength(1)
  // The retried request was metered like any other (the hook ran to its end).
  const report = (await $.command.run({ command: 'escalator', args: 'report', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } } as never) as { text: string }).text
  expect(report).toContain('haiku: 1 requests')
  // The next request goes straight out on the working model.
  await step($, id)
  expect(h.stepModels.at(-1)).toBe('haiku')
  expect(h.stepModels.filter((m) => m === SONNET)).toHaveLength(1)
  expect(h.toasts.some((t) => t.includes('not available') && t.includes('haiku'))).toBe(true)
  expect(h.logs.some((l) => l.includes('not available'))).toBe(true)
})

test('an overloaded model is not marked refused', async ($, on) => {
  const h = wire(on)
  h.failure = 'null'
  h.probe = apiError(529, 'overloaded')
  const id = await refusedSwap($, h)
  await step($, id)
  expect(h.toasts.some((t) => t.includes('not available'))).toBe(false)
  h.bad = undefined
  await step($, id)
  expect(h.stepModels.at(-1)).toBe(SONNET)
})

test('a failure with no response that the probe answers is transient', async ($, on) => {
  const h = wire(on)
  h.failure = 'null'
  h.probe = answered
  const id = await refusedSwap($, h)
  await step($, id)
  h.bad = undefined
  await step($, id)
  expect(h.stepModels.at(-1)).toBe(SONNET)
  expect(h.toasts.some((t) => t.includes('not available'))).toBe(false)
})

test('a refused tier is never swapped to again and the ladder reaches the human level', async ($, on) => {
  const h = wire(on)
  const id = await refusedSwap($, h)
  await step($, id)
  const notes = await stuck($, id, 12)
  expect(notes.some((n) => n.includes('Stop now'))).toBe(true)
  expect(h.toasts.some((t) => t.includes('needs a human'))).toBe(true)
  // Another agent that gets stuck never goes to the refused tier either.
  const other = await spawn($)
  const otherNotes = await stuck($, other, 16)
  expect(otherNotes.some((n) => n.includes('Stop now'))).toBe(true)
  await step($, other)
  expect(h.stepModels.at(-1)).toBe('haiku')
  expect(h.stepModels.filter((m) => m === SONNET)).toHaveLength(1)
})

test('a refused senior model is skipped by later consults', async ($, on) => {
  const h = wire(on)
  h.senior = (model) => (model === 'opus' ? apiError(404, 'model_not_found') : answered)
  await $.session.start({ cwd: '/work' } as never)
  const a = await spawn($)
  const notes = await stuck($, a, 10)
  expect(notes.some((n) => n.includes('Advice from a senior model'))).toBe(true)
  expect(h.calls.map((c) => c.model)).toEqual(['opus', 'sonnet'])
  const b = await spawn($)
  await stuck($, b, 10)
  expect(h.calls.filter((c) => c.model === 'opus')).toHaveLength(1)
  expect(h.calls.filter((c) => c.model === 'sonnet')).toHaveLength(2)
})

test('a senior failing for another reason is still tried again', async ($, on) => {
  const h = wire(on)
  h.senior = (model) => (model === 'opus' ? apiError(529, 'overloaded') : answered)
  await $.session.start({ cwd: '/work' } as never)
  await stuck($, await spawn($), 10)
  await stuck($, await spawn($), 10)
  expect(h.calls.filter((c) => c.model === 'opus')).toHaveLength(2)
})

test('with both seniors refused no further consult call is made', async ($, on) => {
  const h = wire(on)
  h.senior = (model) => (model === 'opus' ? apiError(404, 'model_not_found') : apiError(403, 'invalid_request'))
  await $.session.start({ cwd: '/work' } as never)
  await stuck($, await spawn($), 10)
  const made = h.calls.length
  expect(made).toBe(2)
  const notes = await stuck($, await spawn($), 10)
  expect(h.calls.length).toBe(made)
  expect(notes.some((n) => n.includes('Still stuck'))).toBe(true)
})

test('refused tiers survive a module reload', async ($, on) => {
  const h = wire(on)
  const id = await refusedSwap($, h)
  await step($, id)
  resetState()
  await $.session.start({ cwd: '/work' } as never)
  const other = await spawn($)
  const notes = await stuck($, other, 16)
  expect(notes.some((n) => n.includes('Stop now'))).toBe(true)
})

test('a snapshot saved before blocked tiers existed still hydrates', () => {
  const old = { agents: [], ledger: {}, seenModels: {}, sessionTag: 't', mode: 'active', baseline: 'opus', baselinePinned: false }
  expect(parseSnapshot(old)?.blockedTiers).toEqual([])
  expect(parseSnapshot({ ...old, blockedTiers: ['sonnet', 'bogus', 'sonnet'] })?.blockedTiers).toEqual(['sonnet'])
  expect(parseSnapshot({ ...old, blockedTiers: 'sonnet' })?.blockedTiers).toEqual([])
  expect(parseSnapshot({ ...old, refusedSeniors: ['opus', 3] })?.refusedSeniors).toEqual(['opus'])
})

test('isModelRefusal tells an unusable model from a transient failure', () => {
  expect(isModelRefusal({ status: 404, error: 'model_not_found' })).toBe(true)
  expect(isModelRefusal({ status: 404 })).toBe(true)
  expect(isModelRefusal({ status: 403 })).toBe(true)
  expect(isModelRefusal({ message: 'The model is not allowed by your organization allowlist' })).toBe(true)
  expect(isModelRefusal({ message: '404 not_found_error: model: claude-x' })).toBe(true)
  expect(isModelRefusal({ status: 400, message: 'invalid model id' })).toBe(true)
  expect(isModelRefusal({ status: 529, error: 'overloaded' })).toBe(false)
  expect(isModelRefusal({ status: 429, error: 'rate_limit' })).toBe(false)
  expect(isModelRefusal({ status: 500 })).toBe(false)
  expect(isModelRefusal({ status: null, error: 'unknown' })).toBe(false)
  expect(isModelRefusal({ message: '529 overloaded_error' })).toBe(false)
  expect(isModelRefusal({ message: 'socket hang up' })).toBe(false)
  expect(isModelRefusal({})).toBe(false)
})

test('blocked tiers cap the ladder like maxTier', () => {
  expect(refuseTier([], 'sonnet')).toEqual(['sonnet'])
  expect(refuseTier(['sonnet'], 'sonnet')).toEqual(['sonnet'])
  expect(allowedMax('opus', [])).toBe('opus')
  expect(allowedMax('opus', ['opus'])).toBe('sonnet')
  expect(allowedMax('opus', ['sonnet'])).toBe('haiku')
  expect(allowedMax('sonnet', ['opus'])).toBe('sonnet')
  const a = { ...newAgent('x', 'c', 'haiku', 't'), tier: 'sonnet' as const }
  expect(usableTier(a, ['sonnet'])).toBe('haiku')
  expect(usableTier(a, ['opus'])).toBe('sonnet')
  expect(pickSenior('opus', [])).toBe('opus')
  expect(pickSenior('opus', ['opus'])).toBe('sonnet')
  expect(pickSenior('opus', ['opus', 'sonnet'])).toBeUndefined()
  const back = revertSwap({ ...a, level: 3, stepsSinceAction: 0 }, 'haiku', DEFAULT_CONFIG)
  expect(back.tier).toBe('haiku')
  expect(back.level).toBe(DEFAULT_CONFIG.levels.indexOf('human'))
  expect(back.stepsSinceAction).toBe(DEFAULT_CONFIG.grace)
})

test('observe never swaps into a blocked tier', () => {
  let s = newAgent('x', 'c', 'haiku', 't')
  const actions: (string | undefined)[] = []
  for (let i = 0; i < 20; i++) {
    const r = observe(s, { tool: 'Bash', ok: false, text: 'Error: boom', summary: 'npm test' }, DEFAULT_CONFIG, true, ['sonnet'])
    s = r.state
    actions.push(r.action)
  }
  expect(actions).not.toContain('swap')
  expect(actions).toContain('human')
  expect(s.tier).toBe('haiku')
})
