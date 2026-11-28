import { useQuery } from '@tanstack/react-query';
import { adminGet } from './api';

export interface PlannedEntry {
  entryType: 'CREDIT' | 'ADJUSTMENT'; amount: number; effectiveDate: string; period: string; reason: string;
}
export interface AccrualLine { employeeId: number; employeeCode: string; employeeName: string; leaveType: string; entries: PlannedEntry[] }
export interface AccrualSummary {
  today: string; year: { id: number; label: string; accrualFrom: string | null } | null; dryRun: boolean;
  employeesConsidered: number; creditsPosted: number; adjustmentsPosted: number; daysPosted: number;
  missingJoiningDate: { employeeId: number; employeeCode: string; employeeName: string }[];
  lines: AccrualLine[]; truncated: boolean;
}

export interface MissingEmployee { employeeId: number; employeeCode: string; employeeName: string }
export interface OpeningRow { employeeId: number; employeeCode: string; employeeName: string; joiningDate: string | null; opening: number | null }

export const accrualKeys = {
  missing: ['leave', 'accrual', 'missing'] as const,
  openingAll: ['leave', 'opening'] as const,
  opening: (yearId: number, typeId: number, search: string) => ['leave', 'opening', yearId, typeId, search] as const,
};

export const useMissingJoiningDates = () =>
  useQuery({
    queryKey: accrualKeys.missing,
    queryFn: async () => (await adminGet<{ employees: MissingEmployee[] }>('/leave/accrual/missing-joining-dates')).employees,
    retry: false,
  });

export const useOpening = (yearId: number | null, typeId: number | null, search: string) =>
  useQuery({
    queryKey: accrualKeys.opening(yearId ?? 0, typeId ?? 0, search),
    queryFn: async () => {
      const qs = search.trim() ? `?search=${encodeURIComponent(search.trim())}` : '';
      return (await adminGet<{ employees: OpeningRow[] }>(`/leave/opening/${yearId}/${typeId}${qs}`)).employees;
    },
    enabled: yearId !== null && typeId !== null,
    retry: false,
  });
