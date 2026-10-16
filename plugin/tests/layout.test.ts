import { expect, test } from 'claude-code/testing'
import { emptyGraph, reduce, type GraphInput, type GraphState } from '../hooks/graph'
import { layoutGraph, LAYOUT, type Layout, type LayoutNode } from '../hooks/layout'

const base = (): GraphState => emptyGraph('claude-opus-5-5', 0)
const run = (inputs: GraphInput[], from: GraphState = base()): GraphState => inputs.reduce((s, i) => reduce(s, i), from)
const spawn = (id: string, at = 1): GraphInput => ({ type: 'spawn', at, agentId: id, label: 'worker ' + id, model: 'claude-haiku-5-5' })
const done = (id: string, at = 2): GraphInput => ({ type: 'complete', at, agentId: id })
const ids = (n: number, from = 0): string[] => Array.from({ length: n }, (_, i) => 'w' + (i + from))
const spawnAll = (list: string[]): GraphInput[] => list.map((id, i) => spawn(id, i + 1))
const at = (l: Layout, id: string): LayoutNode | undefined => l.nodes.find((n) => n.id === id)
const pos = (l: Layout, id: string) => {
  const n = at(l, id)
  return n ? { x: n.x, y: n.y } : undefined
}

function overlaps(a: LayoutNode, b: LayoutNode): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

function expectNoOverlap(l: Layout): void {
  for (let i = 0; i < l.nodes.length; i++) {
    for (let j = i + 1; j < l.nodes.length; j++) {
      const a = l.nodes[i]!
      const b = l.nodes[j]!
      if (overlaps(a, b)) throw new Error(`${a.id} overlaps ${b.id}`)
    }
  }
}

function expectInside(l: Layout): void {
  for (const n of l.nodes) {
    expect(n.x).toBeGreaterThanOrEqual(0)
    expect(n.y).toBeGreaterThanOrEqual(0)
    expect(n.x + n.w).toBeLessThanOrEqual(l.width)
    expect(n.y + n.h).toBeLessThanOrEqual(l.height)
  }
}

test('an empty graph lays out the lead alone, at the top left', () => {
  const l = layoutGraph(base())
  expect(l.nodes.map((n) => n.id)).toEqual(['lead'])
  const lead = at(l, 'lead')!
  expect(lead.kind).toBe('lead')
  expect(lead.x).toBe(LAYOUT.margin)
  expect(lead.y).toBe(LAYOUT.margin)
  expect(l.edges).toEqual([])
  expectInside(l)
})

test('1, 5 and 30 workers fit without overlapping boxes', () => {
  for (const n of [1, 5, 30]) {
    const l = layoutGraph(run(spawnAll(ids(n))))
    const workers = l.nodes.filter((x) => x.kind === 'worker')
    expect(workers.length).toBe(n)
    expect(l.nodes.some((x) => x.kind === 'group')).toBe(false)
    expectNoOverlap(l)
    expectInside(l)
    const lead = at(l, 'lead')!
    for (const w of workers) expect(w.y).toBeGreaterThan(lead.y + lead.h)
  }
})

test('the canvas keeps its width and grows in height with the rows', () => {
  const one = layoutGraph(run(spawnAll(ids(1))))
  const thirty = layoutGraph(run(spawnAll(ids(30))))
  expect(thirty.width).toBe(one.width)
  expect(thirty.height).toBeGreaterThan(one.height)
})

test('the first worker sits under the lead', () => {
  const l = layoutGraph(run(spawnAll(ids(1))))
  const w = at(l, 'w0')!
  const lead = at(l, 'lead')!
  expect(w.y).toBeGreaterThan(lead.y + lead.h)
  expect(w.x).toBeGreaterThan(lead.x)
  expect(w.x).toBeLessThan(lead.x + lead.w)
})

test('the canvas fits a side pane: at most 480 wide, whatever the number of workers', () => {
  for (const n of [0, 1, 4, 30, 40]) {
    let g = run(spawnAll(ids(n)))
    g = reduce(g, { type: 'consult', at: 99, agentId: 'w0', phase: 'start' })
    const l = layoutGraph(g)
    expect(l.width).toBeLessThanOrEqual(480)
    expectInside(l)
  }
})

test('workers stack in one column under the lead, one per row, in slot order', () => {
  const l = layoutGraph(run(spawnAll(ids(6))))
  const workers = l.nodes.filter((n) => n.kind === 'worker')
  const lead = at(l, 'lead')!
  for (const w of workers) expect(w.x).toBe(workers[0]!.x)
  for (let i = 1; i < workers.length; i++) expect(workers[i]!.y).toBeGreaterThanOrEqual(workers[i - 1]!.y + workers[i - 1]!.h)
  // indented under the lead, leaving a gutter for the tree's trunk, and wider than the lead for long names
  expect(workers[0]!.x).toBeGreaterThan(lead.x + 16)
  expect(workers[0]!.w).toBeGreaterThan(lead.w)
})

