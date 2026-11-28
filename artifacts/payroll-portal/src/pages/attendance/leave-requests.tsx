import { useEffect, useState } from 'react';
import { CalendarPlus, Check, Clock, Plus, X } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAcademicYears } from './leave-api';
import { DecisionDialog, EntryDialog, type DecisionMode } from './leave-request-dialogs';
import { useLeaveRequests, type LeaveRequest, type LeaveStatus } from './leave-requests-api';
import { canCancel, decisionLine, isAutoRejected, requestCost, requestDates, STATUS_SHORT, waitingDays } from './request-helpers';
import { PermissionRequestsPanel } from './permission-requests-panel';
import { AccessMessage } from './setup';
import { errorText, useMe } from './use-attendance';

type Tab = LeaveStatus | 'ALL';
const TABS: Tab[] = ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'ALL'];
const ALL_YEARS = 'all';

function defaultYearId(years: { id: number; startDate: string; endDate: string }[]): number | null {
  const today = new Date().toISOString().slice(0, 10);
  return (years.find(y => y.startDate <= today && today <= y.endDate) ?? years[0])?.id ?? null;
}

function RequestCard({ r, isDirector, onAct }: { r: LeaveRequest; isDirector: boolean; onAct(mode: DecisionMode): void }) {
  const wait = r.status === 'PENDING' ? waitingDays(r.submittedAt) : 0;
  const line = decisionLine(r);
  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <p className="font-medium">{r.employeeName} <span className="text-sm font-normal text-muted-foreground">({r.employeeCode}) · {r.campusName}</span></p>
            <p className="text-sm">{r.leaveTypeName} · {requestDates(r)}</p>
          </div>
          <div className="flex items-center gap-2">
            {isAutoRejected(r) && <Badge variant="outline">Declined automatically</Badge>}
            {r.submittedVia === 'MANUAL' && <Badge variant="outline">Entered by an administrator</Badge>}
            <Badge variant={r.status === 'APPROVED' ? 'secondary' : r.status === 'PENDING' ? 'default' : 'outline'}>{STATUS_SHORT[r.status]}</Badge>
          </div>
        </div>
        <p className="text-sm"><span className="text-muted-foreground">Cost:</span> {requestCost(r)} <span className="text-muted-foreground">· {r.academicYearLabel}</span></p>
        <p className="text-sm"><span className="text-muted-foreground">Reason:</span> {r.reason}</p>
        {line && <p className="text-sm text-muted-foreground">{line}</p>}
        {r.status === 'PENDING' && wait > 0 && (
          <p className="flex items-center gap-1 text-xs text-muted-foreground"><Clock className="h-3 w-3" />Waiting {wait} day{wait === 1 ? '' : 's'}</p>
        )}
        {(r.status === 'PENDING' || canCancel(r)) && (
          <div className="flex flex-wrap items-center gap-2 pt-1">
            {r.status === 'PENDING' && (
              <>
                <Button size="sm" disabled={!isDirector} onClick={() => onAct('approve')}><Check className="mr-1.5 h-4 w-4" />Approve</Button>
                <Button size="sm" variant="outline" disabled={!isDirector} onClick={() => onAct('reject')}><X className="mr-1.5 h-4 w-4" />Do not approve</Button>
              </>
            )}
            {canCancel(r) && <Button size="sm" variant="ghost" onClick={() => onAct('cancel')}>Cancel leave</Button>}
            {r.status === 'PENDING' && !isDirector && <span className="text-xs text-muted-foreground">Only the Director can approve or reject.</span>}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function LeaveRequestsPage() {
  const me = useMe();
  const years = useAcademicYears();
  const [tab, setTab] = useState<Tab>('PENDING');
  const [yearId, setYearId] = useState<number | null | 'init'>('init');
  const [acting, setActing] = useState<{ request: LeaveRequest; mode: DecisionMode } | null>(null);
  const [entering, setEntering] = useState(false);
  const [kind, setKind] = useState<'LEAVE' | 'PERMISSION'>('LEAVE');

  useEffect(() => {
    if (yearId === 'init' && years.data) setYearId(years.data.length > 0 ? defaultYearId(years.data) : null);
  }, [years.data, yearId]);

  const list = useLeaveRequests(tab, yearId === 'init' ? null : yearId);

  if (me.isLoading || years.isLoading) return <div className="space-y-6"><Skeleton className="h-10 w-64" /><Skeleton className="h-48 w-full" /></div>;
  if (me.isError) return <AccessMessage error={me.error} />;
  if (years.isError) return <AccessMessage error={years.error} />;

  const isDirector = me.data?.role === 'DIRECTOR';
  const counts = list.data?.counts;
  const label = (t: Tab) => (t === 'ALL' ? 'All' : STATUS_SHORT[t]) + (counts && t !== 'ALL' ? ` (${counts[t]})` : '');

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Leave and permission requests</h1>
          <p className="text-sm text-muted-foreground">Only the Director approves or rejects. Requests also reach the Director on WhatsApp.</p>
        </div>
        {kind === 'LEAVE' && <Button variant="outline" onClick={() => setEntering(true)}><Plus className="mr-2 h-4 w-4" />Enter leave for an employee</Button>}
      </div>

      <Tabs value={kind} onValueChange={v => setKind(v as 'LEAVE' | 'PERMISSION')}>
        <TabsList><TabsTrigger value="LEAVE">Leave</TabsTrigger><TabsTrigger value="PERMISSION">Permission</TabsTrigger></TabsList>
      </Tabs>

      {kind === 'PERMISSION' ? <PermissionRequestsPanel isDirector={isDirector} /> : (<>

      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm font-medium">Academic year</span>
        <Select value={yearId === 'init' || yearId === null ? ALL_YEARS : String(yearId)} onValueChange={v => setYearId(v === ALL_YEARS ? null : Number(v))}>
          <SelectTrigger className="w-48" aria-label="Academic year"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_YEARS}>All years</SelectItem>
            {(years.data ?? []).map(y => <SelectItem key={y.id} value={String(y.id)}>{y.label}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      <Tabs value={tab} onValueChange={v => setTab(v as Tab)}>
        <TabsList className="flex-wrap h-auto">{TABS.map(t => <TabsTrigger key={t} value={t}>{label(t)}</TabsTrigger>)}</TabsList>
      </Tabs>

      {list.isLoading && <Skeleton className="h-40 w-full" />}
      {list.isError && <Alert variant="destructive"><AlertDescription>{errorText(list.error)}</AlertDescription></Alert>}
      {list.data && (list.data.requests.length === 0 ? (
        <Alert>
          <CalendarPlus className="h-4 w-4" />
          <AlertDescription>{tab === 'PENDING' ? 'No leave requests are waiting for a decision.' : 'Nothing to show here.'}</AlertDescription>
        </Alert>
      ) : (
        <div className="space-y-3">
          {list.data.requests.map(r => <RequestCard key={r.id} r={r} isDirector={isDirector} onAct={mode => setActing({ request: r, mode })} />)}
        </div>
      ))}

      {acting && <DecisionDialog key={`${acting.request.id}:${acting.mode}`} request={acting.request} mode={acting.mode} onClose={() => setActing(null)} />}
      {entering && <EntryDialog onClose={() => setEntering(false)} />}
      </>)}
    </div>
  );
}
