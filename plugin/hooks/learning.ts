import { LADDER, type Tier } from './detector'

// `notAccepted` counts runs that were escalated or failed the verification gate (a run that did both counts once).
// `updatedAt` (ms) is set only when a run is recorded with a clock; counters may be fractional once decayed.
// `failedVerify` and `notAccepted` are absent in stats stored before the gate existed: `notAccepted` then reads as `escalated`.
export type Cell = { runs: number; escalated: number; tokens: number; failedVerify?: number; notAccepted?: number; updatedAt?: number }
export type Stats = Record<string, Partial<Record<Tier, Cell>>>

const KEYWORDS: [RegExp, string][] = [
  [/\btest|spec\b/i, 'tests'],
  [/\bfix|bug|debug|error\b/i, 'bugfix'],
  [/\brefactor|rename|cleanup\b/i, 'refactor'],
  [/\bdoc|readme|comment\b/i, 'docs'],
  [/\bmigrat|schema|database|sql\b/i, 'data'],
  [/\bui|css|component|layout\b/i, 'ui'],
  [/\bsearch|find|explore|research|read\b/i, 'explore'],
]

export function categorize(subagentType: string, description: string): string {
  const hit = KEYWORDS.find(([re]) => re.test(description))
  return `${subagentType}:${hit ? hit[1] : 'other'}`
}

// Old runs fade: every counter of a cell halves after this much time without a new run.
export const HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000

// Counters of `c` as seen at `now`. Cells without `updatedAt` (stored before decay existed) or calls without `now`
// are read as they are; a clock that went backwards never inflates counters. Never mutates `c`.
function decayed(c: Cell, now: number | undefined, halfLifeMs: number): Cell {
  if (now === undefined || c.updatedAt === undefined || now <= c.updatedAt || !(halfLifeMs > 0)) return c
  const f = 0.5 ** ((now - c.updatedAt) / halfLifeMs)
  return {
    ...c,
    runs: c.runs * f,
    escalated: c.escalated * f,
    tokens: c.tokens * f,
    ...(c.failedVerify !== undefined ? { failedVerify: c.failedVerify * f } : {}),
    ...(c.notAccepted !== undefined ? { notAccepted: c.notAccepted * f } : {}),
  }
}

export function record(
  stats: Stats,
  category: string,
  tier: Tier,
  escalated: boolean,
  tokens: number,
  verifyFailed = false,
  now?: number,
  halfLifeMs = HALF_LIFE_MS,
): Stats {
  const row = { ...(stats[category] ?? {}) }
  const c = decayed(row[tier] ?? { runs: 0, escalated: 0, tokens: 0 }, now, halfLifeMs)
  row[tier] = {
    runs: c.runs + 1,
    escalated: c.escalated + (escalated ? 1 : 0),
    tokens: c.tokens + tokens,
    failedVerify: (c.failedVerify ?? 0) + (verifyFailed ? 1 : 0),
    notAccepted: (c.notAccepted ?? c.escalated) + (escalated || verifyFailed ? 1 : 0),
    ...(now !== undefined ? { updatedAt: now } : c.updatedAt !== undefined ? { updatedAt: c.updatedAt } : {}),
  }
  return { ...stats, [category]: row }
}

export const LEARN = { minRuns: 5, maxEscalationRate: 0.4 }

// Climbs the ladder while the evidence says the tier fails this category too often.
// With `now`, old evidence is decayed first: the rate is unchanged (all counters fade together) but a category left
// alone long enough drops below `minRuns` and falls back to the requested tier.
export function recommend(stats: Stats, category: string, requested: Tier, now?: number, halfLifeMs = HALF_LIFE_MS): Tier {
  let t = requested
  for (;;) {
    const raw = stats[category]?.[t]
    const c = raw === undefined ? undefined : decayed(raw, now, halfLifeMs)
    const bad = c !== undefined && c.runs >= LEARN.minRuns && (c.notAccepted ?? c.escalated) / c.runs > LEARN.maxEscalationRate
    const i = LADDER.indexOf(t)
    if (!bad || i === LADDER.length - 1) return t
    t = LADDER[i + 1]!
  }
}

const num1 = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(1))

function ageText(ms: number): string {
  if (ms < 60_000) return 'just now'
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} min ago`
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)} h ago`
  return `${Math.floor(ms / 86_400_000)} d ago`
}

// One line per category and tier; counters may be fractional once decayed. With `now`, shows how old each cell is.
export function formatStats(stats: Stats, now?: number): string {
  const lines: string[] = []
  for (const [category, row] of Object.entries(stats)) {
    for (const [tier, c] of Object.entries(row)) {
      if (!c) continue
      const failed = c.failedVerify ? `, ${num1(c.failedVerify)} failed verify` : ''
      const na = c.notAccepted !== undefined && c.notAccepted !== c.escalated ? `, ${num1(c.notAccepted)} not accepted` : ''
      const age = now !== undefined && c.updatedAt !== undefined ? ` (updated ${ageText(Math.max(0, now - c.updatedAt))})` : ''
      lines.push(`- ${category} ${tier}: ${num1(c.runs)} runs, ${num1(c.escalated)} escalated${failed}${na}${age}`)
    }
  }
  return lines.length === 0 ? 'No stats yet.' : lines.join('\n')
}
