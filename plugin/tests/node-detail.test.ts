import { expect, test } from 'claude-code/testing'
import { newAgent, type AgentState } from '../hooks/detector'
import type { GraphEvent, GraphNode } from '../hooks/graph'
import { buildDetail, consultGate, DETAIL_LIMITS, findAgent, selectorChips, swapGate } from '../hooks/node-detail'

const agent = (over: Partial<AgentState> = {}): AgentState => ({ ...newAgent('a1', 'tests', 'haiku', 'fix the db test'), name: 'fixer', ...over })
const node = (over: Partial<GraphNode> = {}): GraphNode => ({
  id: 'a1', kind: 'worker', label: 'fixer', model: 'haiku', tier: 'haiku', status: 'active', action: 'runs the tests',
  level: 0, score: 0, cost: 0.0123, interventions: 0, consults: 0, since: 0, ...over,
})
const ev = (seq: number, kind: GraphEvent['kind'], nodes: string[]): GraphEvent => ({ seq, kind, at: seq, nodes })

test('the detail names the agent, its tiers, state, difficulty and cost', () => {
  const d = buildDetail({
    agent: agent({ tier: 'sonnet', level: 3, score: 1.5, consults: 1 }), node: node({ cost: 0.0123, status: 'stuck', tier: 'sonnet' }),
    events: [], consult: { ok: true }, swap: { ok: true },
  })
  const text = d.rows.map((r) => `${r.label}: ${r.value}`).join('\n')
  expect(d.title).toContain('fixer (a1)')
  expect(text).toContain('Category: tests')
  expect(text).toContain('Tier: sonnet (requested haiku)')
  expect(text).toContain('State: stuck')
  expect(text).toContain('Difficulty: level 3, score 1.5')
  expect(text).toContain('Cost: $0.0123')
  expect(text).toContain('Consults: 1')
})

test('a tier as requested says so, and a paused agent says paused', () => {
  const d = buildDetail({ agent: agent({ paused: true }), node: node({ status: 'paused' }), events: [], consult: { ok: true }, swap: { ok: true } })
  const text = d.rows.map((r) => `${r.label}: ${r.value}`).join('\n')
  expect(text).toContain('Tier: haiku (as requested)')
  expect(text).toContain('State: paused')
})

test('interventions are counted per kind from the events that name the agent', () => {
  const d = buildDetail({
    agent: agent(), node: node({ interventions: 4 }),
    events: [ev(1, 'nudge', ['a1']), ev(2, 'consult', ['a1', 'senior']), ev(3, 'swap', ['a1']), ev(4, 'nudge', ['b2']), ev(5, 'spawn', ['a1'])],
    consult: { ok: true }, swap: { ok: true },
  })
  const row = d.rows.find((r) => r.label === 'Interventions')!
  expect(row.value).toContain('4')
  expect(row.value).toContain('nudge 1')
  expect(row.value).toContain('consult 1')
  expect(row.value).toContain('swap 1')
  expect(row.value).not.toContain('spawn')
})

test('an agent without interventions says none', () => {
  const d = buildDetail({ agent: agent(), node: node(), events: [], consult: { ok: true }, swap: { ok: true } })
  expect(d.rows.find((r) => r.label === 'Interventions')!.value).toBe('none')
})

test('the last failed attempts come from the log, newest last, redacted and capped', () => {
  const log = [
    'Bash: npm test -> ERR <n> failed',
    'Read: a.ts -> ok',
    'Bash: curl -H "Authorization: Bearer abcdefghijklmnop" x -> ERR denied',
    'Bash: node build.js --token=supersecretvalue99 -> ERR boom ' + 'x'.repeat(400),
    'Edit: b.ts -> ERR conflict',
    'Bash: npm test -> ERR fourth',
  ]
  const d = buildDetail({ agent: agent({ log }), node: node(), events: [], consult: { ok: true }, swap: { ok: true } })
  expect(d.attempts.length).toBe(DETAIL_LIMITS.attempts)
  expect(d.attempts.at(-1)).toContain('fourth')
  const all = d.attempts.join('\n')
  expect(all).not.toContain('abcdefghijklmnop')
  expect(all).not.toContain('supersecretvalue99')
  expect(all).toContain('[redacted]')
  for (const a of d.attempts) expect(a.length).toBeLessThanOrEqual(DETAIL_LIMITS.attemptChars)
  expect(all).not.toContain('Read: a.ts')
})

