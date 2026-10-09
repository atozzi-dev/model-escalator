import { expect, mock, test } from 'claude-code/testing'
import { announcement, isValidTag, newTag, tagNote, withAnnouncement } from '../hooks/channel'
import { resetState } from '../hooks/register'

test('tags are 6 lowercase hex chars and differ between calls', () => {
  const a = newTag()
  const b = newTag()
  expect(isValidTag(a)).toBe(true)
  expect(isValidTag('ABC123')).toBe(false)
  expect(a).not.toBe(b)
})

test('tagNote prefixes the note with the tagged marker', () => {
  expect(tagNote('abc123', 'Stop.')).toBe('[supervisor:abc123] Stop.')
})

test('announcement names the exact tag and withAnnouncement only appends', () => {
  expect(announcement('abc123')).toContain('[supervisor:abc123]')
  const out = withAnnouncement('do the work', 'abc123')
  expect(out.startsWith('do the work\n\n')).toBe(true)
  expect(out).toContain('[supervisor:abc123]')
})

function wire(on: any, env: Record<string, string>, prompts: string[]) {
  mock.env(on, env)
  mock.store(on)
  on('session.start', () => ({ cwd: '/work' }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  on('agent.spawn', (_$: unknown, e: any) => { prompts.push(e.prompt); return { model: 'haiku', agentId: 'a1' } })
  on('tool.call', () => ({ isError: true, result: 'Error: boom', text: 'Error: boom' }) as never)
  on('model.complete', () => ({ value: { isAnswered: true, text: 'advice' } }) as never)
  on('ui.log', () => ({ value: undefined }) as never)
  for (const k of ['ui.toast', 'ui.status'] as const) on(k, () => ({ value: undefined }) as never)
}

async function run($: any) {
  await $.session.start({ cwd: '/work' } as never)
  const r = await $.agent.spawn({ prompt: 'p', description: 'fix db test', subagentType: 'general-purpose', model: 'haiku' } as never) as { agentId: string }
  const notes: string[] = []
  for (let i = 0; i < 12; i++) {
    const t = await $.tool.call({ tool: 'Bash', command: 'npm test', agentId: r.agentId } as never) as { context?: readonly string[] }
    for (const c of t.context ?? []) notes.push(c)
  }
  return notes
}

test('active: spawn prompt announces the session tag and every note carries it', async ($, on) => {
  resetState()
  const prompts: string[] = []
  wire(on, {}, prompts)
  const notes = await run($)
  expect(prompts[0]!.startsWith('p\n\n')).toBe(true)
  // The harness loads the plugin as its own module instance, so the tag is read back from the prompt.
  const tag = /\[supervisor:([0-9a-f]{6})\]/.exec(prompts[0]!)?.[1]
  expect(tag).toBeDefined()
  expect(notes.length).toBeGreaterThan(2)
  for (const n of notes) expect(n.startsWith(`[supervisor:${tag}] `)).toBe(true)
})

for (const mode of ['observe', 'baseline', 'off']) {
  test(`${mode}: spawn prompt is left untouched`, async ($, on) => {
    resetState()
    const prompts: string[] = []
    wire(on, { MODEL_ESCALATOR_MODE: mode }, prompts)
    await run($)
    expect(prompts[0]).toBe('p')
  })
}

const tags: string[] = []
for (const n of [1, 2]) {
  test(`session.start generates a random tag (session ${n})`, async ($, on) => {
    resetState()
    const prompts: string[] = []
    wire(on, {}, prompts)
    await run($)
    const m = /\[supervisor:([0-9a-f]{6})\]/.exec(prompts[0]!)
    expect(m).not.toBe(null)
    tags.push(m![1]!)
    if (tags.length === 2) expect(tags[0]).not.toBe(tags[1])
  })
}
