import { expect, test } from 'claude-code/testing'
import { createQueue } from '../hooks/queue'

const ticks = async (n: number): Promise<void> => { for (let i = 0; i < n; i++) await Promise.resolve() }

test('tasks run one at a time, in arrival order', async () => {
  const q = createQueue()
  const log: string[] = []
  const task = (name: string, delay: number) => q(async () => {
    log.push('start ' + name)
    await ticks(delay)
    log.push('end ' + name)
    return name
  })
  const results = await Promise.all([task('a', 10), task('b', 1), task('c', 5)])
  expect(results).toEqual(['a', 'b', 'c'])
  expect(log).toEqual(['start a', 'end a', 'start b', 'end b', 'start c', 'end c'])
})

test('a read-modify-write done through the queue never loses an update', async () => {
  const q = createQueue()
  let value = 0
  const bump = () => q(async () => {
    const current = value
    await ticks(3)
    value = current + 1
  })
  await Promise.all([bump(), bump(), bump()])
  expect(value).toBe(3)
})

test('a task that throws rejects its own promise but not the next ones', async () => {
  const q = createQueue()
  const bad = q(async () => { throw new Error('boom') })
  const good = q(() => 'ok')
  let message = ''
  try { await bad } catch (err) { message = (err as Error).message }
  expect(message).toBe('boom')
  expect(await good).toBe('ok')
  expect(await q(() => 'again')).toBe('again')
})

test('a synchronous throw is handled like an async one', async () => {
  const q = createQueue()
  const bad = q(() => { throw new Error('sync') })
  const good = q(() => 1)
  let caught = false
  try { await bad } catch { caught = true }
  expect(caught).toBe(true)
  expect(await good).toBe(1)
})
