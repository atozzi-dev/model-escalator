import { LADDER, type Tier } from './detector'

export type Cell = { runs: number; escalated: number; tokens: number }
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

export function record(stats: Stats, category: string, tier: Tier, escalated: boolean, tokens: number): Stats {
  const row = { ...(stats[category] ?? {}) }
  const c = row[tier] ?? { runs: 0, escalated: 0, tokens: 0 }
  row[tier] = { runs: c.runs + 1, escalated: c.escalated + (escalated ? 1 : 0), tokens: c.tokens + tokens }
  return { ...stats, [category]: row }
}

export const LEARN = { minRuns: 5, maxEscalationRate: 0.4 }

// Climbs the ladder while the evidence says the tier fails this category too often.
export function recommend(stats: Stats, category: string, requested: Tier): Tier {
  let t = requested
  for (;;) {
    const c = stats[category]?.[t]
    const bad = c !== undefined && c.runs >= LEARN.minRuns && c.escalated / c.runs > LEARN.maxEscalationRate
    const i = LADDER.indexOf(t)
    if (!bad || i === LADDER.length - 1) return t
    t = LADDER[i + 1]!
  }
}
