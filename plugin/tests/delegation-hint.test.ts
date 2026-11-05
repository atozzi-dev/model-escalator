import { expect, mock, test } from 'claude-code/testing'
import { hintText, leadWork, noteLeadCall, emptyLeadTurn, pushTurn, shouldHint } from '../hooks/lead-work'
import { resetState } from '../hooks/register'

type Drainable = { result: Promise<unknown> } & AsyncIterable<unknown>
const drain = async (st: Drainable) => { for await (const _ of st) { /* chunks */ } return st.result }

// What the lead's requests cost: the default is a small request, a test raises it for a costly turn.
type Harness = { toasts: string[]; logs: string[]; usage: Record<string, number>; saved?: { leadHint?: unknown } }

const SMALL = { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

function wire(on: any, env: Record<string, string> = {}): { h: Harness; clock: { advance: (ms: number) => Promise<void> } } {
  resetState()
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.env(on, env)
  mock.store(on)
  const h: Harness = { toasts: [], logs: [], usage: SMALL }
  on('session.start', () => ({ cwd: '/work' }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  on('tool.call', () => ({ result: 'ok' }) as never)
  on('turn.complete', () => ({ text: 'done' }) as never)
  on('turn.step', async function* (_$: unknown, e: any) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn',
      usage: { model: e.model, ...h.usage } } as never
  })
  on('state.set', (_$: unknown, e: any, next: any) => { h.saved = e.value; return next(e) })
  on('ui.log', (_$: unknown, e: any) => { h.logs.push(String(e.message ?? e.text ?? JSON.stringify(e))); return { value: undefined } as never })
  on('ui.toast', (_$: unknown, e: any) => { h.toasts.push(String(e.message ?? e.text ?? JSON.stringify(e))); return { value: undefined } as never })
  on('ui.status', () => ({ value: undefined }) as never)
  return { h, clock }
}

const write = (path: string, lines: number) => ({ tool: 'Write', file_path: path, content: 'x\n'.repeat(lines) })
const spawnCall = (subagentType: string) => ({ tool: 'Agent', subagent_type: subagentType, prompt: 'do it' })

// One main-loop turn: its calls, then its end. The lead has no agentId.
async function leadTurn($: any, calls: Record<string, unknown>[], withStep = false): Promise<void> {
  if (withStep) await drain($.turn.step({ turnId: 't', index: 0, model: 'opus', messageCount: 3 } as never) as never)
  for (const c of calls) await $.tool.call(c as never)
  await $.turn.complete({ turnId: 't', answer: 'done' } as never)
}

// Four files in two folders, 300 lines: the job that fires the hint.
const BIG_JOB = [write('/work/src/a.ts', 100), write('/work/src/b.ts', 100), write('/work/lib/c.ts', 50), write('/work/lib/d.ts', 50)]
const EXPECTED = 'The lead wrote 4 files (300 lines) across 2 folders by itself. Asking it to split the work into subagents lets model-escalator start parts on cheaper models.'

test('a large job the lead does alone shows the hint once, as a toast and a log line', async ($, on) => {
  const { h } = wire(on)
  await $.session.start({ cwd: '/work' } as never)
  await leadTurn($, BIG_JOB)
  expect(h.toasts).toEqual([EXPECTED])
  expect(h.logs).toContain(`delegation hint: ${EXPECTED}`)
})

test('the hint is not repeated later in the same session', async ($, on) => {
  const { h } = wire(on)
  await $.session.start({ cwd: '/work' } as never)
  await leadTurn($, BIG_JOB)
  await leadTurn($, [write('/work/src/e.ts', 80), write('/work/src/f.ts', 80), write('/work/lib/g.ts', 80), write('/work/lib/h.ts', 80)])
  expect(h.toasts.length).toBe(1)
})

test('a writing subagent started by the lead means no hint, now or later', async ($, on) => {
  const { h } = wire(on)
  await $.session.start({ cwd: '/work' } as never)
  await leadTurn($, [spawnCall('general-purpose'), ...BIG_JOB])
  await leadTurn($, [write('/work/src/e.ts', 80), write('/work/src/f.ts', 80), write('/work/lib/g.ts', 80), write('/work/lib/h.ts', 80), write('/work/x/i.ts', 80), write('/work/y/j.ts', 80)])
  expect(h.toasts.length).toBe(0)
})

test('Explore and Plan calls are not delegation: the hint still shows', async ($, on) => {
  const { h } = wire(on)
  await $.session.start({ cwd: '/work' } as never)
  await leadTurn($, [spawnCall('Explore'), spawnCall('Plan'), ...BIG_JOB])
  expect(h.toasts).toEqual([EXPECTED])
})

test('a small turn shows nothing', async ($, on) => {
  const { h } = wire(on)
  await $.session.start({ cwd: '/work' } as never)
  await leadTurn($, [write('/work/src/a.ts', 20), write('/work/src/b.ts', 20)])
  expect(h.toasts.length).toBe(0)
})

test('a costly turn of three small files shows the hint: 1.5 USD of the lead\'s own requests', async ($, on) => {
  const { h } = wire(on)
  await $.session.start({ cwd: '/work' } as never)
  // 300k input and 20k output on Opus: about 1.6 USD at list prices.
  h.usage = { input_tokens: 300_000, output_tokens: 20_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
  await leadTurn($, [write('/work/src/a.ts', 5), write('/work/src/b.ts', 5), write('/work/src/c.ts', 5)], true)
  expect(h.toasts.length).toBe(1)
  expect(h.toasts[0]!.startsWith('The lead wrote 3 files (15 lines) across 1 folder by itself.')).toBe(true)
})

test('three turns of two files inside thirty minutes add up to the hint on the third', async ($, on) => {
  const { h, clock } = wire(on)
  await $.session.start({ cwd: '/work' } as never)
  await leadTurn($, [write('/work/src/a1.ts', 60), write('/work/src/a2.ts', 60)])
  await clock.advance(10 * 60_000)
  await leadTurn($, [write('/work/src/b1.ts', 60), write('/work/src/b2.ts', 60)])
  expect(h.toasts.length).toBe(0)
  await clock.advance(10 * 60_000)
  await leadTurn($, [write('/work/src/c1.ts', 60), write('/work/src/c2.ts', 60)])
  expect(h.toasts.length).toBe(1)
})

test('turns more than thirty minutes apart do not add up', async ($, on) => {
  const { h, clock } = wire(on)
  await $.session.start({ cwd: '/work' } as never)
  await leadTurn($, [write('/work/src/a1.ts', 200), write('/work/src/a2.ts', 200)])
  await clock.advance(40 * 60_000)
  await leadTurn($, [write('/work/src/b1.ts', 200), write('/work/src/b2.ts', 200)])
  await clock.advance(10 * 60_000)
  await leadTurn($, [write('/work/src/c1.ts', 0), write('/work/src/c2.ts', 0)])
  expect(h.toasts.length).toBe(0)
})

test('observe mode logs the hint and shows no toast', async ($, on) => {
  const { h } = wire(on, { MODEL_ESCALATOR_MODE: 'observe' })
  await $.session.start({ cwd: '/work' } as never)
  await leadTurn($, BIG_JOB)
  expect(h.toasts.length).toBe(0)
  expect(h.logs.some((l) => l.startsWith('delegation hint (observe mode, not shown): '))).toBe(true)
})

test('delegationHint off: nothing is shown', { options: { delegationHint: false } }, async ($, on) => {
  const { h } = wire(on)
  await $.session.start({ cwd: '/work' } as never)
  await leadTurn($, BIG_JOB)
  expect(h.toasts.length).toBe(0)
  expect(h.logs.some((l) => l.includes('delegation hint'))).toBe(false)
})

test('the hint is saved with the session, so a reload does not show it again', async ($, on) => {
  const { h } = wire(on)
  await $.session.start({ cwd: '/work' } as never)
  await leadTurn($, BIG_JOB)
  expect(h.saved?.leadHint).toEqual({ hinted: true, delegated: false })
})

test('/escalator shows a line about the hint while it applies', async ($, on) => {
  wire(on)
  await $.session.start({ cwd: '/work' } as never)
  await leadTurn($, BIG_JOB)
  const text = (await $.command.run({ command: 'escalator', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } } as never) as { text: string }).text
  expect(text).toContain('Delegation hint: shown this session')
})

test('the pure window and rule agree with the wiring on a plain job', () => {
  const window = pushTurn([], [write('/work/src/a.ts', 100), write('/work/src/b.ts', 100), write('/work/lib/c.ts', 50), write('/work/lib/d.ts', 50)]
    .reduce((t, c) => noteLeadCall(t, c.tool, c as never, '/work'), emptyLeadTurn()), 1)
  expect(shouldHint(leadWork(window))).toBe(true)
  expect(hintText(leadWork(window))).toBe(EXPECTED)
})
