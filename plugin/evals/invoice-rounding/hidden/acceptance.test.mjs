import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyDiscounts } from '../../src/discount.mjs'
import { buildInvoice } from '../../src/invoice.mjs'
import { formatMoney, parseMoney, parseRate, roundDiv } from '../../src/money.mjs'
import { computeTax } from '../../src/tax.mjs'

const isZero = (x) => Object.is(x, 0)

test('parseMoney: cents without float artefacts', () => {
  const cases = { '0.07': 7, '0.1': 10, '1.10': 110, '0.29': 29, '1.15': 115, '4.35': 435, '8.2': 820, '0.57': 57, '0.58': 58 }
  for (const [text, cents] of Object.entries(cases)) assert.equal(parseMoney(text), cents, text)
  assert.equal(parseMoney('12,345,678.9'), 1234567890)
  assert.equal(parseMoney('1,234'), 123400)
  assert.equal(parseMoney('-1,000.01'), -100001)
  assert.equal(parseMoney('001'), 100)
  assert.equal(parseMoney('90071992547409.91'), 9007199254740991)
})

test('parseMoney: limits and bad input', () => {
  assert.throws(() => parseMoney('90071992547409.92'), RangeError)
  assert.throws(() => parseMoney('9007199254740991'), RangeError)
  for (const bad of ['1,2345', '12,34', '1,,234', ',123', '-', '--1', '1.2.3', '1 000', '1_000', '0x10', '١٢']) {
    assert.throws(() => parseMoney(bad), TypeError, bad)
  }
  for (const bad of [5, null, undefined, {}]) assert.throws(() => parseMoney(bad), TypeError)
})

test('parseMoney: negative zero is zero', () => {
  assert.ok(isZero(parseMoney('-0')))
  assert.ok(isZero(parseMoney('-0.0')))
  assert.ok(isZero(parseMoney('-0.00')))
  assert.ok(isZero(parseMoney('-000')))
})

test('formatMoney', () => {
  const cases = new Map([[1, '0.01'], [99, '0.99'], [100, '1.00'], [-100, '-1.00'], [-99, '-0.99'], [-1, '-0.01'], [123456789, '1234567.89'], [1000, '10.00']])
  for (const [cents, text] of cases) assert.equal(formatMoney(cents), text)
  assert.equal(formatMoney(-0), '0.00')
  for (const bad of [1.5, NaN, Infinity, '5', null]) assert.throws(() => formatMoney(bad), TypeError)
})

test('formatMoney and parseMoney round-trip', () => {
  for (const cents of [0, 1, 9, 10, 99, 100, 101, 12345, -1, -10, -100, -12345, 999999999]) {
    assert.equal(parseMoney(formatMoney(cents)), cents)
  }
})

test('roundDiv: halves go away from zero, the rest to the nearest', () => {
  const cases = [
    [1, 2, 1], [-1, 2, -1], [3, 2, 2], [-3, 2, -2], [14, 4, 4], [-14, 4, -4], [13, 4, 3], [-13, 4, -3],
    [4999, 10000, 0], [5000, 10000, 1], [-5000, 10000, -1], [1649175, 10000, 165], [-1649175, 10000, -165],
    [10, 5, 2], [-10, 5, -2], [1, 1, 1], [-1, 1, -1],
  ]
  for (const [n, d, want] of cases) assert.equal(roundDiv(n, d), want, `${n}/${d}`)
})

test('roundDiv never returns negative zero', () => {
  assert.ok(isZero(roundDiv(0, 5)))
  assert.ok(isZero(roundDiv(-4999, 10000)))
  assert.ok(isZero(roundDiv(-1, 3)))
  assert.ok(isZero(roundDiv(-0, 7)))
})

test('parseRate: exact basis points', () => {
  const cases = { '0%': 0, '100%': 10000, '0.07%': 7, '0.5%': 50, '12.3%': 1230, '7.65%': 765, '0.29%': 29, '8.20%': 820, '1.15%': 115, '4.35%': 435, '7.25%': 725, '19%': 1900 }
  for (const [text, bp] of Object.entries(cases)) {
    const got = parseRate(text)
    assert.ok(Number.isInteger(got), `${text} gave ${got}`)
    assert.equal(got, bp, text)
  }
})

test('parseRate: bad input', () => {
  for (const bad of ['%', '-5%', '8.255%', '8.%', '.5%', '1000%', '8 %', ' 8%', '8%%', '8', 8, null]) {
    assert.throws(() => parseRate(bad), TypeError, String(bad))
  }
})

test('computeTax: line mode versus invoice mode', () => {
  const lines = [{ net: 333, taxable: true }, { net: 333, taxable: true }, { net: 334, taxable: true }]
  assert.equal(computeTax(lines, 800, 'line'), 81)
  assert.equal(computeTax(lines, 800, 'invoice'), 80)
  const small = [{ net: 5, taxable: true }, { net: 5, taxable: true }]
  assert.equal(computeTax(small, 500, 'line'), 0)
  assert.equal(computeTax(small, 500, 'invoice'), 1)
})