test('the "+N done" and "+N more" groups sit under the last row', () => {
  let g = run(spawnAll(ids(34)))
  g = run(ids(3).map((id) => done(id, 100)), g)
  g = run(spawnAll(ids(3, 40)), g)
  const l = layoutGraph(g)
  const bottom = Math.max(...l.nodes.filter((n) => n.kind === 'worker').map((n) => n.y + n.h))
  const groups = l.nodes.filter((n) => n.kind === 'group')
  expect(groups.length).toBe(2)
  for (const grp of groups) expect(grp.y).toBeGreaterThanOrEqual(bottom)
  expectNoOverlap(l)
  expectInside(l)
})

test('adding a worker does not move the existing ones', () => {
  let g = run(spawnAll(ids(5)))
  const before = layoutGraph(g)
  g = reduce(g, spawn('w5', 10))
  const after = layoutGraph(g, before)
  for (const id of ['lead', ...ids(5)]) expect(pos(after, id)).toEqual(pos(before, id))
  expect(at(after, 'w5')).toBeDefined()
  expectNoOverlap(after)
})

test('positions stay put one worker at a time up to 30', () => {
  let g = base()
  let prev: Layout | undefined
  const seen = new Map<string, { x: number; y: number }>()
  for (const id of ids(30)) {
    g = reduce(g, spawn(id))
    const l = layoutGraph(g, prev)
    for (const [k, p] of seen) expect(pos(l, k)).toEqual(p)
    seen.set(id, pos(l, id)!)
    prev = l
  }
})

test('finishing a worker does not move any node', () => {
  let g = run(spawnAll(ids(6)))
  const before = layoutGraph(g)
  g = reduce(g, done('w2'))
  const after = layoutGraph(g, before)
  for (const id of ['lead', ...ids(6)]) expect(pos(after, id)).toEqual(pos(before, id))
  expect(after.slots['w2']).toBe(before.slots['w2'])
})

test('workers without a slot take the lowest free slots in spawn order', () => {
  const g = run(spawnAll(ids(4)))
  const l = layoutGraph(g, { slots: { w0: 0, w2: 2 } })
  expect(l.slots).toEqual({ w0: 0, w1: 1, w2: 2, w3: 3 })
})

test('the senior appears to the side of the lead after a consult', () => {
  let g = run(spawnAll(ids(4)))
  const before = layoutGraph(g)
  expect(at(before, 'senior')).toBeUndefined()
  g = reduce(g, { type: 'consult', at: 5, agentId: 'w1', phase: 'start', model: 'claude-opus-5-5' })
  const after = layoutGraph(g, before)
  const senior = at(after, 'senior')!
  const lead = at(after, 'lead')!
  expect(senior.kind).toBe('senior')
  expect(senior.y).toBe(lead.y)
  expect(senior.x).toBeGreaterThan(lead.x + lead.w)
  for (const id of ['lead', ...ids(4)]) expect(pos(after, id)).toEqual(pos(before, id))
  expectNoOverlap(after)
  expectInside(after)
  expect(after.edges.some((e) => e.kind === 'consult' && e.from === 'w1' && e.to === 'senior')).toBe(true)
})

test('the senior does not overlap a full grid', () => {
  let g = run(spawnAll(ids(30)))
  g = reduce(g, { type: 'consult', at: 50, agentId: 'w0', phase: 'start' })
  const l = layoutGraph(g)
  expectNoOverlap(l)
  expectInside(l)
})

test('beyond 30 live workers the rest go into a "+N more" group', () => {
  const g = run(spawnAll(ids(34)))
  const l = layoutGraph(g)
  expect(l.nodes.filter((n) => n.kind === 'worker').length).toBe(LAYOUT.slots)
  const more = at(l, 'group:more')!
  expect(more.kind).toBe('group')
  expect(more.count).toBe(4)
  expect(more.label).toBe('+4 more')
  expect(more.members).toEqual(['w30', 'w31', 'w32', 'w33'])
  expect(at(l, 'w33')).toBeUndefined()
  expectNoOverlap(l)
  expectInside(l)
})

test('finished workers collapse into "+N done" first, live ones keep the slots', () => {
  const list = ids(40)
  const g = run([...spawnAll(list), ...ids(10).map((id) => done(id, 100))])
  const l = layoutGraph(g)
  const doneGroup = at(l, 'group:done')!
  expect(doneGroup.count).toBe(10)
  expect(doneGroup.label).toBe('+10 done')
  expect(at(l, 'group:more')).toBeUndefined()
  for (const id of ids(30, 10)) expect(at(l, id)).toBeDefined()
  expectNoOverlap(l)
  expectInside(l)
})

