import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseLine, parseText } from '../src/parse.mjs'
import { TodoStore } from '../src/store.mjs'
import { formatItem } from '../src/format.mjs'

test('parses open and done items with an optional due date', () => {
  assert.deepEqual(parseLine('- [ ] buy milk @due(2024-05-01)').due, '2024-05-01')
  assert.equal(parseLine('- [ ] buy milk @due(2024-05-01)').title, 'buy milk')
  assert.equal(parseLine('- [x] call Ann').done, true)
  assert.equal(parseLine('just a note'), null)
})

test('parseText skips non-item lines', () => {
  const items = parseText('# Monday\n- [ ] a\n\n- [x] b\r\n')
  assert.deepEqual(items.map((i) => i.title), ['a', 'b'])
})

test('store filters by state and due date', () => {
  const store = new TodoStore()
  for (const item of parseText('- [ ] a @due(2024-01-10)\n- [x] b @due(2024-01-01)\n- [ ] c')) store.add(item)
  assert.deepEqual(store.list({ done: false }).map((i) => i.title), ['a', 'c'])
  assert.deepEqual(store.list({ dueBefore: '2024-01-05' }).map((i) => i.title), ['b'])
})

test('formats items', () => {
  assert.equal(formatItem(parseLine('- [x] buy milk @due(2024-05-01)')), '[x] buy milk (due 2024-05-01)')
  assert.equal(formatItem(parseLine('- [ ] call Ann')), '[ ] call Ann')
})
