import { roundDiv } from './money.mjs'

/**
 * Applies a percentage discount and then a fixed coupon to the net amount of each invoice line.
 *
 *   applyDiscounts(nets, { percentOff = 0, coupon = 0 }) -> { nets, discount }
 *
 * `nets` are integer cents per line (negative for returns), `percentOff` is in basis points (1000 is
 * 10%) and `coupon` is a non-negative number of cents.
 *
 * 1. Percentage first: each line is reduced by roundDiv(net * percentOff, 10000) (halves away from
 *    zero, so a return is reduced by the same magnitude as the sale).
 * 2. Then the coupon. Only lines whose remaining net is positive take part. The coupon is capped at
 *    the sum of their nets (a coupon never turns the invoice negative) and split across them in
 *    proportion to their net by the largest remainder method: line i gets
 *    floor(cap * net_i / sum) cents, then the cents still unassigned go one each to the lines with
 *    the largest remainder of that division; equal remainders go to the earlier line first.
 *
 * Returns the discounted nets (same order) and the total discount, which is the percentage part plus
 * the part of the coupon that was applied.
 */
export function applyDiscounts(nets, { percentOff = 0, coupon = 0 } = {}) {
  let discount = 0
  const afterPercent = nets.map((net) => {
    const cut = Math.round((net * percentOff) / 10000)
    discount += cut
    return net - cut
  })

  const eligible = afterPercent.map((net, index) => ({ net, index })).filter((line) => line.net > 0)
  const sum = eligible.reduce((total, line) => total + line.net, 0)
  const cap = coupon
  if (cap === 0) return { nets: afterPercent, discount }

  const shares = eligible.map((line) => {
    const product = cap * line.net
    const remainder = product % sum
    return { index: line.index, share: (product - remainder) / sum, remainder }
  })
  let left = cap - shares.reduce((total, line) => total + line.share, 0)
  const byRemainder = [...shares].sort((a, b) => b.remainder - a.remainder || b.index - a.index)
  for (const line of byRemainder) {
    if (left === 0) break
    line.share += 1
    left -= 1
  }

  const result = [...afterPercent]
  for (const line of shares) result[line.index] -= line.share
  return { nets: result, discount: discount + cap }
}