test('computeTax: exact halves round up in magnitude, for sales and returns', () => {
  assert.equal(computeTax([{ net: 50, taxable: true }], 100, 'line'), 1)
  assert.equal(computeTax([{ net: -50, taxable: true }], 100, 'line'), -1)
  assert.equal(computeTax([{ net: 200, taxable: true }], 725, 'line'), 15)
  assert.equal(computeTax([{ net: -200, taxable: true }], 725, 'invoice'), -15)
  assert.equal(computeTax([{ net: 1000, taxable: true }], 825, 'invoice'), 83)
  assert.equal(computeTax([{ net: -105, taxable: true }, { net: -105, taxable: true }], 825, 'line'), -18)
  assert.equal(computeTax([{ net: -105, taxable: true }, { net: -105, taxable: true }], 825, 'invoice'), -17)
})

test('computeTax: untaxable lines, no lines, bad mode, no negative zero', () => {
  assert.equal(computeTax([{ net: 1000, taxable: false }, { net: 1000, taxable: true }], 1000, 'line'), 100)
  assert.equal(computeTax([{ net: 1000, taxable: false }], 1000, 'invoice'), 0)
  assert.equal(computeTax([], 1000, 'line'), 0)
  assert.ok(isZero(computeTax([{ net: -4, taxable: true }], 100, 'invoice')))
  assert.ok(isZero(computeTax([{ net: -4, taxable: true }], 100, 'line')))
  assert.throws(() => computeTax([], 100, 'weekly'), RangeError)
  assert.throws(() => computeTax([], 100), RangeError)
})

test('applyDiscounts: percentage with halves away from zero', () => {
  const r = applyDiscounts([1999, 5], { percentOff: 1000 })
  assert.deepEqual(r.nets, [1799, 4])
  assert.equal(r.discount, 201)
  const back = applyDiscounts([-1999], { percentOff: 1000 })
  assert.deepEqual(back.nets, [-1799])
  assert.equal(back.discount, -200)
})

test('applyDiscounts: coupon capped at the total and ignored on non-positive lines', () => {
  assert.deepEqual(applyDiscounts([300, 200], { coupon: 1000 }), { nets: [0, 0], discount: 500 })
  assert.deepEqual(applyDiscounts([-500, 1000], { coupon: 300 }), { nets: [-500, 700], discount: 300 })
  assert.deepEqual(applyDiscounts([-500, 0], { coupon: 300 }), { nets: [-500, 0], discount: 0 })
  assert.deepEqual(applyDiscounts([], { coupon: 300 }), { nets: [], discount: 0 })
  assert.deepEqual(applyDiscounts([100, 200]), { nets: [100, 200], discount: 0 })
})

test('applyDiscounts: largest remainder, then earlier line on equal remainders', () => {
  assert.deepEqual(applyDiscounts([100, 200, 700], { coupon: 10 }).nets, [99, 198, 693])
  assert.deepEqual(applyDiscounts([100, 200, 700], { coupon: 7 }).nets, [99, 199, 695])
  assert.deepEqual(applyDiscounts([1, 1, 1], { coupon: 2 }).nets, [0, 0, 1])
  assert.deepEqual(applyDiscounts([1000, 1000, 1000], { coupon: 100 }).nets, [966, 967, 967])
  assert.deepEqual(applyDiscounts([3, 3, 3, 3], { coupon: 5 }).nets, [1, 2, 2, 2])
})

test('applyDiscounts: the coupon splits what is left after the percentage', () => {
  assert.deepEqual(applyDiscounts([1000, 1000], { percentOff: 5000, coupon: 300 }), { nets: [350, 350], discount: 1300 })
  assert.deepEqual(applyDiscounts([999, 1], { percentOff: 5000, coupon: 100 }), { nets: [399, 0], discount: 601 })
})

test('applyDiscounts does not modify its input and never returns negative zero', () => {
  const nets = [10, 0, -3]
  const r = applyDiscounts(nets, { percentOff: 0, coupon: 10 })
  assert.deepEqual(nets, [10, 0, -3])
  assert.ok(r.nets.every((n) => !Object.is(n, -0)))
  assert.deepEqual(r.nets, [0, 0, -3])
})

test('buildInvoice: tax is computed on the discounted amounts', () => {
  const invoice = buildInvoice({ lines: [{ sku: 'A', qty: 1, unitPrice: '100.00' }], percentOff: '10%', taxRate: '10%' })
  assert.equal(invoice.subtotal, 10000)
  assert.equal(invoice.discount, 1000)
  assert.equal(invoice.tax, 900)
  assert.equal(invoice.total, 9900)
  assert.deepEqual(invoice.lines, [{ sku: 'A', net: 9000 }])
})

