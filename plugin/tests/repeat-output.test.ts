import { expect, mock, test } from 'claude-code/testing'
import { DEFAULT_CONFIG } from '../hooks/config'
import {
  decide, endRun, features, newAgent, normalizeCommand, observe, REPEAT_OUTPUT_WEIGHT, resumeAgent,
  type Action, type AgentState, type Features, type Observation,
} from '../hooks/detector'
import { addAgent, hashKey, push, recordedOptions, startRecording, toolEvent, type Recording } from '../hooks/recorder'
import { resetState } from '../hooks/register'
import { replaySession } from '../hooks/replay'
import { parseSnapshot } from '../hooks/state'
import { normalizeOutput, outputPrint, softFailure } from '../hooks/testparse'
import { EXIT_ZERO_RUNS } from './fixtures/exit-zero'

// The 0.7 observation's one true miss, rebuilt without its exit marker: a check that prints FAIL but exits 0
// (for example piped through `tail`), tried again with a new candidate each time.
const GUESS = 'FAIL: answer.txt does not match the expected digest'
const guess = (word: string): Observation => ({ tool: 'Bash', ok: true, text: GUESS, summary: `echo "${word}" > answer.txt && bash check.sh | tail -1` })
const WORDS = ['apple', 'garden', 'secret', 'escalator', 'password', 'treasure', 'mystery', 'elevator', 'sandbox', 'supervisor',
  'hidden', 'puzzle', 'rabbit', 'shadow', 'dragon', 'wizard', 'silence', 'journey', 'keystone', 'gravity', 'compass', 'lantern',
  'meadow', 'phoenix', 'harbor']

// ---- Reading the output ----

test('a soft failure is an output that reports a failure in its own words', async () => {
  for (const text of [
    GUESS,
    'FAILED: adds with carry policy (expected 5, got 4)',
    'Traceback (most recent call last):\n  File "t.py", line 3\nAssertionError: 4 != 5',
    'src/a.ts(3,5): error TS2322: Type string is not assignable to type number.',
    'error[E0308]: mismatched types',
    'Error: Cannot find module ./lib',
    'TypeError: x is not a function',
    '  ✗ adds two numbers',
    '  ✕ adds two numbers',
    'not ok 1 - adds two numbers',
    'panic: runtime error: index out of range',
    'Build failed with 2 errors',
  ]) expect({ text, soft: softFailure(text) }).toEqual({ text, soft: true })
})

test('a normal output is not a soft failure, even when it names failures it did not have', async () => {
  for (const text of [
    '', 'ok', 'Compiled successfully in 1.2s', 'On branch main\nnothing to commit, working tree clean',
    'Found 0 errors.', 'no failures', 'All checks passed, 0 failed', 'error handling: done', 'src/errors.ts\nsrc/fail-safe.ts',
  ]) expect({ text, soft: softFailure(text) }).toEqual({ text, soft: false })
  expect(softFailure(undefined as unknown as string)).toBe(false)
})

test('the normalised output drops what changes between identical runs', async () => {
  const esc = String.fromCharCode(27)
  const a = `${esc}[31mFAIL${esc}[0m check at 2026-10-16T09:12:44.512Z (took 132ms)\nrun id 3f9a2c41be, pid 48213\nlog in /tmp/check-AbC123/out.log\n  after 0.84s`
  const b = 'FAIL check at 2026-10-17 18:01:02 (took 7 ms)\nrun id 9c0d1e2f3a, pid 1177\nlog in /tmp/check-zz9/out.log\n  after 12.5s'
  expect(normalizeOutput(a)).toBe(normalizeOutput(b))
  expect(outputPrint(a)).toBe(outputPrint(b))
  // Windows temporary folders and timestamps of the clock alone go too.
  expect(normalizeOutput('FAIL at 09:12:44 in C:\\Users\\me\\AppData\\Local\\Temp\\x1\\a.log'))
    .toBe(normalizeOutput('FAIL at 10:00:01 in C:\\Users\\me\\AppData\\Local\\Temp\\y2\\a.log'))
})

test('a different failure, or the same one with other small numbers, is another output', async () => {
  expect(outputPrint('FAIL: expected 4, got 5')).not.toBe(outputPrint('FAIL: expected 4, got 6'))
  expect(outputPrint('FAIL: digest mismatch')).not.toBe(outputPrint('FAIL: file missing'))
  // The print is a short hash: no output text in it.
  expect(outputPrint(GUESS)).toBe(hashKey(normalizeOutput(GUESS)))
  expect(outputPrint(GUESS)).not.toContain('answer')
})

test('a very long output is fingerprinted from its head and tail, quickly', async () => {
  const big = 'FAIL start\n' + 'line of noise\n'.repeat(200_000) + 'FAIL end'
  const t0 = Date.now()
  expect(outputPrint(big)).toBe(outputPrint(big))
  expect(Date.now() - t0).toBeLessThan(1000)
})

