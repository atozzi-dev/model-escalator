// Pure text renderer of the agent network for the terminal. No $ calls, no clock: the same graph, layout and
// options always give the same lines. It returns styled segments, never ANSI codes, so the wiring can map each
// segment 1:1 onto a `Text` element (props: color, bold, dimColor) inside a `Box flexDirection="column"`, one
// Box row per line. Status colours are theme keys (error, warning, success, inactive); tiers are mid-tone
// hex strings: haiku teal, sonnet blue, opus violet, lead orange, senior pink.
//
// One line per visible node, in the layout order (lead, workers by slot, "+N done", "+N more", senior):
//   <tree glyph><activity glyph> <badge> <label> <status> <action> L<n> $<cost> <marker> <recent event>
// Width is counted in code points (wide glyphs such as CJK are not measured): no line exceeds `width`.
// Every text field comes from agents, so control characters and escape sequences are stripped before use.
// Never throws: malformed input degrades to the lead line alone.

import { tierOf, LADDER, type Tier } from './detector'
import { LEAD_ID, SENIOR_ID, type GraphEvent, type GraphNode, type GraphState } from './graph'
import type { Layout } from './layout'

export type Segment = { text: string; color?: string; bold?: boolean; dim?: boolean }
export type Line = Segment[]

export type TreeOptions = {
  frame: number              // animation frame, driven by the wiring's frame clock
  width: number              // maximum line length in code points
  reducedMotion?: boolean    // static activity glyph
  lastSeq?: number           // events with a higher seq are "recent"; absent: none is
}

export const SPINNER: readonly string[] = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
export const STATIC_GLYPH = '●'

// Tier hues are mid-tone raw colours so they read on dark and light terminals alike; the status colours are
// engine theme keys, so they follow the person's theme.
export const TIER_COLORS = {
  haiku: '#0d9488', sonnet: '#3b82f6', opus: '#8b5cf6', lead: '#ea580c', senior: '#ec4899', stuck: 'error', paused: 'warning',
} as const

const MUTED = 'inactive'
const DONE = 'success'
const DEFAULT_WIDTH = 80
const ELLIPSIS = '…'

// Escape sequences first (CSI, OSC up to BEL or ST, any other ESC + one char), then every control character,
// bidi overrides, zero-width marks and line separators; whitespace controls become a space.
const OSC = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g
const CSI = /\u001b\[[0-?]*[ -/]*[@-~]?/g
const ESC = /\u001b[\s\S]?/g
const WHITESPACE_CONTROLS = new RegExp('[\t\n\r\v\f' + String.fromCharCode(0x85, 0x2028, 0x2029) + ']+', 'g')
const INVISIBLE = new RegExp('[\x00-\x1f\x7f-\x9f' + String.fromCharCode(0x200b) + '-' + String.fromCharCode(0x200f) +
  String.fromCharCode(0x202a) + '-' + String.fromCharCode(0x202e) + String.fromCharCode(0x2060) + '-' + String.fromCharCode(0x2069) +
  String.fromCharCode(0xfeff) + ']', 'g')

export function sanitize(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.replace(OSC, '').replace(CSI, '').replace(ESC, '').replace(WHITESPACE_CONTROLS, ' ').replace(INVISIBLE, '')
    .replace(/ {2,}/g, ' ').trim()
}

const glyphs = (s: string): string[] => Array.from(s)
const len = (s: string): number => glyphs(s).length

// Cuts `s` to `max` code points, ending with an ellipsis when something was cut.
export function clip(s: string, max: number): string {
  const g = glyphs(s)
  if (g.length <= max) return s
  if (max <= 0) return ''
  return g.slice(0, max - 1).join('') + ELLIPSIS
}

const spinnerGlyph = (frame: number, reduced: boolean): string => {
  if (reduced) return STATIC_GLYPH
  const f = Number.isFinite(frame) ? Math.floor(frame) : 0
  return SPINNER[((f % SPINNER.length) + SPINNER.length) % SPINNER.length] ?? STATIC_GLYPH
}

const money = (v: number): string => `$${(Number.isFinite(v) && v > 0 ? v : 0).toFixed(2)}`

const kindColor = (n: GraphNode): string =>
  n.kind === 'lead' ? TIER_COLORS.lead : n.kind === 'senior' ? TIER_COLORS.senior : TIER_COLORS[n.tier] ?? MUTED

const tierRank = (t: Tier | undefined): number => (t ? LADDER.indexOf(t) : -1)

type Recent = { text: string; color?: string }

// The most recent new event that involves the node, as a short suffix.
function recentFor(n: GraphNode, events: readonly GraphEvent[], lastSeq: number | undefined): Recent | undefined {
  if (typeof lastSeq !== 'number' || !Number.isFinite(lastSeq)) return undefined
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (!e || !(e.seq > lastSeq) || !Array.isArray(e.nodes) || !e.nodes.includes(n.id)) continue
    switch (e.kind) {
      case 'swap': {
        const up = tierRank(e.toTier) >= tierRank(e.fromTier)
        const to = e.toTier ?? n.tier
        return { text: `${up ? '↑' : '↓'} ${to}`, color: TIER_COLORS[to] }
      }
      case 'consult': return { text: n.kind === 'senior' ? 'advising…' : 'consulting…', color: TIER_COLORS.senior }
      case 'nudge': return { text: 'nudged' }
      case 'effort': return { text: 'more effort' }
      case 'human': return { text: 'needs you', color: TIER_COLORS.stuck }
      case 'stall': return { text: 'stalled', color: TIER_COLORS.stuck }
      case 'pause': return { text: 'paused', color: TIER_COLORS.paused }
      case 'resume': return { text: 'resumed' }
      case 'spawn': return n.kind === 'lead' ? undefined : { text: 'new' }
      case 'message': return { text: 'message' }
      case 'notice': return n.id === e.nodes[0] ? { text: 'noted lead' } : undefined
      default: continue
    }
  }
  return undefined
}

