import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Camera, Check, X } from 'lucide-react';
import { Link } from 'wouter';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import { adminGet, adminPatch, type AlertProblem, type ExceptionRow, type FeedEvent, type OnLeaveItem, type PermissionToday, type UnmarkedEmployee } from './api';
import { dayMonth, permissionActive, permissionRange } from './dashboard-stats';
import {
  alertKindLabel, describeAlert, describeEvent, describeGps, describeReview, exceptionLabel, formatDay, formatTime,
  timeAgo, type Label as ToneLabel,
} from './dashboard-helpers';
import { SelfieDialog } from './selfie-dialog';
import { errorText, keys, useRefresh } from './use-attendance';

export function ToneBadge({ label }: { label: ToneLabel }) {
  if (label.tone === 'bad') return <Badge variant="destructive">{label.text}</Badge>;
  if (label.tone === 'good') return <Badge>{label.text}</Badge>;
  if (label.tone === 'warn') return <Badge variant="outline" className="border-amber-500 text-amber-700 dark:text-amber-400">{label.text}</Badge>;
  return <Badge variant="secondary">{label.text}</Badge>;
}

export const EmployeeLink = ({ id, name, code }: { id: number; name: string; code: string }) => (
  <div>
    <Link href={`/attendance/employees/${id}`} className="font-medium text-primary underline-offset-4 hover:underline">{name}</Link>
    <div className="text-xs text-muted-foreground">{code}</div>
  </div>
);

const Empty = ({ children }: { children: string }) => <p className="py-10 text-center text-sm text-muted-foreground">{children}</p>;

