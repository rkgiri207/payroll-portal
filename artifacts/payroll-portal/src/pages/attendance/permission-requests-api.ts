import { useQuery } from '@tanstack/react-query';
import { adminGet } from './api';
import type { LeaveStatus } from './leave-requests-api';

export interface PermissionRequest {
  id: string; status: LeaveStatus; employeeId: number; employeeCode: string; employeeName: string; campusName: string;
  date: string; startTime: string; endTime: string; reason: string; submittedVia: 'WHATSAPP_LINK' | 'MANUAL';
  submittedAt: string; decidedVia: string | null; decidedAt: string | null; decisionNote: string | null;
  cancelledBy: string | null; cancelReason: string | null;
}

export const permissionKeys = {
  all: ['leave', 'permissions'] as const,
  list: (status: string) => ['leave', 'permissions', 'list', status] as const,
};

export const usePermissionRequests = (status: LeaveStatus | 'ALL') =>
  useQuery({
    queryKey: permissionKeys.list(status),
    queryFn: () => adminGet<{ permissions: PermissionRequest[]; counts: Record<LeaveStatus, number> }>(`/leave/permissions${status === 'ALL' ? '' : `?status=${status}`}`),
    refetchInterval: 30_000, // a new request from WhatsApp appears without a refresh
    retry: false,
  });
