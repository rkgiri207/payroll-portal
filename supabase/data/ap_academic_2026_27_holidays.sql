-- AP academic calendar 2026-27: loads the academic year and its holidays as DRAFTS.
-- Source: "Academic Calendar for Primary Schools 2026-27", Department of School Education,
-- Government of Andhra Pradesh (SCERT AP). General schools only.
-- Requires migration 06. Run on the TEST project only (kcpaqvuburgehzrdtygk).
--
-- Everything is inserted with status DRAFT. DRAFT holidays do NOT affect leave counting.
-- Review them (query at the bottom), then run ap_academic_2026_27_confirm.sql to confirm.
-- Idempotent: safe to run twice (existing rows are left as they are).
--
-- Not loaded on purpose:
--   * Christian-minority-institution dates (not used by your schools).
--   * Optional holiday 3 June 2026 (Eid-E-Gadeer): it falls before school reopens on 12 June.
--   * 10 April 2027, the second Saturday of April: the calendar treats it as a working day.
--   * Sundays: weekly offs come from the campus shifts.

begin;

insert into academic_years (label, start_date, end_date)
values ('2026-27', date '2026-06-12', date '2027-04-23')
on conflict (label) do nothing;

insert into holidays (academic_year_id, name, kind, start_date, end_date, source)
select y.id, v.name, v.kind, v.start_date::date, v.end_date::date,
       'AP School Education Academic Calendar 2026-27 (primary), general schools'
  from academic_years y
  cross join (values
    -- Closures for all staff
    ('Moharram',                    'HOLIDAY',    '2026-06-26', '2026-06-26'),
    ('Independence Day',            'HOLIDAY',    '2026-08-15', '2026-08-15'),
    ('Varalakshmi Vratam',          'HOLIDAY',    '2026-08-21', '2026-08-21'),
    ('Milad-Un-Nabi',               'HOLIDAY',    '2026-08-25', '2026-08-25'),
    ('Sri Krishnashtami',           'HOLIDAY',    '2026-09-04', '2026-09-04'),
    ('Vinayaka Chaviti',            'HOLIDAY',    '2026-09-14', '2026-09-14'),
    ('Gandhi Jayanthi',             'HOLIDAY',    '2026-10-02', '2026-10-02'),
    ('Deepavali',                   'HOLIDAY',    '2026-11-08', '2026-11-08'),
    ('Christmas',                   'HOLIDAY',    '2026-12-25', '2026-12-25'),
    ('Republic Day',                'HOLIDAY',    '2027-01-26', '2027-01-26'),
    ('Maha Shivaratri',             'HOLIDAY',    '2027-03-06', '2027-03-06'),
    ('Ramadan (Eid-Ul-Fitr)',       'HOLIDAY',    '2027-03-10', '2027-03-10'),
    ('Holi',                        'HOLIDAY',    '2027-03-22', '2027-03-22'),
    ('Good Friday',                 'HOLIDAY',    '2027-03-26', '2027-03-26'),
    ('Babu Jagjivan Ram Jayanthi',  'HOLIDAY',    '2027-04-05', '2027-04-05'),
    ('Ugadi',                       'HOLIDAY',    '2027-04-07', '2027-04-07'),
    ('Dr. B.R. Ambedkar Jayanthi',  'HOLIDAY',    '2027-04-14', '2027-04-14'),
    ('Sri Rama Navami',             'HOLIDAY',    '2027-04-15', '2027-04-15'),
    -- School vacations (staff flagged "reports during vacations" still work)
    ('Dasara Holidays',             'VACATION',   '2026-10-12', '2026-10-21'),
    ('Sankranthi Holidays',         'VACATION',   '2027-01-11', '2027-01-17'),
    -- Second Saturdays listed on the calendar (April 2027 has none)
    ('Second Saturday',             'WEEKLY_OFF', '2026-06-13', '2026-06-13'),
    ('Second Saturday',             'WEEKLY_OFF', '2026-07-11', '2026-07-11'),
    ('Second Saturday',             'WEEKLY_OFF', '2026-08-08', '2026-08-08'),
    ('Second Saturday',             'WEEKLY_OFF', '2026-09-12', '2026-09-12'),
    ('Second Saturday',             'WEEKLY_OFF', '2026-10-10', '2026-10-10'),
    ('Second Saturday',             'WEEKLY_OFF', '2026-11-14', '2026-11-14'),
    ('Second Saturday',             'WEEKLY_OFF', '2026-12-12', '2026-12-12'),
    ('Second Saturday',             'WEEKLY_OFF', '2027-01-09', '2027-01-09'),
    ('Second Saturday',             'WEEKLY_OFF', '2027-02-13', '2027-02-13'),
    ('Second Saturday',             'WEEKLY_OFF', '2027-03-13', '2027-03-13'),
    -- Optional holidays: informational, never a closure ("availed at school level")
    ('9th Moharram',                'OPTIONAL',   '2026-06-25', '2026-06-25'),
    ('Ratha Yatra',                 'OPTIONAL',   '2026-07-16', '2026-07-16'),
    ('Arbayeen',                    'OPTIONAL',   '2026-08-04', '2026-08-04'),
    ('Parsi New Year''s Day',       'OPTIONAL',   '2026-08-15', '2026-08-15'),
    ('Yaz Dahum Shareef',           'OPTIONAL',   '2026-09-22', '2026-09-22'),
    ('Hazrath Syed Mohammed',       'OPTIONAL',   '2026-10-27', '2026-10-27'),
    ('Gurunanak Jayanthi',          'OPTIONAL',   '2026-11-24', '2026-11-24'),
    ('Christmas Eve',               'OPTIONAL',   '2026-12-24', '2026-12-24'),
    ('Boxing Day',                  'OPTIONAL',   '2026-12-26', '2026-12-26'),
    ('New Year',                    'OPTIONAL',   '2027-01-01', '2027-01-01'),
    ('Shab-E-Barath',               'OPTIONAL',   '2027-01-25', '2027-01-25'),
    ('Shahadat of Hazrath',         'OPTIONAL',   '2027-02-28', '2027-02-28'),
    ('Jamat-Ul-Vida',               'OPTIONAL',   '2027-03-01', '2027-03-01'),
    ('Shab-E-Qadar',                'OPTIONAL',   '2027-03-03', '2027-03-03'),
    ('Mahavir Jayanthi',            'OPTIONAL',   '2027-04-19', '2027-04-19')
  ) as v(name, kind, start_date, end_date)
 where y.label = '2026-27'
on conflict do nothing;

commit;

-- REVIEW (run after loading). Expect: HOLIDAY 18, OPTIONAL 15, VACATION 2, WEEKLY_OFF 10 (45 rows, all DRAFT).
--   select kind, count(*) as rows, min(status) as status
--     from holidays h join academic_years y on y.id = h.academic_year_id
--    where y.label = '2026-27' group by kind order by kind;
--
-- And to read every date next to its weekday:
--   select to_char(start_date, 'DD Mon YYYY') as from_date,
--          case when end_date <> start_date then to_char(end_date, 'DD Mon YYYY') end as to_date,
--          to_char(start_date, 'Dy') as weekday, kind, name
--     from holidays h join academic_years y on y.id = h.academic_year_id
--    where y.label = '2026-27' order by start_date, name;
