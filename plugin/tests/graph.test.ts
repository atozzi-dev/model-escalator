import { expect, test } from 'claude-code/testing'
import { actionText, emptyGraph, reduce, GRAPH_LIMITS, type GraphInput, type GraphState } from '../hooks/graph'

const run = (inputs: GraphInput[], from: GraphState = emptyGraph('claude-opus-5-5', 0)): GraphState =>
  inputs.reduce((s, i) => reduce(s, i), from)
const node = (s: GraphState, id: string) => s.nodes.find((n) => n.id === id)
const spawn = (id: string, at = 1, model = 'claude-haiku-5-5'): GraphInput =>
  ({ type: 'spawn', at, agentId: id, label: 'worker ' + id, model })

test('the empty graph has only the lead', () => {
  const s = emptyGraph('claude-opus-5-5', 0)
  expect(s.nodes.map((n) => n.id)).toEqual(['lead'])
  expect(node(s, 'lead')?.kind).toBe('lead')
  expect(node(s, 'lead')?.tier).toBe('opus')
})

test('spawn creates a worker node, a spawn edge and an event', () => {
  const s = run([spawn('a')])
  const w = node(s, 'a')
  expect(w?.kind).toBe('worker')
  expect(w?.tier).toBe('haiku')
  expect(w?.status).toBe('active')
  expect(s.edges.some((e) => e.kind === 'spawn' && e.from === 'lead' && e.to === 'a')).toBe(true)
  expect(s.events.at(-1)?.kind).toBe('spawn')
  expect(s.events.at(-1)?.nodes).toEqual(['lead', 'a'])
})

test('tool events update the action in plain words', () => {
  let s = run([spawn('a'), { type: 'tool-start', at: 2, agentId: 'a', tool: 'Read', summary: 'C:\\proj\\src\\app.ts' }])
  expect(node(s, 'a')?.action).toBe('reads app.ts')
  s = reduce(s, { type: 'tool-start', at: 3, agentId: 'a', tool: 'Edit', summary: '/p/lib.sh' })
  expect(node(s, 'a')?.action).toBe('edits lib.sh')
  s = reduce(s, { type: 'tool-start', at: 4, agentId: 'a', tool: 'Bash', summary: 'npm test -- --watch' })
  expect(node(s, 'a')?.action).toBe('runs the tests')
  s = reduce(s, { type: 'tool-start', at: 5, agentId: 'a', tool: 'Bash', summary: 'git status' })
  expect(node(s, 'a')?.action).toBe('runs git')
  s = reduce(s, { type: 'tool-end', at: 6, agentId: 'a', tool: 'Bash' })
  expect(node(s, 'a')?.action).toBe('thinks')
})

test('action table covers common and unknown tools', () => {
  expect(actionText('ask_for_help')).toBe('asks for help')
  expect(actionText('Grep', 'foo')).toBe('searches the code')
  expect(actionText('Glob')).toBe('lists files')
  expect(actionText('Write', 'a/b/new.md')).toBe('writes new.md')
  expect(actionText('Frobnicate')).toBe('uses Frobnicate')
  expect(actionText('Read')).toBe('reads a file')
})

test('events without an agent id go to the lead', () => {
  const s = run([{ type: 'tool-start', at: 2, tool: 'Read', summary: 'x.ts' }])
  expect(node(s, 'lead')?.action).toBe('reads x.ts')
})

test('a model step records the model, adds cost, and thinks', () => {
  const s = run([spawn('a'), { type: 'step', at: 2, agentId: 'a', model: 'claude-haiku-5-5', cost: 0.01 },
    { type: 'step', at: 3, agentId: 'a', model: 'claude-haiku-5-5', cost: 0.02 }])
  expect(Math.abs((node(s, 'a')?.cost ?? 0) - 0.03) < 1e-9).toBe(true)
  expect(node(s, 'a')?.action).toBe('thinks')
  expect(node(run([{ type: 'step', at: 1, agentId: 'a', model: 'x', cost: -5 }]), 'a')).toBeUndefined()
})

