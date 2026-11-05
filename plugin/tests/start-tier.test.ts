import { expect, mock, test } from 'claude-code/testing'
import { DEFAULT_CONFIG, describeConfig, parseConfig } from '../hooks/config'
import { AGENT_TYPES_LIMIT, type AgentTypes, AUTO_START, autoStartTier, categorize, categoryLabel, formatLoweredStarts, isEngineType, ownTierOf, parseAgentTypes, rememberAgentType, startChoice, storedOwnTier } from '../hooks/learning'
import { resetState } from '../hooks/register'
import { parseSnapshot } from '../hooks/state'

// ---------- pure ----------

test('config: startTier is auto by default, requested restores the old start, anything else falls back', () => {
  expect(DEFAULT_CONFIG.startTier).toBe('auto')
  expect(parseConfig({}).startTier).toBe('auto')
  expect(parseConfig({ startTier: 'requested' }).startTier).toBe('requested')
  expect(parseConfig({ startTier: ' Requested ' }).startTier).toBe('requested')
  for (const bad of ['', 'haiku', 1, null, true]) expect(parseConfig({ startTier: bad }).startTier).toBe('auto')
  expect(describeConfig(parseConfig({})).some((l) => l === 'startTier: auto')).toBe(true)
})

test('config: reviewRate defaults to 0.25', () => {
  expect(parseConfig({}).reviewRate).toBe(0.25)
  expect(parseConfig({ reviewRate: 0 }).reviewRate).toBe(0)
})

test('categoryLabel: the part after the last colon', () => {
  expect(categoryLabel('general-purpose:bugfix')).toBe('bugfix')
  expect(categoryLabel('superpowers:code-reviewer:review')).toBe('review')
  expect(categoryLabel('nolabel')).toBe('nolabel')
})

test('auto start per category: explore on haiku, code, docs, data and ui on sonnet, review and other as asked', () => {
  expect(autoStartTier('Explore:explore', 'opus')).toBe('haiku')
  for (const label of ['bugfix', 'feature', 'refactor', 'tests', 'docs', 'data', 'ui']) {
    expect(AUTO_START[label]).toBe('sonnet')
    expect(autoStartTier(`general-purpose:${label}`, 'opus')).toBe('sonnet')
  }
  for (const label of ['review', 'other', 'something-new']) expect(autoStartTier(`general-purpose:${label}`, 'opus')).toBe('opus')
})

test('auto start never goes above the asked tier', () => {
  expect(autoStartTier('general-purpose:bugfix', 'haiku')).toBe('haiku')
  expect(autoStartTier('general-purpose:bugfix', 'sonnet')).toBe('sonnet')
  expect(autoStartTier('general-purpose:explore', 'sonnet')).toBe('haiku')
  expect(autoStartTier('general-purpose:explore', 'haiku')).toBe('haiku')
})

test('auto start with the tier the agent type runs on by itself: lowered from that, never above it; unknown blocks sonnet', () => {
  // the definition picks haiku: a code task stays on haiku
  expect(autoStartTier('scout:bugfix', 'opus', 'haiku')).toBe('haiku')
  // the definition picks sonnet: explore still goes to haiku
  expect(autoStartTier('scout:explore', 'opus', 'sonnet')).toBe('haiku')
  // not known yet: haiku is never above anything, sonnet could be above a cheaper definition
  expect(autoStartTier('scout:explore', 'opus', null)).toBe('haiku')
  expect(autoStartTier('scout:bugfix', 'opus', null)).toBe('opus')
})

test('isEngineType: only a provider named engine is Claude Code itself', () => {
  expect(isEngineType({ provider: { plugin: 'engine', tier: 'core' } })).toBe(true)
  for (const provider of [undefined, null, 'engine', { plugin: 'acme-agents', tier: 'user' }, { tier: 'core' }]) expect(isEngineType({ provider })).toBe(false)
  expect(isEngineType({})).toBe(false)
})

