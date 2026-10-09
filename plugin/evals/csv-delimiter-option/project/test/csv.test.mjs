import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseCsv } from '../src/parse.mjs'
import { toCsv } from '../src/stringify.mjs'

test('parses plain and quoted fields', () => {
  assert.deepEqual(parseCsv('a,b,c\n1,"x, y",3\n'), [
    ['a', 'b', 'c'],
    ['1', 'x, y', '3'],
  ])
})

test('doubled quotes and CRLF line endings', () => {
  assert.deepEqual(parseCsv('"say ""hi""",2\r\nlast,row'), [
    ['say "hi"', '2'],
    ['last', 'row'],
  ])
})

test('line breaks inside quotes are kept', () => {
  assert.deepEqual(parseCsv('"one\ntwo",x'), [['one\ntwo', 'x']])
})

test('serialises with quoting only where needed', () => {
  assert.equal(toCsv([['a', 'b,c', 'say "hi"', null], [1, 2, 3, undefined]]), 'a,"b,c","say ""hi""",\r\n1,2,3,')
})
