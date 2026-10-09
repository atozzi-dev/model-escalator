import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ConfigError, parseConfig } from '../src/config.mjs'

test('sections, keys and full-line comments', () => {
  const text = ['# app settings', 'name = demo', '', '[server]', 'port = 8080', '; old: port = 80', 'host=localhost'].join('\n')
  assert.deepEqual(parseConfig(text), { '': { name: 'demo' }, server: { port: '8080', host: 'localhost' } })
})

test('inline comments need whitespace before them', () => {
  const cfg = parseConfig('[links]\nhome = http://example.test/#top   # main page\ntag = a#b')
  assert.equal(cfg.links.home, 'http://example.test/#top')
  assert.equal(cfg.links.tag, 'a#b')
})

test('quoted values keep spaces and comment characters', () => {
  const cfg = parseConfig('greeting = "  hello; world # not a comment "  # a comment')
  assert.equal(cfg[''].greeting, '  hello; world # not a comment ')
})

test('continuation lines are joined with a space', () => {
  const cfg = parseConfig('[cmd]\nargs = --verbose \\\n    --color \\\n    --dry-run\nnext = 1')
  assert.deepEqual(cfg.cmd, { args: '--verbose --color --dry-run', next: '1' })
})

test('errors report the 1-based line number', () => {
  assert.throws(() => parseConfig('a = 1\n[server\nb = 2'), (e) => e instanceof ConfigError && e.line === 2)
})
