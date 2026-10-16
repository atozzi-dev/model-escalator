import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseRange } from '../../src/range.mjs'
import { maxSatisfying, satisfies } from '../../src/satisfies.mjs'
import { compareVersions, parseVersion } from '../../src/version.mjs'

test('parseVersion: fields, prerelease identifiers and build metadata', () => {
  assert.deepEqual(parseVersion('1.2.3'), { major: 1, minor: 2, patch: 3, prerelease: [] })
  assert.deepEqual(parseVersion('1.2.3-alpha.1.x-y+build.007'), { major: 1, minor: 2, patch: 3, prerelease: ['alpha', 1, 'x-y'] })
  assert.deepEqual(parseVersion('0.0.0-0'), { major: 0, minor: 0, patch: 0, prerelease: [0] })
  assert.deepEqual(parseVersion('1.0.0-0a.01a'), { major: 1, minor: 0, patch: 0, prerelease: ['0a', '01a'] })
  assert.deepEqual(parseVersion('10.20.30+1'), { major: 10, minor: 20, patch: 30, prerelease: [] })
})

test('parseVersion: everything else is a TypeError', () => {
  const bad = ['1.2', 'v1.2.3', '1.2.3.4', '01.2.3', '1.02.3', '1.2.03', '1.2.3-', '1.2.3-a..b', '1.2.3-01', '1.2.3-a.01', '1.2.3+', '1.2.3+a..b', '1.2.3-a_b', ' 1.2.3', '1.2.3 ', '-1.2.3', '1.2.3-+x', 'x.y.z', '']
  for (const text of bad) assert.throws(() => parseVersion(text), TypeError, JSON.stringify(text))
  for (const value of [null, undefined, 123, {}]) assert.throws(() => parseVersion(value), TypeError)
})

test('compareVersions: the semver.org precedence chain', () => {
  const chain = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0', '1.0.1', '1.1.0', '2.0.0', '10.0.0']
  for (let i = 0; i < chain.length; i++) {
    for (let j = 0; j < chain.length; j++) {
      assert.equal(compareVersions(chain[i], chain[j]), Math.sign(i - j), `${chain[i]} vs ${chain[j]}`)
    }
  }
})

test('compareVersions: numeric identifiers are numbers, build metadata is ignored, objects are accepted', () => {
  assert.equal(compareVersions('1.0.0-2', '1.0.0-10'), -1)
  assert.equal(compareVersions('1.0.0-9', '1.0.0-a'), -1)
  assert.equal(compareVersions('1.0.0-B', '1.0.0-a'), -1)
  assert.equal(compareVersions('1.0.0+a', '1.0.0+b'), 0)
  assert.equal(compareVersions('1.0.0-x+1', '1.0.0-x+2'), 0)
  assert.equal(compareVersions(parseVersion('2.0.0'), '1.9.9'), 1)
  assert.equal(compareVersions('1.0.0', parseVersion('1.0.0-rc.1')), 1)
  assert.throws(() => compareVersions('1.0', '1.0.0'), TypeError)
})

