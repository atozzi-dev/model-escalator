import { expect, mock, test } from 'claude-code/testing'
import { resetState } from '../hooks/register'
import { parseConfig } from '../hooks/config'
import { record, recordReview, type Stats } from '../hooks/learning'
import {
  buildReportReviewPrompt, buildReviewPrompt, diffArgv, editedPath, formatReviews, handbackReport, isCheaper, parseReview,
  REPORT_REVIEW_SYSTEM, reportText, REVIEW_LIMITS, REVIEW_SYSTEM, sampleRun,
} from '../hooks/review'

// ---------- pure helpers ----------

test('config: one run in four is reviewed by default, rate between 0 and 1, model defaults to the senior', () => {
  const d = parseConfig({})
  expect(d.reviewRate).toBe(0.25)
  expect(parseConfig({ reviewRate: 0 }).reviewRate).toBe(0)
  expect(d.reviewModel).toBe('')
  expect(parseConfig({ reviewRate: 0.25 }).reviewRate).toBe(0.25)
  expect(parseConfig({ reviewRate: '1' }).reviewRate).toBe(1)
  for (const bad of [2, -0.1, 'x', '', null]) expect(parseConfig({ reviewRate: bad }).reviewRate).toBe(0.25)
  expect(parseConfig({ reviewModel: ' sonnet ' }).reviewModel).toBe('sonnet')
  expect(parseConfig({ reviewModel: 'x'.repeat(101) }).reviewModel).toBe('')
})

test('sampleRun: never at 0, always at 1, deterministic for a seed, close to the rate', () => {
  const keys = Array.from({ length: 2000 }, (_, i) => `a${i}:t${i}`)
  expect(keys.some((k) => sampleRun(0, 'abc123', k))).toBe(false)
  expect(keys.every((k) => sampleRun(1, 'abc123', k))).toBe(true)
  const first = keys.map((k) => sampleRun(0.3, 'abc123', k))
  const again = keys.map((k) => sampleRun(0.3, 'abc123', k))
  expect(again).toEqual(first)
  const share = first.filter(Boolean).length / keys.length
  expect(Math.abs(share - 0.3) < 0.05).toBe(true)
  const other = keys.map((k) => sampleRun(0.3, 'ffffff', k))
  expect(other).not.toEqual(first)
  expect(sampleRun(Number.NaN, 'abc123', 'k')).toBe(false)
})

test('isCheaper: only a start tier below the baseline', () => {
  expect(isCheaper('haiku', 'opus')).toBe(true)
  expect(isCheaper('sonnet', 'opus')).toBe(true)
  expect(isCheaper('haiku', 'sonnet')).toBe(true)
  expect(isCheaper('opus', 'opus')).toBe(false)
  expect(isCheaper('sonnet', 'sonnet')).toBe(false)
  expect(isCheaper('sonnet', 'haiku')).toBe(false)
})

test('editedPath: the file of an edit tool, nothing for other tools', () => {
  expect(editedPath('Edit', { file_path: 'src/a.ts' })).toBe('src/a.ts')
  expect(editedPath('Write', { file_path: ' src/b.ts ' })).toBe('src/b.ts')
  expect(editedPath('MultiEdit', { file_path: 'c.ts' })).toBe('c.ts')
  expect(editedPath('NotebookEdit', { notebook_path: 'n.ipynb' })).toBe('n.ipynb')
  expect(editedPath('Bash', { command: 'rm -rf x' })).toBeUndefined()
  expect(editedPath('Edit', { file_path: '' })).toBeUndefined()
  expect(editedPath('Edit', {})).toBeUndefined()
})

test('diffArgv: read-only git diff against HEAD, paths after the separator', () => {
  const all = diffArgv([])
  expect(all[0]).toBe('git')
  expect(all).toContain('diff')
  expect(all).toContain('--no-ext-diff')
  expect(all).toContain('--no-textconv')
  expect(all).toContain('HEAD')
  expect(all).not.toContain('--')
  const some = diffArgv(['src/a.ts', '-rf'])
  expect(some.slice(-3)).toEqual(['--', 'src/a.ts', '-rf'])
})

