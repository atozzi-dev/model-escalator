import { test } from 'node:test'
import assert from 'node:assert/strict'
import { splitByWeight, splitEvenly } from '../src/split.mjs'
import { formatCents } from '../src/money.mjs'

const sum = (xs) => xs.reduce((a, b) => a + b, 0)

test('an even split that divides exactly', () => {
  assert.deepEqual(splitEvenly(900, 3), [300, 300, 300])
})

test('shares always add up to the total', () => {
  const shares = splitEvenly(100, 3)
  assert.equal(sum(shares), 100)
  assert.deepEqual(shares, [34, 33, 33])
})

test('weighted split hands leftover cents to the largest remainders', () => {
  assert.deepEqual(splitByWeight(1000, [1, 2, 3]), [167, 333, 500])
})

test('formats cents', () => {
  assert.equal(formatCents(123456), '1,234.56')
  assert.equal(formatCents(5), '0.05')
  assert.equal(formatCents(-5), '-0.05')
})
