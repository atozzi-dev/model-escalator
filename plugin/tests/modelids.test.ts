import { expect, mock, test } from 'claude-code/testing'
import { resetState } from '../hooks/register'
import { rememberModel, resolveModelId } from '../hooks/detector'
import { DEFAULT_CONFIG, parseConfig } from '../hooks/config'

type Drainable = { result: Promise<unknown> } & AsyncIterable<unknown>
const drain = async (st: Drainable) => { for await (const _ of st) { /* chunks */ } return st.result }

const BEDROCK_SONNET = 'us.anthropic.claude-sonnet-5-5-v1:0'
const BEDROCK_OPUS = 'us.anthropic.claude-opus-5-5-v1:0'

test('provider-shaped ids are remembered for their tier', async () => {
  expect(rememberModel({}, BEDROCK_SONNET)).toEqual({ sonnet: BEDROCK_SONNET })
  expect(rememberModel({}, 'anthropic.claude-haiku-5-5-v1:0')).toEqual({ haiku: 'anthropic.claude-haiku-5-5-v1:0' })
  expect(rememberModel({}, 'claude-opus-5-5@20261001')).toEqual({ opus: 'claude-opus-5-5@20261001' })
  expect(rememberModel({}, 'claude-sonnet-5-5[1m]')).toEqual({ sonnet: 'claude-sonnet-5-5[1m]' })
  expect(rememberModel({}, 'eu.anthropic.claude-3-haiku-20240307-v1:0')).toEqual({ haiku: 'eu.anthropic.claude-3-haiku-20240307-v1:0' })
})

test('ids without claude- or of other families are still ignored', async () => {
  for (const m of ['us.anthropic.claude-fable-5-5-v1:0', 'claude-mythos-1', 'anthropic.claude-fable-opus-x', 'gpt-sonnet', 'sonnet', 'claude-5-5', 'opus-claude-1']) {
    expect(rememberModel({}, m)).toEqual({})
  }
})

test('explicit ids beat observed ids, which beat the defaults', async () => {
  const seen = rememberModel({}, BEDROCK_SONNET)
  expect(resolveModelId(seen, 'sonnet', DEFAULT_CONFIG.modelIds, { sonnet: 'custom-sonnet' })).toBe('custom-sonnet')
  expect(resolveModelId(seen, 'sonnet', DEFAULT_CONFIG.modelIds, {})).toBe(BEDROCK_SONNET)
  expect(resolveModelId({}, 'sonnet', DEFAULT_CONFIG.modelIds, { opus: 'x' })).toBe('claude-sonnet-5-5')
  expect(resolveModelId({}, 'opus', DEFAULT_CONFIG.modelIds, { opus: 'x' })).toBe('x')
})

test('an id of the lead\'s own provider shape is not replaced by one of another shape', async () => {
  let seen = rememberModel({}, BEDROCK_OPUS, true)
  seen = rememberModel(seen, BEDROCK_SONNET)
  seen = rememberModel(seen, 'claude-sonnet-5-5')
  expect(resolveModelId(seen, 'sonnet')).toBe(BEDROCK_SONNET)
  // With no id of the lead's shape yet, any id is taken; the lead's shape wins once it shows up.
  let late = rememberModel({}, BEDROCK_OPUS, true)
  late = rememberModel(late, 'claude-sonnet-5-5')
  expect(resolveModelId(late, 'sonnet')).toBe('claude-sonnet-5-5')
  late = rememberModel(late, BEDROCK_SONNET)
  expect(resolveModelId(late, 'sonnet')).toBe(BEDROCK_SONNET)
})

