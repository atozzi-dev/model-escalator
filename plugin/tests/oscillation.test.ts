import { expect, test } from 'claude-code/testing'
import { DEFAULT_CONFIG, parseConfig } from '../hooks/config'
import { newAgent, observe, type AgentState } from '../hooks/detector'
import { parseSnapshot } from '../hooks/state'

const edit = (file: string, tool = 'Edit', ok = true, text = 'edited') => ({ tool, ok, text, summary: file })
const apply = (s: AgentState, file: string, n: number, tool = 'Edit') => {
  for (let i = 0; i < n; i++) s = observe(s, edit(file, tool)).state
  return s
}

test('the oscillation threshold defaults to 3 and is parsed from options', async () => {
  expect(DEFAULT_CONFIG.oscillationEdits).toBe(3)
  expect(parseConfig({ oscillationEdits: '5' }).oscillationEdits).toBe(5)
  expect(parseConfig({ oscillationEdits: '0' }).oscillationEdits).toBe(3)
  expect(parseConfig({ oscillationEdits: 'x' }).oscillationEdits).toBe(3)
})

test('only the fourth edit of the same file starts adding to the score', async () => {
  let s = apply(newAgent('a', 'x', 'haiku', 't'), '/src/a.ts', 3)
  expect(s.score).toBe(0)
  s = apply(s, '/src/a.ts', 1)
  expect(s.score).toBe(1)
})

test('repeated edits of one file escalate even when error text varies', async () => {
  let s = newAgent('a', 'x', 'haiku', 't')
  const actions: (string | undefined)[] = []
  for (let i = 0; i < 8; i++) {
    const r = observe(s, edit('/src/a.ts', 'Edit', i % 2 === 0, `different failure ${'x'.repeat(i * 3)} q${i}z`))
    s = r.state
    actions.push(r.action)
  }
  expect(actions.filter(Boolean)[0]).toBe('nudge')
})

test('edits spread over different files do not escalate', async () => {
  let s = newAgent('a', 'x', 'haiku', 't')
  for (let i = 0; i < 20; i++) s = observe(s, edit(`/src/f${i}.ts`)).state
  expect(s.score).toBe(0)
  expect(s.level).toBe(0)
})

test('all edit tools count, other tools do not', async () => {
  for (const tool of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']) {
    expect(apply(newAgent('a', 'x', 'opus', 't'), '/src/a.ts', 4, tool).score).toBe(1)
  }
  expect(apply(newAgent('a', 'x', 'opus', 't'), '/src/a.ts', 6, 'Read').score).toBe(0)
})

test('progress clears the edit counts', async () => {
  let s = apply(newAgent('a', 'x', 'opus', 't'), '/src/a.ts', 3)
  s = observe(s, { tool: 'Bash', ok: true, text: '10 passed', summary: 'npm test' }).state
  expect(s.editCounts).toEqual({})
  s = apply(s, '/src/a.ts', 3)
  expect(s.score).toBe(0)
})

test('Windows and POSIX forms of the same file count together', async () => {
  let s = newAgent('a', 'x', 'opus', 't')
  for (const f of ['C:\\Proj\\src\\a.ts', 'c:/proj/src/A.ts', 'C:\\Proj\\src/a.ts', 'c:\\proj\\src\\a.ts']) s = observe(s, edit(f)).state
  expect(s.score).toBe(1)
  let p = newAgent('b', 'x', 'opus', 't')
  for (const f of ['/src/a.ts', '/src/a.ts', '/src/A.ts', '/src/a.ts']) p = observe(p, edit(f)).state
  expect(p.score).toBe(0) // POSIX paths stay case-sensitive
})

test('a snapshot saved before edit counts still hydrates', async () => {
  const { editCounts: _omit, ...old } = newAgent('a', 'x', 'haiku', 't')
  const snap = parseSnapshot({
    agents: [old], ledger: {}, seenModels: {}, sessionTag: 't', mode: 'active', baseline: 'sonnet', baselinePinned: false,
  })
  expect(snap?.agents[0]?.editCounts).toEqual({})
  const r = observe(snap!.agents[0]!, edit('/src/a.ts'))
  expect(r.state.editCounts).toEqual({ '/src/a.ts': 1 })
})
