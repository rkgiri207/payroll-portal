import assert from 'node:assert/strict';
import test from 'node:test';
import { minutesLabel, NO_LIMIT, permissionMinuteOptions } from './settings-options';

test('the dropdown is No limit, then 5 minutes to 8 hours in 5-minute steps', () => {
  assert.deepEqual(permissionMinuteOptions[0], { value: NO_LIMIT, label: 'No limit' });
  const steps = permissionMinuteOptions.slice(1);
  assert.equal(steps.length, 96);
  assert.deepEqual(steps[0], { value: '5', label: '5 minutes' });
  assert.deepEqual(steps[1], { value: '10', label: '10 minutes' });
  assert.deepEqual(steps.at(-1), { value: '480', label: '8 hours' });
  assert.ok(steps.every((o, i) => Number(o.value) === (i + 1) * 5), 'strictly 5-minute steps');
  assert.equal(new Set(permissionMinuteOptions.map(o => o.value)).size, 97, 'no duplicates');
});

test('labels read naturally', () => {
  assert.equal(minutesLabel(5), '5 minutes');
  assert.equal(minutesLabel(55), '55 minutes');
  assert.equal(minutesLabel(60), '1 hour');
  assert.equal(minutesLabel(65), '1 hour 5 minutes');
  assert.equal(minutesLabel(90), '1 hour 30 minutes');
  assert.equal(minutesLabel(120), '2 hours');
  assert.equal(minutesLabel(125), '2 hours 5 minutes');
});
