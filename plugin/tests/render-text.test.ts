import { expect, test } from 'claude-code/testing'
import { emptyGraph, reduce, type GraphInput, type GraphState } from '../hooks/graph'
import { layoutGraph } from '../hooks/layout'
import { plainLines, renderTree, SPINNER, TIER_COLORS, type Line, type TreeOptions } from '../hooks/render-text'

const base = (): GraphState => emptyGraph('claude-opus-5-5', 0)
const run = (inputs: GraphInput[], from: GraphState = base()): GraphState => inputs.reduce((s, i) => reduce(s, i), from)
const spawn = (id: string, at = 1, model = 'claude-haiku-5-5', label = 'worker ' + id): GraphInput =>
  ({ type: 'spawn', at, agentId: id, label, model })
const draw = (g: GraphState, opts: Partial<TreeOptions> = {}): Line[] =>
  renderTree(g, layoutGraph(g), { frame: 0, width: 100, ...opts })
const text = (g: GraphState, opts: Partial<TreeOptions> = {}): string[] => plainLines(draw(g, opts))
const cp = (s: string): number => Array.from(s).length

// Control characters, bidi overrides, zero-width marks and line separators, by code point.
const isHostile = (t: string): boolean =>
  Array.from(t).some((c) => {
    const n = c.codePointAt(0) ?? 0
    return n < 0x20 || (n >= 0x7f && n <= 0x9f) || n === 0x2028 || n === 0x2029 || (n >= 0x200b && n <= 0x200f) ||
      (n >= 0x202a && n <= 0x202e) || (n >= 0x2066 && n <= 0x2069)
  })

test('an empty graph renders just the lead line', () => {
  const lines = text(base())
  expect(lines.length).toBe(1)
  expect(lines[0]).toContain('lead')
  expect(lines[0]).toContain('opus')
})

test('malformed input degrades to a single line without throwing', () => {
  const bad = renderTree(null as unknown as GraphState, layoutGraph(null as unknown as GraphState), { frame: NaN, width: NaN })
  expect(bad.length).toBe(1)
  expect(plainLines(bad)[0]).toContain('lead')
})

test('lines follow the layout order as a tree under the lead', () => {
  const g = run([
    spawn('a', 1, 'claude-haiku-5-5', 'alpha'),
    spawn('b', 2, 'claude-sonnet-5-5', 'beta'),
    { type: 'consult', at: 3, agentId: 'a', phase: 'start', model: 'opus' },
  ])
  const lines = text(g)
  expect(lines.length).toBe(4)
  expect(lines[0]).toContain('lead')
  expect(lines[1]).toContain('alpha')
  expect(lines[2]).toContain('beta')
  expect(lines[3]).toContain('senior')
  expect(lines[0]).not.toMatch(/^[├└│]/)
  expect(lines[1]).toMatch(/^├─ /)
  expect(lines[2]).toMatch(/^├─ /)
  expect(lines[3]).toMatch(/^└─ /)
})

test('the last child closes the tree', () => {
  const lines = text(run([spawn('a'), spawn('b')]))
  expect(lines[1]).toMatch(/^├─ /)
  expect(lines[2]).toMatch(/^└─ /)
})

test('tier badges carry the tier colour', () => {
  const g = run([spawn('a', 1, 'claude-haiku-5-5'), spawn('b', 2, 'claude-sonnet-5-5'), spawn('c', 3, 'claude-opus-5-5')])
  const lines = draw(g)
  const badge = (i: number, word: string) => lines[i]!.find((s) => s.text.includes(word))
  expect(badge(1, 'haiku')?.color).toBe(TIER_COLORS.haiku)
  expect(badge(2, 'sonnet')?.color).toBe(TIER_COLORS.sonnet)
  expect(badge(3, 'opus')?.color).toBe(TIER_COLORS.opus)
  expect(lines[0]!.find((s) => s.text.includes('lead'))?.color).toBe(TIER_COLORS.lead)
  expect(new Set(Object.values(TIER_COLORS)).size).toBe(Object.values(TIER_COLORS).length)
})

test('the senior badge uses the senior colour', () => {
  const g = run([spawn('a'), { type: 'consult', at: 2, agentId: 'a', phase: 'start', model: 'opus' }])
  const last = draw(g).at(-1)!
  expect(last.find((s) => s.text.includes('senior'))?.color).toBe(TIER_COLORS.senior)
})

