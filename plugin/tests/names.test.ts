import { expect, mock, test } from 'claude-code/testing'
import { agentHead, agentLabel, clipLabel, leadMessage, MAX_AGENT_NAME, MAX_TASK_TITLE, taskClaim, taskOfResult } from '../hooks/detector'
import { resetState } from '../hooks/register'
import { parseSnapshot } from '../hooks/state'

type Harness = { logs: string[]; toasts: string[]; sent: string[] }

// The task list answers TaskCreate with the task it made; every other tool fails for Bash and succeeds otherwise.
function wire(on: any): Harness {
  resetState()
  mock.clock(on, { now: 1_000_000 })
  mock.env(on, {})
  mock.store(on)
  const session = mock.session(on)
  const h: Harness = { logs: [], toasts: [], sent: [] }
  Object.defineProperty(h, 'sent', { get: () => session.appended().map((r: any) => String(r.message.content[0]?.text ?? '')) })
  on('session.start', () => ({ cwd: '/work' }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  let n = 0
  on('agent.spawn', (_$: unknown, e: any) => ({ model: e.model ?? 'haiku', agentId: 'a' + ++n }))
  on('tool.call', (_$: unknown, e: any) => {
    if (e.tool === 'Bash') return { isError: true, result: 'Error: boom', text: 'Error: boom' } as never
    if (e.tool === 'TaskCreate') return { result: { task: { id: '7', subject: 'Fix the date parser' } } } as never
    return { result: 'ok' } as never
  })
  on('turn.complete', () => ({ text: 'done' }) as never)
  on('turn.step', async function* (_$: unknown, e: any) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn',
      usage: { model: e.model, input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } as never
  })
  on('ui.log', (_$: unknown, e: any) => { h.logs.push(String(e.message ?? e.text ?? JSON.stringify(e))); return { value: undefined } as never })
  on('ui.toast', (_$: unknown, e: any) => { h.toasts.push(String(e.message ?? e.text ?? JSON.stringify(e))); return { value: undefined } as never })
  on('ui.status', () => ({ value: undefined }) as never)
  return h
}

const spawn = async ($: any, prompt: string, name?: string): Promise<string> =>
  ((await $.agent.spawn({ prompt, description: 'fix db test', subagentType: 'general-purpose', model: 'haiku', ...(name ? { name } : {}) } as never)) as { agentId: string }).agentId

// Twelve failing calls: enough for the first swap to be logged and announced.
async function stuck($: any, agentId: string): Promise<void> {
  for (let i = 0; i < 12; i++) await $.tool.call({ tool: 'Bash', command: 'npm test', agentId } as never)
  for (let i = 0; i < 30; i++) await Promise.resolve()
}

test('a named agent is labelled by its name in log lines and toasts', async ($, on) => {
  const h = wire(on)
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($, 'Fix the failing database test in src/db.ts', 'fixer')
  await stuck($, id)
  expect(h.logs.some((l) => l.startsWith(`fixer (${id}) (`))).toBe(true)
  expect(h.toasts.some((t) => t.startsWith('fixer: switched to sonnet'))).toBe(true)
  expect(h.sent.some((t) => t.includes(`fixer (${id})`))).toBe(true)
})

test('an unnamed subagent without a description is labelled by its id only', async ($, on) => {
  const h = wire(on)
  await $.session.start({ cwd: '/work' } as never)
  const id = ((await $.agent.spawn({ prompt: 'Fix the failing database test in src/db.ts', description: ' ', subagentType: 'general-purpose', model: 'haiku' } as never)) as { agentId: string }).agentId
  await stuck($, id)
  expect(h.logs.some((l) => l.startsWith(`${id} (`))).toBe(true)
  expect(h.logs.every((l) => !l.includes(' · task: '))).toBe(true)
  expect(h.toasts.some((t) => t.includes('switched to sonnet'))).toBe(true)
})

test('a task the agent claims with TaskUpdate titles its log lines and the lead notice', async ($, on) => {
  const h = wire(on)
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($, 'Fix the failing database test in src/db.ts', 'fixer')
  await $.tool.call({ tool: 'TaskUpdate', taskId: '9', status: 'in_progress', agentId: id } as never)
  await $.tool.call({ tool: 'TaskUpdate', taskId: '9', subject: 'Fix the date parser', status: 'in_progress', agentId: id } as never)
  await stuck($, id)
  const title = `fixer (${id}) · task: Fix the date parser (`
  expect(h.logs.some((l) => l.startsWith(title))).toBe(true)
  expect(h.sent.some((t) => t.includes(`fixer (${id}) (`) && t.includes('task: Fix the date parser'))).toBe(true)
  expect(h.sent.every((t) => !t.includes('Fix the failing database test'))).toBe(true)
})

test('a task the lead created is titled when an agent claims it without a subject', async ($, on) => {
  const h = wire(on)
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($, 'Fix the failing database test in src/db.ts', 'fixer')
  await $.tool.call({ tool: 'TaskCreate', subject: 'Fix the date parser', description: 'd' } as never)
  await $.tool.call({ tool: 'TaskUpdate', taskId: '7', status: 'in_progress', agentId: id } as never)
  await stuck($, id)
  expect(h.logs.some((l) => l.includes(`fixer (${id}) · task: Fix the date parser`))).toBe(true)
})

test('long names and task titles are capped in logs', async ($, on) => {
  const h = wire(on)
  await $.session.start({ cwd: '/work' } as never)
  const id = await spawn($, 'prompt', 'n'.repeat(60))
  await $.tool.call({ tool: 'TaskUpdate', taskId: '9', subject: 'y'.repeat(200), status: 'in_progress', agentId: id } as never)
  await stuck($, id)
  const line = h.logs.find((l) => l.includes(` (${id}) · task: `))
  expect(line).toBeDefined()
  expect(line!.includes('n'.repeat(MAX_AGENT_NAME + 1))).toBe(false)
  expect(line!.includes('y'.repeat(MAX_TASK_TITLE + 1))).toBe(false)
  expect(line!.includes('n'.repeat(MAX_AGENT_NAME - 3) + '...')).toBe(true)
  expect(line!.includes('y'.repeat(MAX_TASK_TITLE - 3) + '...')).toBe(true)
})

test('clipLabel flattens, caps with an ellipsis and drops empty or non-text values', () => {
  expect(clipLabel('  a \n  b  ', 40)).toBe('a b')
  expect(clipLabel('x'.repeat(40), 40)).toBe('x'.repeat(40))
  expect(clipLabel('x'.repeat(41), 40)).toBe('x'.repeat(37) + '...')
  expect(clipLabel('   ', 40)).toBeUndefined()
  expect(clipLabel(42, 40)).toBeUndefined()
  expect(clipLabel(undefined, 40)).toBeUndefined()
})

test('agentHead and agentLabel show the name, the id and the task title when known', () => {
  expect(agentHead({ id: 'a1' })).toBe('a1')
  expect(agentHead({ id: 'a1', name: 'fixer' })).toBe('fixer (a1)')
  expect(agentLabel({ id: 'a1' })).toBe('a1')
  expect(agentLabel({ id: 'a1', taskTitle: 'Fix it' })).toBe('a1 · task: Fix it')
  expect(agentLabel({ id: 'a1', name: 'fixer', taskTitle: 'Fix the date parser' })).toBe('fixer (a1) · task: Fix the date parser')
})

test('taskClaim: a created task is the creator\'s, an in_progress update claims the task', () => {
  const subjects = new Map([['7', 'Known subject']])
  expect(taskClaim('TaskCreate', { subject: 'Made it' }, subjects)).toBe('Made it')
  expect(taskClaim('TaskUpdate', { taskId: '9', subject: 'Given', status: 'in_progress' }, subjects)).toBe('Given')
  expect(taskClaim('TaskUpdate', { taskId: '7', status: 'in_progress' }, subjects)).toBe('Known subject')
  expect(taskClaim('TaskUpdate', { taskId: '7', status: 'completed' }, subjects)).toBeUndefined()
  expect(taskClaim('TaskUpdate', { taskId: '8', status: 'in_progress' }, subjects)).toBeUndefined()
  expect(taskClaim('Bash', { command: 'ls' }, subjects)).toBeUndefined()
})

test('taskOfResult reads the task a task-list answer carries', () => {
  expect(taskOfResult({ task: { id: '7', subject: 'Fix it' } })).toEqual({ id: '7', subject: 'Fix it' })
  expect(taskOfResult({ task: { id: 7, subject: 'Fix it' } })).toEqual({ id: '7', subject: 'Fix it' })
  expect(taskOfResult({ success: true })).toBeUndefined()
  expect(taskOfResult('text')).toBeUndefined()
})

test('leadMessage names the agent and shows its task title instead of the prompt', () => {
  const m = leadMessage({ id: 'a1', name: 'fixer', category: 'bugfix', task: 'the long prompt', taskTitle: 'Fix the date parser' },
    { kind: 'swap', tier: 'opus' }, false)
  expect(m).toContain('fixer (a1) (bugfix, task: Fix the date parser)')
  expect(m).not.toContain('the long prompt')
})

const base = { ledger: {}, seenModels: {}, sessionTag: 't', mode: 'active', baseline: 'opus', baselinePinned: false }
const agent = (extra: Record<string, unknown> = {}) => ({ id: 'a1', category: 'bugfix', task: 'x', startTier: 'haiku', tier: 'haiku',
  score: 0, level: 0, stepsSinceAction: 0, stepsSinceProgress: 0, errorCounts: {}, editCounts: {}, log: [], tokens: 0, ...extra })

test('names and task titles survive a snapshot round trip', () => {
  const saved = JSON.parse(JSON.stringify({ ...base, agents: [agent({ name: 'fixer', taskTitle: 'Fix the date parser' })] }))
  const back = parseSnapshot(saved)
  expect(back!.agents[0]!.name).toBe('fixer')
  expect(back!.agents[0]!.taskTitle).toBe('Fix the date parser')
})

test('a snapshot with long or malformed names and titles is capped or dropped', () => {
  const back = parseSnapshot({ ...base, agents: [agent({ name: 'n'.repeat(60), taskTitle: 'y'.repeat(200) }), agent({ id: 'a2', name: 5, taskTitle: '  ' })] })
  expect(back!.agents[0]!.name).toBe('n'.repeat(MAX_AGENT_NAME - 3) + '...')
  expect(back!.agents[0]!.taskTitle).toBe('y'.repeat(MAX_TASK_TITLE - 3) + '...')
  expect('name' in back!.agents[1]!).toBe(false)
  expect('taskTitle' in back!.agents[1]!).toBe(false)
})

test('a snapshot saved before names existed hydrates without them', () => {
  const back = parseSnapshot({ ...base, agents: [agent()] })
  expect(back).toBeDefined()
  expect(back!.agents[0]!.id).toBe('a1')
  expect('name' in back!.agents[0]!).toBe(false)
  expect('taskTitle' in back!.agents[0]!).toBe(false)
})
