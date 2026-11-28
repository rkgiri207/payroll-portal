import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  attendanceSegments, attentionTotal, campusRate, checkInRate, clock, dayMonth, istMinutes, noticeFor, permissionActive, rateTone, weekdayShort,
} from './dashboard-stats';

test('segments add up to 100 and the numbers are split four ways', () => {
  const { segments, total } = attendanceSegments({ present: 41, late: 3, unmarked: 9, onLeave: 1 });
  assert.equal(total, 51);
  assert.deepEqual(segments.map(s => s.value), [38, 3, 9, 1]);
  assert.equal(segments.reduce((a, s) => a + s.percent, 0), 100);
  for (const t of [[1, 1, 1], [1, 2, 4], [7, 3, 3]]) {
    const r = attendanceSegments({ present: t[0], late: 0, unmarked: t[1], onLeave: t[2] });
    assert.equal(r.segments.reduce((a, s) => a + s.percent, 0), 100);
  }
  const empty = attendanceSegments({ present: 0, late: 0, unmarked: 0, onLeave: 0 });
  assert.equal(empty.total, 0);
  assert.equal(empty.segments.reduce((a, s) => a + s.percent, 0), 0);
});

test('check-in rate and its tone', () => {
  assert.equal(checkInRate({ expected: 0, present: 0 }), null);
  assert.equal(checkInRate({ expected: 50, present: 41 }), 82);
  assert.equal(checkInRate({ expected: 2, present: 3 }), 100, 'never over 100');
  assert.equal(campusRate({ expected: 20, present: 14 }), 70);
  assert.equal(rateTone(null), 'neutral');
  assert.equal(rateTone(90), 'good');
  assert.equal(rateTone(89), 'warn');
  assert.equal(rateTone(60), 'warn');
  assert.equal(rateTone(59), 'bad');
});

test('day notices', () => {
  const s = { expected: 5, onLeave: 0 };
  assert.equal(noticeFor(null, s), null);
  assert.equal(noticeFor({ kind: 'HOLIDAY', name: 'Diwali' }, s)?.title, 'Holiday: Diwali');
  assert.match(noticeFor({ kind: 'OPTIONAL', name: 'X' }, s)?.title ?? '', /Optional holiday/);
  assert.equal(noticeFor(null, { expected: 0, onLeave: 0 })?.title, 'No shifts today');
  assert.equal(noticeFor(null, { expected: 0, onLeave: 2 }), null, 'everyone away on leave is not "no shifts"');
});

test('attention total', () => {
  assert.equal(attentionTotal({ leave: 2, permission: 1, review: 4, exceptions: 2, failedAlerts: 1 }), 10);
  assert.equal(attentionTotal({ leave: 0, permission: 0, review: 0, exceptions: 0, failedAlerts: 0 }), 0);
});

test('permission window: starts inclusive, ends exclusive', () => {
  const p = { startTime: '10:00', endTime: '12:00' };
  assert.equal(permissionActive(p, 599), false);
  assert.equal(permissionActive(p, 600), true);
  assert.equal(permissionActive(p, 719), true);
  assert.equal(permissionActive(p, 720), false);
});

test('dates and clock wording', () => {
  assert.equal(weekdayShort('2026-03-02'), 'Mon');
  assert.equal(dayMonth('2026-09-09'), '09 Sep');
  assert.equal(clock('00:05'), '12:05 AM');
  assert.equal(clock('12:00'), '12:00 PM');
  assert.equal(clock('15:30'), '3:30 PM');
  assert.equal(istMinutes('2026-03-02T05:30:00Z'), 11 * 60);
});
