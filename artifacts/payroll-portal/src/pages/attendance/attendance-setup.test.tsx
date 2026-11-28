import assert from 'node:assert/strict';
import test from 'node:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  ApiError, describeWeekdays, formatWhatsapp, shiftStatuses, todayIst,
  type Campus, type ChecklistItem, type EmployeeRow, type Me, type SettingRow, type SetupStatus, type Shift,
} from './api';
import { CampusesTab } from './campuses-tab';
import { EmployeesTab } from './employees-tab';
import { SettingsTab } from './settings-tab';
import { SetupChecklist } from './setup-checklist';
import AttendanceSetupPage, { AccessMessage } from './setup';
import { keys } from './use-attendance';

// ── Helpers ───────────────────────────────────────────────────────────────────
test('working days read naturally', () => {
  assert.equal(describeWeekdays([1, 2, 3, 4, 5]), 'Mon–Fri');
  assert.equal(describeWeekdays([5, 4, 3, 2, 1, 6]), 'Mon–Sat');
  assert.equal(describeWeekdays([1, 3, 5]), 'Mon, Wed, Fri');
  assert.equal(describeWeekdays([6]), 'Sat');
  assert.equal(describeWeekdays([0, 1, 2, 3, 4]), 'Mon, Tue, Wed, Thu, Sun');
  assert.equal(describeWeekdays([]), '—');
});

test('WhatsApp numbers display in a readable way', () => {
  assert.equal(formatWhatsapp('919849136605'), '+91 98491 36605');
  assert.equal(formatWhatsapp(null), '—');
  assert.equal(formatWhatsapp('14155550123'), '+14155550123');
});

test('shift status: the latest started shift per day is in use, newer ones are upcoming, older ones replaced', () => {
  const shift = (id: number, effectiveFrom: string, weekdays: number[]): Shift =>
    ({ id, campusId: 1, loginTime: '09:00', logoutTime: '16:00', graceMinutes: 10, weekdays, effectiveFrom });
  const shifts = [
    shift(1, '2026-01-01', [1, 2, 3, 4, 5]),   // replaced by 3 on weekdays
    shift(2, '2026-02-01', [6]),                // Saturday only: in use
    shift(3, '2026-03-01', [1, 2, 3, 4, 5]),   // in use
    shift(4, '2026-09-01', [1, 2, 3, 4, 5]),   // not started
  ];
  assert.deepEqual(shiftStatuses(shifts, '2026-03-10'), { 1: 'PAST', 2: 'CURRENT', 3: 'CURRENT', 4: 'UPCOMING' });
  assert.deepEqual(shiftStatuses([], '2026-03-10'), {});
  assert.match(todayIst(), /^\d{4}-\d{2}-\d{2}$/);
});

// ── Sample data ───────────────────────────────────────────────────────────────
const me = (over: Partial<Me> = {}): Me => ({ userId: 1, role: 'DIRECTOR', canEditDirectorSettings: true, whatsappMode: 'live', ...over });

const checklist: ChecklistItem[] = [
  { key: 'campus', label: 'Add your campuses', done: true, detail: '2 active campuses', tab: 'campuses' },
  { key: 'location', label: 'Set each campus location', done: false, detail: '1 of 2 have a latitude and longitude', tab: 'campuses' },
  { key: 'numbers', label: 'Register employee WhatsApp numbers', done: false, detail: '30 of 50 active employees are registered', tab: 'employees' },
  { key: 'enabled', label: 'Attendance switched on', done: false, detail: 'Set ATTENDANCE_ENABLED=true in Netlify', tab: 'system' },
];
const status = (items = checklist): SetupStatus => ({ items, ready: items.every(i => i.done) });

