/**
 * Formats an item for display, for example "[x] buy milk (due 2024-05-01)".
 * The due part is left out when the item has no due date.
 */
export function formatItem(item) {
  const box = item.done ? '[x]' : '[ ]'
  const due = item.due ? ` (due ${item.due})` : ''
  return `${box} ${item.title}${due}`
}
