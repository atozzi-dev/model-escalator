// Pure, stable layout of the agent network for the renderers. No $ calls, no clock, no randomness: the same
// graph and the same memory always give the same coordinates.
//
// Geometry: a vertical tree sized for a side pane (LAYOUT.width wide, top-left origin).
//   - the lead sits at the top left; the senior, once a consult happened, on the same row at the right;
//   - workers are full-width rows under the lead, one per slot (slot k is row k), indented to leave a gutter on
//     the left for the tree's trunk; a gutter on the right carries consults and messages between workers;
//   - group nodes ("+N done", "+N more") are shorter rows under the last slot.
// The canvas width never changes; the height grows with the last row in use, downwards only, so no existing
// box ever moves when the canvas grows.
//
// Stability policy. Each worker owns a slot; the slot map comes back with every layout and is passed in again
// next time (`previous`, a Layout or just { slots, retired }, JSON-safe so it can live in $.state). A position
// depends only on the slot, so a node moves only if its slot changes, and a slot changes only like this:
//   - a worker keeps its slot while it runs and after it finishes (finished workers are drawn in place);
//   - workers without a slot (new ones, or with an unusable previous slot) take the lowest free slot, live
//     workers first, then finished ones, each group in spawn order;
//   - when no slot is free, a live newcomer takes the slot of the finished worker that finished first (ties: the
//     lower slot); that worker is retired into "+N done". Nothing else moves;
//   - a retired worker never comes back to the grid, even if a slot frees up later (no flicker);
//   - if every slot holds a live worker, the newcomer waits in "+N more" and is promoted, in spawn order, as soon
//     as a slot frees up or a slot holder finishes;
//   - a worker that disappears from the graph frees its slot; the next newcomer may reuse that position.
// The output is bounded: at most LAYOUT.slots workers, the lead, the senior and two group nodes.
//
// Edges: every visible graph edge is routed as a polyline of horizontal and vertical segments (`points`), from a
// point on the border of its first box (x1, y1) to a point on the border of the second (x2, y2), through lanes
// that never cross a box: lead <-> row on a lane of the left gutter per kind (spawn, message, notice), row <->
// senior along the right edge, row <-> row through the right gutter. An endpoint that is hidden in a group is
// routed to that group node; parallel edges that end up between the same pair are merged (counts summed, latest
// `at`). An edge whose endpoints are both hidden, or that would loop on one node, is dropped.

import { LEAD_ID, SENIOR_ID, type EdgeKind, type GraphState, type NodeKind } from './graph'

export const LAYOUT = (() => {
  const width = 440
  const margin = 16
  const indent = 50                      // left edge of the rows: the gutter before it carries the tree's trunk
  const gutter = 24                      // right gutter: consults and messages between workers
  const rows = 30
  return {
    width, margin, indent, gutter, rows, slots: rows, members: 50,
    topW: 196,                           // lead and senior
    nodeW: width - margin - gutter - indent,
    nodeH: 50, groupH: 32, gapY: 10, topGap: 22,
    // x of the vertical lanes: the left ones start under the lead, one per edge kind; `right` runs in the right
    // gutter between rows, `senior` along the right edge up to the senior's bottom border
    lanes: { spawn: 24, message: 32, notice: 40, right: width - margin - gutter + 10, senior: width - margin - 6 },
  } as const
})()

export const GROUP_DONE_ID = 'group:done'
export const GROUP_MORE_ID = 'group:more'

export type GroupKind = 'done' | 'more'

export type LayoutNode = {
  readonly id: string
  readonly kind: NodeKind | 'group'
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
  readonly cx: number
  readonly cy: number
  readonly slot?: number                 // workers only
  readonly group?: GroupKind             // group nodes only
  readonly count?: number                // group nodes: hidden workers, including those the graph already folded away
  readonly label?: string                // group nodes: "+3 done", "+2 more"
  readonly members?: readonly string[]   // group nodes: ids of the hidden workers still in the graph, spawn order
}

