import { test } from 'node:test'
import assert from 'node:assert/strict'
import { paginate } from '../../src/paginate.mjs'
import { describePage } from '../../src/format.mjs'

const range = (n) => Array.from({ length: n }, (_, i) => i + 1)

test('a list that divides evenly has no extra empty page', () => {
  const r = paginate(range(20), 2, 10)
  assert.equal(r.totalPages, 2)
  assert.deepEqual(r.items, range(20).slice(10))
  assert.equal(r.hasNext, false)
})

test('page size larger than the list', () => {
  const r = paginate(range(3), 1, 10)
  assert.equal(r.totalPages, 1)
  assert.deepEqual(r.items, [1, 2, 3])
  assert.equal(describePage(r, 3, 10), 'Page 1 of 1 (items 1-3 of 3)')
})

test('pages out of range are clamped', () => {
  assert.equal(paginate(range(25), 0, 10).page, 1)
  assert.equal(paginate(range(25), -4, 10).page, 1)
  const r = paginate(range(25), 99, 10)
  assert.equal(r.page, 3)
  assert.deepEqual(r.items, [21, 22, 23, 24, 25])
})

test('every item appears on exactly one page', () => {
  for (const [n, size] of [[1, 1], [7, 3], [30, 7], [100, 10]]) {
    const seen = []
    const { totalPages } = paginate(range(n), 1, size)
    for (let p = 1; p <= totalPages; p++) seen.push(...paginate(range(n), p, size).items)
    assert.deepEqual(seen, range(n), `n=${n} size=${size}`)
  }
})

test('labels of the last page and of a single item page', () => {
  assert.equal(describePage(paginate(range(25), 3, 10), 25, 10), 'Page 3 of 3 (items 21-25 of 25)')
  assert.equal(describePage(paginate(range(7), 7, 1), 7, 1), 'Page 7 of 7 (items 7-7 of 7)')
})

test('invalid page sizes are rejected', () => {
  for (const size of [0, -1, 2.5, Number.NaN]) {
    assert.throws(() => paginate(range(5), 1, size), RangeError)
  }
})