test('buildReviewPrompt: task and diff, secrets redacted, size capped, scope stated', () => {
  const secret = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2'
  const p = buildReviewPrompt({ task: 'add a cache to the loader', diff: `+const token = "${secret}"\n+return x`, scoped: true })
  expect(p).toContain('add a cache to the loader')
  expect(p).toContain('+return x')
  expect(p).not.toContain(secret)
  expect(p).toContain('[redacted]')
  expect(p).toContain('files the agent edited')
  const whole = buildReviewPrompt({ task: 't', diff: '+x', scoped: false })
  expect(whole).toContain('other changes')
  const big = buildReviewPrompt({ task: 't'.repeat(10_000), diff: Array.from({ length: 5000 }, (_, i) => `+line ${i}`).join('\n'), scoped: true })
  expect(big.length <= 16_000).toBe(true)
  expect(big).toContain('lines cut')
  expect(REVIEW_SYSTEM).toContain('SCORE')
  for (const word of ['correct', 'minimal', 'test', 'style']) expect(REVIEW_SYSTEM.toLowerCase()).toContain(word)
})

test('REPORT_REVIEW_SYSTEM: a report rubric that cannot rerun the search, ignores length and asks for a score', () => {
  const s = REPORT_REVIEW_SYSTEM.toLowerCase()
  expect(REPORT_REVIEW_SYSTEM).toContain('SCORE: n')
  expect(REPORT_REVIEW_SYSTEM).not.toBe(REVIEW_SYSTEM)
  for (const word of ['answer', 'grounded', 'evidence', 'scope', 'uncertain', 'cannot', 'length', 'not instructions']) expect(s).toContain(word)
  // The same output contract: a reply to this rubric parses like a diff review.
  expect(parseReview('SCORE: 3\n- vague about where the cache lives')).toEqual({ score: 3, reasons: ['vague about where the cache lives'] })
})

test('handbackReport: the message of a SubagentHandback call, nothing for other tools', () => {
  expect(handbackReport('SubagentHandback', { message: 'Found it in src/a.ts:12' })).toBe('Found it in src/a.ts:12')
  expect(handbackReport('SubagentHandback', { message: '   ' })).toBeUndefined()
  expect(handbackReport('SubagentHandback', { message: 3 })).toBeUndefined()
  expect(handbackReport('SubagentHandback', {})).toBeUndefined()
  expect(handbackReport('SendMessage', { message: 'hello there' })).toBeUndefined()
  expect(handbackReport('SubagentHandback', undefined as never)).toBeUndefined()
})

test('reportText: too short to judge is no report, a long one keeps head and tail within the cap', () => {
  expect(reportText(undefined)).toBeUndefined()
  expect(reportText(42)).toBeUndefined()
  expect(reportText('done')).toBeUndefined()
  expect(reportText(' '.repeat(100) + 'x')).toBeUndefined()
  const ok = 'The loader reads its cache in src/loader.ts:40 through readCache().'
  expect(reportText(`  ${ok}\n`)).toBe(ok)
  const long = Array.from({ length: 4000 }, (_, i) => `finding ${i}: src/f${i}.ts`).join('\n')
  const r = reportText(long)!
  expect(r.length <= REVIEW_LIMITS.maxReportChars + 100).toBe(true)
  expect(r).toContain('finding 0:')
  expect(r).toContain('finding 3999:')
  expect(r).toContain('lines cut')
})

test('buildReportReviewPrompt: task and report, secrets redacted, size capped, the report marked as read-only work', () => {
  const secret = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2'
  const p = buildReportReviewPrompt({ task: 'find where the loader reads its cache', report: `It is in src/loader.ts:40.\nToken: ${secret}` })
  expect(p).toContain('find where the loader reads its cache')
  expect(p).toContain('src/loader.ts:40')
  expect(p).not.toContain(secret)
  expect(p).toContain('[redacted]')
  expect(p).toContain('## Report')
  expect(p).toContain('changed no file')
  expect(p).not.toContain('## Diff')
  const big = buildReportReviewPrompt({ task: 't'.repeat(10_000), report: Array.from({ length: 5000 }, (_, i) => `line ${i}`).join('\n') })
  expect(big.length <= REVIEW_LIMITS.maxTaskChars + REVIEW_LIMITS.maxReportChars + 200).toBe(true)
  expect(buildReportReviewPrompt({ task: '', report: '' })).toContain('(not given)')
})

