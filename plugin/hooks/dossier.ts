// Pure builder for the dossier handed to a senior model: what the agent was asked to do, what it
// tried, the real error text of the failures and the files it touched. No instructions live here
// (the system prompt stays with the caller): the text only reports facts. Never throws.
import { SOFT_FAILURE_MARK, type AgentState } from './detector'

export type DossierAttempt = {
  tool: string
  summary: string
  ok: boolean
  soft?: boolean            // ok, but its output reports a failure (a command that exited 0 anyway)
  error?: string            // full error/output text for failures and soft failures
}

export type DossierInput = {
  goal: string
  tier: string
  interventions: number
  attempts: DossierAttempt[]                       // oldest first
  files: { path: string; edits: number }[]
  diffStat?: string                                // `git diff --stat` output
  extra?: string                                   // the agent's own problem / what it tried
}

export type DossierLimits = {
  maxChars: number          // hard cap on the whole dossier
  maxAttempts: number       // last N attempts shown
  maxErrorChars: number     // cap per error text (head + tail kept)
  maxGoalChars: number
  maxExtraChars: number
  maxDiffChars: number
  maxFiles: number
}

export const DEFAULT_DOSSIER_LIMITS: DossierLimits = {
  maxChars: 12000, maxAttempts: 12, maxErrorChars: 1500,
  maxGoalChars: 2000, maxExtraChars: 1500, maxDiffChars: 1500, maxFiles: 20,
}

const REDACTED = '[redacted]'

