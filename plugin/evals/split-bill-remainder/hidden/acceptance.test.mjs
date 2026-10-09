import { test } from 'node:test'
import assert from 'node:assert/strict'
import { splitByWeight, splitEvenly } from '../../src/split.mjs'
import { formatCents } from '../../src/money.mjs'

const sum = (xs) => xs.reduce((a, b) => a + b, 0)

// Small deterministic generator so the property checks are reproducible.
function rng(seed) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

test('ties go to the participant listed first', () => {
  assert.deepEqual(splitEvenly(5, 3), [2, 2, 1])
  assert.deepEqual(splitEvenly(2, 4), [1, 1, 0, 0])
  assert.deepEqual(splitByWeight(10, [1, 1, 1, 1, 1, 1]), [2, 2, 2, 2, 1, 1])
})

test('largest fractional parts get the leftover cents, not the largest weights', () => {
  // exact shares: 1.4, 1.75, 6.85 -> floors 1, 1, 6 -> two cents left for 0.85 then 0.75
  assert.deepEqual(splitByWeight(10, [28, 35, 137]), [1, 2, 7])
  assert.deepEqual(splitByWeight(7, [1, 1, 5]), [1, 1, 5])
  assert.deepEqual(splitByWeight(100, [1.5, 2.5]), [38, 62])
})

test('zero weights get nothing', () => {
  assert.deepEqual(splitByWeight(99, [0, 1, 0, 2]), [0, 33, 0, 66])
  assert.deepEqual(splitByWeight(0, [1, 2]), [0, 0])
})

test('a refund is split like its absolute value', () => {
  assert.deepEqual(splitEvenly(-100, 3), [-34, -33, -33])
  assert.deepEqual(splitByWeight(-1000, [1, 2, 3]), [-167, -333, -500])
})

test('shares always add up and stay within one cent of the exact share', () => {
  const next = rng(42)
  for (let round = 0; round < 500; round++) {
    const total = Math.floor(next() * 2_000_001) - 1_000_000
    const weights = Array.from({ length: 1 + Math.floor(next() * 7) }, () => Math.floor(next() * 50))
    if (sum(weights) === 0) weights[0] = 1
    const shares = splitByWeight(total, weights)
    assert.equal(shares.length, weights.length)
    assert.equal(sum(shares), total, `total ${total} weights ${weights}`)
    for (let i = 0; i < weights.length; i++) {
      assert.ok(Number.isInteger(shares[i]))
      const exact = (total * weights[i]) / sum(weights)
      assert.ok(Math.abs(shares[i] - exact) < 1, `share ${shares[i]} vs exact ${exact}`)
    }
  }
})

test('invalid input is rejected with a RangeError', () => {
  assert.throws(() => splitByWeight(100, []), RangeError)
  assert.throws(() => splitByWeight(100, [0, 0]), RangeError)
  assert.throws(() => splitByWeight(100, [1, -1, 2]), RangeError)
  assert.throws(() => splitByWeight(100, [1, Infinity]), RangeError)
  assert.throws(() => splitByWeight(100, [1, Number.NaN]), RangeError)
  assert.throws(() => splitByWeight(10.5, [1, 1]), RangeError)
  assert.throws(() => splitEvenly(100, 0), RangeError)
})

test('formats amounts of any sign and size', () => {
  assert.equal(formatCents(0), '0.00')
  assert.equal(formatCents(7), '0.07')
  assert.equal(formatCents(100), '1.00')
  assert.equal(formatCents(-100), '-1.00')
  assert.equal(formatCents(-123456), '-1,234.56')
  assert.equal(formatCents(100000000), '1,000,000.00')
  assert.equal(formatCents(-99), '-0.99')
})