test('startChoice: a model named in the call is a ceiling with startTier auto, kept with respectExplicitModel or requested', () => {
  const base = { parentTier: 'opus' as const, engine: true, startTier: 'auto' as const, respectExplicit: false }
  expect(startChoice({ ...base, category: 'general-purpose:bugfix', called: 'opus' })).toEqual({ asked: 'opus', floor: 'sonnet', learn: true, lowers: 'ceiling' })
  expect(startChoice({ ...base, category: 'general-purpose:bugfix', called: 'haiku' })).toEqual({ asked: 'haiku', floor: 'haiku', learn: true })
  expect(startChoice({ ...base, category: 'acme:explore', called: 'sonnet', engine: false })).toEqual({ asked: 'sonnet', floor: 'haiku', learn: true, lowers: 'ceiling' })
  expect(startChoice({ ...base, category: 'general-purpose:bugfix', called: 'opus', respectExplicit: true })).toEqual({ asked: 'opus', floor: 'opus', learn: false })
  expect(startChoice({ ...base, category: 'general-purpose:bugfix', called: 'opus', startTier: 'requested' })).toEqual({ asked: 'opus', floor: 'opus', learn: true })
})

test('startChoice: no model in the call, an engine type starts on its category tier, a definition decides for any other', () => {
  const base = { parentTier: 'opus' as const, startTier: 'auto' as const, respectExplicit: false }
  expect(startChoice({ ...base, category: 'general-purpose:bugfix', engine: true, own: 'opus' })).toEqual({ asked: 'opus', floor: 'sonnet', learn: true, lowers: 'auto' })
  expect(startChoice({ ...base, category: 'general-purpose:review', engine: true, own: 'opus' })).toEqual({ asked: 'opus', floor: 'opus', learn: true })
  // an engine type whose own tier is not known yet: only haiku is a safe lower start
  expect(startChoice({ ...base, category: 'scout:bugfix', engine: true })).toEqual({ asked: 'opus', floor: 'opus', learn: true })
  expect(startChoice({ ...base, category: 'scout:bugfix', engine: true, own: 'haiku' })).toEqual({ asked: 'haiku', floor: 'haiku', learn: true })
  expect(startChoice({ ...base, category: 'general-purpose:bugfix', engine: true, own: 'opus', startTier: 'requested' })).toEqual({ asked: 'opus', floor: 'opus', learn: true })
  // a definition: never lowered, learning moves up from its tier once known, nothing at all while it is not
  expect(startChoice({ ...base, category: 'acme:explore', engine: false, own: 'opus' })).toEqual({ asked: 'opus', floor: 'opus', learn: true })
  expect(startChoice({ ...base, category: 'acme:explore', engine: false, own: 'sonnet', startTier: 'requested' })).toEqual({ asked: 'sonnet', floor: 'sonnet', learn: true })
  expect(startChoice({ ...base, category: 'acme:explore', engine: false })).toEqual({ asked: 'opus', floor: 'opus', learn: false })
})

test('ownTierOf: the parent tier for an inheriting type, the latest tier seen for other types, else unknown', () => {
  const seen = [
    { category: 'scout:explore', ownTier: 'sonnet' as const },
    { category: 'plug:scout:bugfix', ownTier: 'opus' as const },
    { category: 'scout:bugfix' },
    { category: 'scout:docs', ownTier: 'haiku' as const },
  ]
  expect(ownTierOf('general-purpose', 'opus', seen)).toBe('opus')
  expect(ownTierOf('Explore', 'opus', seen)).toBe('opus')
  expect(ownTierOf('Plan', 'sonnet', seen)).toBe('sonnet')
  // a definition that takes the name of a built-in is not known to inherit
  expect(ownTierOf('general-purpose', 'opus', seen, undefined, false)).toBeUndefined()
  expect(ownTierOf('scout', 'opus', seen)).toBe('haiku')
  expect(ownTierOf('plug:scout', 'opus', seen)).toBe('opus')
  expect(ownTierOf('other', 'opus', seen)).toBeUndefined()
})

