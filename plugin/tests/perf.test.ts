import { expect, mock, test } from 'claude-code/testing'
import { MAP_PANE, resetState } from '../hooks/register'
import { SVG_MAX } from '../hooks/render-svg'

type Drainable = { result: Promise<unknown> } & AsyncIterable<unknown>
const drain = async (st: Drainable) => { for await (const _ of st) { /* chunks */ } return st.result }

type Harness = { lastValue: unknown; invalidations: number; sets: number; lastBytes: number; maxBytes: number; clock: ReturnType<typeof mock.clock> }

function wire(on: any, ownStore = false): Harness {
  resetState()
  mock.env(on, {})
  if (!ownStore) mock.store(on)
  const h: Harness = { lastValue: undefined, invalidations: 0, sets: 0, lastBytes: 0, maxBytes: 0, clock: mock.clock(on, { now: 1_000_000 }) }
  on('session.start', () => ({ cwd: '/work' }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  on('tool.register', (_$: unknown, e: any) => ({ value: { tool: `mcp__model-escalator__${e.name}` } }) as never)
  let n = 0
  on('agent.spawn', (_$: unknown, e: any) => ({ model: e.model ?? 'haiku', agentId: 'a' + ++n }))
  let k = 0
  on('tool.call', (_$: unknown, e: any) => {
    k++
    const ok = k % 3 === 0
    return { isError: !ok, result: ok ? 'ok' : `Error: failure number ${k} in module ${e.agentId}`, text: ok ? 'ok' : `Error: failure number ${k}` } as never
  })
  on('model.complete', () => ({ value: { isAnswered: true, text: 'advice' } }) as never)
  on('turn.complete', () => ({ text: 'done' }) as never)
  on('turn.step', async function* (_$: unknown, e: any) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn',
      usage: { model: e.model, input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 20000, cache_creation_input_tokens: 1000 } } as never
  })
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.panes', () => ({ value: [] }) as never)
  on('ui.invalidate', () => { h.invalidations++; return { value: undefined } as never })
  on('state.set', async (_$: unknown, e: any, next: any) => {
    h.sets++
    h.lastValue = e.value
    h.lastBytes = JSON.stringify(e.value).length
    h.maxBytes = Math.max(h.maxBytes, h.lastBytes)
    return next(e)
  })
  for (const key of ['ui.log', 'ui.toast', 'ui.status'] as const) on(key, () => ({ value: undefined }) as never)
  return h
}

const PROPS = (cols: number) => ({ title: 'x', isFocused: false, bodyColumns: cols, placement: 'inline', scroll: { first: 0, last: 0, bodyRows: 30 }, view: {} }) as never
const mount = ($: any, surface: string, id: string, cols = 120) =>
  $.ui.mount({ plugin: 'model-escalator', surface, component: 'Pane', requestId: id, props: PROPS(cols) }) as Promise<any>

async function traffic($: any, agents: number, rounds: number): Promise<{ events: number }> {
  const ids: string[] = []
  let events = 0
  for (let i = 0; i < agents; i++) {
    const r = await $.agent.spawn({ prompt: 'p', description: `fix db test ${i}`, subagentType: 'general-purpose', model: 'haiku', name: `worker-${i}` } as never) as { agentId: string }
    ids.push(r.agentId); events++
  }
  for (let round = 0; round < rounds; round++) {
    for (const agentId of ids) {
      await $.tool.call({ tool: 'Bash', command: `npm test ${round}`, agentId } as never); events++
      await drain($.turn.step({ turnId: 't' + round, index: round, model: 'haiku', messageCount: 3, agentId } as never) as never); events++
    }
  }
  for (const agentId of ids) { await $.turn.complete({ turnId: 'z', agentId, answer: 'done' } as never); events++ }
  return { events }
}

const runCommand = async ($: any, args: string) =>
  (await $.command.run({ command: 'escalator', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } } as never) as { text: string }).text

// Counts every Button under a drawn tree.
const countType = (node: any, type: string): number =>
  node === null || typeof node !== 'object' ? 0
    : (node.type === type ? 1 : 0) + ((node.children as any[] | undefined) ?? []).reduce((n: number, c) => n + countType(c, type), 0)

// Bounds, not timings: counts and sizes only. The numbers below leave headroom over what was measured with
// 25 and 50 agents (sequential hooks, so no write is coalesced by chance).
const SNAPSHOT_BYTES_PER_AGENT = 1500

for (const n of [25, 50]) {
  test(`${n} agents: state writes stay bounded and the snapshot size is linear`, { timeoutMs: 30000 }, async ($, on) => {
    const h = wire(on)
    await $.session.start({ cwd: '/work' } as never)
    const { events } = await traffic($, n, 4)
    // Spawns and completions write at once; the tool calls in between are spaced (1 s apart on the virtual clock).
    expect(h.sets).toBeLessThan(events * 0.65)
    await h.clock.advance(2000)
    await h.clock.settle()
    expect(h.maxBytes).toBeLessThan(n * SNAPSHOT_BYTES_PER_AGENT)
    // The last write holds the final state: every agent has finished.
    const saved = h.lastValue as { agents: { running?: boolean }[]; graph: { events: unknown[]; nodes: unknown[]; edges: unknown[] } }
    expect(saved.agents.length).toBe(n)
    expect(saved.agents.every((a) => a.running !== true)).toBe(true)
    expect(saved.graph.events.length).toBeLessThanOrEqual(100)
    expect(saved.graph.edges.length).toBeLessThanOrEqual(200)
  })

  test(`${n} agents: the map stays under the Svg limit and the tree has one row per node`, { timeoutMs: 30000 }, async ($, on) => {
    const h = wire(on)
    await $.session.start({ cwd: '/work' } as never)
    await traffic($, n, 4)
    await h.clock.settle()
    const desk = await mount($, 'desktop', MAP_PANE)
    const svg = String((await desk.find({ type: 'Svg' })).props.source)
    expect(svg.length).toBeLessThan(SVG_MAX)
    // Selector buttons (and with them the detail panel) are capped at 8 agents.
    expect(countType(await desk.drawn(), 'Button')).toBeLessThanOrEqual(8)
    const term = await mount($, 'terminal', MAP_PANE)
    const rows = ((await term.drawn()).children as any[]).filter((r) => r.props?.flexDirection === 'row')
    expect(rows.length).toBeLessThanOrEqual(n + 2)
    expect(countType(await term.drawn(), 'Button')).toBeLessThanOrEqual(8)
  })
}

