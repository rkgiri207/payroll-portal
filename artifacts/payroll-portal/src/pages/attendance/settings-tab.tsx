import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Lock } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { useToast } from '@/hooks/use-toast';
import { adminPatch, formatWhatsapp, type SettingRow } from './api';
import { NO_LIMIT, permissionMinuteOptions } from './settings-options';
import { errorText, keys, useMe, useRefresh, useSettings } from './use-attendance';

type Kind = 'int' | 'text' | 'phone' | 'select' | 'switch';
export interface Meta {
  label: string; help: string; kind: Kind; unit?: string;
  /** For a dropdown: the choice that means "nothing set" (stored as empty). */
  nullValue?: string;
  options?: { value: string; label: string }[];
}

const ALERT_MODES = [
  { value: 'individual', label: 'Every event: each IN, OUT, late arrival and exception' },
  { value: 'digest', label: 'Summary: a periodic summary, with late arrivals and exceptions still sent at once' },
  { value: 'mute_normal', label: 'Only problems: late arrivals, exceptions and missing check-outs' },
];
const DIGEST_MINUTES = [15, 30, 60, 120, 240].map(m => ({ value: String(m), label: m < 60 ? `Every ${m} minutes` : `Every ${m / 60} hour${m === 60 ? '' : 's'}` }));

export const META: Record<string, Meta> = {
  director_whatsapp_e164: { label: "Director's WhatsApp number", kind: 'phone', help: 'Alerts are sent to this number. Enter a 10-digit Indian mobile number.' },
  alert_mode: { label: 'How the Director is alerted', kind: 'select', options: ALERT_MODES, help: 'Muting never hides anything from the dashboard; it only changes WhatsApp alerts.' },
  digest_interval_minutes: { label: 'Summary interval', kind: 'select', options: DIGEST_MINUTES, help: 'Used when the mode above is "Summary". A summary is sent only if something happened since the last one.' },
  default_grace_minutes: { label: 'Default grace period', kind: 'int', unit: 'minutes', help: 'Pre-filled when you add a shift. Each shift keeps its own grace.' },
  default_geofence_radius_m: { label: 'Default allowed distance', kind: 'int', unit: 'metres', help: 'Pre-filled when you add a campus. Each campus keeps its own distance.' },
  required_gps_accuracy_m: { label: 'GPS accuracy needed', kind: 'int', unit: 'metres', help: 'A phone reporting a worse accuracy is asked to try again. A campus can override this.' },
  token_ttl_minutes: { label: 'Attendance link lifetime', kind: 'int', unit: 'minutes', help: 'How long the WhatsApp link works. It can be used once.' },
  max_failed_attempts: { label: 'Failed location attempts before the link locks', kind: 'int', help: 'After this many failures the employee is told, and the Director is alerted.' },
  missing_out_after_minutes: { label: 'Flag a missing check-out after', kind: 'int', unit: 'minutes after logout time', help: 'An employee who checked in but not out is flagged for review, never marked absent.' },
  allow_attendance_outside_academic_year: { label: 'Allow check-in and check-out outside the academic year', kind: 'switch', help: 'Off: an employee who sends IN or OUT on a date outside every academic year is told to contact the office. On: it is accepted and flagged "outside academic year". Academic years are set on the Holiday Calendar page.' },
  selfie_retention_days: { label: 'Keep selfies for', kind: 'int', unit: 'days', help: 'Selfies are private. This sets how long they are kept (automatic deletion comes in a later phase).' },
  attendance_link_base_url: { label: 'Public address for attendance links', kind: 'text', help: 'Starts with https://. Leave empty to use the portal address.' },
  whatsapp_template_language: { label: 'WhatsApp template language', kind: 'text', help: 'Must match the language you chose in Meta, for example en.' },
  template_checkin: { label: 'Template name: check-in', kind: 'text', help: 'Must match the approved template name in Meta exactly.' },
  template_checkout: { label: 'Template name: check-out', kind: 'text', help: 'Must match Meta exactly.' },
  template_late: { label: 'Template name: late arrival', kind: 'text', help: 'Must match Meta exactly.' },
  template_exception: { label: 'Template name: exception', kind: 'text', help: 'Must match Meta exactly.' },
  template_missing_out: { label: 'Template name: missing check-out', kind: 'text', help: 'Must match Meta exactly.' },
  template_digest: { label: 'Template name: summary', kind: 'text', help: 'Must match Meta exactly.' },
  leave_cap_per_campus_per_day: { label: 'Most people on leave per campus, per day', kind: 'int', unit: 'people', help: 'A leave request that would exceed this on any date is declined automatically and the employee is told. Applies to new requests at once; approved leave is not changed.' },
  form_token_ttl_minutes: { label: 'Leave form link lifetime', kind: 'int', unit: 'minutes', help: 'How long the WhatsApp link to the leave or permission form works.' },
  permission_max_minutes: { label: 'Longest single permission', kind: 'select', options: permissionMinuteOptions, nullValue: NO_LIMIT, help: 'A permission longer than this cannot be requested. Choose in steps of 5 minutes, or No limit.' },
  permission_max_per_month: { label: 'Permissions allowed per month', kind: 'int', unit: 'per employee (empty = no limit)', help: 'Counted per month (1st to last day), per employee. Leave itself runs on the academic year.' },
  template_leave_request: { label: 'Template name: leave request to Director', kind: 'text', help: 'Must match Meta exactly.' },
  template_permission_request: { label: 'Template name: permission request to Director', kind: 'text', help: 'Must match Meta exactly.' },
  template_leave_decision: { label: 'Template name: leave decision', kind: 'text', help: 'Must match Meta exactly.' },
  template_permission_decision: { label: 'Template name: permission decision', kind: 'text', help: 'Must match Meta exactly.' },
};