// Why a stuck node is stuck: the last stall/human/pause event decides the marker.
function markerFor(n: GraphNode, events: readonly GraphEvent[]): Recent | undefined {
  if (n.status === 'paused') return { text: '‖ paused', color: TIER_COLORS.paused }
  if (n.status !== 'stuck') return undefined
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (e && Array.isArray(e.nodes) && e.nodes.includes(n.id) && (e.kind === 'human' || e.kind === 'stall')) {
      return e.kind === 'human' ? { text: '⚠ needs you', color: TIER_COLORS.stuck } : { text: '⚠ stalled', color: TIER_COLORS.stuck }
    }
  }
  return { text: '⚠ stuck', color: TIER_COLORS.stuck }
}

const STATUS_WORD: Record<GraphNode['status'], string> = {
  active: 'working', waiting: 'waiting', done: 'done', stuck: 'stuck', paused: 'paused',
}

type Shape = { label: number; action: number; extras: boolean; recent: boolean }

function nodeLine(
  n: GraphNode, prefix: string, o: { frame: number; reduced: boolean; lastSeq?: number; events: readonly GraphEvent[] }, shape: Shape,
): Line {
  const color = kindColor(n)
  const badgeWord = n.kind === 'worker' ? n.tier : n.kind
  const label = clip(sanitize(n.label), shape.label)
  const action = clip(sanitize(n.action), shape.action)
  const marker = markerFor(n, o.events)
  const found = shape.recent ? recentFor(n, o.events, o.lastSeq) : undefined
  const recent = found && !(shape.extras && marker && marker.text.includes(found.text)) ? found : undefined
  const activity = n.status === 'active' ? spinnerGlyph(o.frame, o.reduced)
    : n.status === 'done' ? '✓' : n.status === 'waiting' ? '○' : n.status === 'paused' ? '‖' : '!'
  const line: Line = []
  if (prefix) line.push({ text: prefix, dim: true })
  line.push({ text: activity, color: n.status === 'stuck' ? TIER_COLORS.stuck : n.status === 'paused' ? TIER_COLORS.paused : n.status === 'done' ? DONE : color })
  line.push({ text: ' ' })
  line.push({ text: `[${badgeWord}]`, color, bold: true })
  if (n.kind !== 'worker') line.push({ text: ` ${n.tier}`, color: TIER_COLORS[n.tier] ?? MUTED })
  if (label && !(n.kind !== 'worker' && label === n.kind)) line.push({ text: ` ${label}` })
  line.push({ text: ` ${STATUS_WORD[n.status] ?? n.status}`, dim: true })
  if (action && shape.action > 0 && action !== STATUS_WORD[n.status]) line.push({ text: ` · ${action}`, dim: true })
  if (shape.extras) {
    if (n.level > 0) line.push({ text: ` L${Math.floor(n.level)}`, color: MUTED })
    if (n.cost > 0) line.push({ text: ` ${money(n.cost)}`, color: MUTED })
    if (marker) line.push({ text: ` ${marker.text}`, color: marker.color, bold: true })
  }
  if (recent) line.push({ text: ` ${recent.text}`, color: recent.color, bold: true })
  return line
}

const lineLength = (l: Line): number => l.reduce((n, s) => n + len(s.text), 0)

