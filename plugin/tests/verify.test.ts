import { expect, mock, test } from 'claude-code/testing'
import { resetState } from '../hooks/register'

type Harness = { runs: { argv: readonly string[]; timeoutMs?: number }[]; active: number; maxActive: number; logs: string[]; toasts: string[] }
type Behavior = (argv: readonly string[]) => Promise<unknown> | unknown

// Fake core under the plugin: spawn, a controllable process.run, log and toast capture.
function wire(on: any, env: Record<string, string>, behavior: Behavior): Harness {
  resetState()
  mock.env(on, env)
  mock.store(on)
  on('session.start', () => ({ cwd: '/work' }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  const h: Harness = { runs: [], active: 0, maxActive: 0, logs: [], toasts: [] }
  let n = 0
  on('agent.spawn', (_$: unknown, e: any) => ({ model: e.model ?? 'haiku', agentId: 'a' + ++n }))
  on('turn.complete', () => ({ text: 'done' }) as never)
  on('process.run', async (_$: unknown, e: any) => {
    h.runs.push({ argv: e.argv, timeoutMs: e.init?.timeoutMs })
    h.active++
    h.maxActive = Math.max(h.maxActive, h.active)
    try { return { value: await behavior(e.argv) } as never } finally { h.active-- }
  })
  on('ui.log', (_$: unknown, e: any) => { h.logs.push(String(e.message ?? e.text ?? JSON.stringify(e))); return { value: undefined } as never })
  on('ui.toast', (_$: unknown, e: any) => { h.toasts.push(String(e.message ?? e.text ?? JSON.stringify(e))); return { value: undefined } as never })
  on('ui.status', () => ({ value: undefined }) as never)
  return h
}

const ok = { exitCode: 0, stdout: 'all good', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
const bad = { exitCode: 1, stdout: 'line1\nFAIL x', stderr: 'boom', isStdoutTruncated: false, isStderrTruncated: false }

async function spawn($: any): Promise<string> {
  const r = await $.agent.spawn({ prompt: 'p', description: 'fix db test', subagentType: 'general-purpose', model: 'haiku' } as never) as { agentId: string }
  return r.agentId
}
// The verification runs in the background: wait until `runs` commands have finished, then let the outcome land.
const sleep = (ms: number) => new Promise<void>((r) => (globalThis as unknown as { setTimeout: (f: () => void, ms: number) => unknown }).setTimeout(r, ms))
async function settle(h: Harness, runs: number): Promise<void> {
  for (let i = 0; i < 200 && !(h.runs.length >= runs && h.active === 0); i++) await sleep(10)
  await sleep(60)
}
const finish =($: any, agentId: string) => $.turn.complete({ turnId: 't' + agentId, agentId, answer: 'x' } as never)
// Reads the learned stats through the /escalator stats command (the test $ has no store of its own).
const stats = async ($: any) => {
  const out = await $.command.run({ command: 'escalator', args: 'stats', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } } as never) as { text: string }
  return JSON.parse(out.text.slice(out.text.indexOf('{')))
}

const CMD = { verifyCommand: 'npm test -- --run "my suite"' }

test('off by default: no process call, outcome recorded as before', async ($, on) => {
  const h = wire(on, {}, () => ok)
  await $.session.start({ cwd: '/work' } as never)
  await finish($, await spawn($))
  await settle(h, 0)
  expect(h.runs.length).toBe(0)
  const c = (await stats($))['general-purpose:tests'].haiku
  expect(c.runs).toBe(1)
  expect(c.escalated).toBe(0)
})

test('passing command: runs once with argv, records a positive outcome', { options: CMD }, async ($, on) => {
  const h = wire(on, {}, () => ok)
  await $.session.start({ cwd: '/work' } as never)
  await finish($, await spawn($))
  await settle(h, 1)
  expect(h.runs.length).toBe(1)
  expect(h.runs[0]!.argv).toEqual(['npm', 'test', '--', '--run', 'my suite'])
  expect(h.runs[0]!.timeoutMs).toBe(120_000)
  expect(h.toasts.length).toBe(0)
  const c = (await stats($))['general-purpose:tests'].haiku
  expect(c.runs).toBe(1)
  expect(c.failedVerify ?? 0).toBe(0)
  expect(c.notAccepted).toBe(0)
})

test('failing command: negative outcome, log with output tail, toast', { options: CMD }, async ($, on) => {
  const h = wire(on, {}, () => bad)
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($)
  await finish($, id)
  await settle(h, 1)
  const c = (await stats($))['general-purpose:tests'].haiku
  expect(c.runs).toBe(1)
  expect(c.failedVerify).toBe(1)
  expect(c.notAccepted).toBe(1)
  const line = h.logs.find((l) => l.includes('verification failed'))
  expect(line).toBeDefined()
  expect(line!).toContain(id)
  expect(line!).toContain('general-purpose:tests')
  expect(line!).toContain('FAIL x')
  expect(h.toasts.length).toBe(1)
})

test('a very long output is truncated in the log', { options: CMD }, async ($, on) => {
  const h = wire(on, {}, () => ({ ...bad, stdout: 'x'.repeat(50_000) }))
  await $.session.start({ cwd: '/work' } as never)
  await finish($, await spawn($))
  await settle(h, 1)
  const line = h.logs.find((l) => l.includes('verification failed'))!
  expect(line.length < 1500).toBe(true)
})

test('a command that throws counts as failed and does not crash', { options: CMD }, async ($, on) => {
  const h = wire(on, {}, () => { throw new Error('spawn ENOENT') })
  await $.session.start({ cwd: '/work' } as never)
  await finish($, await spawn($))
  await settle(h, 1)
  const c = (await stats($))['general-purpose:tests'].haiku
  expect(c.failedVerify).toBe(1)
  expect(h.toasts.length).toBe(1)
})

test('the timeout option is passed to the process call', { options: { ...CMD, verifyTimeoutSeconds: 7 } }, async ($, on) => {
  const h = wire(on, {}, () => ok)
  await $.session.start({ cwd: '/work' } as never)
  await finish($, await spawn($))
  await settle(h, 1)
  expect(h.runs[0]!.timeoutMs).toBe(7000)
})

test('two agents finishing together verify one at a time', { options: CMD }, async ($, on) => {
  const h = wire(on, {}, async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); return ok })
  await $.session.start({ cwd: '/work' } as never)
  const a = await spawn($)
  const b = await spawn($)
  await Promise.all([finish($, a), finish($, b)])
  await settle(h, 2)
  expect(h.runs.length).toBe(2)
  expect(h.maxActive).toBe(1)
  expect((await stats($))['general-purpose:tests'].haiku.runs).toBe(2)
})