const campuses: Campus[] = [
  { id: 1, code: 'MAIN', name: 'Main Campus', address: null, latitude: 17.385044, longitude: 78.486671, geofenceRadiusM: 25, requiredAccuracyM: null, isActive: true, shiftCount: 1, employeeCount: 30 },
  { id: 2, code: 'NORTH', name: 'North Campus', address: null, latitude: null, longitude: null, geofenceRadiusM: 40, requiredAccuracyM: 8, isActive: false, shiftCount: 0, employeeCount: 0 },
];

const settingRows: SettingRow[] = [
  { key: 'director_whatsapp_e164', value: '919849136605', description: null, hint: 'digits', directorOnly: true },
  { key: 'alert_mode', value: 'digest', description: null, hint: null, directorOnly: true },
  { key: 'digest_interval_minutes', value: 45, description: null, hint: null, directorOnly: true },
  { key: 'default_grace_minutes', value: 10, description: null, hint: null, directorOnly: false },
  { key: 'default_geofence_radius_m', value: 25, description: null, hint: null, directorOnly: false },
  { key: 'template_digest', value: 'attendance_digest', description: null, hint: null, directorOnly: false },
];

const employees: EmployeeRow[] = [
  { id: 7, employeeCode: 'T001', employeeName: 'Asha Rao', designation: 'Teacher', branch: 'Main', status: 'ACTIVE', mobileNumber: '9849136605', joiningDate: '2024-06-10', whatsapp: '919849136605', attendanceApplicable: true, reportsDuringVacations: true, hasRegistration: true, primaryCampusId: 1, primaryCampusName: 'Main Campus', activeTemporary: 1 },
  { id: 8, employeeCode: 'T002', employeeName: 'Ravi Kumar', designation: null, branch: null, status: 'INACTIVE', mobileNumber: null, joiningDate: null, whatsapp: null, attendanceApplicable: false, reportsDuringVacations: false, hasRegistration: false, primaryCampusId: null, primaryCampusName: null, activeTemporary: 0 },
];

