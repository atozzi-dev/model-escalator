import { test } from 'node:test'
import assert from 'node:assert/strict'
import { maxSatisfying, satisfies } from '../src/satisfies.mjs'
import { compareVersions, parseVersion } from '../src/version.mjs'

test('versions compare numerically, not as text', () => {
  assert.equal(compareVersions('1.10.0', '1.2.0'), 1)
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0)
  assert.equal(compareVersions('0.9.9', '1.0.0'), -1)
})

test('a prerelease is lower than its release, and prereleases are ordered', () => {
  assert.equal(compareVersions('1.0.0-rc.1', '1.0.0'), -1)
  assert.equal(compareVersions('1.0.0-alpha', '1.0.0-beta'), -1)
  assert.equal(compareVersions('1.0.0-alpha', '1.0.0-alpha.1'), -1)
})

test('parseVersion rejects malformed versions', () => {
  for (const bad of ['1.2', 'v1.2.3', '1.2.3.4', '01.2.3', '1.2.3-', 'a.b.c', '']) {
    assert.throws(() => parseVersion(bad), TypeError, bad)
  }
})

test('caret, tilde and hyphen ranges', () => {
  assert.equal(satisfies('1.4.0', '^1.2.3'), true)
  assert.equal(satisfies('2.0.0', '^1.2.3'), false)
  assert.equal(satisfies('1.2.9', '~1.2.3'), true)
  assert.equal(satisfies('1.3.0', '~1.2.3'), false)
  assert.equal(satisfies('2.3.4', '1.2.3 - 2.3.4'), true)
  assert.equal(satisfies('2.3.5', '1.2.3 - 2.3.4'), false)
})

test('alternatives and comparators', () => {
  assert.equal(satisfies('3.1.0', '^1.0.0 || >=3.0.0'), true)
  assert.equal(satisfies('2.5.0', '^1.0.0 || >=3.0.0'), false)
  assert.equal(satisfies('1.5.0', '>=1.2.0 <2.0.0'), true)
})

test('maxSatisfying picks the highest match', () => {
  assert.equal(maxSatisfying(['1.2.3', '1.10.0', '1.3.0', '2.0.0'], '^1.2.0'), '1.10.0')
  assert.equal(maxSatisfying(['0.1.0'], '^1.0.0'), null)
})
