import { expect, test } from 'claude-code/testing'
import { failingTests, newAgent, normalizeError, observe, type AgentState } from '../hooks/detector'

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
  const { s, actions } = run(newAgent('a1', 'x', 'haiku', 'fix'), 20, 'TypeError: x is undefined at line 7')
  expect(actions.filter(Boolean)).toEqual(['nudge', 'consult', 'swap', 'human'])
  expect(s.tier).toBe('sonnet')
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