// Secret patterns, applied in this order. Each keeps the surrounding text so the error stays readable.
//  1. PEM blocks: "-----BEGIN ... KEY-----" up to "-----END ... KEY-----" (or to the end of the text if cut).
//  2. "Authorization: <scheme> <value>" headers (the label stays, the value goes).
//  3. name=value / name: value where the name ends with password, passwd, pwd, secret, token, api key,
//     access key or private key (optional plural, so `TokenError:` and "password is required" are left
//     alone). The value is a quoted string or a run of 4+ non-space characters.
//  4. Well-known prefixed keys: sk-..., ghp_/gho_/ghs_/github_pat_..., xox[abp]-..., AKIA..., AIza...
//  5. Hex runs of 64+ characters (a 40-character git sha is kept).
//  6. Runs of 32+ base64/url-safe characters that mix lower case, upper case and digits.
const PEM = /-----BEGIN [A-Z0-9 ]*KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*KEY-----|$)/g
const AUTH = /(\bauthorization["']?\s*[:=]\s*)(?:(?:bearer|basic|token|digest)\s+)?[^\s"',;]+/gi
const NAMED = /(\b[\w.-]*(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)s?["']?\s*[:=]\s*)("[^"\n]*"|'[^'\n]*'|[^\s"',;]{4,})/gi
const PREFIXED = /\b(?:sk-|ghp_|gho_|ghs_|github_pat_|xox[abp]-|AKIA|AIza)[A-Za-z0-9_-]{16,}/g
const LONG_HEX = /\b[0-9a-fA-F]{64,}\b/g
const LONG_B64 = /[A-Za-z0-9+/_=-]{32,}/g

export function redactSecrets(text: string): string {
  try {
    return String(text ?? '')
      .replace(PEM, REDACTED)
      .replace(AUTH, `$1${REDACTED}`)
      .replace(NAMED, `$1${REDACTED}`)
      .replace(PREFIXED, REDACTED)
      .replace(LONG_HEX, REDACTED)
      .replace(LONG_B64, (m) => /[a-z]/.test(m) && /[A-Z]/.test(m) && /\d/.test(m) ? REDACTED : m)
  } catch {
    return REDACTED
  }
}

// Keeps the first and last lines of a long text and marks the cut. A single huge line is cut by characters.
export function truncateMiddle(text: string, max: number): string {
  const t = String(text ?? '')
  if (t.length <= max) return t
  const lines = t.split('\n')
  if (lines.length > 2) {
    const headBudget = Math.floor(max * 0.4)
    const tailBudget = Math.floor(max * 0.4)
    let head = 0, hl = 0
    while (head < lines.length && hl + lines[head]!.length + 1 <= headBudget) hl += lines[head++]!.length + 1
    let tail = 0, tl = 0
    while (tail < lines.length - head && tl + lines[lines.length - 1 - tail]!.length + 1 <= tailBudget) tl += lines[lines.length - 1 - tail++]!.length + 1
    if (head + tail >= 1 && head + tail < lines.length) {
      const cut = lines.length - head - tail
      return [...lines.slice(0, head), `[... ${cut} lines cut ...]`, ...lines.slice(lines.length - tail)].join('\n')
    }
  }
  const keep = Math.max(1, Math.floor(max * 0.4))
  return `${t.slice(0, keep)}\n[... ${t.length - 2 * keep} chars cut ...]\n${t.slice(t.length - keep)}`
}

// Signature for "same error": numbers and spacing folded away.
const sig = (e: string) => e.replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().slice(0, 300)

type Group = { a: DossierAttempt; count: number }

// A failure, or a soft one: its text is worth showing.
const failing = (a: DossierAttempt): boolean => !a.ok || a.soft === true

function group(attempts: DossierAttempt[]): Group[] {
  const out: Group[] = []
  for (const a of attempts) {
    const last = out[out.length - 1]
    if (last && failing(a) && failing(last.a) && last.a.ok === a.ok && last.a.tool === a.tool && sig(last.a.error ?? '') === sig(a.error ?? '') && (a.error ?? '') !== '') last.count++
    else out.push({ a, count: 1 })
  }
  return out
}

const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v))
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`

function render(input: DossierInput, lim: DossierLimits): string {
  const parts: string[] = []
  parts.push(`## Task\n${redactSecrets(truncateMiddle(str(input.goal), lim.maxGoalChars))}`)
  parts.push(`## State\nModel tier: ${str(input.tier)}. Interventions so far: ${Number(input.interventions) || 0}.`)

  const attempts = Array.isArray(input.attempts) ? input.attempts.slice(-lim.maxAttempts) : []
  if (attempts.length > 0) {
    const lines: string[] = []
    for (const { a, count } of group(attempts)) {
      const soft = a.ok && a.soft === true
      const verdict = soft ? 'ok, but the output reports a failure' : a.ok ? 'ok' : 'FAILED'
      const head = `- ${str(a.tool)}: ${redactSecrets(str(a.summary).slice(0, 200))} -> ${verdict}${count > 1 ? ` (same ${soft ? 'output' : 'error'} ×${count})` : ''}`
      lines.push(head)
      const err = str(a.error)
      if (failing(a) && err.trim()) {
        const body = redactSecrets(truncateMiddle(err.trim(), lim.maxErrorChars))
        lines.push(body.split('\n').map((l) => '    ' + l).join('\n'))
      }
    }
    parts.push(`## Recent attempts (oldest first)\n${lines.join('\n')}`)
  }

  const files = (Array.isArray(input.files) ? input.files : []).filter((f) => f && str(f.path)).sort((x, y) => (y.edits || 0) - (x.edits || 0))
  if (files.length > 0) {
    const shown = files.slice(0, lim.maxFiles).map((f) => `- ${str(f.path)} (${plural(Number(f.edits) || 0, 'edit')})`)
    if (files.length > lim.maxFiles) shown.push(`- ... and ${files.length - lim.maxFiles} more`)
    parts.push(`## Files touched\n${shown.join('\n')}`)
  }

  const diff = str(input.diffStat).trim()
  if (diff) parts.push(`## Diff stat\n${redactSecrets(truncateMiddle(diff, lim.maxDiffChars))}`)

  const extra = str(input.extra).trim()
  if (extra) parts.push(`## Agent notes\n${redactSecrets(truncateMiddle(extra, lim.maxExtraChars))}`)

  return parts.join('\n\n')
}

