import { expect, test } from 'claude-code/testing'

import { addTo, dayOf, describeLedger, empty, parseLedger, totalOf } from '../hooks/ledger'

const delta = { runs: 1, tokens: 100, cost: 1, base: 3, saved: 2 }

test('a ledger sums per day and in total', () => {
  let ledger = addTo(empty(), '2026-11-01', delta)
  ledger = addTo(ledger, '2026-11-01', delta)
  ledger = addTo(ledger, '2026-11-02', { ...delta, escalated: 1, saved: -1 })

  expect(ledger.days['2026-11-01']?.runs).toBe(2)
  expect(ledger.days['2026-11-02']?.escalated).toBe(1)
  expect(totalOf(ledger)).toEqual({ runs: 3, tokens: 300, cost: 3, base: 9, saved: 3, escalated: 1, redone: 0 })
})

test('a correction moves the savings without adding a run', () => {
  const ledger = addTo(addTo(empty(), '2026-11-01', delta), '2026-11-02', { saved: -3, redone: 1 })
  expect(totalOf(ledger).runs).toBe(1)
  expect(totalOf(ledger).saved).toBe(-1)
  expect(totalOf(ledger).redone).toBe(1)
})

test('what the store holds is only trusted when it is a ledger', () => {
  expect(parseLedger(undefined)).toEqual(empty())
  expect(parseLedger('junk')).toEqual(empty())
  expect(parseLedger({ version: 99, days: {} })).toEqual(empty())
  const good = addTo(empty(), '2026-11-01', delta)
  expect(parseLedger(JSON.parse(JSON.stringify(good)))).toEqual(good)
  // A bad day is dropped, a good one kept, and the prototype is out of reach.
  const mixed = parseLedger({
    version: 1,
    days: { '2026-11-01': good.days['2026-11-01'], '2026-11-02': { runs: 'x' }, nonsense: good.days['2026-11-01'] },
  })
  expect(Object.keys(mixed.days)).toEqual(['2026-11-01'])
})

test('the report says what was saved and since when', () => {
  expect(describeLedger(empty())).toContain('Nothing recorded yet')
  const text = describeLedger(addTo(addTo(empty(), '2026-11-02', delta), '2026-11-01', delta))
  expect(text).toContain('since 2026-11-01')
  expect(text).toContain('saved ~$4.00')
  expect(text).toContain('2 runs')
})

test('a day is the UTC date of a clock reading', () => {
  expect(dayOf(Date.UTC(2026, 10, 1, 23, 59))).toBe('2026-11-01')
})
