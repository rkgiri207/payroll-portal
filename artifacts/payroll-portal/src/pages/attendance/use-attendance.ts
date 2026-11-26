import { useQuery, useQueryClient } from '@tanstack/react-query';
import { adminGet, type Campus, type Me, type SettingRow, type SetupStatus } from './api';

export const keys = {
  me: ['attendance', 'me'] as const,
  status: ['attendance', 'setup-status'] as const,
  settings: ['attendance', 'settings'] as const,
  campuses: ['attendance', 'campuses'] as const,
  shifts: (campusId: number) => ['attendance', 'shifts', campusId] as const,
  employees: (params: string) => ['attendance', 'employees', params] as const,
  assignments: (employeeId: number) => ['attendance', 'assignments', employeeId] as const,
  dashboard: ['attendance', 'dashboard'] as const,
  unmarked: ['attendance', 'unmarked'] as const,
  exceptions: ['attendance', 'exceptions'] as const,
  pending: ['attendance', 'pending-review'] as const,
  profile: (employeeId: number) => ['attendance', 'profile', employeeId] as const,
};

export const useMe = () =>
  useQuery({ queryKey: keys.me, queryFn: () => adminGet<Me>('/me'), retry: false, staleTime: 60_000 });

export const useSetupStatus = () =>
  useQuery({ queryKey: keys.status, queryFn: () => adminGet<SetupStatus>('/setup-status'), retry: false });

export const useSettings = () =>
  useQuery({
    queryKey: keys.settings,
    queryFn: async () => (await adminGet<{ settings: SettingRow[] }>('/settings')).settings,
    retry: false,
  });

export const useCampuses = () =>
  useQuery({
    queryKey: keys.campuses,
    queryFn: async () => (await adminGet<{ campuses: Campus[] }>('/campuses')).campuses,
    retry: false,
  });

/** Read one setting's value with a fallback while settings are still loading. */
export function settingValue<T>(rows: SettingRow[] | undefined, key: string, fallback: T): T {
  const row = rows?.find(r => r.key === key);
  return row && row.value !== null && row.value !== undefined ? (row.value as T) : fallback;
}

/** After a change, refresh the checklist and whatever lists were affected. */
export function useRefresh() {
  const client = useQueryClient();
  return (...queryKeys: (readonly unknown[])[]) => {
    void client.invalidateQueries({ queryKey: keys.status });
    for (const key of queryKeys) void client.invalidateQueries({ queryKey: key });
  };
}

export const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : 'Something went wrong. Please try again.';