test('ownTierOf: a tier remembered in the store is the fallback, and a tier seen in the session wins over it', () => {
  expect(ownTierOf('scout', 'opus', [], 'haiku')).toBe('haiku')
  expect(ownTierOf('scout', 'opus', [{ category: 'scout:bugfix', ownTier: 'sonnet' }], 'haiku')).toBe('sonnet')
  expect(ownTierOf('general-purpose', 'opus', [], 'haiku')).toBe('opus')
})

test('agent types in the store: parsed defensively, one tier and time per type', () => {
  expect(parseAgentTypes(undefined)).toEqual({})
  expect(parseAgentTypes('scout')).toEqual({})
  expect(parseAgentTypes([{ tier: 'haiku', seenAt: 1 }])).toEqual({})
  expect(parseAgentTypes({
    scout: { tier: 'haiku', seenAt: 5 },
    wrongTier: { tier: 'gpt', seenAt: 5 },
    notRecord: 'opus',
    badTime: { tier: 'opus', seenAt: 'x' },
    '': { tier: 'opus', seenAt: 1 },
  })).toEqual({ scout: { tier: 'haiku', seenAt: 5 } })
  expect(storedOwnTier({ scout: { tier: 'haiku', seenAt: 1 } }, 'scout')).toBe('haiku')
  expect(storedOwnTier({}, 'scout')).toBeUndefined()
})

test('agent types in the store: at most AGENT_TYPES_LIMIT types, the least recently seen go first', () => {
  expect(AGENT_TYPES_LIMIT).toBe(100)
  let m: AgentTypes = {}
  for (let i = 0; i < AGENT_TYPES_LIMIT + 5; i++) m = rememberAgentType(m, `type-${i}`, 'sonnet', i)
  expect(Object.keys(m).length).toBe(AGENT_TYPES_LIMIT)
  expect(m['type-0']).toBeUndefined()
  expect(m[`type-${AGENT_TYPES_LIMIT + 4}`]).toEqual({ tier: 'sonnet', seenAt: AGENT_TYPES_LIMIT + 4 })
  expect(rememberAgentType(m, 'type-10', 'opus', 9999)['type-10']).toEqual({ tier: 'opus', seenAt: 9999 })
})

test('snapshot: the start fields of an agent are kept when well formed and dropped otherwise', () => {
  const base = {
    agents: [], seenModels: {}, sessionTag: 'abc123', mode: 'active', baseline: 'opus', baselinePinned: false,
    ledger: { actual: 0, baselineHigh: 0, baselineLow: 0, agentSteps: 0, byTier: {}, consults: 0, consultCost: 0, interventions: {} },
  }
  const good = parseSnapshot({ ...base, agents: [{ id: 'a', lowered: 'opus', ownTier: 'haiku', qualityFailed: true }] })!.agents[0]!
  expect(good.lowered).toBe('opus')
  expect(good.ownTier).toBe('haiku')
  expect(good.qualityFailed).toBe(true)
  const bad = parseSnapshot({ ...base, agents: [{ id: 'a', lowered: 'gpt', ownTier: 3, qualityFailed: 'yes' }] })!.agents[0]!
  expect(bad.lowered).toBeUndefined()
  expect(bad.ownTier).toBeUndefined()
  expect(bad.qualityFailed).toBeUndefined()
})