test('parseReview: score line anywhere, at most three reasons, invalid scores rejected', () => {
  expect(parseReview('SCORE: 4\n- fixes the bug\n- minimal change')).toEqual({ score: 4, reasons: ['fixes the bug', 'minimal change'] })
  expect(parseReview('**SCORE: 2/5**\n1. deletes a test\n2. unrelated rename\n3. no check\n4. extra')!.reasons.length).toBe(3)
  expect(parseReview('Looks fine.\nscore = 5')!.score).toBe(5)
  expect(parseReview('SCORE: 3.6')!.score).toBe(4)
  expect(parseReview('SCORE: 0')).toBeUndefined()
  expect(parseReview('SCORE: 6')).toBeUndefined()
  expect(parseReview('SCORE: n')).toBeUndefined()
  expect(parseReview('no verdict')).toBeUndefined()
  expect(parseReview('')).toBeUndefined()
  expect(parseReview(undefined as never)).toBeUndefined()
  expect(parseReview('SCORE: 3\n' + 'x'.repeat(1000))!.reasons[0]!.length <= 200).toBe(true)
})

test('formatReviews: average per category and tier, empty without reviews', () => {
  expect(formatReviews({})).toBe('')
  expect(formatReviews(record({}, 'gp:tests', 'haiku', false, 0))).toBe('')
  let s = recordReview({}, 'gp:tests', 'haiku', 4)
  s = recordReview(s, 'gp:tests', 'haiku', 3)
  expect(formatReviews(s)).toBe('- gp:tests haiku: average 3.5/5 over 2 reviews')
})

// ---------- through the engine ----------

type Call = { model: string; system: string; prompt: string }
type Proc = { argv: readonly string[]; timeoutMs?: number }
type H = { calls: Call[]; runs: Proc[]; logs: string[]; debug: string[]; toasts: string[]; prompts: string[] }

const answered = (text: string) => ({ isAnswered: true, text, usage: { input_tokens: 1000, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } })
const refusedReply = { isAnswered: false, reason: 'empty-reply', usage: { input_tokens: 1000, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }
const SECRET = 'ghp_' + 'Z9y8X7w6V5u4T3s2R1q0P9o8'
const DIFF = ` src/a.ts | 2 +-\n 1 file changed\n\ndiff --git a/src/a.ts b/src/a.ts\n-old\n+const key = "${SECRET}"\n+new line`
const okDiff = { exitCode: 0, stdout: DIFF, stderr: '', isStdoutTruncated: false, isStderrTruncated: false }

function wire(on: any, env: Record<string, string>, opts: {
  reply?: (c: Call) => unknown | Promise<unknown>
  proc?: (argv: readonly string[]) => unknown
} = {}): H {
  resetState()
  mock.env(on, env)
  mock.store(on)
  on('session.start', () => ({ cwd: '/work' }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  const h: H = { calls: [], runs: [], logs: [], debug: [], toasts: [], prompts: [] }
  let n = 0
  on('agent.spawn', (_$: unknown, e: any) => { h.prompts.push(String(e.prompt)); return { model: e.model ?? 'haiku', agentId: 'a' + ++n } })
  on('tool.call', () => ({ result: 'ok' }) as never)
  on('turn.complete', () => ({ text: 'done' }) as never)
  on('process.run', async (_$: unknown, e: any) => {
    h.runs.push({ argv: e.argv, timeoutMs: e.init?.timeoutMs })
    return { value: await (opts.proc ?? (() => okDiff))(e.argv) } as never
  })
  on('model.complete', async (_$: unknown, e: any) => {
    const c = { model: String(e.model), system: String(e.system ?? ''), prompt: String(e.prompt) }
    h.calls.push(c)
    return { value: await (opts.reply ?? (() => answered('SCORE: 4\n- does the task\n- small change')))(c) } as never
  })
  on('ui.log', (_$: unknown, e: any) => {
    const text = String(e.message ?? e.text ?? JSON.stringify(e))
    ;(e.options?.to === 'debug' || e.to === 'debug' ? h.debug : h.logs).push(text)
    return { value: undefined } as never
  })
  on('ui.toast', (_$: unknown, e: any) => { h.toasts.push(String(e.message ?? e.text ?? JSON.stringify(e))); return { value: undefined } as never })
  on('ui.status', () => ({ value: undefined }) as never)
  return h
}

const sleep = (ms: number) => new Promise<void>((r) => (globalThis as unknown as { setTimeout: (f: () => void, ms: number) => unknown }).setTimeout(r, ms))
async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i++) await sleep(10)
  await sleep(40)
}

async function spawn($: any, model = 'haiku', prompt = 'add a cache to the loader'): Promise<string> {
  const r = await $.agent.spawn({ prompt, description: 'add loader cache', subagentType: 'general-purpose', model } as never) as { agentId: string }
  return r.agentId
}
const edit = ($: any, agentId: string, file: string) => $.tool.call({ tool: 'Edit', file_path: file, old_string: 'a', new_string: 'b', agentId } as never)
const finish = ($: any, agentId: string, extra: Record<string, unknown> = {}) => $.turn.complete({ turnId: 't-' + agentId, agentId, answer: 'x', ...extra } as never)
const command = async ($: any, args: string): Promise<string> =>
  ((await $.command.run({ command: 'escalator', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } } as never)) as { text: string }).text

