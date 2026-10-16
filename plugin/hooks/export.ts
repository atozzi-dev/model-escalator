// CSV export of costs, savings and quality, for `/escalator export`. Pure: no engine calls, never throws; malformed
// input degrades to fewer rows. The same data as `/escalator stats` and `/escalator history`, one table per kind.
//
// Call from register.ts:
//
//   exportCsv(kind: 'session' | 'learned' | 'history' | 'all', inputs: ExportInputs): string
//
//   ExportInputs = {
//     ledger?: Ledger          // this session's ledger (the module-level `ledger`)
//     stats?: Stats            // learned stats, global: `$.store.get('stats')`
//     projectStats?: Stats     // the current project's table: `parseProjects($.store.get('projects'))[projectKey(cwd)]?.stats`
//     sessions?: unknown[]     // `$.store.get('sessions')` as stored (entries `{ at, mode, baseline, ledger }`)
//     now?: number             // for the decayed cost per accepted run, default: no decay
//     halfLifeMs?: number      // default HALF_LIFE_MS
//     historyLimit?: number    // newest N sessions, default: all stored
//   }
//
// Format: RFC 4180 quoting, header row, `\n` line ends (the text is meant to be pasted, so no CRLF), `.` decimal
// separator, USD with 4 decimals, rates with 3, percentages with 1, ISO 8601 UTC dates. Text cells that start with
// `=`, `+`, `-` or `@` (except formatted negative numbers) get a leading `'` so a spreadsheet does not read them as formulas; numbers are never touched.
// Only counters, costs, model and category names are exported: never prompts, commands, outputs or project paths
// (the per-project table is the current project's, labelled `project`; its hashed key is not exported).
import { costPerAccepted, HALF_LIFE_MS, type Cell, type Stats } from './learning'
import { savings, type Ledger } from './savings'
import { LADDER } from './detector'

export type ExportKind = 'session' | 'learned' | 'history' | 'all'

export type ExportInputs = {
  ledger?: Ledger
  stats?: Stats
  projectStats?: Stats
  sessions?: unknown[]
  now?: number
  halfLifeMs?: number
  historyLimit?: number
}

type Field = string | number | undefined

// One CSV field. Quotes it when it holds a comma, quote, CR or LF; defuses formula prefixes in text.
export function csvField(v: Field): string {
  if (v === undefined) return ''
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : ''
  let s = String(v)
  if (/^[=+\-@]/.test(s) && !/^-\d+(\.\d+)?$/.test(s)) s = "'" + s   // formatted negative numbers stay numbers
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
}

export const csvRow = (fields: Field[]): string => fields.map(csvField).join(',')

const table = (header: string[], rows: Field[][]): string => [header, ...rows].map(csvRow).join('\n')

const num = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) ? x : 0)
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const usd = (x: number): string => x.toFixed(4)
const rate = (x: number): string => x.toFixed(3)
const pct1 = (x: number, base: number): string => (base > 0 ? ((x / base) * 100).toFixed(1) : '0.0')
// Counters may be fractional once decayed: up to 3 decimals, no trailing zeros.
const count = (x: number): string => String(Math.round(x * 1000) / 1000)
const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

// --- This session ---

const SESSION_HEADER = ['category', 'agents', 'escalations', 'requests', 'cost_usd', 'baseline_cost_low_usd', 'baseline_cost_high_usd',
  'savings_low_usd', 'savings_high_usd', 'savings_low_pct', 'savings_high_pct']

function costCells(actual: number, low: number, high: number): string[] {
  return [usd(actual), usd(low), usd(high), usd(low - actual), usd(high - actual), pct1(low - actual, low), pct1(high - actual, high)]
}

// One row per task category, highest real cost first, then a `(total)` row from the ledger (it includes the lead's own
// requests and the consults, which no category owns). The baseline columns are the same tokens on the baseline model
// (high) and the prudent estimate with fewer tokens (low), as in the report.
export function sessionCsv(ledger: Ledger | undefined): string {
  const l = isObj(ledger) ? (ledger as Ledger) : undefined
  const map = l && isObj(l.byCategory) ? l.byCategory : {}
  const rows = Object.entries(map).filter(([, r]) => isObj(r)).map(([name, r]) => ({
    name, agents: num(r.agents), esc: num(r.escalated), steps: num(r.steps), actual: num(r.actual), high: num(r.baselineHigh), low: num(r.baselineLow),
  })).sort((a, b) => b.actual - a.actual || byName(a.name, b.name))
  const out: Field[][] = rows.map((r) => [r.name, r.agents, r.esc, r.steps, ...costCells(r.actual, r.low, r.high)])
  const sum = (k: 'agents' | 'esc') => rows.reduce((a, r) => a + r[k], 0)
  out.push(['(total)', sum('agents'), sum('esc'), num(l?.agentSteps), ...costCells(num(l?.actual), num(l?.baselineLow), num(l?.baselineHigh))])
  return table(SESSION_HEADER, out)
}

// --- Learned statistics ---

const LEARNED_HEADER = ['scope', 'category', 'model', 'runs', 'escalated', 'escalation_rate', 'not_accepted_rate', 'failed_verify', 'reworked',
  'cost_per_run_usd', 'cost_per_accepted_usd', 'reviews', 'review_mean']

