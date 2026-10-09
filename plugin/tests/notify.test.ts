import { expect, mock, test } from 'claude-code/testing'
import { DEFAULT_CONFIG, parseConfig } from '../hooks/config'
import { leadMessage, MAX_LEAD_NOTICES } from '../hooks/detector'
import { resetState } from '../hooks/register'

type Drainable = { result: Promise<unknown> } & AsyncIterable<unknown>
const drain = async (st: Drainable) => { for await (const _ of st) { /* chunks */ } return st.result }

const SONNET = 'claude-sonnet-5-5'
type Sent = { text: string; type: string; agentId?: string }
type Harness = { sent: Sent[]; toasts: string[]; logs: string[]; bad?: string; failSend: boolean; skip: number }

function wire(on: any, env: Record<string, string> = {}): Harness {
  resetState()
  mock.clock(on, { now: 1_000_000 })
  mock.env(on, env)
  mock.store(on)
  const session = mock.session(on)
  const h: Harness = { sent: [], toasts: [], logs: [], failSend: false, skip: 0 }
  // The rows the mod appended to the main conversation, after the first `skip`.
  Object.defineProperty(h, 'sent', { get: () => session.appended().slice(h.skip).map((r: any) => ({
    text: String(r.message.content[0]?.text ?? ''), type: r.message.type, agentId: r.agentId })) })
  on('session.start', () => ({ cwd: '/work' }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  on('session.append', { door: 'note' }, (_$: unknown, e: any, next: any) => (h.failSend ? ({ deny: 'refused' } as never) : next(e)))
  let n = 0
  on('agent.spawn', (_$: unknown, e: any) => ({ model: e.model ?? 'haiku', agentId: 'a' + ++n }))
  on('tool.call', () => ({ isError: true, result: 'Error: boom', text: 'Error: boom' }) as never)
  on('model.complete', (_$: unknown, e: any) => ({ value: e.maxTokens === 1
    ? { isAnswered: false, reason: 'api-error', status: 404, error: 'model_not_found', usage: { input_tokens: 0, output_tokens: 0 } }
    : { isAnswered: true, text: 'advice', usage: { input_tokens: 10, output_tokens: 5 } } }) as never)
  on('turn.complete', () => ({ text: 'done' }) as never)
  on('turn.step', async function* (_$: unknown, e: any) {
    if (h.bad && e.model === h.bad) return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: null, usage: null } as never
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn',
      usage: { model: e.model, input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } as never
  })
  on('ui.log', (_$: unknown, e: any) => { h.logs.push(String(e.message ?? e.text ?? JSON.stringify(e))); return { value: undefined } as never })
  on('ui.toast', (_$: unknown, e: any) => { h.toasts.push(String(e.message ?? e.text ?? JSON.stringify(e))); return { value: undefined } as never })
  on('ui.status', () => ({ value: undefined }) as never)
  return h
}

const spawn = async ($: any, prompt = 'Fix the failing database test in src/db.ts'): Promise<string> =>
  ((await $.agent.spawn({ prompt, description: 'fix db test', subagentType: 'general-purpose', model: 'haiku' } as never)) as { agentId: string }).agentId

// The send is not awaited by the hook: let it land.
const settle = async (): Promise<void> => { for (let i = 0; i < 30; i++) await Promise.resolve() }

async function stuck($: any, agentId: string, calls: number): Promise<void> {
  for (let i = 0; i < calls; i++) await $.tool.call({ tool: 'Bash', command: 'npm test', agentId } as never)
  await settle()
}

const step = ($: any, agentId: string) => drain($.turn.step({ turnId: 't', index: 0, model: 'haiku', messageCount: 3, agentId } as never) as never)

test('a model swap sends one message to the session naming the agent and the new tier', async ($, on) => {
  const h = wire(on)
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($)
  await stuck($, id, 12)
  const swaps = h.sent.filter((s) => s.text.includes('sonnet'))
  expect(swaps).toHaveLength(1)
  // A user-role row of the main conversation (no agentId), which the lead model reads.
  expect(swaps[0]!.type).toBe('user')
  expect(swaps[0]!.agentId).toBeUndefined()
  expect(swaps[0]!.text).toContain('[model-escalator]')
  expect(swaps[0]!.text).toContain(id)
  expect(swaps[0]!.text).toContain('Fix the failing database test')
  expect(swaps[0]!.text.length).toBeLessThan(700)
  // The first message says once what these notices are; the later ones do not repeat it.
  expect(h.sent[0]!.text).toContain('automatic notice')
})

test('each further swap and the human level send their own message', async ($, on) => {
  const h = wire(on)
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($)
  await stuck($, id, 60)
  expect(h.sent.length).toBe(3)
  expect(h.sent[0]!.text).toContain('sonnet')
  expect(h.sent[1]!.text).toContain('opus')
  expect(h.sent[2]!.text).toContain(`/escalator resume ${id}`)
  expect(h.sent[2]!.text).toContain('paused')
  expect(h.sent.slice(1).every((s) => !s.text.includes('automatic notice'))).toBe(true)
})

test('the human level without a pause does not offer a resume command', { options: { levels: 'human', pauseAtHuman: false } }, async ($, on) => {
  const h = wire(on)
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($)
  await stuck($, id, 40)
  expect(h.sent).toHaveLength(1)
  expect(h.sent[0]!.text).toContain('needs a human')
  expect(h.sent[0]!.text).not.toContain('/escalator resume')
})

test('an unavailable swap target sends a message', async ($, on) => {
  const h = wire(on)
  await $.session.start({ cwd: '/work' } as never)
  h.bad = SONNET
  const id = await spawn($)
  await stuck($, id, 12)
  h.skip = h.sent.length
  await step($, id)
  await settle()
  expect(h.sent).toHaveLength(1)
  expect(h.sent[0]!.text).toContain('not available')
  expect(h.sent[0]!.text).toContain(SONNET)
  expect(h.sent[0]!.text).toContain(id)
})

for (const mode of ['observe', 'baseline', 'off']) {
  test(`${mode} mode sends nothing`, async ($, on) => {
    const h = wire(on, { MODEL_ESCALATOR_MODE: mode })
    await $.session.start({ cwd: '/work' } as never)
    const id = await spawn($)
    await stuck($, id, 60)
    expect(h.sent).toHaveLength(0)
  })
}

test('notifyLead false sends nothing', { options: { notifyLead: false } }, async ($, on) => {
  const h = wire(on)
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($)
  await stuck($, id, 60)
  expect(h.sent).toHaveLength(0)
  expect(h.toasts.some((t) => t.includes('needs a human'))).toBe(true)
})

test('an append that is refused never breaks the hook', async ($, on) => {
  const h = wire(on)
  h.failSend = true
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($)
  const notes: string[] = []
  for (let i = 0; i < 12; i++) {
    const r = await $.tool.call({ tool: 'Bash', command: 'npm test', agentId: id } as never) as { context?: readonly string[] }
    for (const c of r.context ?? []) notes.push(c)
  }
  await settle()
  expect(notes.some((n) => n.includes('stronger model'))).toBe(true)
  expect(h.toasts.some((t) => t.includes('switched to sonnet'))).toBe(true)
})

test('the session sends at most MAX_LEAD_NOTICES messages', async ($, on) => {
  const h = wire(on)
  await $.session.start({ cwd: '/work' } as never)
  for (let i = 0; i < 8; i++) {
    const id = await spawn($, `task number ${i}`)
    await stuck($, id, 60)
  }
  expect(h.sent).toHaveLength(MAX_LEAD_NOTICES)
})

test('notifyLead is on by default and parsed as a boolean', () => {
  expect(DEFAULT_CONFIG.notifyLead).toBe(true)
  expect(parseConfig({ notifyLead: false }).notifyLead).toBe(false)
  expect(parseConfig({ notifyLead: 'false' }).notifyLead).toBe(false)
  expect(parseConfig({ notifyLead: 'nope' }).notifyLead).toBe(true)
})

test('leadMessage is short, factual and clips the task', () => {
  const a = { id: 'a1', category: 'bugfix', task: 'x'.repeat(500) + '\nsecond line' }
  const m = leadMessage(a, { kind: 'swap', tier: 'opus' }, false)
  expect(m).toContain('a1 (bugfix, task: ' + 'x'.repeat(80) + '...)')
  expect(m).not.toContain('\n')
  expect(m).toContain('opus')
})
