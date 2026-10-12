import { expect, test } from 'claude-code/testing'
import { DEFAULT_CONFIG, type Config } from '../hooks/config'
import { beginRequest, decide, endRequest, escalated, startCall, failingTests, features, newAgent, normalizeError, observe, rememberModel, resolveModelId, type AgentState } from '../hooks/detector'

const err = (text: string) => ({ tool: 'Bash', ok: false, text, summary: 'npm test' })
const run = (s: AgentState, n: number, text: string) => {
  const actions: (string | undefined)[] = []
  for (let i = 0; i < n; i++) { const r = observe(s, err(text)); s = r.state; actions.push(r.action) }
  return { s, actions }
}

test('the same error with different line numbers is one signature', async () => {
  expect(normalizeError('Error at /src/a.ts:12:4')).toBe(normalizeError('Error at /lib/b.ts:99:1'))
})

test('reads failing test counts', async () => {
  expect(failingTests('Tests: 3 failed, 10 passed')).toBe(3)
  expect(failingTests('Tests: 12 passed, 12 total')).toBe(0)
  expect(failingTests('compiled ok')).toBe(undefined)
})

test('a repeated error climbs the ladder, one level per grace window', async () => {
  const { s, actions } = run(newAgent('a1', 'x', 'haiku', 'fix'), 40, 'TypeError: x is undefined at line 7')
  expect(actions.filter(Boolean)).toEqual(['nudge', 'consult', 'swap', 'swap', 'human'])
  expect(s.tier).toBe('opus')
  expect(s.level).toBe(4)
})

test('a stronger model gets more patience', async () => {
  const cheap = run(newAgent('a', 'x', 'haiku', 't'), 4, 'boom 1').actions.findIndex(Boolean)
  const strong = run(newAgent('b', 'x', 'opus', 't'), 8, 'boom 1').actions.findIndex(Boolean)
  expect(strong).toBeGreaterThan(cheap)
})

test('fewer failing tests is progress and resets the score', async () => {
  let s = newAgent('a1', 'x', 'haiku', 'fix')
  s = observe(s, { tool: 'Bash', ok: false, text: '5 failed', summary: 'npm test' }).state
  s = observe(s, { tool: 'Bash', ok: false, text: '5 failed', summary: 'npm test' }).state
  expect(s.score).toBeGreaterThan(0)
  s = observe(s, { tool: 'Bash', ok: false, text: '2 failed', summary: 'npm test' }).state
  expect(s.score).toBe(0)
})

test('a failing count that goes up (new failing tests: the red phase) adds no points by itself', async () => {
  const counts = (n: number) => ({ attempts: 0, sig: '', counts: [n] })
  let s = decide(newAgent('a1', 'x', 'haiku', 'fix'), counts(0)).state
  s = decide(s, counts(2)).state
  expect(s.score).toBe(0)
  s = decide(s, counts(5)).state
  expect(s.score).toBe(0)
  // The same count again while failing: no progress, one point.
  s = decide(s, counts(5)).state
  expect(s.score).toBe(1)
  // Within one output too: the runs of a loop that only add failing tests add nothing.
  expect(decide(newAgent('a2', 'x', 'haiku', 'fix'), { attempts: 0, sig: '', counts: [1, 3, 4] }).state.score).toBe(0)
})

test('the same error from calls of one assistant message (parallel calls) counts once', async () => {
  const fail = (sig: string, group?: number) => ({ attempts: 1, sig, counts: [], ...(group === undefined ? {} : { group }) })
  let s = newAgent('a1', 'x', 'haiku', 'fix')
  for (let i = 0; i < 3; i++) s = decide(s, fail('E', 1)).state
  expect(s.errorCounts).toEqual({ E: 1 })
  expect(s.score).toBe(0.25)
  // The next message repeating it is a real repeat.
  s = decide(s, fail('E', 2)).state
  expect(s.errorCounts).toEqual({ E: 2 })
  expect(s.score).toBe(1.25)
  // Another error in the same message counts.
  s = decide(s, fail('F', 2)).state
  expect(s.errorCounts).toEqual({ E: 2, F: 1 })
  // A parallel repeat of a failing test run adds nothing for the count either.
  let t = decide(newAgent('a2', 'x', 'haiku', 'fix'), { attempts: 1, sig: 'T', counts: [3], group: 1 }).state
  t = decide(t, { attempts: 1, sig: 'T', counts: [3], group: 1 }).state
  expect(t.score).toBe(0.25)
  // Without a message (an older recording) every call counts, as before.
  let u = newAgent('a3', 'x', 'haiku', 'fix')
  for (let i = 0; i < 3; i++) u = decide(u, fail('E')).state
  expect(u.errorCounts).toEqual({ E: 3 })
})

