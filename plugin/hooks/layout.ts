// Pure, stable layout of the agent network for the renderers. No $ calls, no clock, no randomness: the same
// graph and the same memory always give the same coordinates.
//
// Geometry (all boxes are LAYOUT.nodeW x LAYOUT.nodeH, top-left origin):
//   - the lead sits at the top, centred on the worker grid;
//   - workers fill a fixed grid of LAYOUT.columns x LAYOUT.rows slots below the lead. Slot k is in row
//     floor(k / columns); inside a row slots fill from the centre outwards, so a few workers stay under the lead;
//   - the senior, once a consult happened, sits on the lead's row above the last column, to the right;
//   - group nodes ("+N done", "+N more") sit on a fixed row under the grid, two centre columns.
// The canvas width never changes (the grid has a fixed number of columns); the height grows with the last row
// in use, downwards only, so no existing box ever moves when the canvas grows.
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
// Edges: every visible graph edge gets two anchor points on the borders of its boxes. An endpoint that is hidden
// in a group is routed to that group node; parallel edges that end up between the same pair are merged (counts
// summed, latest `at`). An edge whose endpoints are both hidden, or that would loop on one node, is dropped.

import { LEAD_ID, SENIOR_ID, type EdgeKind, type GraphState, type NodeKind } from './graph'

export const LAYOUT = (() => {
  const columns = 6
  const rows = 5
  return { nodeW: 168, nodeH: 60, gapX: 24, gapY: 40, margin: 24, columns, rows, slots: columns * rows, members: 50 } as const
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
}

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

const GRID_W = LAYOUT.columns * LAYOUT.nodeW + (LAYOUT.columns - 1) * LAYOUT.gapX
const WIDTH = 2 * LAYOUT.margin + GRID_W

// Column of each position inside a row, from the centre outwards (6 columns: 2, 3, 1, 4, 0, 5).
const COLUMN_ORDER: readonly number[] = Array.from({ length: LAYOUT.columns }, (_, c) => c)
  .sort((a, b) => Math.abs(a - (LAYOUT.columns - 1) / 2) - Math.abs(b - (LAYOUT.columns - 1) / 2) || a - b)

const colX = (c: number): number => LAYOUT.margin + c * (LAYOUT.nodeW + LAYOUT.gapX)
const rowY = (r: number): number => LAYOUT.margin + LAYOUT.nodeH + LAYOUT.gapY + r * (LAYOUT.nodeH + LAYOUT.gapY)

function box(id: string, kind: LayoutNode['kind'], x: number, y: number, extra: Partial<LayoutNode> = {}): LayoutNode {
  return { id, kind, x, y, w: LAYOUT.nodeW, h: LAYOUT.nodeH, cx: x + LAYOUT.nodeW / 2, cy: y + LAYOUT.nodeH / 2, ...extra }
}

const leadBox = (): LayoutNode => box(LEAD_ID, 'lead', LAYOUT.margin + (GRID_W - LAYOUT.nodeW) / 2, LAYOUT.margin)
const seniorBox = (): LayoutNode => box(SENIOR_ID, 'senior', colX(LAYOUT.columns - 1), LAYOUT.margin)
const slotBox = (id: string, slot: number): LayoutNode =>
  box(id, 'worker', colX(COLUMN_ORDER[slot % LAYOUT.columns] ?? 0), rowY(Math.floor(slot / LAYOUT.columns)), { slot })

function groupBox(group: GroupKind, count: number, members: readonly string[]): LayoutNode {
  const centre = Math.floor((LAYOUT.columns - 1) / 2)
  const col = group === 'done' ? centre : centre + 1
  return box(group === 'done' ? GROUP_DONE_ID : GROUP_MORE_ID, 'group', colX(col), rowY(LAYOUT.rows), {
    group, count, label: `+${count} ${group}`, members,
  })
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const own = (o: Record<string, unknown>, k: string): unknown => (Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined)
const finite = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)
const counter = (v: unknown): number => Math.max(0, Math.floor(finite(v, 0)))

// Anchor points on the borders of two boxes: bottom to top when one is below the other, side to side otherwise.
function anchors(a: LayoutNode, b: LayoutNode): [number, number, number, number] {
  if (b.y >= a.y + a.h) return [a.cx, a.y + a.h, b.cx, b.y]
  if (a.y >= b.y + b.h) return [a.cx, a.y, b.cx, b.y + b.h]
  if (b.x >= a.x + a.w) return [a.x + a.w, a.cy, b.x, b.cy]
  return [a.x, a.cy, b.x + b.w, b.cy]
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
    const [x1, y1, x2, y2] = anchors(a, b)
    edges.push({ id, kind: m.kind, from: m.from, to: m.to, x1, y1, x2, y2, count: m.count, at: m.at, rerouted: m.rerouted })
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