// ---- Features ----

test('features of a shell call that exits 0 but reports a failure carry the output print and the command hash', async () => {
  const f = features(guess('apple'))
  expect(f).toEqual({ attempts: 0, sig: '', counts: [], out: outputPrint(GUESS), cmd: hashKey(normalizeCommand(guess('apple').summary)) })
  expect(normalizeCommand('  npm   test \n -- -t x ')).toBe('npm test -- -t x')
  expect(features({ tool: 'PowerShell', ok: true, text: GUESS, summary: 'pwsh ./check.ps1' }).out).toBe(outputPrint(GUESS))
})

test('no output print for other tools, failed calls, refusals, test summaries or a normal output', async () => {
  expect(features({ tool: 'Read', ok: true, text: GUESS, summary: '/notes.md' }).out).toBeUndefined()
  expect(features({ tool: 'Grep', ok: true, text: 'src/a.ts: throw new Error: x', summary: 'Error' }).out).toBeUndefined()
  expect(features({ tool: 'Bash', ok: false, text: GUESS, summary: 'bash check.sh' }).out).toBeUndefined()
  expect(features({ tool: 'Bash', ok: true, text: `${GUESS}\nexit=1`, summary: 'bash check.sh; echo "exit=$?"' }).out).toBeUndefined()
  expect(features({ tool: 'Bash', ok: true, text: 'FAIL src/a.test.ts\nTests: 1 failed, 3 passed', summary: 'npx jest | tail' }).out).toBeUndefined()
  expect(features({ tool: 'Bash', ok: true, text: 'Compiled successfully', summary: 'npm run build' }).out).toBeUndefined()
  expect(features({ tool: 'Bash', ok: false, text: 'Permission to use Bash with command x has been denied.', summary: 'x' }).out).toBeUndefined()
})

// ---- Score ----

const run = (s: AgentState, obs: Observation[]): { state: AgentState; acts: { act: Action; call: number }[] } => {
  const acts: { act: Action; call: number }[] = []
  obs.forEach((ob, i) => {
    const r = observe(s, ob, DEFAULT_CONFIG)
    if (r.action) acts.push({ act: r.action, call: i + 1 })
    s = r.state
  })
  return { state: s, acts }
}

test('the same failure output for a new attempt adds half a point from its second sighting', async () => {
  expect(REPEAT_OUTPUT_WEIGHT).toBe(0.5)
  let s = newAgent('a1', 'x', 'opus', 't')
  s = observe(s, guess('apple')).state
  expect(s.score).toBe(0)
  s = observe(s, guess('garden')).state
  expect(s.score).toBe(0.5)
  s = observe(s, guess('secret')).state
  expect(s.score).toBe(1)
  // It is no failed attempt: no error count, nothing for the senior's error ring.
  expect(s.errorCounts).toEqual({})
  expect(s.recentErrors).toBeUndefined()
})

test('the exit-0 guesser climbs to a swap within its 25 attempts, never faster than a nudge at the 7th', async () => {
  const { acts } = run(newAgent('a1', 'x', 'haiku', 'guess'), WORDS.map(guess))
  expect(acts).toEqual([{ act: 'nudge', call: 7 }, { act: 'consult', call: 13 }, { act: 'swap', call: 19 }])
})

test('the same command with the same output and no edit in between is a re-read: it adds nothing', async () => {
  let s = newAgent('a1', 'x', 'haiku', 't')
  // (A bare "FAIL" line would be a failed go test run, read by the test parser: not this signal.)
  const tailLog: Observation = { tool: 'Bash', ok: true, text: 'Error: connection refused\nretrying', summary: 'tail -2 server.log' }
  expect(features(tailLog).out).toBeDefined()
  for (let i = 0; i < 30; i++) s = observe(s, tailLog).state
  expect(s.score).toBe(0)
  expect(s.level).toBe(0)
})

test('the same command after an edit with the same failure output again counts', async () => {
  let s = newAgent('a1', 'x', 'opus', 't')
  const check: Observation = { tool: 'Bash', ok: true, text: 'FAILED: adds with carry policy', summary: 'bash test.sh | tail -3' }
  const edit: Observation = { tool: 'Edit', ok: true, text: 'ok', summary: '/src/lib.sh' }
  s = observe(s, check).state
  s = observe(s, check).state
  expect(s.score).toBe(0)
  s = observe(s, edit).state
  s = observe(s, check).state
  expect(s.score).toBe(0.5)
  s = observe(s, edit).state
  s = observe(s, check).state
  expect(s.score).toBe(1)
})

