import { expect, test } from 'claude-code/testing'
import { DEFAULT_CONFIG } from '../hooks/config'
import { decide, endRun, features, newAgent, normalizeError, observe, type AgentState, type Observation } from '../hooks/detector'

const obs: Observation[] = [
  { tool: 'Bash', ok: false, text: 'TypeError: x is undefined at /src/a.ts:7', summary: 'npm test' },
  { tool: 'Bash', ok: true, text: 'Tests: 3 failed, 4 passed\nexit=1', summary: 'npm test' },
  { tool: 'Edit', ok: true, text: 'ok', summary: 'C:\\Work\\Src\\A.ts' },
  { tool: 'Bash', ok: true, text: 'Tests: 3 failed, 4 passed', summary: 'npm test' },
  { tool: 'Edit', ok: true, text: 'ok', summary: 'c:/work/src/a.ts' },
  { tool: 'Edit', ok: true, text: 'ok', summary: 'c:/work/src/a.ts' },
  { tool: 'Edit', ok: true, text: 'ok', summary: 'c:/work/src/a.ts' },
  { tool: 'Bash', ok: true, text: 'Tests: 0 failed, 7 passed', summary: 'npm test' },
]

test('features keep what the score needs from an output: attempts, signature, failing counts, edited file', async () => {
  expect(features(obs[0]!)).toEqual({ attempts: 1, sig: normalizeError(obs[0]!.text), counts: [] })
  expect(features(obs[1]!)).toEqual({ attempts: 1, sig: normalizeError(obs[1]!.text), counts: [3] })
  expect(features(obs[2]!)).toEqual({ attempts: 0, sig: '', counts: [], edit: 'c:/work/src/a.ts' })
  expect(features({ tool: 'Read', ok: true, text: 'x', summary: '/a.ts' })).toEqual({ attempts: 0, sig: '', counts: [] })
})

test('deciding from the features gives the same score, ladder and progress as observing the output', async () => {
  let a: AgentState = newAgent('a1', 'x', 'haiku', 'fix')
  let b: AgentState = a
  for (const ob of [...obs, ...obs, ...obs]) {
    const full = observe(a, ob, DEFAULT_CONFIG)
    const lean = decide(b, features(ob), DEFAULT_CONFIG)
    expect(lean.action).toBe(full.action)
    expect(lean.progress).toBe(full.progress)
    const { log: _l, recentErrors: _r, ...fullRest } = full.state
    const { log: _l2, recentErrors: _r2, ...leanRest } = lean.state
    expect(leanRest).toEqual(fullRest)
    a = full.state
    b = lean.state
  }
})

test('observe still logs the call and keeps the failed text for the dossier', async () => {
  const r = observe(newAgent('a1', 'x', 'haiku', 'fix'), obs[0]!, DEFAULT_CONFIG)
  expect(r.state.log.length).toBe(1)
  expect(r.state.log[0]).toContain('Bash: npm test -> ERR')
  expect(r.state.recentErrors).toEqual([obs[0]!.text])
})

test('the end of a run resets the ladder and keeps the tier, the pause and the counts', async () => {
  const s: AgentState = { ...newAgent('a1', 'x', 'haiku', 'fix'), tier: 'sonnet', level: 3, score: 2, stepsSinceAction: 5,
    deescalated: true, progressSignals: 2, running: true, inFlight: 1, stalled: true, paused: true, consults: 2 }
  const e = endRun(s)
  expect(e).toEqual({ ...s, level: 0, score: 0, stepsSinceAction: 0, deescalated: false, progressSignals: 0, running: false, inFlight: 0, stalled: false })
})
