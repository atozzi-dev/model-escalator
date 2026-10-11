import { expect, mock, test } from 'claude-code/testing'
import { parseConfig } from '../hooks/config'
import { categorize, formatStats, record, recordRework, type Cell, type Stats } from '../hooks/learning'
import { resetState } from '../hooks/register'

const CAT = categorize('general-purpose', 'add loader cache')
const NOW = 1_000_000_000_000
const MIN = 60_000

const near = (a: number | undefined, b: number, tol = 0.01): boolean => a !== undefined && Math.abs(a - b) < tol

// ---------- pure helpers ----------

test('config: reworkWindowMinutes defaults to 30, 0 turns it off, invalid values fall back', () => {
  expect(parseConfig({}).reworkWindowMinutes).toBe(30)
  expect(parseConfig({ reworkWindowMinutes: 10 }).reworkWindowMinutes).toBe(10)
  expect(parseConfig({ reworkWindowMinutes: '5' }).reworkWindowMinutes).toBe(5)
  expect(parseConfig({ reworkWindowMinutes: 0 }).reworkWindowMinutes).toBe(0)
  for (const bad of [-1, 'x', '', null, Number.NaN]) expect(parseConfig({ reworkWindowMinutes: bad }).reworkWindowMinutes).toBe(30)
})

test('recordRework: an accepted run becomes not accepted, once, and the cell counts the rework', () => {
  let s: Stats = record({}, 'c', 'haiku', false, 0, false, NOW)
  s = recordRework(s, 'c', 'haiku', { now: NOW, runAccepted: true, runAt: NOW })
  const c = s.c!.haiku!
  expect(c.notAccepted).toBe(1)
  expect(c.reworked).toBe(1)
  expect(c.runs).toBe(1)
  // a run already counted as not accepted is not counted again, the rework still shows
  const again = recordRework(s, 'c', 'haiku', { now: NOW, runAccepted: false, runAt: NOW })
  expect(again.c!.haiku!.notAccepted).toBe(1)
  expect(again.c!.haiku!.reworked).toBe(2)
})

test('recordRework: weighted by the run age, never above the runs, no cell no change, input untouched', () => {
  const day = 86_400_000
  const base = record({}, 'c', 'haiku', false, 0, false, NOW)
  const frozen = JSON.stringify(base)
  const s = recordRework(base, 'c', 'haiku', { now: NOW + 30 * day, halfLifeMs: 30 * day, runAccepted: true, runAt: NOW })
  expect(JSON.stringify(base)).toBe(frozen)
  expect(near(s.c!.haiku!.notAccepted, 0.5, 1e-9)).toBe(true)
  expect((s.c!.haiku!.notAccepted ?? 0) <= s.c!.haiku!.runs).toBe(true)
  expect(recordRework(base, 'c', 'sonnet', { now: NOW, runAccepted: true })).toBe(base)
  expect(recordRework(base, 'other', 'haiku', { runAccepted: true })).toBe(base)
})

test('formatStats: reworked shows only when above 0', () => {
  const plain = record({}, 'c', 'haiku', false, 0, false, NOW)
  expect(formatStats(plain, NOW)).not.toContain('reworked')
  const s = recordRework(plain, 'c', 'haiku', { now: NOW, runAccepted: true, runAt: NOW })
  expect(formatStats(s, NOW)).toContain('reworked 1')
})

// ---------- through the engine ----------

type H = { data: Record<string, unknown>; logs: string[]; advance: (ms: number) => Promise<unknown> }

