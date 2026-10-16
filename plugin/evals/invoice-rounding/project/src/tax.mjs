import { roundDiv } from './money.mjs'

/**
 * Computes the total sales tax of an invoice.
 *
 *   computeTax(lines, rateBp, mode) -> cents
 *
 * `lines` are `{ net, taxable }` with `net` in integer cents (after discounts, negative for returns)
 * and `rateBp` the rate in basis points (825 is 8.25%). Lines that are not taxable are ignored.
 *
 * - mode "line": the tax of each taxable line is rounded on its own, roundDiv(net * rateBp, 10000)
 *   (halves away from zero), and the invoice tax is the sum of those rounded amounts.
 * - mode "invoice": the taxable nets are added up first and the tax is rounded once,
 *   roundDiv(sum * rateBp, 10000).
 *
 * Any other mode throws a RangeError.
 */
export function computeTax(lines, rateBp, mode) {
  const taxable = lines.filter((line) => line.taxable)
  if (mode === 'line') {
    return taxable.reduce((total, line) => total + roundDiv(line.net * rateBp, 10000), 0)
  }
  if (mode === 'invoice') {
    return taxable.reduce((total, line) => total + roundDiv(line.net * rateBp, 10000), 0)
  }
  throw new RangeError(`unknown tax mode: ${mode}`)
}
