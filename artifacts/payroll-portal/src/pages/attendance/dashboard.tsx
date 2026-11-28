import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle, CalendarDays, Camera, CheckCircle2, ClipboardList, Clock, MessageSquareWarning, Plane, RefreshCw, Timer, UserCheck, UserX, Users,
} from 'lucide-react';
import { Link } from 'wouter';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import { adminGet, type Dashboard, type FeedEvent } from './api';
import {
  AlertProblems, ExceptionsList, FeedList, OnLeaveList, PendingList, PermissionsList, UnmarkedList,
} from './dashboard-lists';
import {
  attendanceSegments, attentionTotal, campusRate, checkInRate, istMinutes, noticeFor, permissionActive, rateTone, type Attention, type Tone,
} from './dashboard-stats';
import { Kpi, MiniBar, StatusBar, toneText, UpcomingStrip } from './dashboard-widgets';
import { formatDay, formatTime, newEventIds } from './dashboard-helpers';
import { AccessMessage } from './setup';
import { keys, useMe } from './use-attendance';

type Tab = 'feed' | 'unmarked' | 'leave' | 'exceptions' | 'review' | 'alerts';

const NOTICE_STYLE: Record<Tone, string> = {
  good: 'border-emerald-500/40 bg-emerald-500/10',
  warn: 'border-amber-500/40 bg-amber-500/10',
  bad: 'border-red-500/40 bg-red-500/10',
  info: 'border-sky-500/40 bg-sky-500/10',
  neutral: 'border-border bg-muted/40',
};

