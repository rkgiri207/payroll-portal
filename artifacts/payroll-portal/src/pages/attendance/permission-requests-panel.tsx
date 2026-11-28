import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Check, Clock, X } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import { adminPost } from './api';
import type { LeaveStatus } from './leave-requests-api';
import { permissionDecisionLine, permissionWhen } from './permission-helpers';
import { permissionKeys, usePermissionRequests, type PermissionRequest } from './permission-requests-api';
import { STATUS_SHORT, waitingDays } from './request-helpers';
import { errorText, useRefresh } from './use-attendance';

type Tab = LeaveStatus | 'ALL';
const TABS: Tab[] = ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'ALL'];
type Mode = 'approve' | 'reject' | 'cancel';

function DecisionDialog({ request, mode, onClose }: { request: PermissionRequest; mode: Mode; onClose(): void }) {
  const { toast } = useToast();
  const refresh = useRefresh();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const reasonRequired = mode === 'reject' || (mode === 'cancel' && request.status === 'APPROVED');

  const run = useMutation({
    mutationFn: () => adminPost<{ message: string }>(`/leave/permissions/${request.id}/${mode}`, mode === 'approve' ? {} : { reason }),
    onSuccess: r => {
      refresh(permissionKeys.all);
      toast({ title: mode === 'approve' ? 'Permission approved' : mode === 'reject' ? 'Permission not approved' : 'Permission cancelled', description: r.message });
      onClose();
    },
    onError: e => setError(errorText(e)),
  });

  return (
    <Dialog open onOpenChange={o => { if (!o) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{mode === 'approve' ? 'Approve' : mode === 'reject' ? 'Do not approve' : 'Cancel'} permission for {request.employeeName}?</DialogTitle>
          <DialogDescription>{permissionWhen(request)} · {request.campusName}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <p><span className="text-muted-foreground">Reason given:</span> {request.reason}</p>
          {mode === 'approve' && <p className="text-muted-foreground">A permission uses no leave balance.</p>}
          {mode !== 'approve' && (
            <div className="space-y-1.5">
              <Label htmlFor="perm-reason">{mode === 'reject' ? 'Reason (the employee will see this)' : reasonRequired ? 'Reason for cancelling' : 'Reason (optional)'}</Label>
              <Textarea id="perm-reason" rows={3} maxLength={500} value={reason} onChange={e => setReason(e.target.value)} />
            </div>
          )}
          {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Back</Button>
          <Button variant={mode === 'approve' ? 'default' : 'destructive'} disabled={run.isPending || (reasonRequired && reason.trim() === '')} onClick={() => { setError(null); run.mutate(); }}>
            {run.isPending ? 'Saving…' : mode === 'approve' ? 'Approve' : mode === 'reject' ? 'Do not approve' : 'Cancel the permission'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function PermissionCard({ r, isDirector, onAct }: { r: PermissionRequest; isDirector: boolean; onAct(mode: Mode): void }) {
  const wait = r.status === 'PENDING' ? waitingDays(r.submittedAt) : 0;
  const line = permissionDecisionLine(r);
  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <p className="font-medium">{r.employeeName} <span className="text-sm font-normal text-muted-foreground">({r.employeeCode}) · {r.campusName}</span></p>
            <p className="text-sm">{permissionWhen(r)}</p>
          </div>
          <Badge variant={r.status === 'APPROVED' ? 'secondary' : r.status === 'PENDING' ? 'default' : 'outline'}>{STATUS_SHORT[r.status]}</Badge>
        </div>
        <p className="text-sm"><span className="text-muted-foreground">Reason:</span> {r.reason}</p>
        {line && <p className="text-sm text-muted-foreground">{line}</p>}
        {r.status === 'PENDING' && wait > 0 && <p className="flex items-center gap-1 text-xs text-muted-foreground"><Clock className="h-3 w-3" />Waiting {wait} day{wait === 1 ? '' : 's'}</p>}
        {(r.status === 'PENDING' || r.status === 'APPROVED') && (
          <div className="flex flex-wrap items-center gap-2 pt-1">
            {r.status === 'PENDING' && (
              <>
                <Button size="sm" disabled={!isDirector} onClick={() => onAct('approve')}><Check className="mr-1.5 h-4 w-4" />Approve</Button>
                <Button size="sm" variant="outline" disabled={!isDirector} onClick={() => onAct('reject')}><X className="mr-1.5 h-4 w-4" />Do not approve</Button>
              </>
            )}
            <Button size="sm" variant="ghost" onClick={() => onAct('cancel')}>Cancel permission</Button>
            {r.status === 'PENDING' && !isDirector && <span className="text-xs text-muted-foreground">Only the Director can approve or reject.</span>}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function PermissionRequestsPanel({ isDirector }: { isDirector: boolean }) {
  const [tab, setTab] = useState<Tab>('PENDING');
  const [acting, setActing] = useState<{ request: PermissionRequest; mode: Mode } | null>(null);
  const list = usePermissionRequests(tab);
  const counts = list.data?.counts;
  const label = (t: Tab) => (t === 'ALL' ? 'All' : STATUS_SHORT[t]) + (counts && t !== 'ALL' ? ` (${counts[t]})` : '');

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">Short absences within a working day. They use no leave balance, and only the Director approves or rejects them.</p>
      <Tabs value={tab} onValueChange={v => setTab(v as Tab)}>
        <TabsList className="flex-wrap h-auto">{TABS.map(t => <TabsTrigger key={t} value={t}>{label(t)}</TabsTrigger>)}</TabsList>
      </Tabs>
      {list.isLoading && <Skeleton className="h-40 w-full" />}
      {list.isError && <Alert variant="destructive"><AlertDescription>{errorText(list.error)}</AlertDescription></Alert>}
      {list.data && (list.data.permissions.length === 0 ? (
        <Alert><AlertDescription>{tab === 'PENDING' ? 'No permission requests are waiting for a decision.' : 'Nothing to show here.'}</AlertDescription></Alert>
      ) : (
        <div className="space-y-3">{list.data.permissions.map(r => <PermissionCard key={r.id} r={r} isDirector={isDirector} onAct={mode => setActing({ request: r, mode })} />)}</div>
      ))}
      {acting && <DecisionDialog key={`${acting.request.id}:${acting.mode}`} request={acting.request} mode={acting.mode} onClose={() => setActing(null)} />}
    </div>
  );
}
