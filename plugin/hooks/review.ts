// Pure: sampled senior review of the runs finished by cheap models. Which runs are sampled, the git command
// that reads the agent's diff, the rubric and the prompt sent to the review model, the parser of its verdict,
// and the formatting of the review counters kept in the learned stats. Nothing here calls the host. Never throws.
import { tierRank, type Tier } from './detector'
import { redactSecrets, truncateMiddle } from './dossier'
import type { Cell, Stats } from './learning'

export const REVIEW_SYSTEM =
  'You review the change a coding agent made for the task below. Judge the diff against the task on this rubric: ' +
  '(1) correctness: it does what the task asks and adds no bug; ' +
  '(2) minimality: no unrelated or unnecessary changes; ' +
  '(3) tests: no test weakened, skipped or deleted to make things pass; ' +
  '(4) style: consistent with the surrounding code. ' +
  'Score from 1 to 5: 5 ready to merge, 4 minor nits, 3 works but needs changes, 2 serious problems, 1 wrong or harmful. ' +
  'Reply with the line "SCORE: n" first, then at most 3 short reasons, one per line. Nothing else.'

export const REVIEW_LIMITS = {
  maxTaskChars: 2000,
  maxDiffChars: 12_000,
  maxPaths: 50,          // more edited files than this: the whole working tree diff is reviewed instead
  maxTracked: 200,       // edited paths remembered per agent run
  maxReasonChars: 200,
  maxReasons: 3,
}

// FNV-1a, 32 bits: a stable hash, so a seed and a key always give the same draw.
function fnv1a(text: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

// Whether the run `key` (agent id and turn id) is reviewed, at `rate` (0 to 1), for the session `seed`.
// Deterministic: the same seed and key always give the same answer, and over many keys about `rate` of them pass.
export function sampleRun(rate: number, seed: string, key: string): boolean {
  if (!(rate > 0)) return false
  if (rate >= 1) return true
  return fnv1a(`${seed}\u0000${key}`) / 0x1_0000_0000 < rate
}

// A run is cheap when its start tier is below the reference (the lead's model or the pinned baseline).
export const isCheaper = (start: Tier, baseline: Tier): boolean => tierRank(start) < tierRank(baseline)

// The file an edit tool call changed, as the agent named it; undefined for any other tool.
export function editedPath(tool: unknown, input: Record<string, unknown>): string | undefined {
  const field = tool === 'Edit' || tool === 'Write' || tool === 'MultiEdit' ? 'file_path' : tool === 'NotebookEdit' ? 'notebook_path' : undefined
  if (!field) return undefined
  const v = input?.[field]
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined
}

// Read-only diff of the working tree and index against HEAD, with the stat on top. External diff drivers and
// text conversion filters are off, so the repository's own config cannot make git run other programs for it.
// The paths come after `--`, so none of them can be read as an option.
export function diffArgv(paths: readonly string[]): string[] {
  const base = ['git', '--no-pager', 'diff', '--no-color', '--no-ext-diff', '--no-textconv', '--patch-with-stat', 'HEAD']
  return paths.length > 0 ? [...base, '--', ...paths] : base
}

export type ReviewInput = { task: string; diff: string; scoped: boolean }

// The facts for the review model: the task and the diff, both capped and with obvious secrets redacted.
export function buildReviewPrompt(input: ReviewInput, limits: Partial<typeof REVIEW_LIMITS> = {}): string {
  try {
    const lim = { ...REVIEW_LIMITS, ...limits }
    const task = redactSecrets(truncateMiddle(String(input?.task ?? '').trim(), lim.maxTaskChars)) || '(not given)'
    const diff = redactSecrets(truncateMiddle(String(input?.diff ?? '').trim(), lim.maxDiffChars))
    const scope = input?.scoped
      ? 'git diff against HEAD, limited to the files the agent edited'
      : 'git diff of the whole working tree against HEAD: it may contain other changes made in the same folder, judge only what serves the task'
    return `## Task\n${task}\n\n## Diff (${scope})\n${diff}`
  } catch {
    return '## Task\n(not given)'
  }
}

export type Review = { score: number; reasons: string[] }

const SCORE_LINE = /\bscore\b\**\s*[:=]\s*\**\s*(\d+(?:\.\d+)?)/i

// Reads "SCORE: n" (1 to 5, rounded) and up to three reasons from the other lines. Undefined when there is no
// valid score: an empty or refused reply, or a verdict out of range.
export function parseReview(text: string): Review | undefined {
  try {
    const t = typeof text === 'string' ? text : ''
    const m = SCORE_LINE.exec(t)
    if (!m) return undefined
    const n = Math.round(Number(m[1]))
    if (!(n >= 1 && n <= 5)) return undefined
    const reasons = t.split('\n')
      .filter((l) => !SCORE_LINE.test(l))
      .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').replace(/\*\*/g, '').trim())
      .filter((l) => l !== '')
      .slice(0, REVIEW_LIMITS.maxReasons)
      .map((l) => l.slice(0, REVIEW_LIMITS.maxReasonChars))
    return { score: n, reasons }
  } catch {
    return undefined
  }
}

const num1 = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(1))

// One line per category and tier with reviews: the average score and how many reviews it comes from. '' when none.
export function formatReviews(stats: Stats): string {
  const lines: string[] = []
  for (const [category, row] of Object.entries(stats ?? {})) {
    for (const [tier, cell] of Object.entries(row ?? {})) {
      const c = cell as Cell | undefined
      if (!c || !(typeof c.reviews === 'number' && c.reviews > 0) || typeof c.reviewScore !== 'number') continue
      const n = Math.round(c.reviews * 10) / 10
      lines.push(`- ${category} ${tier}: average ${(c.reviewScore / c.reviews).toFixed(1)}/5 over ${num1(n)} review${n === 1 ? '' : 's'}`)
    }
  }
  return lines.join('\n')
}