function wire(on: any, env: Record<string, string> = {}): H {
  resetState()
  const clock = mock.clock(on, { now: NOW })
  mock.env(on, env)
  const h: H = { data: {}, logs: [], advance: async (ms) => { await clock.advance(ms) } }
  on('store.get', (_$: unknown, e: any) => ({ value: h.data[e.key] }))
  on('store.set', (_$: unknown, e: any) => { h.data[e.key] = e.value; return { value: undefined } })
  on('store.delete', (_$: unknown, e: any) => { delete h.data[e.key]; return { value: undefined } })
  on('session.start', () => ({ cwd: '/work' }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  let n = 0
  on('agent.spawn', (_$: unknown, e: any) => ({ model: e.model ?? 'haiku', agentId: 'a' + ++n }))
  on('tool.call', () => ({ result: 'ok' }) as never)
  on('turn.complete', () => ({ text: 'done' }) as never)
  on('ui.log', (_$: unknown, e: any) => { h.logs.push(String(e.message ?? e.text ?? JSON.stringify(e))); return { value: undefined } as never })
  for (const k of ['ui.toast', 'ui.status'] as const) on(k, () => ({ value: undefined }) as never)
  return h
}

const cell = (h: H, tier = 'haiku'): Cell | undefined => ((h.data.stats as Stats | undefined)?.[CAT] as Record<string, Cell> | undefined)?.[tier]
const spawn = async ($: any, model = 'haiku'): Promise<string> =>
  ((await $.agent.spawn({ prompt: 'add a cache to the loader', description: 'add loader cache', subagentType: 'general-purpose', model } as never)) as { agentId: string }).agentId
const edit = ($: any, file: string, agentId?: string, tool = 'Edit') =>
  $.tool.call({ tool, file_path: file, old_string: 'a', new_string: 'b', ...(agentId ? { agentId } : {}) } as never)
const finish = ($: any, id: string) => $.turn.complete({ turnId: 't-' + id, agentId: id, answer: 'x' } as never)
const command = async ($: any, args: string): Promise<string> =>
  ((await $.command.run({ command: 'escalator', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } } as never)) as { text: string }).text
const reworkLogs = (h: H): string[] => h.logs.filter((l) => l.includes('lead reworked'))

test('the lead edits a file a cheap agent wrote, in the window: one rework, the run is not accepted, stats and log show it', async ($, on) => {
  const h = wire(on)
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($)
  await edit($, 'src/a.ts', id)
  await finish($, id)
  expect(cell(h)!.runs).toBe(1)
  expect(cell(h)!.notAccepted).toBe(0)
  await h.advance(5 * MIN)
  await edit($, 'src/a.ts')
  expect(cell(h)!.reworked).toBe(1)
  expect(near(cell(h)!.notAccepted, 1)).toBe(true)
  expect(reworkLogs(h).length).toBe(1)
  expect(reworkLogs(h)[0]!).toContain(id)
  expect(reworkLogs(h)[0]!).toContain('lead reworked a.ts')
  expect(await command($, 'stats')).toContain('reworked 1')
})

test('a second lead edit of the same file is not a second rework', async ($, on) => {
  const h = wire(on)
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($)
  await edit($, 'src/a.ts', id)
  await finish($, id)
  await h.advance(MIN)
  await edit($, 'src/a.ts')
  await h.advance(MIN)
  await edit($, 'src/a.ts')
  expect(cell(h)!.reworked).toBe(1)
  expect(near(cell(h)!.notAccepted, 1)).toBe(true)
  expect(reworkLogs(h).length).toBe(1)
})

test('another file of the same run is not a second rework of that run', async ($, on) => {
  const h = wire(on)
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($)
  await edit($, 'src/a.ts', id)
  await edit($, 'src/b.ts', id, 'Write')
  await finish($, id)
  await edit($, 'src/a.ts')
  await edit($, 'src/b.ts')
  expect(cell(h)!.reworked).toBe(1)
  expect(reworkLogs(h).length).toBe(1)
})

test('an edit after the window counts for nothing', async ($, on) => {
  const h = wire(on)
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($)
  await edit($, 'src/a.ts', id)
  await finish($, id)
  await h.advance(31 * MIN)
  await edit($, 'src/a.ts')
  expect(cell(h)!.reworked).toBeUndefined()
  expect(cell(h)!.notAccepted).toBe(0)
  expect(reworkLogs(h).length).toBe(0)
  expect(await command($, 'stats')).not.toContain('reworked')
})

test('the window is the option: 5 minutes', { options: { reworkWindowMinutes: 5 } }, async ($, on) => {
  const h = wire(on)
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($)
  await edit($, 'src/a.ts', id)
  await finish($, id)
  await h.advance(6 * MIN)
  await edit($, 'src/a.ts')
  expect(cell(h)!.reworked).toBeUndefined()
})

test('a file the agent did not touch, or an edit while the agent still runs, counts for nothing', async ($, on) => {
  const h = wire(on)
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($)
  await edit($, 'src/a.ts', id)
  await edit($, 'src/a.ts')
  await finish($, id)
  await edit($, 'src/other.ts')
  expect(cell(h)!.reworked).toBeUndefined()
  expect(reworkLogs(h).length).toBe(0)
})

test('an edit by another agent is not the lead: no rework', async ($, on) => {
  const h = wire(on)
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($)
  const other = await spawn($)
  await edit($, 'src/a.ts', id)
  await finish($, id)
  await edit($, 'src/a.ts', other)
  expect(cell(h)!.reworked).toBeUndefined()
})

test('an agent on the baseline tier is not tracked', async ($, on) => {
  const h = wire(on)
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($, 'opus')
  await edit($, 'src/a.ts', id)
  await finish($, id)
  await edit($, 'src/a.ts')
  expect(cell(h, 'opus')!.reworked).toBeUndefined()
  expect(reworkLogs(h).length).toBe(0)
})

test('reworkWindowMinutes 0 turns it off', { options: { reworkWindowMinutes: 0 } }, async ($, on) => {
  const h = wire(on)
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($)
  await edit($, 'src/a.ts', id)
  await finish($, id)
  await edit($, 'src/a.ts')
  expect(cell(h)!.reworked).toBeUndefined()
  expect(reworkLogs(h).length).toBe(0)
})

for (const mode of ['baseline', 'off']) {
  test(`${mode} mode tracks nothing`, async ($, on) => {
    const h = wire(on, { MODEL_ESCALATOR_MODE: mode })
    await $.session.start({ cwd: '/work' } as never)
    const id = await spawn($)
    await edit($, 'src/a.ts', id)
    await finish($, id)
    await edit($, 'src/a.ts')
    expect(reworkLogs(h).length).toBe(0)
  })
}

test('paths are compared normalised: Windows case and backslashes', async ($, on) => {
  const h = wire(on)
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($)
  await edit($, 'C:\\Proj\\Src\\A.ts', id)
  await finish($, id)
  await edit($, 'c:/proj/src/a.ts')
  expect(cell(h)!.reworked).toBe(1)
  expect(reworkLogs(h)[0]!).toContain('lead reworked a.ts')
})

test('a rework before the verification lands is applied once the run is recorded', { options: { verifyCommand: 'node check' } }, async ($, on) => {
  const h = wire(on)
  let release: () => void = () => undefined
  const gate = new Promise<void>((r) => { release = r })
  on('process.run', async () => { await gate; return { value: { exitCode: 0, stdout: 'ok', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } as never })
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($)
  await edit($, 'src/a.ts', id)
  await finish($, id)
  expect(cell(h)).toBeUndefined()
  await edit($, 'src/a.ts')
  release()
  for (let i = 0; i < 100 && !cell(h)?.reworked; i++) await new Promise<void>((r) => (globalThis as unknown as { setTimeout: (f: () => void, ms: number) => unknown }).setTimeout(r, 10))
  expect(cell(h)!.runs).toBe(1)
  expect(cell(h)!.reworked).toBe(1)
  expect(near(cell(h)!.notAccepted, 1)).toBe(true)
})