export function buildDossier(input: DossierInput, limits: Partial<DossierLimits> = {}): string {
  try {
    const lim = { ...DEFAULT_DOSSIER_LIMITS, ...limits }
    const safe: DossierInput = input && typeof input === 'object' ? input : ({} as DossierInput)
    // Shrink the per-section caps until the whole fits; the hard slice is only the last resort.
    let out = render(safe, lim)
    for (let i = 0; i < 6 && out.length > lim.maxChars; i++) {
      lim.maxErrorChars = Math.max(80, Math.floor(lim.maxErrorChars / 2))
      lim.maxDiffChars = Math.max(80, Math.floor(lim.maxDiffChars / 2))
      lim.maxExtraChars = Math.max(80, Math.floor(lim.maxExtraChars / 2))
      lim.maxGoalChars = Math.max(200, Math.floor(lim.maxGoalChars / 2))
      lim.maxAttempts = Math.max(3, Math.floor(lim.maxAttempts * 0.75))
      out = render(safe, lim)
    }
    if (out.length > lim.maxChars) {
      const mark = '\n[... dossier cut ...]\n'
      const keep = Math.max(0, lim.maxChars - mark.length)
      const headLen = Math.floor(keep * 0.6)
      out = out.slice(0, headLen) + mark + out.slice(out.length - (keep - headLen))
      out = out.slice(0, lim.maxChars)
    }
    return out
  } catch {
    return '## Task\n(dossier unavailable)'
  }
}

// "tool: summary -> ok" / "tool: summary -> ok (the output reports a failure)" / "tool: summary -> ERR <normalised
// error>", as written by observe().
const LOG_LINE = /^([^:]*): ([\s\S]*?) -> (ok|ERR)(?: ([\s\S]*))?$/

// Builds the input from today's AgentState. `recentErrors` is an optional bounded ring of full error
// texts, oldest first, one per failed attempt or soft failure: it is matched to those log entries from the end.
// Without it, a failed attempt shows the normalised error stored in the log line; a soft failure shows no text.
export function inputFromState(
  s: AgentState & { recentErrors?: string[] },
  opts: { diffStat?: string; extra?: string } = {},
): DossierInput {
  try {
    const errors = Array.isArray(s.recentErrors) ? s.recentErrors : []
    const parsed = s.log.map((line) => {
      const m = LOG_LINE.exec(line)
      if (!m) return { tool: '', summary: line, ok: true, soft: false, error: undefined as string | undefined }
      const soft = m[3] === 'ok' && m[4] === SOFT_FAILURE_MARK
      return { tool: m[1]!, summary: m[2]!, ok: m[3] === 'ok', soft, error: soft ? undefined : m[4] }
    })
    const failedIdx = parsed.map((p, i) => (p.ok && !p.soft ? -1 : i)).filter((i) => i >= 0)
    failedIdx.reverse().forEach((logIdx, k) => {
      const full = errors[errors.length - 1 - k]
      if (full) parsed[logIdx]!.error = full
    })
    const attempts: DossierAttempt[] = parsed.map((p) => (
      p.soft ? { tool: p.tool, summary: p.summary, ok: true, soft: true, ...(p.error ? { error: p.error } : {}) }
        : p.ok ? { tool: p.tool, summary: p.summary, ok: true }
          : { tool: p.tool, summary: p.summary, ok: false, ...(p.error ? { error: p.error } : {}) }))
    const files = Object.entries(s.editCounts ?? {}).map(([path, edits]) => ({ path, edits }))
    return { goal: s.task, tier: s.tier, interventions: s.level, attempts, files, ...(opts.diffStat ? { diffStat: opts.diffStat } : {}), ...(opts.extra ? { extra: opts.extra } : {}) }
  } catch {
    return { goal: '', tier: '', interventions: 0, attempts: [], files: [] }
  }
}