export type LayoutEdge = {
  readonly id: string                    // kind|from|to, after routing
  readonly kind: EdgeKind
  readonly from: string                  // visible node ids (a group id when rerouted)
  readonly to: string
  readonly x1: number
  readonly y1: number
  readonly x2: number
  readonly y2: number
  readonly count: number
  readonly at: number
  readonly rerouted: boolean
  readonly points: readonly Point[]      // the route from (x1, y1) to (x2, y2): horizontal and vertical segments
}

export type Point = readonly [number, number]

export type LayoutMemory = {
  readonly slots?: Readonly<Record<string, number>>
  readonly retired?: readonly string[]
}

// Nodes are listed lead first, then workers by slot, then the groups, then the senior: a text tree can reuse it.
export type Layout = {
  readonly width: number
  readonly height: number
  readonly nodes: readonly LayoutNode[]
  readonly edges: readonly LayoutEdge[]
  readonly slots: Readonly<Record<string, number>>
  readonly retired: readonly string[]
}

const EDGE_KINDS: readonly string[] = ['spawn', 'message', 'consult', 'notice']

const WIDTH = LAYOUT.width
const rowY = (r: number): number => LAYOUT.margin + LAYOUT.nodeH + LAYOUT.topGap + r * (LAYOUT.nodeH + LAYOUT.gapY)

function box(id: string, kind: LayoutNode['kind'], x: number, y: number, w: number, h: number, extra: Partial<LayoutNode> = {}): LayoutNode {
  return { id, kind, x, y, w, h, cx: x + w / 2, cy: y + h / 2, ...extra }
}

const leadBox = (): LayoutNode => box(LEAD_ID, 'lead', LAYOUT.margin, LAYOUT.margin, LAYOUT.topW, LAYOUT.nodeH)
const seniorBox = (): LayoutNode =>
  box(SENIOR_ID, 'senior', LAYOUT.width - LAYOUT.margin - LAYOUT.topW, LAYOUT.margin, LAYOUT.topW, LAYOUT.nodeH)
const slotBox = (id: string, slot: number): LayoutNode => box(id, 'worker', LAYOUT.indent, rowY(slot), LAYOUT.nodeW, LAYOUT.nodeH, { slot })

// Group rows sit under the last slot: "+N done" first, then "+N more", each always at the same place.
function groupBox(group: GroupKind, count: number, members: readonly string[]): LayoutNode {
  const y = rowY(LAYOUT.rows) + (group === 'done' ? 0 : LAYOUT.groupH + LAYOUT.gapY)
  return box(group === 'done' ? GROUP_DONE_ID : GROUP_MORE_ID, 'group', LAYOUT.indent, y, LAYOUT.nodeW, LAYOUT.groupH, {
    group, count, label: `+${count} ${group}`, members,
  })
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const own = (o: Record<string, unknown>, k: string): unknown => (Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined)
const finite = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)
const counter = (v: unknown): number => Math.max(0, Math.floor(finite(v, 0)))

// Fallback for a pair no lane serves (the lead and the senior): bottom to top when one box is below the other,
// side to side otherwise, with an elbow halfway so every segment stays horizontal or vertical.
function direct(a: LayoutNode, b: LayoutNode): Point[] {
  if (b.y >= a.y + a.h || a.y >= b.y + b.h) {
    const down = b.y >= a.y + a.h
    const y1 = down ? a.y + a.h : a.y
    const y2 = down ? b.y : b.y + b.h
    const my = (y1 + y2) / 2
    return a.cx === b.cx ? [[a.cx, y1], [b.cx, y2]] : [[a.cx, y1], [a.cx, my], [b.cx, my], [b.cx, y2]]
  }
  const right = b.x >= a.x + a.w
  const x1 = right ? a.x + a.w : a.x
  const x2 = right ? b.x : b.x + b.w
  const mx = (x1 + x2) / 2
  return a.cy === b.cy ? [[x1, a.cy], [x2, b.cy]] : [[x1, a.cy], [mx, a.cy], [mx, b.cy], [x2, b.cy]]
}

