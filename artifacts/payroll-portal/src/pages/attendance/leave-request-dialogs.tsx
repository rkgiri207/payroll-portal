import { useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import { adminGet, adminPost, type EmployeeRow } from './api';
import { useLeaveTypes } from './leave-policy-api';
import { requestKeys, useRequestDetail, type DayMode, type LeaveRequest, type Preview } from './leave-requests-api';
import { cancelNeedsReason, DAY_MODE_LABELS, requestDates } from './request-helpers';
import { errorText, useRefresh } from './use-attendance';

export type DecisionMode = 'approve' | 'reject' | 'cancel';

export function DecisionDialog({ request, mode, onClose }: { request: LeaveRequest; mode: DecisionMode; onClose(): void }) {
  const { toast } = useToast();
  const refresh = useRefresh();
  const detail = useRequestDetail(mode === 'approve' ? request.id : null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const reasonRequired = mode === 'reject' || (mode === 'cancel' && cancelNeedsReason(request));

  const run = useMutation({
    mutationFn: () => adminPost<{ message: string }>(`/leave/requests/${request.id}/${mode}`, mode === 'approve' ? {} : { reason }),
    onSuccess: r => {
      refresh(requestKeys.all);
      toast({ title: mode === 'approve' ? 'Leave approved' : mode === 'reject' ? 'Leave not approved' : 'Leave cancelled', description: r.message });
      onClose();
    },
    onError: e => setError(errorText(e)),
  });

  const approval = detail.data?.ifApproved ?? null;
  const blocked = mode === 'approve' && approval !== null && !approval.ok;

  return (
    <Dialog open onOpenChange={o => { if (!o) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {mode === 'approve' ? 'Approve' : mode === 'reject' ? 'Do not approve' : 'Cancel'} {request.leaveTypeName} for {request.employeeName}?
          </DialogTitle>
          <DialogDescription>
            {requestDates(request)} · {request.campusName} · {request.academicYearLabel}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 text-sm">
          <p><span className="text-muted-foreground">Reason given:</span> {request.reason}</p>

          {mode === 'approve' && (detail.isLoading ? <Skeleton className="h-16 w-full" /> : approval && (approval.ok ? (
            <div className="rounded-md border p-3">
              <p className="font-medium">If you approve now</p>
              <p>{request.totalDays} day{request.totalDays === 1 ? '' : 's'}: <strong>{approval.paidDays} paid</strong>
                {approval.lopDays > 0 && <>, <strong className="text-destructive">{approval.lopDays} without pay (loss of pay)</strong></>}.</p>
              <p className="text-xs text-muted-foreground">
                Balance now {approval.balance} day{approval.balance === 1 ? '' : 's'}; it will be {Math.max(approval.balance - approval.paidDays, 0)} after approval.
                The split is fixed at the moment you approve.
              </p>
            </div>
          ) : (
            <Alert variant="destructive"><AlertDescription>{approval.message} You can reject the request instead.</AlertDescription></Alert>
          )))}

          {mode === 'cancel' && request.status === 'APPROVED' && (
            <Alert><AlertDescription>This leave is already approved. Cancelling gives the {request.paidDays} paid day{request.paidDays === 1 ? '' : 's'} back to the balance and frees the campus place.</AlertDescription></Alert>
          )}

          {mode !== 'approve' && (
            <div className="space-y-1.5">
              <Label htmlFor="decision-reason">{mode === 'reject' ? 'Reason (the employee will see this)' : reasonRequired ? 'Reason for cancelling' : 'Reason (optional)'}</Label>
              <Textarea id="decision-reason" rows={3} maxLength={500} value={reason} onChange={e => setReason(e.target.value)} />
            </div>
          )}
          {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Back</Button>
          <Button
            variant={mode === 'approve' ? 'default' : 'destructive'}
            disabled={run.isPending || blocked || (mode === 'approve' && detail.isLoading) || (reasonRequired && reason.trim() === '')}
            onClick={() => { setError(null); run.mutate(); }}
          >
            {run.isPending ? 'Saving…' : mode === 'approve' ? 'Approve' : mode === 'reject' ? 'Do not approve' : 'Cancel the leave'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Enter leave for an employee, for example a past date. It still waits for the Director's decision. */
export function EntryDialog({ onClose }: { onClose(): void }) {
  const { toast } = useToast();
  const refresh = useRefresh();
  const types = useLeaveTypes();
  const activeTypes = (types.data ?? []).filter(t => t.isActive);
  const [search, setSearch] = useState('');
  const [employee, setEmployee] = useState<EmployeeRow | null>(null);
  const [form, setForm] = useState({ leaveTypeId: '', startDate: '', endDate: '', dayMode: 'FULL' as DayMode, reason: '' });
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = useMemo(() => crypto.randomUUID(), []);          // one key per dialog, so a double click saves once

  const matches = useQuery({
    queryKey: ['leave', 'entry-employees', search],
    queryFn: async () => (await adminGet<{ employees: EmployeeRow[] }>(`/employees?status=ACTIVE&limit=6&search=${encodeURIComponent(search.trim())}`)).employees,
    enabled: employee === null && search.trim().length >= 2,
    retry: false,
  });

  const body = () => ({
    employeeId: employee?.id, leaveTypeId: Number(form.leaveTypeId), startDate: form.startDate,
    endDate: form.endDate || form.startDate, dayMode: form.dayMode,
  });
  const ready = employee !== null && form.leaveTypeId !== '' && form.startDate !== '';
  const changed = (patch: Partial<typeof form>) => { setForm(f => ({ ...f, ...patch })); setPreview(null); setError(null); };

  const check = useMutation({
    mutationFn: () => adminPost<Preview>('/leave/requests/preview', body()),
    onSuccess: r => { setPreview(r); setError(null); },
    onError: e => { setPreview(null); setError(errorText(e)); },
  });
  const save = useMutation({
    mutationFn: () => adminPost('/leave/requests', { ...body(), reason: form.reason, idempotencyKey: key }),
    onSuccess: () => {
      refresh(requestKeys.all);
      toast({ title: 'Leave entered', description: `${employee?.employeeName}: waiting for the Director's decision.` });
      onClose();
    },
    onError: e => setError(errorText(e)),
  });

  return (
    <Dialog open onOpenChange={o => { if (!o) onClose(); }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Enter leave for an employee</DialogTitle>
          <DialogDescription>Use this for leave the employee could not request themselves, such as a past date. The Director still has to approve it.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="entry-employee">Employee</Label>
            {employee ? (
              <div className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
                <span>{employee.employeeName} <span className="text-muted-foreground">({employee.employeeCode})</span></span>
                <Button size="sm" variant="ghost" onClick={() => { setEmployee(null); setPreview(null); }}>Change</Button>
              </div>
            ) : (
              <>
                <Input id="entry-employee" placeholder="Type a name or code" value={search} onChange={e => setSearch(e.target.value)} />
                {(matches.data ?? []).length > 0 && (
                  <ul className="rounded-md border">
                    {matches.data!.map(e => (
                      <li key={e.id}>
                        <button type="button" className="w-full px-3 py-2 text-left text-sm hover:bg-muted" onClick={() => { setEmployee(e); setSearch(''); setPreview(null); }}>
                          {e.employeeName} <span className="text-muted-foreground">({e.employeeCode})</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {matches.data && matches.data.length === 0 && <p className="text-xs text-muted-foreground">No active employee matches.</p>}
              </>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="entry-type">Leave type</Label>
            <Select value={form.leaveTypeId} onValueChange={v => changed({ leaveTypeId: v })}>
              <SelectTrigger id="entry-type"><SelectValue placeholder="Choose a leave type" /></SelectTrigger>
              <SelectContent>{activeTypes.map(t => <SelectItem key={t.id} value={String(t.id)}>{t.name}</SelectItem>)}</SelectContent>
            </Select>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="entry-start">First day</Label>
              <Input id="entry-start" type="date" value={form.startDate} onChange={e => changed({ startDate: e.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="entry-end">Last day (empty = one day)</Label>
              <Input id="entry-end" type="date" min={form.startDate} value={form.endDate} onChange={e => changed({ endDate: e.target.value })} />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="entry-mode">Day</Label>
            <Select value={form.dayMode} onValueChange={v => changed({ dayMode: v as DayMode })}>
              <SelectTrigger id="entry-mode"><SelectValue /></SelectTrigger>
              <SelectContent>{(Object.keys(DAY_MODE_LABELS) as DayMode[]).map(m => <SelectItem key={m} value={m}>{DAY_MODE_LABELS[m]}</SelectItem>)}</SelectContent>
            </Select>
            {form.dayMode !== 'FULL' && <p className="text-xs text-muted-foreground">A half-day is for a single date.</p>}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="entry-reason">Reason</Label>
            <Textarea id="entry-reason" rows={2} maxLength={500} value={form.reason} onChange={e => { setForm(f => ({ ...f, reason: e.target.value })); setError(null); }} />
          </div>

          {preview && (
            <Alert>
              <AlertDescription>
                <strong>{preview.plan.totalDays} day{preview.plan.totalDays === 1 ? '' : 's'}</strong> of {preview.leaveType} in {preview.yearLabel}:{' '}
                {preview.plan.paidDays} paid{preview.plan.lopDays > 0 ? `, ${preview.plan.lopDays} without pay` : ''}.
                {' '}Holidays and weekly offs are not counted. Balance available: {preview.availableBalance}.
              </AlertDescription>
            </Alert>
          )}
          {error && <Alert variant="destructive"><AlertDescription className="whitespace-pre-line">{error}</AlertDescription></Alert>}
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button variant="secondary" disabled={!ready || check.isPending} onClick={() => check.mutate()}>{check.isPending ? 'Checking…' : 'Check the days'}</Button>
          <Button disabled={!ready || form.reason.trim() === '' || save.isPending} onClick={() => { setError(null); save.mutate(); }}>{save.isPending ? 'Saving…' : 'Enter leave'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

