import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import { adminDelete, adminGet, adminPost, describeWeekdays, shiftStatuses, todayIst, WEEKDAYS, type Campus, type Shift } from './api';
import { errorText, keys, settingValue, useCampuses, useRefresh, useSettings } from './use-attendance';

const PRESETS = [
  { label: 'Mon–Fri', days: [1, 2, 3, 4, 5] },
  { label: 'Mon–Sat', days: [1, 2, 3, 4, 5, 6] },
];

function ShiftDialog(props: { campus: Campus; defaultGrace: number; onClose(): void }) {
  const { campus, defaultGrace, onClose } = props;
  const { toast } = useToast();
  const refresh = useRefresh();
  const [loginTime, setLoginTime] = useState('09:00');
  const [logoutTime, setLogoutTime] = useState('16:00');
  const [grace, setGrace] = useState(String(defaultGrace));
  const [days, setDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [from, setFrom] = useState(todayIst());
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () => adminPost(`/campuses/${campus.id}/shifts`, {
      loginTime, logoutTime, graceMinutes: grace, weekdays: days, effectiveFrom: from,
    }),
    onSuccess: () => {
      refresh(keys.shifts(campus.id), keys.campuses);
      toast({ title: 'Shift added' });
      onClose();
    },
    onError: e => setError(errorText(e)),
  });

  const toggle = (day: number) => setDays(d => (d.includes(day) ? d.filter(x => x !== day) : [...d, day]));

  return (
    <Dialog open onOpenChange={o => { if (!o) onClose(); }}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add a shift for {campus.name}</DialogTitle>
          <DialogDescription>
            A shift applies from its start date. Changing a shift never changes attendance that is already recorded.
          </DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={e => { e.preventDefault(); setError(null); save.mutate(); }}>
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="shift-in">Login time</Label>
              <Input id="shift-in" type="time" value={loginTime} onChange={e => setLoginTime(e.target.value)} required />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="shift-out">Logout time</Label>
              <Input id="shift-out" type="time" value={logoutTime} onChange={e => setLogoutTime(e.target.value)} required />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="shift-grace">Grace (minutes)</Label>
              <Input id="shift-grace" inputMode="numeric" value={grace} onChange={e => setGrace(e.target.value)} />
            </div>
          </div>
          <p className="-mt-2 text-xs text-muted-foreground">
            On time means up to login time plus grace. With 09:00 and 10 minutes, 9:10 is on time and 9:11 is late.
          </p>

          <div className="space-y-2">
            <Label>Working days</Label>
            <div className="flex flex-wrap gap-2" role="group" aria-label="Working days">
              {WEEKDAYS.map(d => (
                <button
                  key={d.value} type="button" onClick={() => toggle(d.value)} aria-pressed={days.includes(d.value)}
                  className={cn('h-10 min-w-12 rounded-md border px-3 text-sm font-medium transition-colors',
                    days.includes(d.value) ? 'border-primary bg-primary text-primary-foreground' : 'hover:bg-accent')}
                >{d.short}</button>
              ))}
            </div>
            <div className="flex gap-2">
              {PRESETS.map(p => <Button key={p.label} type="button" variant="outline" size="sm" onClick={() => setDays(p.days)}>{p.label}</Button>)}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="shift-from">Starts on</Label>
            <Input id="shift-from" type="date" value={from} onChange={e => setFrom(e.target.value)} required />
          </div>

          {error && <Alert variant="destructive" role="alert"><AlertDescription>{error}</AlertDescription></Alert>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={save.isPending}>{save.isPending ? 'Saving…' : 'Add shift'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function ShiftsTab() {
  const { toast } = useToast();
  const refresh = useRefresh();
  const campuses = useCampuses();
  const settings = useSettings();
  const [campusId, setCampusId] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const [toDelete, setToDelete] = useState<Shift | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  useEffect(() => {
    if (campusId === null && campuses.data && campuses.data.length > 0) setCampusId(campuses.data[0].id);
  }, [campuses.data, campusId]);

  const campus = campuses.data?.find(c => c.id === campusId) ?? null;
  const shifts = useQuery({
    queryKey: keys.shifts(campusId ?? 0),
    queryFn: () => adminGet<{ shifts: Shift[]; today: string }>(`/campuses/${campusId}/shifts`),
    enabled: campusId !== null, retry: false,
  });
  const statuses = useMemo(() => shiftStatuses(shifts.data?.shifts ?? [], shifts.data?.today ?? todayIst()), [shifts.data]);
  const defaultGrace = settingValue(settings.data, 'default_grace_minutes', 10);

  const remove = useMutation({
    mutationFn: (shift: Shift) => adminDelete(`/shifts/${shift.id}`),
    onSuccess: () => { refresh(keys.shifts(campusId ?? 0), keys.campuses); toast({ title: 'Shift removed' }); setToDelete(null); },
    onError: e => setDeleteError(errorText(e)),
  });

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-4 space-y-0">
        <div>
          <CardTitle className="text-lg">Shifts</CardTitle>
          <CardDescription>Login and logout times, grace and working days, set separately for each campus.</CardDescription>
        </div>
        <Button onClick={() => setAdding(true)} disabled={!campus}><Plus className="mr-2 h-4 w-4" />Add shift</Button>
      </CardHeader>
      <CardContent className="space-y-4">
        {campuses.isLoading ? <Skeleton className="h-32 w-full" /> : (campuses.data?.length ?? 0) === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">Add a campus first (Campuses tab), then set its shift here.</p>
        ) : (
          <>
            <div className="max-w-xs space-y-1.5">
              <Label>Campus</Label>
              <Select value={campusId === null ? undefined : String(campusId)} onValueChange={v => setCampusId(Number(v))}>
                <SelectTrigger aria-label="Campus"><SelectValue placeholder="Choose a campus" /></SelectTrigger>
                <SelectContent>
                  {campuses.data!.map(c => <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>

            {shifts.isLoading ? <Skeleton className="h-24 w-full" /> : shifts.isError ? (
              <Alert variant="destructive"><AlertDescription>{errorText(shifts.error)}</AlertDescription></Alert>
            ) : (shifts.data?.shifts.length ?? 0) === 0 ? (
              <Alert><AlertDescription>
                {campus?.name} has no shift yet. Until one is added, check-ins are recorded as &quot;no shift&quot; and flagged for review, never as late.
              </AlertDescription></Alert>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Starts on</TableHead><TableHead>Login</TableHead><TableHead>Logout</TableHead>
                      <TableHead>Grace</TableHead><TableHead>Days</TableHead><TableHead>Status</TableHead><TableHead className="w-12" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {shifts.data!.shifts.map(s => (
                      <TableRow key={s.id}>
                        <TableCell>{s.effectiveFrom}</TableCell>
                        <TableCell>{s.loginTime}</TableCell>
                        <TableCell>{s.logoutTime}</TableCell>
                        <TableCell>{s.graceMinutes} min</TableCell>
                        <TableCell>{describeWeekdays(s.weekdays)}</TableCell>
                        <TableCell>
                          {statuses[s.id] === 'CURRENT' ? <Badge>In use</Badge>
                            : statuses[s.id] === 'UPCOMING' ? <Badge variant="outline">Upcoming</Badge>
                              : <Badge variant="secondary">Replaced</Badge>}
                        </TableCell>
                        <TableCell>
                          {statuses[s.id] === 'UPCOMING' && (
                            <Button variant="ghost" size="icon" aria-label="Remove this upcoming shift" onClick={() => { setDeleteError(null); setToDelete(s); }}>
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              To change a shift, add a new one with a later start date. Shifts that have started are kept as history and cannot be edited.
            </p>
          </>
        )}
      </CardContent>

      {adding && campus && <ShiftDialog campus={campus} defaultGrace={defaultGrace} onClose={() => setAdding(false)} />}

      <AlertDialog open={toDelete !== null} onOpenChange={o => { if (!o) setToDelete(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this upcoming shift?</AlertDialogTitle>
            <AlertDialogDescription>
              The shift starting {toDelete?.effectiveFrom} has not begun yet, so removing it changes no recorded attendance.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleteError && <Alert variant="destructive"><AlertDescription>{deleteError}</AlertDescription></Alert>}
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction onClick={e => { e.preventDefault(); if (toDelete) remove.mutate(toDelete); }} disabled={remove.isPending}>
              {remove.isPending ? 'Removing…' : 'Remove shift'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