const CASES = [
  // exact versions and partials
  ['1.2.3', '1.2.3', true], ['1.2.4', '1.2.3', false], ['1.2.3', '=1.2.3', true], ['1.2.3', '= 1.2.3', true],
  ['1.2.9', '1.2', true], ['1.3.0', '1.2', false], ['1.2.9', '1.2.x', true], ['1.2.9', '1.2.*', true],
  ['1.9.9', '1', true], ['2.0.0', '1', false], ['1.9.9', '1.x', true], ['1.9.9', '1.X.X', true], ['0.0.1', '*', true],
  ['0.0.1', 'x', true], ['5.5.5', '', true], ['5.5.5', '   ', true],
  // caret
  ['1.2.3', '^1.2.3', true], ['1.9.9', '^1.2.3', true], ['1.2.2', '^1.2.3', false], ['2.0.0', '^1.2.3', false],
  ['0.2.9', '^0.2.3', true], ['0.3.0', '^0.2.3', false], ['0.2.2', '^0.2.3', false],
  ['0.0.3', '^0.0.3', true], ['0.0.4', '^0.0.3', false], ['0.0.2', '^0.0.3', false],
  ['1.9.0', '^1.2', true], ['2.0.0', '^1.2', false], ['1.1.9', '^1.2', false],
  ['0.0.9', '^0.0', true], ['0.1.0', '^0.0', false], ['0.9.9', '^0', true], ['1.0.0', '^0', false],
  ['1.9.9', '^1.2.x', true], ['2.0.0', '^1.2.x', false], ['0.0.9', '^0.0.x', true], ['0.1.0', '^0.0.x', false],
  ['1.5.0', '^1', true], ['1.5.0', '^1.x', true], ['0.0.0', '^0.0.0', true], ['0.0.1', '^0.0.0', false], ['9.9.9', '^*', true],
  ['1.5.0', '^ 1.2.3', true],
  // tilde
  ['1.2.3', '~1.2.3', true], ['1.2.99', '~1.2.3', true], ['1.3.0', '~1.2.3', false], ['1.2.2', '~1.2.3', false],
  ['1.2.9', '~1.2', true], ['1.3.0', '~1.2', false], ['1.9.9', '~1', true], ['2.0.0', '~1', false],
  ['0.2.9', '~0.2.3', true], ['0.3.0', '~0.2.3', false], ['0.9.9', '~0', true], ['1.0.0', '~0', false], ['1.2.5', '~1.2.x', true],
  // comparisons with full and partial versions
  ['1.2.4', '>1.2.3', true], ['1.2.3', '>1.2.3', false], ['1.3.0', '>1.2', true], ['1.2.9', '>1.2', false],
  ['2.0.0', '>1', true], ['1.9.9', '>1', false], ['1.2.0', '>=1.2', true], ['1.1.9', '>=1.2', false],
  ['1.1.9', '<1.2', true], ['1.2.0', '<1.2', false], ['1.2.9', '<=1.2', true], ['1.3.0', '<=1.2', false],
  ['1.9.9', '<=1', true], ['2.0.0', '<=1', false], ['0.9.9', '<1', true], ['1.0.0', '<1', false],
  ['1.2.3', '<=1.2.3', true], ['1.2.4', '<=1.2.3', false], ['1.2.3', '>=1.2.3', true], ['1.2.2', '<1.2.3', true],
  ['1.5.0', '>= 1.2.0', true], ['1.5.0', '>=1.2.0   <  2.0.0', true], ['2.0.0', '>=1.2.0 <2.0.0', false], ['1.1.0', '>=1.2.0 <2.0.0', false],
  ['1.5.0', '>=1.2.0 <1.4.0', false], ['9.9.9', '>=*', true], ['9.9.9', '<=*', true], ['0.0.0', '>*', false],
  // hyphen ranges
  ['1.2.3', '1.2.3 - 2.3.4', true], ['2.3.4', '1.2.3 - 2.3.4', true], ['2.3.5', '1.2.3 - 2.3.4', false], ['1.2.2', '1.2.3 - 2.3.4', false],
  ['1.2.0', '1.2 - 2.3.4', true], ['1.1.9', '1.2 - 2.3.4', false], ['2.3.9', '1.2.3 - 2.3', true], ['2.4.0', '1.2.3 - 2.3', false],
  ['2.9.9', '1.2.3 - 2', true], ['3.0.0', '1.2.3 - 2', false], ['0.5.0', '1 - 2', false], ['1.0.0', '1 - 2', true], ['2.9.9', '1 - 2', true],
  ['99.0.0', '1.2.3 - *', true], ['1.2.2', '1.2.3 - *', false], ['0.0.1', '* - 2.0.0', true],
  // alternatives
  ['3.1.0', '^1.0.0 || >=3.0.0', true], ['2.5.0', '^1.0.0 || >=3.0.0', false], ['1.5.0', '^1.0.0||>=3.0.0', true],
  ['0.5.0', '1.2.3 || 0.5.x', true], ['4.0.0', '<1.0.0 || ', true], ['1.5.0', ' || ^1.0.0', true], ['2.0.0', '^1.0.0 || ^1.5.0', false],
  // prereleases
  ['1.2.3-beta.2', '>=1.2.3-beta.1', true], ['1.2.3-beta.0', '>=1.2.3-beta.1', false], ['1.2.3', '>=1.2.3-beta.1', true],
  ['1.2.3-beta.2', '^1.2.3-beta.1', true], ['1.2.4-beta.1', '^1.2.3-beta.1', false], ['1.3.0', '^1.2.3-beta.1', true],
  ['1.2.4-beta', '^1.2.3', false], ['1.3.0-beta', '>=1.2.3 <2.0.0', false], ['2.0.0-rc.1', '<2.0.0', false],
  ['2.0.0-rc.1', '*', false], ['2.0.0-rc.1', '', false], ['2.0.0-rc.1', '>=1.0.0', false], ['1.2.3-beta', '1.2.3', false],
  ['1.2.3-beta', '=1.2.3-beta', true], ['1.2.3-beta', '~1.2.3-alpha', true], ['1.2.4-alpha', '~1.2.3-alpha', false],
  ['2.0.0-rc.2', '^1.2.3 || >=2.0.0-rc.1', true], ['2.0.0-rc.0', '^1.2.3 || >=2.0.0-rc.1', false], ['1.3.0-rc.2', '^1.2.3 || >=2.0.0-rc.1', false],
  ['1.0.0-alpha.2', '1.0.0-alpha.1 - 1.0.0-beta', true], ['1.0.0-gamma', '1.0.0-alpha.1 - 1.0.0-beta', false],
  // build metadata
  ['1.2.3+meta', '1.2.3', true], ['1.2.3+meta', '^1.2.0', true],
  // invalid versions never satisfy
  ['1.2', '*', false], ['v1.2.3', '^1.0.0', false], ['', '*', false], ['abc', '', false],
]

