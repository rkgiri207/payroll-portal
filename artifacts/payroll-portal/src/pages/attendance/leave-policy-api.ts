import { useQuery } from '@tanstack/react-query';
import { adminGet } from './api';

export type CreditMode = 'UPFRONT' | 'MONTHLY' | 'MANUAL';
export type CarryForwardMode = 'NONE' | 'LIMIT' | 'ALL';
export type InsufficientBalance = 'REJECT' | 'LOP' | 'NEGATIVE';

export interface LeaveType {
  id: number; code: string; name: string; isPaid: boolean; tracksBalance: boolean; isActive: boolean; sortOrder: number;
}

export interface Policy {
  creditMode: CreditMode; defaultAnnualDays: number; monthlyAccrualDays: number; carryForwardMode: CarryForwardMode; carryForwardLimit: number | null;
  encashmentAllowed: boolean; encashmentLimitDays: number | null; insufficientBalance: InsufficientBalance;
  allowHalfDay: boolean; minNoticeDays: number; maxConsecutiveDays: number | null; updatedAt: string | null;
}
export interface PolicyRow { type: LeaveType; policy: Policy | null }

export interface Allocation {
  employeeId: number; employeeCode: string; employeeName: string; designation: string | null;
  annualDays: number | null; creditModeOverride: CreditMode | null; carryForwardOverride: CarryForwardMode | null;
  carryForwardLimitOverride: number | null; effectiveDays: number;
  monthlyAccrualOverride: number | null; encashmentOverride: boolean | null; encashmentLimitOverride: number | null;
  /** What actually applies: the employee's own setting, else the policy's. */
  effectiveMode: CreditMode | null; effectiveMonthlyDays: number;
}

export const policyKeys = {
  types: ['leave', 'types'] as const,
  policies: (yearId: number) => ['leave', 'policies', yearId] as const,
  allocations: (yearId: number, typeId: number, search: string) => ['leave', 'allocations', yearId, typeId, search] as const,
  allocationsAll: ['leave', 'allocations'] as const,
};

export const useLeaveTypes = () =>
  useQuery({
    queryKey: policyKeys.types,
    queryFn: async () => (await adminGet<{ types: LeaveType[] }>('/leave/types')).types,
    retry: false,
  });

export const usePolicies = (yearId: number | null) =>
  useQuery({
    queryKey: policyKeys.policies(yearId ?? 0),
    queryFn: async () => (await adminGet<{ policies: PolicyRow[] }>(`/leave/policies/${yearId}`)).policies,
    enabled: yearId !== null,
    retry: false,
  });

export const useAllocations = (yearId: number | null, typeId: number | null, search: string) =>
  useQuery({
    queryKey: policyKeys.allocations(yearId ?? 0, typeId ?? 0, search),
    queryFn: async () => {
      const qs = search.trim() ? `?search=${encodeURIComponent(search.trim())}` : '';
      return (await adminGet<{ allocations: Allocation[] }>(`/leave/allocations/${yearId}/${typeId}${qs}`)).allocations;
    },
    enabled: yearId !== null && typeId !== null,
    retry: false,
  });
