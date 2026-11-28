import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Copy } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { useToast } from '@/hooks/use-toast';
import { adminPost, adminPut } from './api';
import { policyKeys, usePolicies, type PolicyRow } from './leave-policy-api';
import type { AcademicYear } from './leave-api';
import {
  CARRY_OPTIONS, CREDIT_OPTIONS, describePolicy, formToBody, INSUFFICIENT_OPTIONS, policyToForm, sameForm, type PolicyForm,
} from './policy-helpers';
import { errorText, useRefresh } from './use-attendance';

function Field(props: { id: string; label: string; help?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={props.id}>{props.label}</Label>
      {props.children}
      {props.help && <p className="text-xs text-muted-foreground">{props.help}</p>}
    </div>
  );
}

function PolicyCard({ row, year }: { row: PolicyRow; year: AcademicYear }) {
  const { toast } = useToast();
  const refresh = useRefresh();
  const saved = policyToForm(row.policy);
  const [form, setForm] = useState<PolicyForm>(saved);
  const [open, setOpen] = useState(row.policy === null);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof PolicyForm>(key: K, value: PolicyForm[K]) => setForm(f => ({ ...f, [key]: value }));
  const tracks = row.type.tracksBalance;
  const changed = row.policy === null || !sameForm(form, saved);

  const save = useMutation({
    mutationFn: () => adminPut(`/leave/policies/${year.id}/${row.type.id}`, formToBody(form)),
    onSuccess: () => {
      refresh(policyKeys.policies(year.id));
      toast({ title: 'Policy saved', description: `${row.type.name}, ${year.label}` });
      setError(null);
      setOpen(false);
    },
    onError: e => setError(errorText(e)),
  });

  return (
    <Card className={row.type.isActive ? undefined : 'opacity-60'}>
      <CardHeader className="flex-row items-start justify-between gap-4 space-y-0 pb-2">
        <div className="space-y-1">
          <CardTitle className="flex items-center gap-2 text-base">
            {row.type.name}
            {!row.policy && <Badge variant="outline">Not set</Badge>}
            {!row.type.isActive && <Badge variant="outline">Off</Badge>}
          </CardTitle>
          <CardDescription>{describePolicy(row.policy, tracks)}</CardDescription>
        </div>
        <Button size="sm" variant={open ? 'ghost' : 'outline'} onClick={() => { setForm(saved); setError(null); setOpen(o => !o); }}>
          {open ? 'Close' : row.policy ? 'Edit' : 'Set up'}
        </Button>
      </CardHeader>
      {open && (
        <CardContent className="space-y-5 border-t pt-4">
          {tracks && (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field id={`credit-${row.type.id}`} label="How leave is credited" help={CREDIT_OPTIONS.find(o => o.value === form.creditMode)?.help}>
                <Select value={form.creditMode} onValueChange={v => set('creditMode', v as PolicyForm['creditMode'])}>
                  <SelectTrigger id={`credit-${row.type.id}`}><SelectValue /></SelectTrigger>
                  <SelectContent>{CREDIT_OPTIONS.map(o => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}</SelectContent>
                </Select>
              </Field>
              {form.creditMode === 'MONTHLY' && (
                <Field id={`monthly-${row.type.id}`} label="Days credited each month"
                  help="Credited on the 1st of every month, for example 1, 0.5 or 1.25 (up to 2 decimals). The month an employee joins earns nothing; the next month is the first. You can give one employee a different number on the Allocations tab.">
                  <Input id={`monthly-${row.type.id}`} inputMode="decimal" value={form.monthlyAccrualDays} onChange={e => set('monthlyAccrualDays', e.target.value)} />
                </Field>
              )}
              {form.creditMode === 'UPFRONT' && (
                <Field id={`days-${row.type.id}`} label="Yearly days" help="The default for every employee. Set an individual's own days on the Allocations tab.">
                  <Input id={`days-${row.type.id}`} inputMode="decimal" value={form.defaultAnnualDays} onChange={e => set('defaultAnnualDays', e.target.value)} />
                </Field>
              )}
              <Field id={`carry-${row.type.id}`} label="At the end of the academic year">
                <Select value={form.carryForwardMode} onValueChange={v => set('carryForwardMode', v as PolicyForm['carryForwardMode'])}>
                  <SelectTrigger id={`carry-${row.type.id}`}><SelectValue /></SelectTrigger>
                  <SelectContent>{CARRY_OPTIONS.map(o => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}</SelectContent>
                </Select>
              </Field>
              {form.carryForwardMode === 'LIMIT' && (
                <Field id={`carrylimit-${row.type.id}`} label="Most days carried forward">
                  <Input id={`carrylimit-${row.type.id}`} inputMode="decimal" value={form.carryForwardLimit} onChange={e => set('carryForwardLimit', e.target.value)} />
                </Field>
              )}
              <Field id={`short-${row.type.id}`} label="When the balance is not enough"
                help={INSUFFICIENT_OPTIONS.find(o => o.value === form.insufficientBalance)?.help}>
                <Select value={form.insufficientBalance} onValueChange={v => set('insufficientBalance', v as PolicyForm['insufficientBalance'])}>
                  <SelectTrigger id={`short-${row.type.id}`}><SelectValue /></SelectTrigger>
                  <SelectContent>{INSUFFICIENT_OPTIONS.map(o => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}</SelectContent>
                </Select>
              </Field>
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <Label htmlFor={`encash-${row.type.id}`}>Encashment allowed</Label>
                    <p className="text-xs text-muted-foreground">Recorded only. It has no effect on payroll.</p>
                  </div>
                  <Switch id={`encash-${row.type.id}`} checked={form.encashmentAllowed} onCheckedChange={v => set('encashmentAllowed', v)} />
                </div>
                {form.encashmentAllowed && (
                  <Field id={`encashlimit-${row.type.id}`} label="Most days that can be encashed (empty = no limit)">
                    <Input id={`encashlimit-${row.type.id}`} inputMode="decimal" value={form.encashmentLimitDays} onChange={e => set('encashmentLimitDays', e.target.value)} />
                  </Field>
                )}
              </div>
            </div>
          )}
          {!tracks && <p className="text-sm text-muted-foreground">{row.type.name} has no balance, so only the request rules below apply.</p>}

          <div className="grid gap-4 border-t pt-4 sm:grid-cols-3">
            <div className="flex items-center justify-between gap-4 sm:col-span-3">
              <div>
                <Label htmlFor={`half-${row.type.id}`}>Half-days allowed</Label>
                <p className="text-xs text-muted-foreground">A half-day is on a single date and counts as 0.5 day.</p>
              </div>
              <Switch id={`half-${row.type.id}`} checked={form.allowHalfDay} onCheckedChange={v => set('allowHalfDay', v)} />
            </div>
            <Field id={`notice-${row.type.id}`} label="Minimum notice (days)">
              <Input id={`notice-${row.type.id}`} inputMode="numeric" value={form.minNoticeDays} onChange={e => set('minNoticeDays', e.target.value)} />
            </Field>
            <Field id={`max-${row.type.id}`} label="Longest single leave (days, empty = no limit)">
              <Input id={`max-${row.type.id}`} inputMode="numeric" value={form.maxConsecutiveDays} onChange={e => set('maxConsecutiveDays', e.target.value)} />
            </Field>
          </div>

          {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => { setForm(saved); setError(null); setOpen(false); }}>Cancel</Button>
            <Button onClick={() => { setError(null); save.mutate(); }} disabled={!changed || save.isPending}>{save.isPending ? 'Saving…' : 'Save policy'}</Button>
          </div>
        </CardContent>
      )}
    </Card>
  );
}

export function PolicyTab({ year, otherYears }: { year: AcademicYear; otherYears: AcademicYear[] }) {
  const policies = usePolicies(year.id);
  const { toast } = useToast();
  const refresh = useRefresh();
  const [copyFrom, setCopyFrom] = useState<string>('');

  const copy = useMutation({
    mutationFn: () => adminPost<{ copied: number }>(`/leave/policies/${year.id}/copy-from/${copyFrom}`, {}),
    onSuccess: r => {
      refresh(policyKeys.policies(year.id));
      toast({ title: r.copied > 0 ? 'Policies copied' : 'Nothing to copy', description: r.copied > 0 ? `${r.copied} leave type policies copied. Review them, then adjust anything that changed.` : 'This year already has a policy for each leave type that the other year has.' });
    },
    onError: e => toast({ title: 'Could not copy', description: errorText(e), variant: 'destructive' }),
  });

  if (policies.isLoading) return <Skeleton className="h-64 w-full" />;
  if (policies.isError) return <Alert variant="destructive"><AlertDescription>{errorText(policies.error)}</AlertDescription></Alert>;
  const rows = policies.data!;
  const unset = rows.filter(r => r.type.isActive && !r.policy).length;

  return (
    <div className="space-y-4">
      <Alert>
        <AlertDescription>
          These rules apply to academic year <strong>{year.label}</strong> only. Each academic year has its own policies, so
          changing them here never affects another year.
          {unset > 0 && ` ${unset} leave type${unset === 1 ? ' has' : 's have'} no policy yet, so nothing is credited for ${unset === 1 ? 'it' : 'them'}.`}
        </AlertDescription>
      </Alert>

      {otherYears.length > 0 && rows.some(r => !r.policy) && (
        <div className="flex flex-wrap items-center gap-2">
          <Select value={copyFrom} onValueChange={setCopyFrom}>
            <SelectTrigger className="w-56" aria-label="Copy policies from"><SelectValue placeholder="Copy policies from…" /></SelectTrigger>
            <SelectContent>{otherYears.map(y => <SelectItem key={y.id} value={String(y.id)}>{y.label}</SelectItem>)}</SelectContent>
          </Select>
          <Button variant="outline" disabled={!copyFrom || copy.isPending} onClick={() => copy.mutate()}>
            <Copy className="mr-2 h-4 w-4" />{copy.isPending ? 'Copying…' : 'Copy'}
          </Button>
          <span className="text-xs text-muted-foreground">Policies this year already has are kept.</span>
        </div>
      )}

      {rows.map(row => <PolicyCard key={`${row.type.id}:${row.policy?.updatedAt ?? 'none'}`} row={row} year={year} />)}
    </div>
  );
}
