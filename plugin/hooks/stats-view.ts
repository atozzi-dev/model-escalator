// The statistics panel as data: sections of rows of cells, no engine calls. `register.ts` maps it to Box and Text
// elements per surface. Pure and total: malformed input degrades to fewer or empty rows, never throws.
import { costPerAccepted, HALF_LIFE_MS, type Stats } from './learning'
import { savings, type Ledger } from './savings'

export type ViewCell = { text: string; bold?: boolean; dim?: boolean }
export type ViewSection = { id: 'session' | 'plan' | 'categories' | 'learned'; title: string; rows: ViewCell[][] }
export type StatsView = { sections: ViewSection[] }

export type StatsInput = {
  mode: string
  baseline: string
  ledger: Ledger
  paused: string[]            // one label per paused agent
  plan: string                // the report's "Plan usage" block, '' when there is none
  stats: Stats                // learned statistics (global)
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
const head = (...texts: string[]): ViewCell[] => texts.map((text) => ({ text, bold: true }))

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
  const out: ViewCell[][] = [head('Category', 'Cost', 'Saved', 'Esc')]
  for (const r of rows.slice(0, top)) {
    out.push([plain(r.name), plain(usd(r.actual)), plain(`${pct(r.low - r.actual, r.low)}% to ${pct(r.high - r.actual, r.high)}%`), plain(`${r.esc}/${r.agents}`)])
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
  const out: ViewCell[][] = [head('Category', 'Runs', 'Not acc.', '$/accepted', 'Review', 'Rework')]
  for (const r of rows.slice(0, top)) {
    out.push([
      plain(r.name), plain(num1(r.runs)), plain(`${Math.round((r.na / r.runs) * 100)}%`),
      plain(r.best ? `${usd(r.best.e)} ${r.best.tier}` : '-'),
      plain(r.reviews > 0 ? `${num1(r.score / r.reviews)} (${num1(r.reviews)})` : '-'),
      plain(num1(r.rework)),
    ])
  }
  if (rows.length > top) out.push([label(`+${rows.length - top} more`)])
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
  return { sections }
}

const GAP = 2
const MIN_COL = 6

// Shortens `text` to `max` characters, ending with an ellipsis when it was cut.
const clip = (text: string, max: number): string => (text.length <= max ? text : max <= 1 ? text.slice(0, Math.max(0, max)) : text.slice(0, max - 1) + '…')

// The width of each column of a table: the longest text in it, over the rows that have more than one cell.
export function columnWidths(rows: ViewCell[][]): number[] {
  const table = rows.filter((r) => r.length > 1)
  const cols = Math.max(0, ...table.map((r) => r.length))
  return Array.from({ length: cols }, (_, c) => Math.max(0, ...table.map((r) => r[c]?.text.length ?? 0)))
}

// Pads the cells of every multi-cell row of a section to the column widths and makes each row fit in `width`
// characters (cells joined by two spaces). The widest column gives way first; single-cell rows are only clipped.
export function fitView(view: StatsView, width: number): StatsView {
  const w = Number.isFinite(width) && width >= 1 ? Math.floor(width) : 80
  return {
    sections: view.sections.map((s) => {
      const widths = columnWidths(s.rows)
      const cols = widths.length
      const room = w - GAP * Math.max(0, cols - 1)
      // Shrink the widest column, one character at a time, until the table fits.
      while (widths.reduce((a, b) => a + b, 0) > room) {
        let k = 0
        for (let c = 1; c < widths.length; c++) if (widths[c]! > widths[k]!) k = c
        if (widths[k]! <= MIN_COL) break
        widths[k]!--
      }
      const rows = s.rows.map((r): ViewCell[] => {
        if (r.length <= 1) return r.map((c) => ({ ...c, text: clip(c.text, w) }))
        const cells = r.map((c, k) => ({ ...c, text: clip(c.text, widths[k] ?? MIN_COL).padEnd(widths[k] ?? 0) }))
        // Even at the minimum widths the row may be wider than the room: cut the last cells.
        let over = cells.reduce((n, c) => n + c.text.length, 0) + GAP * (cells.length - 1) - w
        for (let k = cells.length - 1; k >= 0 && over > 0; k--) {
          const cut = Math.min(over, cells[k]!.text.length)
          cells[k] = { ...cells[k]!, text: clip(cells[k]!.text.trimEnd(), cells[k]!.text.length - cut) }
          over -= cut
        }
        return cells
      })
      return { ...s, rows }
    }),
  }
}