test('a clean build repeated after every edit never counts: there is no failure in it', async () => {
  let s = newAgent('a1', 'x', 'haiku', 't')
  for (let i = 0; i < 30; i++) {
    s = observe(s, { tool: 'Edit', ok: true, text: 'ok', summary: `/src/f${i}.ts` }).state
    s = observe(s, { tool: 'Bash', ok: true, text: 'Compiled successfully', summary: 'npm run build' }).state
  }
  expect(s.score).toBe(0)
})

test('parallel calls of one assistant message with the same failure output count once', async () => {
  let s = newAgent('a1', 'x', 'opus', 't')
  s = decide(s, { ...features(guess('apple')), group: 1 }).state
  s = decide(s, { ...features(guess('garden')), group: 2 }).state
  expect(s.score).toBe(0.5)
  s = decide(s, { ...features(guess('secret')), group: 3 }).state
  s = decide(s, { ...features(guess('mystery')), group: 3 }).state
  s = decide(s, { ...features(guess('rabbit')), group: 3 }).state
  expect(s.score).toBe(1)
})

test('progress forgets the outputs seen; a run end keeps them; a resume forgets them', async () => {
  let s = newAgent('a1', 'x', 'opus', 't')
  s = observe(s, guess('apple')).state
  expect(Object.keys(s.outputs ?? {}).length).toBe(1)
  expect(endRun(s).outputs).toEqual(s.outputs)
  expect(resumeAgent(s).outputs).toEqual({})
  s = observe(s, { tool: 'Bash', ok: true, text: 'Tests: 2 failed, 3 passed', summary: 'npm test' }).state
  s = observe(s, { tool: 'Bash', ok: true, text: 'Tests: 1 failed, 4 passed', summary: 'npm test' }).state
  expect(s.outputs).toEqual({})
  s = observe(s, guess('garden')).state
  expect(s.score).toBe(0)
})

test('only the latest outputs are remembered', async () => {
  let s = newAgent('a1', 'x', 'opus', 't')
  for (let i = 0; i < 60; i++) s = observe(s, { tool: 'Bash', ok: true, text: `FAIL: case ${'x'.repeat(i)}`, summary: `t ${i}` }).state
  expect(Object.keys(s.outputs ?? {}).length).toBe(20)
})

test('an agent without outputs (no soft failure seen) has no such field', async () => {
  const s = observe(newAgent('a1', 'x', 'opus', 't'), { tool: 'Bash', ok: true, text: 'ok', summary: 'ls' }).state
  expect('outputs' in s).toBe(false)
})

test('observe logs a soft failure as such', async () => {
  const r = observe(newAgent('a1', 'x', 'haiku', 'fix'), guess('apple'))
  // Still an "ok" line for the dossier's parser: the call did not fail, its output only says so.
  expect(r.state.log[0]).toContain('-> ok (the output reports a failure)')
})

// ---- State ----

test('the outputs seen survive a snapshot; a malformed map is dropped', async () => {
  const base = newAgent('a', 'x', 'haiku', 't')
  const snap = (outputs: unknown) => parseSnapshot({
    agents: [{ ...base, outputs }], ledger: {}, seenModels: {}, sessionTag: 't', mode: 'active', baseline: 'sonnet', baselinePinned: false,
  })!.agents[0]!
  expect(snap({ k1: { c: 'h1', e: 2 } }).outputs).toEqual({ k1: { c: 'h1', e: 2 } })
  for (const bad of [5, 'x', [], { k1: 3 }, { k1: { c: 1, e: 2 } }, { k1: { c: 'h', e: -1 } }, { k1: { c: 'h', e: 1.5 } }]) {
    expect(snap(bad).outputs).toBeUndefined()
  }
})

// ---- Recording and replay ----

test('a tool event keeps the output print and the command hash, never the text', async () => {
  const live = startRecording('s1', 1_000_000, 'observe', 'opus', recordedOptions(DEFAULT_CONFIG))
  const a = addAgent(live, { id: 'x1', label: 'guesser', cat: 'c', tier: 'haiku' })
  const f = features({ tool: 'Bash', ok: true, text: 'FAIL: token=hunter2hunter2 rejected', summary: 'curl -H "token: hunter2hunter2" http://x' })
  const ev = toolEvent(live, a, 1_005_000, 1_004_000, 'Bash', f)
  expect(ev).toEqual({ k: 'tool', a, at: 5000, d: 1000, t: 'Bash', o: f.out, c: f.cmd })
  expect(JSON.stringify(live.rec)).not.toContain('hunter2')
  // A normal call records neither.
  const plain = toolEvent(live, a, 1_006_000, 1_006_000, 'Bash', features({ tool: 'Bash', ok: true, text: 'ok', summary: 'ls' }))
  expect(plain).toEqual({ k: 'tool', a, at: 6000, d: 0, t: 'Bash' })
})

