import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCache } from '../src/cache.mjs'

// A clock the test moves by hand and a loader whose results the test controls.
function setup(options = {}) {
  const clock = { t: 0 }
  const calls = []
  const pending = []
  const load = (key) =>
    new Promise((resolve, reject) => {
      calls.push(key)
      pending.push({ key, resolve, reject })
    })
  const cache = createCache({ load, ttlMs: 100, now: () => clock.t, ...options })
  return { clock, calls, pending, cache }
}

const T = { timeout: 3000 }
const tick = () => new Promise((r) => setImmediate(r))

test('a fresh entry is served without loading, an entry exactly ttlMs old is not', T, async () => {
  const { clock, calls, pending, cache } = setup()
  const first = cache.get('a')
  pending[0].resolve(1)
  assert.equal(await first, 1)
  clock.t = 99
  assert.equal(await cache.get('a'), 1)
  assert.deepEqual(calls, ['a'])
  clock.t = 100
  const again = cache.get('a')
  assert.deepEqual(calls, ['a', 'a'])
  pending[1].resolve(2)
  assert.equal(await again, 2)
})

test('concurrent gets of one key share a single load', T, async () => {
  const { calls, pending, cache } = setup()
  const p1 = cache.get('a')
  const p2 = cache.get('a')
  assert.deepEqual(calls, ['a'])
  pending[0].resolve('v')
  assert.deepEqual(await Promise.all([p1, p2]), ['v', 'v'])
})

test('a failed load rejects every waiter and is retried by the next get', T, async () => {
  const { calls, pending, cache } = setup()
  const p1 = cache.get('a')
  const p2 = cache.get('a')
  pending[0].reject(new Error('boom'))
  await assert.rejects(p1, /boom/)
  await assert.rejects(p2, /boom/)
  const p3 = cache.get('a')
  assert.deepEqual(calls, ['a', 'a'])
  pending[1].resolve('ok')
  assert.equal(await p3, 'ok')
})

test('the age of an entry counts from when its load completed', T, async () => {
  const { clock, calls, pending, cache } = setup()
  const p = cache.get('a')
  clock.t = 80
  pending[0].resolve('v')
  await p
  clock.t = 170
  assert.equal(await cache.get('a'), 'v')
  assert.deepEqual(calls, ['a'])
})

test('reading a key makes it the most recently used one', T, async () => {
  const { calls, pending, cache } = setup({ maxEntries: 2 })
  const a = cache.get('a')
  pending[0].resolve('A')
  await a
  const b = cache.get('b')
  pending[1].resolve('B')
  await b
  await cache.get('a')
  const c = cache.get('c')
  pending[2].resolve('C')
  await c
  assert.equal(cache.size, 2)
  await cache.get('a')
  assert.deepEqual(calls, ['a', 'b', 'c'])
})

test('a load that was invalidated while running is not stored', T, async () => {
  const { calls, pending, cache } = setup()
  const p = cache.get('a')
  cache.invalidate('a')
  pending[0].resolve('old')
  assert.equal(await p, 'old')
  await tick()
  assert.equal(cache.size, 0)
  const q = cache.get('a')
  assert.deepEqual(calls, ['a', 'a'])
  pending[1].resolve('new')
  assert.equal(await q, 'new')
})
