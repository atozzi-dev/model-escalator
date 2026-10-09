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
