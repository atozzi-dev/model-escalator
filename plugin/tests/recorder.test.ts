import { expect, test } from 'claude-code/testing'
import { DEFAULT_CONFIG, parseConfig } from '../hooks/config'
import { features } from '../hooks/detector'
import {
  addAgent, hashKey, indexOf, mergeRecordings, parseRecordings, push, RECORDING_VERSION, RECORDED_OPTIONS, recordedOptions,
  resumeRecording, SESSION_MAX_BYTES, sigText, sizeOf, startRecording, stepEvent, toolEvent, TOTAL_MAX_BYTES, type Recording,
} from '../hooks/recorder'

const fresh = () => startRecording('s1', 1_000_000, 'observe', 'opus', recordedOptions(DEFAULT_CONFIG))

test('a new recording carries its format version, session, mode and the options the replay needs', async () => {
  const live = fresh()
  expect(live.rec.v).toBe(RECORDING_VERSION)
  expect(live.rec.id).toBe('s1')
  expect(live.rec.mode).toBe('observe')
  expect(Object.keys(live.rec.opts).sort()).toEqual([...RECORDED_OPTIONS].sort())
  expect(live.rec.opts.thresholdHaiku).toBe(3)
  expect(live.rec.opts.levels).toBe('nudge,consult,swap,human')
  // The options read back as the same configuration.
  const back = parseConfig(live.rec.opts)
  expect(back.threshold).toEqual(DEFAULT_CONFIG.threshold)
  expect(back.levels).toEqual(DEFAULT_CONFIG.levels)
  expect(live.bytes).toBe(sizeOf(live.rec))
})

test('agents get one index each; the label is the redacted name or the category', async () => {
  const live = fresh()
  const a = addAgent(live, { id: 'x1', label: 'fixer token=abcd1234efgh', cat: 'general-purpose:bugfix', tier: 'haiku' })
  const b = addAgent(live, { id: 'x2', label: '', cat: 'general-purpose:docs', tier: 'sonnet' })
  expect(a).toBe(0)
  expect(b).toBe(1)
  expect(addAgent(live, { id: 'x1', label: 'again', cat: 'c', tier: 'opus' })).toBe(0)
  expect(indexOf(live, 'x2')).toBe(1)
  expect(indexOf(live, 'nope')).toBe(undefined)
  expect(live.rec.agents[0]!.label).not.toContain('abcd1234efgh')
  expect(live.rec.agents[1]!.label).toBe('general-purpose:docs')
})

test('a tool event keeps derived features only: hashed signature and file, failing counts, attempts', async () => {
  const live = fresh()
  const a = addAgent(live, { id: 'x1', label: 'fixer', cat: 'c', tier: 'haiku' })
  const secret = 'Error: login failed with password=hunter2hunter2 at /src/app.ts:12'
  const f = features({ tool: 'Bash', ok: false, text: secret, summary: 'npm test -- --password hunter2hunter2' })
  const ev = toolEvent(live, a, 1_005_000, 1_002_000, 'Bash', f)
  expect(ev).toEqual({ k: 'tool', a, at: 5000, d: 3000, t: 'Bash', n: 1, s: hashKey(f.sig) })
  // The signature text is kept once, redacted; the command line never is.
  expect(Object.values(live.rec.sigs).length).toBe(1)
  expect(JSON.stringify(live.rec)).not.toContain('hunter2')
  const edit = toolEvent(live, a, 1_006_000, 1_006_000, 'Edit', features({ tool: 'Edit', ok: true, text: 'ok', summary: 'C:\\Secret\\Plan.ts' }))
  expect(edit).toEqual({ k: 'tool', a, at: 6000, d: 0, t: 'Edit', e: hashKey('c:/secret/plan.ts') })
  expect(JSON.stringify(live.rec)).not.toContain('plan.ts')
  const tests = toolEvent(live, a, 1_007_000, 1_006_500, 'Bash', features({ tool: 'Bash', ok: true, text: 'Tests: 2 failed, 3 passed', summary: 'npm test' }))
  expect((tests as { f?: number[] }).f).toEqual([2])
})

test('signature texts lose Windows and UNC paths too, and secrets', async () => {
  expect(sigText('Error: ENOENT C:\\Users\\alice\\proj\\a.ts not found')).toBe('Error: ENOENT <path> not found')
  expect(sigText('cannot open \\\\server\\share\\x.txt')).toBe('cannot open <path>')
  expect(sigText('bad api_key=sk-abcdefghijklmnopqrstuvwxyz')).not.toContain('abcdefghijklmnop')
})

test('a step event keeps the tier, the effort and the usage', async () => {
  const live = fresh()
  const a = addAgent(live, { id: 'x1', label: 'fixer', cat: 'c', tier: 'haiku' })
  expect(stepEvent(live, a, 1_001_000, 1_000_400, 'claude-haiku-5-5', 'high', { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40 }))
    .toEqual({ k: 'step', a, at: 1000, d: 600, m: 'haiku', ef: 'high', u: [10, 20, 30, 40] })
  expect(stepEvent(live, a, undefined, undefined, 'claude-sonnet-5-5', null, undefined)).toEqual({ k: 'step', a, at: 0, d: 0, m: 'sonnet' })
})