const tierOrder = (t: string): number => { const i = LADDER.indexOf(t as never); return i < 0 ? LADDER.length : i }

function learnedRows(scope: string, stats: unknown, now: number | undefined, halfLifeMs: number): Field[][] {
  const out: Field[][] = []
  if (!isObj(stats)) return out
  for (const category of Object.keys(stats).sort(byName)) {
    const row = stats[category]
    if (!isObj(row)) continue
    for (const tier of Object.keys(row).sort((a, b) => tierOrder(a) - tierOrder(b) || byName(a, b))) {
      const c = row[tier]
      if (!isObj(c)) continue
      const cell = c as Cell
      const runs = num(cell.runs)
      const esc = num(cell.escalated)
      const na = cell.notAccepted !== undefined ? num(cell.notAccepted) : esc
      const priced = typeof cell.cost === 'number' && typeof cell.costRuns === 'number' && cell.costRuns > 0
      let accepted: number | undefined
      try { accepted = priced ? costPerAccepted(cell, now, halfLifeMs) : undefined } catch { accepted = undefined }
      const reviews = num(cell.reviews)
      out.push([
        scope, category, tier, count(runs), count(esc), rate(runs > 0 ? esc / runs : 0), rate(runs > 0 ? na / runs : 0),
        count(num(cell.failedVerify)), count(num(cell.reworked)),
        priced ? usd((cell.cost as number) / (cell.costRuns as number)) : undefined,
        accepted !== undefined && Number.isFinite(accepted) ? usd(accepted) : undefined,
        count(reviews), reviews > 0 ? rate(num(cell.reviewScore) / reviews) : undefined,
      ])
    }
  }
  return out
}

// One row per category and model for the global table (`global`), then for the current project (`project`, only when
// given). Counters are as stored (decayed by age); rates are per recorded run; `review_mean` is the average sampled
// review score out of 5, empty without reviews; the two cost columns are empty without priced runs.
export function learnedCsv(i: Pick<ExportInputs, 'stats' | 'projectStats' | 'now' | 'halfLifeMs'>): string {
  const hl = i.halfLifeMs ?? HALF_LIFE_MS
  return table(LEARNED_HEADER, [...learnedRows('global', i.stats, i.now, hl), ...learnedRows('project', i.projectStats, i.now, hl)])
}

// --- Session history ---

const HISTORY_HEADER = ['date', 'mode', 'baseline', 'agent_requests', 'agents', 'escalations', 'interventions', 'consults', 'consult_cost_usd',
  'cost_usd', 'savings_low_usd', 'savings_high_usd', 'savings_low_pct', 'savings_high_pct']

// One row per recorded session, oldest first. Entries that are not `{ at, ledger }` with a numeric cost are skipped.
// `agents` and `escalations` come from the per-category counters and are empty for sessions saved before those existed.
export function historyCsv(sessions: unknown, limit?: number): string {
  const rows: Field[][] = []
  for (const s of Array.isArray(sessions) ? sessions : []) {
    if (!isObj(s) || typeof s['at'] !== 'number' || !Number.isFinite(s['at']) || !isObj(s['ledger']) || typeof s['ledger']['actual'] !== 'number') continue
    const l = s['ledger'] as unknown as Ledger
    let date: string
    try { date = new Date(s['at']).toISOString() } catch { continue }
    const sv = savings({ ...l, actual: num(l.actual), baselineHigh: num(l.baselineHigh), baselineLow: num(l.baselineLow) })
    const cats = isObj(l.byCategory) ? Object.values(l.byCategory).filter(isObj) : []
    const iv = Object.values(isObj(l.interventions) ? l.interventions : {}).reduce<number>((a, b) => a + num(b), 0)
    rows.push([
      date, typeof s['mode'] === 'string' ? s['mode'] : undefined, typeof s['baseline'] === 'string' ? s['baseline'] : undefined,
      num(l.agentSteps),
      cats.length > 0 ? cats.reduce((a, r) => a + num(r['agents']), 0) : undefined,
      cats.length > 0 ? cats.reduce((a, r) => a + num(r['escalated']), 0) : undefined,
      iv, num(l.consults), usd(num(l.consultCost)), usd(num(l.actual)), usd(sv.low), usd(sv.high),
      pct1(sv.low, num(l.baselineLow)), pct1(sv.high, num(l.baselineHigh)),
    ])
  }
  rows.sort((a, b) => byName(String(a[0]), String(b[0])))
  const keep = limit !== undefined && Number.isInteger(limit) && limit >= 1 ? rows.slice(-limit) : rows
  return table(HISTORY_HEADER, keep)
}

// --- Dispatcher ---

// `session`, `learned` or `history`: the bare table. `all`: the three tables, each after a `# <kind>` comment line,
// separated by one blank line (a spreadsheet pastes the first block cleanly and the comments mark where each starts).
export function exportCsv(kind: ExportKind, i: ExportInputs): string {
  const part = (k: Exclude<ExportKind, 'all'>): string =>
    k === 'session' ? sessionCsv(i.ledger) : k === 'learned' ? learnedCsv(i) : historyCsv(i.sessions, i.historyLimit)
  if (kind !== 'all') return part(kind)
  return (['session', 'learned', 'history'] as const).map((k) => `# ${k}\n${part(k)}`).join('\n\n')
}
