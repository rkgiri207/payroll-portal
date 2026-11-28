/**
 * "Who is expected to check in today": ONE definition, used by every dashboard number and list, so
 * the cards, the campus table, the Unmarked list and the Director's summary can never disagree.
 *
 * Query shape it expects: employee_campus_assignments a, attendance_employees ae, employees e.
 * Parameters: $1 = the date (YYYY-MM-DD), $2 = the weekday (0 = Sunday ... 6 = Saturday).
 *
 * An employee is expected when they are active and attendance applies to them, have a campus
 * assignment covering the date, AND the day is a working day at that campus:
 *   - a shift runs on that weekday, and
 *   - the day is not closed by a CONFIRMED holiday, weekly off, or school vacation
 *     (staff flagged "reports during vacations" are still expected in a vacation), and
 *   - the day is not a SPECIAL WORKING DAY exception to the above: a confirmed special working day
 *     means the campus works, whatever the weekday or closures.
 * An employee on APPROVED leave for the whole day is not expected: they are "on leave", never
 * "unmarked". (A half-day leave still counts as expected: they work the other half.)
 * Draft holidays and pending leave change nothing; only decisions that have been made count.
 */

const SPECIAL_WORKING_DAY = `exists (
    select 1 from holidays h
     where h.status = 'CONFIRMED' and h.kind = 'SPECIAL_WORKING_DAY'
       and $1::date between h.start_date and h.end_date and (h.campus_id is null or h.campus_id = a.campus_id))`;

const CLOSED_BY_CALENDAR = `exists (
    select 1 from holidays h
     where h.status = 'CONFIRMED' and $1::date between h.start_date and h.end_date
       and (h.campus_id is null or h.campus_id = a.campus_id)
       and (h.kind in ('HOLIDAY', 'WEEKLY_OFF') or (h.kind = 'VACATION' and not ae.reports_during_vacations)))`;

/** The employee has approved leave for the whole of the date. */
export const ON_FULL_LEAVE = `exists (
    select 1 from leave_request_days d join leave_requests r on r.id = d.request_id
     where d.employee_id = a.employee_id and d.leave_date = $1::date and d.fraction = 1 and r.status = 'APPROVED')`;

/** Active, applicable, assigned, and the day is a working day at their campus. Leave is not considered here. */
export const EXPECTED_BASE = `
  ae.attendance_applicable and e.status = 'ACTIVE'
  and a.start_date <= $1::date and (a.end_date is null or a.end_date >= $1::date)
  and (${SPECIAL_WORKING_DAY}
       or (exists (select 1 from campus_shifts s
                    where s.campus_id = a.campus_id and s.effective_from <= $1::date and $2::smallint = any(s.weekdays))
           and not ${CLOSED_BY_CALENDAR}))`;

/** Expected to check in: a working day, and not on approved full-day leave. */
export const EXPECTED_FILTER = `${EXPECTED_BASE}
  and not ${ON_FULL_LEAVE}`;
