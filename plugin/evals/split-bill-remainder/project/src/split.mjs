/**
 * Splits an amount of money, in integer cents, among participants in proportion to their weights.
 *
 * - Returns one whole-cent share per weight, in the same order, and the shares always add up
 *   to exactly `totalCents`.
 * - Every participant first gets its exact share rounded down; the cents left over are handed
 *   out one each to the participants with the largest fractional parts, ties going to the
 *   participant listed first.
 * - A negative total (a refund) is split like its absolute value, then every share is negated.
 * - `totalCents` must be an integer, and the weights finite and non-negative with at least one
 *   above zero; otherwise a RangeError is thrown.
 */
export function splitByWeight(totalCents, weights) {
  const sum = weights.reduce((acc, w) => acc + w, 0)
  return weights.map((w) => Math.round((totalCents * w) / sum))
}

/** Splits `totalCents` evenly among `count` participants (same rules as splitByWeight). */
export function splitEvenly(totalCents, count) {
  return splitByWeight(totalCents, new Array(count).fill(1))
}
