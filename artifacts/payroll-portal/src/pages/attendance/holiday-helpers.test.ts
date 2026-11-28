import assert from 'node:assert/strict';
import test from 'node:test';
import { formatRange, mismatchSummary, monthName, totalWorkingDays, weekdayRange } from './holiday-helpers';

test('dates show on the same calendar day in any time zone', () => {
  assert.equal(formatRange('2026-10-02', '2026-10-02'), '02 Oct 2026');
  assert.equal(formatRange('2026-10-12', '2026-10-21'), '12 Oct 2026 to 21 Oct 2026');
  assert.equal(weekdayRange('2026-10-02', '2026-10-02'), 'Fri');
  assert.equal(weekdayRange('2026-10-12', '2026-10-14'), 'Mon to Wed');
  assert.equal(monthName('2027-01'), 'January 2027');
});

test('mismatch summary names only the months that differ', () => {
  const months = [
    { month: '2026-06', workingDays: 14, printed: 14, matches: true },
    { month: '2026-07', workingDays: 25, printed: 26, matches: false },
    { month: '2026-08', workingDays: 22, printed: null, matches: null },
  ];
  assert.deepEqual(mismatchSummary(months), ['July 2026: 25 working days here, 26 on the official calendar']);
  assert.equal(totalWorkingDays(months), 61);
  assert.deepEqual(mismatchSummary([]), []);
});
