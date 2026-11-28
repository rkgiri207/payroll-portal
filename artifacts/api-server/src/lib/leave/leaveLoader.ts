import type { Queryable } from '../attendance/db';
import { getShifts } from '../attendance/campusData';
import type { ShiftRow } from '../attendance/shift';
import type { HolidayRow } from './calendar';
import { DEFAULT_RULES, type AssignmentRow, type EvalContext, type LeavePolicyRules } from './leaveEvaluate';
import { getLeaveType, type LeaveTypeView } from './policyStore';

export interface EmployeeFacts { id: number; name: string; code: string; active: boolean; reportsDuringVacations: boolean }

export interface LoadedFacts {
  employee: EmployeeFacts;
  type: LeaveTypeView;
  yearId: number | null;
  context: EvalContext;
}

export async function loadEmployeeFacts(q: Queryable, employeeId: number): Promise<EmployeeFacts | null> {
  const { rows } = await q.query<{ id: number; employee_name: string; employee_code: string; status: string; reports: boolean | null }>(
    `select e.id, e.employee_name, e.employee_code, e.status, ae.reports_during_vacations as reports
       from employees e left join attendance_employees ae on ae.employee_id = e.id where e.id = $1`,
    [employeeId],
  );
  const r = rows[0];
  return r ? { id: r.id, name: r.employee_name, code: r.employee_code, active: r.status === 'ACTIVE', reportsDuringVacations: r.reports === true } : null;
}

/**
 * Gather everything the leave rules need for one employee, leave type and date range, using the
 * organisation's own academic year that contains the first day.
 */
export async function loadLeaveFacts(
  q: Queryable, employeeId: number, leaveTypeId: number, startDate: string, endDate: string,
): Promise<LoadedFacts | { error: 'EMPLOYEE_NOT_FOUND' | 'TYPE_NOT_FOUND' }> {
  const [employee, type] = await Promise.all([loadEmployeeFacts(q, employeeId), getLeaveType(q, leaveTypeId)]);
  if (!employee) return { error: 'EMPLOYEE_NOT_FOUND' };
  if (!type) return { error: 'TYPE_NOT_FOUND' };

  const yearRows = await q.query<{ id: number; label: string; start_date: string; end_date: string }>(
    `select id, label, to_char(start_date, 'YYYY-MM-DD') as start_date, to_char(end_date, 'YYYY-MM-DD') as end_date
       from academic_years where $1::date between start_date and end_date`,
    [startDate],
  );
  const year = yearRows.rows[0] ?? null;

  const assignmentRows = await q.query<{ campus_id: number; kind: 'PRIMARY' | 'TEMPORARY'; mode: 'REPLACE' | 'ADDITIONAL'; start_date: string; end_date: string | null }>(
    `select campus_id, kind, mode, to_char(start_date, 'YYYY-MM-DD') as start_date, to_char(end_date, 'YYYY-MM-DD') as end_date
       from employee_campus_assignments
      where employee_id = $1 and start_date <= $3::date and (end_date is null or end_date >= $2::date)`,
    [employeeId, startDate, endDate],
  );
  const assignments: AssignmentRow[] = assignmentRows.rows.map(a => ({
    campusId: a.campus_id, kind: a.kind, mode: a.mode, startDate: a.start_date, endDate: a.end_date,
  }));

  const shiftsByCampus: Record<number, ShiftRow[]> = {};
  for (const campusId of new Set(assignments.map(a => a.campusId))) shiftsByCampus[campusId] = await getShifts(q, campusId);

  let holidays: HolidayRow[] = [];
  let rules: LeavePolicyRules = DEFAULT_RULES;
  let availableBalance = 0;
  if (year) {
    const h = await q.query<{ kind: HolidayRow['kind']; status: HolidayRow['status']; start_date: string; end_date: string; campus_id: number | null }>(
      `select kind, status, to_char(start_date, 'YYYY-MM-DD') as start_date, to_char(end_date, 'YYYY-MM-DD') as end_date, campus_id
         from holidays where academic_year_id = $1 and status = 'CONFIRMED'`,
      [year.id],
    );
    holidays = h.rows.map(r => ({ kind: r.kind, status: r.status, startDate: r.start_date, endDate: r.end_date, campusId: r.campus_id }));

    const p = await q.query<{ allow_half_day: boolean; min_notice_days: number; max_consecutive_days: number | null; insufficient_balance: LeavePolicyRules['insufficientBalance'] }>(
      `select allow_half_day, min_notice_days, max_consecutive_days, insufficient_balance
         from leave_policies where leave_type_id = $1 and academic_year_id = $2`,
      [leaveTypeId, year.id],
    );
    if (p.rows[0]) {
      rules = {
        allowHalfDay: p.rows[0].allow_half_day, minNoticeDays: p.rows[0].min_notice_days,
        maxConsecutiveDays: p.rows[0].max_consecutive_days, insufficientBalance: p.rows[0].insufficient_balance,
      };
    }

    // Balance for THIS academic year only, less the paid days already promised to pending requests.
    const b = await q.query<{ available: number }>(
      `select (coalesce((select balance from leave_balances where employee_id = $1 and leave_type_id = $2 and academic_year_id = $3), 0)
             - coalesce((select sum(paid_days) from leave_requests
                          where employee_id = $1 and leave_type_id = $2 and academic_year_id = $3 and status = 'PENDING'), 0))::float8 as available`,
      [employeeId, leaveTypeId, year.id],
    );
    availableBalance = b.rows[0]?.available ?? 0;
  }

  const taken = await q.query<{ leave_date: string }>(
    `select to_char(leave_date, 'YYYY-MM-DD') as leave_date from leave_request_days
      where employee_id = $1 and counts_toward_cap and leave_date between $2::date and $3::date`,
    [employeeId, startDate, endDate],
  );

  return {
    employee, type, yearId: year?.id ?? null,
    context: {
      type: { name: type.name, tracksBalance: type.tracksBalance, isActive: type.isActive },
      year: year ? { label: year.label, startDate: year.start_date, endDate: year.end_date } : null,
      rules, assignments, shiftsByCampus, holidays, reportsDuringVacations: employee.reportsDuringVacations,
      availableBalance, existingLeaveDates: taken.rows.map(r => r.leave_date),
    },
  };
}
