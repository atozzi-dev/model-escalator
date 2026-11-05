// Pure: spots a large job the lead does alone (option delegationHint). The lead writes many files itself and never
// spawns a subagent that writes, so the ladder has nothing to start on a cheaper model. The hint only tells the user,
// once per session; it never changes the lead's prompt or what Claude does. Zero tokens: no model call.
import { normalizePath } from './detector'
import { editedPath } from './review'

// Thresholds are provisional (DELEGA-ANALISI 1.3): tune them on real traces before trusting them.
// Four files of real code, 300 new lines, in two folders (or six files alone): a job worth splitting.
export const LEAD_FILES_MIN = 4
export const LEAD_LINES_MIN = 300
export const LEAD_GROUPS_MIN = 2
export const LEAD_FILES_ALONE = 6
// About a dollar and a half of the lead's own requests is a long job even when the files are few and small.
export const LEAD_COST_MIN = 1.5
export const LEAD_COST_FILES_MIN = 3
// The window: the last turns of the lead, and only those that ended within the last half hour.
export const LEAD_WINDOW_TURNS = 3
export const LEAD_WINDOW_MS = 30 * 60_000
// Bounds: distinct files kept per turn (the count stops there, the rule is already met long before).
export const LEAD_MAX_FILES = 50

// What the lead did in one main-loop turn. `files` and `groups` are normalised paths and folders; `spawns` counts
// the subagents it started that write; `cost` is set when the turn ends. `at` is the time the turn ended.
export type LeadTurn = { at: number; files: string[]; groups: string[]; lines: number; spawns: number; cost: number }
// The window's totals: distinct files and folders, lines and cost summed, writing spawns summed.
export type LeadWork = { files: number; groups: number; lines: number; cost: number; spawns: number }

export function emptyLeadTurn(): LeadTurn {
  return { at: 0, files: [], groups: [], lines: 0, spawns: 0, cost: 0 }
}

// The folder a file belongs to: its first folder under the project root, '.' for a file at the root. A file outside
// the root (or with no root known) is grouped by its directory when absolute, by its first folder when relative.
export function fileGroup(file: string, root?: string): string {
  const p = normalizePath(file)
  const base = typeof root === 'string' && root.trim() !== '' ? normalizePath(root).replace(/\/+$/, '') : ''
  if (base !== '' && p.startsWith(base + '/')) {
    const rest = p.slice(base.length + 1).split('/')
    return rest.length > 1 ? rest[0]! : '.'
  }
  const absolute = p.startsWith('/') || /^[a-z]:\//.test(p)
  if (absolute) {
    const cut = p.lastIndexOf('/')
    return cut > 0 ? p.slice(0, cut) : '.'
  }
  const parts = p.split('/')
  return parts.length > 1 ? parts[0]! : '.'
}

// True for an Agent call (or its older name Task) that starts a subagent which may write: Explore, Plan and forks do not.
export function isWritingSpawn(tool: unknown, input: Record<string, unknown>): boolean {
  if (tool !== 'Agent' && tool !== 'Task') return false
  const type = typeof input?.subagent_type === 'string' ? input.subagent_type.trim().toLowerCase() : ''
  return type !== 'explore' && type !== 'plan' && type !== 'fork'
}

// Newlines in a piece of text written by a tool; anything else counts as none.
function newlines(text: unknown): number {
  return typeof text === 'string' ? text.split('\n').length - 1 : 0
}

// Lines a successful write call of the lead wrote, from the text it carries.
function linesWritten(tool: unknown, input: Record<string, unknown>): number {
  if (tool === 'Edit') return newlines(input.new_string)
  if (tool === 'Write') return newlines(input.content)
  if (tool === 'NotebookEdit') return newlines(input.new_source) + newlines(input.new_string)
  if (tool === 'MultiEdit') {
    const edits = Array.isArray(input.edits) ? input.edits : []
    return edits.reduce<number>((n, ed) => n + newlines((ed as { new_string?: unknown } | null)?.new_string), 0)
  }
  return 0
}

// Adds one successful call of the lead to its turn: a write adds its file, folder and lines, a writing Agent call
// adds a spawn. Anything else, or malformed input, returns the turn unchanged. The caller passes only calls that
// succeeded. Never throws.
export function noteLeadCall(turn: LeadTurn, tool: unknown, input: Record<string, unknown>, root?: string): LeadTurn {
  try {
    if (isWritingSpawn(tool, input)) return { ...turn, spawns: turn.spawns + 1 }
    const raw = editedPath(tool, input)
    if (!raw) return turn
    const file = normalizePath(raw)
    const group = fileGroup(file, root)
    const files = turn.files.includes(file) || turn.files.length >= LEAD_MAX_FILES ? turn.files : [...turn.files, file]
    const groups = turn.groups.includes(group) ? turn.groups : [...turn.groups, group]
    return { ...turn, files, groups, lines: turn.lines + linesWritten(tool, input) }
  } catch {
    return turn
  }
}

// The window after a turn ended at `now`: the turn appended, turns that ended more than LEAD_WINDOW_MS earlier dropped,
// and only the last LEAD_WINDOW_TURNS kept.
export function pushTurn(window: readonly LeadTurn[], turn: LeadTurn, now: number): LeadTurn[] {
  const kept = window.filter((t) => now - t.at <= LEAD_WINDOW_MS)
  return [...kept, { ...turn, at: now }].slice(-LEAD_WINDOW_TURNS)
}

// The totals of the window: distinct files and folders across its turns, lines, cost and spawns summed.
export function leadWork(window: readonly LeadTurn[]): LeadWork {
  const files = new Set<string>()
  const groups = new Set<string>()
  let lines = 0
  let cost = 0
  let spawns = 0
  for (const t of window) {
    for (const f of t.files) files.add(f)
    for (const g of t.groups) groups.add(g)
    lines += t.lines
    cost += t.cost
    spawns += t.spawns
  }
  return { files: files.size, groups: groups.size, lines, cost, spawns }
}

// The rule of DELEGA-ANALISI 1.3: no writing subagent in the window, and either a large multi-file job or a costly one.
export function shouldHint(w: LeadWork): boolean {
  if (w.spawns > 0) return false
  if (w.files >= LEAD_FILES_MIN && w.lines >= LEAD_LINES_MIN && (w.groups >= LEAD_GROUPS_MIN || w.files >= LEAD_FILES_ALONE)) return true
  return w.cost >= LEAD_COST_MIN && w.files >= LEAD_COST_FILES_MIN
}

// The sentence the user reads (toast and log). Plain English; it names no model and no price.
export function hintText(w: LeadWork): string {
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
  return `The lead wrote ${plural(w.files, 'file', 'files')} (${plural(w.lines, 'line', 'lines')}) across ` +
    `${plural(w.groups, 'folder', 'folders')} by itself. Asking it to split the work into subagents lets model-escalator start parts on cheaper models.`
}