const RATE = { reviewRate: 1 }

test('reviewRate 0: a cheap run is never reviewed', { options: { reviewRate: 0 } }, async ($, on) => {
  const h = wire(on, {})
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($)
  await edit($, id, 'src/a.ts')
  await finish($, id)
  await sleep(80)
  expect(h.runs.length).toBe(0)
  expect(h.calls.length).toBe(0)
  expect(await command($, 'stats')).not.toContain('review')
})

test('a sampled cheap run: git diff of the edited files, rubric and redacted diff to the review model, score recorded', { options: RATE }, async ($, on) => {
  const h = wire(on, {})
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($)
  await edit($, id, 'src/a.ts')
  await edit($, id, 'src/b.ts')
  await finish($, id)
  await until(() => h.logs.some((l) => l.includes('review 4/5')))
  expect(h.runs.length).toBe(1)
  expect(h.runs[0]!.argv.slice(0, 2)).toEqual(['git', '--no-pager'])
  expect(h.runs[0]!.argv.slice(-3)).toEqual(['--', 'src/a.ts', 'src/b.ts'])
  expect(typeof h.runs[0]!.timeoutMs).toBe('number')
  expect(h.calls.length).toBe(1)
  expect(h.calls[0]!.model).toBe('opus')
  expect(h.calls[0]!.system).toBe(REVIEW_SYSTEM)
  expect(h.calls[0]!.prompt).toContain('add a cache to the loader')
  expect(h.calls[0]!.prompt).toContain('+new line')
  expect(h.calls[0]!.prompt).not.toContain(SECRET)
  const line = h.logs.find((l) => l.includes('review 4/5'))!
  expect(line).toContain(id)
  expect(line).toContain('does the task')
  expect(h.toasts.length).toBe(0)
  const stats = await command($, 'stats')
  expect(stats).toContain('general-purpose:feature haiku: 1 run')
  expect(stats).toContain('- general-purpose:feature haiku: average 4.0/5 over 1 review')
})

test('reviewModel overrides the senior; a low score shows a toast', { options: { ...RATE, reviewModel: 'sonnet' } }, async ($, on) => {
  const h = wire(on, {}, { reply: () => answered('SCORE: 2\n- weakens a test') })
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($)
  await edit($, id, 'src/a.ts')
  await finish($, id)
  await until(() => h.toasts.length > 0)
  expect(h.calls[0]!.model).toBe('sonnet')
  expect(h.toasts.length).toBe(1)
  expect(h.toasts[0]!).toContain('review 2/5')
})

test('a run with neither an edited file nor a report is never reviewed: no git, no call, no score', { options: RATE }, async ($, on) => {
  const h = wire(on, {})
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($)
  await $.tool.call({ tool: 'Read', file_path: 'src/a.ts', agentId: id } as never)
  // A one-word reply is no report: nothing to judge.
  await finish($, id, { answer: 'done' })
  await sleep(80)
  expect(h.runs.length).toBe(0)
  expect(h.calls.length).toBe(0)
  expect(await command($, 'report')).toContain('senior consults: 0')
  expect(await command($, 'stats')).not.toContain('average')
})

