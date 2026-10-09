import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runPool } from '../../src/pool.mjs'
import { withRetry } from '../../src/retry.mjs'

const T = { timeout: 3000 }
const tick = () => new Promise((r) => setImmediate(r))

function controllable(id, log) {
  let release
  let fail
  const done = new Promise((res, rej) => {
    release = res
    fail = rej
  })
  const task = () => {
    log.push(`start ${id}`)
    return done.then(
      () => {
        log.push(`end ${id}`)
        return id
      },
      (e) => {
        log.push(`end ${id}`)
        throw e
      },
    )
  }
  return { task, release, fail }
}

test('an empty list resolves to an empty array', T, async () => {
  assert.deepEqual(await runPool([], 3), [])
})

test('tasks start in order and the limit holds', T, async () => {
  const log = []
  const jobs = [0, 1, 2, 3, 4, 5].map((i) => controllable(i, log))
  const all = runPool(jobs.map((j) => j.task), 2)
  await tick()
  assert.deepEqual(log, ['start 0', 'start 1'])
  jobs[1].release()
  await tick()
  assert.deepEqual(log.slice(2), ['end 1', 'start 2'])
  for (const j of [jobs[0], jobs[3], jobs[2], jobs[5], jobs[4]]) {
    j.release()
    await tick()
  }
  assert.deepEqual(await all, [0, 1, 2, 3, 4, 5])
  assert.deepEqual(log.filter((l) => l.startsWith('start')), [0, 1, 2, 3, 4, 5].map((i) => `start ${i}`))
})

test('plain values and synchronous functions are accepted', T, async () => {
  assert.deepEqual(await runPool([() => 1, async () => 2, () => Promise.resolve(3)], 2), [1, 2, 3])
})

test('a limit larger than the list runs everything at once', T, async () => {
  const log = []
  const jobs = [0, 1, 2].map((i) => controllable(i, log))
  const all = runPool(jobs.map((j) => j.task), 10)
  await tick()
  assert.equal(log.length, 3)
  jobs.forEach((j) => j.release())
  assert.deepEqual(await all, [0, 1, 2])
})

test('after a failure no new task starts, and the pool waits for running ones', T, async () => {
  const log = []
  const jobs = [0, 1, 2, 3].map((i) => controllable(i, log))
  let settled = false
  const all = runPool(jobs.map((j) => j.task), 2).finally(() => (settled = true))
  await tick()
  jobs[0].fail(new Error('boom'))
  await tick()
  assert.equal(settled, false, 'must wait for task 1, still running')
  assert.ok(!log.includes('start 2'), 'no task may start after a failure')
  jobs[1].release()
  await assert.rejects(all, /boom/)
  assert.ok(!log.includes('start 2') && !log.includes('start 3'))
})

test('the first error wins and a synchronous throw counts as a failure', T, async () => {
  const log = []
  const jobs = [0, 1].map((i) => controllable(i, log))
  const tasks = [jobs[0].task, jobs[1].task, () => log.push('start 2')]
  const all = runPool(tasks, 2)
  await tick()
  jobs[1].fail(new Error('first'))
  await tick()
  jobs[0].fail(new Error('second'))
  await assert.rejects(all, /first/)
  assert.ok(!log.includes('start 2'))
  await assert.rejects(
    runPool([() => {
      throw new Error('sync')
    }], 1),
    /sync/,
  )
})

test('an invalid limit rejects with a RangeError', T, async () => {
  for (const limit of [0, -1, 1.5, Number.NaN, '2']) {
    await assert.rejects(runPool([() => 1], limit), RangeError, `limit ${String(limit)}`)
  }
})

test('retry waits with exponential backoff and not after the last attempt', T, async () => {
  let calls = 0
  const waits = []
  const task = withRetry(
    async () => {
      calls++
      throw new Error(`fail ${calls}`)
    },
    { attempts: 4, baseDelayMs: 5, sleep: async (ms) => waits.push(ms) },
  )
  await assert.rejects(task(), /fail 4/)
  assert.equal(calls, 4)
  assert.deepEqual(waits, [5, 10, 20])
})

test('retry with a single attempt never sleeps', T, async () => {
  const waits = []
  const ok = withRetry(async () => 'done', { attempts: 1, sleep: async (ms) => waits.push(ms) })
  assert.equal(await ok(), 'done')
  const ko = withRetry(async () => {
    throw new Error('nope')
  }, { attempts: 1, sleep: async (ms) => waits.push(ms) })
  await assert.rejects(ko(), /nope/)
  assert.deepEqual(waits, [])
})
