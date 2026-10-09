/**
 * Formats integer cents as an amount with two decimals and a comma every three digits,
 * for example 123456 -> "1,234.56", -5 -> "-0.05", 0 -> "0.00".
 */
export function formatCents(cents) {
  const units = Math.floor(cents / 100)
  const rest = cents % 100
  return `${units.toLocaleString('en-US')}.${String(rest).padStart(2, '0')}`
}
