import { expect, test } from 'claude-code/testing'

import { isRaised, rungOf, shiftsDown } from '../hooks/budget'

test('the fullest window sets the rung', () => {
  expect(rungOf([])).toBe('ok')
  expect(rungOf([{ percentUsed: 74.9 }])).toBe('ok')
  expect(rungOf([{ percentUsed: 20 }, { percentUsed: 75 }])).toBe('tight')
  expect(rungOf([{ percentUsed: 90 }])).toBe('critical')
  expect(rungOf([{ percentUsed: Number.NaN }])).toBe('ok')
})

test('tight shifts only unplaced tasks, critical every placed one', () => {
  expect(shiftsDown('tight', 'open')).toBe(true)
  expect(shiftsDown('tight', 'builder')).toBe(false)
  expect(shiftsDown('critical', 'builder')).toBe(true)
  expect(shiftsDown('ok', 'open')).toBe(false)
  expect(isRaised('ok', 'tight')).toBe(true)
  expect(isRaised('critical', 'tight')).toBe(false)
})
