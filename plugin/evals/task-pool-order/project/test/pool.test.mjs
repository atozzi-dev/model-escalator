import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runPool } from '../src/pool.mjs'
import { withRetry } from '../src/retry.mjs'

// A task whose completion the test controls, recording how many tasks run at once.
function harness() {
  const state = { running: 0, peak: 0, started: [] }
  const make = (id) => {
    let release
    const done = new Promise((r) => (release = r))
    const task = async () => {
      state.started.push(id)
      state.running++
      state.peak = Math.max(state.peak, state.running)
      await done
      state.running--
      return id
    }
    return { task, release }
  }
  return { state, make }
}

const T = { timeout: 3000 }
const tick = () => new Promise((r) => setImmediate(r))

test('never runs more than limit tasks at once', T, async () => {
  const { state, make } = harness()
  const jobs = [1, 2, 3, 4, 5].map(make)
  const all = runPool(jobs.map((j) => j.task), 2)
  await tick()
  assert.equal(state.running, 2)
  for (const j of jobs) {
    j.release()
    await tick()
  }
  await all
  assert.equal(state.peak, 2)
})

test('results keep the order of the tasks', T, async () => {
  const { make } = harness()
  const jobs = ['a', 'b', 'c'].map(make)
  const all = runPool(jobs.map((j) => j.task), 3)
  jobs[2].release()
  await tick()
  jobs[0].release()
  await tick()
  jobs[1].release()
  assert.deepEqual(await all, ['a', 'b', 'c'])
})

test('retries a failing task until it succeeds', T, async () => {
  let calls = 0
  const waits = []
  const task = withRetry(
    async () => {
      calls++
      if (calls < 3) throw new Error(`fail ${calls}`)
      return 'ok'
    },
    { attempts: 3, baseDelayMs: 10, sleep: async (ms) => waits.push(ms) },
  )
  assert.equal(await task(), 'ok')
  assert.equal(calls, 3)
  assert.deepEqual(waits, [10, 20])
})
