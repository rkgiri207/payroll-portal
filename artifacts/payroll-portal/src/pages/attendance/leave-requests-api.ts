import { useQuery } from '@tanstack/react-query';
import { adminGet } from './api';

export type LeaveStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';
export type DayMode = 'FULL' | 'FIRST_HALF' | 'SECOND_HALF';

export interface LeaveRequest {
  id: string; status: LeaveStatus; employeeId: number; employeeCode: string; employeeName: string;
  leaveTypeId: number; leaveTypeName: string; academicYearId: number; academicYearLabel: string;
  campusId: number; campusName: string; startDate: string; endDate: string; dayMode: DayMode; reason: string;
  totalDays: number; paidDays: number; lopDays: number; submittedVia: 'WHATSAPP_LINK' | 'MANUAL';
  submittedAt: string; decidedVia: string | null; decidedAt: string | null; decisionNote: string | null;
  cancelledBy: string | null; cancelReason: string | null;
}

export type StatusCounts = Record<LeaveStatus, number>;

export interface RequestDetail {
  request: LeaveRequest;
  days: { date: string; fraction: number; campusName: string }[];
  /** What approving would do right now. null once the request is no longer pending. */
  ifApproved: { ok: true; paidDays: number; lopDays: number; balance: number } | { ok: false; balance: number; message: string } | null;
}

export interface Preview {
  ok: true;
  plan: { days: { date: string; campusId: number; fraction: number }[]; totalDays: number; paidDays: number; lopDays: number; campusId: number };
  yearLabel: string; leaveType: string; availableBalance: number;
}

export const requestKeys = {
  all: ['leave', 'requests'] as const,
  list: (status: string, yearId: number | null) => ['leave', 'requests', 'list', status, yearId] as const,
  detail: (id: string) => ['leave', 'requests', 'detail', id] as const,
};

export const useLeaveRequests = (status: LeaveStatus | 'ALL', yearId: number | null) =>
  useQuery({
    queryKey: requestKeys.list(status, yearId),
    queryFn: () => {
      const params = new URLSearchParams();
      if (status !== 'ALL') params.set('status', status);
      if (yearId !== null) params.set('yearId', String(yearId));
      return adminGet<{ requests: LeaveRequest[]; counts: StatusCounts }>(`/leave/requests?${params}`);
    },
    refetchInterval: 30_000, // a new request from WhatsApp appears without a refresh
    retry: false,
  });

export const useRequestDetail = (id: string | null) =>
  useQuery({
    queryKey: requestKeys.detail(id ?? ''),
    queryFn: () => adminGet<RequestDetail>(`/leave/requests/${id}`),
    enabled: id !== null,
    retry: false,
  });
