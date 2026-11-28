import { useQuery } from '@tanstack/react-query';
import { adminGet } from './api';

export type HolidayKind = 'HOLIDAY' | 'VACATION' | 'WEEKLY_OFF' | 'OPTIONAL' | 'SPECIAL_WORKING_DAY';

export interface AcademicYear {
  id: number; label: string; startDate: string; endDate: string; draftCount: number; confirmedCount: number;
  /** The first day of the month leave starts being credited from; null means the year's first day. */
  accrualFrom: string | null;
}
export interface Holiday {
  id: number; academicYearId: number; campusId: number | null; name: string; kind: HolidayKind;
  startDate: string; endDate: string; status: 'DRAFT' | 'CONFIRMED'; source: string | null;
}
export interface MonthRow { month: string; workingDays: number; printed: number | null; matches: boolean | null }
export interface YearDetail { year: AcademicYear; holidays: Holiday[]; months: MonthRow[]; officialDatesDiffer: boolean }
export interface SkippedHoliday { name: string; kind: HolidayKind; startDate: string; endDate: string }
export interface ImportResult {
  yearId: number; yearCreated: boolean; holidaysAdded: number; yearStartDate: string; yearEndDate: string; skipped: SkippedHoliday[];
}
export interface CalendarTemplate {
  key: string; title: string; label: string; startDate: string; endDate: string; holidayCount: number;
}

export const leaveKeys = {
  years: ['leave', 'calendar', 'years'] as const,
  year: (id: number) => ['leave', 'calendar', 'year', id] as const,
  templates: ['leave', 'calendar', 'templates'] as const,
};

export const useAcademicYears = () =>
  useQuery({
    queryKey: leaveKeys.years,
    queryFn: async () => (await adminGet<{ years: AcademicYear[] }>('/leave/calendar/years')).years,
    retry: false,
  });

export const useYearDetail = (id: number | null) =>
  useQuery({
    queryKey: leaveKeys.year(id ?? 0),
    queryFn: () => adminGet<YearDetail>(`/leave/calendar/years/${id}`),
    enabled: id !== null,
    retry: false,
  });

export const useCalendarTemplates = () =>
  useQuery({
    queryKey: leaveKeys.templates,
    queryFn: async () => (await adminGet<{ templates: CalendarTemplate[] }>('/leave/calendar/templates')).templates,
    retry: false,
  });
