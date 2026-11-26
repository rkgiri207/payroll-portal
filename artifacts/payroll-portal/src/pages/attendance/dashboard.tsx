import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, RefreshCw } from 'lucide-react';
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
  AlertProblems, ExceptionsList, FeedList, PendingList, UnmarkedList,
} from './dashboard-lists';
import { formatDay, formatTime, newEventIds } from './dashboard-helpers';
import { AccessMessage } from './setup';
import { keys, useMe } from './use-attendance';

type Tab = 'feed' | 'unmarked' | 'exceptions' | 'review' | 'alerts';

function Tile(props: { label: string; value: number; hint?: string; tone?: 'warn' | 'bad'; onClick?: () => void }) {
  const { label, value, hint, tone, onClick } = props;
  const body = (
    <>
      <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className={cn('mt-1 text-3xl font-bold tabular-nums', tone === 'warn' && value > 0 && 'text-amber-600 dark:text-amber-400', tone === 'bad' && value > 0 && 'text-destructive')}>{value}</span>
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </>
  );
  const classes = 'flex flex-col items-start rounded-lg border bg-card p-4 text-left';
  return onClick
    ? <button type="button" onClick={onClick} className={cn(classes, 'transition-colors hover:bg-accent')} data-testid={`tile-${label.toLowerCase().replace(/\s+/g, '-')}`}>{body}</button>
    : <div className={classes} data-testid={`tile-${label.toLowerCase().replace(/\s+/g, '-')}`}>{body}</div>;
}

/** The dashboard body, given data. Separate from the page so it can be tested without a network. */
export function DashboardView(props: { data: Dashboard; fresh: Set<string>; tab: Tab; onTab(tab: Tab): void }) {
  const { data, fresh, tab, onTab } = props;
  const s = data.summary;
  const failed = data.alertProblems.filter(p => p.status === 'FAILED').length;

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

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Tile label="Expected" value={s.expected} hint="should check in today" />
        <Tile label="Present" value={s.present} hint="checked in" />
        <Tile label="Late" value={s.late} tone="warn" />
        <Tile label="Unmarked" value={s.unmarked} tone="warn" hint="no check-in yet" onClick={() => onTab('unmarked')} />
        <Tile label="Needs review" value={s.pendingReview} tone="warn" onClick={() => onTab('review')} />
        <Tile label="Open exceptions" value={s.openExceptions} tone="bad" onClick={() => onTab('exceptions')} />
      </div>

      {data.campuses.length > 0 && (
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-lg">By campus</CardTitle></CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow><TableHead>Campus</TableHead><TableHead className="text-right">Expected</TableHead><TableHead className="text-right">Present</TableHead><TableHead className="text-right">Late</TableHead><TableHead className="text-right">Unmarked</TableHead></TableRow>
                </TableHeader>
                <TableBody>
                  {data.campuses.map(c => (
                    <TableRow key={c.campusId} data-testid="campus-row">
                      <TableCell className="font-medium">{c.campusName}</TableCell>
                      <TableCell className="text-right tabular-nums">{c.expected}</TableCell>
                      <TableCell className="text-right tabular-nums">{c.present}</TableCell>
                      <TableCell className="text-right tabular-nums">{c.late}</TableCell>
                      <TableCell className="text-right tabular-nums">{c.unmarked}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}

      <Tabs value={tab} onValueChange={v => onTab(v as Tab)}>
        <TabsList className="h-auto w-full flex-wrap justify-start sm:w-auto">
          <TabsTrigger value="feed">Live feed</TabsTrigger>
          <TabsTrigger value="unmarked">Unmarked ({s.unmarked})</TabsTrigger>
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
