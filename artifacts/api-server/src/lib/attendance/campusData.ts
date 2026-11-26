import type { Queryable } from './db';
import type { ShiftRow } from './shift';

// NOTE on types: the pg driver returns `date` as a JS Date and `numeric` as a string, so
// every query below casts dates to text and numerics to float8 to get plain values.

export interface RegisteredEmployee {
  employeeId: number;
  employeeCode: string;
  employeeName: string;
}

/**
 * Find the employee for an inbound WhatsApp number. Only ACTIVE employees with attendance
 * switched on can be found; anyone else is treated as "not registered" (no reply at all).
 */
export async function findEmployeeByWhatsApp(
  q: Queryable,
  e164: string,
): Promise<RegisteredEmployee | null> {
  const { rows } = await q.query<{ id: number; employee_code: string; employee_name: string }>(
    `select e.id, e.employee_code, e.employee_name
       from attendance_employees ae
       join employees e on e.id = ae.employee_id
      where ae.whatsapp_e164 = $1
        and ae.attendance_applicable
        and e.status = 'ACTIVE'`,
    [e164],
  );
  const row = rows[0];
  return row
    ? { employeeId: row.id, employeeCode: row.employee_code, employeeName: row.employee_name }
    : null;
}

export interface EmployeeContact {
  employeeId: number;
  employeeCode: string;
  employeeName: string;
  whatsapp: string | null;
}

export async function getEmployeeContact(q: Queryable, employeeId: number): Promise<EmployeeContact | null> {
  const { rows } = await q.query<{
    id: number; employee_code: string; employee_name: string; whatsapp_e164: string | null;
  }>(
    `select e.id, e.employee_code, e.employee_name, ae.whatsapp_e164
       from employees e left join attendance_employees ae on ae.employee_id = e.id
      where e.id = $1`,
    [employeeId],
  );
  const r = rows[0];
  return r
    ? { employeeId: r.id, employeeCode: r.employee_code, employeeName: r.employee_name, whatsapp: r.whatsapp_e164 }
    : null;
}

export interface CampusOption {
  campusId: number;
  campusCode: string;
  campusName: string;
  kind: 'PRIMARY' | 'TEMPORARY';
  mode: 'REPLACE' | 'ADDITIONAL';
}

/**
 * Which campuses may this employee mark at? Rules:
 *  - a TEMPORARY assignment in REPLACE mode replaces the primary campus for its dates;
 *  - a TEMPORARY assignment in ADDITIONAL mode is offered alongside the primary campus.
 * Duplicates are removed, keeping a stable order.
 */
export function resolveAllowedCampuses(active: CampusOption[]): CampusOption[] {
  const primary = active.filter(a => a.kind === 'PRIMARY');
  const replace = active.filter(a => a.kind === 'TEMPORARY' && a.mode === 'REPLACE');
  const additional = active.filter(a => a.kind === 'TEMPORARY' && a.mode === 'ADDITIONAL');
  const chosen = replace.length > 0 ? [...replace, ...additional] : [...primary, ...additional];
  const seen = new Set<number>();
  return chosen.filter(option => (seen.has(option.campusId) ? false : (seen.add(option.campusId), true)));
}

export async function listAllowedCampuses(
  q: Queryable,
  employeeId: number,
  workDate: string,
): Promise<CampusOption[]> {
  const { rows } = await q.query<{
    campus_id: number; code: string; name: string; kind: 'PRIMARY' | 'TEMPORARY'; mode: 'REPLACE' | 'ADDITIONAL';
  }>(
    `select a.campus_id, c.code, c.name, a.kind, a.mode
       from employee_campus_assignments a
       join campuses c on c.id = a.campus_id
      where a.employee_id = $1
        and a.start_date <= $2::date
        and (a.end_date is null or a.end_date >= $2::date)
        and c.is_active
      order by a.kind, c.name, a.id`,
    [employeeId, workDate],
  );
  return resolveAllowedCampuses(
    rows.map(r => ({ campusId: r.campus_id, campusCode: r.code, campusName: r.name, kind: r.kind, mode: r.mode })),
  );
}

export interface CampusRecord {
  id: number;
  code: string;
  name: string;
  latitude: number | null;
  longitude: number | null;
  radiusM: number;
  requiredAccuracyM: number | null;
  isActive: boolean;
}

export async function getCampus(q: Queryable, campusId: number): Promise<CampusRecord | null> {
  const { rows } = await q.query<{
    id: number; code: string; name: string; latitude: number | null; longitude: number | null;
    geofence_radius_m: number; required_accuracy_m: number | null; is_active: boolean;
  }>(
    `select id, code, name, latitude::float8 as latitude, longitude::float8 as longitude,
            geofence_radius_m, required_accuracy_m, is_active
       from campuses where id = $1`,
    [campusId],
  );
  const r = rows[0];
  return r
    ? {
        id: r.id, code: r.code, name: r.name, latitude: r.latitude, longitude: r.longitude,
        radiusM: r.geofence_radius_m, requiredAccuracyM: r.required_accuracy_m, isActive: r.is_active,
      }
    : null;
}

export async function getShifts(q: Queryable, campusId: number): Promise<ShiftRow[]> {
  const { rows } = await q.query<{
    id: number; login_time: string; logout_time: string; grace_minutes: number;
    weekdays: number[]; effective_from: string;
  }>(
    `select id, login_time::text as login_time, logout_time::text as logout_time, grace_minutes,
            weekdays, effective_from::text as effective_from
       from campus_shifts where campus_id = $1`,
    [campusId],
  );
  return rows.map(r => ({
    id: r.id,
    loginTime: r.login_time,
    logoutTime: r.logout_time,
    graceMinutes: r.grace_minutes,
    weekdays: r.weekdays.map(Number),
    effectiveFrom: r.effective_from,
  }));
}