test('redraws stay at 4 a second for the map and 1 a second for the stats panel, and 10 together', { timeoutMs: 30000 }, async ($, on) => {
  const h = wire(on)
  await $.session.start({ cwd: '/work' } as never)
  const ids: string[] = []
  for (let i = 0; i < 25; i++) ids.push(((await $.agent.spawn({ prompt: 'p', description: `fix db test ${i}`, subagentType: 'general-purpose', model: 'haiku' } as never)) as { agentId: string }).agentId)
  await runCommand($, 'map')
  await h.clock.advance(10_000)
  h.invalidations = 0
  // Ten virtual seconds of steady traffic from 25 agents, a new event every 50 ms.
  let t = 0
  for (let ms = 0; ms < 10_000; ms += 50) {
    const agentId = ids[t++ % ids.length]!
    await $.tool.call({ tool: 'Bash', command: `npm test ${t}`, agentId } as never)
    await h.clock.advance(50)
  }
  const mapOnly = h.invalidations
  expect(mapOnly).toBeLessThanOrEqual(4 * 10 + 4)
  await runCommand($, 'panel')
  h.invalidations = 0
  for (let ms = 0; ms < 10_000; ms += 50) {
    const agentId = ids[t++ % ids.length]!
    await $.tool.call({ tool: 'Bash', command: `npm test ${t}`, agentId } as never)
    await h.clock.advance(50)
  }
  expect(h.invalidations).toBeLessThanOrEqual((4 + 1) * 10 + 4)
  expect(h.invalidations / 10).toBeLessThanOrEqual(10)
})

test('50 agents with the recorder on: a few store writes, none per call, and a record well under its cap', { timeoutMs: 30000, options: { recordSessions: 5 } }, async ($, on) => {
  const h = wire(on, true)
  on('session.end', () => ({ sessionId: 's' }) as never)
  let writes = 0
  let stored: unknown
  const data: Record<string, unknown> = {}
  on('store.get', (_$: unknown, e: any) => ({ value: data[e.key] }))
  on('store.set', (_$: unknown, e: any) => {
    data[e.key] = e.value
    if (e.key === 'recordings') { writes++; stored = e.value }
    return { value: undefined }
  })
  await $.session.start({ cwd: '/work' } as never)
  const ids: string[] = []
  for (let i = 0; i < 50; i++) ids.push(((await $.agent.spawn({ prompt: 'p', description: `fix db test ${i}`, subagentType: 'general-purpose', model: 'haiku', name: `worker-${i}` } as never)) as { agentId: string }).agentId)
  for (let round = 0; round < 4; round++) {
    for (const agentId of ids) {
      await $.tool.call({ tool: 'Bash', command: `npm test ${round}`, agentId } as never)
      await drain($.turn.step({ turnId: 't' + round, index: round, model: 'haiku', messageCount: 3, agentId } as never) as never)
    }
  }
  // Steady traffic writes nothing; 50 ends in a row write once at once and once more after the gap.
  expect(writes).toBe(0)
  for (const agentId of ids) await $.turn.complete({ turnId: 'z', agentId, answer: 'done' } as never)
  await h.clock.advance(6000)
  await h.clock.settle()
  expect(writes).toBe(2)
  await $.session.end({ reason: 'exit' } as never)
  expect(writes).toBeLessThanOrEqual(3)
  const [rec] = stored as { events: unknown[]; agents: unknown[] }[]
  expect(rec!.agents.length).toBe(50)
  // 50 spawns, 200 tool results, 200 requests, 50 ends, plus the ladder actions and one boot mark.
  expect(rec!.events.length).toBeGreaterThanOrEqual(501)
  const bytes = JSON.stringify(rec).length
  expect(bytes / rec!.events.length).toBeLessThan(120)
  expect(bytes).toBeLessThan(64 * 1024)
})

test('tool calls that only move counters are written once, one second after the last write, with the latest state', async ($, on) => {
  const h = wire(on)
  await $.session.start({ cwd: '/work' } as never)
  const agentId = ((await $.agent.spawn({ prompt: 'p', description: 'fix db test', subagentType: 'general-purpose', model: 'haiku' } as never)) as { agentId: string }).agentId
  const afterSpawn = h.sets
  for (let i = 0; i < 2; i++) await $.tool.call({ tool: 'Bash', command: `npm test ${i}`, agentId } as never)
  expect(h.sets).toBe(afterSpawn)
  await h.clock.advance(1100)
  await h.clock.settle()
  expect(h.sets).toBe(afterSpawn + 1)
  expect(JSON.stringify((h.lastValue as { agents: unknown[] }).agents)).toContain('npm test 1')
  await h.clock.advance(5000)
  expect(h.sets).toBe(afterSpawn + 1)
})