/** The dashboard body, given data. Separate from the page so it can be tested without a network. */
export function DashboardView(props: { data: Dashboard; fresh: Set<string>; tab: Tab; onTab(tab: Tab): void }) {
  const { data, fresh, tab, onTab } = props;
  const s = data.summary;
  const leave = data.leave;
  const failed = data.alertProblems.filter(p => p.status === 'FAILED').length;
  const rate = checkInRate(s);
  const { segments, total } = attendanceSegments(s);
  const notice = noticeFor(leave.notice, s);
  const attention: Attention = { leave: leave.pendingLeave, permission: leave.pendingPermission, review: s.pendingReview, exceptions: s.openExceptions, failedAlerts: failed };
  const needs = attentionTotal(attention);
  const nowMinutes = istMinutes(data.serverTime);
  const awayNow = leave.permissionsToday.filter(p => permissionActive(p, nowMinutes)).length;

  return (
    <div className="space-y-6">
      {data.warnings.length > 0 && (
        <div className="space-y-2" data-testid="warnings">
          {data.warnings.map(w => (
            <Alert key={w}>
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription>{w} <Link href="/attendance/setup" className="font-medium underline underline-offset-4">Open setup</Link></AlertDescription>
            </Alert>
          ))}
        </div>
      )}

      {notice && (
        <div className={cn('flex items-start gap-3 rounded-xl border p-4', NOTICE_STYLE[notice.tone])} data-testid="day-notice" role="status">
          <CalendarDays className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
          <div><p className="font-semibold">{notice.title}</p><p className="text-sm text-muted-foreground">{notice.body}</p></div>
        </div>
      )}

      <Card data-testid="hero">
        <CardContent className="grid gap-6 p-6 md:grid-cols-[auto_1fr] md:items-center md:gap-10">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Checked in</p>
            <p className={cn('text-6xl font-bold leading-none tabular-nums', toneText(rateTone(rate)))} data-testid="hero-rate">{rate === null ? '—' : `${rate}%`}</p>
            <p className="mt-2 text-sm text-muted-foreground">
              {rate === null ? 'Nobody is expected to check in today' : `${s.present} of ${s.expected} expected`}
            </p>
          </div>
          <StatusBar segments={segments} total={total} />
        </CardContent>
      </Card>

      <section aria-label="Today" className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Kpi label="Expected" value={s.expected} hint="should check in today" icon={Users} />
        <Kpi label="Present" value={s.present} hint="checked in" icon={UserCheck} tone="good" colourWhenAboveZero={false} />
        <Kpi label="Late" value={s.late} hint="after the grace period" icon={Clock} tone="warn" />
        <Kpi label="Unmarked" value={s.unmarked} hint="no check-in yet" icon={UserX} tone="warn" onClick={() => onTab('unmarked')} />
        <Kpi label="On leave" value={s.onLeave} hint="approved for today" icon={Plane} tone="info" colourWhenAboveZero={false} onClick={() => onTab('leave')} />
        <Kpi label="On permission" value={leave.permissionsToday.length} hint={awayNow > 0 ? `${awayNow} away right now` : 'approved for today'} icon={Timer} tone="info" colourWhenAboveZero={false} onClick={() => onTab('leave')} />
      </section>

      <section aria-label="Needs your attention" className="space-y-3">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-semibold">Needs your attention</h2>
          {needs === 0
            ? <Badge className="gap-1 bg-emerald-600 hover:bg-emerald-600" data-testid="all-clear"><CheckCircle2 className="h-3.5 w-3.5" />All clear</Badge>
            : <Badge variant="secondary" data-testid="attention-count">{needs} to look at</Badge>}
        </div>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
          <Kpi label="Leave to approve" value={leave.pendingLeave} hint="waiting for the Director" icon={ClipboardList} tone="warn" href="/leave/requests" />
          <Kpi label="Permissions to approve" value={leave.pendingPermission} hint="waiting for the Director" icon={ClipboardList} tone="warn" href="/leave/requests" />
          <Kpi label="Needs review" value={s.pendingReview} hint="selfies to check" icon={Camera} tone="warn" onClick={() => onTab('review')} />
          <Kpi label="Open exceptions" value={s.openExceptions} hint="location or link problems" icon={AlertTriangle} tone="bad" onClick={() => onTab('exceptions')} />
          <Kpi label="Failed alerts" value={failed} hint="WhatsApp not sent" icon={MessageSquareWarning} tone="bad" onClick={() => onTab('alerts')} />
        </div>
      </section>

      <div className="grid gap-6 lg:grid-cols-3">
        {data.campuses.length > 0 && (
          <Card className="lg:col-span-2">
            <CardHeader className="pb-2"><CardTitle className="text-lg">By campus</CardTitle></CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Campus</TableHead><TableHead className="text-right">Expected</TableHead><TableHead className="text-right">Present</TableHead>
                      <TableHead className="text-right">Late</TableHead><TableHead className="text-right">Unmarked</TableHead><TableHead className="text-right">On leave</TableHead>
                      <TableHead className="w-28">Checked in</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.campuses.map(c => {
                      const r = campusRate(c);
                      return (
                        <TableRow key={c.campusId} data-testid="campus-row">
                          <TableCell className="font-medium">{c.campusName}</TableCell>
                          <TableCell className="text-right tabular-nums">{c.expected}</TableCell>
                          <TableCell className="text-right tabular-nums">{c.present}</TableCell>
                          <TableCell className="text-right tabular-nums">{c.late}</TableCell>
                          <TableCell className="text-right tabular-nums">{c.unmarked}</TableCell>
                          <TableCell className="text-right tabular-nums">{c.onLeave}</TableCell>
                          <TableCell>
                            <div className="flex items-center gap-2"><MiniBar value={c.present} of={c.expected} tone={rateTone(r)} /><span className="w-9 text-xs tabular-nums text-muted-foreground">{r === null ? '—' : `${r}%`}</span></div>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        )}

        <Card className={data.campuses.length === 0 ? 'lg:col-span-3' : undefined}>
          <CardHeader className="pb-2"><CardTitle className="text-lg">Leave in the next 7 days</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <UpcomingStrip days={leave.upcoming} />
            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">On leave today</p>
              {leave.onLeave.length === 0 ? <p className="text-sm text-muted-foreground">Nobody.</p> : (
                <ul className="space-y-1.5 text-sm" data-testid="onleave-preview">
                  {leave.onLeave.slice(0, 5).map(i => (
                    <li key={`${i.employeeId}:${i.startDate}`} className="flex items-center justify-between gap-2">
                      <Link href={`/attendance/employees/${i.employeeId}`} className="truncate font-medium hover:underline">{i.employeeName}</Link>
                      <span className="shrink-0 text-xs text-muted-foreground">{i.leaveType}{i.halfDay ? ' (half-day)' : ''}</span>
                    </li>
                  ))}
                  {leave.onLeave.length > 5 && (
                    <li><button type="button" className="text-xs font-medium text-primary underline-offset-4 hover:underline" onClick={() => onTab('leave')}>and {leave.onLeave.length - 5} more</button></li>
                  )}
                </ul>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      <Tabs value={tab} onValueChange={v => onTab(v as Tab)}>
        <TabsList className="h-auto w-full flex-wrap justify-start sm:w-auto">
          <TabsTrigger value="feed">Live feed</TabsTrigger>
          <TabsTrigger value="unmarked">Unmarked ({s.unmarked})</TabsTrigger>
          <TabsTrigger value="leave">On leave ({leave.onLeave.length})</TabsTrigger>
          <TabsTrigger value="exceptions">Exceptions ({s.openExceptions})</TabsTrigger>
          <TabsTrigger value="review">Needs review ({s.pendingReview})</TabsTrigger>
          <TabsTrigger value="alerts">
            Alert problems ({data.alertProblems.length}){failed > 0 && <Badge variant="destructive" className="ml-2">{failed} failed</Badge>}
          </TabsTrigger>
        </TabsList>
        <Card className="mt-4">
          <CardContent className="pt-6">
            <TabsContent value="feed" className="mt-0"><FeedList events={data.feed} fresh={fresh} /></TabsContent>
            <TabsContent value="unmarked" className="mt-0"><UnmarkedList /></TabsContent>
            <TabsContent value="leave" className="mt-0 space-y-6">
              <OnLeaveList items={leave.onLeave} />
              <div>
                <h3 className="mb-2 text-sm font-semibold">Permission today</h3>
                <PermissionsList items={leave.permissionsToday} nowMinutes={nowMinutes} />
              </div>
            </TabsContent>
            <TabsContent value="exceptions" className="mt-0"><ExceptionsList /></TabsContent>
            <TabsContent value="review" className="mt-0"><PendingList /></TabsContent>
            <TabsContent value="alerts" className="mt-0">
              <p className="mb-3 text-sm text-muted-foreground">WhatsApp messages that failed to send, or are still being retried. They are never lost.</p>
              <AlertProblems items={data.alertProblems} />
            </TabsContent>
          </CardContent>
        </Card>
      </Tabs>
    </div>
  );
}

export default function AttendanceDashboardPage() {
  const me = useMe();
  const [tab, setTab] = useState<Tab>('feed');
  const dash = useQuery({
    queryKey: keys.dashboard,
    queryFn: () => adminGet<Dashboard>('/dashboard'),
    enabled: me.isSuccess,
    refetchInterval: 7_000,
    refetchIntervalInBackground: false,   // no polling while the tab is hidden
    retry: false,
  });

  // Highlight new arrivals for a few seconds, and announce them for screen readers.
  const previous = useRef<FeedEvent[] | undefined>(undefined);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const [announcement, setAnnouncement] = useState('');
  useEffect(() => {
    const data = dash.data;
    if (!data) return;
    const ids = newEventIds(previous.current, data.feed);
    previous.current = data.feed;
    if (ids.size === 0) return;
    setFresh(ids);
    const latest = data.feed.find(e => ids.has(e.id));
    if (latest) setAnnouncement(`${latest.employeeName} ${latest.eventType === 'IN' ? 'checked in' : 'checked out'}`);
    const timer = setTimeout(() => setFresh(new Set()), 8_000);
    return () => clearTimeout(timer);
  }, [dash.data]);

  if (me.isLoading) return <div className="space-y-6"><Skeleton className="h-10 w-64" /><Skeleton className="h-40 w-full" /></div>;
  if (me.isError) return <AccessMessage error={me.error} />;

  return (
    <div className="space-y-6" data-testid="page-attendance-dashboard">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Attendance today</h1>
          <p className="mt-1 text-muted-foreground">
            {dash.data ? formatDay(dash.data.workDate) : 'Loading…'} · updates automatically every few seconds
          </p>
        </div>
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          {dash.dataUpdatedAt > 0 && <span>Updated {formatTime(new Date(dash.dataUpdatedAt).toISOString())}</span>}
          <Button variant="outline" size="sm" onClick={() => void dash.refetch()} disabled={dash.isFetching}>
            <RefreshCw className={cn('mr-2 h-4 w-4', dash.isFetching && 'animate-spin')} />Refresh
          </Button>
        </div>
      </div>

      <p className="sr-only" aria-live="polite">{announcement}</p>

      {dash.isError && (
        <Alert variant="destructive" role="alert">
          <AlertTitle>Connection problem</AlertTitle>
          <AlertDescription>{dash.data ? 'Showing the last update. Trying again…' : 'Could not load the dashboard. Trying again…'}</AlertDescription>
        </Alert>
      )}

      {dash.isLoading ? (
        <div className="space-y-4"><Skeleton className="h-24 w-full" /><Skeleton className="h-64 w-full" /></div>
      ) : dash.data ? (
        <DashboardView data={dash.data} fresh={fresh} tab={tab} onTab={setTab} />
      ) : null}
      {dash.data && dash.data.alertMode !== 'individual' && (
        <AlertModeNote mode={dash.data.alertMode} />
      )}
    </div>
  );
}

function AlertModeNote({ mode }: { mode: string }) {
  return (
    <p className="text-xs text-muted-foreground">
      Director WhatsApp alerts are in &quot;{mode === 'digest' ? 'summary' : 'only problems'}&quot; mode. Everything still appears here.{' '}
      <Link href="/attendance/setup" className="underline underline-offset-4">Change in setup</Link>.
    </p>
  );
}