test('a line shows status, action, level and cost', () => {
  const g = run([
    spawn('a', 1, 'claude-haiku-5-5', 'alpha'),
    { type: 'step', at: 3, agentId: 'a', model: 'claude-haiku-5-5', cost: 0.1234 },
    { type: 'tool-start', at: 2, agentId: 'a', tool: 'Read', summary: 'src/app.ts' },
    { type: 'ladder', at: 4, agentId: 'a', action: 'nudge', level: 2, score: 3 },
  ])
  const line = text(g)[1]!
  expect(line).toContain('alpha')
  expect(line).toContain('reads app.ts')
  expect(line).toContain('L2')
  expect(line).toContain('$0.12')
})

test('done, waiting, stuck and paused nodes show their status word and marker', () => {
  const g = run([
    spawn('d', 1, 'claude-haiku-5-5', 'dd'), spawn('s', 2, 'claude-haiku-5-5', 'ss'),
    spawn('p', 3, 'claude-haiku-5-5', 'pp'), spawn('h', 4, 'claude-haiku-5-5', 'hh'),
    { type: 'complete', at: 5, agentId: 'd' },
    { type: 'stall', at: 6, agentId: 's' },
    { type: 'pause', at: 7, agentId: 'p' },
    { type: 'ladder', at: 8, agentId: 'h', action: 'human' },
  ])
  const lines = text(g)
  const of = (name: string) => lines.find((l) => l.includes(name))!
  expect(of('dd')).toContain('done')
  expect(of('ss')).toContain('stalled')
  expect(of('pp')).toContain('paused')
  expect(of('hh')).toContain('needs you')
})

test('markers are coloured as alerts', () => {
  const g = run([spawn('s'), { type: 'stall', at: 2, agentId: 's' }])
  const seg = draw(g)[1]!.find((s) => s.text.includes('stalled'))
  expect(seg?.color).toBe(TIER_COLORS.stuck)
  expect(seg?.bold).toBe(true)
})

test('group lines read +N done and +N more', () => {
  const ids = Array.from({ length: 33 }, (_, i) => 'w' + i)
  const inputs: GraphInput[] = ids.map((id, i) => spawn(id, i + 1))
  const g = run(inputs)
  const l = layoutGraph(g)
  const lines = plainLines(renderTree(g, l, { frame: 0, width: 100 }))
  expect(lines.some((x) => /\+\d+ more/.test(x))).toBe(true)
  const done = run([...inputs.slice(0, 31), ...ids.slice(0, 2).map((id, i): GraphInput => ({ type: 'complete', at: 100 + i, agentId: id })), spawn('late', 200)])
  expect(plainLines(draw(done)).some((x) => /\+\d+ done/.test(x))).toBe(true)
  const gl = draw(g).find((ln) => ln.some((s) => /more/.test(s.text)))!
  expect(gl.every((s) => s.bold !== true)).toBe(true)
})

test('the spinner advances with the frame for active nodes', () => {
  const g = run([spawn('a')])
  const glyph = (frame: number) => text(g, { frame })[1]!.replace(/^[├└]─ /, '')[0]!
  const seen = new Set(SPINNER.map((_, f) => glyph(f)))
  expect(seen.size).toBe(SPINNER.length)
  expect(glyph(0)).toBe(glyph(SPINNER.length))
  expect(glyph(0)).not.toBe(glyph(1))
})

test('the spinner is a pure function of the frame, also for odd values', () => {
  const g = run([spawn('a')])
  expect(text(g, { frame: -3 })).toEqual(text(g, { frame: -3 }))
  expect(text(g, { frame: 2.7 }).length).toBe(2)
  expect(text(g, { frame: NaN }).length).toBe(2)
})

test('reduced motion keeps a static glyph', () => {
  const g = run([spawn('a')])
  expect(text(g, { frame: 0, reducedMotion: true })).toEqual(text(g, { frame: 5, reducedMotion: true }))
  for (const s of SPINNER) expect(text(g, { reducedMotion: true })[1]).not.toContain(s)
})