const EXPLORE = 'find where the loader reads its cache'
const REPORT = 'The loader reads its cache in src/loader.ts:40 through readCache(); the TTL comes from config.ts:12.'
const scout = async ($: any, model: string): Promise<string> =>
  ((await $.agent.spawn({ prompt: EXPLORE, description: 'find the loader cache', subagentType: 'general-purpose', model } as never)) as { agentId: string }).agentId
const handback = ($: any, agentId: string, message: string) => $.tool.call({ tool: 'SubagentHandback', message, agentId } as never)

test('a read-only run is reviewed on its handed-back report: report rubric, task and redacted report, no git', { options: RATE }, async ($, on) => {
  const h = wire(on, {})
  await $.session.start({ cwd: '/work' } as never)
  const id = await scout($, 'haiku')
  await $.tool.call({ tool: 'Grep', pattern: 'readCache', agentId: id } as never)
  const r = await handback($, id, `${REPORT}\nThe key in .env is ${SECRET}.`) as { result?: unknown; deny?: unknown }
  // The hand-back itself is never touched.
  expect(r.deny).toBeUndefined()
  expect(r.result).toBe('ok')
  await finish($, id, { answer: 'x' })
  await until(() => h.logs.some((l) => l.includes('review 4/5')))
  expect(h.runs.length).toBe(0)
  expect(h.calls.length).toBe(1)
  expect(h.calls[0]!.model).toBe('opus')
  expect(h.calls[0]!.system).toBe(REPORT_REVIEW_SYSTEM)
  expect(h.calls[0]!.prompt).toContain(EXPLORE)
  expect(h.calls[0]!.prompt).toContain('src/loader.ts:40')
  expect(h.calls[0]!.prompt).not.toContain(SECRET)
  const line = h.logs.find((l) => l.includes('review 4/5'))!
  expect(line).toContain(id)
  expect(line).toContain('report')
  const stats = await command($, 'stats')
  expect(stats).toMatch(/general-purpose:explore haiku: average 4\.0\/5 over 1 review/)
  expect(await command($, 'report')).toContain('senior consults: 1')
})

test('without a hand-back, the final answer of a read-only run is its report', { options: RATE }, async ($, on) => {
  const h = wire(on, {})
  await $.session.start({ cwd: '/work' } as never)
  const id = await scout($, 'haiku')
  await finish($, id, { answer: REPORT })
  await until(() => h.calls.length > 0)
  expect(h.calls[0]!.system).toBe(REPORT_REVIEW_SYSTEM)
  expect(h.calls[0]!.prompt).toContain('readCache()')
})

test('the hand-back is preferred to the final answer, and is kept for that run only', { options: RATE }, async ($, on) => {
  const h = wire(on, {})
  await $.session.start({ cwd: '/work' } as never)
  const id = await scout($, 'haiku')
  await handback($, id, REPORT)
  await finish($, id, { answer: 'Report delivered to the lead, see the hand-back above for the details.' })
  await until(() => h.calls.length > 0)
  expect(h.calls[0]!.prompt).toContain('readCache()')
  expect(h.calls[0]!.prompt).not.toContain('Report delivered')
  // The next run of the same agent starts with no report: a one-word answer is not reviewed.
  await finish($, id, { turnId: 't2', answer: 'ok' })
  await sleep(80)
  expect(h.calls.length).toBe(1)
})

test('a low report score counts like a low diff review: toast, quality failure in the stats', { options: RATE }, async ($, on) => {
  const h = wire(on, {}, { reply: () => answered('SCORE: 2\n- names no file') })
  await $.session.start({ cwd: '/work' } as never)
  const id = await scout($, 'haiku')
  await handback($, id, REPORT)
  await finish($, id)
  await until(() => h.toasts.length > 0)
  expect(h.toasts[0]!).toContain('review 2/5')
  const stats = await command($, 'stats')
  expect(stats).toContain('average 2.0/5 over 1 review')
})

test('a run with edited files keeps the diff review, whatever it reported', { options: RATE }, async ($, on) => {
  const h = wire(on, {})
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($)
  await edit($, id, 'src/a.ts')
  await handback($, id, REPORT)
  await finish($, id, { answer: REPORT })
  await until(() => h.calls.length > 0)
  expect(h.runs.length).toBe(1)
  expect(h.calls[0]!.system).toBe(REVIEW_SYSTEM)
  expect(h.calls[0]!.prompt).toContain('+new line')
  expect(h.calls[0]!.prompt).not.toContain('readCache()')
})

