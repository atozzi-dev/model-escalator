// Shared acceptance cases, run once per time zone by the *.test.mjs files next to this one.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { addBusinessDays, businessDaysBetween, isBusinessDay } from '../../src/bizdays.mjs'
import { invoiceDueDate, overdueBusinessDays } from '../../src/schedule.mjs'

// Independent oracle: day of week from the calendar date alone (Sakamoto's method), 0 = Sunday.
function weekday(iso) {
  let [y, m, d] = iso.split('-').map(Number)
  const t = [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4]
  if (m < 3) y -= 1
  return (y + Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400) + t[m - 1] + d) % 7
}

function* days(fromIso, count) {
  const [y, m, d] = fromIso.split('-').map(Number)
  for (let i = 0; i < count; i++) yield new Date(Date.UTC(y, m - 1, d + i)).toISOString().slice(0, 10)
}

export function defineCases(zone) {
  process.env.TZ = zone

  test(`[${zone}] every day of 2024-2025 has the right weekday`, () => {
    for (const iso of days('2024-01-01', 731)) {
      const wd = weekday(iso)
      assert.equal(isBusinessDay(iso), wd !== 0 && wd !== 6, iso)
    }
  })

  test(`[${zone}] holidays`, () => {
    assert.equal(isBusinessDay('2024-12-25', ['2024-12-25']), false)
    assert.equal(isBusinessDay('2024-12-24', ['2024-12-25']), true)
    assert.equal(addBusinessDays('2024-12-24', 1, ['2024-12-25', '2024-12-26']), '2024-12-27')
    assert.equal(addBusinessDays('2024-12-31', 1, ['2025-01-01']), '2025-01-02')
  })

  test(`[${zone}] adding across month ends, leap days and DST changes`, () => {
    assert.equal(addBusinessDays('2024-02-28', 1), '2024-02-29')
    assert.equal(addBusinessDays('2024-02-28', 2), '2024-03-01')
    assert.equal(addBusinessDays('2024-03-29', 1), '2024-04-01') // Europe and NZ change clocks around here
    assert.equal(addBusinessDays('2024-04-05', 1), '2024-04-08')
    assert.equal(addBusinessDays('2024-10-25', 1), '2024-10-28')
    assert.equal(addBusinessDays('2024-11-01', 1), '2024-11-04')
    assert.equal(addBusinessDays('2024-03-08', 5), '2024-03-15')
    assert.equal(addBusinessDays('2024-01-01', 261), '2024-12-31')
  })

  test(`[${zone}] starting on a weekend, going backwards, and n = 0`, () => {
    assert.equal(addBusinessDays('2024-03-09', 1), '2024-03-11')
    assert.equal(addBusinessDays('2024-03-10', -1), '2024-03-08')
    assert.equal(addBusinessDays('2024-04-01', -1), '2024-03-29')
    assert.equal(addBusinessDays('2024-03-04', -5), '2024-02-26')
    assert.equal(addBusinessDays('2024-03-09', 0), '2024-03-09')
  })

  test(`[${zone}] counting is start-exclusive, end-inclusive and antisymmetric`, () => {
    assert.equal(businessDaysBetween('2024-03-08', '2024-03-08'), 0)
    assert.equal(businessDaysBetween('2024-03-08', '2024-03-09'), 0)
    assert.equal(businessDaysBetween('2024-03-09', '2024-03-11'), 1)
    assert.equal(businessDaysBetween('2024-03-11', '2024-03-08'), -1)
    assert.equal(businessDaysBetween('2024-01-01', '2024-12-31'), 261)
    assert.equal(businessDaysBetween('2024-12-31', '2024-01-01'), -261)
    assert.equal(businessDaysBetween('2024-01-01', '2024-12-31', ['2024-12-25', '2024-12-26', '2024-06-01']), 259)
  })

  test(`[${zone}] adding and counting agree`, () => {
    const holidays = ['2024-04-01', '2024-12-25']
    for (const start of days('2024-03-20', 20)) {
      for (const n of [1, 2, 3, 7, 30]) {
        const end = addBusinessDays(start, n, holidays)
        assert.equal(businessDaysBetween(start, end, holidays), n, `${start} + ${n} = ${end}`)
        assert.equal(isBusinessDay(end, holidays), true, end)
      }
    }
  })

  test(`[${zone}] invoices`, () => {
    assert.equal(invoiceDueDate('2024-03-22', 5), '2024-03-29')
    assert.equal(invoiceDueDate('2024-03-22', 6), '2024-04-01')
    assert.equal(overdueBusinessDays('2024-03-22', 5, '2024-03-29'), 0)
    assert.equal(overdueBusinessDays('2024-03-22', 5, '2024-03-25'), 0)
    assert.equal(overdueBusinessDays('2024-03-22', 5, '2024-04-02'), 2)
  })
}