test('formatLoweredStarts: runs started lower, escalated (swapped once or above the start) and failing a quality check', () => {
  expect(formatLoweredStarts([{ startTier: 'opus', tier: 'opus' }])).toBe('')
  expect(formatLoweredStarts([
    { lowered: 'opus', startTier: 'sonnet', tier: 'opus' },
    { lowered: 'opus', startTier: 'haiku', tier: 'haiku', escCounted: true, qualityFailed: true },
    { lowered: 'opus', startTier: 'sonnet', tier: 'sonnet' },
    { startTier: 'opus', tier: 'opus', qualityFailed: true },
  ])).toBe('Started lower by startTier: 3 runs (2 escalated, 1 failed a quality check)')
  expect(formatLoweredStarts([{ lowered: 'opus', startTier: 'sonnet', tier: 'sonnet' }])).toBe('Started lower by startTier: 1 run (0 escalated, 0 failed a quality check)')
})

// ---------- wiring ----------

const NOW = 1_000_000_000_000

type H = { spawned: (string | undefined)[]; logs: string[]; data: Record<string, unknown>; providers: unknown[] }

// The fake core resolves a spawn without a model to the agent definition's model (`defs`) or the parent's.
function wire(on: any, env: Record<string, string> = {}, defs: Record<string, string> = {}, stats: unknown = {}): H {
  resetState()
  mock.clock(on, { now: NOW })
  mock.env(on, env)
  const data: Record<string, unknown> = { stats }
  const h: H = { spawned: [], logs: [], data, providers: [] }
  on('store.get', (_$: unknown, e: any) => ({ value: data[e.key] }))
  on('store.set', (_$: unknown, e: any) => { data[e.key] = e.value; return { value: undefined } })
  on('store.delete', (_$: unknown, e: any) => { delete data[e.key]; return { value: undefined } })
  on('session.start', () => ({ cwd: '/work' }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  let n = 0
  on('agent.spawn', (_$: unknown, e: any) => {
    h.spawned.push(e.model)
    h.providers.push(e.provider)
    return { model: e.model ?? defs[e.subagentType] ?? e.parentModel, agentId: 'a' + ++n }
  })
  on('turn.complete', () => ({ text: 'done' }) as never)
  on('tool.call', () => ({ result: 'ok' }) as never)
  on('turn.step', async function* (_$: unknown, e: any) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn',
      usage: { model: e.model, input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } as never
  })
  on('ui.log', (_$: unknown, e: any) => { h.logs.push(String(e.message ?? e.text ?? JSON.stringify(e))); return { value: undefined } as never })
  for (const k of ['ui.toast', 'ui.status'] as const) on(k, () => ({ value: undefined }) as never)
  return h
}

// Who provides an agent type: Claude Code itself for its built-ins and teammates, a plugin or the user's settings for a
// definition file.
const ENGINE = { plugin: 'engine', tier: 'core' }
const CUSTOM = { plugin: 'acme-agents', tier: 'user' }

// `provider: null` leaves the provider out of the spawn.
const spawn = async ($: any, description: string, opts: { model?: string; type?: string; parent?: string; provider?: object | null } = {}): Promise<string> =>
  ((await $.agent.spawn({
    prompt: 'p', description, subagentType: opts.type ?? 'general-purpose', parentModel: opts.parent ?? 'claude-opus-5-5',
    ...(opts.provider === null ? {} : { provider: opts.provider ?? ENGINE }),
    ...(opts.model !== undefined ? { model: opts.model } : {}),
  } as never)) as { agentId: string }).agentId

const report = async ($: any): Promise<string> =>
  ((await $.command.run({ command: 'escalator', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } } as never)) as { text: string }).text

test('a spawn without a model starts on the category tier and the log says so', async ($, on) => {
  const h = wire(on)
  await $.session.start({ cwd: '/work' } as never)
  await spawn($, 'fix the login bug')
  await spawn($, 'find where the cache is built')
  await spawn($, 'review the patch')
  expect(h.spawned).toEqual(['sonnet', 'haiku', undefined])
  expect(h.logs.some((l) => l.includes('started on sonnet, asked opus (startTier auto)'))).toBe(true)
  expect(h.logs.some((l) => l.includes('started on haiku, asked opus (startTier auto)'))).toBe(true)
})