test('a live newcomer takes the slot of the oldest finished worker, nothing else moves', () => {
  let g = run(spawnAll(ids(30)))
  g = run([done('w7', 40), done('w3', 41)], g)
  const before = layoutGraph(g)
  g = reduce(g, spawn('w30', 50))
  const after = layoutGraph(g, before)
  expect(pos(after, 'w30')).toEqual(pos(before, 'w7'))
  expect(at(after, 'w7')).toBeUndefined()
  expect(at(after, 'group:done')?.members).toEqual(['w7'])
  for (const id of ids(30).filter((x) => x !== 'w7')) expect(pos(after, id)).toEqual(pos(before, id))
  expectNoOverlap(after)
})

test('a retired worker stays in its group even when slots are free', () => {
  const g = run([...spawnAll(ids(3)), done('w0', 10)])
  const l = layoutGraph(g, { slots: {}, retired: ['w0'] })
  expect(at(l, 'w0')).toBeUndefined()
  expect(at(l, 'group:done')?.members).toEqual(['w0'])
  expect(l.retired).toEqual(['w0'])
  expect(l.slots).toEqual({ w1: 0, w2: 1 })
})

test('an overflowing live worker is promoted when a finished one can make room', () => {
  let g = run(spawnAll(ids(31)))
  const l1 = layoutGraph(g)
  expect(at(l1, 'group:more')?.members).toEqual(['w30'])
  g = reduce(g, done('w12', 60))
  const l2 = layoutGraph(g, l1)
  expect(pos(l2, 'w30')).toEqual(pos(l1, 'w12'))
  expect(at(l2, 'group:more')).toBeUndefined()
  expect(at(l2, 'group:done')?.members).toEqual(['w12'])
})

test('the output stays bounded with many agents', () => {
  let g = run(spawnAll(ids(80)))
  g = run(ids(80).map((id, i) => ({ type: 'message', at: 200 + i, from: id, to: 'w' + ((i + 1) % 80) }) as GraphInput), g)
  g = reduce(g, { type: 'consult', at: 400, agentId: 'w45', phase: 'start' })
  const l = layoutGraph(g)
  expect(l.nodes.length).toBeLessThanOrEqual(LAYOUT.slots + 4)
  expect(l.edges.length).toBeLessThanOrEqual((LAYOUT.slots + 4) * (LAYOUT.slots + 3) * 4)
  const more = at(l, 'group:more')!
  expect(more.count).toBe(20 + g.dropped)
  expectNoOverlap(l)
  expectInside(l)
})

test('edges to hidden workers are routed to their group and merged', () => {
  let g = run(spawnAll(ids(33)))
  g = run([
    { type: 'message', at: 60, from: 'w31', to: 'w0' },
    { type: 'message', at: 61, from: 'w32', to: 'w0' },
    { type: 'message', at: 62, from: 'w31', to: 'w32' },
  ], g)
  const l = layoutGraph(g)
  const spawnToGroup = l.edges.filter((e) => e.kind === 'spawn' && e.to === 'group:more')
  expect(spawnToGroup.length).toBe(1)
  expect(spawnToGroup[0]!.count).toBe(3)
  expect(spawnToGroup[0]!.rerouted).toBe(true)
  const msg = l.edges.filter((e) => e.kind === 'message' && e.from === 'group:more' && e.to === 'w0')
  expect(msg.length).toBe(1)
  expect(msg[0]!.count).toBe(2)
  expect(msg[0]!.at).toBe(61)
  // w31 -> w32: both hidden, no edge at all
  expect(l.edges.some((e) => e.from === e.to)).toBe(false)
  expect(l.edges.filter((e) => e.kind === 'message').length).toBe(1)
  const visible = new Set(l.nodes.map((n) => n.id))
  for (const e of l.edges) {
    expect(visible.has(e.from)).toBe(true)
    expect(visible.has(e.to)).toBe(true)
  }
})

test('edge endpoints sit on the boxes they connect', () => {
  let g = run(spawnAll(ids(8)))
  g = run([
    { type: 'message', at: 30, from: 'w2', to: 'w3' },
    { type: 'consult', at: 31, agentId: 'w7', phase: 'start' },
  ], g)
  const l = layoutGraph(g)
  const onBorder = (n: LayoutNode, x: number, y: number) => {
    const inX = x >= n.x - 0.001 && x <= n.x + n.w + 0.001
    const inY = y >= n.y - 0.001 && y <= n.y + n.h + 0.001
    const edgeX = Math.abs(x - n.x) < 0.001 || Math.abs(x - n.x - n.w) < 0.001
    const edgeY = Math.abs(y - n.y) < 0.001 || Math.abs(y - n.y - n.h) < 0.001
    return inX && inY && (edgeX || edgeY)
  }
  expect(l.edges.length).toBe(10)
  for (const e of l.edges) {
    expect(onBorder(at(l, e.from)!, e.x1, e.y1)).toBe(true)
    expect(onBorder(at(l, e.to)!, e.x2, e.y2)).toBe(true)
  }
  const s = l.edges.find((e) => e.kind === 'spawn' && e.to === 'w0')!
  const lead = at(l, 'lead')!
  const w0 = at(l, 'w0')!
  expect(s.y1).toBe(lead.y + lead.h)
  expect(s.x2).toBe(w0.x)
  expect(s.y2).toBe(w0.cy)
})