// Last resort: cuts the line segment by segment so it fits, ending with an ellipsis.
function hardClip(l: Line, width: number): Line {
  if (lineLength(l) <= width) return l
  const out: Line = []
  let left = width - 1
  for (const s of l) {
    if (left <= 0) break
    const g = glyphs(s.text)
    out.push(g.length <= left ? s : { ...s, text: g.slice(0, left).join('') })
    left -= g.length
  }
  const last = out[out.length - 1]
  if (width <= 0) return []
  return [...out, { text: ELLIPSIS, ...(last?.color ? { color: last.color } : {}), ...(last?.dim ? { dim: true } : {}) }]
}

function fit(build: (shape: Shape) => Line, width: number): Line {
  const full: Shape = { label: 40, action: 60, extras: true, recent: true }
  const attempts: Shape[] = [full]
  for (const action of [24, 14, 8]) attempts.push({ ...full, action })
  attempts.push({ ...full, action: 0 })
  attempts.push({ ...full, action: 0, extras: false })
  attempts.push({ label: 20, action: 0, extras: false, recent: true })
  attempts.push({ label: 20, action: 0, extras: false, recent: false })
  for (const label of [12, 8, 5]) attempts.push({ label, action: 0, extras: false, recent: false })
  for (const shape of attempts) {
    const l = build(shape)
    if (lineLength(l) <= width) return l
  }
  return hardClip(build({ label: 3, action: 0, extras: false, recent: false }), width)
}

function leadFallback(graph: unknown, options: TreeOptions, width: number): Line {
  const model = isRecord(graph) && Array.isArray(graph.nodes)
    ? ((graph.nodes as unknown[]).find((n) => isRecord(n) && n.id === LEAD_ID) as { model?: unknown } | undefined)?.model
    : undefined
  const tier = tierOf(typeof model === 'string' ? model : '')
  const node: GraphNode = {
    id: LEAD_ID, kind: 'lead', label: 'lead', model: typeof model === 'string' ? model : '', tier, status: 'waiting',
    action: 'waits', level: 0, score: 0, cost: 0, interventions: 0, consults: 0, since: 0,
  }
  const o = { frame: options.frame, reduced: options.reducedMotion === true, events: [] as GraphEvent[] }
  return fit((shape) => nodeLine(node, '', o, shape), width)
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

function renderUnsafe(graph: GraphState, layout: Layout, options: TreeOptions): Line[] {
  const width = Number.isFinite(options?.width) ? Math.max(1, Math.floor(options.width)) : DEFAULT_WIDTH
  const events = Array.isArray(graph.events) ? graph.events : []
  const byId = new Map<string, GraphNode>()
  for (const n of Array.isArray(graph.nodes) ? graph.nodes : []) if (isRecord(n) && typeof n.id === 'string') byId.set(n.id, n as unknown as GraphNode)
  const o = { frame: options.frame, reduced: options.reducedMotion === true, lastSeq: options.lastSeq, events }

  type Row = { node?: GraphNode; group?: string }
  const rows: Row[] = []
  const lead = byId.get(LEAD_ID)
  if (!lead) return [leadFallback(graph, options, width)]
  rows.push({ node: lead })
  const children: Row[] = []
  for (const ln of Array.isArray(layout?.nodes) ? layout.nodes : []) {
    if (ln.id === LEAD_ID) continue
    if (ln.kind === 'group') {
      const label = sanitize(ln.label) || `+${ln.count ?? 0} ${ln.group ?? ''}`.trim()
      children.push({ group: label })
      continue
    }
    const n = byId.get(ln.id)
    if (n && ln.id !== LEAD_ID) children.push({ node: n })
  }
  // The senior is a separate child of the lead and always closes the tree.
  children.sort((a, b) => Number(a.node?.id === SENIOR_ID) - Number(b.node?.id === SENIOR_ID))
  rows.push(...children)

  return rows.map((row, i): Line => {
    const prefix = i === 0 ? '' : i === rows.length - 1 ? '└─ ' : '├─ '
    if (row.group !== undefined) {
      return fit((shape) => [{ text: prefix, dim: true }, { text: clip(row.group ?? '', shape.label + 8), dim: true }], width)
    }
    const n = row.node as GraphNode
    return fit((shape) => nodeLine(n, prefix, o, shape), width)
  })
}

// Renders the graph as tree lines. Never throws: on malformed input it degrades to the lead line.
export function renderTree(graph: GraphState, layout: Layout, options: TreeOptions): Line[] {
  try {
    return renderUnsafe(graph, layout, options)
  } catch {
    try {
      const width = Number.isFinite(options?.width) ? Math.max(1, Math.floor(options.width)) : DEFAULT_WIDTH
      return [leadFallback(graph, options ?? { frame: 0, width }, width)]
    } catch {
      return [[{ text: 'lead' }]]
    }
  }
}

// The lines as plain strings (for tests, logs and a plain-text fallback).
export const plainLines = (lines: readonly Line[]): string[] => lines.map((l) => l.map((s) => s.text).join(''))
