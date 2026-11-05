import { expect, test } from 'claude-code/testing'
import {
  emptyLeadTurn, fileGroup, hintText, isWritingSpawn, leadWork, LEAD_WINDOW_MS, LEAD_WINDOW_TURNS, noteLeadCall,
  pushTurn, shouldHint, type LeadTurn, type LeadWork,
} from '../hooks/lead-work'
import { parseSnapshot } from '../hooks/state'

const ROOT = 'C:/Projects/app'
const write = (path: string, lines: number) => ({ tool: 'Write', file_path: path, content: 'x\n'.repeat(lines) })
const edit = (path: string, lines: number) => ({ tool: 'Edit', file_path: path, old_string: 'a', new_string: 'b\n'.repeat(lines) })

const work = (over: Partial<LeadWork> = {}): LeadWork => ({ files: 0, groups: 0, lines: 0, cost: 0, spawns: 0, ...over })
const turn = (over: Partial<LeadTurn> = {}): LeadTurn => ({ ...emptyLeadTurn(), ...over })

test('fileGroup takes the first folder under the project root, and "." for root-level files', () => {
  expect(fileGroup('C:/Projects/app/src/db/a.ts', ROOT)).toBe('src')
  expect(fileGroup('C:\\Projects\\app\\src\\db\\a.ts', ROOT)).toBe('src')
  expect(fileGroup('C:/Projects/app/README.md', ROOT)).toBe('.')
})

test('fileGroup falls back to the directory outside the root and to the first folder of a relative path', () => {
  expect(fileGroup('/elsewhere/lib/x.ts', ROOT)).toBe('/elsewhere/lib')
  expect(fileGroup('src/a/b.ts')).toBe('src')
  expect(fileGroup('a.ts')).toBe('.')
})

test('noteLeadCall counts the distinct files and the newlines of the new text', () => {
  let t = noteLeadCall(emptyLeadTurn(), 'Write', write('C:/Projects/app/src/a.ts', 10), ROOT)
  t = noteLeadCall(t, 'Edit', edit('C:/Projects/app/src/a.ts', 5), ROOT)
  t = noteLeadCall(t, 'Edit', edit('C:/Projects/app/src/b.ts', 3), ROOT)
  expect(t.files.length).toBe(2)
  expect(t.lines).toBe(18)
  expect(t.groups).toEqual(['src'])
})

test('noteLeadCall reads MultiEdit edits and NotebookEdit cells', () => {
  let t = noteLeadCall(emptyLeadTurn(), 'MultiEdit', {
    tool: 'MultiEdit', file_path: 'C:/Projects/app/docs/x.md',
    edits: [{ old_string: 'a', new_string: 'b\nc\n' }, { old_string: 'd', new_string: 'e' }],
  }, ROOT)
  t = noteLeadCall(t, 'NotebookEdit', { tool: 'NotebookEdit', notebook_path: 'C:/Projects/app/nb/n.ipynb', new_source: 'x\ny\nz' }, ROOT)
  expect(t.files.length).toBe(2)
  expect(t.lines).toBe(4)
  expect(t.groups.sort()).toEqual(['docs', 'nb'])
})

test('noteLeadCall ignores reads, unknown tools and malformed input, and never throws', () => {
  const t = emptyLeadTurn()
  expect(noteLeadCall(t, 'Read', { tool: 'Read', file_path: 'C:/Projects/app/a.ts' }, ROOT)).toEqual(t)
  expect(noteLeadCall(t, 'Edit', null as never, ROOT)).toEqual(t)
  expect(noteLeadCall(t, 'Write', { tool: 'Write', file_path: 42, content: 7 } as never, ROOT)).toEqual(t)
  expect(noteLeadCall(t, undefined, undefined as never, ROOT)).toEqual(t)
})

test('noteLeadCall keeps at most 50 files per turn', () => {
  let t = emptyLeadTurn()
  for (let i = 0; i < 80; i++) t = noteLeadCall(t, 'Write', write(`C:/Projects/app/d${i}/f.ts`, 1), ROOT)
  expect(t.files.length).toBe(50)
})

test('isWritingSpawn is true for general-purpose and named agents, false for Explore, Plan and forks', () => {
  expect(isWritingSpawn('Agent', { subagent_type: 'general-purpose', prompt: 'fix it' })).toBe(true)
  expect(isWritingSpawn('Task', { subagent_type: 'my-coder' })).toBe(true)
  expect(isWritingSpawn('Agent', { prompt: 'no type given' })).toBe(true)
  expect(isWritingSpawn('Agent', { subagent_type: 'Explore' })).toBe(false)
  expect(isWritingSpawn('Agent', { subagent_type: 'plan' })).toBe(false)
  expect(isWritingSpawn('Agent', { subagent_type: 'fork' })).toBe(false)
  expect(isWritingSpawn('Edit', { subagent_type: 'general-purpose' })).toBe(false)
})