test('satisfies: the range table', () => {
  for (const [version, range, want] of CASES) {
    assert.equal(satisfies(version, range), want, `${version} in "${range}" should be ${want}`)
  }
})

test('satisfies: malformed ranges throw a TypeError, whatever the version', () => {
  const bad = ['1.x.3', 'x.2', '1.2.3.4', 'abc', '>=', '^', '~', '1.2.3 -', '- 1.2.3', '1.2.3 -2.0.0', '^1.2.x-beta', '1.2-beta', '>=1.2.3 foo', '1.2.3 - 2.3.4 - 3', '=>1.2.3', '1.2.3 ||| 2', '1.2.3-', 'v1.2.3', '>>1.0.0', '1.2.3++']
  for (const range of bad) {
    assert.throws(() => satisfies('1.2.3', range), TypeError, JSON.stringify(range))
    assert.throws(() => satisfies('nope', range), TypeError, JSON.stringify(range))
  }
  for (const value of [null, undefined, 5]) assert.throws(() => satisfies('1.2.3', value), TypeError)
})

test('parseRange: comparator sets for the interesting cases', () => {
  const show = (text) => parseRange(text).map((set) => set.map(({ op, version: v }) => `${op}${v.major}.${v.minor}.${v.patch}${v.prerelease.length ? '-' + v.prerelease.join('.') : ''}`).join(' '))
  assert.deepEqual(show('^1.2.3'), ['>=1.2.3 <2.0.0'])
  assert.deepEqual(show('^0.0.3'), ['>=0.0.3 <0.0.4'])
  assert.deepEqual(show('^0.2.3'), ['>=0.2.3 <0.3.0'])
  assert.deepEqual(show('^0'), ['>=0.0.0 <1.0.0'])
  assert.deepEqual(show('^1.2.3-beta.2'), ['>=1.2.3-beta.2 <2.0.0'])
  assert.deepEqual(show('~1.2'), ['>=1.2.0 <1.3.0'])
  assert.deepEqual(show('~1'), ['>=1.0.0 <2.0.0'])
  assert.deepEqual(show('1.2.x'), ['>=1.2.0 <1.3.0'])
  assert.deepEqual(show('1.2.3'), ['=1.2.3'])
  assert.deepEqual(show('>1.2'), ['>=1.3.0'])
  assert.deepEqual(show('<=1'), ['<2.0.0'])
  assert.deepEqual(show('1.2 - 2.3.4'), ['>=1.2.0 <=2.3.4'])
  assert.deepEqual(show('1.2.3 - 2.3'), ['>=1.2.3 <2.4.0'])
  assert.deepEqual(show('*'), ['>=0.0.0'])
  assert.deepEqual(show(''), ['>=0.0.0'])
  assert.deepEqual(show('1.x || >= 3.1.0 < 4'), ['>=1.0.0 <2.0.0', '>=3.1.0 <4.0.0'])
})

test('maxSatisfying: highest match, prerelease rule, skipped garbage, first of equals', () => {
  const list = ['1.2.3', '1.10.0', '1.3.0', '2.0.0', '1.11.0-beta.1', 'nope', '1.9.0']
  assert.equal(maxSatisfying(list, '^1.2.0'), '1.10.0')
  assert.equal(maxSatisfying(list, '>=1.11.0-beta.0 <1.11.0'), '1.11.0-beta.1')
  assert.equal(maxSatisfying(list, '~1.3'), '1.3.0')
  assert.equal(maxSatisfying(list, '^3'), null)
  assert.equal(maxSatisfying([], '*'), null)
  assert.equal(maxSatisfying(['1.0.0+b', '1.0.0+a'], '1.x'), '1.0.0+b')
  assert.equal(maxSatisfying(['1.0.0', '1.0.0+a'], '1.x'), '1.0.0')
  assert.equal(maxSatisfying(['1.9.0', '1.10.0', '1.2.0'], '*'), '1.10.0')
  assert.equal(maxSatisfying(['2.0.0-rc.1', '1.0.0'], '*'), '1.0.0')
  assert.throws(() => maxSatisfying(['1.0.0'], '1.x.3'), TypeError)
})
