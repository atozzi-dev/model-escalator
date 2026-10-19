// Pure helpers for model-based task categories: the label set, the text handed to the classifier, a bounded
// JSON-safe LRU cache and the merge with the keyword category. No calls to `$`; nothing here throws.
import { redactSecrets } from './dossier'

// The keyword categories of `categorize` (learning.ts) use the same labels, so keyword and model categories stay
// comparable: the original seven, plus new code ('feature') and review work ('review').
export const LABELS: readonly string[] = ['tests', 'bugfix', 'refactor', 'docs', 'data', 'ui', 'explore', 'feature', 'review', 'other']

export const LABEL_DESCRIPTIONS: Readonly<Record<string, string>> = {
  tests: 'write, run or repair automated tests',
  bugfix: 'find and fix a defect, an error or a failure',
  refactor: 'restructure, rename or clean up code without changing behaviour',
  docs: 'write or update documentation, comments or a README',
  data: 'databases, schemas, migrations, SQL or data files',
  ui: 'user interface, styling, layout or front-end components',
  explore: 'read, search or research and report back, without changing code',
  feature: 'implement new behaviour or a new piece of code',
  review: 'review, audit or check existing work and report findings',
  other: 'anything that fits none of the above',
}

export const MAX_INPUT_CHARS = 600
const MAX_DESCRIPTION_CHARS = 160
const KEY_PROMPT_WORDS = 12
const KEY_DESCRIPTION_CHARS = 120

const CODE_BLOCK = /```[\s\S]*?(?:```|$)/g

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

// Prose only: code blocks removed (an unterminated one runs to the end), whitespace collapsed.
function prose(text: unknown): string {
  try {
    return str(text).replace(CODE_BLOCK, ' ').replace(/\s+/g, ' ').trim()
  } catch {
    return ''
  }
}

// The short, redacted, neutral text the classifier sees. Never longer than MAX_INPUT_CHARS.
export function classifierInput(subagentType: string, description: string, prompt: string): string {
  try {
    const head = `Agent type: ${redactSecrets(prose(subagentType)).slice(0, 60)}\nTask: ${redactSecrets(prose(description)).slice(0, MAX_DESCRIPTION_CHARS)}\nBrief: `
    const room = Math.max(0, MAX_INPUT_CHARS - head.length)
    return (head + redactSecrets(prose(prompt)).slice(0, room)).slice(0, MAX_INPUT_CHARS)
  } catch {
    return ''
  }
}

// The first words of a brief as the keyword categories read them: prose only, redacted, at most PROMPT_HEAD_CHARS.
export const PROMPT_HEAD_CHARS = 400
export function promptHead(prompt: unknown): string {
  try {
    return redactSecrets(prose(prompt)).slice(0, PROMPT_HEAD_CHARS)
  } catch {
    return ''
  }
}

function normalise(text: unknown): string {
  return prose(text).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

// Equal for spawns that differ only in case, punctuation or spacing, and for prompts that share their first words.
export function cacheKey(subagentType: string, description: string, prompt: string): string {
  try {
    const words = normalise(prompt).split(' ').filter(Boolean).slice(0, KEY_PROMPT_WORDS).join(' ')
    return `${normalise(subagentType)}|${normalise(description).slice(0, KEY_DESCRIPTION_CHARS)}|${words}`
  } catch {
    return ''
  }
}

// Least recently used first, most recent last. Plain JSON, so it can live in a store.
export type LabelCache = { entries: [string, string][] }

export function emptyCache(): LabelCache {
  return { entries: [] }
}

// Reads stored data back; anything malformed or with an unknown label is dropped.
export function parseCache(raw: unknown): LabelCache {
  try {
    const list = (raw as { entries?: unknown } | null | undefined)?.entries
    if (!Array.isArray(list)) return emptyCache()
    const entries: [string, string][] = []
    for (const e of list) {
      if (Array.isArray(e) && typeof e[0] === 'string' && typeof e[1] === 'string' && LABELS.includes(e[1])) entries.push([e[0], e[1]])
    }
    return { entries }
  } catch {
    return emptyCache()
  }
}

// The label for `key` (undefined on a miss) and the cache with that entry marked as freshly used.
export function cacheGet(cache: LabelCache, key: string): { label: string | undefined; cache: LabelCache } {
  try {
    const i = cache.entries.findIndex(([k]) => k === key)
    if (i < 0) return { label: undefined, cache }
    const hit = cache.entries[i]!
    return { label: hit[1], cache: { entries: [...cache.entries.slice(0, i), ...cache.entries.slice(i + 1), hit] } }
  } catch {
    return { label: undefined, cache }
  }
}

// Adds or replaces `key` as the freshest entry and evicts the oldest ones beyond `max` (at least 1).
export function cachePut(cache: LabelCache, key: string, label: string, max: number): LabelCache {
  try {
    const bound = Number.isFinite(max) && max >= 1 ? Math.floor(max) : 1
    const entries = cache.entries.filter(([k]) => k !== key)
    entries.push([key, label])
    return { entries: entries.slice(Math.max(0, entries.length - bound)) }
  } catch {
    return cache
  }
}

// `type:label` as `categorize` builds it. A missing, invalid or unknown label gives `fallback` (the keyword category).
export function combineCategory(subagentType: string, label: string | undefined, fallback: string): string {
  try {
    const l = typeof label === 'string' ? label.trim().toLowerCase() : ''
    return LABELS.includes(l) ? `${str(subagentType)}:${l}` : fallback
  } catch {
    return fallback
  }
}
