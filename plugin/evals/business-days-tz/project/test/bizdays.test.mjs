import { test } from 'node:test'
import assert from 'node:assert/strict'
import { addBusinessDays, businessDaysBetween, isBusinessDay } from '../src/bizdays.mjs'
import { invoiceDueDate, overdueBusinessDays } from '../src/schedule.mjs'

// Our office runs these tests on machines in New York.
process.env.TZ = 'America/New_York'

test('weekdays and weekends', () => {
  assert.equal(isBusinessDay('2024-03-08'), true) // Friday
  assert.equal(isBusinessDay('2024-03-09'), false) // Saturday
  assert.equal(isBusinessDay('2024-03-11'), true) // Monday
})

test('adding business days skips the weekend', () => {
  assert.equal(addBusinessDays('2024-03-08', 1), '2024-03-11')
  assert.equal(addBusinessDays('2024-03-11', -1), '2024-03-08')
})

test('counting business days excludes the start date', () => {
  assert.equal(businessDaysBetween('2024-03-08', '2024-03-11'), 1)
  assert.equal(businessDaysBetween('2024-03-04', '2024-03-08'), 4)
})

test('invoices', () => {
  assert.equal(invoiceDueDate('2024-03-01', 10), '2024-03-15')
  assert.equal(overdueBusinessDays('2024-03-01', 10, '2024-03-19'), 2)
})
