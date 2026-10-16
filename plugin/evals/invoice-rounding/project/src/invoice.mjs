import { applyDiscounts } from './discount.mjs'
import { formatMoney, parseMoney, parseRate } from './money.mjs'
import { computeTax } from './tax.mjs'

/**
 * Builds an invoice.
 *
 *   buildInvoice({ lines, percentOff = '0%', coupon = '0', taxRate = '0%', taxMode = 'line' })
 *
 * Each line is `{ sku, qty, unitPrice, taxable = true }`: `qty` is a non-zero integer (negative for a
 * return), `unitPrice` an amount string for `parseMoney`. A line's net is qty * unit price in cents.
 * `percentOff` and `taxRate` are percentage strings for `parseRate`, `coupon` is an amount string for
 * `parseMoney` and must not be negative. A bad quantity, a negative coupon or an empty list of lines
 * throws a RangeError; a malformed amount or rate throws the TypeError of the parser.
 *
 * Order of operations: net amounts, then the discounts (see `applyDiscounts`), then the tax on the
 * DISCOUNTED amounts of the taxable lines (see `computeTax`).
 *
 * Returns integer cents:
 *   { lines: [{ sku, net }], subtotal, discount, tax, total, formatted }
 * where `net` is the discounted net of the line, `subtotal` the sum of the nets before discounts,
 * `discount` the total discount, `tax` the tax and `total` = subtotal - discount + tax. `formatted`
 * has the same four amounts as strings from `formatMoney`.
 */
export function buildInvoice({ lines, percentOff = '0%', coupon = '0', taxRate = '0%', taxMode = 'line' }) {
  if (!Array.isArray(lines) || lines.length === 0) throw new RangeError('an invoice needs at least one line')
  const items = lines.map((line) => {
    if (!Number.isInteger(line.qty) || line.qty === 0) throw new RangeError(`invalid quantity for ${line.sku}`)
    return { sku: line.sku, taxable: line.taxable || true, net: line.qty * parseMoney(line.unitPrice) }
  })
  const couponCents = parseMoney(coupon)
  if (couponCents < 0) throw new RangeError('the coupon cannot be negative')

  const subtotal = items.reduce((total, item) => total + item.net, 0)
  const discounted = applyDiscounts(
    items.map((item) => item.net),
    { percentOff: parseRate(percentOff), coupon: couponCents },
  )
  const result = items.map((item, index) => ({ sku: item.sku, net: discounted.nets[index], taxable: item.taxable }))
  const tax = computeTax(items, parseRate(taxRate), taxMode)
  const total = subtotal - discounted.discount + tax

  return {
    lines: result.map(({ sku, net }) => ({ sku, net })),
    subtotal,
    discount: discounted.discount,
    tax,
    total,
    formatted: {
      subtotal: formatMoney(subtotal),
      discount: formatMoney(discounted.discount),
      tax: formatMoney(tax),
      total: formatMoney(total),
    },
  }
}