test('modelIds option: valid entries kept, everything else ignored', async () => {
  expect(parseConfig({ modelIds: '{"sonnet":" s ","opus":"o"}' }).modelOverrides).toEqual({ sonnet: 's', opus: 'o' })
  expect(parseConfig({ modelIds: '{"sonnet":3,"opus":"","fable":"x","haiku":"h"}' }).modelOverrides).toEqual({ haiku: 'h' })
  for (const bad of ['{nope', '[1]', '"x"', 'null', '', 5, undefined]) {
    expect(parseConfig({ modelIds: bad }).modelOverrides).toEqual({})
  }
  expect(parseConfig({ modelIds: '{nope' })).toEqual(DEFAULT_CONFIG)
  expect(parseConfig({}).modelIds).toEqual(DEFAULT_CONFIG.modelIds)
})

type Harness = { stepModels: string[]; bad?: string }

function wire(on: any): Harness {
  resetState()
  mock.env(on, {})
  mock.store(on)
  on('session.start', () => ({ cwd: '/work' }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  const h: Harness = { stepModels: [] }
  on('agent.spawn', (_$: unknown, e: any) => ({ model: e.model ?? 'haiku', agentId: 'a1' }))
  on('tool.call', () => ({ isError: true, result: 'Error: boom', text: 'Error: boom' }) as never)
  on('model.complete', (_$: unknown, e: any) => ({ value: e.maxTokens === 1
    ? { isAnswered: false, reason: 'api-error', status: 404, error: 'model_not_found', usage: { input_tokens: 0, output_tokens: 0 } }
    : { isAnswered: true, text: 'advice', usage: { input_tokens: 10, output_tokens: 5 } } }) as never)
  on('turn.complete', () => ({ text: 'done' }) as never)
  on('turn.step', async function* (_$: unknown, e: any) {
    h.stepModels.push(e.model)
    if (h.bad && e.model === h.bad) return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: null, usage: null } as never
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn',
      usage: { model: e.model, input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } as never
  })
  for (const k of ['ui.log', 'ui.toast', 'ui.status'] as const) on(k, () => ({ value: undefined }) as never)
  return h
}

async function stuck($: any, calls: number): Promise<void> {
  for (let i = 0; i < calls; i++) await $.tool.call({ tool: 'Bash', command: 'npm test', agentId: 'a1' } as never)
}

const step = ($: any, model: string, agentId?: string) =>
  drain($.turn.step({ turnId: 't', index: 0, model, messageCount: 3, agentId } as never) as never)

test('a swap under a Bedrock lead targets the Bedrock-shaped sonnet id', async ($, on) => {
  const h = wire(on)
  await $.session.start({ cwd: '/work' } as never)
  await step($, BEDROCK_OPUS)
  await step($, BEDROCK_SONNET)
  await $.agent.spawn({ prompt: 'p', description: 'fix db test', subagentType: 'general-purpose', model: 'haiku' } as never)
  await step($, 'claude-sonnet-5-5', 'a1')
  await stuck($, 12)
  await step($, 'haiku', 'a1')
  expect(h.stepModels.at(-1)).toBe(BEDROCK_SONNET)
})

test('the modelIds option decides the swap target over observed ids', { options: { modelIds: '{"sonnet":"gw-sonnet"}' } }, async ($, on) => {
  const h = wire(on)
  await $.session.start({ cwd: '/work' } as never)
  await step($, BEDROCK_SONNET)
  await $.agent.spawn({ prompt: 'p', description: 'fix db test', subagentType: 'general-purpose', model: 'haiku' } as never)
  await stuck($, 12)
  await step($, 'haiku', 'a1')
  expect(h.stepModels.at(-1)).toBe('gw-sonnet')
})

test('a bogus explicit id falls back to the previous working model', { options: { modelIds: '{"sonnet":"bogus-sonnet"}' } }, async ($, on) => {
  const h = wire(on)
  h.bad = 'bogus-sonnet'
  await $.session.start({ cwd: '/work' } as never)
  await $.agent.spawn({ prompt: 'p', description: 'fix db test', subagentType: 'general-purpose', model: 'haiku' } as never)
  await stuck($, 12)
  await step($, 'haiku', 'a1')
  expect(h.stepModels).toEqual(['bogus-sonnet', 'haiku'])
  await step($, 'haiku', 'a1')
  expect(h.stepModels.at(-1)).toBe('haiku')
})
