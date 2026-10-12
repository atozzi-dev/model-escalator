import { expect, test } from 'claude-code/testing'
import { DEFAULT_CONFIG, parseConfig, splitCommand } from '../hooks/config'

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

test('verify options: off by default, parsed and bounded when set', async () => {
  expect(DEFAULT_CONFIG.verifyCommand).toBe('')
  expect(DEFAULT_CONFIG.verifyTimeoutSeconds).toBe(120)
  const c = parseConfig({ verifyCommand: '  npm test  ', verifyTimeoutSeconds: '30' })
  expect(c.verifyCommand).toBe('npm test')
  expect(c.verifyTimeoutSeconds).toBe(30)
  expect(parseConfig({ verifyCommand: 5, verifyTimeoutSeconds: -1 }).verifyCommand).toBe('')
  expect(parseConfig({ verifyTimeoutSeconds: 0 }).verifyTimeoutSeconds).toBe(120)
  expect(parseConfig({ verifyTimeoutSeconds: 99999 }).verifyTimeoutSeconds).toBe(600)
})

test('splitCommand splits on spaces and honors quotes, never a shell', async () => {
  expect(splitCommand('npm test')).toEqual(['npm', 'test'])
  expect(splitCommand(`node -e "a b" 'c d'  e`)).toEqual(['node', '-e', 'a b', 'c d', 'e'])
  expect(splitCommand('   ')).toEqual([])
  expect(splitCommand('a "b')).toEqual([])   // unbalanced quote: refuse rather than guess
})

test('learningHalfLifeDays defaults to 30, 0 disables, invalid falls back', async () => {
  expect(DEFAULT_CONFIG.learningHalfLifeDays).toBe(30)
  expect(parseConfig({ learningHalfLifeDays: '7' }).learningHalfLifeDays).toBe(7)
  expect(parseConfig({ learningHalfLifeDays: 0 }).learningHalfLifeDays).toBe(0)
  expect(parseConfig({ learningHalfLifeDays: -3 }).learningHalfLifeDays).toBe(30)
  expect(parseConfig({ learningHalfLifeDays: 'x' }).learningHalfLifeDays).toBe(30)
})

test('a fallback configuration fills the options that are absent or invalid', async () => {
  const base = parseConfig({ graceSteps: 7, verifyCommand: 'npm test', reviewModel: 'sonnet', modelIds: '{"opus":"x-opus"}', effortStep: true })
  const c = parseConfig({ thresholdHaiku: 5, graceSteps: 'nope', effortStep: false }, base)
  expect(c.threshold.haiku).toBe(5)
  expect(c.grace).toBe(7)
  expect(c.verifyCommand).toBe('npm test')
  expect(c.reviewModel).toBe('sonnet')
  expect(c.modelOverrides).toEqual({ opus: 'x-opus' })
  // effortStep off removes the effort level the base had.
  expect(c.levels).toEqual(['nudge', 'consult', 'swap', 'human'])
  expect(parseConfig({}, base)).toEqual(base)
})

test('recordSessions is off by default, a whole count of sessions, at most 50', async () => {
  expect(DEFAULT_CONFIG.recordSessions).toBe(0)
  expect(parseConfig({ recordSessions: 10 }).recordSessions).toBe(10)
  expect(parseConfig({ recordSessions: '7.9' }).recordSessions).toBe(7)
  expect(parseConfig({ recordSessions: 500 }).recordSessions).toBe(50)
  expect(parseConfig({ recordSessions: -1 }).recordSessions).toBe(0)
  expect(parseConfig({ recordSessions: 'many' }).recordSessions).toBe(0)
})