test('features carry the message of the call when it is known', async () => {
  expect(features({ tool: 'Bash', ok: false, text: 'boom', summary: 'x', group: 4 }).group).toBe(4)
  expect(features({ tool: 'Bash', ok: false, text: 'boom', summary: 'x' }).group).toBeUndefined()
})

test('the message of a tool call: the agent request it follows, for as many calls as that request asked for', async () => {
  let s = newAgent('a1', 'x', 'haiku', 'fix')
  // No request seen yet: no message.
  let c = startCall(s)
  expect(c.group).toBeUndefined()
  s = beginRequest(c.state)
  s = beginRequest(s)
  expect(s.requests).toBe(2)
  // While the request is still streaming, how many calls it asks for is not known yet: its calls belong to it.
  c = startCall(s)
  expect(c.group).toBe(2)
  // The request asked for two calls: the second belongs to it, a third cannot.
  s = endRequest(c.state, 2)
  c = startCall(s)
  expect(c.group).toBe(2)
  c = startCall(c.state)
  expect(c.group).toBeUndefined()
  // A request that asked for no call has no message for later calls.
  s = endRequest(beginRequest(c.state), 0)
  expect(startCall(s).group).toBeUndefined()
})

test('resolveModelId falls back to full default ids', async () => {
  expect(resolveModelId({}, 'haiku')).toBe('claude-haiku-5-5')
  expect(resolveModelId({}, 'sonnet')).toBe('claude-sonnet-5-5')
  expect(resolveModelId({}, 'opus')).toBe('claude-opus-5-5')
})

test('resolveModelId prefers ids observed at runtime', async () => {
  const seen = rememberModel({}, 'claude-sonnet-5-5-20261001')
  expect(resolveModelId(seen, 'sonnet')).toBe('claude-sonnet-5-5-20261001')
  expect(resolveModelId(seen, 'opus')).toBe('claude-opus-5-5')
})

test('rememberModel ignores bare aliases and empty values', async () => {
  for (const m of ['sonnet', 'opus', 'haiku', 'Sonnet', '', undefined]) {
    expect(rememberModel({}, m)).toEqual({})
  }
  const seen = rememberModel({}, 'claude-haiku-5-5')
  expect(seen).toEqual({ haiku: 'claude-haiku-5-5' })
})

test('rememberModel only keeps ids of the ladder families', async () => {
  for (const m of ['claude-fable-5-1', 'claude-mythos-1', 'claude-foo-1']) {
    expect(rememberModel({}, m)).toEqual({})
  }
  expect(rememberModel({}, 'claude-opus-5-5')).toEqual({ opus: 'claude-opus-5-5' })
  expect(rememberModel({}, 'Claude-Sonnet-5-5')).toEqual({ sonnet: 'Claude-Sonnet-5-5' })
})

const runWith = (s: AgentState, n: number, text: string, cfg: Config) => {
  const actions: (string | undefined)[] = []
  for (let i = 0; i < n; i++) { const r = observe(s, err(text), cfg); s = r.state; actions.push(r.action) }
  return { s, actions }
}

test('a custom threshold and grace window change when the ladder moves', async () => {
  const cfg = { ...DEFAULT_CONFIG, threshold: { haiku: 1, sonnet: 1, opus: 1 }, grace: 1 }
  const custom = runWith(newAgent('a', 'x', 'haiku', 't'), 8, 'boom 1', cfg).actions
  const def = run(newAgent('b', 'x', 'haiku', 't'), 8, 'boom 1').actions
  expect(custom.findIndex(Boolean)).toBeLessThan(def.findIndex(Boolean))
  expect(custom.filter(Boolean)).toEqual(['nudge', 'consult', 'swap', 'swap', 'human'])
  expect(def.filter(Boolean).length).toBeLessThan(5)
})

test('a disabled level is skipped by the ladder', async () => {
  const cfg = { ...DEFAULT_CONFIG, levels: ['nudge', 'swap'] as const }
  const { s, actions } = runWith(newAgent('a', 'x', 'haiku', 't'), 30, 'TypeError: x is undefined', cfg)
  expect(actions.filter(Boolean)).toEqual(['nudge', 'swap', 'swap'])
  expect(s.tier).toBe('opus')
  expect(escalated(s, cfg.levels)).toBe(true)
  expect(escalated({ ...s, level: 1 }, cfg.levels)).toBe(false)
  expect(escalated({ ...s, level: 3 }, DEFAULT_CONFIG.levels)).toBe(true)
  expect(escalated({ ...s, level: 2 }, DEFAULT_CONFIG.levels)).toBe(false)
})

test('resolveModelId falls back to the configured ids', async () => {
  const ids = { ...DEFAULT_CONFIG.modelIds, sonnet: 'claude-sonnet-x' }
  expect(resolveModelId({}, 'sonnet', ids)).toBe('claude-sonnet-x')
})