test('buildInvoice: percentage before coupon, coupon on the remainder, only taxable lines taxed', () => {
  const invoice = buildInvoice({
    lines: [
      { sku: 'A', qty: 3, unitPrice: '19.99' },
      { sku: 'B', qty: 1, unitPrice: '5.00', taxable: false },
    ],
    percentOff: '10%',
    coupon: '2.00',
    taxRate: '8.25%',
  })
  assert.deepEqual(invoice.lines, [{ sku: 'A', net: 5212 }, { sku: 'B', net: 435 }])
  assert.deepEqual(invoice.formatted, { subtotal: '64.97', discount: '8.50', tax: '4.30', total: '60.77' })
})

test('buildInvoice: the tax mode changes the rounding', () => {
  const lines = [0, 1, 2].map((i) => ({ sku: `S${i}`, qty: 1, unitPrice: '0.33' }))
  assert.equal(buildInvoice({ lines, taxRate: '8%', taxMode: 'line' }).tax, 9)
  assert.equal(buildInvoice({ lines, taxRate: '8%', taxMode: 'invoice' }).tax, 8)
  assert.equal(buildInvoice({ lines, taxRate: '8%' }).tax, 9)
})

test('buildInvoice: returns and float traps', () => {
  const ret = buildInvoice({ lines: [{ sku: 'X', qty: -3, unitPrice: '0.50' }], percentOff: '50%', taxRate: '10%' })
  assert.equal(ret.subtotal, -150)
  assert.equal(ret.discount, -75)
  assert.equal(ret.tax, -8)
  assert.equal(ret.total, -83)
  assert.deepEqual(ret.formatted, { subtotal: '-1.50', discount: '-0.75', tax: '-0.08', total: '-0.83' })
  const trap = buildInvoice({ lines: [{ sku: 'T', qty: 2, unitPrice: '1.00' }], taxRate: '7.25%' })
  assert.equal(trap.tax, 15)
  assert.equal(trap.total, 215)
  const cheap = buildInvoice({ lines: [{ sku: 'T', qty: 3, unitPrice: '0.29' }], taxRate: '1.15%' })
  assert.equal(cheap.subtotal, 87)
  assert.equal(cheap.tax, 1)
})

test('buildInvoice: validation', () => {
  const ok = { sku: 'A', qty: 1, unitPrice: '1.00' }
  assert.throws(() => buildInvoice({ lines: [] }), RangeError)
  assert.throws(() => buildInvoice({}), RangeError)
  assert.throws(() => buildInvoice({ lines: [{ ...ok, qty: 0 }] }), RangeError)
  assert.throws(() => buildInvoice({ lines: [{ ...ok, qty: 1.5 }] }), RangeError)
  assert.throws(() => buildInvoice({ lines: [{ ...ok, qty: '2' }] }), RangeError)
  assert.throws(() => buildInvoice({ lines: [ok], coupon: '-1.00' }), RangeError)
  assert.throws(() => buildInvoice({ lines: [ok], taxMode: 'weekly' }), RangeError)
  assert.throws(() => buildInvoice({ lines: [{ ...ok, unitPrice: '1.234' }] }), TypeError)
  assert.throws(() => buildInvoice({ lines: [ok], percentOff: '10' }), TypeError)
  assert.throws(() => buildInvoice({ lines: [ok], taxRate: '-1%' }), TypeError)
})

test('buildInvoice: invariants hold on a few hundred generated invoices', () => {
  let seed = 12345
  const next = (n) => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed % n
  }
  for (let i = 0; i < 300; i++) {
    const lines = Array.from({ length: 1 + next(5) }, (_, k) => ({
      sku: `L${k}`,
      qty: (next(2) ? 1 : -1) * (1 + next(6)),
      unitPrice: `${next(50)}.${String(next(100)).padStart(2, '0')}`,
      taxable: next(3) !== 0,
    }))
    if (lines.every((l) => l.unitPrice === '0.00')) continue
    const invoice = buildInvoice({
      lines,
      percentOff: `${next(40)}.${String(next(100)).padStart(2, '0')}%`,
      coupon: `${next(30)}.${String(next(100)).padStart(2, '0')}`,
      taxRate: `${next(15)}.${String(next(100)).padStart(2, '0')}%`,
      taxMode: next(2) ? 'line' : 'invoice',
    })
    const label = JSON.stringify({ lines, invoice })
    for (const key of ['subtotal', 'discount', 'tax', 'total']) {
      assert.ok(Number.isInteger(invoice[key]) && !Object.is(invoice[key], -0), `${key} ${label}`)
    }
    assert.equal(invoice.total, invoice.subtotal - invoice.discount + invoice.tax, label)
    assert.equal(invoice.lines.reduce((s, l) => s + l.net, 0), invoice.subtotal - invoice.discount, label)
  }
})
