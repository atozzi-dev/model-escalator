import { addBusinessDays, businessDaysBetween } from './bizdays.mjs'

/**
 * Due date of an invoice issued on `issuedIso` with payment terms of `termDays` business days.
 * The holidays of the issuing office apply.
 */
export function invoiceDueDate(issuedIso, termDays, holidays = []) {
  return addBusinessDays(issuedIso, termDays, holidays)
}

/**
 * Business days an invoice is overdue on `todayIso`: 0 when it is not yet due,
 * otherwise the number of business days after its due date up to and including today.
 */
export function overdueBusinessDays(issuedIso, termDays, todayIso, holidays = []) {
  const due = invoiceDueDate(issuedIso, termDays, holidays)
  return Math.max(0, businessDaysBetween(due, todayIso, holidays))
}
