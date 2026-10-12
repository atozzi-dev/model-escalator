/**
 * Business-day arithmetic on calendar dates written as ISO strings ("YYYY-MM-DD").
 *
 * Dates are calendar days, not instants: results must be the same whatever the time zone
 * of the machine, including on days when daylight saving time starts or ends.
 * Business days are Monday to Friday, except the dates listed in `holidays`
 * (an array of ISO strings).
 */

/** True when `iso` is a business day. */
export function isBusinessDay(iso, holidays = []) {
  const date = new Date(iso)
  const day = date.getDay()
  return day !== 0 && day !== 6 && !holidays.includes(toIso(date))
}

/**
 * Moves `n` business days away from `iso`: forward when n > 0, backward when n < 0.
 * The starting date is never counted and does not need to be a business day.
 * n = 0 returns `iso` unchanged.
 */
export function addBusinessDays(iso, n, holidays = []) {
  const date = new Date(iso)
  const step = n < 0 ? -1 : 1
  let left = Math.abs(n)
  while (left > 0) {
    date.setDate(date.getDate() + step)
    if (isBusinessDay(toIso(date), holidays)) left--
  }
  return toIso(date)
}

/**
 * Number of business days d with start < d <= end.
 * When end is before start the result is negative:
 * businessDaysBetween(a, b) === -businessDaysBetween(b, a).
 */
export function businessDaysBetween(start, end, holidays = []) {
  let count = 0
  const date = new Date(start)
  const last = new Date(end)
  while (date <= last) {
    if (isBusinessDay(toIso(date), holidays)) count++
    date.setDate(date.getDate() + 1)
  }
  return count
}

function toIso(date) {
  return date.toISOString().slice(0, 10)
}
