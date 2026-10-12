import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseCsv } from '../../src/parse.mjs'
import { toCsv } from '../../src/stringify.mjs'

test('default delimiter is unchanged', () => {
  assert.deepEqual(parseCsv('a,b\n1,2'), [['a', 'b'], ['1', '2']])
  assert.deepEqual(parseCsv('a,b', {}), [['a', 'b']])
  assert.equal(toCsv([['a', 'b,c']]), 'a,"b,c"')
  assert.equal(toCsv([['a', 'b,c']], {}), 'a,"b,c"')
})

test('parses with a semicolon delimiter', () => {
  assert.deepEqual(parseCsv('name;amount\n"Smith; John";1,50\r\nDoe;2', { delimiter: ';' }), [
    ['name', 'amount'],
    ['Smith; John', '1,50'],
    ['Doe', '2'],
  ])
})

test('parses with a tab delimiter', () => {
  assert.deepEqual(parseCsv('a\tb\t\n"x\ty"\t2\t3', { delimiter: '\t' }), [
    ['a', 'b', ''],
    ['x\ty', '2', '3'],
  ])
})

test('serialises with another delimiter, quoting fields that contain it', () => {
  assert.equal(toCsv([['a;b', 'c,d', 'e'], ['say "hi"', '', 'x\ny']], { delimiter: ';' }), '"a;b";c,d;e\r\n"say ""hi""";;"x\ny"')
  assert.equal(toCsv([['a\tb', 'c,d']], { delimiter: '\t' }), '"a\tb"\tc,d')
})

test('round trip with a custom delimiter', () => {
  const rows = [['id', 'note'], ['1', 'semi;colon, comma and "quotes"'], ['2', 'line\nbreak']]
  for (const delimiter of [';', '\t', '|', ',']) {
    assert.deepEqual(parseCsv(toCsv(rows, { delimiter }), { delimiter }), rows, `delimiter ${JSON.stringify(delimiter)}`)
  }
})

test('invalid delimiters are rejected with a TypeError', () => {
  for (const delimiter of ['', ';;', '"', '\n', '\r', 1]) {
    assert.throws(() => parseCsv('a', { delimiter }), TypeError, `parse ${JSON.stringify(delimiter)}`)
    assert.throws(() => toCsv([['a']], { delimiter }), TypeError, `stringify ${JSON.stringify(delimiter)}`)
  }
})
