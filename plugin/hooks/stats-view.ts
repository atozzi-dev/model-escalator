// The statistics panel as data: sections of rows of cells, no engine calls. `register.ts` maps it to Box and Text
// elements per surface. Pure and total: malformed input degrades to fewer or empty rows, never throws.
import { costPerAccepted, HALF_LIFE_MS, type Stats } from './learning'
import { costSplit, savings, type Ledger } from './savings'
import { ADVICE, type Advice } from './advice'

// align: numbers are right-aligned. short: a narrower text used when the column has to give way. clip: 'middle'
// cuts a name in its middle, keeping the end that tells similar names apart ("gen…:bugfix").
export type ViewCell = { text: string; bold?: boolean; dim?: boolean; align?: 'right'; short?: string; clip?: 'middle' }
export type ViewSection = { id: 'session' | 'plan' | 'categories' | 'learned' | 'advice'; title: string; rows: ViewCell[][] }
export type StatsView = { sections: ViewSection[] }

export type StatsInput = {
  mode: string
  baseline: string
  ledger: Ledger
  paused: string[]            // one label per paused agent
  claudeCost?: number         // the session total Claude Code reports (USD), when it does
  plan: string                // the report's "Plan usage" block, '' when there is none
  stats: Stats                // learned statistics (global)
  advice?: Advice[]           // cheaper-model suggestions (advice.ts), none by default
  now?: number
  halfLifeMs?: number
  topRows?: number            // rows per table, default 5
}

const TOP_ROWS = 5
const num = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) ? x : 0)
const usd = (x: number): string => (x < 0 ? '-' : '') + '$' + (x !== 0 && Math.abs(x) < 0.01 ? Math.abs(x).toFixed(4) : Math.abs(x).toFixed(2))
const num1 = (x: number): string => String(Math.round(x * 10) / 10)
const pct = (x: number, base: number): number => (base > 0 ? Math.round((x / base) * 100) : 0)

const label = (text: string): ViewCell => ({ text, dim: true })
const plain = (text: string): ViewCell => ({ text })
const name = (text: string): ViewCell => ({ text, clip: 'middle' })
const right = (text: string, short?: string): ViewCell => ({ text, align: 'right', ...(short !== undefined ? { short } : {}) })
// A table header: the first column names the rows (left), the others hold numbers (right).
const head = (first: string, ...rest: (string | [string, string])[]): ViewCell[] => [
  { text: first, bold: true, dim: true },
  ...rest.map((t): ViewCell => (Array.isArray(t)
    ? { text: t[0], short: t[1], bold: true, dim: true, align: 'right' }
    : { text: t, bold: true, dim: true, align: 'right' })),
]

// The lead and the agents apart, when the ledger has the split.
function splitRows(l: Ledger): ViewCell[][] {
  const s = costSplit(l)
  return s ? [[label('Lead'), plain(`${usd(s.lead)}, ${s.pct}% of the session`)], [label('Subagents'), plain(usd(s.agents))]] : []
}

function sessionRows(i: StatsInput): ViewCell[][] {
  const l = i.ledger
  const s = savings({ ...l, actual: num(l.actual), baselineHigh: num(l.baselineHigh), baselineLow: num(l.baselineLow) })
  const iv = Object.entries(l.interventions && typeof l.interventions === 'object' ? l.interventions : {})
    .filter(([, n]) => typeof n === 'number').map(([k, n]) => `${k} ${n}`).join(', ')
  return [
    [label('Mode'), plain(`${i.mode} (baseline ${i.baseline})`)],
    [label('Cost'), plain(`${usd(num(l.actual))} (consults ${num(l.consults)}, ${usd(num(l.consultCost))})`)],
    [label(`All on ${i.baseline}`), plain(`${usd(num(l.baselineLow))} to ${usd(num(l.baselineHigh))}`)],
    [label('Savings'), plain(`${usd(s.low)} to ${usd(s.high)} (${s.lowPct}% to ${s.highPct}%)`)],
    ...splitRows(l),
    ...(i.claudeCost !== undefined && Number.isFinite(i.claudeCost)
      ? [[label('Claude Code'), plain(`${usd(i.claudeCost)} reported, the mod metered ${usd(num(l.actual))}`)]]
      : []),
    [label('Interventions'), plain(iv || 'none')],
    [label('Paused'), plain(i.paused.length > 0 ? i.paused.join('; ') : 'none')],
  ]
}