// Every routed edge is a polyline of horizontal and vertical segments from (x1, y1) to (x2, y2) that never runs
// through the inside of a box.
test('edges are routed around the boxes, in straight segments', () => {
  let g = run(spawnAll(ids(8)))
  g = run([
    { type: 'message', at: 30, from: 'w2', to: 'w5' },
    { type: 'message', at: 31, from: 'w6', to: 'lead' },
    { type: 'message', at: 32, from: 'lead', to: 'w4' },
    { type: 'notice', at: 33, agentId: 'w3' },
    { type: 'consult', at: 34, agentId: 'w7', phase: 'start' },
    { type: 'consult', at: 35, agentId: 'w1', phase: 'start' },
  ], g)
  const l = layoutGraph(g)
  expect(l.edges.length).toBe(14)
  const inside = (n: LayoutNode, x: number, y: number) => x > n.x + 0.5 && x < n.x + n.w - 0.5 && y > n.y + 0.5 && y < n.y + n.h - 0.5
  for (const e of l.edges) {
    const pts = e.points
    expect(pts.length).toBeGreaterThanOrEqual(2)
    expect(pts[0]).toEqual([e.x1, e.y1])
    expect(pts[pts.length - 1]).toEqual([e.x2, e.y2])
    for (let i = 1; i < pts.length; i++) {
      const [ax, ay] = pts[i - 1]!
      const [bx, by] = pts[i]!
      expect(ax === bx || ay === by).toBe(true)
      // sample the segment and check no point falls inside any box
      for (let k = 0; k <= 20; k++) {
        const x = ax + ((bx - ax) * k) / 20
        const y = ay + ((by - ay) * k) / 20
        for (const n of l.nodes) if (inside(n, x, y)) throw new Error(`${e.id} runs through ${n.id}`)
      }
    }
  }
})

test('the same input gives the same output', () => {
  let g = run(spawnAll(ids(36)))
  g = run([done('w4', 50), done('w9', 51), { type: 'consult', at: 52, agentId: 'w1', phase: 'start' }], g)
  const prev = layoutGraph(run(spawnAll(ids(20))))
  const a = layoutGraph(g, prev)
  const b = layoutGraph(g, JSON.parse(JSON.stringify(prev)) as Layout)
  expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  expect(JSON.stringify(layoutGraph(g))).toBe(JSON.stringify(layoutGraph(g)))
})

test('the layout memory survives a JSON round trip', () => {
  const g = run(spawnAll(ids(12)))
  const l = layoutGraph(g)
  const again = layoutGraph(g, JSON.parse(JSON.stringify({ slots: l.slots, retired: l.retired })))
  expect(again).toEqual(l)
})

test('workers are listed in slot order after the lead', () => {
  const l = layoutGraph(run(spawnAll(ids(7))))
  expect(l.nodes.map((n) => n.id)).toEqual(['lead', ...ids(7)])
  expect(l.nodes.filter((n) => n.kind === 'worker').map((n) => n.slot)).toEqual([0, 1, 2, 3, 4, 5, 6])
})

test('malformed input never throws', () => {
  const g = run(spawnAll(ids(3)))
  const bad = [
    { slots: { w0: -1, w1: 1.5, w2: 'x' } },
    { slots: { w0: 2, w1: 2, w2: 2 } },
    { slots: { w0: 99 } },
    { slots: null, retired: 'w0' },
    null,
    42,
  ]
  for (const p of bad) {
    const l = layoutGraph(g, p as never)
    expect(l.nodes.filter((n) => n.kind === 'worker').length).toBe(3)
    expectNoOverlap(l)
    const used = Object.values(l.slots)
    expect(new Set(used).size).toBe(used.length)
  }
  const dup = layoutGraph(g, { slots: { w0: 2, w1: 2, w2: 2 } })
  expect(dup.slots['w0']).toBe(2)
  for (const garbage of [null, undefined, {}, { nodes: 'x' }, { nodes: [null, { id: 3 }] }]) {
    const l = layoutGraph(garbage as never)
    expect(l.nodes.map((n) => n.id)).toEqual(['lead'])
  }
})
