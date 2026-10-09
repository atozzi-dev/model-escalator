import { expect, test } from 'claude-code/testing'
import { DEFAULT_CONFIG, parseConfig } from '../hooks/config'

test('no options gives the defaults', async () => {
  expect(parseConfig(undefined)).toEqual(DEFAULT_CONFIG)
  expect(parseConfig({})).toEqual(DEFAULT_CONFIG)
  expect(DEFAULT_CONFIG.threshold).toEqual({ haiku: 3, sonnet: 4, opus: 6 })
  expect(DEFAULT_CONFIG.grace).toBe(4)
  expect(DEFAULT_CONFIG.senior).toBe('opus')
  expect(DEFAULT_CONFIG.prudentTokenRatio).toBe(0.65)
  expect(DEFAULT_CONFIG.levels).toEqual(['nudge', 'consult', 'swap', 'human'])
})

test('valid overrides are applied', async () => {
  const c = parseConfig({ thresholdHaiku: 2, thresholdSonnet: '5', thresholdOpus: 9, graceSteps: 1, seniorModel: ' sonnet ',
    levels: 'swap, nudge', prudentTokenRatio: 0.5 })
  expect(c.threshold).toEqual({ haiku: 2, sonnet: 5, opus: 9 })
  expect(c.grace).toBe(1)
  expect(c.senior).toBe('sonnet')
  expect(c.levels).toEqual(['nudge', 'swap'])
  expect(c.prudentTokenRatio).toBe(0.5)
})

test('invalid values fall back to the defaults', async () => {
  const c = parseConfig({ thresholdHaiku: -1, thresholdSonnet: 'abc', thresholdOpus: 0, graceSteps: -2, seniorModel: '  ',
    levels: 'nudge,bogus', prudentTokenRatio: 3, prices: '{not json' })
  expect(c).toEqual(DEFAULT_CONFIG)
  expect(parseConfig({ levels: ',' }).levels).toEqual(DEFAULT_CONFIG.levels)
  expect(parseConfig({ prudentTokenRatio: 0 }).prudentTokenRatio).toBe(0.65)
  expect(parseConfig({ prices: '[1]' })).toEqual(DEFAULT_CONFIG)
})

test('prices override only the rates they name', async () => {
  const c = parseConfig({ prices: '{"sonnet":{"input":3,"output":"x"},"haiku":{"longContext":{"threshold":50000}},"opus":5}' })
  expect(c.prices.sonnet.input).toBe(3)
  expect(c.prices.sonnet.output).toBe(10)
  expect(c.prices.sonnet.cacheRead).toBe(0.2)
  expect(c.prices.haiku.longContext?.threshold).toBe(50000)
  expect(c.prices.haiku.longContext?.input).toBe(0.5)
  expect(c.prices.opus).toEqual(DEFAULT_CONFIG.prices.opus)
})