test('turn.complete does not wait for the verification', { options: CMD }, async ($, on) => {
  let release!: () => void
  const gate = new Promise<void>((r) => { release = r })
  const h = wire(on, {}, async () => { await gate; return ok })
  await $.session.start({ cwd: '/work' } as never)
  await finish($, await spawn($))   // resolves while the command is still pending
  expect(h.runs.length).toBe(1)
  release()
  await settle(h, 1)
  expect((await stats($))['general-purpose:tests'].haiku.runs).toBe(1)
})

test('baseline mode never runs the command', { options: CMD }, async ($, on) => {
  const h = wire(on, { MODEL_ESCALATOR_MODE: 'baseline' }, () => ok)
  await $.session.start({ cwd: '/work' } as never)
  await finish($, await spawn($))
  await settle(h, 0)
  expect(h.runs.length).toBe(0)
})

test('off mode never runs the command', { options: CMD }, async ($, on) => {
  const h = wire(on, { MODEL_ESCALATOR_MODE: 'off' }, () => ok)
  await $.session.start({ cwd: '/work' } as never)
  await finish($, await spawn($))
  await settle(h, 0)
  expect(h.runs.length).toBe(0)
})

test('observe mode runs the command and records the outcome', { options: CMD }, async ($, on) => {
  const h = wire(on, { MODEL_ESCALATOR_MODE: 'observe' }, () => bad)
  await $.session.start({ cwd: '/work' } as never)
  await finish($, await spawn($))
  await settle(h, 1)
  expect(h.runs.length).toBe(1)
  expect((await stats($))['general-purpose:tests'].haiku.failedVerify).toBe(1)
})

test('the main loop (no agentId) is never verified', { options: CMD }, async ($, on) => {
  const h = wire(on, {}, () => ok)
  await $.session.start({ cwd: '/work' } as never)
  await $.turn.complete({ turnId: 'm', answer: 'x' } as never)
  await settle(h, 0)
  expect(h.runs.length).toBe(0)
})
