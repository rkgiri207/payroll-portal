import assert from 'node:assert/strict';
import test from 'node:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Me, SettingRow } from './api';
import { fromDraft, META, SettingsTab, toDraft } from './settings-tab';
import { keys } from './use-attendance';

const me: Me = { userId: 1, role: 'DIRECTOR', canEditDirectorSettings: true, whatsappMode: 'live' };
const row = (value: unknown): SettingRow => ({ key: 'permission_max_minutes', value, description: null, hint: null, directorOnly: false });
const meta = META.permission_max_minutes;

function render(value: unknown, role: Me['role'] = 'DIRECTOR') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(keys.settings, [row(value)]);
  client.setQueryData(keys.me, { ...me, role });
  return renderToStaticMarkup(<QueryClientProvider client={client}><SettingsTab /></QueryClientProvider>);
}

test('the longest permission is a dropdown, not a free-text box', () => {
  const html = render(90);
  assert.match(html, /Longest single permission/);
  assert.match(html, /Choose in steps of 5 minutes, or No limit/);
  assert.match(html, /<button[^>]*role="combobox"[^>]*id="setting-permission_max_minutes"/, 'a dropdown');
  assert.ok(!/<input[^>]*id="setting-permission_max_minutes"/.test(html), 'not a text input');
});

test('the dropdown offers No limit and 96 five-minute steps', () => {
  assert.equal(meta.kind, 'select');
  assert.equal(meta.options?.length, 97);
  assert.equal(meta.options?.[0].label, 'No limit');
  assert.equal(meta.options?.[1].label, '5 minutes');
  assert.equal(meta.options?.at(-1)?.label, '8 hours');
});

test('what is saved is shown as a choice, and the choice is saved as a number (or empty for no limit)', () => {
  assert.equal(toDraft(row(90), meta), '90');
  assert.equal(toDraft(row(null), meta), 'none', 'empty is shown as No limit');
  assert.equal(fromDraft('90', meta), 90);
  assert.equal(fromDraft('5', meta), 5);
  assert.equal(fromDraft('none', meta), null, 'No limit is saved as empty');
  // The round trip never changes the value.
  for (const v of [null, 5, 60, 95, 480]) assert.equal(fromDraft(toDraft(row(v), meta), meta), v);
});

test('a saved value outside the steps is still shown, so the screen never hides what is stored', () => {
  assert.equal(toDraft(row(7), meta), '7');
  assert.ok(!meta.options!.some(o => o.value === '7'), 'it is not one of the steps; the field adds it as "(current)" itself');
});

test('the other numeric fields still behave as before', () => {
  assert.equal(fromDraft('12', META.leave_cap_per_campus_per_day), 12);
  assert.equal(fromDraft('', META.permission_max_per_month), null);
  assert.equal(toDraft({ key: 'x', value: null, description: null, hint: null, directorOnly: false }, META.permission_max_per_month), '');
  assert.equal(fromDraft('true', META.allow_attendance_outside_academic_year), true);
  assert.equal(fromDraft('45', META.digest_interval_minutes), 45, 'other dropdowns still save numbers');
});

test('an administrator can change it too (only the Director-only settings are locked)', () => {
  assert.ok(!/Only the Director can change this/.test(render(90, 'ADMIN')));
});
