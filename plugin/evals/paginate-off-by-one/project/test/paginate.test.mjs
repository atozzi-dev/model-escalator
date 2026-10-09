import { test } from 'node:test'
import assert from 'node:assert/strict'
import { paginate } from '../src/paginate.mjs'
import { describePage } from '../src/format.mjs'

const range = (n) => Array.from({ length: n }, (_, i) => i + 1)

test('first page of a list that does not divide evenly', () => {
  const r = paginate(range(25), 1, 10)
  assert.deepEqual(r.items, range(10))
  assert.equal(r.totalPages, 3)
  assert.equal(r.hasPrev, false)
  assert.equal(r.hasNext, true)
})

test('the last, partial page is reachable', () => {
  const r = paginate(range(25), 3, 10)
  assert.deepEqual(r.items, [21, 22, 23, 24, 25])
  assert.equal(r.hasNext, false)
})

test('label of a middle page', () => {
  const r = paginate(range(25), 2, 10)
  assert.equal(describePage(r, 25, 10), 'Page 2 of 3 (items 11-20 of 25)')
})

test('empty list', () => {
  const r = paginate([], 1, 10)
  assert.deepEqual(r.items, [])
  assert.equal(r.totalPages, 1)
  assert.equal(describePage(r, 0, 10), 'No items')
})