test('a swap changes the tier, keeps an event and counts the intervention', () => {
  const s = run([spawn('a'), { type: 'ladder', at: 2, agentId: 'a', action: 'swap', toModel: 'claude-sonnet-5-5', level: 3, score: 7 }])
  const w = node(s, 'a')
  expect(w?.tier).toBe('sonnet')
  expect(w?.model).toBe('claude-sonnet-5-5')
  expect(w?.interventions).toBe(1)
  expect(w?.level).toBe(3)
  expect(w?.score).toBe(7)
  const ev = s.events.at(-1)
  expect(ev?.kind).toBe('swap')
  expect(ev?.fromTier).toBe('haiku')
  expect(ev?.toTier).toBe('sonnet')
})

test('a nudge and a human step become events, human marks the node stuck', () => {
  let s = run([spawn('a'), { type: 'ladder', at: 2, agentId: 'a', action: 'nudge' }])
  expect(s.events.at(-1)?.kind).toBe('nudge')
  expect(node(s, 'a')?.interventions).toBe(1)
  s = reduce(s, { type: 'ladder', at: 3, agentId: 'a', action: 'human' })
  expect(s.events.at(-1)?.kind).toBe('human')
  expect(node(s, 'a')?.status).toBe('stuck')
})

test('a consult creates the senior node and a consult edge, then returns the worker to work', () => {
  let s = run([spawn('a'), { type: 'consult', at: 2, agentId: 'a', phase: 'start', model: 'claude-opus-5-5' }])
  expect(node(s, 'senior')?.kind).toBe('senior')
  expect(node(s, 'senior')?.status).toBe('active')
  expect(node(s, 'a')?.status).toBe('waiting')
  expect(node(s, 'a')?.action).toBe('asks for help')
  expect(s.edges.some((e) => e.kind === 'consult' && e.from === 'a' && e.to === 'senior')).toBe(true)
  expect(s.events.at(-1)?.kind).toBe('consult')
  s = reduce(s, { type: 'consult', at: 3, agentId: 'a', phase: 'end', cost: 0.5 })
  expect(node(s, 'a')?.status).toBe('active')
  expect(node(s, 'a')?.consults).toBe(1)
  expect(node(s, 'senior')?.status).toBe('waiting')
  expect(node(s, 'senior')?.cost).toBe(0.5)
  s = reduce(s, { type: 'consult', at: 4, agentId: 'a', phase: 'start' })
  expect(s.nodes.filter((n) => n.kind === 'senior').length).toBe(1)
  expect(s.edges.filter((e) => e.kind === 'consult').length).toBe(1)
  expect(s.edges.find((e) => e.kind === 'consult')?.count).toBe(2)
})

test('stall, pause, resume and done set statuses and events', () => {
  let s = run([spawn('a'), { type: 'stall', at: 2, agentId: 'a' }])
  expect(node(s, 'a')?.status).toBe('stuck')
  expect(s.events.at(-1)?.kind).toBe('stall')
  s = reduce(s, { type: 'pause', at: 3, agentId: 'a' })
  expect(node(s, 'a')?.status).toBe('paused')
  s = reduce(s, { type: 'tool-start', at: 4, agentId: 'a', tool: 'Read', summary: 'x' })
  expect(node(s, 'a')?.status).toBe('paused')
  s = reduce(s, { type: 'resume', at: 5, agentId: 'a' })
  expect(node(s, 'a')?.status).toBe('active')
  expect(s.events.at(-1)?.kind).toBe('resume')
  s = reduce(s, { type: 'complete', at: 6, agentId: 'a' })
  expect(node(s, 'a')?.status).toBe('done')
  expect(s.events.at(-1)?.kind).toBe('done')
  s = reduce(s, { type: 'tool-start', at: 7, agentId: 'a', tool: 'Read', summary: 'x' })
  expect(node(s, 'a')?.status).toBe('done')
})

test('a message between two teammates makes a message edge that counts', () => {
  let s = run([spawn('a'), spawn('b'), { type: 'message', at: 3, from: 'a', to: 'b', text: 'hi' }])
  expect(s.edges.some((e) => e.kind === 'message' && e.from === 'a' && e.to === 'b')).toBe(true)
  expect(s.events.at(-1)?.kind).toBe('message')
  s = reduce(s, { type: 'message', at: 4, from: 'a', to: 'b' })
  expect(s.edges.find((e) => e.kind === 'message')?.count).toBe(2)
  const before = s.events.length
  s = reduce(s, { type: 'message', at: 5, from: 'a', to: 'ghost' })
  expect(s.events.length).toBe(before)
})

