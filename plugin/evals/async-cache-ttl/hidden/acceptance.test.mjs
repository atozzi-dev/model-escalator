import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCache } from '../../src/cache.mjs'
import { createInflight } from '../../src/inflight.mjs'
import { createLru } from '../../src/lru.mjs'

const T = { timeout: 3000 }
const tick = () => new Promise((r) => setImmediate(r))

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

async function fill(cache, pending, key, value) {
  const p = cache.get(key)
  pending[pending.length - 1].resolve(value)
  return p
}

test('lru: touch moves a tracked key to the most recent position', T, () => {
  const lru = createLru()
  lru.touch('a')
  lru.touch('b')
  lru.touch('c')
  lru.touch('a')
  assert.equal(lru.size, 3)
  assert.equal(lru.evict(), 'b')
  assert.equal(lru.evict(), 'c')
  assert.equal(lru.evict(), 'a')
  assert.equal(lru.evict(), undefined)
  assert.equal(lru.size, 0)
})

test('lru: delete stops tracking a key', T, () => {
  const lru = createLru()
  lru.touch('a')
  lru.touch('b')
  lru.delete('a')
  assert.equal(lru.evict(), 'b')
  assert.equal(lru.evict(), undefined)
})

test('inflight: a rejected load is forgotten, a later start loads again', T, async () => {
  const inflight = createInflight()
  const p = inflight.start('a', () => Promise.reject(new Error('x')))
  assert.equal(inflight.get('a'), p)
  await assert.rejects(p, /x/)
  await tick()
  assert.equal(inflight.get('a'), undefined)
  const q = inflight.start('a', () => 5)
  assert.equal(await q, 5)
})

test('inflight: a synchronous throw becomes a rejection and is forgotten', T, async () => {
  const inflight = createInflight()
  const p = inflight.start('a', () => {
    throw new Error('sync')
  })
  await assert.rejects(p, /sync/)
  await tick()
  assert.equal(inflight.get('a'), undefined)
})

test('inflight: a cancelled load does not call onSuccess and does not disturb its successor', T, async () => {
  const inflight = createInflight()
  const seen = []
  let release
  const slow = inflight.start('a', () => new Promise((r) => (release = r)), (v) => seen.push(v))
  inflight.cancel('a')
  let release2
  const next = inflight.start('a', () => new Promise((r) => (release2 = r)), (v) => seen.push(v))
  release('old')
  assert.equal(await slow, 'old')
  await tick()
  assert.deepEqual(seen, [])
  assert.equal(inflight.get('a'), next)
  release2('new')
  assert.equal(await next, 'new')
  await tick()
  assert.deepEqual(seen, ['new'])
  assert.equal(inflight.get('a'), undefined)
})

test('inflight: onSuccess has run by the time the waiters resume', T, async () => {
  const inflight = createInflight()
  let stored = false
  const p = inflight.start('a', () => 1, () => (stored = true))
  await p
  assert.equal(stored, true)
})

test('cache: values are stored before the caller of get resumes', T, async () => {
  const { pending, cache } = setup()
  assert.equal(cache.size, 0)
  await fill(cache, pending, 'a', 1)
  assert.equal(cache.size, 1)
})

test('cache: freshness boundary, completion-based age and reload after expiry', T, async () => {
  const { clock, calls, pending, cache } = setup()
  const p = cache.get('a')
  clock.t = 60
  pending[0].resolve('v')
  await p
  clock.t = 159
  assert.equal(await cache.get('a'), 'v')
  assert.deepEqual(calls, ['a'])
  clock.t = 160
  const q = cache.get('a')
  assert.deepEqual(calls, ['a', 'a'])
  clock.t = 200
  pending[1].resolve('w')
  assert.equal(await q, 'w')
  clock.t = 299
  assert.equal(await cache.get('a'), 'w')
  assert.deepEqual(calls, ['a', 'a'])
})