const GROUPS: { title: string; description: string; keys: string[] }[] = [
  { title: 'Director alerts', description: 'Who is alerted on WhatsApp, and how often.', keys: ['director_whatsapp_e164', 'alert_mode', 'digest_interval_minutes'] },
  { title: 'Attendance rules', description: 'Defaults and limits. Campuses and shifts can override some of these.', keys: ['default_grace_minutes', 'default_geofence_radius_m', 'required_gps_accuracy_m', 'token_ttl_minutes', 'max_failed_attempts', 'missing_out_after_minutes', 'allow_attendance_outside_academic_year'] },
  { title: 'Leave and permission rules', description: 'Limits that apply to leave and permission requests. Leave types, balances and holidays have their own pages.', keys: ['leave_cap_per_campus_per_day', 'form_token_ttl_minutes', 'permission_max_minutes', 'permission_max_per_month'] },
  { title: 'Photos and privacy', description: 'Selfies are stored privately and never sent on WhatsApp.', keys: ['selfie_retention_days'] },
  { title: 'WhatsApp templates and links', description: 'Names must match your approved templates in Meta exactly.', keys: ['attendance_link_base_url', 'whatsapp_template_language', 'template_checkin', 'template_checkout', 'template_late', 'template_exception', 'template_missing_out', 'template_digest', 'template_leave_request', 'template_permission_request', 'template_leave_decision', 'template_permission_decision'] },
];

/** Show a stored value as the text a person would type. */
export function toDraft(row: SettingRow, meta: Meta): string {
  if (row.value === null || row.value === undefined) return meta.nullValue ?? '';
  if (meta.kind === 'phone') return formatWhatsapp(String(row.value)).replace(/^\+91 /, '');
  return String(row.value);
}

export function fromDraft(draft: string, meta: Meta): unknown {
  if (meta.kind === 'switch') return draft === 'true';
  if (meta.kind === 'int') return draft.trim() === '' ? null : Number(draft);
  if (meta.nullValue !== undefined && draft === meta.nullValue) return null;
  if (meta.kind === 'select' && meta.options?.every(o => o.value === meta.nullValue || /^\d+$/.test(o.value))) return Number(draft);
  if (meta.kind === 'phone') return draft.trim() === '' ? null : draft.trim();
  return draft.trim();
}

