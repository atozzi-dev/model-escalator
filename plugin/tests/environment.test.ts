import { expect, mock, test } from 'claude-code/testing'
import { DEFAULT_CONFIG } from '../hooks/config'
import { decide, environmentError, features, newAgent, observe, type AgentState } from '../hooks/detector'
import type { Recording } from '../hooks/recorder'
import { resetState } from '../hooks/register'

// Results the engine gave before the tool did anything, as the model read them (texts from real sessions, paths shortened).
const REFUSALS = [
  "This agent is isolated in the worktree C:\\w\\.claude\\worktrees\\agent-a1, but this command is too complex to verify that it stays inside the worktree. Refusing to run it — a worktree-isolated agent's git operations must target its own worktree.",
  'Refusing to use c:\\w\\.claude\\worktrees\\agent-a1 as an isolation worktree: git resolves its working tree to C:/w (a core.worktree redirect)',
  'Permission for this action was denied by the Claude Code auto mode classifier. Reason: [Irreversible Local Destruction]. If you have other tasks',
  'Permission for this command was denied by a built-in Claude Code safety check, not by the user.',
  'Permission for this action has been denied. Reason: outside the project',
  'Permission to use Bash with command rm -rf build has been denied.',
  'Permission to use WebFetch has been denied.',
  "Read in 'C:\\w\\.env' was blocked by a deny rule",
  'The server-side auto mode classifier gave no verdict (error), so auto mode cannot determine the safety of Bash.',
  "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file).",
  'This Bash command contains multiple operations. The following parts require approval: ls -la ~/.claude/skills',
  'PreToolUse hook did not respond before its timeout (host client may be unreachable). The tool call was not executed.',
  'PreToolUse:Bash hook error: [python3 guard.py]: commands outside the repository are not allowed',
  'Operation stopped by hook: not now',
  '<tool_use_error>File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.</tool_use_error>',
  '<tool_use_error>File has not been read yet. Read it first before writing to it.</tool_use_error>',
  '<tool_use_error>Blocked: standalone sleep 110. To wait for a condition, use Monitor with an until-loop.</tool_use_error>',
  '<tool_use_error>Blocked: sleep 60 followed by: curl -s https://example.com. To wait for a condition, use Monitor.</tool_use_error>',
  '<tool_use_error>[supervisor:52d79f] You are paused by the supervisor: a human has to step in.</tool_use_error>',
]

// Real failures of the agent's own work: they keep their weight.
const FAILURES = [
  'Exit code 1\nFAILED: adds with carry policy (expected 5, got 4)\n1 failed, 1 passed',
  "Exit code 1\nrm: cannot remove 'build/out': Permission denied",
  'Exit code 1\n  ✗ reports permission denied when the token is missing\n 3 pass\n 1 fail',
  'Exit code 2\nError: Permission to use the cache has been denied by the server (403)',
  '<tool_use_error>String to replace not found in file.\nString: const a = 1</tool_use_error>',
  '<tool_use_error>Found 2 matches of the string to replace, but replace_all is false.</tool_use_error>',
  'Exit code 1\nThis agent is isolated in the worktree, the test says',
  'Exit code 1\nsleep: invalid time interval',
]

test('engine refusals are environment errors', async () => {
  for (const text of REFUSALS) expect({ text, env: environmentError(text) }).toEqual({ text, env: true })
})

test('failures of the agent itself are not, even when they mention a permission or a refusal', async () => {
  for (const text of FAILURES) expect({ text, env: environmentError(text) }).toEqual({ text, env: false })
  expect(environmentError('')).toBe(false)
  expect(environmentError(undefined as unknown as string)).toBe(false)
})

test('an environment error has no attempt, no signature, no test count and no edit, and is marked', async () => {
  const f = features({ tool: 'Edit', ok: false, text: REFUSALS[14]!, summary: '/src/a.ts' })
  expect(f).toEqual({ attempts: 0, sig: '', counts: [], env: true })
  // A successful result is never one, whatever it says (a file that quotes a refusal, for instance).
  expect(features({ tool: 'Read', ok: true, text: REFUSALS[0]!, summary: '/notes.md' }).env).toBeUndefined()
})

test('environment errors add no score, no error count and no step of the grace window', async () => {
  let s: AgentState = newAgent('a1', 'x', 'haiku', 'fix')
  for (let i = 0; i < 20; i++) {
    for (const text of REFUSALS) {
      const r = observe(s, { tool: 'Bash', ok: false, text, summary: 'git status; echo' })
      expect(r.action).toBeUndefined()
      s = r.state
    }
  }
  expect(s.score).toBe(0)
  expect(s.errorCounts).toEqual({})
  expect(s.stepsSinceAction).toBe(0)
  expect(s.recentErrors).toBeUndefined()
})

// Wiring: an agent whose calls the engine keeps refusing gets no note, and the recording marks each refusal.
test('a run of refused calls never reaches the ladder and is recorded as refused', { options: { recordSessions: 5 } }, async ($, on) => {
  resetState()
  mock.env(on, {})
  const store: Record<string, unknown> = {}
  on('store.get', (_$: unknown, e: any) => ({ value: store[e.key] }))
  on('store.set', (_$: unknown, e: any) => { store[e.key] = JSON.parse(JSON.stringify(e.value)); return { value: undefined } })
  on('session.start', () => ({ cwd: '/work' }) as never)
  on('session.end', () => ({ sessionId: 's' }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  on('agent.spawn', (_$: unknown, e: any) => ({ model: e.model ?? 'haiku', agentId: 'a1' }))
  on('tool.call', () => ({ isError: true, result: REFUSALS[0], text: REFUSALS[0] }) as never)
  on('turn.complete', () => ({ text: 'done' }) as never)
  for (const k of ['ui.log', 'ui.toast', 'ui.status'] as const) on(k, () => ({ value: undefined }) as never)
  await $.session.start({ cwd: '/work' } as never)
  const { agentId } = await $.agent.spawn({ prompt: 'p', description: 'fix the parser', subagentType: 'general-purpose', model: 'haiku' } as never) as { agentId: string }
  const notes: string[] = []
  for (let i = 0; i < 30; i++) {
    const r = await $.tool.call({ tool: 'Bash', command: 'git status; echo done', agentId } as never) as { context?: readonly string[] }
    notes.push(...(r.context ?? []))
  }
  expect(notes).toEqual([])
  await $.turn.complete({ turnId: 't', agentId, answer: 'done' } as never)
  await $.session.end({ reason: 'exit' } as never)
  const rec = (store['recordings'] as Recording[])[0]!
  const tools = rec.events.filter((e) => e.k === 'tool')
  expect(tools.length).toBe(30)
  for (const t of tools) expect(t).toMatchObject({ env: 1 })
})

test('the same refusals as plain failures would have escalated', async () => {
  let s: AgentState = newAgent('a1', 'x', 'haiku', 'fix')
  const acts: string[] = []
  for (let i = 0; i < 12; i++) {
    const r = decide(s, { attempts: 1, sig: 'refused', counts: [] }, DEFAULT_CONFIG)
    if (r.action) acts.push(r.action)
    s = r.state
  }
  expect(acts.length).toBeGreaterThan(0)
})