test('reviewRate 0 and runs on the baseline tier: no report is reviewed', { options: { reviewRate: 0 } }, async ($, on) => {
  const h = wire(on, {})
  await $.session.start({ cwd: '/work' } as never)
  const cheap = await scout($, 'haiku')
  await handback($, cheap, REPORT)
  await finish($, cheap)
  const strong = await scout($, 'opus')
  await finish($, strong, { answer: REPORT })
  await sleep(80)
  expect(h.calls.length).toBe(0)
})

test('a huge report is capped with head and tail before it reaches the review model', { options: RATE }, async ($, on) => {
  const h = wire(on, {})
  await $.session.start({ cwd: '/work' } as never)
  const id = await scout($, 'haiku')
  const huge = Array.from({ length: 20_000 }, (_, i) => `hit ${i}: src/f${i}.ts`).join('\n')
  await handback($, id, huge)
  await finish($, id)
  await until(() => h.calls.length > 0)
  const p = h.calls[0]!.prompt
  expect(p.length <= REVIEW_LIMITS.maxTaskChars + REVIEW_LIMITS.maxReportChars + 200).toBe(true)
  expect(p).toContain('hit 0:')
  expect(p).toContain('hit 19999:')
})

test('too many edited files to list: the whole working tree diff is reviewed', { options: RATE }, async ($, on) => {
  const h = wire(on, {})
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($)
  for (let i = 0; i <= REVIEW_LIMITS.maxPaths; i++) await edit($, id, `src/f${i}.ts`)
  await finish($, id)
  await until(() => h.calls.length > 0)
  expect(h.runs[0]!.argv).not.toContain('--')
  expect(h.calls[0]!.prompt).toContain('other changes')
})

for (const [name, reply] of [['refused', refusedReply], ['unscored', answered('I cannot grade this.')]] as const) {
  test(`a ${name} reply records no score`, { options: RATE }, async ($, on) => {
    const h = wire(on, {}, { reply: () => reply })
    await $.session.start({ cwd: '/work' } as never)
    const id = await spawn($)
    await edit($, id, 'src/a.ts')
    await finish($, id)
    await until(() => h.logs.some((l) => l.includes('no score')))
    expect(h.calls.length).toBe(1)
    expect(h.logs.some((l) => l.includes('no score'))).toBe(true)
    expect(h.toasts.length).toBe(0)
    expect(await command($, 'stats')).not.toContain('average')
  })
}

const NO_DIFF: [string, (argv: readonly string[]) => unknown][] = [
  ['an empty diff', () => ({ ...okDiff, stdout: '  \n' })],
  ['a failing git', () => ({ ...okDiff, exitCode: 128, stdout: '', stderr: 'fatal: not a git repository' })],
  ['no git', () => { throw new Error('spawn git ENOENT') }],
]
for (const [name, proc] of NO_DIFF) {
  test(`${name}: no review call`, { options: RATE }, async ($, on) => {
    const h = wire(on, {}, { proc })
    await $.session.start({ cwd: '/work' } as never)
    const id = await spawn($)
    await edit($, id, 'src/a.ts')
    await finish($, id)
    await until(() => h.runs.length > 0)
    await sleep(40)
    expect(h.runs.length).toBe(1)
    expect(h.calls.length).toBe(0)
    expect(await command($, 'report')).toContain('senior consults: 0')
  })
}

test('runs that start on the baseline tier or above are never sampled', { options: RATE }, async ($, on) => {
  const h = wire(on, { MODEL_ESCALATOR_BASELINE: 'sonnet' })
  await $.session.start({ cwd: '/work' } as never)
  for (const model of ['sonnet', 'opus']) {
    const id = await spawn($, model)
    await edit($, id, 'src/a.ts')
    await finish($, id)
  }
  await sleep(80)
  expect(h.runs.length).toBe(0)
  expect(h.calls.length).toBe(0)
  const cheap = await spawn($, 'haiku')
  await edit($, cheap, 'src/a.ts')
  await finish($, cheap)
  await until(() => h.calls.length > 0)
  expect(h.calls.length).toBe(1)
})