test('a model named in the Agent call is a ceiling: the start is the category tier, never above the named model', async ($, on) => {
  const h = wire(on)
  await $.session.start({ cwd: '/work' } as never)
  await spawn($, 'fix the login bug', { model: 'opus' })
  await spawn($, 'find where the cache is built', { model: 'claude-opus-5-5' })
  await spawn($, 'review the patch', { model: 'opus' })
  await spawn($, 'fix the logout bug', { model: 'haiku' })
  await spawn($, 'find where the token is read', { model: 'sonnet' })
  expect(h.spawned).toEqual(['sonnet', 'haiku', 'opus', 'haiku', 'haiku'])
  expect(h.logs.some((l) => l.includes('started on sonnet, asked opus (startTier auto, model in the call is a ceiling)'))).toBe(true)
  expect(h.logs.some((l) => l.includes('started on haiku, asked sonnet (startTier auto, model in the call is a ceiling)'))).toBe(true)
  expect(await report($)).toContain('Started lower by startTier: 3 runs')
})

test('a model named in the call overrides a definition: a custom type is lowered from it like any other', async ($, on) => {
  const h = wire(on, {}, { 'acme-worker': 'claude-haiku-5-5' })
  await $.session.start({ cwd: '/work' } as never)
  await spawn($, 'fix the login bug', { model: 'opus', type: 'acme-worker', provider: CUSTOM })
  expect(h.spawned).toEqual(['sonnet'])
})

test('with respectExplicitModel a model named in the call is kept exactly', { options: { respectExplicitModel: true } }, async ($, on) => {
  const h = wire(on)
  await $.session.start({ cwd: '/work' } as never)
  await spawn($, 'fix the login bug', { model: 'opus' })
  await spawn($, 'find where the cache is built', { model: 'claude-opus-5-5' })
  await spawn($, 'fix the logout bug', { model: 'opus', type: 'acme-worker', provider: CUSTOM })
  expect(h.spawned).toEqual(['opus', 'claude-opus-5-5', 'opus'])
  expect(h.logs.some((l) => l.includes('startTier'))).toBe(false)
})

test('a custom agent type with no model in the call runs as its definition says, explore included', async ($, on) => {
  const h = wire(on, {}, { 'acme-worker': 'claude-opus-5-5' })
  // even a tier remembered from earlier sessions does not lower it
  h.data.agentTypes = { 'acme-worker': { tier: 'opus', seenAt: NOW - 1 } }
  await $.session.start({ cwd: '/work' } as never)
  await spawn($, 'fix the login bug', { type: 'acme-worker', provider: CUSTOM })
  await spawn($, 'find where the cache is built', { type: 'acme-worker', provider: CUSTOM })
  await spawn($, 'fix the logout bug', { type: 'acme-worker', provider: CUSTOM })
  expect(h.spawned).toEqual([undefined, undefined, undefined])
  expect(h.logs.some((l) => l.includes('startTier'))).toBe(false)
  expect(await report($)).not.toContain('Started lower')
})

test('a spawn whose provider is missing is treated as a definition and left as it is', async ($, on) => {
  const h = wire(on)
  await $.session.start({ cwd: '/work' } as never)
  await spawn($, 'fix the login bug', { provider: null })
  await spawn($, 'find where the cache is built', { provider: null })
  await spawn($, 'fix the logout bug', { provider: { tier: 'core' } })
  expect(h.spawned).toEqual([undefined, undefined, undefined])
})

test('the built-in Explore and Plan types inherit the parent model and are lowered from their first spawn', async ($, on) => {
  const h = wire(on)
  await $.session.start({ cwd: '/work' } as never)
  await spawn($, 'find where the cache is built', { type: 'Explore' })
  await spawn($, 'fix the login bug', { type: 'Plan' })
  expect(h.spawned).toEqual(['haiku', 'sonnet'])
})

