/**
 * Calls the attendance admin API (/api/attendance/admin/*) and the existing employee API.
 * The portal's global fetch handling already redirects to the login page on a 401, so these
 * helpers only need to turn error replies into readable messages.
 */

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(url: string, method: string, body?: unknown): Promise<T> {
  const response = await fetch(url, {
    method,
    credentials: 'include',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await response.json().catch(() => null)) as { error?: unknown } | null;
  if (!response.ok) {
    const message = typeof data?.error === 'string' ? data.error : 'Something went wrong. Please try again.';
    throw new ApiError(message, response.status);
  }
  return data as T;
}

const admin = (path: string) => `/api/attendance/admin${path}`;
export const adminGet = <T,>(path: string) => request<T>(admin(path), 'GET');
export const adminPost = <T,>(path: string, body: unknown) => request<T>(admin(path), 'POST', body);
export const adminPut = <T,>(path: string, body: unknown) => request<T>(admin(path), 'PUT', body);
export const adminPatch = <T,>(path: string, body: unknown) => request<T>(admin(path), 'PATCH', body);
export const adminDelete = <T,>(path: string) => request<T>(admin(path), 'DELETE');

// ── Types (mirror the server's replies) ───────────────────────────────────────
export interface Me {
  userId: number;
  role: 'DIRECTOR' | 'ADMIN';
  canEditDirectorSettings: boolean;
  whatsappMode: 'stub' | 'live';
}

export type SetupTab = 'campuses' | 'shifts' | 'employees' | 'settings' | 'system';

export interface ChecklistItem { key: string; label: string; done: boolean; detail: string; tab: SetupTab }
export interface SetupStatus { items: ChecklistItem[]; ready: boolean }

export interface Campus {
  id: number; code: string; name: string; address: string | null;
  latitude: number | null; longitude: number | null; geofenceRadiusM: number;
  requiredAccuracyM: number | null; isActive: boolean; shiftCount: number; employeeCount: number;
}

export interface Shift {
  id: number; campusId: number; loginTime: string; logoutTime: string; graceMinutes: number;
  weekdays: number[]; effectiveFrom: string;
}

export interface SettingRow {
  key: string; value: unknown; description: string | null; hint: string | null; directorOnly: boolean;
}

export interface EmployeeRow {
  id: number; employeeCode: string; employeeName: string; designation: string | null; branch: string | null;
  status: string; mobileNumber: string | null; joiningDate: string | null; whatsapp: string | null; attendanceApplicable: boolean;
  reportsDuringVacations: boolean; hasRegistration: boolean; primaryCampusId: number | null; primaryCampusName: string | null; activeTemporary: number;
}

export interface Assignment {
  id: number; employeeId: number; campusId: number; campusName: string; kind: 'PRIMARY' | 'TEMPORARY';
  mode: 'REPLACE' | 'ADDITIONAL'; startDate: string; endDate: string | null; note: string | null;
}

// ── Dashboard ─────────────────────────────────────────────────────────────────
export interface DaySummary {
  expected: number; present: number; late: number; unmarked: number; onLeave: number; openExceptions: number; pendingReview: number;
}
export interface CampusSummary { campusId: number; campusName: string; expected: number; present: number; late: number; unmarked: number; onLeave: number }

export interface OnLeaveItem {
  employeeId: number; employeeCode: string; employeeName: string; campusName: string; leaveType: string;
  halfDay: boolean; dayMode: 'FULL' | 'FIRST_HALF' | 'SECOND_HALF'; startDate: string; endDate: string; totalDays: number;
}
export interface PermissionToday { employeeId: number; employeeCode: string; employeeName: string; campusName: string; startTime: string; endTime: string; reason: string }
export interface UpcomingDay { date: string; employees: number }
export interface DayNotice { kind: 'HOLIDAY' | 'WEEKLY_OFF' | 'VACATION' | 'SPECIAL_WORKING_DAY' | 'OPTIONAL'; name: string }
export interface LeaveDashboard {
  onLeave: OnLeaveItem[]; permissionsToday: PermissionToday[]; pendingLeave: number; pendingPermission: number;
  upcoming: UpcomingDay[]; notice: DayNotice | null;
}

export interface FeedEvent {
  id: string; eventType: 'IN' | 'OUT'; serverTs: string; punctuality: string; lateMinutes: number | null;
  reviewStatus: string; gpsResult: string | null; gpsDistanceM: number | null; hasSelfie: boolean; source: string;
  employeeId: number; employeeCode: string; employeeName: string; campusName: string;
  directorAlert: string | null;
}

export interface AlertProblem {
  id: string; kind: string; status: string; recipientType: 'DIRECTOR' | 'EMPLOYEE'; employeeName: string | null;
  lastError: string | null; attempts: number; createdAt: string;
}

export interface Dashboard {
  workDate: string; serverTime: string; summary: DaySummary; campuses: CampusSummary[];
  feed: FeedEvent[]; alertProblems: AlertProblem[]; warnings: string[]; alertMode: string;
  leave: LeaveDashboard;
}

export interface UnmarkedEmployee { employeeId: number; employeeCode: string; employeeName: string; campusName: string }

export interface ExceptionRow {
  id: string; employeeId: number; employeeCode: string; employeeName: string; campusId: number | null;
  campusName: string | null; workDate: string; kind: string; detail: string | null;
  status: 'OPEN' | 'REVIEWED' | 'RESOLVED'; createdAt: string;
}

export interface EmployeeProfile {
  employee: { id: number; employeeCode: string; employeeName: string; designation: string | null; branch: string | null; status: string };
  registration: { whatsapp: string | null; attendanceApplicable: boolean; reportsDuringVacations?: boolean } | null;
  assignments: Assignment[];
  recentEvents: FeedEvent[];
}

// ── The portal's existing employee API (unchanged) ───────────────────────────
export interface EmployeeInput {
  employeeCode?: string;
  employeeName?: string;
  mobileNumber?: string | null;
  designation?: string | null;
  branch?: string | null;
  joiningDate?: string | null;
  status?: 'ACTIVE' | 'INACTIVE';
}
export interface CreatedEmployee { id: number; employeeCode: string; employeeName: string }

export const createEmployee = (body: EmployeeInput) => request<CreatedEmployee>('/api/employees', 'POST', body);
export const updateEmployee = (id: number, body: EmployeeInput) => request<CreatedEmployee>(`/api/employees/${id}`, 'PATCH', body);

// ── Small helpers ─────────────────────────────────────────────────────────────
/** Today's date in India, as YYYY-MM-DD. */
export function todayIst(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

export const WEEKDAYS = [
  { value: 1, short: 'Mon', long: 'Monday' },
  { value: 2, short: 'Tue', long: 'Tuesday' },
  { value: 3, short: 'Wed', long: 'Wednesday' },
  { value: 4, short: 'Thu', long: 'Thursday' },
  { value: 5, short: 'Fri', long: 'Friday' },
  { value: 6, short: 'Sat', long: 'Saturday' },
  { value: 0, short: 'Sun', long: 'Sunday' },
] as const;

/** [1,2,3,4,5] -> "Mon–Fri"; otherwise the day names. */
export function describeWeekdays(days: number[]): string {
  const set = new Set(days);
  const order = WEEKDAYS.filter(d => set.has(d.value));
  const monToSat = [1, 2, 3, 4, 5, 6];
  const run = monToSat.filter(d => set.has(d));
  if (order.length >= 3 && run.length === order.length && run.every((d, i) => i === 0 || d === run[i - 1] + 1)) {
    return `${WEEKDAYS.find(d => d.value === run[0])!.short}–${WEEKDAYS.find(d => d.value === run[run.length - 1])!.short}`;
  }
  return order.map(d => d.short).join(', ') || '—';
}

/** "919849136605" -> "+91 98491 36605" (display only). */
export function formatWhatsapp(number: string | null): string {
  if (!number) return '—';
  const m = /^91(\d{5})(\d{5})$/.exec(number);
  return m ? `+91 ${m[1]} ${m[2]}` : `+${number}`;
}

/** Which shifts are in force today (the latest started shift per weekday) and which are upcoming. */
export function shiftStatuses(shifts: Shift[], today: string): Record<number, 'CURRENT' | 'UPCOMING' | 'PAST'> {
  const result: Record<number, 'CURRENT' | 'UPCOMING' | 'PAST'> = {};
  const latestByDay = new Map<number, Shift>();
  for (const shift of shifts) {
    if (shift.effectiveFrom > today) { result[shift.id] = 'UPCOMING'; continue; }
    for (const day of shift.weekdays) {
      const best = latestByDay.get(day);
      if (!best || shift.effectiveFrom > best.effectiveFrom || (shift.effectiveFrom === best.effectiveFrom && shift.id > best.id)) {
        latestByDay.set(day, shift);
      }
    }
  }
  const current = new Set([...latestByDay.values()].map(s => s.id));
  for (const shift of shifts) {
    if (result[shift.id]) continue;
    result[shift.id] = current.has(shift.id) ? 'CURRENT' : 'PAST';
  }
  return result;
}