const isRow = (n: LayoutNode): boolean => n.kind === 'worker' || n.kind === 'group'

// The route of one edge: the first point on `a`'s border, the last on `b`'s.
function route(kind: EdgeKind, a: LayoutNode, b: LayoutNode): Point[] {
  const L = LAYOUT.lanes
  const left = kind === 'spawn' ? L.spawn : kind === 'notice' ? L.notice : L.message
  if (a.kind === 'lead' && isRow(b)) return [[left, a.y + a.h], [left, b.cy], [b.x, b.cy]]
  if (isRow(a) && b.kind === 'lead') return [[a.x, a.cy], [left, a.cy], [left, b.y + b.h]]
  if (isRow(a) && b.kind === 'senior') return [[a.x + a.w, a.cy], [L.senior, a.cy], [L.senior, b.y + b.h]]
  if (a.kind === 'senior' && isRow(b)) return [[L.senior, a.y + a.h], [L.senior, b.cy], [b.x + b.w, b.cy]]
  if (isRow(a) && isRow(b)) return [[a.x + a.w, a.cy], [L.right, a.cy], [L.right, b.cy], [b.x + b.w, b.cy]]
  return direct(a, b)
}

type Worker = { id: string; done: boolean; since: number }
type Place = number | GroupKind

function layoutUnsafe(graph: GraphState, previous: LayoutMemory | undefined): Layout {
  const g: Record<string, unknown> = isRecord(graph) ? graph : {}
  const rawNodes = Array.isArray(g.nodes) ? (g.nodes as unknown[]) : []

  const workers: Worker[] = []
  const seen = new Set<string>([LEAD_ID, SENIOR_ID, GROUP_DONE_ID, GROUP_MORE_ID])
  let hasSenior = false
  for (const n of rawNodes) {
    if (!isRecord(n) || typeof n.id !== 'string') continue
    if (n.kind === 'senior' && n.id === SENIOR_ID) hasSenior = true
    if (n.kind !== 'worker' || !n.id || seen.has(n.id)) continue
    seen.add(n.id)
    workers.push({ id: n.id, done: n.status === 'done', since: finite(n.since, 0) })
  }

  const mem: Record<string, unknown> = isRecord(previous) ? previous : {}
  const prevSlots: Record<string, unknown> = isRecord(mem.slots) ? mem.slots : {}
  const retired = new Set<string>(Array.isArray(mem.retired) ? mem.retired.filter((x): x is string => typeof x === 'string') : [])

  const place = new Map<string, Place>()
  const holder: (Worker | undefined)[] = Array.from({ length: LAYOUT.slots }, () => undefined)

  // 1. keep the previous slots (the first claimant in spawn order wins a duplicated slot)
  for (const w of workers) {
    const s = own(prevSlots, w.id)
    if (typeof s === 'number' && Number.isInteger(s) && s >= 0 && s < LAYOUT.slots && !holder[s]) {
      holder[s] = w
      place.set(w.id, s)
    }
  }
  const freeSlot = (): number => holder.findIndex((h) => h === undefined)

  // 2. live workers without a slot: a free slot, else the slot of the earliest finished worker, else "+N more"
  for (const w of workers) {
    if (place.has(w.id) || w.done) continue
    let s = freeSlot()
    if (s < 0) {
      let victim = -1
      holder.forEach((h, i) => {
        if (h?.done && (victim < 0 || h.since < (holder[victim]?.since ?? 0))) victim = i
      })
      if (victim >= 0) {
        const old = holder[victim]
        if (old) place.set(old.id, 'done')
        s = victim
      }
    }
    if (s >= 0) {
      holder[s] = w
      place.set(w.id, s)
    } else {
      place.set(w.id, 'more')
    }
  }

  // 3. finished workers without a slot: retired ones stay folded, the others take a free slot if there is one
  for (const w of workers) {
    if (place.has(w.id)) continue
    const s = retired.has(w.id) ? -1 : freeSlot()
    if (s >= 0) {
      holder[s] = w
      place.set(w.id, s)
    } else {
      place.set(w.id, 'done')
    }
  }

  const doneMembers = workers.filter((w) => place.get(w.id) === 'done').map((w) => w.id)
  const moreMembers = workers.filter((w) => place.get(w.id) === 'more').map((w) => w.id)
  const doneCount = doneMembers.length + counter(g.collapsed)
  const moreCount = moreMembers.length + counter(g.dropped)

  const nodes: LayoutNode[] = [leadBox()]
  holder.forEach((w, s) => {
    if (w) nodes.push(slotBox(w.id, s))
  })
  if (doneCount > 0) nodes.push(groupBox('done', doneCount, doneMembers.slice(0, LAYOUT.members)))
  if (moreCount > 0) nodes.push(groupBox('more', moreCount, moreMembers.slice(0, LAYOUT.members)))
  if (hasSenior) nodes.push(seniorBox())

  const byId = new Map(nodes.map((n) => [n.id, n]))
  const resolve = (id: unknown): { id: string; hidden: boolean } | undefined => {
    if (typeof id !== 'string') return undefined
    const p = place.get(id)
    if (p === 'done') return byId.has(GROUP_DONE_ID) ? { id: GROUP_DONE_ID, hidden: true } : undefined
    if (p === 'more') return byId.has(GROUP_MORE_ID) ? { id: GROUP_MORE_ID, hidden: true } : undefined
    return byId.has(id) ? { id, hidden: false } : undefined
  }

  type Acc = { kind: EdgeKind; from: string; to: string; count: number; at: number; rerouted: boolean }
  const merged = new Map<string, Acc>()
  for (const e of Array.isArray(g.edges) ? (g.edges as unknown[]) : []) {
    if (!isRecord(e) || typeof e.kind !== 'string' || !EDGE_KINDS.includes(e.kind)) continue
    const a = resolve(e.from)
    const b = resolve(e.to)
    if (!a || !b || (a.hidden && b.hidden) || a.id === b.id) continue
    const kind = e.kind as EdgeKind
    const key = `${kind}|${a.id}|${b.id}`
    const count = Math.max(1, counter(e.count))
    const at = finite(e.at, 0)
    const cur = merged.get(key)
    if (cur) {
      cur.count += count
      cur.at = Math.max(cur.at, at)
      cur.rerouted = cur.rerouted || a.hidden || b.hidden
    } else {
      merged.set(key, { kind, from: a.id, to: b.id, count, at, rerouted: a.hidden || b.hidden })
    }
  }
  const edges: LayoutEdge[] = []
  for (const [id, m] of merged) {
    const a = byId.get(m.from)
    const b = byId.get(m.to)
    if (!a || !b) continue
    const points = route(m.kind, a, b)
    const [x1, y1] = points[0]!
    const [x2, y2] = points[points.length - 1]!
    edges.push({ id, kind: m.kind, from: m.from, to: m.to, x1, y1, x2, y2, count: m.count, at: m.at, rerouted: m.rerouted, points })
  }

  const bottom = nodes.reduce((y, n) => Math.max(y, n.y + n.h), 0)
  const slots = Object.fromEntries(holder.flatMap((w, s) => (w ? [[w.id, s] as const] : [])))
  return { width: WIDTH, height: bottom + LAYOUT.margin, nodes, edges, slots, retired: doneMembers.slice(0, LAYOUT.members) }
}

// Lays out the graph, keeping the slots of `previous` (the last Layout, or the { slots, retired } part of it).
// Never throws: on malformed input it degrades to the lead alone.
export function layoutGraph(graph: GraphState, previous?: LayoutMemory): Layout {
  try {
    return layoutUnsafe(graph, previous)
  } catch {
    const lead = leadBox()
    return { width: WIDTH, height: lead.y + lead.h + LAYOUT.margin, nodes: [lead], edges: [], slots: {}, retired: [] }
  }
}
