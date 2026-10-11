import { expect, test } from 'claude-code/testing'
import {
  cacheGet, cachePut, cacheKey, classifierInput, combineCategory, emptyCache, LABELS, LABEL_DESCRIPTIONS,
  MAX_INPUT_CHARS, parseCache,
} from '../hooks/classify'
import { categorize } from '../hooks/learning'

test('every keyword category of today is a label and every label has a description', async () => {
  for (const l of ['tests', 'bugfix', 'refactor', 'docs', 'data', 'ui', 'explore', 'other']) expect(LABELS.includes(l)).toBe(true)
  for (const l of LABELS) expect((LABEL_DESCRIPTIONS[l] ?? '').length > 5).toBe(true)
  expect(Object.keys(LABEL_DESCRIPTIONS).length).toBe(LABELS.length)
})

test('classifier input redacts secrets', async () => {
  const out = classifierInput('general-purpose', 'call the API', 'use api_key=abcd1234efgh5678 and ghp_abcdefghijklmnopqrstuvwxyz0123')
  expect(out.includes('abcd1234efgh5678')).toBe(false)
  expect(out.includes('ghp_abcdefghijkl')).toBe(false)
  expect(out.includes('[redacted]')).toBe(true)
})

test('classifier input is capped', async () => {
  const out = classifierInput('general-purpose', 'd'.repeat(5000), 'word '.repeat(5000))
  expect(out.length <= MAX_INPUT_CHARS).toBe(true)
  expect(out.includes('general-purpose')).toBe(true)
})

test('classifier input drops code blocks, closed or not', async () => {
  const closed = classifierInput('Explore', 'look around', 'Read this:\n```ts\nconst SECRET_BODY = 1\n```\nthen report')
  expect(closed.includes('SECRET_BODY')).toBe(false)
  expect(closed.includes('then report')).toBe(true)
  const open = classifierInput('Explore', 'look around', 'Start\n```\nconst CUT_BODY = 1\nmore code')
  expect(open.includes('CUT_BODY')).toBe(false)
  expect(open.includes('Start')).toBe(true)
})

test('classifier input never throws on odd values', async () => {
  const bad = undefined as unknown as string
  expect(typeof classifierInput(bad, bad, bad)).toBe('string')
  expect(typeof cacheKey(bad, bad, bad)).toBe('string')
})

test('near-identical spawns share a key, different ones do not', async () => {
  const a = cacheKey('general-purpose', 'Fix the login bug', 'Please fix the login bug in auth.ts. Be careful.')
  const b = cacheKey('general-purpose', '  fix the LOGIN bug!  ', 'please   fix the login bug in auth.ts, be careful')
  expect(a).toBe(b)
  expect(cacheKey('general-purpose', 'Write the docs', 'Update the README')).not.toBe(a)
  expect(cacheKey('Explore', 'Fix the login bug', 'Please fix the login bug in auth.ts. Be careful.')).not.toBe(a)
})

test('a long prompt only contributes its first words to the key', async () => {
  const head = 'one two three four five six seven eight nine ten eleven twelve '
  expect(cacheKey('t', 'd', head + 'alpha')).toBe(cacheKey('t', 'd', head + 'beta'))
})

test('cache stores and finds a label', async () => {
  const c = cachePut(emptyCache(), 'k1', 'tests', 4)
  expect(cacheGet(c, 'k1').label).toBe('tests')
  expect(cacheGet(c, 'zzz').label).toBeUndefined()
})

test('cache evicts the least recently used entry and stays bounded', async () => {
  let c = emptyCache()
  c = cachePut(c, 'a', 'docs', 3)
  c = cachePut(c, 'b', 'ui', 3)
  c = cachePut(c, 'c', 'data', 3)
  c = cacheGet(c, 'a').cache // a is now the freshest
  c = cachePut(c, 'd', 'tests', 3)
  expect(c.entries.length).toBe(3)
  expect(cacheGet(c, 'b').label).toBeUndefined() // b was the oldest
  expect(cacheGet(c, 'a').label).toBe('docs')
  expect(cacheGet(c, 'd').label).toBe('tests')
})

test('putting an existing key replaces it and does not grow the cache', async () => {
  let c = cachePut(cachePut(emptyCache(), 'a', 'docs', 3), 'b', 'ui', 3)
  c = cachePut(c, 'a', 'tests', 3)
  expect(c.entries.length).toBe(2)
  expect(cacheGet(c, 'a').label).toBe('tests')
})

test('cache survives a JSON round trip and rejects garbage', async () => {
  const c = cachePut(cachePut(emptyCache(), 'a', 'docs', 5), 'b', 'ui', 5)
  const back = parseCache(JSON.parse(JSON.stringify(c)))
  expect(back).toEqual(c)
  expect(parseCache(undefined)).toEqual(emptyCache())
  expect(parseCache({ entries: 'no' })).toEqual(emptyCache())
  expect(parseCache({ entries: [['a', 'docs'], ['b'], [1, 2], ['c', 'notalabel']] }).entries).toEqual([['a', 'docs']])
})

test('combine uses a valid label', async () => {
  expect(combineCategory('Explore', 'bugfix', 'Explore:other')).toBe('Explore:bugfix')
  expect(combineCategory('Explore', ' Tests ', 'Explore:other')).toBe('Explore:tests')
})

test('combine falls back to the keyword category when the label is missing or invalid', async () => {
  for (const [type, desc] of [['general-purpose', 'fix the crash'], ['Explore', 'write a poem'], ['x', 'update the readme']] as const) {
    const fb = categorize(type, desc)
    expect(combineCategory(type, undefined, fb)).toBe(fb)
    expect(combineCategory(type, 'made-up', fb)).toBe(fb)
    expect(combineCategory(type, '', fb)).toBe(fb)
    expect(combineCategory(type, 42 as unknown as string, fb)).toBe(fb)
  }
})
