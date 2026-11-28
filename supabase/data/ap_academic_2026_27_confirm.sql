-- Confirms the AP 2026-27 draft holidays so they start to count for leave.
-- Run ONLY after you have reviewed the dates from ap_academic_2026_27_holidays.sql against the
-- official calendar. Run on the TEST project only (kcpaqvuburgehzrdtygk).
-- Idempotent: only DRAFT rows change. Changing a date later is done in the app.

begin;

update holidays h
   set status = 'CONFIRMED', confirmed_at = now()
  from academic_years y
 where y.id = h.academic_year_id
   and y.label = '2026-27'
   and h.status = 'DRAFT';

commit;

-- CHECK: working days per month must equal the calendar's printed figures
-- (Mon to Sat working; Sundays, confirmed holidays, vacations and second Saturdays off):
--   Jun 14, Jul 26, Aug 22, Sep 23, Oct 16, Nov 24, Dec 25, Jan 18, Feb 23, Mar 22, Apr 16 = 229
--
--   with days as (
--     select d::date as day
--       from academic_years y, generate_series(y.start_date, y.end_date, interval '1 day') d
--      where y.label = '2026-27'
--   ), off as (
--     select distinct g::date as day
--       from holidays h join academic_years y on y.id = h.academic_year_id,
--            generate_series(h.start_date, h.end_date, interval '1 day') g
--      where y.label = '2026-27' and h.status = 'CONFIRMED' and h.kind in ('HOLIDAY','VACATION','WEEKLY_OFF')
--   )
--   select to_char(day, 'YYYY-MM') as month, count(*) as working_days
--     from days
--    where extract(dow from day) <> 0 and day not in (select day from off)
--    group by 1 order by 1;
