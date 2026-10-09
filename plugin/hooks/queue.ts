// A tiny promise-chain serializer: tasks run one at a time, in arrival order.
// A task that throws rejects only its own promise; the chain carries on with the next one.
export type Queue = <T>(task: () => T | Promise<T>) => Promise<T>

export function createQueue(): Queue {
  let tail: Promise<unknown> = Promise.resolve()
  return <T>(task: () => T | Promise<T>): Promise<T> => {
    const run = tail.then(task)
    tail = run.catch(() => undefined)
    return run
  }
}
