import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseLine, parseText } from '../../src/parse.mjs'
import { TodoStore } from '../../src/store.mjs'
import { formatItem } from '../../src/format.mjs'

test('items without tags have an empty tag list and are otherwise unchanged', () => {
  assert.deepEqual(parseLine('- [ ] buy milk @due(2024-05-01)'), { done: false, title: 'buy milk', due: '2024-05-01', tags: [] })
  assert.deepEqual(parseLine('- [x] call Ann'), { done: true, title: 'call Ann', due: null, tags: [] })
})

test('tags are extracted, lowercased, de-duplicated and removed from the title', () => {
  const item = parseLine('- [ ] #Urgent call   Ann @due(2024-05-01) #home #URGENT')
  assert.deepEqual(item.tags, ['urgent', 'home'])
  assert.equal(item.title, 'call Ann')
  assert.equal(item.due, '2024-05-01')
})

test('only whole words starting with # are tags', () => {
  assert.deepEqual(parseLine('- [ ] fix C# build #dev').tags, ['dev'])
  assert.equal(parseLine('- [ ] fix C# build #dev').title, 'fix C# build')
  const item = parseLine('- [ ] see issue#12 #bug-fix #ops_2 # #work,')
  assert.deepEqual(item.tags, ['bug-fix', 'ops_2'])
  assert.equal(item.title, 'see issue#12 # #work,')
})

test('a line made only of tags has an empty title', () => {
  assert.deepEqual(parseLine('- [ ] #a #b'), { done: false, title: '', due: null, tags: ['a', 'b'] })
})

function sample() {
  const store = new TodoStore()
  const text = [
    '- [ ] write report #work @due(2024-03-01)',
    '- [x] gym #health',
    '- [ ] plan trip #home #Fun',
    '- [ ] review PR #work #dev',
    '- [ ] water plants',
  ].join('\n')
  for (const item of parseText(text)) store.add(item)
  return store
}

test('store filters by tag, case-insensitively and with or without #', () => {
  const store = sample()
  assert.deepEqual(store.list({ tag: 'work' }).map((i) => i.title), ['write report', 'review PR'])
  assert.deepEqual(store.list({ tag: '#FUN' }).map((i) => i.title), ['plan trip'])
  assert.deepEqual(store.list({ tag: 'missing' }), [])
})

test('the tag filter combines with the other filters', () => {
  const store = sample()
  assert.deepEqual(store.list({ tag: 'work', dueBefore: '2024-04-01' }).map((i) => i.title), ['write report'])
  assert.deepEqual(store.list({ tag: 'health', done: false }), [])
})

test('tagCounts sorts by count, then by name', () => {
  assert.deepEqual(sample().tagCounts(), [['work', 2], ['dev', 1], ['fun', 1], ['health', 1], ['home', 1]])
  assert.deepEqual(new TodoStore().tagCounts(), [])
})

test('formatting appends tags after the due date', () => {
  assert.equal(formatItem(parseLine('- [ ] #urgent call Ann @due(2024-05-01) #home')), '[ ] call Ann (due 2024-05-01) #urgent #home')
  assert.equal(formatItem(parseLine('- [x] gym #health')), '[x] gym #health')
  assert.equal(formatItem(parseLine('- [ ] water plants')), '[ ] water plants')
  assert.equal(formatItem({ done: false, title: 'legacy', due: null }), '[ ] legacy')
})
