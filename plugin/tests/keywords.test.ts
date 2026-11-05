import { expect, test } from 'claude-code/testing'
import { categorize } from '../hooks/learning'

// The keyword categorizer as it was before the agent type and the prompt were read, kept here to measure the change.
const LEGACY: [RegExp, string][] = [
  [/\btest|spec\b/i, 'tests'],
  [/\bfix|bug|debug|error\b/i, 'bugfix'],
  [/\brefactor|rename|cleanup\b/i, 'refactor'],
  [/\bdoc|readme|comment\b/i, 'docs'],
  [/\bmigrat|schema|database|sql\b/i, 'data'],
  [/\bui|css|component|layout\b/i, 'ui'],
  [/\bsearch|find|explore|research|read\b/i, 'explore'],
]
const legacy = (type: string, description: string): string => `${type}:${LEGACY.find(([re]) => re.test(description))?.[1] ?? 'other'}`

type Case = [type: string, description: string, prompt: string, expected: string]

const ROADMAP = 'Implement task P.6 of internal/ROADMAP.md in your worktree. Work test first: write the failing test, then the code. Only touch the files listed.'

// Realistic spawns, modelled on a real session.
const CASES: Case[] = [
  ['security-reviewer', 'Security pass over the auth changes', 'Look at the diff and report problems.', 'review'],
  ['infra-reviewer', 'CI workflow', 'Go through the workflow files and report mistakes.', 'review'],
  ['task-worker-sonnet', 'Task Q.2', ROADMAP, 'feature'],
  ['task-worker-opus', 'Orchestrator rewrite', 'Rework the lead loop. Read CLAUDE.md first, then change the hooks.', 'refactor'],
  ['task-worker-haiku', 'Roadmap P.7', 'Fix the typo in the README table and update the changelog line.', 'bugfix'],
  ['docs-writer', 'Describe the config options', 'Write the section.', 'docs'],
  ['technical-writer', 'Update the user guide', 'Cover the new command.', 'docs'],
  ['test-runner', 'Run the suite', 'Run everything and summarize failures.', 'tests'],
  ['Explore', 'Map the repo structure', 'Report the directory structure.', 'explore'],
  ['Explore', 'Where does the retry logic live', 'Report back.', 'explore'],
  ['general-purpose', 'Add a loader cache', 'Please add it.', 'feature'],
  ['general-purpose', 'Fix the login bug', 'Users cannot sign in.', 'bugfix'],
  ['general-purpose', 'Write unit tests for the parser', 'Cover edge cases.', 'tests'],
  ['general-purpose', 'Tidy the utils module', 'Move helpers around.', 'refactor'],
  ['general-purpose', 'Postgres index tuning', 'Look at slow queries.', 'data'],
  ['general-purpose', 'Build the settings modal', 'Use the existing components.', 'ui'],
  ['general-purpose', 'Task A', 'Implement the export command and wire it into the help text.', 'feature'],
  ['general-purpose', 'Task B', 'Write tests for the queue module. Cover overflow.', 'tests'],
  // the head of a brief alone is never enough to start on haiku: the next label in it ("build") is taken instead
  ['general-purpose', 'Task C', 'Investigate why the build is slow and report back.', 'feature'],
  ['general-purpose', 'Task D', 'Audit the permissions of the scripts.', 'review'],
  ['general-purpose', 'Introduce a retry option', '', 'feature'],
  ['general-purpose', 'zzz qqq', 'nothing useful here', 'other'],
]

test('table: realistic spawns get the expected label', async () => {
  for (const [type, description, prompt, expected] of CASES) {
    expect(categorize(type, description, prompt)).toBe(`${type}:${expected}`)
  }
})

test('the share of other shrinks on the realistic sample', async () => {
  const share = (f: (c: Case) => string): number => CASES.filter((c) => f(c).endsWith(':other')).length / CASES.length
  const before = share((c) => legacy(c[0], c[1]))
  const after = share((c) => categorize(c[0], c[1], c[2]))
  expect(before > 0.4).toBe(true)
  expect(after <= 0.1).toBe(true)
})

test('descriptions the old keywords labelled keep their label', async () => {
  const kept: [string, string][] = [
    ['Fix the login bug', 'bugfix'], ['fix db test', 'tests'], ['update the readme', 'docs'], ['Refactor the parser', 'refactor'],
    ['rename helpers', 'refactor'], ['run the migration', 'data'], ['update the layout component', 'ui'], ['research options', 'explore'],
    ['debug crash', 'bugfix'], ['write spec', 'tests'], ['search for usages', 'explore'],
  ]
  for (const [description, label] of kept) {
    expect(legacy('t', description)).toBe(`t:${label}`)
    expect(categorize('t', description)).toBe(`t:${label}`)
  }
})

