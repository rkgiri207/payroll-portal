import { useEffect, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Pencil, Users } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useToast } from '@/hooks/use-toast';
import { adminDelete, adminPost, adminPut } from './api';
import type { AcademicYear } from './leave-api';
import { policyKeys, useAllocations, useLeaveTypes, type Allocation, type LeaveType } from './leave-policy-api';
import { CARRY_OPTIONS, CREDIT_OPTIONS, creditPhrase, labelOf } from './policy-helpers';
import { errorText, useRefresh } from './use-attendance';

const FOLLOW = 'policy';

function EditDialog({ year, type, row, onClose }: { year: AcademicYear; type: LeaveType; row: Allocation; onClose(): void }) {
  const { toast } = useToast();
  const refresh = useRefresh();
  const [form, setForm] = useState({
    days: String(row.effectiveDays), credit: row.creditModeOverride ?? FOLLOW, carry: row.carryForwardOverride ?? FOLLOW,
    carryLimit: row.carryForwardLimitOverride === null ? '' : String(row.carryForwardLimitOverride),
    monthly: row.monthlyAccrualOverride === null ? '' : String(row.monthlyAccrualOverride),
    encash: row.encashmentOverride === null ? FOLLOW : row.encashmentOverride ? 'yes' : 'no',
    encashLimit: row.encashmentLimitOverride === null ? '' : String(row.encashmentLimitOverride),
  });
  const [error, setError] = useState<string | null>(null);
  const base = `/leave/allocations/${year.id}/${type.id}/${row.employeeId}`;
  const done = (title: string) => {
    refresh(policyKeys.allocationsAll);
    toast({ title, description: `${row.employeeName}, ${type.name}, ${year.label}` });
    onClose();
  };

  const save = useMutation({
    mutationFn: () => adminPut(base, {
      annualDays: form.days,
      creditModeOverride: form.credit === FOLLOW ? null : form.credit,
      carryForwardOverride: form.carry === FOLLOW ? null : form.carry,
      carryForwardLimitOverride: form.carry === 'LIMIT' ? form.carryLimit : null,
      monthlyAccrualOverride: form.monthly.trim() === '' ? null : form.monthly,
      encashmentOverride: form.encash === FOLLOW ? null : form.encash === 'yes',
      encashmentLimitOverride: form.encash === 'yes' && form.encashLimit.trim() !== '' ? form.encashLimit : null,
    }),
    onSuccess: () => done('Allocation saved'),
    onError: e => setError(errorText(e)),
  });
  const reset = useMutation({
    mutationFn: () => adminDelete(base),
    onSuccess: () => done('Back to the policy default'),
    onError: e => setError(errorText(e)),
  });

  return (
    <Dialog open onOpenChange={o => { if (!o) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{row.employeeName}: {type.name}</DialogTitle>
          <DialogDescription>
            Academic year {year.label}. Changing days here does not change any balance that has already been credited.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="alloc-days">Yearly days for this employee</Label>
            <Input id="alloc-days" inputMode="decimal" value={form.days} onChange={e => setForm(f => ({ ...f, days: e.target.value }))} />
            <p className="text-xs text-muted-foreground">Used when leave is credited all at the start.</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="alloc-monthly">Days credited each month for this employee</Label>
            <Input id="alloc-monthly" inputMode="decimal" placeholder="Same as the policy" value={form.monthly} onChange={e => setForm(f => ({ ...f, monthly: e.target.value }))} />
            <p className="text-xs text-muted-foreground">Leave empty to follow the policy. Up to 2 decimals, for example 1.25.</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="alloc-credit">How leave is credited</Label>
            <Select value={form.credit} onValueChange={v => setForm(f => ({ ...f, credit: v }))}>
              <SelectTrigger id="alloc-credit"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={FOLLOW}>Same as the policy</SelectItem>
                {CREDIT_OPTIONS.map(o => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="alloc-carry">At the end of the academic year</Label>
            <Select value={form.carry} onValueChange={v => setForm(f => ({ ...f, carry: v }))}>
              <SelectTrigger id="alloc-carry"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={FOLLOW}>Same as the policy</SelectItem>
                {CARRY_OPTIONS.map(o => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          {form.carry === 'LIMIT' && (
            <div className="space-y-1.5">
              <Label htmlFor="alloc-limit">Most days carried forward</Label>
              <Input id="alloc-limit" inputMode="decimal" value={form.carryLimit} onChange={e => setForm(f => ({ ...f, carryLimit: e.target.value }))} />
            </div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="alloc-encash">Encashment of unused days at year end</Label>
            <Select value={form.encash} onValueChange={v => setForm(f => ({ ...f, encash: v }))}>
              <SelectTrigger id="alloc-encash"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={FOLLOW}>Same as the policy</SelectItem>
                <SelectItem value="yes">Allowed for this employee</SelectItem>
                <SelectItem value="no">Not allowed for this employee</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">By default unused days lapse. Encashment is recorded only and has no effect on payroll.</p>
          </div>
          {form.encash === 'yes' && (
            <div className="space-y-1.5">
              <Label htmlFor="alloc-encash-limit">Most days that can be encashed (empty = no limit)</Label>
              <Input id="alloc-encash-limit" inputMode="decimal" value={form.encashLimit} onChange={e => setForm(f => ({ ...f, encashLimit: e.target.value }))} />
            </div>
          )}
          {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
        </div>
        <DialogFooter className="gap-2 sm:justify-between">
          {row.annualDays !== null
            ? <Button variant="ghost" onClick={() => { setError(null); reset.mutate(); }} disabled={reset.isPending}>Use the policy default</Button>
            : <span />}
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose}>Cancel</Button>
            <Button onClick={() => { setError(null); save.mutate(); }} disabled={save.isPending}>{save.isPending ? 'Saving…' : 'Save'}</Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ApplyDialog({ year, type, onClose }: { year: AcademicYear; type: LeaveType; onClose(): void }) {
  const { toast } = useToast();
  const refresh = useRefresh();
  const [days, setDays] = useState('');
  const [overwrite, setOverwrite] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const apply = useMutation({
    mutationFn: () => adminPost<{ applied: number }>(`/leave/allocations/${year.id}/${type.id}/apply`, { annualDays: days, employeeIds: 'ALL', overwrite }),
    onSuccess: r => {
      refresh(policyKeys.allocationsAll);
      toast({ title: 'Allocations applied', description: `${r.applied} employee${r.applied === 1 ? '' : 's'} updated for ${type.name}, ${year.label}.` });
      onClose();
    },
    onError: e => setError(errorText(e)),
  });

  return (
    <Dialog open onOpenChange={o => { if (!o) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Give everyone the same {type.name} days</DialogTitle>
          <DialogDescription>
            Applies to every active employee for academic year {year.label}. You can still change any one employee afterwards.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="apply-days">Yearly days</Label>
            <Input id="apply-days" inputMode="decimal" value={days} onChange={e => setDays(e.target.value)} />
          </div>
          <div className="flex items-start gap-3">
            <Checkbox id="apply-overwrite" checked={overwrite} onCheckedChange={v => setOverwrite(v === true)} />
            <div>
              <Label htmlFor="apply-overwrite">Replace days I have already set for individual employees</Label>
              <p className="text-xs text-muted-foreground">Left unticked, employees with their own days keep them.</p>
            </div>
          </div>
          {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => { setError(null); apply.mutate(); }} disabled={apply.isPending || days.trim() === ''}>{apply.isPending ? 'Applying…' : 'Apply to everyone'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function AllocationsTab({ year }: { year: AcademicYear }) {
  const types = useLeaveTypes();
  const balanceTypes = (types.data ?? []).filter(t => t.tracksBalance && t.isActive);
  const [typeId, setTypeId] = useState<number | null>(null);
  const [searchText, setSearchText] = useState('');
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<Allocation | null>(null);
  const [applying, setApplying] = useState(false);

  useEffect(() => { // wait for a pause in typing before asking the server
    const timer = setTimeout(() => setSearch(searchText), 300);
    return () => clearTimeout(timer);
  }, [searchText]);
  useEffect(() => { if (typeId === null && balanceTypes.length > 0) setTypeId(balanceTypes[0].id); }, [typeId, balanceTypes]);

  const type = balanceTypes.find(t => t.id === typeId) ?? null;
  const allocations = useAllocations(year.id, typeId, search);

  if (types.isLoading) return <Skeleton className="h-48 w-full" />;
  if (balanceTypes.length === 0) return <Alert><AlertDescription>There is no active leave type that keeps a balance yet.</AlertDescription></Alert>;

  return (
    <Card>
      <CardHeader className="space-y-3 pb-2">
        <div>
          <CardTitle className="text-base">Leave credit per employee, {year.label}</CardTitle>
          <CardDescription>
            Employees follow the policy's yearly days unless you give them their own. Each academic year has its own allocations.
          </CardDescription>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select value={typeId === null ? undefined : String(typeId)} onValueChange={v => setTypeId(Number(v))}>
            <SelectTrigger className="w-52" aria-label="Leave type"><SelectValue /></SelectTrigger>
            <SelectContent>{balanceTypes.map(t => <SelectItem key={t.id} value={String(t.id)}>{t.name}</SelectItem>)}</SelectContent>
          </Select>
          <Input className="w-56" placeholder="Search name or code" aria-label="Search employees" value={searchText} onChange={e => setSearchText(e.target.value)} />
          <Button variant="outline" className="ml-auto" disabled={!type || !allocations.data} onClick={() => setApplying(true)}>
            <Users className="mr-2 h-4 w-4" />Same days for everyone
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {allocations.isLoading && <Skeleton className="h-48 w-full" />}
        {allocations.isError && <Alert variant="destructive"><AlertDescription>{errorText(allocations.error)}</AlertDescription></Alert>}
        {allocations.data && (allocations.data.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">No active employees match.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Employee</TableHead><TableHead>Credit</TableHead><TableHead>Source</TableHead><TableHead>Own rules</TableHead>
                <TableHead className="w-16" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {allocations.data.map(a => (
                <TableRow key={a.employeeId}>
                  <TableCell>
                    <div className="font-medium">{a.employeeName}</div>
                    <div className="text-xs text-muted-foreground">{a.employeeCode}{a.designation ? `, ${a.designation}` : ''}</div>
                  </TableCell>
                  <TableCell className="text-sm">{a.effectiveMode ? creditPhrase(a.effectiveMode, a.effectiveMonthlyDays, a.effectiveDays) : 'No policy yet'}</TableCell>
                  <TableCell><Badge variant={a.annualDays === null && a.monthlyAccrualOverride === null ? 'outline' : 'secondary'}>{a.annualDays === null && a.monthlyAccrualOverride === null ? 'Policy default' : 'Own setting'}</Badge></TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {[a.creditModeOverride && labelOf(CREDIT_OPTIONS, a.creditModeOverride), a.carryForwardOverride && labelOf(CARRY_OPTIONS, a.carryForwardOverride), a.encashmentOverride !== null && (a.encashmentOverride ? 'Encashment allowed' : 'Encashment not allowed')].filter(Boolean).join('; ') || '-'}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button size="icon" variant="ghost" aria-label={`Edit ${a.employeeName}`} onClick={() => setEditing(a)}><Pencil className="h-4 w-4" /></Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ))}
      </CardContent>
      {editing && type && <EditDialog key={editing.employeeId} year={year} type={type} row={editing} onClose={() => setEditing(null)} />}
      {applying && type && <ApplyDialog year={year} type={type} onClose={() => setApplying(false)} />}
    </Card>
  );
}