function planRows(plan: string): ViewCell[][] {
  // The first line is the block's title, which the section carries.
  return plan.split('\n').slice(1).map((l) => l.trim()).filter(Boolean).map((l) => [plain(l)])
}

function categoryRows(l: Ledger, top: number): ViewCell[][] {
  const map = l && typeof l.byCategory === 'object' && l.byCategory ? l.byCategory : {}
  const rows = Object.entries(map)
    .filter(([, r]) => r && typeof r === 'object')
    .map(([name, r]) => ({ name, actual: num(r.actual), high: num(r.baselineHigh), low: num(r.baselineLow), agents: num(r.agents), esc: num(r.escalated) }))
    .sort((a, b) => b.actual - a.actual || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  if (rows.length === 0) return [[label('No category data yet.')]]
  const out: ViewCell[][] = [head('Category', 'Cost', 'Saved', ['Escalated', 'Esc'])]
  for (const r of rows.slice(0, top)) {
    out.push([name(r.name), right(usd(r.actual)), right(`${pct(r.low - r.actual, r.low)}% to ${pct(r.high - r.actual, r.high)}%`), right(`${r.esc}/${r.agents}`)])
  }
  if (rows.length > top) out.push([label(`+${rows.length - top} more`)])
  return out
}

function learnedRows(i: StatsInput, top: number): ViewCell[][] {
  const halfLife = i.halfLifeMs ?? HALF_LIFE_MS
  const rows: { name: string; runs: number; na: number; best?: { e: number; tier: string }; reviews: number; score: number; rework: number }[] = []
  const stats = i.stats && typeof i.stats === 'object' ? i.stats : {}
  for (const [name, row] of Object.entries(stats)) {
    if (!row || typeof row !== 'object') continue
    const r = { name, runs: 0, na: 0, best: undefined as { e: number; tier: string } | undefined, reviews: 0, score: 0, rework: 0 }
    for (const [tier, c] of Object.entries(row)) {
      if (!c || typeof c !== 'object') continue
      r.runs += num(c.runs)
      r.na += c.notAccepted !== undefined ? num(c.notAccepted) : num(c.escalated)
      r.reviews += num(c.reviews)
      r.score += num(c.reviewScore)
      r.rework += num(c.reworked)
      let e: number | undefined
      try { e = costPerAccepted(c, i.now, halfLife) } catch { e = undefined }
      if (e !== undefined && (r.best === undefined || e < r.best.e)) r.best = { e, tier }
    }
    if (r.runs > 0) rows.push(r)
  }
  if (rows.length === 0) return [[label('No learned stats yet.')]]
  rows.sort((a, b) => b.runs - a.runs || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  const out: ViewCell[][] = [head('Category', 'Runs', 'Not acc.', ['$/accepted', '$/acc.'], 'Review', 'Rework')]
  for (const r of rows.slice(0, top)) {
    out.push([
      name(r.name), right(num1(r.runs)), right(`${Math.round((r.na / r.runs) * 100)}%`),
      r.best ? right(`${usd(r.best.e)} ${r.best.tier}`, usd(r.best.e)) : right('-'),
      right(r.reviews > 0 ? `${num1(r.score / r.reviews)} (${num1(r.reviews)})` : '-'),
      right(num1(r.rework)),
    ])
  }
  if (rows.length > top) out.push([label(`+${rows.length - top} more`)])
  return out
}

const TIERS = ['haiku', 'sonnet', 'opus']
const isAdvice = (a: unknown): a is Advice => {
  const o = a as Partial<Advice> | null
  return typeof o === 'object' && o !== null && typeof o.category === 'string' && TIERS.includes(o.tier as string) &&
    TIERS.includes(o.suggested as string) && typeof o.runs === 'number' && Number.isFinite(o.runs) &&
    (o.strength === 'strong' || o.strength === 'moderate')
}

// One row per suggestion: what changes, the evidence, and the cost of a run now and (estimated) on the cheaper model.
// The last cell is the strength of a measured suggestion and "unmeasured" otherwise (a missing quality reads as
// unmeasured), with a note under the table saying what that means; a last row keeps the general caveat.
function adviceRows(list: unknown, top: number): ViewCell[][] {
  const ok = Array.isArray(list) ? list.filter(isAdvice) : []
  if (ok.length === 0) return []
  const money = (x: number | undefined): string => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? usd(x) : '-')
  const out: ViewCell[][] = [head('Category', 'Change', 'Runs', 'Now', 'Est.', '')]
  const shown = ok.slice(0, Math.min(top, ADVICE.maxLines))
  for (const a of shown) {
    out.push([
      name(a.category), plain(`${a.tier} -> ${a.suggested}`), right(num1(a.runs)), right(money(a.costNow)), right(money(a.costCheaper)),
      { text: a.quality === 'measured' ? a.strength : 'unmeasured', dim: true },
    ])
  }
  const more = ok.length - shown.length
  if (more > 0) out.push([label(`+${more} more`)])
  if (shown.some((a) => a.quality !== 'measured')) {
    out.push([label('unmeasured: quality not measured, the mod cannot tell whether the cheaper model would do as well')])
  }
  out.push([label('From runs that did not get stuck, not a comparison with the cheaper model; costs are estimates')])
  return out
}

// The panel's content: session, plan usage (only when the engine reports plan windows), savings per category and
// the learned statistics.
export function buildStatsView(i: StatsInput): StatsView {
  const top = i.topRows !== undefined && i.topRows >= 1 ? Math.floor(i.topRows) : TOP_ROWS
  const sections: ViewSection[] = [{ id: 'session', title: 'Session', rows: sessionRows(i) }]
  const plan = planRows(i.plan)
  if (plan.length > 0) sections.push({ id: 'plan', title: 'Plan usage', rows: plan })
  sections.push({ id: 'categories', title: 'Savings by category', rows: categoryRows(i.ledger, top) })
  sections.push({ id: 'learned', title: 'Learned statistics', rows: learnedRows(i, top) })
  const advice = adviceRows(i.advice, top)
  if (advice.length > 0) sections.push({ id: 'advice', title: 'Cheaper model suggestions', rows: advice })
  return { sections }
}

const GAP = 2
const MIN_COL = 6
const NAME_MIN = 10
const HEAD_MIN = 4

// Shortens `text` to `max` characters, ending with an ellipsis when it was cut.
const clip = (text: string, max: number): string => (text.length <= max ? text : max <= 1 ? text.slice(0, Math.max(0, max)) : text.slice(0, max - 1) + '…')

// Shortens a name in its middle: the part after the last ':' is kept whole when it leaves room for a start,
// otherwise the last two thirds are kept.
function clipMiddle(text: string, max: number): string {
  if (text.length <= max) return text
  if (max <= 4) return clip(text, max)
  const colon = text.lastIndexOf(':')
  const tail = colon > 0 && text.length - colon <= max - 2 ? text.length - colon : Math.floor(((max - 1) * 2) / 3)
  return text.slice(0, max - 1 - tail) + '…' + text.slice(text.length - tail)
}

// Breaks `text` into lines of at most `max` characters at spaces; continuation lines are indented by two
// spaces. A word longer than a line is cut.
function wrapText(text: string, max: number): string[] {
  if (text.length <= max) return [text]
  const lines: string[] = []
  let line = ''
  for (const word of text.split(' ')) {
    const indent = lines.length > 0 ? '  ' : ''
    const next = line ? `${line} ${word}` : indent + word
    if (next.length <= max) { line = next; continue }
    if (line) lines.push(line)
    line = clip((lines.length > 0 ? '  ' : '') + word, max)
  }
  if (line) lines.push(line)
  return lines
}

// The width of each column of a table: the longest text in it, over the rows that have more than one cell.
// With `short`, the width when every cell that has a shorter text uses it.
export function columnWidths(rows: ViewCell[][], short = false): number[] {
  const table = rows.filter((r) => r.length > 1)
  const cols = Math.max(0, ...table.map((r) => r.length))
  const len = (c: ViewCell | undefined): number => (c === undefined ? 0 : short && c.short !== undefined ? c.short.length : c.text.length)
  return Array.from({ length: cols }, (_, c) => Math.max(0, ...table.map((r) => len(r[c]))))
}

function fitCell(c: ViewCell, width: number): ViewCell {
  const source = c.text.length > width && c.short !== undefined ? c.short : c.text
  const text = c.clip === 'middle' ? clipMiddle(source, width) : clip(source, width)
  return { ...c, text: c.align === 'right' ? text.padStart(width) : text.padEnd(width) }
}

// Pads the cells of every multi-cell row of a section to the column widths (numbers on the right) and makes
// each row fit in `width` characters (cells joined by two spaces). Columns with a shorter form use it first,
// then the widest column gives way. A single-cell row wraps onto more rows.
export function fitView(view: StatsView, width: number): StatsView {
  const w = Number.isFinite(width) && width >= 1 ? Math.floor(width) : 80
  return {
    sections: view.sections.map((s) => {
      let widths = columnWidths(s.rows)
      const cols = widths.length
      const room = w - GAP * Math.max(0, cols - 1)
      const sum = (ws: number[]): number => ws.reduce((a, b) => a + b, 0)
      if (sum(widths) > room) widths = columnWidths(s.rows, true)
      // Then names give way, down to NAME_MIN; then headers wider than their values; last the widest column,
      // one character at a time, until the table fits.
      const names = widths.map((_, k) => s.rows.some((r) => r.length > 1 && r[k]?.clip === 'middle'))
      for (let k = 0; k < cols && sum(widths) > room; k++) {
        if (names[k]) widths[k] = Math.max(Math.min(widths[k]!, NAME_MIN), widths[k]! - (sum(widths) - room))
      }
      const data = columnWidths(s.rows.filter((r) => !r.every((c) => c.bold)), true)
      while (sum(widths) > room) {
        let k = -1
        for (let c = 0; c < cols; c++) if (widths[c]! > (data[c] ?? 0) && widths[c]! > HEAD_MIN && (k < 0 || widths[c]! > widths[k]!)) k = c
        if (k < 0) break
        widths[k]!--
      }
      while (sum(widths) > room) {
        let k = 0
        for (let c = 1; c < widths.length; c++) if (widths[c]! > widths[k]!) k = c
        if (widths[k]! <= MIN_COL) break
        widths[k]!--
      }
      const rows = s.rows.flatMap((r): ViewCell[][] => {
        if (r.length === 0) return [r]
        if (r.length === 1) return wrapText(r[0]!.text, w).map((text) => [{ ...r[0]!, text }])
        const cells = r.map((c, k) => fitCell(c, widths[k] ?? MIN_COL))
        // Even at the minimum widths the row may be wider than the room: cut the last cells.
        let over = cells.reduce((n, c) => n + c.text.length, 0) + GAP * (cells.length - 1) - w
        for (let k = cells.length - 1; k >= 0 && over > 0; k--) {
          const cut = Math.min(over, cells[k]!.text.length)
          cells[k] = { ...cells[k]!, text: clip(cells[k]!.text.trim(), cells[k]!.text.length - cut) }
          over -= cut
        }
        return [cells]
      })
      return { ...s, rows }
    }),
  }
}