function recordingOf(tier: 'haiku' | 'sonnet' | 'opus', feats: Features[]): Recording {
  const live = startRecording('r', 0, 'active', 'opus', recordedOptions(DEFAULT_CONFIG))
  const a = addAgent(live, { id: 'x', label: 'x', cat: 'c', tier })
  let at = 0
  push(live, { k: 'boot', at })
  push(live, { k: 'spawn', a, at: (at += 1000), asked: tier, tier })
  for (const f of feats) {
    push(live, { k: 'step', a, at: (at += 1000), d: 0, m: tier })
    push(live, toolEvent(live, a, (at += 1000), at, f.edit ? 'Edit' : 'Bash', f))
  }
  push(live, { k: 'end', a, at: (at += 1000) })
  return live.rec
}

test('a replay scores the recorded output prints exactly as the live detector did', async () => {
  const obs = WORDS.map(guess)
  const live = run(newAgent('x', 'c', 'haiku', ''), obs).acts
  const replayed = replaySession(recordingOf('haiku', obs.map(features)), DEFAULT_CONFIG).agents[0]!.candidate
  expect(replayed.map((h) => ({ act: h.act, call: h.call }))).toEqual(live)
})

test('a recording made before output prints replays as before: the signal is silent', async () => {
  const old = recordingOf('haiku', WORDS.map(guess).map(features))
  for (const e of old.events) if (e.k === 'tool') { delete e.o; delete e.c }
  expect(replaySession(old, DEFAULT_CONFIG).agents[0]!.candidate).toEqual([])
})

// ---- Fixture: exit-0 failures and their look-alikes ----

const toFeatures = (events: (typeof EXIT_ZERO_RUNS)[number]['events']): Features[] => events.map((e) => ({
  attempts: 0, sig: '', counts: e.f ?? [], ...(e.o !== undefined ? { out: String(e.o), cmd: String(e.c ?? 0) } : {}),
  ...(e.e !== undefined ? { edit: String(e.e) } : {}),
}))

test('the exit-0 fixture: every positive is flagged, up to a swap; no look-alike is', async () => {
  const LADDER = ['nudge', 'consult', 'effort', 'swap', 'human']
  for (const r of EXIT_ZERO_RUNS) {
    const hits = replaySession(recordingOf(r.tier, toFeatures(r.events)), DEFAULT_CONFIG).agents[0]!.candidate.filter((h) => LADDER.includes(h.act))
    if (r.label === 'positive') expect({ name: r.name, swap: hits.some((h) => h.act === 'swap') }).toEqual({ name: r.name, swap: true })
    else expect({ name: r.name, hits: hits.length }).toEqual({ name: r.name, hits: 0 })
  }
})

// ---- Wiring ----

test('live: an agent whose check prints FAIL but exits 0 gets a nudge, and the recording keeps the prints', { options: { recordSessions: 5 } }, async ($, on) => {
  resetState()
  mock.env(on, {})
  const store: Record<string, unknown> = {}
  on('store.get', (_$: unknown, e: any) => ({ value: store[e.key] }))
  on('store.set', (_$: unknown, e: any) => { store[e.key] = JSON.parse(JSON.stringify(e.value)); return { value: undefined } })
  on('session.start', () => ({ cwd: '/work' }) as never)
  on('session.end', () => ({ sessionId: 's' }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  on('tool.register', (_$: unknown, e: any) => ({ value: { tool: `mcp__model-escalator__${e.name}` } }) as never)
  on('agent.spawn', (_$: unknown, e: any) => ({ model: e.model ?? 'haiku', agentId: 'a1' }))
  on('tool.call', () => ({ isError: false, result: GUESS, text: GUESS }) as never)
  on('turn.complete', () => ({ text: 'done' }) as never)
  for (const k of ['ui.log', 'ui.toast', 'ui.status'] as const) on(k, () => ({ value: undefined }) as never)
  await $.session.start({ cwd: '/work' } as never)
  const { agentId } = await $.agent.spawn({ prompt: 'p', description: 'guess the word', subagentType: 'general-purpose', model: 'haiku' } as never) as { agentId: string }
  const noted: number[] = []
  for (let i = 0; i < 8; i++) {
    const r = await $.tool.call({ tool: 'Bash', command: guess(WORDS[i]!).summary, agentId } as never) as { context?: readonly string[] }
    if ((r.context ?? []).length > 0) noted.push(i + 1)
  }
  expect(noted).toEqual([7])
  await $.turn.complete({ turnId: 't', agentId, answer: 'done' } as never)
  await $.session.end({ reason: 'exit' } as never)
  const rec = (store['recordings'] as Recording[])[0]!
  const tools = rec.events.filter((e) => e.k === 'tool')
  expect(tools.length).toBe(8)
  for (const t of tools) expect(t).toMatchObject({ o: outputPrint(GUESS) })
  expect(new Set(tools.map((t) => (t as { c?: string }).c)).size).toBe(8)
  expect(JSON.stringify(rec)).not.toContain('answer.txt')
})