test('an aborted run is never reviewed', { options: RATE }, async ($, on) => {
  const h = wire(on, {})
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($)
  await edit($, id, 'src/a.ts')
  await finish($, id, { isAborted: true, reason: 'aborted' })
  await sleep(80)
  expect(h.runs.length).toBe(0)
  expect(h.calls.length).toBe(0)
})

for (const mode of ['baseline', 'off']) {
  test(`${mode} mode never reviews`, { options: RATE }, async ($, on) => {
    const h = wire(on, { MODEL_ESCALATOR_MODE: mode, MODEL_ESCALATOR_BASELINE: 'opus' })
    await $.session.start({ cwd: '/work' } as never)
    const a = await spawn($)
    await edit($, a, 'src/a.ts')
    await finish($, a)
    await sleep(80)
    expect(h.runs.length).toBe(0)
    expect(h.calls.length).toBe(0)
  })
}

test('observe mode reviews too: it measures quality without touching the agent', { options: RATE }, async ($, on) => {
  const h = wire(on, { MODEL_ESCALATOR_MODE: 'observe' })
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($)
  await edit($, id, 'src/a.ts')
  await finish($, id)
  await until(() => h.logs.some((l) => l.includes('review 4/5')))
  expect(h.calls.length).toBe(1)
})

test('a run recorded after its review keeps the review in the stats', { options: { ...RATE, verifyCommand: 'npm test' } }, async ($, on) => {
  // The verification answers only after the review landed, so the run is recorded last.
  let release: (v: unknown) => void = () => undefined
  const gate = new Promise((r) => { release = r })
  const h = wire(on, {}, {
    proc: (argv) => (argv[0] === 'git' ? okDiff : gate.then(() => ({ ...okDiff, stdout: 'ok' }))),
  })
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($)
  await edit($, id, 'src/a.ts')
  await finish($, id)
  await until(() => h.logs.some((l) => l.includes('review 4/5')))
  release(undefined)
  await until(() => h.logs.some((l) => l.includes('verification passed')))
  const stats = await command($, 'stats')
  expect(stats).toContain('general-purpose:feature haiku: 1 run')
  expect(stats).toContain('average 4.0/5 over 1 review')
})

test('sampling follows the session seed: the same runs are picked as the pure sampler says', { options: { reviewRate: 0.5 } }, async ($, on) => {
  const h = wire(on, {})
  await $.session.start({ cwd: '/work' } as never)
  const ids: string[] = []
  for (let i = 0; i < 12; i++) {
    const id = await spawn($, 'haiku', `task number ${i}`)
    ids.push(id)
    await edit($, id, `src/f${i}.ts`)
    await finish($, id)
  }
  const tag = /\[supervisor:([0-9a-f]{6})\]/.exec(h.prompts[0]!)![1]!
  const expected = ids.filter((id) => sampleRun(0.5, tag, `${id}:t-${id}`))
  await until(() => h.calls.length >= expected.length)
  await sleep(40)
  const reviewed = ids.filter((id, i) => h.calls.some((c) => c.prompt.includes(`task number ${i}\n`)) && id)
  expect(reviewed).toEqual(expected)
})

test('the review cost goes in the ledger like a consult', { options: RATE }, async ($, on) => {
  const h = wire(on, {})
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($)
  await edit($, id, 'src/a.ts')
  await finish($, id)
  await until(() => h.logs.some((l) => l.includes('review 4/5')))
  const report = await command($, 'report')
  expect(report).toContain('senior consults: 1')
  // 1000 input + 50 output tokens on opus: $0.004 + $0.001.
  expect(report).toContain('Session cost: $0.01')
})

test('the review never holds up turn.complete', { options: RATE }, async ($, on) => {
  let release: (v: unknown) => void = () => undefined
  const gate = new Promise((r) => { release = r })
  const h = wire(on, {}, { reply: async () => { await gate; return answered('SCORE: 5') } })
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($)
  await edit($, id, 'src/a.ts')
  const r = await finish($, id) as { text: string }
  expect(r.text).toBe('done')
  await until(() => h.calls.length > 0)
  expect(h.calls.length).toBe(1)
  expect(h.logs.some((l) => l.includes('review'))).toBe(false)
  release(undefined)
  await until(() => h.logs.some((l) => l.includes('review 5/5')))
  expect(h.logs.some((l) => l.includes('review 5/5'))).toBe(true)
})