// ── Live feed ─────────────────────────────────────────────────────────────────
export function FeedList(props: { events: FeedEvent[]; fresh?: Set<string>; showSelfie?: boolean; empty?: string }) {
  const { events, fresh, showSelfie = true, empty = 'No attendance recorded yet today.' } = props;
  const [viewing, setViewing] = useState<FeedEvent | null>(null);
  if (events.length === 0) return <Empty>{empty}</Empty>;
  return (
    <>
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Time</TableHead><TableHead>Employee</TableHead><TableHead>Campus</TableHead><TableHead>What</TableHead>
              <TableHead>Location</TableHead><TableHead>Director alert</TableHead><TableHead>Review</TableHead>
              {showSelfie && <TableHead className="w-12"><span className="sr-only">Selfie</span></TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {events.map(e => (
              <TableRow key={e.id} className={cn(fresh?.has(e.id) && 'bg-primary/10 transition-colors')} data-testid="feed-row">
                <TableCell className="whitespace-nowrap">
                  <div className="font-medium tabular-nums">{formatTime(e.serverTs)}</div>
                  <div className="text-xs text-muted-foreground">{timeAgo(e.serverTs)}</div>
                </TableCell>
                <TableCell><EmployeeLink id={e.employeeId} name={e.employeeName} code={e.employeeCode} /></TableCell>
                <TableCell>{e.campusName}</TableCell>
                <TableCell>
                  <Badge variant={e.eventType === 'IN' ? 'default' : 'secondary'} className="mr-2">{e.eventType}</Badge>
                  <ToneBadge label={describeEvent(e)} />
                </TableCell>
                <TableCell><ToneBadge label={describeGps(e)} /></TableCell>
                <TableCell><ToneBadge label={describeAlert(e.directorAlert)} /></TableCell>
                <TableCell><ToneBadge label={describeReview(e.reviewStatus)} /></TableCell>
                {showSelfie && (
                  <TableCell>
                    {e.hasSelfie && (
                      <Button variant="ghost" size="icon" aria-label={`View selfie of ${e.employeeName}`} onClick={() => setViewing(e)}>
                        <Camera className="h-4 w-4" />
                      </Button>
                    )}
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {viewing && <SelfieDialog eventId={viewing.id} title={`${viewing.employeeName} · ${viewing.eventType} ${formatTime(viewing.serverTs)}`} onClose={() => setViewing(null)} />}
    </>
  );
}

// ── Unmarked ──────────────────────────────────────────────────────────────────
export function UnmarkedList() {
  const list = useQuery({
    queryKey: keys.unmarked,
    queryFn: () => adminGet<{ workDate: string; unmarked: UnmarkedEmployee[] }>('/unmarked'),
    refetchInterval: 20_000, refetchIntervalInBackground: false, retry: false,
  });
  if (list.isLoading) return <Skeleton className="h-32 w-full" />;
  if (list.isError) return <Alert variant="destructive"><AlertDescription>{errorText(list.error)}</AlertDescription></Alert>;
  const rows = list.data?.unmarked ?? [];
  if (rows.length === 0) return <Empty>Nobody is unmarked. Everyone expected today has checked in.</Empty>;
  return (
    <>
      <p className="mb-3 text-sm text-muted-foreground">
        Expected today but no check-in yet. This is not an absence: nobody is ever marked absent automatically.
      </p>
      <div className="overflow-x-auto">
        <Table>
          <TableHeader><TableRow><TableHead>Employee</TableHead><TableHead>Campus</TableHead></TableRow></TableHeader>
          <TableBody>
            {rows.map(r => (
              <TableRow key={r.employeeId} data-testid="unmarked-row">
                <TableCell><EmployeeLink id={r.employeeId} name={r.employeeName} code={r.employeeCode} /></TableCell>
                <TableCell>{r.campusName}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </>
  );
}

// ── Exceptions ────────────────────────────────────────────────────────────────
function ExceptionDialog({ exception, onClose }: { exception: ExceptionRow; onClose(): void }) {
  const { toast } = useToast();
  const refresh = useRefresh();
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const act = useMutation({
    mutationFn: (status: 'REVIEWED' | 'RESOLVED') => adminPatch(`/exceptions/${exception.id}`, { status, note }),
    onSuccess: () => { refresh(keys.exceptions, keys.dashboard); toast({ title: 'Exception updated' }); onClose(); },
    onError: e => setError(errorText(e)),
  });
  return (
    <Dialog open onOpenChange={o => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{exceptionLabel(exception.kind)}</DialogTitle>
          <DialogDescription>{exception.employeeName} · {formatDay(exception.workDate)}{exception.campusName ? ` · ${exception.campusName}` : ''}</DialogDescription>
        </DialogHeader>
        {exception.detail && <p className="text-sm">{exception.detail}</p>}
        <div className="space-y-1.5">
          <Label htmlFor="exception-note">Note (optional)</Label>
          <Textarea id="exception-note" value={note} onChange={e => setNote(e.target.value)} maxLength={300} placeholder="What did you find or do?" />
        </div>
        {error && <Alert variant="destructive" role="alert"><AlertDescription>{error}</AlertDescription></Alert>}
        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={() => act.mutate('REVIEWED')} disabled={act.isPending}>Mark reviewed</Button>
          <Button onClick={() => act.mutate('RESOLVED')} disabled={act.isPending}>Mark resolved</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ExceptionsList() {
  const [selected, setSelected] = useState<ExceptionRow | null>(null);
  const list = useQuery({
    queryKey: keys.exceptions,
    queryFn: () => adminGet<{ exceptions: ExceptionRow[] }>('/exceptions?status=OPEN'),
    refetchInterval: 20_000, refetchIntervalInBackground: false, retry: false,
  });
  if (list.isLoading) return <Skeleton className="h-32 w-full" />;
  if (list.isError) return <Alert variant="destructive"><AlertDescription>{errorText(list.error)}</AlertDescription></Alert>;
  const rows = list.data?.exceptions ?? [];
  if (rows.length === 0) return <Empty>No open exceptions.</Empty>;
  return (
    <>
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow><TableHead>Employee</TableHead><TableHead>Issue</TableHead><TableHead>Day</TableHead><TableHead>Campus</TableHead><TableHead className="w-28" /></TableRow>
          </TableHeader>
          <TableBody>
            {rows.map(x => (
              <TableRow key={x.id} data-testid="exception-row">
                <TableCell><EmployeeLink id={x.employeeId} name={x.employeeName} code={x.employeeCode} /></TableCell>
                <TableCell>
                  <div>{exceptionLabel(x.kind)}</div>
                  {x.detail && <div className="max-w-xs text-xs text-muted-foreground">{x.detail}</div>}
                </TableCell>
                <TableCell className="whitespace-nowrap">{formatDay(x.workDate)}</TableCell>
                <TableCell>{x.campusName ?? '—'}</TableCell>
                <TableCell><Button size="sm" variant="outline" onClick={() => setSelected(x)}>Review</Button></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {selected && <ExceptionDialog key={selected.id} exception={selected} onClose={() => setSelected(null)} />}
    </>
  );
}

// ── Pending review ────────────────────────────────────────────────────────────
function RejectDialog({ event, onClose }: { event: FeedEvent; onClose(): void }) {
  const { toast } = useToast();
  const refresh = useRefresh();
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const reject = useMutation({
    mutationFn: () => adminPatch(`/events/${event.id}/review`, { status: 'REJECTED', note }),
    onSuccess: () => { refresh(keys.pending, keys.dashboard); toast({ title: 'Marked as rejected' }); onClose(); },
    onError: e => setError(errorText(e)),
  });
  return (
    <Dialog open onOpenChange={o => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Reject this record?</DialogTitle>
          <DialogDescription>
            {event.employeeName} · {event.eventType} at {formatTime(event.serverTs)}. The record is kept and marked rejected; it is not deleted.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="reject-note">Reason (required)</Label>
          <Textarea id="reject-note" value={note} onChange={e => setNote(e.target.value)} maxLength={300} />
        </div>
        {error && <Alert variant="destructive" role="alert"><AlertDescription>{error}</AlertDescription></Alert>}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button variant="destructive" onClick={() => reject.mutate()} disabled={reject.isPending || !note.trim()}>Reject</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function PendingList() {
  const { toast } = useToast();
  const refresh = useRefresh();
  const [rejecting, setRejecting] = useState<FeedEvent | null>(null);
  const [viewing, setViewing] = useState<FeedEvent | null>(null);
  const list = useQuery({
    queryKey: keys.pending,
    queryFn: () => adminGet<{ events: FeedEvent[] }>('/reviews/pending'),
    refetchInterval: 20_000, refetchIntervalInBackground: false, retry: false,
  });
  const approve = useMutation({
    mutationFn: (id: string) => adminPatch(`/events/${id}/review`, { status: 'APPROVED' }),
    onSuccess: () => { refresh(keys.pending, keys.dashboard); toast({ title: 'Approved' }); },
    onError: e => toast({ title: 'Could not approve', description: errorText(e), variant: 'destructive' }),
  });

  if (list.isLoading) return <Skeleton className="h-32 w-full" />;
  if (list.isError) return <Alert variant="destructive"><AlertDescription>{errorText(list.error)}</AlertDescription></Alert>;
  const rows = list.data?.events ?? [];
  if (rows.length === 0) return <Empty>Nothing is waiting for review.</Empty>;
  return (
    <>
      <p className="mb-3 text-sm text-muted-foreground">Recent check-ins and check-outs (last 14 days) not yet reviewed. Selfies are for review only.</p>
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow><TableHead>When</TableHead><TableHead>Employee</TableHead><TableHead>Campus</TableHead><TableHead>What</TableHead><TableHead>Location</TableHead><TableHead className="w-56" /></TableRow>
          </TableHeader>
          <TableBody>
            {rows.map(e => (
              <TableRow key={e.id} data-testid="pending-row">
                <TableCell className="whitespace-nowrap">
                  <div className="tabular-nums">{formatTime(e.serverTs)}</div>
                  <div className="text-xs text-muted-foreground">{timeAgo(e.serverTs)}</div>
                </TableCell>
                <TableCell><EmployeeLink id={e.employeeId} name={e.employeeName} code={e.employeeCode} /></TableCell>
                <TableCell>{e.campusName}</TableCell>
                <TableCell><Badge variant={e.eventType === 'IN' ? 'default' : 'secondary'} className="mr-2">{e.eventType}</Badge><ToneBadge label={describeEvent(e)} /></TableCell>
                <TableCell><ToneBadge label={describeGps(e)} /></TableCell>
                <TableCell>
                  <div className="flex items-center gap-1">
                    {e.hasSelfie && <Button variant="ghost" size="icon" aria-label={`View selfie of ${e.employeeName}`} onClick={() => setViewing(e)}><Camera className="h-4 w-4" /></Button>}
                    <Button size="sm" variant="outline" onClick={() => approve.mutate(e.id)} disabled={approve.isPending}><Check className="mr-1 h-4 w-4" />Approve</Button>
                    <Button size="sm" variant="outline" onClick={() => setRejecting(e)}><X className="mr-1 h-4 w-4" />Reject</Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {rejecting && <RejectDialog key={rejecting.id} event={rejecting} onClose={() => setRejecting(null)} />}
      {viewing && <SelfieDialog eventId={viewing.id} title={`${viewing.employeeName} · ${viewing.eventType} ${formatTime(viewing.serverTs)}`} onClose={() => setViewing(null)} />}
    </>
  );
}

// ── Alert problems ────────────────────────────────────────────────────────────
export function AlertProblems({ items }: { items: AlertProblem[] }) {
  if (items.length === 0) return <Empty>No WhatsApp alert problems.</Empty>;
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow><TableHead>When</TableHead><TableHead>Message</TableHead><TableHead>To</TableHead><TableHead>Status</TableHead><TableHead>Detail</TableHead></TableRow>
        </TableHeader>
        <TableBody>
          {items.map(p => (
            <TableRow key={p.id} data-testid="alert-problem-row">
              <TableCell className="whitespace-nowrap">{formatTime(p.createdAt)}<div className="text-xs text-muted-foreground">{timeAgo(p.createdAt)}</div></TableCell>
              <TableCell>{alertKindLabel(p.kind)}{p.employeeName ? <div className="text-xs text-muted-foreground">{p.employeeName}</div> : null}</TableCell>
              <TableCell>{p.recipientType === 'DIRECTOR' ? 'Director' : 'Employee'}</TableCell>
              <TableCell>{p.status === 'FAILED' ? <Badge variant="destructive">Failed</Badge> : <Badge variant="outline">Retrying ({p.attempts})</Badge>}</TableCell>
              <TableCell className="max-w-xs text-xs text-muted-foreground">{p.lastError ?? '—'}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

// ── Leave and permission today (data comes with the dashboard, so these need no request of their own) ──

export function OnLeaveList({ items }: { items: OnLeaveItem[] }) {
  if (items.length === 0) return <Empty>Nobody is on approved leave today.</Empty>;
  const away = items.filter(i => !i.halfDay).length;
  return (
    <>
      <p className="mb-3 text-sm text-muted-foreground">
        Approved leave for today: {away} away for the whole day{items.length > away ? `, ${items.length - away} on a half-day (still expected to check in for the rest of the day)` : ''}.
        Only decisions count; requests still waiting for the Director are not shown here.
      </p>
      <div className="overflow-x-auto">
        <Table>
          <TableHeader><TableRow><TableHead>Employee</TableHead><TableHead>Campus</TableHead><TableHead>Leave</TableHead><TableHead>Dates</TableHead></TableRow></TableHeader>
          <TableBody>
            {items.map(i => (
              <TableRow key={`${i.employeeId}:${i.startDate}`} data-testid="onleave-row">
                <TableCell>
                  <Link href={`/attendance/employees/${i.employeeId}`} className="font-medium hover:underline">{i.employeeName}</Link>
                  <span className="ml-2 text-xs text-muted-foreground">{i.employeeCode}</span>
                </TableCell>
                <TableCell>{i.campusName}</TableCell>
                <TableCell>
                  {i.leaveType}
                  {i.halfDay && <Badge variant="outline" className="ml-2">{i.dayMode === 'FIRST_HALF' ? 'First half' : 'Second half'}</Badge>}
                </TableCell>
                <TableCell className="whitespace-nowrap text-sm">
                  {i.startDate === i.endDate ? 'Today only' : `${dayMonth(i.startDate)} to ${dayMonth(i.endDate)}`}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </>
  );
}

export function PermissionsList({ items, nowMinutes }: { items: PermissionToday[]; nowMinutes: number }) {
  if (items.length === 0) return <Empty>No approved permissions today.</Empty>;
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader><TableRow><TableHead>Employee</TableHead><TableHead>Campus</TableHead><TableHead>Time</TableHead><TableHead>Reason</TableHead></TableRow></TableHeader>
        <TableBody>
          {items.map(p => (
            <TableRow key={`${p.employeeId}:${p.startTime}`} data-testid="permission-row">
              <TableCell>
                <Link href={`/attendance/employees/${p.employeeId}`} className="font-medium hover:underline">{p.employeeName}</Link>
                <span className="ml-2 text-xs text-muted-foreground">{p.employeeCode}</span>
              </TableCell>
              <TableCell>{p.campusName}</TableCell>
              <TableCell className="whitespace-nowrap">
                {permissionRange(p)}
                {permissionActive(p, nowMinutes) && <Badge className="ml-2">Away now</Badge>}
              </TableCell>
              <TableCell className="text-sm text-muted-foreground">{p.reason}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
