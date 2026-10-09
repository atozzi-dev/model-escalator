// Pure SVG renderer of the agent network: graph state + layout -> one complete SVG document, for the `Svg`
// element with `isInteractive: true` (a script-less sandboxed frame where CSS animations, :hover and <title>
// tooltips work). No $ calls, no clock, no randomness: the same input always gives the same string.
//
// Safety. Every piece of text that comes from agents (labels, actions, model names, tooltips) goes through
// escapeXml: control, bidi and lone-surrogate characters are stripped, then & < > " ' are escaped. Numbers are
// coerced to finite values, class names come from fixed lists, element ids are derived from agent ids by
// replacing anything outside [A-Za-z0-9_-] and appending a hash. Nothing references the outside world: no
// links, no images, no fonts from the network; the only url(#...) are the arrowheads defined in the document.
//
// Animation. The renderer is re-run on each change, so it animates only what is new: graph events with
// seq > opts.lastSeq (spawn fade-in, a flash on the senior for a consult, a colour cross-fade on a model swap,
// a blinking marker for stall / human / pause, a ping for nudge / effort / resume / notice, a flowing edge for
// spawn / message / consult / notice). State-driven motion stays on whatever lastSeq says: a pulsing halo on
// active nodes and a flowing edge while a consult is in progress. With opts.now, edges used in the last
// opts.recentMs keep flowing too. Pure CSS keyframes; prefers-reduced-motion stops all of them and keeps the
// static highlight (halo, dashed edge, thicker border).
//
// Size. The `Svg` element takes at most SVG_MAX characters. Past opts.budget (SVG_BUDGET by default) the
// renderer degrades step by step: one-line tooltips, then no animations, then no tooltips, then the lead
// alone with a note. The layout bounds the drawing (30 workers, the lead, the senior, two groups), so with 50
// agents and 100 events the full detail stays far below the budget.

import { LEAD_ID, SENIOR_ID, type GraphState } from './graph'
import { LAYOUT, type Layout } from './layout'
import type { Tier } from './detector'

export const SVG_MAX = 131_072
export const SVG_BUDGET = 120_000

export type Theme = 'auto' | 'light' | 'dark'

export type RenderOptions = {
  readonly lastSeq?: number    // events with seq <= lastSeq were already drawn: not animated again (default 0: all new)
  readonly theme?: Theme       // 'auto' (default) follows prefers-color-scheme
  readonly now?: number        // with recentMs: an edge used at or after now - recentMs keeps flowing
  readonly recentMs?: number   // default 4000
  readonly budget?: number     // max characters before degrading (default SVG_BUDGET, never above SVG_MAX)
}

type Detail = 'full' | 'short' | 'static' | 'bare' | 'lead'
type Kind = 'lead' | 'worker' | 'senior' | 'group'
type Status = 'active' | 'waiting' | 'done' | 'stuck' | 'paused'
type EdgeKind = 'spawn' | 'message' | 'consult' | 'notice'
type Mark = 'stall' | 'human' | 'pause'

const TIERS: readonly Tier[] = ['haiku', 'sonnet', 'opus']
const STATUSES: readonly Status[] = ['active', 'waiting', 'done', 'stuck', 'paused']
const KINDS: readonly Kind[] = ['lead', 'worker', 'senior', 'group']
const EDGE_KINDS: readonly EdgeKind[] = ['spawn', 'message', 'consult', 'notice']
const MAX_NODES = 64
const MAX_EDGES = 300
const MAX_EVENTS = 200

// ---------------------------------------------------------------------------------------------------- text

