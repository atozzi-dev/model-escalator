import { expect, test } from 'claude-code/testing'
import { categorize, recommend, record, type Stats } from '../hooks/learning'

test('categorizes by agent type and task keywords', async () => {
  expect(categorize('general-purpose', 'Fix the login bug')).toBe('general-purpose:bugfix')
  expect(categorize('Explore', 'map the repo')).toBe('Explore:other')
})

test('keeps the requested tier without enough evidence', async () => {
  let st: Stats = {}
  for (let i = 0; i < 4; i++) st = record(st, 'c', 'haiku', true, 100)
  expect(recommend(st, 'c', 'haiku')).toBe('haiku')
})

test('raises the tier when the cheap one escalates too often', async () => {
  let st: Stats = {}
  for (let i = 0; i < 6; i++) st = record(st, 'c', 'haiku', i < 4, 100)
  expect(recommend(st, 'c', 'haiku')).toBe('sonnet')
  for (let i = 0; i < 6; i++) st = record(st, 'c', 'sonnet', i < 1, 100)
  expect(recommend(st, 'c', 'haiku')).toBe('sonnet')
})

test('a failed verification counts like an escalation for the recommendation', async () => {
  let st: Stats = {}
  for (let i = 0; i < 6; i++) st = record(st, 'c', 'haiku', false, 100, i < 4)
  expect(st['c']!.haiku!.failedVerify).toBe(4)
  expect(st['c']!.haiku!.escalated).toBe(0)
  expect(recommend(st, 'c', 'haiku')).toBe('sonnet')
})

test('a run both escalated and failing verification is one rejected run', async () => {
  const st = record({}, 'c', 'haiku', true, 0, true)
  expect(st['c']!.haiku!.notAccepted).toBe(1)
  expect(st['c']!.haiku!.escalated).toBe(1)
  expect(st['c']!.haiku!.failedVerify).toBe(1)
})

test('stats stored before verification existed stay readable', async () => {
  const old: Stats = { c: { haiku: { runs: 6, escalated: 4, tokens: 0 } } }
  expect(recommend(old, 'c', 'haiku')).toBe('sonnet')
  const next = record(old, 'c', 'haiku', false, 0, true)
  expect(next['c']!.haiku!.notAccepted).toBe(5)
  expect(next['c']!.haiku!.runs).toBe(7)
})