test('noteLeadCall counts writing spawns but not the read-only ones', () => {
  let t = noteLeadCall(emptyLeadTurn(), 'Agent', { tool: 'Agent', subagent_type: 'Explore' }, ROOT)
  expect(t.spawns).toBe(0)
  t = noteLeadCall(t, 'Agent', { tool: 'Agent', subagent_type: 'general-purpose' }, ROOT)
  expect(t.spawns).toBe(1)
})

test('shouldHint: four files, 300 lines, two folders fire', () => {
  expect(shouldHint(work({ files: 4, lines: 300, groups: 2 }))).toBe(true)
})

test('shouldHint: six files in one folder fire without the folder rule', () => {
  expect(shouldHint(work({ files: 6, lines: 300, groups: 1 }))).toBe(true)
})

test('shouldHint: just under each rule does not fire', () => {
  expect(shouldHint(work({ files: 3, lines: 900, groups: 3 }))).toBe(false)
  expect(shouldHint(work({ files: 4, lines: 299, groups: 2 }))).toBe(false)
  expect(shouldHint(work({ files: 5, lines: 900, groups: 1 }))).toBe(false)
})

test('shouldHint: a single huge file never fires', () => {
  expect(shouldHint(work({ files: 1, lines: 5000, groups: 1 }))).toBe(false)
})

test('shouldHint: 1.5 USD of lead cost with three files fires, with fewer files it does not', () => {
  expect(shouldHint(work({ files: 3, lines: 10, groups: 1, cost: 1.5 }))).toBe(true)
  expect(shouldHint(work({ files: 2, lines: 10, groups: 1, cost: 9 }))).toBe(false)
  expect(shouldHint(work({ files: 3, lines: 10, groups: 1, cost: 1.49 }))).toBe(false)
})

test('shouldHint: never fires once a writing subagent was spawned in the window', () => {
  expect(shouldHint(work({ files: 9, lines: 900, groups: 4, cost: 20, spawns: 1 }))).toBe(false)
})

test('pushTurn keeps the last three turns and drops the ones older than the window', () => {
  const t0 = 1_000_000
  let w: LeadTurn[] = []
  w = pushTurn(w, turn({ files: ['a'] }), t0)
  w = pushTurn(w, turn({ files: ['b'] }), t0 + 60_000)
  w = pushTurn(w, turn({ files: ['c'] }), t0 + 120_000)
  w = pushTurn(w, turn({ files: ['d'] }), t0 + 180_000)
  expect(w.length).toBe(LEAD_WINDOW_TURNS)
  expect(w.map((x) => x.files[0])).toEqual(['b', 'c', 'd'])
  const later = pushTurn(w, turn({ files: ['e'] }), t0 + 180_000 + LEAD_WINDOW_MS + 1)
  expect(later.map((x) => x.files[0])).toEqual(['e'])
})

test('pushTurn stamps the turn with the time it ended', () => {
  const w = pushTurn([], turn({ files: ['a'] }), 42)
  expect(w[0]!.at).toBe(42)
})

test('leadWork adds the window up: distinct files and folders, lines, cost and spawns', () => {
  const w = leadWork([
    turn({ files: ['x/a.ts', 'x/b.ts'], groups: ['x'], lines: 100, cost: 0.5 }),
    turn({ files: ['x/b.ts', 'y/c.ts'], groups: ['x', 'y'], lines: 50, cost: 0.25, spawns: 0 }),
  ])
  expect(w).toEqual({ files: 3, groups: 2, lines: 150, cost: 0.75, spawns: 0 })
  expect(leadWork([]).files).toBe(0)
})

test('hintText is one plain sentence with the numbers', () => {
  expect(hintText(work({ files: 7, lines: 420, groups: 3 }))).toBe(
    'The lead wrote 7 files (420 lines) across 3 folders by itself. Asking it to split the work into subagents lets model-escalator start parts on cheaper models.')
  expect(hintText(work({ files: 1, lines: 1, groups: 1 }))).toContain('wrote 1 file (1 line) across 1 folder ')
})

test('parseSnapshot keeps a well-formed leadHint and drops a malformed one', () => {
  const base = { agents: [], ledger: {}, seenModels: {}, sessionTag: 'abc', mode: 'active', baseline: 'opus', baselinePinned: false }
  expect(parseSnapshot({ ...base, leadHint: { hinted: true, delegated: false } })?.leadHint).toEqual({ hinted: true, delegated: false })
  expect(parseSnapshot({ ...base, leadHint: 'yes' })?.leadHint).toBe(undefined)
  expect(parseSnapshot({ ...base, leadHint: { hinted: 1 } })?.leadHint).toEqual({ hinted: false, delegated: false })
  expect(parseSnapshot(base)?.leadHint).toBe(undefined)
})
