import { expect, test } from 'claude-code/testing'
import { DEFAULT_CONFIG, parseConfig } from '../hooks/config'
import { newAgent, observe, type AgentState } from '../hooks/detector'
import { parseSnapshot } from '../hooks/state'

const OSC = DEFAULT_CONFIG.oscillationEdits
const edit = (file: string, tool = 'Edit', ok = true, text = 'edited') => ({ tool, ok, text, summary: file })
// A failed attempt with its own error text each time, so only the oscillation can add more than 0.25 per failure.
let n = 0
const fail = () => ({ tool: 'Bash', ok: false, text: `Error: case ${'x'.repeat(++n % 50)} broke`, summary: 'npm test' })
// `k` rounds of: edit the file, then a failed attempt.
const rounds = (s: AgentState, file: string, k: number, tool = 'Edit') => {
  for (let i = 0; i < k; i++) {
    s = observe(s, edit(file, tool)).state
    s = observe(s, fail()).state
  }
  return s
}
const editsOf = (s: AgentState, file: string) => s.retryEdits?.[file] ?? 0

test('the oscillation threshold is parsed from options', async () => {
  expect(parseConfig({ oscillationEdits: '7' }).oscillationEdits).toBe(7)
  expect(parseConfig({ oscillationEdits: '0' }).oscillationEdits).toBe(OSC)
  expect(parseConfig({ oscillationEdits: 'x' }).oscillationEdits).toBe(OSC)
})

test('edits with no failed attempt in between are normal work: they never count', async () => {
  let s = newAgent('a', 'x', 'haiku', 't')
  for (let i = 0; i < 40; i++) s = observe(s, edit('/src/a.ts')).state
  expect(s.score).toBe(0)
  expect(editsOf(s, '/src/a.ts')).toBe(0)
})

test('an edit counts when an attempt failed since the previous edit of that file', async () => {
  let s = newAgent('a', 'x', 'haiku', 't')
  s = observe(s, edit('/src/a.ts')).state          // nothing failed yet
  s = observe(s, edit('/src/a.ts')).state          // nothing failed in between
  expect(editsOf(s, '/src/a.ts')).toBe(0)
  s = observe(s, fail()).state
  s = observe(s, edit('/src/a.ts')).state          // after a failure: counts
  s = observe(s, edit('/src/a.ts')).state          // no new failure: does not
  expect(editsOf(s, '/src/a.ts')).toBe(1)
  // The failure counts for every file edited after it.
  s = observe(s, fail()).state
  s = observe(s, edit('/src/a.ts')).state
  s = observe(s, edit('/src/b.ts')).state
  expect(editsOf(s, '/src/a.ts')).toBe(2)
  expect(editsOf(s, '/src/b.ts')).toBe(1)
})

test('past the tolerated edits, each further edit after a failure adds a point', async () => {
  let s = newAgent('a', 'x', 'opus', 't')
  s = observe(s, fail()).state
  s = rounds(s, '/src/a.ts', OSC)
  const before = s.score
  s = observe(s, edit('/src/a.ts')).state
  expect(s.score).toBe(before + 1)
})

test('repeated edits of one file between failures escalate even when the error text varies', async () => {
  let s = newAgent('a', 'x', 'haiku', 't')
  const actions: (string | undefined)[] = []
  for (let i = 0; i < OSC + 6; i++) {
    for (const ob of [edit('/src/a.ts'), fail()]) {
      const r = observe(s, ob)
      s = r.state
      actions.push(r.action)
    }
  }
  expect(actions.filter(Boolean)[0]).toBe('nudge')
})

test('edits spread over different files do not escalate', async () => {
  let s = newAgent('a', 'x', 'haiku', 't')
  for (let i = 0; i < 20; i++) {
    s = observe(s, edit(`/src/f${i}.ts`)).state
    s = observe(s, { tool: 'Bash', ok: true, text: 'built', summary: 'make' }).state
  }
  expect(s.score).toBe(0)
  expect(s.level).toBe(0)
})

test('all edit tools count, other tools do not', async () => {
  for (const tool of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']) {
    const s = rounds(observe(newAgent('a', 'x', 'opus', 't'), fail()).state, '/src/a.ts', OSC + 1, tool)
    expect(editsOf(s, '/src/a.ts')).toBe(OSC + 1)
  }
  expect(editsOf(rounds(newAgent('a', 'x', 'opus', 't'), '/src/a.ts', OSC + 3, 'Read'), '/src/a.ts')).toBe(0)
})

test('progress clears the edit counts', async () => {
  let s = rounds(observe(newAgent('a', 'x', 'opus', 't'), fail()).state, '/src/a.ts', 3)
  expect(editsOf(s, '/src/a.ts')).toBe(3)
  s = observe(s, { tool: 'Bash', ok: true, text: '10 passed', summary: 'npm test' }).state
  expect(s.editCounts).toEqual({})
  expect(s.retryEdits).toEqual({})
  // After progress the next edit needs a new failure to count.
  s = observe(s, edit('/src/a.ts')).state
  expect(s.editCounts).toEqual({ '/src/a.ts': 1 })
  expect(editsOf(s, '/src/a.ts')).toBe(0)
})

test('every edit is still counted for the senior dossier, failure or not', async () => {
  let s = newAgent('a', 'x', 'haiku', 't')
  for (let i = 0; i < 4; i++) s = observe(s, edit('/src/a.ts')).state
  s = observe(s, fail()).state
  s = observe(s, edit('/src/a.ts')).state
  expect(s.editCounts).toEqual({ '/src/a.ts': 5 })
  expect(editsOf(s, '/src/a.ts')).toBe(1)
})

test('Windows and POSIX forms of the same file count together', async () => {
  let s = newAgent('a', 'x', 'opus', 't')
  for (const f of ['C:\\Proj\\src\\a.ts', 'c:/proj/src/A.ts', 'C:\\Proj\\src/a.ts', 'c:\\proj\\src\\a.ts']) {
    s = observe(s, fail()).state
    s = observe(s, edit(f)).state
  }
  expect(editsOf(s, 'c:/proj/src/a.ts')).toBe(4)
  let p = newAgent('b', 'x', 'opus', 't')
  for (const f of ['/src/a.ts', '/src/a.ts', '/src/A.ts', '/src/a.ts']) {
    p = observe(p, fail()).state
    p = observe(p, edit(f)).state
  }
  expect(editsOf(p, '/src/a.ts')).toBe(3) // POSIX paths stay case-sensitive
  expect(editsOf(p, '/src/A.ts')).toBe(1)
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

test('a snapshot keeps the oscillation counters only when they are well formed', async () => {
  const base = { ...newAgent('a', 'x', 'haiku', 't') }
  const snap = (m: unknown) => parseSnapshot({
    agents: [{ ...base, editMarks: m, retryEdits: m }], ledger: {}, seenModels: {}, sessionTag: 't', mode: 'active', baseline: 'sonnet', baselinePinned: false,
  })!.agents[0]!
  expect(snap({ '/src/a.ts': 2 })).toMatchObject({ editMarks: { '/src/a.ts': 2 }, retryEdits: { '/src/a.ts': 2 } })
  for (const bad of [{ '/src/a.ts': 'x' }, [1], { '/src/a.ts': -1 }]) {
    expect(snap(bad).editMarks).toBeUndefined()
    expect(snap(bad).retryEdits).toBeUndefined()
  }
  // Older snapshots have neither: the agent goes on with fresh counters.
  const old = snap(undefined)
  expect(observe(observe(old, fail()).state, edit('/src/a.ts')).state.retryEdits).toEqual({ '/src/a.ts': 1 })
})
