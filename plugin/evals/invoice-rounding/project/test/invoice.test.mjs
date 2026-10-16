import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildInvoice } from '../src/invoice.mjs'
import { formatMoney, parseMoney } from '../src/money.mjs'
import { computeTax } from '../src/tax.mjs'

test('parseMoney reads cents without float rounding', () => {
  assert.equal(parseMoney('12'), 1200)
  assert.equal(parseMoney('12.3'), 1230)
  assert.equal(parseMoney('0.29'), 29)
  assert.equal(parseMoney('19.99'), 1999)
  assert.equal(parseMoney('1,234.50'), 123450)
  assert.equal(parseMoney('-0.05'), -5)
})

test('parseMoney rejects malformed amounts', () => {
  for (const bad of ['', '1.', '.5', '1.234', '1,23', '1234,567', '+5', ' 5', '1e3', 'abc']) {
    assert.throws(() => parseMoney(bad), TypeError, bad)
  }
})

test('formatMoney pads the cents and keeps the sign', () => {
  assert.equal(formatMoney(105), '1.05')
  assert.equal(formatMoney(-5), '-0.05')
  assert.equal(formatMoney(0), '0.00')
  assert.equal(formatMoney(-123456), '-1234.56')
})

test('line mode rounds each line, invoice mode rounds once', () => {
  const lines = [
    { net: 105, taxable: true },
    { net: 105, taxable: true },
  ]
  assert.equal(computeTax(lines, 825, 'line'), 18)
  assert.equal(computeTax(lines, 825, 'invoice'), 17)
})

test('a complete invoice', () => {
  const invoice = buildInvoice({
    lines: [
      { sku: 'A', qty: 3, unitPrice: '19.99' },
      { sku: 'B', qty: 1, unitPrice: '5.00', taxable: false },
    ],
    percentOff: '10%',
    coupon: '2.00',
    taxRate: '8.25%',
  })
  assert.equal(invoice.subtotal, 6497)
  assert.deepEqual(invoice.lines, [
    { sku: 'A', net: 5212 },
    { sku: 'B', net: 435 },
  ])
  assert.deepEqual(invoice.formatted, { subtotal: '64.97', discount: '8.50', tax: '4.30', total: '60.77' })
})