test('learning raises a custom type from the tier its definition runs on, never below it', async ($, on) => {
  const cat = categorize('acme-worker', 'fix the login bug')
  // haiku escalated 3 of 5 runs for this category: learning climbs to sonnet
  const h = wire(on, {}, { 'acme-worker': 'claude-haiku-5-5' }, { [cat]: { haiku: { runs: 5, escalated: 3, tokens: 0, notAccepted: 3 } } })
  await $.session.start({ cwd: '/work' } as never)
  // the first spawn of the session: the definition's tier is not known yet, the spawn is left alone and its tier seen
  await spawn($, 'fix the login bug', { type: 'acme-worker', provider: CUSTOM })
  await spawn($, 'fix the login bug', { type: 'acme-worker', provider: CUSTOM })
  expect(h.spawned).toEqual([undefined, 'sonnet'])
  expect(h.logs.some((l) => l.includes('startTier'))).toBe(false)
})

test('the tier a custom type runs on, remembered from earlier sessions, lets learning raise it from its first spawn', async ($, on) => {
  const cat = categorize('acme-worker', 'fix the login bug')
  const h = wire(on, {}, { 'acme-worker': 'claude-haiku-5-5' }, { [cat]: { haiku: { runs: 5, escalated: 3, tokens: 0, notAccepted: 3 } } })
  h.data.agentTypes = { 'acme-worker': { tier: 'haiku', seenAt: NOW - 1 } }
  await $.session.start({ cwd: '/work' } as never)
  await spawn($, 'fix the login bug', { type: 'acme-worker', provider: CUSTOM })
  expect(h.spawned).toEqual(['sonnet'])
})

test('exploration never goes below the tier a custom definition runs on', { options: { explore: 1 } }, async ($, on) => {
  const cat = categorize('acme-worker', 'fix the login bug')
  const h = wire(on, {}, { 'acme-worker': 'claude-sonnet-5-5' }, { [cat]: { haiku: { runs: 0, escalated: 0, tokens: 0 }, sonnet: { runs: 5, escalated: 3, tokens: 0, notAccepted: 3 } } })
  await $.session.start({ cwd: '/work' } as never)
  for (let i = 0; i < 20; i++) await spawn($, 'fix the login bug', { type: 'acme-worker', provider: CUSTOM })
  expect(h.spawned.includes('haiku')).toBe(false)
})

test('an empty model counts as no model', async ($, on) => {
  const h = wire(on)
  await $.session.start({ cwd: '/work' } as never)
  await spawn($, 'fix the login bug', { model: '' })
  expect(h.spawned).toEqual(['sonnet'])
})

test('startTier requested keeps the old start, a model named in the call included', { options: { startTier: 'requested' } }, async ($, on) => {
  const h = wire(on)
  await $.session.start({ cwd: '/work' } as never)
  await spawn($, 'fix the login bug')
  await spawn($, 'find where the cache is built')
  await spawn($, 'fix the logout bug', { model: 'opus' })
  await spawn($, 'find where the token is read', { model: 'claude-opus-5-5' })
  expect(h.spawned).toEqual([undefined, undefined, 'opus', 'claude-opus-5-5'])
  expect(h.logs.some((l) => l.includes('startTier'))).toBe(false)
})

test('baseline mode never lowers the start', async ($, on) => {
  const h = wire(on, { MODEL_ESCALATOR_MODE: 'baseline', MODEL_ESCALATOR_BASELINE: 'opus' })
  await $.session.start({ cwd: '/work' } as never)
  await spawn($, 'fix the login bug')
  await spawn($, 'find where the cache is built')
  // the baseline is the parent's opus: nothing to rewrite, nothing lowered
  expect(h.spawned).toEqual([undefined, undefined])
  expect(h.logs.some((l) => l.includes('startTier'))).toBe(false)
})

test('observe mode only logs the lower start', async ($, on) => {
  const h = wire(on, { MODEL_ESCALATOR_MODE: 'observe' })
  await $.session.start({ cwd: '/work' } as never)
  await spawn($, 'fix the login bug')
  expect(h.spawned).toEqual([undefined])
  expect(h.logs.some((l) => l.includes('would start on sonnet, asked opus (startTier auto)'))).toBe(true)
})

