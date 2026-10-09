/**
 * Human readable label for a page returned by `paginate`, for example
 * "Page 2 of 3 (items 11-20 of 25)". Item numbers are 1-based and inclusive.
 * An empty list is labelled "No items".
 */
export function describePage(result, totalItems, pageSize) {
  if (totalItems === 0) return 'No items'
  const first = (result.page - 1) * pageSize + 1
  const last = first + result.items.length
  return `Page ${result.page} of ${result.totalPages} (items ${first}-${last} of ${totalItems})`
}
