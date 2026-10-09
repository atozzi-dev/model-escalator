import { expect, test } from 'claude-code/testing'
import { DEFAULT_CONFIG, type Config } from '../hooks/config'
import { newAgent, observe } from '../hooks/detector'

// High thresholds so the score can be compared without interventions resetting it.
const calm: Config = { ...DEFAULT_CONFIG, threshold: { haiku: 1000, sonnet: 1000, opus: 1000 } }
const bash = (ok: boolean, text: string) => ({ tool: 'Bash', ok, text, summary: 'bash test.sh' })

const attempt = 'FAILED: adds with carry policy (expected 5, got 4)\n1 failed, 1 passed\n'

test('a loop of failing runs in one call weighs as much as separate failing calls', async () => {
  let separate = newAgent('a', 'x', 'haiku', 't')
  for (let i = 0; i < 5; i++) separate = observe(separate, bash(false, attempt), calm).state

  // ok is true because the command ends in `; echo "exit=$?"`
  const loop = observe(newAgent('b', 'x', 'haiku', 't'), bash(true, attempt.repeat(5) + 'exit=1\n'), calm).state
  expect(loop.score).toBe(separate.score)
})

test('a batched loop escalates as fast as separate calls', async () => {
  const r = observe(newAgent('b', 'x', 'haiku', 't'), bash(true, attempt.repeat(5) + 'exit=1\n'))
  expect(r.action).toBe('nudge')
})

test('a successful call with a non-zero exit marker counts as a failed attempt', async () => {
  const s = observe(newAgent('a', 'x', 'haiku', 't'), bash(true, 'something broke\nexit=2\n'), calm).state
  expect(s.score).toBe(0.25)
  expect(Object.keys(s.errorCounts).length).toBe(1)
})

test('a clean call with exit=0 is not an error', async () => {
  const s = observe(newAgent('a', 'x', 'haiku', 't'), bash(true, 'all good\nexit=0\n'), calm).state
  expect(s.score).toBe(0)
})

test('decreasing failures inside one output are progress', async () => {
  let s = newAgent('a', 'x', 'haiku', 't')
  s = observe(s, bash(false, 'Tests: 5 failed, 5 passed, 10 total'), calm).state
  s = observe(s, bash(false, 'Tests: 5 failed, 5 passed, 10 total'), calm).state
  expect(s.score).toBeGreaterThan(0)
  s = observe(s, bash(true, 'Tests: 4 failed, 6 passed, 10 total\nTests: 2 failed, 8 passed, 10 total\n'), calm).state
  expect(s.score).toBe(0)
  expect(s.lastFailing).toBe(2)
})

test('runs after a progress inside the same output count again', async () => {
  let s = newAgent('a', 'x', 'haiku', 't')
  s = observe(s, bash(true, '3 failed, 7 passed'), calm).state
  s = observe(s, bash(true, '2 failed, 8 passed\n2 failed, 8 passed\n2 failed, 8 passed\n'), calm).state
  expect(s.score).toBe(2)
  expect(s.lastFailing).toBe(2)
})

test('pytest summaries are read', async () => {
  let s = newAgent('a', 'x', 'haiku', 't')
  s = observe(s, bash(false, '=== 3 failed, 2 passed in 0.5s ==='), calm).state
  s = observe(s, bash(false, '=== 1 failed, 4 passed in 0.5s ==='), calm).state
  expect(s.score).toBe(0)
  expect(s.lastFailing).toBe(1)
})

test('a passing run is progress', async () => {
  let s = newAgent('a', 'x', 'haiku', 't')
  s = observe(s, bash(false, '2 failed, 1 passed'), calm).state
  s = observe(s, bash(true, '=== 3 passed in 0.1s ==='), calm).state
  expect(s.score).toBe(0)
  expect(s.lastFailing).toBe(0)
})

test('output without a recognised summary falls back to the failing count', async () => {
  let s = newAgent('a', 'x', 'haiku', 't')
  s = observe(s, bash(true, 'ran suite: 3 failures'), calm).state
  expect(s.lastFailing).toBe(3)
  s = observe(s, bash(true, 'ran suite: 3 failures'), calm).state
  expect(s.score).toBe(1)
})