test('cache: failures are never stored, whoever is waiting', T, async () => {
  const { calls, pending, cache } = setup()
  const first = cache.get('a')
  const second = cache.get('a')
  pending[0].reject(new Error('down'))
  await assert.rejects(first, /down/)
  await assert.rejects(second, /down/)
  assert.equal(cache.size, 0)
  const third = cache.get('a')
  const fourth = cache.get('a')
  assert.deepEqual(calls, ['a', 'a'])
  pending[1].resolve('up')
  assert.deepEqual(await Promise.all([third, fourth]), ['up', 'up'])
})

test('cache: a synchronous throw in load rejects get and is not cached', T, async () => {
  let n = 0
  const cache = createCache({
    ttlMs: 100,
    load: () => {
      n++
      if (n === 1) throw new Error('sync')
      return 'fine'
    },
  })
  await assert.rejects(cache.get('a'), /sync/)
  assert.equal(await cache.get('a'), 'fine')
})

test('cache: load may return a plain value', T, async () => {
  const cache = createCache({ ttlMs: 100, load: (k) => k.toUpperCase() })
  assert.equal(await cache.get('a'), 'A')
  assert.equal(cache.size, 1)
})

test('cache: least recently used entry is dropped, reads and loads both count as use', T, async () => {
  const { calls, pending, cache } = setup({ maxEntries: 3 })
  await fill(cache, pending, 'a', 'A')
  await fill(cache, pending, 'b', 'B')
  await fill(cache, pending, 'c', 'C')
  await cache.get('a')
  await cache.get('b')
  await fill(cache, pending, 'd', 'D')
  assert.equal(cache.size, 3)
  await cache.get('a')
  await cache.get('b')
  await cache.get('d')
  assert.deepEqual(calls, ['a', 'b', 'c', 'd'])
  const c = cache.get('c')
  assert.deepEqual(calls, ['a', 'b', 'c', 'd', 'c'])
  pending[4].resolve('C2')
  assert.equal(await c, 'C2')
  assert.equal(cache.size, 3)
})

test('cache: maxEntries 1 keeps only the latest key', T, async () => {
  const { calls, pending, cache } = setup({ maxEntries: 1 })
  await fill(cache, pending, 'a', 'A')
  await fill(cache, pending, 'b', 'B')
  assert.equal(cache.size, 1)
  assert.equal(await cache.get('b'), 'B')
  const a = cache.get('a')
  assert.deepEqual(calls, ['a', 'b', 'a'])
  pending[2].resolve('A2')
  await a
})

test('cache: an expired entry is dropped and no longer counts', T, async () => {
  const { clock, pending, cache } = setup({ maxEntries: 2 })
  await fill(cache, pending, 'a', 'A')
  clock.t = 500
  const again = cache.get('a')
  assert.equal(cache.size, 0)
  pending[1].resolve('A2')
  await again
  assert.equal(cache.size, 1)
})

test('cache: a stale entry is served at once and refreshed once in the background', T, async () => {
  const { clock, calls, pending, cache } = setup({ staleMs: 50 })
  await fill(cache, pending, 'a', 'v1')
  clock.t = 100
  assert.equal(await cache.get('a'), 'v1')
  assert.equal(await cache.get('a'), 'v1')
  assert.deepEqual(calls, ['a', 'a'])
  pending[1].resolve('v2')
  await tick()
  clock.t = 120
  assert.equal(await cache.get('a'), 'v2')
  assert.deepEqual(calls, ['a', 'a'])
  clock.t = 199
  assert.equal(await cache.get('a'), 'v2')
  assert.deepEqual(calls, ['a', 'a'])
})

test('cache: a failed background refresh keeps the stale entry and is retried', T, async () => {
  const { clock, calls, pending, cache } = setup({ staleMs: 50 })
  await fill(cache, pending, 'a', 'v1')
  clock.t = 110
  assert.equal(await cache.get('a'), 'v1')
  pending[1].reject(new Error('refresh failed'))
  await tick()
  assert.equal(cache.size, 1)
  assert.equal(await cache.get('a'), 'v1')
  assert.deepEqual(calls, ['a', 'a', 'a'])
  pending[2].resolve('v3')
  await tick()
  assert.equal(await cache.get('a'), 'v3')
})

