/**
 * Splits `items` into pages of `pageSize` items and returns page `page` (1-based).
 *
 * - The last page may hold fewer than `pageSize` items.
 * - An empty list has exactly one, empty, page.
 * - A page number below 1 or above the last page is clamped to the nearest valid page.
 * - `pageSize` must be a positive integer, otherwise a RangeError is thrown.
 */
export function paginate(items, page, pageSize) {
  if (!Number.isInteger(pageSize) || pageSize < 1) {
    throw new RangeError('pageSize must be a positive integer')
  }
  const totalPages = Math.max(1, Math.floor(items.length / pageSize))
  const current = Math.min(Math.max(1, page), totalPages)
  const start = current * pageSize
  return {
    page: current,
    totalPages,
    items: items.slice(start, start + pageSize),
    hasPrev: current > 1,
    hasNext: current < totalPages,
  }
}
