import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ConfigError, parseConfig } from '../../src/config.mjs'

const lines = (...xs) => xs.join('\n')

function errorLine(text) {
  try {
    parseConfig(text)
  } catch (e) {
    assert.ok(e instanceof ConfigError, `expected a ConfigError, got ${e}`)
    assert.equal(e.name, 'ConfigError')
    return e.line
  }
  assert.fail(`no error for ${JSON.stringify(text)}`)
}

test('comments only start at the line start or after whitespace', () => {
  const cfg = parseConfig(lines('   # indented comment', ';x = 1', '[s] # header comment', 'a = 1 ; note', 'b = x;y', 'c = # only a comment', 'd = 5#6 #seven'))
  assert.deepEqual(cfg.s, { a: '1', b: 'x;y', c: '', d: '5#6' })
  assert.equal(cfg[''].x, undefined)
})

test('keys and values are split at the first equals sign and trimmed', () => {
  const cfg = parseConfig(lines('  url   =   a=b=c  ', 'empty =', '[  my section  ]', 'k=v'))
  assert.equal(cfg[''].url, 'a=b=c')
  assert.equal(cfg[''].empty, '')
  assert.deepEqual(cfg['my section'], { k: 'v' })
})

test('quoted values: escapes, comments after the closing quote, empty strings', () => {
  const cfg = parseConfig(lines('s = "say \\"hi\\" \\\\ \\n \\t"', 't = "x # y ; z"   ; comment', 'e = ""', 'size = 5" screen'))
  assert.equal(cfg[''].s, 'say "hi" \\ \n \t')
  assert.equal(cfg[''].t, 'x # y ; z')
  assert.equal(cfg[''].e, '')
  assert.equal(cfg[''].size, '5" screen')
})

test('a backslash inside quotes is not a continuation', () => {
  const cfg = parseConfig(lines('p = "C:\\\\dir\\\\"', 'q = 2'))
  assert.equal(cfg[''].p, 'C:\\dir\\')
  assert.equal(cfg[''].q, '2')
})

test('continuations drop comments, join with one space and may chain', () => {
  const cfg = parseConfig(lines('[cmd]', 'args = one   \\', '   two # first comment', 'list = a \\', ' b \\', '  c ; trailing', 'after = yes'))
  assert.deepEqual(cfg.cmd, { args: 'one two', list: 'a b c', after: 'yes' })
})

test('CRLF files', () => {
  const cfg = parseConfig('[a]\r\nx = 1 \\\r\n  2\r\ny = "q"\r\n')
  assert.deepEqual(cfg.a, { x: '1 2', y: 'q' })
})

test('repeated sections merge and the last value wins', () => {
  const cfg = parseConfig(lines('[a]', 'x = 1', 'y = 1', '[b]', 'z = 1', '[a]', 'y = 2'))
  assert.deepEqual(cfg.a, { x: '1', y: '2' })
  assert.deepEqual(cfg.b, { z: '1' })
})

test('errors carry the 1-based line of the problem', () => {
  assert.equal(errorLine(lines('a = 1', '', '[server')), 3)
  assert.equal(errorLine(lines('a = 1', 'just text')), 2)
  assert.equal(errorLine(' = 5'), 1)
  assert.equal(errorLine(lines('ok = 1', 'a = "abc')), 2)
  assert.equal(errorLine('a = "abc" def'), 1)
  assert.equal(errorLine(lines('[a]', '[ ]')), 2)
  assert.equal(errorLine('a = 1 \\'), 1)
  assert.equal(errorLine(lines('x = 1', 'a = b \\')), 2)
  assert.equal(errorLine(lines('a = one \\', '  two', '  three')), 3)
  assert.equal(errorLine(lines('a = one \\', '  two \\', '  three', '[bad')), 4)
})