function SettingField({ row, meta, locked }: { row: SettingRow; meta: Meta; locked: boolean }) {
  const { toast } = useToast();
  const refresh = useRefresh();
  const saved = toDraft(row, meta);
  const [draft, setDraft] = useState(saved);
  const [error, setError] = useState<string | null>(null);
  const changed = draft !== saved;

  const save = useMutation({
    mutationFn: () => adminPatch(`/settings/${row.key}`, { value: fromDraft(draft, meta) }),
    onSuccess: () => { refresh(keys.settings); toast({ title: 'Saved', description: meta.label }); setError(null); },
    onError: e => setError(errorText(e)),
  });

  const options = meta.options && !meta.options.some(o => o.value === draft) && draft !== ''
    ? [...meta.options, { value: draft, label: `${draft} (current)` }] : meta.options;

  return (
    <div className="grid gap-2 border-b py-4 last:border-b-0 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] sm:gap-6">
      <div>
        <Label htmlFor={`setting-${row.key}`} className="flex items-center gap-2 text-sm font-medium">
          {meta.label}
          {locked && <Lock className="h-3.5 w-3.5 text-muted-foreground" aria-label="Only the Director can change this" />}
        </Label>
        <p className="mt-1 text-xs text-muted-foreground">{meta.help}</p>
        {locked && <p className="mt-1 text-xs text-muted-foreground">Only the Director can change this.</p>}
      </div>
      <div className="space-y-2">
        <div className="flex gap-2">
          {meta.kind === 'switch' ? (
            <div className="flex w-full items-center gap-3">
              <Switch
                id={`setting-${row.key}`} checked={draft === 'true'} disabled={locked}
                onCheckedChange={on => setDraft(on ? 'true' : 'false')}
              />
              <span className="text-sm">{draft === 'true' ? 'On' : 'Off'}</span>
            </div>
          ) : meta.kind === 'select' ? (
            <Select value={draft} onValueChange={setDraft} disabled={locked}>
              <SelectTrigger id={`setting-${row.key}`}><SelectValue /></SelectTrigger>
              <SelectContent>{options!.map(o => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}</SelectContent>
            </Select>
          ) : (
            <div className="flex w-full items-center gap-2">
              {meta.kind === 'phone' && <span className="text-sm text-muted-foreground">+91</span>}
              <Input
                id={`setting-${row.key}`} value={draft} disabled={locked}
                inputMode={meta.kind === 'int' ? 'numeric' : meta.kind === 'phone' ? 'tel' : 'text'}
                onChange={e => setDraft(e.target.value)}
              />
              {meta.unit && <span className="shrink-0 text-xs text-muted-foreground">{meta.unit}</span>}
            </div>
          )}
          <Button type="button" onClick={() => { setError(null); save.mutate(); }} disabled={!changed || locked || save.isPending}>
            {save.isPending ? 'Saving…' : 'Save'}
          </Button>
        </div>
        {error && <p className="text-xs text-destructive" role="alert">{error}</p>}
      </div>
    </div>
  );
}

export function SettingsTab() {
  const settings = useSettings();
  const me = useMe();
  const locked = (row: SettingRow) => row.directorOnly && !me.data?.canEditDirectorSettings;

  if (settings.isLoading) return <Skeleton className="h-64 w-full" />;
  if (settings.isError) return <Alert variant="destructive"><AlertDescription>{errorText(settings.error)}</AlertDescription></Alert>;
  const rows = new Map((settings.data ?? []).map(r => [r.key, r]));

  return (
    <div className="space-y-6">
      {GROUPS.map(group => {
        const present = group.keys.map(k => rows.get(k)).filter((r): r is SettingRow => Boolean(r));
        if (present.length === 0) return null;
        return (
          <Card key={group.title}>
            <CardHeader className="pb-2">
              <CardTitle className="text-lg">{group.title}</CardTitle>
              <CardDescription>{group.description}</CardDescription>
            </CardHeader>
            <CardContent>
              {present.map(row => (
                // key includes the saved value so the field resets to the new saved value after a save
                <SettingField key={`${row.key}:${String(row.value)}`} row={row} meta={META[row.key]} locked={locked(row)} />
              ))}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