function render(node: React.ReactElement, preload: (client: QueryClient) => void = () => {}): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  preload(client);
  return renderToStaticMarkup(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

// ── Checklist ─────────────────────────────────────────────────────────────────
test('the checklist shows progress, what is missing, and a server panel for Netlify items', () => {
  const html = renderToStaticMarkup(<SetupChecklist items={checklist} onOpenTab={() => {}} />);
  assert.match(html, /Setup progress: 1 of 4 done/);
  assert.match(html, /Set each campus location/);
  assert.match(html, /1 of 2 have a latitude and longitude/);
  assert.match(html, /aria-valuenow="1"/);
  assert.match(html, /Server settings \(changed in Netlify, not on this page\)/);
  assert.match(html, /ATTENDANCE_ENABLED=true/);
  assert.equal((html.match(/<button/g) ?? []).length, 3);   // the three non-server items are clickable
});

test('a finished checklist says so and hides the server panel', () => {
  const done = checklist.map(i => ({ ...i, done: true }));
  const html = renderToStaticMarkup(<SetupChecklist items={done} onOpenTab={() => {}} />);
  assert.match(html, /Everything is set up/);
  assert.ok(!/Server settings/.test(html));
});

// ── Access messages ───────────────────────────────────────────────────────────
test('access messages explain what to do', () => {
  assert.match(renderToStaticMarkup(<AccessMessage error={new ApiError('x', 404)} />), /not switched on yet[\s\S]*ATTENDANCE_ENABLED=true/);
  assert.match(renderToStaticMarkup(<AccessMessage error={new ApiError('x', 403)} />), /do not have access/);
  assert.match(renderToStaticMarkup(<AccessMessage error={new ApiError('Boom happened', 500)} />), /Boom happened/);
  assert.match(renderToStaticMarkup(<AccessMessage error={new Error('Network down')} />), /Network down/);
});

// ── The page and its tabs ─────────────────────────────────────────────────────
test('the setup page shows the title, test-mode banner, checklist and tabs', () => {
  const html = render(<AttendanceSetupPage />, c => {
    c.setQueryData(keys.me, me({ whatsappMode: 'stub' }));
    c.setQueryData(keys.status, status());
    c.setQueryData(keys.campuses, campuses);
    c.setQueryData(keys.settings, settingRows);
  });
  assert.match(html, /Attendance Setup/);
  assert.match(html, /WhatsApp is in test mode/);
  assert.match(html, /Setup progress: 1 of 4 done/);
  for (const tab of ['Campuses', 'Shifts', 'Employees', 'Settings']) assert.match(html, new RegExp(`>${tab}<`));
  assert.match(html, /Main Campus/);
});

test('live mode shows no test-mode banner', () => {
  const html = render(<AttendanceSetupPage />, c => {
    c.setQueryData(keys.me, me({ whatsappMode: 'live' }));
    c.setQueryData(keys.status, status());
    c.setQueryData(keys.campuses, campuses);
    c.setQueryData(keys.settings, settingRows);
  });
  assert.ok(!/test mode/.test(html));
});

test('campuses tab lists each campus with location, distance, shifts and status', () => {
  const html = render(<CampusesTab />, c => { c.setQueryData(keys.campuses, campuses); c.setQueryData(keys.settings, settingRows); });
  assert.match(html, /Main Campus/);
  assert.match(html, /17\.38504, 78\.48667/);
  assert.match(html, /25 m/);
  assert.match(html, /North Campus/);
  assert.match(html, /Not set/);          // no location yet
  assert.match(html, /None/);              // no shift yet
  assert.match(html, /Inactive/);
  assert.match(html, /Add campus/);
});

test('campuses tab with no campuses invites the first one', () => {
  const html = render(<CampusesTab />, c => { c.setQueryData(keys.campuses, []); c.setQueryData(keys.settings, settingRows); });
  assert.match(html, /No campuses yet/);
});

test('employees tab shows number, campus and attendance status, and flags what is missing', () => {
  const html = render(<EmployeesTab />, c => {
    c.setQueryData(keys.employees('page=1&limit=50&status=ACTIVE'), { employees: employees, total: 2 });
    c.setQueryData(keys.campuses, campuses);
  });
  assert.match(html, /Asha Rao/);
  assert.match(html, /\+91 98491 36605/);
  assert.match(html, /\+1 temporary/);
  assert.match(html, /Ravi Kumar/);
  assert.match(html, /Not registered/);
  assert.match(html, /Not set/);
  assert.match(html, /Inactive/);
  assert.match(html, /Add employee/);
  assert.equal((html.match(/Set up/g) ?? []).length, 2);
  assert.match(html, /Vacations/, 'works-during-vacations badge');
  assert.equal((html.match(/>No joining date</g) ?? []).length, 1, 'only the employee without a date is flagged');
});

test('settings tab groups settings, offers the alert modes, and locks Director-only ones for others', () => {
  const asDirector = render(<SettingsTab />, c => { c.setQueryData(keys.settings, settingRows); c.setQueryData(keys.me, me()); });
  assert.match(asDirector, /Director alerts/);
  assert.match(asDirector, /Attendance rules/);
  assert.match(asDirector, /WhatsApp templates and links/);
  assert.match(asDirector, /Director&#x27;s WhatsApp number|Director's WhatsApp number/);
  assert.match(asDirector, /98491 36605/);              // number shown without the +91 prefix box
  assert.match(asDirector, /How the Director is alerted/);
  assert.match(asDirector, /Summary interval/);
  assert.ok(!/Only the Director can change this/.test(asDirector));

  const asAdmin = render(<SettingsTab />, c => { c.setQueryData(keys.settings, settingRows); c.setQueryData(keys.me, me({ role: 'ADMIN', canEditDirectorSettings: false })); });
  assert.match(asAdmin, /Only the Director can change this/);
  assert.match(asAdmin, /disabled/);
  // Settings that are not Director-only stay editable for an admin.
  assert.match(asAdmin, /Default grace period/);
});