test('cache: past the stale window a miss waits for the load, and a failure rejects', T, async () => {
  const { clock, pending, cache } = setup({ staleMs: 50 })
  await fill(cache, pending, 'a', 'v1')
  clock.t = 150
  const p = cache.get('a')
  pending[1].reject(new Error('gone'))
  await assert.rejects(p, /gone/)
  assert.equal(cache.size, 0)
})

test('cache: a get during a stale refresh joins it instead of starting another load', T, async () => {
  const { clock, calls, pending, cache } = setup({ staleMs: 50 })
  await fill(cache, pending, 'a', 'v1')
  clock.t = 100
  await cache.get('a')
  clock.t = 160
  const joined = cache.get('a')
  assert.deepEqual(calls, ['a', 'a'])
  pending[1].resolve('v2')
  assert.equal(await joined, 'v2')
})

test('cache: invalidate drops the entry and the next get loads again', T, async () => {
  const { calls, pending, cache } = setup()
  await fill(cache, pending, 'a', 1)
  cache.invalidate('a')
  assert.equal(cache.size, 0)
  const p = cache.get('a')
  assert.deepEqual(calls, ['a', 'a'])
  pending[1].resolve(2)
  assert.equal(await p, 2)
})

test('cache: invalidate during a load keeps the waiters served but stores nothing', T, async () => {
  const { calls, pending, cache } = setup()
  const p = cache.get('a')
  const q = cache.get('a')
  cache.invalidate('a')
  const fresh = cache.get('a')
  assert.deepEqual(calls, ['a', 'a'])
  pending[0].resolve('old')
  assert.deepEqual(await Promise.all([p, q]), ['old', 'old'])
  await tick()
  assert.equal(cache.size, 0)
  pending[1].resolve('new')
  assert.equal(await fresh, 'new')
  assert.equal(cache.size, 1)
  assert.equal(await cache.get('a'), 'new')
  assert.deepEqual(calls, ['a', 'a'])
})

test('cache: invalidate during a stale refresh discards the refresh result', T, async () => {
  const { clock, calls, pending, cache } = setup({ staleMs: 50 })
  await fill(cache, pending, 'a', 'v1')
  clock.t = 100
  await cache.get('a')
  cache.invalidate('a')
  pending[1].resolve('v2')
  await tick()
  assert.equal(cache.size, 0)
  const p = cache.get('a')
  assert.deepEqual(calls, ['a', 'a', 'a'])
  pending[2].resolve('v3')
  assert.equal(await p, 'v3')
})

test('cache: clear drops everything, loads in progress included', T, async () => {
  const { calls, pending, cache } = setup({ maxEntries: 2 })
  await fill(cache, pending, 'a', 'A')
  await fill(cache, pending, 'b', 'B')
  const loading = cache.get('c')
  cache.clear()
  assert.equal(cache.size, 0)
  pending[2].resolve('C')
  assert.equal(await loading, 'C')
  await tick()
  assert.equal(cache.size, 0)
  await fill(cache, pending, 'a', 'A2')
  await fill(cache, pending, 'b', 'B2')
  await fill(cache, pending, 'c', 'C2')
  assert.equal(cache.size, 2)
  assert.deepEqual(calls, ['a', 'b', 'c', 'a', 'b', 'c'])
})

test('cache: keys are independent', T, async () => {
  const { calls, pending, cache } = setup()
  const a = cache.get('a')
  const b = cache.get('b')
  assert.deepEqual(calls, ['a', 'b'])
  pending[1].resolve('B')
  pending[0].resolve('A')
  assert.deepEqual(await Promise.all([a, b]), ['A', 'B'])
})
