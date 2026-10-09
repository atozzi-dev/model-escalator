import { expect, test } from 'claude-code/testing'
import { emptyGraph, reduce, type GraphInput, type GraphState } from '../hooks/graph'
import { layoutGraph } from '../hooks/layout'
import { escapeXml, renderSvg, SVG_MAX, type RenderOptions } from '../hooks/render-svg'

const base = (): GraphState => emptyGraph('claude-opus-5-5', 0)
const run = (inputs: GraphInput[], from: GraphState = base()): GraphState => inputs.reduce((s, i) => reduce(s, i), from)
const spawn = (id: string, at = 1, model = 'claude-haiku-5-5', label = 'worker ' + id): GraphInput =>
  ({ type: 'spawn', at, agentId: id, label, model })
const draw = (g: GraphState, opts?: RenderOptions): string => renderSvg(g, layoutGraph(g), opts)
const count = (s: string, needle: string): number => s.split(needle).length - 1
// Class tokens used by elements (the stylesheet names every class too, so plain substring checks would lie).
const classes = (svg: string): Set<string> =>
  new Set([...svg.matchAll(/\sclass="([^"]*)"/g)].flatMap((m) => (m[1] ?? '').split(/\s+/)))

// Minimal XML well-formedness: one root element, balanced tags, no raw '<' or stray '&' in text or attributes.
function expectWellFormed(svg: string): void {
  expect(svg).toStartWith('<svg ')
  expect(svg).toEndWith('</svg>')
  const stack: string[] = []
  let roots = 0
  let last = 0
  const tag = /<(\/?)([A-Za-z][\w:-]*)((?:\s+[\w:-]+="[^"<>]*")*)\s*(\/?)>/g
  for (let m = tag.exec(svg); m; m = tag.exec(svg)) {
    const text = svg.slice(last, m.index)
    if (text.includes('<')) throw new Error(`raw '<' or broken tag near ${m.index}: ${svg.slice(m.index - 40, m.index + 40)}`)
    if (/&(?!(amp|lt|gt|quot|#39|#\d+);)/.test(text)) throw new Error(`stray '&' in text near ${m.index}`)
    for (const v of (m[3] ?? '').matchAll(/="([^"]*)"/g)) {
      if (/&(?!(amp|lt|gt|quot|#39|#\d+);)/.test(v[1] ?? '')) throw new Error(`stray '&' in attribute near ${m.index}`)
    }
    last = m.index + m[0].length
    const [, close, name, , self] = m
    if (close) {
      const open = stack.pop()
      if (open !== name) throw new Error(`</${name}> closes <${open}> near ${m.index}`)
    } else if (!self) {
      if (stack.length === 0) roots++
      stack.push(name!)
    } else if (stack.length === 0) {
      roots++
    }
  }
  expect(svg.slice(last)).toBe('')
  expect(stack).toEqual([])
  expect(roots).toBe(1)
}

// Lead + 4 workers on different tiers, a consult in progress, a swap, a paused worker, a message.
const sample = (): GraphState => run([
  spawn('w1', 1, 'claude-haiku-5-5', 'parser'),
  spawn('w2', 2, 'claude-sonnet-5-5', 'api tests'),
  spawn('w3', 3, 'claude-haiku-5-5', 'docs'),
  spawn('w4', 4, 'claude-opus-5-5', 'refactor'),
  { type: 'step', at: 5, agentId: 'w1', model: 'claude-haiku-5-5', cost: 0.0123 },
  { type: 'tool-start', at: 6, agentId: 'w1', tool: 'Read', summary: 'src/app.ts' },
  { type: 'ladder', at: 7, agentId: 'w3', action: 'swap', toModel: 'claude-sonnet-5-5', level: 3, score: 9 },
  { type: 'message', at: 8, from: 'w2', to: 'w1', text: 'hi' },
  { type: 'consult', at: 9, agentId: 'w2', phase: 'start', model: 'claude-opus-5-5' },
  { type: 'pause', at: 10, agentId: 'w4' },
])

test('an empty graph renders a well-formed svg with the lead only', () => {
  const svg = draw(base())
  expectWellFormed(svg)
  expect(count(svg, 'class="node ')).toBe(1)
  expect(svg).toContain('class="node lead')
  expect(svg).toContain('>lead<')
})

test('the svg declares its namespace, viewBox and size', () => {
  const g = sample()
  const l = layoutGraph(g)
  const svg = renderSvg(g, l)
  expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"')
  expect(svg).toContain(`viewBox="0 0 ${l.width} ${l.height}"`)
  expect(svg).toContain(`width="${l.width}"`)
  expectWellFormed(svg)
})

test('a sample graph is well-formed and draws every visible node and edge', () => {
  const g = sample()
  const l = layoutGraph(g)
  const svg = renderSvg(g, l)
  expectWellFormed(svg)
  expect(count(svg, 'class="node ')).toBe(l.nodes.length)
  expect(count(svg, 'class="edge ')).toBe(l.edges.length)
})

test('a node card shows label, tier badge, status, action, level and cost', () => {
  const g = sample()
  const svg = draw(g, { lastSeq: g.seq })
  expect(svg).toContain('>parser<')
  expect(svg).toContain('>reads app.ts<')
  expect(svg).toContain('>haiku<')
  expect(svg).toContain('>L3<')
  expect(svg).toContain('>$0.012<')
  expect(svg).toContain('>paused<')
  expect(svg).toContain('>waiting<')
})

test('the tooltip carries the full detail and the tier history', () => {
  const g = sample()
  const svg = draw(g, { lastSeq: g.seq })
  const docs = svg.slice(svg.indexOf('<title>docs'), svg.indexOf('</title>', svg.indexOf('<title>docs')))
  expect(docs).toContain('claude-sonnet-5-5')
  expect(docs).toContain('interventions 1')
  expect(docs).toContain('consults 0')
  expect(docs).toContain('score 9')
  expect(docs).toContain('haiku → sonnet')
})

test('escapeXml escapes markup characters and strips control characters', () => {
  expect(escapeXml(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;')
  expect(escapeXml('a\u0000b\u0007c\u001b[31md\u007f\u202ee')).toBe('abc[31mde')
  expect(escapeXml('line\nbreak\ttab')).toBe('line break tab')
  expect(escapeXml('lone \ud800 surrogate')).toBe('lone  surrogate')
  expect(escapeXml(42 as unknown as string)).toBe('')
})

test('hostile agent text cannot break out of elements or attributes', () => {
  const evil = `</svg><script>alert(1)</script>"' onload="x`
  const g = run([
    spawn('w1', 1, `claude-haiku"><script>`, evil),
    spawn(`a"b<c>&d`, 2, 'claude-sonnet-5-5', 'ctl\u0000\u0007\u001b[31m\u009bx'),
    { type: 'tool-start', at: 3, agentId: 'w1', tool: 'Read', summary: `C:/x/"><script>alert(2)</script>.ts` },
    { type: 'tool-start', at: 4, agentId: `a"b<c>&d`, tool: `<img src=x onerror=alert(3)>` },
    { type: 'message', at: 5, from: 'w1', to: `a"b<c>&d` },
    { type: 'consult', at: 6, agentId: 'w1', phase: 'start', model: `opus"/><foreignObject>` },
  ])
  const svg = draw(g, { lastSeq: 0 })
  expectWellFormed(svg)
  expect(svg).not.toMatch(/<script/i)
  expect(svg).not.toMatch(/<img/i)
  expect(svg).not.toMatch(/<foreignObject/i)
  expect(svg).not.toMatch(/\son\w+\s*=\s*"/i)
  expect(count(svg, '<svg')).toBe(1)
  expect(count(svg, '</svg>')).toBe(1)
  expect(svg).not.toMatch(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/)
  expect(svg).toContain('&lt;/svg&gt;&lt;script&gt;')
  expect(svg).toContain('&lt;/script&gt;&quot;&#39; onlo')
  for (const m of svg.matchAll(/\sid="([^"]*)"/g)) expect(m[1]).toMatch(/^[A-Za-z][A-Za-z0-9_-]*$/)
})

test('the svg has no external references', () => {
  const g = sample()
  const svg = draw(g, { lastSeq: 0 })
  expect(svg.replace('xmlns="http://www.w3.org/2000/svg"', '')).not.toMatch(/https?:|\/\/|@import|<image|<use|xlink:href|<a[\s>]/i)
  for (const m of svg.matchAll(/url\(([^)]*)\)/g)) expect(m[1]).toMatch(/^#[A-Za-z][\w-]*$/)
})

test('the legend names every tier and role and the theme follows the colour scheme', () => {
  const svg = draw(sample())
  const legend = svg.slice(svg.indexOf('class="legend"'), svg.indexOf('</g>', svg.indexOf('class="legend"')))
  for (const word of ['haiku', 'sonnet', 'opus', 'lead', 'senior']) expect(legend).toContain(`>${word}<`)
  expect(svg).toContain('@media (prefers-color-scheme:dark)')
  expect(svg).toContain('@media (prefers-reduced-motion:reduce)')
})

test('an explicit theme overrides the colour scheme query', () => {
  const dark = draw(sample(), { theme: 'dark' })
  const light = draw(sample(), { theme: 'light' })
  expect(dark).not.toContain('prefers-color-scheme')
  expect(light).not.toContain('prefers-color-scheme')
  expect(dark).toContain('--bg:#0b1120')
  expect(light).not.toContain('--bg:#0b1120')
  expect(light).toContain('--bg:#f8fafc')
  expect(dark).toContain('prefers-reduced-motion')
  expectWellFormed(dark)
})

test('reduced motion stops every animation', () => {
  const svg = draw(sample(), { lastSeq: 0 })
  const i = svg.indexOf('@media (prefers-reduced-motion:reduce)')
  expect(i).toBeGreaterThan(0)
  expect(svg.slice(i, i + 120)).toContain('animation:none!important')
  expect(svg).not.toContain('<animate')
})

test('active nodes pulse whatever lastSeq says', () => {
  const g = sample()
  const svg = draw(g, { lastSeq: g.seq })
  expect(svg).toContain('class="halo"')
  expect(svg).toContain('@keyframes pulse')
})

test('events at or below lastSeq are not animated again', () => {
  const g = sample()
  const svg = draw(g, { lastSeq: g.seq })
  const used = classes(svg)
  for (const cls of ['a-flash', 'swapfrom', 'a-pop', 'flow1', 'a-appear', 'a-ping']) expect(used.has(cls)).toBe(false)
})

test('new events animate: spawn, consult flash, swap colour, pause marker, message flow', () => {
  const g = sample()
  const svg = draw(g, { lastSeq: 0 })
  expect(classes(svg).has('a-appear')).toBe(true)
  expect(svg).toMatch(/class="node senior[^"]*a-flash/)
  expect(svg).toContain('class="swapfrom t-haiku"')
  expect(svg).toMatch(/class="mk mk-pause a-pop"/)
  expect(svg).toMatch(/class="edge e-message flow1"/)
})

test('only the events after lastSeq animate', () => {
  const before = sample()
  const g = run([{ type: 'stall', at: 11, agentId: 'w1' }], before)
  const svg = draw(g, { lastSeq: before.seq })
  expect(svg).toMatch(/class="mk mk-stall a-pop"/)
  expect(svg).toMatch(/class="mk mk-pause"/)
  expect(classes(svg).has('a-flash')).toBe(false)
  expect(classes(svg).has('swapfrom')).toBe(false)
})

test('a consult in progress keeps its edge flowing, and a human stop has its own marker', () => {
  const g = run([
    { type: 'ladder', at: 12, agentId: 'w1', action: 'human' },
  ], sample())
  const svg = draw(g, { lastSeq: g.seq })
  expect(svg).toMatch(/class="edge e-consult flow"/)
  expect(svg).toMatch(/class="mk mk-human"/)
})

test('edges used within the recent window keep flowing when now is given', () => {
  const g = sample()
  const recent = draw(g, { lastSeq: g.seq, now: 8 + 1000, recentMs: 3000 })
  const old = draw(g, { lastSeq: g.seq, now: 8 + 10_000, recentMs: 3000 })
  expect(recent).toMatch(/class="edge e-message flow1"/)
  expect(old).not.toMatch(/class="edge e-message flow1"/)
})

test('the output is deterministic', () => {
  expect(draw(sample(), { lastSeq: 3 })).toBe(draw(sample(), { lastSeq: 3 }))
  const g = sample()
  const l = layoutGraph(g)
  expect(renderSvg(g, l)).toBe(renderSvg(g, l))
})

test('node ids are derived from the agent ids, sanitised and distinct', () => {
  const g = run([spawn('a.b', 1), spawn('a_b', 2), spawn('x y"z', 3)])
  const svg = draw(g)
  const ids = [...svg.matchAll(/<g id="(n-[^"]*)"/g)].map((m) => m[1])
  expect(ids.length).toBe(4)
  expect(new Set(ids).size).toBe(4)
  for (const id of ids) expect(id).toMatch(/^n-[A-Za-z0-9_-]+$/)
  expect(ids.some((id) => id?.startsWith('n-a_b-'))).toBe(true)
})

function crowded(label: (i: number) => string, messages: number): GraphState {
  const inputs: GraphInput[] = []
  for (let i = 0; i < 50; i++) inputs.push(spawn('w' + i, i + 1, ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'][i % 3]!, label(i)))
  for (let i = 0; i < 50; i++) inputs.push({ type: 'tool-start', at: 100 + i, agentId: 'w' + i, tool: 'Bash', summary: 'npm test -- ' + label(i) })
  for (let i = 0; i < 20; i++) inputs.push({ type: 'consult', at: 200 + i, agentId: 'w' + i, phase: 'start' })
  for (let i = 0; i < 20; i++) inputs.push({ type: 'ladder', at: 300 + i, agentId: 'w' + (i + 20), action: 'swap', toModel: 'claude-opus-5-5', level: 3 })
  for (let i = 0; i < 10; i++) inputs.push({ type: 'stall', at: 400 + i, agentId: 'w' + (i + 40) })
  for (let i = 0; i < messages; i++) inputs.push({ type: 'message', at: 500 + i, from: 'w' + (i % 30), to: 'w' + ((i * 7 + 1) % 30) })
  return run(inputs)
}

test('50 agents and 100 events stay well under the size limit with full detail', () => {
  const g = crowded((i) => 'worker number ' + i + ' with a long label', 10)
  expect(g.events.length).toBe(100)
  const svg = draw(g, { lastSeq: 0 })
  expectWellFormed(svg)
  expect(svg.length).toBeLessThan(SVG_MAX)
  expect(svg.length).toBeLessThan(100_000)
  expect(svg).toContain('data-detail="full"')
})

test('a pathological graph degrades instead of exceeding the limit', () => {
  const g = crowded(() => '"&<>\'"&<>\'"&<>\'"&<>\'"&<>\'"&<>\'"&<>\'"&<', 200)
  const svg = draw(g, { lastSeq: 0 })
  expectWellFormed(svg)
  expect(svg.length).toBeLessThan(SVG_MAX)
})

test('a small budget drops tooltip detail, then animations, then the drawing', () => {
  const g = crowded((i) => 'w' + i, 30)
  const full = draw(g, { lastSeq: 0 })
  const short = draw(g, { lastSeq: 0, budget: full.length - 1 })
  expect(short.length).toBeLessThanOrEqual(full.length - 1)
  expect(short).not.toContain('data-detail="full"')
  expect(short).not.toContain('interventions')
  const tiny = draw(g, { lastSeq: 0, budget: 6000 })
  expect(tiny.length).toBeLessThanOrEqual(6000)
  expect(tiny).not.toContain('@keyframes')
  expectWellFormed(short)
  expectWellFormed(tiny)
})

test('malformed input never throws and still gives a valid svg', () => {
  const bad = renderSvg(undefined as unknown as GraphState, undefined as unknown as ReturnType<typeof layoutGraph>)
  expectWellFormed(bad)
  const weird = renderSvg({ nodes: [{ id: 'lead', kind: 'lead', x: 'x"' }] } as unknown as GraphState,
    { width: NaN, height: -5, nodes: [{ id: 'lead', kind: 'lead', x: '1" onload="x', y: 0, w: 10, h: 10 }], edges: [{ kind: 'bad' }] } as unknown as ReturnType<typeof layoutGraph>)
  expectWellFormed(weird)
  expect(weird).not.toMatch(/\son\w+\s*=\s*"/i)
})
