/**
 * Money is always an integer number of cents, never a float.
 */

/**
 * Parses an amount such as "12", "12.3", "12.34", "-0.05" or "1,234.50" into integer cents.
 *
 * - An optional leading "-" is allowed; "+", spaces and exponents are not.
 * - The whole part is either plain digits or digits with thousands commas: a group of one to three
 *   digits followed by groups of exactly three ("1,234", "12,345,678"; "1,23" and "1234,567" are invalid).
 * - The fraction is optional and has one or two digits ("12.3" is 1230 cents); "12.", ".5" and "1.234"
 *   are invalid.
 * - "-0" and "-0.00" parse to 0 (never to -0).
 * - Anything invalid throws a TypeError; an amount beyond Number.MAX_SAFE_INTEGER cents throws a RangeError.
 */
export function parseMoney(text) {
  const match = /^(-)?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$/.exec(String(text))
  if (typeof text !== 'string' || !match) throw new TypeError(`invalid amount: ${text}`)
  const cents = Math.floor(Number(text.replaceAll(',', '')) * 100)
  if (!Number.isSafeInteger(cents)) throw new RangeError(`amount out of range: ${text}`)
  return cents
}

/**
 * Formats integer cents as a decimal string with two digits after the point and a leading "-" for
 * negative amounts: 105 -> "1.05", -5 -> "-0.05", 0 -> "0.00", -123456 -> "-1234.56".
 * Throws a TypeError when `cents` is not an integer.
 */
export function formatMoney(cents) {
  if (!Number.isInteger(cents)) throw new TypeError(`not an integer amount: ${cents}`)
  const units = Math.trunc(cents / 100)
  const rest = String(Math.abs(cents % 100)).padStart(2, '0')
  return `${units}.${rest}`
}

/**
 * Divides the integer `n` by the positive integer `d` and rounds to the nearest integer, with exact
 * halves going away from zero: roundDiv(5, 2) is 3 and roundDiv(-5, 2) is -3. Never returns -0.
 */
export function roundDiv(n, d) {
  return Math.round(n / d)
}

/**
 * Parses a percentage with at most two decimals ("8%", "8.25%", "0.5%", "100%") into basis points
 * (hundredths of a percent): "8.25%" -> 825. The result is always an integer. Anything else, including
 * a missing "%" or a negative value, throws a TypeError.
 */
export function parseRate(text) {
  const match = /^(\d{1,3})(?:\.(\d{1,2}))?%$/.exec(String(text))
  if (typeof text !== 'string' || !match) throw new TypeError(`invalid rate: ${text}`)
  return Math.floor(parseFloat(text) * 100)
}