test('a fork is never touched', async ($, on) => {
  const h = wire(on)
  await $.session.start({ cwd: '/work' } as never)
  await $.agent.spawn({ prompt: 'p', description: 'fix the login bug', subagentType: 'fork', fork: true, parentModel: 'claude-opus-5-5' } as never)
  expect(h.spawned).toEqual([undefined])
})

test('an engine type with its own model: the first code task runs as defined, later ones never above that model', async ($, on) => {
  const h = wire(on, {}, { 'cheap-worker': 'claude-haiku-5-5', 'mid-worker': 'claude-sonnet-5-5' })
  await $.session.start({ cwd: '/work' } as never)
  await spawn($, 'fix the login bug', { type: 'cheap-worker' })
  await spawn($, 'fix the logout bug', { type: 'cheap-worker' })
  // explore goes to haiku from the first spawn: haiku is never above any definition
  await spawn($, 'find where the cache is built', { type: 'mid-worker' })
  await spawn($, 'fix the cache bug', { type: 'mid-worker' })
  await spawn($, 'fix the cache bug again', { type: 'mid-worker' })
  expect(h.spawned).toEqual([undefined, undefined, 'haiku', undefined, undefined])
  expect(h.logs.filter((l) => l.includes('startTier')).length).toBe(1)
})

test('learning raises from the auto start, and the stats are kept under the tier the agent started on', async ($, on) => {
  const cat = categorize('general-purpose', 'fix the login bug')
  // sonnet failed verification in 1 of 2 runs: the quality rule climbs over it
  const h = wire(on, {}, {}, { [cat]: { sonnet: { runs: 2, escalated: 0, tokens: 0, failedVerify: 1, notAccepted: 1, qualityFailed: 1 } } })
  await $.session.start({ cwd: '/work' } as never)
  await spawn($, 'fix the login bug')
  expect(h.spawned).toEqual([undefined])
  expect(h.logs.some((l) => l.includes('startTier'))).toBe(false)
})

test('exploration never goes below the auto start', { options: { explore: 1 } }, async ($, on) => {
  const cat = categorize('general-purpose', 'fix the login bug')
  // sonnet escalated 3 of 5 runs: the failure-rate rule raises it, haiku was never asked
  const h = wire(on, {}, {}, { [cat]: { haiku: { runs: 0, escalated: 0, tokens: 0 }, sonnet: { runs: 5, escalated: 3, tokens: 0, notAccepted: 3 } } })
  await $.session.start({ cwd: '/work' } as never)
  for (let i = 0; i < 20; i++) await spawn($, 'fix the login bug')
  expect(h.spawned.every((m) => m === undefined || m === 'sonnet')).toBe(true)
  expect(h.spawned.includes('haiku')).toBe(false)
})

test('the report counts the runs started lower and how many escalated or failed a quality check', async ($, on) => {
  wire(on)
  await $.session.start({ cwd: '/work' } as never)
  await spawn($, 'fix the login bug')
  await spawn($, 'find where the cache is built')
  await spawn($, 'review the patch')
  const text = await report($)
  expect(text).toContain('Started lower by startTier: 2 runs (0 escalated, 0 failed a quality check)')
})

test('no line in the report when nothing started lower', { options: { startTier: 'requested' } }, async ($, on) => {
  wire(on)
  await $.session.start({ cwd: '/work' } as never)
  await spawn($, 'fix the login bug')
  expect(await report($)).not.toContain('Started lower')
})

const sleep = (ms: number) => new Promise<void>((r) => (globalThis as unknown as { setTimeout: (f: () => void, ms: number) => unknown }).setTimeout(r, ms))

