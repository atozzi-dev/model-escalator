/**
 * In-memory list of todo items (as returned by parseLine).
 * Items keep their insertion order.
 */
export class TodoStore {
  #items = []

  add(item) {
    this.#items.push(item)
    return this
  }

  /**
   * Returns the items matching every given filter, in insertion order.
   * - `done`: true or false to keep only done or open items.
   * - `dueBefore`: ISO date; keeps items with a due date strictly before it.
   */
  list({ done, dueBefore } = {}) {
    return this.#items.filter((item) => {
      if (done !== undefined && item.done !== done) return false
      if (dueBefore !== undefined && !(item.due !== null && item.due < dueBefore)) return false
      return true
    })
  }
}
