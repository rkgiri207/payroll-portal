import type { HolidayKind } from './calendar';

/**
 * Ready-made academic calendars that an admin can import with one click. Imported rows are
 * always DRAFT: nothing counts for leave until a Director confirms them.
 *
 * AP 2026-27 comes from the official "Academic Calendar for Primary Schools 2026-27" (School
 * Education Department, Andhra Pradesh), general schools only. The working-day figures printed
 * on that calendar are reproduced by these dates (229 days; see calendar tests).
 */

export interface TemplateHoliday { name: string; kind: HolidayKind; startDate: string; endDate: string }

export interface CalendarTemplate {
  key: string;
  label: string;           // academic year label, e.g. 2026-27
  title: string;           // what the admin sees on the button
  startDate: string;       // first day of the academic year
  endDate: string;         // last day of the academic year
  source: string;
  /** Working days printed on the official calendar, per month (for the confirm-step check). */
  printedWorkingDays: Record<string, number>;
  holidays: TemplateHoliday[];
}

const day = (name: string, kind: HolidayKind, date: string): TemplateHoliday => ({ name, kind, startDate: date, endDate: date });
const range = (name: string, kind: HolidayKind, startDate: string, endDate: string): TemplateHoliday => ({ name, kind, startDate, endDate });

export const AP_2026_27: CalendarTemplate = {
  key: 'ap-2026-27',
  label: '2026-27',
  title: 'Andhra Pradesh school calendar 2026-27 (primary, general schools)',
  startDate: '2026-06-12',
  endDate: '2027-04-23',
  source: 'AP School Education Academic Calendar 2026-27 (primary), general schools',
  printedWorkingDays: {
    '2026-06': 14, '2026-07': 26, '2026-08': 22, '2026-09': 23, '2026-10': 16, '2026-11': 24,
    '2026-12': 25, '2027-01': 18, '2027-02': 23, '2027-03': 22, '2027-04': 16,
  },
  holidays: [
    day('Moharram', 'HOLIDAY', '2026-06-26'),
    day('Independence Day', 'HOLIDAY', '2026-08-15'),
    day('Varalakshmi Vratam', 'HOLIDAY', '2026-08-21'),
    day('Milad-Un-Nabi', 'HOLIDAY', '2026-08-25'),
    day('Sri Krishnashtami', 'HOLIDAY', '2026-09-04'),
    day('Vinayaka Chaviti', 'HOLIDAY', '2026-09-14'),
    day('Gandhi Jayanthi', 'HOLIDAY', '2026-10-02'),
    day('Deepavali', 'HOLIDAY', '2026-11-08'),
    day('Christmas', 'HOLIDAY', '2026-12-25'),
    day('Republic Day', 'HOLIDAY', '2027-01-26'),
    day('Maha Shivaratri', 'HOLIDAY', '2027-03-06'),
    day('Ramadan (Eid-Ul-Fitr)', 'HOLIDAY', '2027-03-10'),
    day('Holi', 'HOLIDAY', '2027-03-22'),
    day('Good Friday', 'HOLIDAY', '2027-03-26'),
    day('Babu Jagjivan Ram Jayanthi', 'HOLIDAY', '2027-04-05'),
    day('Ugadi', 'HOLIDAY', '2027-04-07'),
    day('Dr. B.R. Ambedkar Jayanthi', 'HOLIDAY', '2027-04-14'),
    day('Sri Rama Navami', 'HOLIDAY', '2027-04-15'),
    range('Dasara Holidays', 'VACATION', '2026-10-12', '2026-10-21'),
    range('Sankranthi Holidays', 'VACATION', '2027-01-11', '2027-01-17'),
    ...['2026-06-13', '2026-07-11', '2026-08-08', '2026-09-12', '2026-10-10', '2026-11-14', '2026-12-12',
      '2027-01-09', '2027-02-13', '2027-03-13'].map(d => day('Second Saturday', 'WEEKLY_OFF', d)),
    day('9th Moharram', 'OPTIONAL', '2026-06-25'),
    day('Ratha Yatra', 'OPTIONAL', '2026-07-16'),
    day('Arbayeen', 'OPTIONAL', '2026-08-04'),
    day("Parsi New Year's Day", 'OPTIONAL', '2026-08-15'),
    day('Yaz Dahum Shareef', 'OPTIONAL', '2026-09-22'),
    day('Hazrath Syed Mohammed', 'OPTIONAL', '2026-10-27'),
    day('Gurunanak Jayanthi', 'OPTIONAL', '2026-11-24'),
    day('Christmas Eve', 'OPTIONAL', '2026-12-24'),
    day('Boxing Day', 'OPTIONAL', '2026-12-26'),
    day('New Year', 'OPTIONAL', '2027-01-01'),
    day('Shab-E-Barath', 'OPTIONAL', '2027-01-25'),
    day('Shahadat of Hazrath', 'OPTIONAL', '2027-02-28'),
    day('Jamat-Ul-Vida', 'OPTIONAL', '2027-03-01'),
    day('Shab-E-Qadar', 'OPTIONAL', '2027-03-03'),
    day('Mahavir Jayanthi', 'OPTIONAL', '2027-04-19'),
  ],
};

export const CALENDAR_TEMPLATES: CalendarTemplate[] = [AP_2026_27];

export function findTemplate(key: unknown): CalendarTemplate | null {
  return CALENDAR_TEMPLATES.find(t => t.key === key) ?? null;
}