test('a lowered run that fails verification counts in the report and as a quality failure of its start tier', { options: { verifyCommand: 'npm test', reviewRate: 0 } }, async ($, on) => {
  const h = wire(on)
  on('process.run', () => ({ value: { exitCode: 1, stdout: 'FAIL', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }) as never)
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($, 'fix the login bug')
  await $.turn.complete({ turnId: 't-' + id, agentId: id, answer: 'x' } as never)
  const cat = categorize('general-purpose', 'fix the login bug')
  const cell = () => (h.data.stats as Record<string, Record<string, { runs: number; qualityFailed?: number }>>)[cat]?.sonnet
  for (let i = 0; i < 200 && cell()?.runs !== 1; i++) await sleep(10)
  expect(cell()!.qualityFailed).toBe(1)
  expect(await report($)).toContain('Started lower by startTier: 1 run (0 escalated, 1 failed a quality check)')
})

test('a type whose own tier is remembered in the store starts lowered from its first spawn', async ($, on) => {
  const h = wire(on)
  // the type runs on opus by itself (remembered): a code task is lowered to sonnet from its first spawn
  h.data.agentTypes = { scout: { tier: 'opus', seenAt: NOW - 1 } }
  await $.session.start({ cwd: '/work' } as never)
  await spawn($, 'fix the login bug', { type: 'scout' })
  expect(h.spawned).toEqual(['sonnet'])
  expect(h.logs.some((l) => l.includes('started on sonnet, asked opus (startTier auto)'))).toBe(true)
})

test('without a remembered tier the first spawn of an unseen type is not lowered', async ($, on) => {
  const h = wire(on)
  await $.session.start({ cwd: '/work' } as never)
  await spawn($, 'fix the login bug', { type: 'scout' })
  expect(h.spawned).toEqual([undefined])
})

test('the own tier seen at a spawn is written to the store, and not written again when unchanged', async ($, on) => {
  const h = wire(on, {}, { 'mid-worker': 'claude-sonnet-5-5' })
  await $.session.start({ cwd: '/work' } as never)
  await spawn($, 'fix the cache bug', { type: 'mid-worker' })
  const types = h.data.agentTypes as Record<string, { tier: string; seenAt: number }>
  expect(types['mid-worker']?.tier).toBe('sonnet')
  const before = types['mid-worker']
  await spawn($, 'fix the cache bug again', { type: 'mid-worker' })
  expect(h.data.agentTypes).toEqual({ 'mid-worker': before })
})

test('the store never records general-purpose, whose tier is the parent one', async ($, on) => {
  const h = wire(on)
  await $.session.start({ cwd: '/work' } as never)
  await spawn($, 'review the patch')
  expect(h.data.agentTypes).toBeUndefined()
})

test('a tier seen in the session wins over the stored one', async ($, on) => {
  const h = wire(on, {}, { 'mid-worker': 'claude-sonnet-5-5' })
  h.data.agentTypes = { 'mid-worker': { tier: 'opus', seenAt: NOW - 1 } }
  await $.session.start({ cwd: '/work' } as never)
  // review keeps the asked tier (opus, the stored one): the definition's sonnet is seen and stored
  await spawn($, 'review the patch', { type: 'mid-worker' })
  expect(h.spawned).toEqual([undefined])
  // the store now says something else (another session's older value): this session's sonnet still decides
  h.data.agentTypes = { 'mid-worker': { tier: 'opus', seenAt: NOW - 1 } }
  await spawn($, 'fix the cache bug', { type: 'mid-worker' })
  expect(h.spawned).toEqual([undefined, undefined])
})

test('/escalator reset forgets the remembered agent types with the stats', async ($, on) => {
  const h = wire(on)
  h.data.agentTypes = { scout: { tier: 'haiku', seenAt: NOW } }
  await $.session.start({ cwd: '/work' } as never)
  await $.command.run({ command: 'escalator', args: 'reset', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } } as never)
  expect(h.data.agentTypes).toBeUndefined()
})