test('the size is tracked as events are pushed', async () => {
  const live = fresh()
  const a = addAgent(live, { id: 'x1', label: 'fixer', cat: 'c', tier: 'haiku' })
  push(live, { k: 'spawn', a, at: 0, asked: 'haiku', tier: 'haiku' })
  for (let i = 0; i < 50; i++) push(live, toolEvent(live, a, 1_000_000 + i, 1_000_000, 'Bash', features({ tool: 'Bash', ok: false, text: `boom ${i % 3}`, summary: 'x' })))
  expect(live.bytes).toBe(sizeOf(live.rec))
})

test('a session over its cap drops its oldest events first, marks them and the agents they cut', async () => {
  const live = fresh()
  push(live, { k: 'boot', at: 0 })
  const old = addAgent(live, { id: 'old', label: 'old', cat: 'c', tier: 'haiku' })
  push(live, { k: 'spawn', a: old, at: 0, asked: 'haiku', tier: 'haiku' })
  for (let i = 0; i < 2000; i++) push(live, { k: 'step', a: old, at: i, d: 1, m: 'haiku', u: [1000, 2000, 30000, 4000] })
  const young = addAgent(live, { id: 'young', label: 'young', cat: 'c', tier: 'haiku' })
  push(live, { k: 'spawn', a: young, at: 5000, asked: 'haiku', tier: 'haiku' })
  let i = 0
  while (live.rec.dropped === 0) push(live, { k: 'step', a: young, at: 6000 + i++, d: 1, m: 'haiku', u: [1000, 2000, 30000, 4000] })
  expect(live.bytes).toBeLessThanOrEqual(SESSION_MAX_BYTES)
  expect(live.bytes).toBe(sizeOf(live.rec))
  expect(live.rec.agents[old]!.cut).toBe(true)
  expect(live.rec.agents[young]!.cut).toBe(undefined)
  // The boot marks stay (the replay needs the stall timer's phase), and the young agent is whole.
  expect(live.rec.events[0]).toEqual({ k: 'boot', at: 0 })
  expect(live.rec.events.some((e) => e.k === 'spawn' && e.a === young)).toBe(true)
  for (let j = 0; j < 20_000; j++) push(live, { k: 'step', a: young, at: 9000 + j, d: 1, m: 'haiku', u: [1000, 2000, 30000, 4000] })
  expect(live.bytes).toBeLessThanOrEqual(SESSION_MAX_BYTES)
})

test('stored recordings: the current one replaces its older copy, at most `keep`, and the total is capped', async () => {
  const mk = (id: string, pad = 0): Recording => {
    const l = startRecording(id, 1, 'active', 'opus', {})
    const a = addAgent(l, { id: 'a', label: 'a', cat: 'c', tier: 'haiku' })
    for (let i = 0; i < pad; i++) push(l, { k: 'step', a, at: i, d: 1, m: 'haiku', u: [1000, 2000, 30000, 4000] })
    return l.rec
  }
  const stored = [mk('a'), mk('b'), mk('c')]
  expect(mergeRecordings(stored, mk('b'), 5).map((r) => r.id)).toEqual(['a', 'c', 'b'])
  expect(mergeRecordings(stored, mk('d'), 2).map((r) => r.id)).toEqual(['c', 'd'])
  expect(mergeRecordings([null, 'x', { v: 99 }, ...stored], mk('d'), 10).map((r) => r.id)).toEqual(['a', 'b', 'c', 'd'])
  // Big sessions: the oldest go until the total fits; the current one always stays.
  const big = Array.from({ length: 8 }, (_, i) => mk('big' + i, 3500))
  const merged = mergeRecordings(big, mk('now', 3500), 50)
  expect(merged[merged.length - 1]!.id).toBe('now')
  expect(merged.reduce((n, r) => n + sizeOf(r), 0)).toBeLessThanOrEqual(TOTAL_MAX_BYTES)
  expect(merged.length).toBeLessThan(9)
})

test('parsing drops malformed recordings and a reloaded one keeps its agent indexes', async () => {
  const live = fresh()
  addAgent(live, { id: 'x1', label: 'a', cat: 'c', tier: 'haiku' })
  addAgent(live, { id: 'x2', label: 'b', cat: 'c', tier: 'haiku' })
  const stored = JSON.parse(JSON.stringify([live.rec, { v: 1, id: 7 }, 3]))
  const parsed = parseRecordings(stored)
  expect(parsed.length).toBe(1)
  const back = resumeRecording(parsed[0]!)
  expect(indexOf(back, 'x2')).toBe(1)
  expect(addAgent(back, { id: 'x3', label: 'c', cat: 'c', tier: 'haiku' })).toBe(2)
  expect(parseRecordings(undefined)).toEqual([])
})