test('the agent type names a role: reviewer beats the words of the task', async () => {
  expect(categorize('security-reviewer', 'fix the failing tests')).toBe('security-reviewer:review')
  expect(categorize('code_auditor', 'x')).toBe('code_auditor:review')
  expect(categorize('docs-reviewer', 'x')).toBe('docs-reviewer:review')
  expect(categorize('test-writer', 'implement the helper')).toBe('test-writer:tests')
})

test('word boundaries: substrings do not match', async () => {
  expect(categorize('t', 'a prefix suffix')).toBe('t:other')
  expect(categorize('t', 'the bugle band')).toBe('t:other')
  expect(categorize('t', 'a building site')).toBe('t:other')
})

test('the prompt is only read when nothing else says what the task is', async () => {
  expect(categorize('t', 'fix the thing', 'write the docs')).toBe('t:bugfix')
  expect(categorize('t', 'Task 7', 'write the docs')).toBe('t:docs')
})

test('in a prompt the first thing mentioned is the task: "implement ... test first" is a feature', async () => {
  expect(categorize('t', 'Task 7', ROADMAP)).toBe('t:feature')
})

test('only the head of the prompt counts, and code blocks are left out', async () => {
  const far = 'lorem '.repeat(100) + 'implement a feature'
  expect(categorize('t', 'Task', far)).toBe('t:other')
  expect(categorize('t', 'Task', '```\nfix everything\n```\nplease implement the cache')).toBe('t:feature')
})

// Exploration starts on haiku, the most aggressive choice: the explore label needs clear evidence of read-only work.
test('in the description explore is the lowest label: any other label wins whatever its position', async () => {
  expect(categorize('t', 'Read the design and implement the cache')).toBe('t:feature')
  expect(categorize('t', 'Look at the parser and fix the crash')).toBe('t:bugfix')
  expect(categorize('t', 'Analyze the module and simplify it')).toBe('t:refactor')
  expect(categorize('t', 'Read the code and write the docs')).toBe('t:docs')
  expect(categorize('t', 'Trace the slow queries')).toBe('t:data')
  expect(categorize('t', 'Map the modal styles')).toBe('t:ui')
  expect(categorize('t', 'Read the diff and audit it')).toBe('t:review')
  expect(categorize('t', 'Search for flaky specs')).toBe('t:tests')
  // explore alone still is explore
  expect(categorize('t', 'Read the loader and report back')).toBe('t:explore')
  expect(categorize('t', 'Map the repo structure')).toBe('t:explore')
})

test('the other rows keep their order in the description', async () => {
  expect(categorize('t', 'fix db test')).toBe('t:tests')
  expect(categorize('t', 'fix the readme')).toBe('t:bugfix')
  expect(categorize('t', 'review and implement')).toBe('t:review')
})

test('the prompt head never yields explore: the next label in the head, else other', async () => {
  const brief = 'Task B.3 of internal/ROADMAP.md: delegation suggestion. Read internal/DELEGA-ANALISI.md and CLAUDE.md, then implement the hint test first.'
  expect(categorize('task-worker-sonnet', 'B.3 delegation suggestion', brief)).toBe('task-worker-sonnet:feature')
  expect(categorize('t', 'Task C', 'Read the parser, look at the call sites, then fix the crash.')).toBe('t:bugfix')
  expect(categorize('t', 'Task C', 'Investigate why the login is slow and report back.')).toBe('t:other')
  expect(categorize('general-purpose', 'Task C', 'Read CLAUDE.md and map the hooks.')).toBe('general-purpose:other')
})

test('explore still comes from the agent type when the description says nothing', async () => {
  expect(categorize('Explore', 'Where does the retry logic live', 'Read the hooks and report back.')).toBe('Explore:explore')
  expect(categorize('Explore', 'zzz', 'implement nothing')).toBe('Explore:explore')
  expect(categorize('code-scout', 'Task 9', 'Read the hooks.')).toBe('code-scout:explore')
  expect(categorize('Explore', 'Fix the login bug')).toBe('Explore:bugfix')
})

test('categorize never throws on odd input', async () => {
  expect(categorize('t', undefined as unknown as string)).toBe('t:other')
  expect(categorize('t', 'x', 42 as unknown as string)).toBe('t:other')
})