const SPACES = /[\t\n\r\u2028\u2029]/g
// C0/C1 controls, soft hyphen, bidi marks and overrides, zero-width and invisible format characters, BOM,
// non-characters, and lone surrogates (not valid XML).
const STRIP = /[\u0000-\u001F\u007F-\u009F\u00AD\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF\uFFF9-\uFFFB\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g
const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

const cleanText = (v: unknown): string => (typeof v === 'string' ? v.replace(SPACES, ' ').replace(STRIP, '') : '')

// Safe for element content and for double- or single-quoted attribute values.
export function escapeXml(v: unknown): string {
  return cleanText(v).replace(/[&<>"']/g, (c) => ESCAPES[c] ?? '')
}

// Cuts by code points (never in the middle of a surrogate pair), with an ellipsis when cut.
function clip(v: unknown, n: number): string {
  const chars = Array.from(cleanText(v))
  return chars.length > n ? chars.slice(0, Math.max(0, n - 1)).join('') + '…' : chars.join('')
}

const t = (v: unknown, n: number): string => escapeXml(clip(v, n))

// ------------------------------------------------------------------------------------------------- numbers

const finite = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)
const f = (v: unknown): string => {
  const r = Math.round(finite(v) * 10) / 10
  return Object.is(r, -0) ? '0' : String(r)
}
const trimZeros = (s: string): string => s.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')

function money(v: unknown): string {
  const c = finite(v)
  if (!(c > 0)) return '$0'
  if (c < 0.001) return '<$0.001'
  if (c < 1) return '$' + trimZeros(c.toFixed(3))
  if (c < 100) return '$' + c.toFixed(2)
  return '$' + String(Math.round(c))
}

const pick = <T extends string>(v: unknown, list: readonly T[], fallback: T): T =>
  (typeof v === 'string' && (list as readonly string[]).includes(v) ? (v as T) : fallback)

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

// FNV-1a over UTF-16 code units: a stable short suffix that keeps sanitised ids distinct.
function hash(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

const domId = (id: string): string => `n-${id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 24)}-${hash(id)}`

// --------------------------------------------------------------------------------------------------- model

type NodeView = {
  id: string
  kind: Kind
  x: number
  y: number
  w: number
  h: number
  label: string
  model: string
  tier: Tier
  status: Status
  action: string
  level: number
  score: number
  cost: number
  interventions: number
  consults: number
  history: Tier[]
  group?: 'done' | 'more'
  count?: number
  members?: string[]
  // animation flags
  appear: boolean
  flash: boolean
  ping: boolean
  swapFrom?: Tier
  mark?: Mark
  markNew: boolean
}

type EdgeView = {
  kind: EdgeKind
  from: string
  to: string
  x1: number
  y1: number
  x2: number
  y2: number
  count: number
  flow: 'on' | 'once' | 'off'
}

type Model = {
  width: number
  height: number
  theme: Theme
  nodes: NodeView[]
  edges: EdgeView[]
  workers: number
  hidden: number
}

type Ev = { seq: number; kind: string; nodes: string[]; fromTier?: Tier; toTier?: Tier }

const DEFAULT_W = 2 * LAYOUT.margin + LAYOUT.columns * LAYOUT.nodeW + (LAYOUT.columns - 1) * LAYOUT.gapX

function defaultLead(): Record<string, unknown> {
  return { id: LEAD_ID, kind: 'lead', x: (DEFAULT_W - LAYOUT.nodeW) / 2, y: LAYOUT.margin, w: LAYOUT.nodeW, h: LAYOUT.nodeH }
}

function buildModel(graph: unknown, layout: unknown, opts: RenderOptions): Model {
  const g = isRecord(graph) ? graph : {}
  const l = isRecord(layout) ? layout : {}
  const lastSeq = finite(opts.lastSeq, 0)

  const info = new Map<string, Record<string, unknown>>()
  let workers = 0
  for (const n of list(g.nodes)) {
    if (!isRecord(n) || typeof n.id !== 'string' || info.has(n.id)) continue
    info.set(n.id, n)
    if (n.kind === 'worker') workers++
  }

  const events: Ev[] = []
  for (const e of list(g.events).slice(-MAX_EVENTS)) {
    if (!isRecord(e) || typeof e.kind !== 'string') continue
    const nodes = list(e.nodes).filter((x): x is string => typeof x === 'string')
    events.push({
      seq: finite(e.seq), kind: e.kind, nodes,
      fromTier: TIERS.includes(e.fromTier as Tier) ? (e.fromTier as Tier) : undefined,
      toTier: TIERS.includes(e.toTier as Tier) ? (e.toTier as Tier) : undefined,
    })
  }
  events.sort((a, b) => a.seq - b.seq)
  const fresh = events.filter((e) => e.seq > lastSeq)

  let rawNodes = list(l.nodes).filter(isRecord).slice(0, MAX_NODES)
  if (!rawNodes.some((n) => n.id === LEAD_ID)) rawNodes = [defaultLead(), ...rawNodes]

  const nodes: NodeView[] = []
  const visible = new Set<string>()
  const groupOf = new Map<string, string>()
  let hidden = 0
  for (const ln of rawNodes) {
    if (typeof ln.id !== 'string' || visible.has(ln.id)) continue
    const kind = pick(ln.kind, KINDS, 'worker')
    const gn = info.get(ln.id) ?? {}
    const w = Math.min(400, Math.max(40, finite(ln.w, LAYOUT.nodeW)))
    const h = Math.min(200, Math.max(30, finite(ln.h, LAYOUT.nodeH)))
    const base: NodeView = {
      id: ln.id, kind, x: finite(ln.x), y: finite(ln.y), w, h,
      label: kind === 'lead' ? str(gn.label) || 'lead' : kind === 'senior' ? str(gn.label) || 'senior' : str(gn.label) || ln.id,
      model: str(gn.model), tier: pick(gn.tier, TIERS, 'sonnet'), status: pick(gn.status, STATUSES, 'waiting'),
      action: str(gn.action), level: Math.min(99, Math.max(0, Math.floor(finite(gn.level)))), score: finite(gn.score),
      cost: finite(gn.cost), interventions: Math.max(0, Math.floor(finite(gn.interventions))),
      consults: Math.max(0, Math.floor(finite(gn.consults))), history: [],
      appear: false, flash: false, ping: false, markNew: false,
    }
    if (kind === 'group') {
      base.group = ln.group === 'more' ? 'more' : 'done'
      base.count = Math.max(0, Math.floor(finite(ln.count)))
      base.members = list(ln.members).filter((m): m is string => typeof m === 'string').slice(0, 50)
      for (const m of base.members) groupOf.set(m, ln.id)
      hidden += base.count
    }
    visible.add(ln.id)
    nodes.push(base)
  }

  const resolve = (id: string | undefined): string | undefined =>
    id === undefined ? undefined : visible.has(id) ? id : groupOf.get(id)

  for (const n of nodes) {
    if (n.kind === 'group') continue
    const own = events.filter((e) => e.nodes[0] === n.id || (e.kind === 'spawn' && e.nodes[1] === n.id))
    const swaps = own.filter((e) => e.kind === 'swap' && e.toTier)
    if (swaps.length > 0) n.history = [swaps[0]!.fromTier ?? swaps[0]!.toTier!, ...swaps.map((e) => e.toTier!)]
    const newOwn = own.filter((e) => e.seq > lastSeq)
    n.appear = n.kind === 'worker' && newOwn.some((e) => e.kind === 'spawn' && e.nodes[1] === n.id)
    n.ping = newOwn.some((e) => ['nudge', 'effort', 'resume', 'notice'].includes(e.kind) && e.nodes[0] === n.id)
    const firstSwap = newOwn.find((e) => e.kind === 'swap' && e.fromTier && e.nodes[0] === n.id)
    if (n.kind === 'worker' && firstSwap?.fromTier && firstSwap.fromTier !== n.tier) n.swapFrom = firstSwap.fromTier
    if (n.kind === 'senior') n.flash = fresh.some((e) => e.kind === 'consult')
    if (n.status === 'stuck' || n.status === 'paused') {
      const kinds = n.status === 'paused' ? ['pause'] : ['stall', 'human']
      const last = [...own].reverse().find((e) => kinds.includes(e.kind) && e.nodes[0] === n.id)
      n.mark = n.status === 'paused' ? 'pause' : last?.kind === 'human' ? 'human' : 'stall'
      n.markNew = last !== undefined && last.seq > lastSeq
    }
  }

  const byId = new Map(nodes.map((n) => [n.id, n]))
  const freshPairs = new Set<string>()
  for (const e of fresh) {
    if (!(EDGE_KINDS as readonly string[]).includes(e.kind)) continue
    const a = resolve(e.nodes[0])
    const b = resolve(e.nodes[1])
    if (a && b) freshPairs.add(`${e.kind}|${a}|${b}`)
  }
  const now = typeof opts.now === 'number' && Number.isFinite(opts.now) ? opts.now : undefined
  const recentMs = Math.max(0, finite(opts.recentMs, 4000))

  const edges: EdgeView[] = []
  for (const e of list(l.edges).slice(0, MAX_EDGES)) {
    if (!isRecord(e) || typeof e.from !== 'string' || typeof e.to !== 'string') continue
    if (!(EDGE_KINDS as readonly string[]).includes(str(e.kind))) continue
    if (!byId.has(e.from) || !byId.has(e.to)) continue
    const kind = e.kind as EdgeKind
    const from = byId.get(e.from)!
    const to = byId.get(e.to)!
    const inProgress = kind === 'consult' && from.status === 'waiting' && to.kind === 'senior' && to.status === 'active'
    const recent = freshPairs.has(`${kind}|${e.from}|${e.to}`) || (now !== undefined && now - finite(e.at) <= recentMs)
    edges.push({
      kind, from: e.from, to: e.to, x1: finite(e.x1), y1: finite(e.y1), x2: finite(e.x2), y2: finite(e.y2),
      count: Math.max(1, Math.floor(finite(e.count, 1))), flow: inProgress ? 'on' : recent ? 'once' : 'off',
    })
  }

  const maxX = nodes.reduce((m, n) => Math.max(m, n.x + n.w), 0)
  const maxY = nodes.reduce((m, n) => Math.max(m, n.y + n.h), 0)
  const width = Math.min(4000, Math.max(200, finite(l.width, DEFAULT_W), maxX))
  const height = Math.min(10000, Math.max(100, finite(l.height, 0), maxY + LAYOUT.margin))
  return { width: Math.ceil(width), height: Math.ceil(height), theme: pick(opts.theme, ['auto', 'light', 'dark'] as const, 'auto'), nodes, edges, workers, hidden }
}

// ----------------------------------------------------------------------------------------------------- css

const LIGHT = {
  bg: '#f8fafc', card: '#ffffff', fg: '#0f172a', muted: '#475569', line: '#94a3b8', group: '#e2e8f0', on: '#ffffff',
  haiku: '#0d9488', sonnet: '#2563eb', opus: '#7c3aed', lead: '#c2410c', senior: '#db2777', stuck: '#dc2626', paused: '#b45309',
}
const DARK: typeof LIGHT = {
  bg: '#0b1120', card: '#111827', fg: '#e5e7eb', muted: '#9ca3af', line: '#64748b', group: '#1e293b', on: '#0b1120',
  haiku: '#2dd4bf', sonnet: '#60a5fa', opus: '#a78bfa', lead: '#fb923c', senior: '#f472b6', stuck: '#f87171', paused: '#fbbf24',
}
const vars = (p: typeof LIGHT): string => Object.entries(p).map(([k, v]) => `--${k}:${v}`).join(';')

const STATIC_CSS = [
  'svg{font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}',
  'text{fill:var(--fg)}.bg{fill:var(--bg)}',
  '.k-lead{--c:var(--lead)}.k-senior{--c:var(--senior)}.t-haiku{--c:var(--haiku)}.t-sonnet{--c:var(--sonnet)}.t-opus{--c:var(--opus)}',
  '.f-haiku{fill:var(--haiku)}.f-sonnet{fill:var(--sonnet)}.f-opus{fill:var(--opus)}.f-lead{fill:var(--lead)}.f-senior{fill:var(--senior)}',
  '.card{fill:var(--card);stroke:var(--c);stroke-width:1.5}.bar{fill:var(--c)}',
  '.lbl{font-size:12px;font-weight:600}.act{font-size:11px;fill:var(--muted)}.stt,.cost,.lvt{font-size:10px}.stt{fill:var(--muted)}',
  '.mid{text-anchor:middle}.end{text-anchor:end}.tbt{font-size:9px;font-weight:700;fill:var(--on)}.lv{fill:none;stroke:var(--muted)}',
  '.sd{fill:var(--muted)}.st-active .sd{fill:var(--c)}.st-stuck .sd{fill:var(--stuck)}.st-paused .sd{fill:var(--paused)}',
  '.st-done{opacity:.55}.st-waiting .card,.group .card{stroke-dasharray:4 3}.group .card{fill:var(--group);stroke:var(--line)}',
  '.glbl{font-size:12px;fill:var(--muted)}.a-flash .card{stroke-width:3}',
  '.mkc-stall,.mkc-human{fill:var(--stuck)}.mkc-pause{fill:var(--paused)}.mkt{font-size:9px;font-weight:700;fill:var(--on)}',
  '.edge{fill:none}.e-spawn{stroke:var(--line)}.e-message{stroke:var(--muted);stroke-dasharray:5 4}',
  '.e-consult{stroke:var(--senior);stroke-dasharray:5 4}.e-notice{stroke:var(--lead);stroke-dasharray:2 3}.flow,.flow1{stroke-dasharray:6 4}',
  '.ah-spawn{fill:var(--line)}.ah-message{fill:var(--muted)}.ah-consult{fill:var(--senior)}.ah-notice{fill:var(--lead)}',
  '.legend text,.note{font-size:10px;fill:var(--muted)}.legend .mkt{font-size:8px;fill:var(--on)}.le{stroke-width:2}',
].join('')

const MOTION_CSS = [
  '.halo{fill:none;stroke:var(--c);stroke-width:3;animation:pulse 1.8s ease-in-out infinite}',
  '.ring{fill:none;stroke:var(--c);stroke-width:2;opacity:0}.a-ping .ring{animation:fade 1s ease-out 2}',
  '.fl{fill:var(--senior);opacity:0}.a-flash .fl{animation:fade 1.2s ease-out 2}',
  '.swapfrom{opacity:0;animation:fade 2s ease-in}.ol{fill:none;stroke:var(--c);stroke-width:2}',
  '.a-pop{animation:blink .45s ease-in-out 4}.a-appear{animation:appear .6s ease-out}',
  '.flow{animation:flow .9s linear infinite}.flow1{animation:flow .9s linear 6}',
  '@keyframes pulse{0%,100%{opacity:.15}50%{opacity:.7}}@keyframes fade{from{opacity:.9}to{opacity:0}}',
  '@keyframes blink{50%{opacity:.2}}@keyframes appear{from{opacity:0}}@keyframes flow{to{stroke-dashoffset:-20}}',
  '@media (prefers-reduced-motion:reduce){*{animation:none!important}.halo{opacity:.4}}',
].join('')

function css(theme: Theme, motion: boolean): string {
  const palette = theme === 'dark' ? `svg{${vars(DARK)}}`
    : theme === 'light' ? `svg{${vars(LIGHT)}}`
    : `svg{${vars(LIGHT)}}@media (prefers-color-scheme:dark){svg{${vars(DARK)}}}`
  return palette + STATIC_CSS + (motion ? MOTION_CSS : '')
}

// ------------------------------------------------------------------------------------------------- drawing

const DEFS = '<defs>' + EDGE_KINDS.map((k) =>
  `<marker id="ah-${k}" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" markerUnits="userSpaceOnUse" orient="auto"><path class="ah-${k}" d="M0 0L8 4L0 8z"/></marker>`).join('') + '</defs>'

function legend(): string {
  const roles: [string, string][] = [['f-haiku', 'haiku'], ['f-sonnet', 'sonnet'], ['f-opus', 'opus'], ['f-lead', 'lead'], ['f-senior', 'senior']]
  const marks: [string, string, string][] = [['mkc-stall', '!', 'stalled'], ['mkc-human', '?', 'needs a human'], ['mkc-pause', 'II', 'paused']]
  let s = `<g class="legend" transform="translate(${LAYOUT.margin} ${LAYOUT.margin + 8})">`
  roles.forEach(([cls, word], i) => {
    s += `<rect class="${cls}" x="${i * 84}" y="-8" width="10" height="10" rx="2"/><text x="${i * 84 + 14}" y="1">${word}</text>`
  })
  EDGE_KINDS.forEach((k, i) => {
    s += `<path class="le e-${k}" d="M${i * 84} 16h18"/><text x="${i * 84 + 22}" y="19">${k}</text>`
  })
  marks.forEach(([cls, glyph, word], i) => {
    s += `<circle class="${cls}" cx="${i * 100 + 5}" cy="34" r="6"/><text class="mkt mid" x="${i * 100 + 5}" y="37">${glyph}</text><text x="${i * 100 + 15}" y="37">${word}</text>`
  })
  s += `<rect class="lv" x="300" y="27" width="20" height="12" rx="3"/><text class="mid" x="310" y="36.5">L2</text><text x="324" y="37">ladder level</text>`
  return s + '</g>'
}

function edgePath(e: EdgeView): string {
  const { x1, y1, x2, y2 } = e
  if (Math.abs(y2 - y1) >= 20) {
    const my = (y1 + y2) / 2
    return `M${f(x1)} ${f(y1)}C${f(x1)} ${f(my)} ${f(x2)} ${f(my)} ${f(x2)} ${f(y2)}`
  }
  const mx = (x1 + x2) / 2
  return `M${f(x1)} ${f(y1)}C${f(mx)} ${f(y1)} ${f(mx)} ${f(y2)} ${f(x2)} ${f(y2)}`
}

function drawEdge(e: EdgeView, labels: Map<string, string>, detail: Detail, motion: boolean): string {
  const flow = e.flow === 'on' ? ' flow' : e.flow === 'once' && motion ? ' flow1' : ''
  const width = f(1.5 + Math.min(2.5, Math.log2(e.count)))
  const times = e.count > 1 ? ` ×${e.count}` : ''
  const title = detail === 'full' ? `${e.kind}: ${t(labels.get(e.from), 24)} → ${t(labels.get(e.to), 24)}${times}`
    : detail === 'bare' ? '' : `${e.kind}${times}`
  const body = title ? `><title>${title}</title></path>` : '/>'
  return `<path class="edge e-${e.kind}${flow}" d="${edgePath(e)}" stroke-width="${width}" marker-end="url(#ah-${e.kind})"${body}`
}

function tooltip(n: NodeView, detail: Detail, labels: Map<string, string>): string {
  if (detail === 'bare' || detail === 'lead') return ''
  if (n.kind === 'group') {
    const head = `+${n.count ?? 0} ${n.group ?? 'done'}`
    if (detail !== 'full' || !n.members?.length) return `<title>${head}</title>`
    return `<title>${head}: ${t(n.members.map((m) => clip(labels.get(m) ?? m, 24)).join(', '), 400)}</title>`
  }
  if (detail !== 'full') return `<title>${t(n.label, 24)} (${n.tier}, ${n.status})</title>`
  const lines = [
    `${t(n.label, 40)} (${n.kind})`,
    `model ${t(n.model || n.tier, 100)}`,
    `status ${n.status}: ${t(n.action, 60)}`,
    `level L${n.level} · score ${f(n.score)} · cost ${escapeXml(money(n.cost))}`,
    `interventions ${n.interventions} · consults ${n.consults}`,
  ]
  if (n.history.length > 1) lines.push(`tiers ${n.history.join(' → ')}`)
  return `<title>${lines.join('\n')}</title>`
}

function drawNode(n: NodeView, detail: Detail, motion: boolean, labels: Map<string, string>): string {
  const { w, h } = n
  const open = (cls: string) => `<g id="${domId(n.id)}" class="${cls}" transform="translate(${f(n.x)} ${f(n.y)})">`
  if (n.kind === 'group') {
    return open('node group') + tooltip(n, detail, labels) +
      `<rect class="card" width="${f(w)}" height="${f(h)}" rx="8"/>` +
      `<text class="glbl mid" x="${f(w / 2)}" y="${f(h / 2 + 4)}">+${n.count ?? 0} ${n.group ?? 'done'}</text></g>`
  }
  const tone = n.kind === 'worker' ? `t-${n.tier}` : `k-${n.kind}`
  const anim = motion
    ? (n.appear ? ' a-appear' : '') + (n.flash ? ' a-flash' : '') + (n.ping ? ' a-ping' : '')
    : (n.flash ? ' a-flash' : '')
  let s = open(`node ${n.kind} ${tone} st-${n.status}${anim}`) + tooltip(n, detail, labels)
  if (motion && n.status === 'active') s += `<rect class="halo" x="-4" y="-4" width="${f(w + 8)}" height="${f(h + 8)}" rx="12"/>`
  if (motion && n.ping) s += `<rect class="ring" x="-7" y="-7" width="${f(w + 14)}" height="${f(h + 14)}" rx="14"/>`
  s += `<rect class="card" width="${f(w)}" height="${f(h)}" rx="8"/><rect class="bar" x="1.5" y="8" width="3" height="${f(h - 16)}" rx="1.5"/>`
  if (motion && n.flash) s += `<rect class="fl" width="${f(w)}" height="${f(h)}" rx="8"/>`
  if (motion && n.swapFrom) {
    s += `<g class="swapfrom t-${n.swapFrom}"><rect class="ol" width="${f(w)}" height="${f(h)}" rx="8"/><rect class="bar" x="1.5" y="8" width="3" height="${f(h - 16)}" rx="1.5"/></g>`
  }
  s += `<text class="lbl" x="12" y="18">${t(n.label, 15)}</text>`
  s += `<rect class="f-${n.tier}" x="${f(w - 50)}" y="7" width="44" height="15" rx="7.5"/><text class="tbt mid" x="${f(w - 28)}" y="17.5">${n.tier}</text>`
  s += `<text class="act" x="12" y="36">${t(n.action, 26)}</text>`
  s += `<circle class="sd" cx="15" cy="${f(h - 11)}" r="3"/><text class="stt" x="22" y="${f(h - 8)}">${n.status}</text>`
  s += `<rect class="lv" x="${f(w - 84)}" y="${f(h - 18)}" width="22" height="13" rx="3"/><text class="lvt mid" x="${f(w - 73)}" y="${f(h - 8)}">L${n.level}</text>`
  s += `<text class="cost end" x="${f(w - 8)}" y="${f(h - 8)}">${escapeXml(money(n.cost))}</text>`
  if (n.mark) {
    const glyph = n.mark === 'stall' ? '!' : n.mark === 'human' ? '?' : 'II'
    s += `<g class="mk mk-${n.mark}${motion && n.markNew ? ' a-pop' : ''}"><circle class="mkc-${n.mark}" r="8"/><text class="mkt mid" y="3">${glyph}</text></g>`
  }
  return s + '</g>'
}

function draw(m: Model, detail: Detail): string {
  const motion = detail === 'full' || detail === 'short'
  const nodes = detail === 'lead' ? m.nodes.filter((n) => n.id === LEAD_ID) : m.nodes
  const height = detail === 'lead' ? Math.max(...nodes.map((n) => n.y + n.h), 60) + 2 * LAYOUT.margin : m.height
  const labels = new Map(m.nodes.map((n) => [n.id, n.label]))
  const senior = m.nodes.some((n) => n.id === SENIOR_ID) ? ', a senior' : ''
  const summary = `Agent network: ${m.workers} worker${m.workers === 1 ? '' : 's'}${senior}`
  let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${m.width} ${height}" width="${m.width}" height="${height}" role="img" aria-label="${summary}" data-detail="${detail}">`
  s += `<title>${summary}</title><style>${css(m.theme, motion)}</style>${DEFS}`
  s += `<rect class="bg" width="${m.width}" height="${height}"/>`
  if (detail !== 'lead') s += legend()
  if (detail !== 'lead') s += '<g class="edges">' + m.edges.map((e) => drawEdge(e, labels, detail, motion)).join('') + '</g>'
  s += '<g class="nodes">' + nodes.map((n) => drawNode(n, detail, motion, labels)).join('') + '</g>'
  if (detail === 'lead') {
    const lead = nodes[0]
    const y = lead ? lead.y + lead.h + 16 : 100
    s += `<text class="note" x="${LAYOUT.margin}" y="${f(y)}">${m.workers} agents: too many details to draw here</text>`
  }
  return s + '</svg>'
}

const DETAILS: readonly Detail[] = ['full', 'short', 'static', 'bare']

// Renders the whole network as one SVG document. Never throws: malformed input draws the lead alone.
export function renderSvg(graph: GraphState, layout: Layout, opts: RenderOptions = {}): string {
  const o: RenderOptions = isRecord(opts) ? opts : {}
  const budget = Math.min(SVG_MAX - 1, Math.max(0, finite(o.budget, SVG_BUDGET)))
  let model: Model
  try {
    model = buildModel(graph, layout, o)
  } catch {
    model = buildModel(undefined, undefined, {})
  }
  for (const d of DETAILS) {
    const svg = draw(model, d)
    if (svg.length <= budget) return svg
  }
  return draw(model, 'lead')
}