test('no failed attempt gives an empty list', () => {
  const d = buildDetail({ agent: agent({ log: ['Read: a.ts -> ok'] }), node: node(), events: [], consult: { ok: true }, swap: { ok: true } })
  expect(d.attempts).toEqual([])
})

test('an agent whose node was folded away still has a detail, with an unknown cost', () => {
  const d = buildDetail({ agent: agent(), events: [], consult: { ok: true }, swap: { ok: true } })
  expect(d.rows.find((r) => r.label === 'Cost')!.value).toBe('unknown')
})

const ctx = { mode: 'active', done: false, allowed: 'opus' as const, maxTier: 'opus' as const }

test('the consult gate: only in active mode, for a live unpaused agent, within the limits', () => {
  expect(consultGate(agent(), { mode: 'active', done: false })).toEqual({ ok: true })
  const observe = consultGate(agent(), { mode: 'observe', done: false })
  expect(observe.ok).toBe(false)
  expect(observe.ok === false && observe.reason).toContain('active mode')
  const done = consultGate(agent(), { mode: 'active', done: true })
  expect(done.ok === false && done.reason).toContain('finished')
  const paused = consultGate(agent({ paused: true }), { mode: 'active', done: false })
  expect(paused.ok === false && paused.reason).toContain('paused')
  const capped = consultGate(agent(), { mode: 'active', done: false, limit: 'per agent (3 consults)' })
  expect(capped.ok === false && capped.reason).toContain('per agent (3 consults)')
})

test('the swap gate: one tier up, never above maxTier or a refused tier', () => {
  expect(swapGate(agent(), ctx)).toEqual({ ok: true })
  expect(swapGate(agent({ tier: 'sonnet' }), ctx)).toEqual({ ok: true })
  const top = swapGate(agent({ tier: 'opus' }), ctx)
  expect(top.ok === false && top.reason).toContain('top tier')
  const capped = swapGate(agent({ tier: 'sonnet' }), { ...ctx, allowed: 'sonnet', maxTier: 'sonnet' })
  expect(capped.ok === false && capped.reason).toContain('maxTier')
  const blocked = swapGate(agent({ tier: 'sonnet' }), { ...ctx, allowed: 'sonnet', maxTier: 'opus' })
  expect(blocked.ok === false && blocked.reason).toContain('not available')
  expect(swapGate(agent(), { ...ctx, mode: 'baseline' }).ok).toBe(false)
  expect(swapGate(agent(), { ...ctx, done: true }).ok).toBe(false)
  expect(swapGate(agent({ paused: true }), ctx).ok).toBe(false)
})

test('findAgent matches an id, then a name, and says why when it cannot', () => {
  const list = [agent(), { ...agent({ name: 'scout' }), id: 'a2' }, { ...agent({ name: 'scout' }), id: 'a3' }]
  expect(findAgent(list, 'a1')).toEqual({ agent: list[0] })
  expect(findAgent(list, 'FIXER')).toEqual({ agent: list[0] })
  const twice = findAgent(list, 'scout')
  expect('error' in twice && twice.error).toContain('a2')
  expect('error' in twice && twice.error).toContain('a3')
  const none = findAgent(list, 'nope')
  expect('error' in none && none.error).toContain('No agent')
  expect('error' in none && none.error).toContain('a1')
  expect('error' in findAgent(list, '  ')).toBe(true)
})

test('the selector chips are capped, keep the newest and always the selected one', () => {
  const list = Array.from({ length: 12 }, (_, i) => ({ ...agent(), id: `w${i}`, name: `n${i}` }))
  const chips = selectorChips(list, undefined)
  expect(chips.length).toBe(DETAIL_LIMITS.chips)
  expect(chips.at(-1)!.id).toBe('w11')
  const kept = selectorChips(list, 'w0')
  expect(kept.length).toBe(DETAIL_LIMITS.chips)
  expect(kept.some((c) => c.id === 'w0' && c.selected)).toBe(true)
  expect(kept.filter((c) => c.selected).length).toBe(1)
  expect(chips[0]!.label).toContain('n4')
})