test('a notice to the lead draws a notice edge', () => {
  const s = run([spawn('a'), { type: 'notice', at: 2, agentId: 'a' }])
  expect(s.edges.some((e) => e.kind === 'notice' && e.from === 'a' && e.to === 'lead')).toBe(true)
  expect(s.events.at(-1)?.kind).toBe('notice')
})

test('the lead completing a turn waits instead of finishing', () => {
  const s = run([{ type: 'tool-start', at: 1, tool: 'Read', summary: 'x' }, { type: 'complete', at: 2 }])
  expect(node(s, 'lead')?.status).toBe('waiting')
})

test('the worker cap collapses the oldest finished workers into a count', () => {
  const inputs: GraphInput[] = []
  for (let i = 0; i < GRAPH_LIMITS.workers + 5; i++) {
    inputs.push(spawn('w' + i, i + 1), { type: 'complete', at: i + 1, agentId: 'w' + i })
  }
  const s = run(inputs)
  expect(s.nodes.filter((n) => n.kind === 'worker').length).toBe(GRAPH_LIMITS.workers)
  expect(s.collapsed).toBe(5)
  expect(node(s, 'w0')).toBeUndefined()
  expect(node(s, 'w' + (GRAPH_LIMITS.workers + 4))).toBeDefined()
  expect(s.edges.every((e) => node(s, e.from) && node(s, e.to))).toBe(true)
})

test('when no finished worker can collapse, a new spawn is dropped and counted', () => {
  const inputs: GraphInput[] = []
  for (let i = 0; i < GRAPH_LIMITS.workers + 3; i++) inputs.push(spawn('w' + i, i + 1))
  const s = run(inputs)
  expect(s.nodes.filter((n) => n.kind === 'worker').length).toBe(GRAPH_LIMITS.workers)
  expect(s.dropped).toBe(3)
})

test('the event queue is bounded and sequence numbers keep growing', () => {
  const inputs: GraphInput[] = [spawn('a'), spawn('b')]
  for (let i = 0; i < GRAPH_LIMITS.events + 20; i++) inputs.push({ type: 'message', at: i + 5, from: 'a', to: 'b' })
  const s = run(inputs)
  expect(s.events.length).toBe(GRAPH_LIMITS.events)
  expect(s.events.at(-1)?.seq).toBe(s.seq)
  expect(s.seq > GRAPH_LIMITS.events).toBe(true)
})

test('text fields are length-capped and not escaped', () => {
  const s = run([{ type: 'spawn', at: 1, agentId: 'a', label: '<b>' + 'x'.repeat(500), model: 'm' },
    { type: 'tool-start', at: 2, agentId: 'a', tool: 'Read', summary: 'y'.repeat(900) + '.ts' }])
  expect((node(s, 'a')?.label.length ?? 0) <= GRAPH_LIMITS.label).toBe(true)
  expect(node(s, 'a')?.label.startsWith('<b>')).toBe(true)
  expect((node(s, 'a')?.action.length ?? 0) <= GRAPH_LIMITS.text).toBe(true)
})

test('reducers are pure: the input state is not mutated', () => {
  const s0 = run([spawn('a')])
  const snapshot = JSON.stringify(s0)
  const inputs: GraphInput[] = [
    { type: 'tool-start', at: 2, agentId: 'a', tool: 'Read', summary: 'x' },
    { type: 'ladder', at: 3, agentId: 'a', action: 'swap', toModel: 'claude-sonnet-5-5' },
    { type: 'consult', at: 4, agentId: 'a', phase: 'start' },
    { type: 'message', at: 5, from: 'a', to: 'lead' },
    { type: 'stall', at: 6, agentId: 'a' },
    { type: 'complete', at: 7, agentId: 'a' },
  ]
  for (const i of inputs) reduce(s0, i)
  expect(JSON.stringify(s0)).toBe(snapshot)
})

test('malformed input never throws and leaves the state alone', () => {
  const s0 = run([spawn('a')])
  for (const bad of [null, undefined, 42, {}, { type: 'nope' }, { type: 'spawn' }, { type: 'ladder', agentId: 'a', action: 'x' }]) {
    expect(reduce(s0, bad as unknown as GraphInput)).toEqual(s0)
  }
  expect(reduce(s0, { type: 'tool-start', at: 1, agentId: 'ghost', tool: 'Read' })).toEqual(s0)
})
