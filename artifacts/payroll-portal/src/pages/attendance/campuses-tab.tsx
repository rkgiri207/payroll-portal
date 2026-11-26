import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { LocateFixed, Pencil, Plus } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useToast } from '@/hooks/use-toast';
import { adminPatch, adminPost, type Campus } from './api';
import { errorText, keys, settingValue, useCampuses, useRefresh, useSettings } from './use-attendance';

interface Form {
  code: string; name: string; address: string; latitude: string; longitude: string;
  radius: string; accuracy: string; isActive: boolean;
}

const emptyForm = (defaultRadius: number): Form => ({
  code: '', name: '', address: '', latitude: '', longitude: '', radius: String(defaultRadius), accuracy: '', isActive: true,
});

const fromCampus = (c: Campus): Form => ({
  code: c.code, name: c.name, address: c.address ?? '', latitude: c.latitude === null ? '' : String(c.latitude),
  longitude: c.longitude === null ? '' : String(c.longitude), radius: String(c.geofenceRadiusM),
  accuracy: c.requiredAccuracyM === null ? '' : String(c.requiredAccuracyM), isActive: c.isActive,
});

function CampusDialog(props: { campus: Campus | null; open: boolean; onClose(): void; defaultRadius: number; globalAccuracy: number }) {
  const { campus, open, onClose, defaultRadius, globalAccuracy } = props;
  const { toast } = useToast();
  const refresh = useRefresh();
  const [form, setForm] = useState<Form>(() => (campus ? fromCampus(campus) : emptyForm(defaultRadius)));
  const [error, setError] = useState<string | null>(null);
  const [locating, setLocating] = useState(false);
  const [locationNote, setLocationNote] = useState<string | null>(null);
  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm(f => ({ ...f, [key]: value }));

  const save = useMutation({
    mutationFn: () => {
      const body = {
        code: form.code, name: form.name, address: form.address,
        latitude: form.latitude, longitude: form.longitude,
        geofenceRadiusM: form.radius, requiredAccuracyM: form.accuracy, isActive: form.isActive,
      };
      return campus ? adminPatch(`/campuses/${campus.id}`, body) : adminPost('/campuses', body);
    },
    onSuccess: () => {
      refresh(keys.campuses);
      toast({ title: campus ? 'Campus updated' : 'Campus added' });
      onClose();
    },
    onError: e => setError(errorText(e)),
  });

  const useMyLocation = () => {
    setLocationNote(null);
    if (!('geolocation' in navigator)) { setLocationNote('This browser cannot read your location.'); return; }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      p => {
        set('latitude', p.coords.latitude.toFixed(6));
        set('longitude', p.coords.longitude.toFixed(6));
        const accuracy = Math.round(p.coords.accuracy);
        setLocationNote(accuracy > 20
          ? `Saved, but your device reports about ${accuracy} m accuracy. For a better result, stand at the main gate in the open and try again.`
          : `Location filled in (accuracy about ${accuracy} m).`);
        setLocating(false);
      },
      () => { setLocationNote('Could not read your location. Allow location for this site, or type the coordinates.'); setLocating(false); },
      { enableHighAccuracy: true, timeout: 20_000, maximumAge: 0 },
    );
  };

  return (
    <Dialog open={open} onOpenChange={o => { if (!o) onClose(); }}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{campus ? `Edit ${campus.name}` : 'Add a campus'}</DialogTitle>
          <DialogDescription>Employees can only mark attendance when their phone is inside the campus radius.</DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={e => { e.preventDefault(); setError(null); save.mutate(); }}>
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-1.5 sm:col-span-1">
              <Label htmlFor="campus-code">Code</Label>
              <Input id="campus-code" value={form.code} onChange={e => set('code', e.target.value)} placeholder="MAIN" maxLength={20} required />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="campus-name">Name</Label>
              <Input id="campus-name" value={form.name} onChange={e => set('name', e.target.value)} placeholder="Main Campus" maxLength={100} required />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="campus-address">Address (optional)</Label>
            <Input id="campus-address" value={form.address} onChange={e => set('address', e.target.value)} maxLength={300} />
          </div>

          <div className="space-y-2 rounded-md border p-3">
            <div className="flex items-center justify-between gap-2">
              <Label>Campus location</Label>
              <Button type="button" variant="outline" size="sm" onClick={useMyLocation} disabled={locating}>
                <LocateFixed className="mr-2 h-4 w-4" />{locating ? 'Locating…' : 'Use my current location'}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">Stand at the main gate with your phone or laptop, and tap the button. You can also type the numbers.</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="campus-lat">Latitude</Label>
                <Input id="campus-lat" inputMode="decimal" value={form.latitude} onChange={e => set('latitude', e.target.value)} placeholder="17.385044" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="campus-lng">Longitude</Label>
                <Input id="campus-lng" inputMode="decimal" value={form.longitude} onChange={e => set('longitude', e.target.value)} placeholder="78.486671" />
              </div>
            </div>
            {locationNote && <p className="text-xs text-muted-foreground" role="status">{locationNote}</p>}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="campus-radius">Allowed distance (metres)</Label>
              <Input id="campus-radius" inputMode="numeric" value={form.radius} onChange={e => set('radius', e.target.value)} />
              <p className="text-xs text-muted-foreground">5 to 500. Start with {defaultRadius} and adjust after testing on real phones.</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="campus-accuracy">GPS accuracy needed (metres)</Label>
              <Input id="campus-accuracy" inputMode="numeric" value={form.accuracy} onChange={e => set('accuracy', e.target.value)} placeholder={`Default: ${globalAccuracy}`} />
              <p className="text-xs text-muted-foreground">Leave empty to use the default.</p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <Switch id="campus-active" checked={form.isActive} onCheckedChange={v => set('isActive', v)} />
            <Label htmlFor="campus-active">Active (employees can mark attendance here)</Label>
          </div>

          {error && <Alert variant="destructive" role="alert"><AlertDescription>{error}</AlertDescription></Alert>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={save.isPending}>{save.isPending ? 'Saving…' : 'Save campus'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function CampusesTab() {
  const campuses = useCampuses();
  const settings = useSettings();
  const [editing, setEditing] = useState<Campus | null>(null);
  const [adding, setAdding] = useState(false);
  const defaultRadius = settingValue(settings.data, 'default_geofence_radius_m', 25);
  const globalAccuracy = settingValue(settings.data, 'required_gps_accuracy_m', 10);

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-4 space-y-0">
        <div>
          <CardTitle className="text-lg">Campuses</CardTitle>
          <CardDescription>Each campus has its own location and allowed distance.</CardDescription>
        </div>
        <Button onClick={() => setAdding(true)}><Plus className="mr-2 h-4 w-4" />Add campus</Button>
      </CardHeader>
      <CardContent>
        {campuses.isLoading ? <Skeleton className="h-32 w-full" /> : campuses.isError ? (
          <Alert variant="destructive"><AlertDescription>{errorText(campuses.error)}</AlertDescription></Alert>
        ) : (campuses.data?.length ?? 0) === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">No campuses yet. Add your first campus to begin.</p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Campus</TableHead><TableHead>Location</TableHead><TableHead>Distance</TableHead>
                  <TableHead>Shifts</TableHead><TableHead>Employees</TableHead><TableHead>Status</TableHead><TableHead className="w-12" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {campuses.data!.map(c => (
                  <TableRow key={c.id}>
                    <TableCell><div className="font-medium">{c.name}</div><div className="text-xs text-muted-foreground">{c.code}</div></TableCell>
                    <TableCell>
                      {c.latitude === null || c.longitude === null
                        ? <Badge variant="destructive">Not set</Badge>
                        : <span className="text-xs tabular-nums">{c.latitude.toFixed(5)}, {c.longitude.toFixed(5)}</span>}
                    </TableCell>
                    <TableCell>{c.geofenceRadiusM} m</TableCell>
                    <TableCell>{c.shiftCount === 0 ? <Badge variant="destructive">None</Badge> : c.shiftCount}</TableCell>
                    <TableCell>{c.employeeCount}</TableCell>
                    <TableCell>{c.isActive ? <Badge>Active</Badge> : <Badge variant="secondary">Inactive</Badge>}</TableCell>
                    <TableCell>
                      <Button variant="ghost" size="icon" aria-label={`Edit ${c.name}`} onClick={() => setEditing(c)}><Pencil className="h-4 w-4" /></Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
      {(adding || editing) && (
        <CampusDialog
          key={editing?.id ?? 'new'} campus={editing} open
          onClose={() => { setAdding(false); setEditing(null); }}
          defaultRadius={defaultRadius} globalAccuracy={globalAccuracy}
        />
      )}
    </Card>
  );
}