test('only active nodes animate', () => {
  const g = run([spawn('a'), { type: 'complete', at: 2, agentId: 'a' }])
  expect(text(g, { frame: 0 })[1]).toEqual(text(g, { frame: 1 })[1])
})

test('a recent swap shows an arrow and the new tier only for new events', () => {
  const g = run([spawn('a', 1, 'claude-haiku-5-5', 'alpha'), { type: 'ladder', at: 2, agentId: 'a', action: 'swap', toModel: 'claude-sonnet-5-5' }])
  expect(text(g, { lastSeq: 1 })[1]).toContain('↑ sonnet')
  expect(text(g, { lastSeq: g.seq })[1]).not.toContain('↑')
  expect(text(g)[1]).not.toContain('↑')
})

test('a downward swap points down', () => {
  const g = run([spawn('a', 1, 'claude-opus-5-5', 'alpha'), { type: 'ladder', at: 2, agentId: 'a', action: 'swap', toModel: 'claude-haiku-5-5' }])
  expect(text(g, { lastSeq: 1 })[1]).toContain('↓ haiku')
})

test('a consult shows consulting on the worker', () => {
  const g = run([spawn('a', 1, 'claude-haiku-5-5', 'alpha'), { type: 'consult', at: 2, agentId: 'a', phase: 'start', model: 'opus' }])
  const lines = text(g, { lastSeq: 1 })
  expect(lines[1]).toContain('consulting…')
  expect(text(g, { lastSeq: g.seq })[1]).not.toContain('consulting')
})

test('hostile labels cannot inject escape sequences or control characters', () => {
  const hostile = '\u001b[31mred\u001b[0m\u001b]0;pwn\u0007\u001b]8;;http://x\u001b\\link\r\nnext\u0000\u0008\u007f\u0085‮evil​'
  const g = run([spawn('a', 1, 'claude-haiku-5-5', hostile), { type: 'tool-start', at: 2, agentId: 'a', tool: 'Bash', summary: '\u001b[2Jrm\u0007' }])
  for (const ln of draw(g)) {
    for (const s of ln) {
      expect(isHostile(s.text)).toBe(false)
    }
  }
  const joined = text(g).join('\n')
  expect(joined).toContain('red')
  expect(joined).not.toContain('[31m')
  expect(joined).not.toContain('pwn')
})

test('no line exceeds the width, whatever the width', () => {
  const g = run([
    spawn('a', 1, 'claude-haiku-5-5', 'a very long worker label that keeps going and going'),
    { type: 'tool-start', at: 2, agentId: 'a', tool: 'Read', summary: 'some/very/long/path/to/a-file-with-a-long-name.ts' },
    { type: 'step', at: 3, agentId: 'a', model: 'claude-haiku-5-5', cost: 12.5 },
    { type: 'ladder', at: 4, agentId: 'a', action: 'swap', toModel: 'claude-sonnet-5-5', level: 3 },
    { type: 'consult', at: 5, agentId: 'a', phase: 'start', model: 'opus' },
  ])
  for (const width of [200, 80, 60, 40, 30, 20, 12, 8, 5, 3, 2, 1, 0, -4]) {
    const lines = text(g, { width, lastSeq: 0 })
    expect(lines.length).toBe(3)
    for (const ln of lines) expect(cp(ln)).toBeLessThanOrEqual(Math.max(1, width))
  }
})

test('truncation marks the cut with an ellipsis and keeps the label first', () => {
  const g = run([
    spawn('a', 1, 'claude-haiku-5-5', 'important-label'),
    { type: 'tool-start', at: 2, agentId: 'a', tool: 'Read', summary: 'a-really-long-file-name-for-the-test.ts' },
  ])
  const line = text(g, { width: 48 })[1]!
  expect(cp(line)).toBeLessThanOrEqual(48)
  expect(line).toContain('important-label')
  expect(line).toContain('…')
})

test('rendering is deterministic', () => {
  const g = run([spawn('a'), spawn('b'), { type: 'ladder', at: 2, agentId: 'a', action: 'swap', toModel: 'sonnet' }])
  expect(JSON.stringify(draw(g, { frame: 3, lastSeq: 0 }))).toBe(JSON.stringify(draw(g, { frame: 3, lastSeq: 0 })))
})
