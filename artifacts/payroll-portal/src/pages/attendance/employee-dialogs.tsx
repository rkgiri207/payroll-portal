import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useToast } from '@/hooks/use-toast';
import {
  adminDelete, adminGet, adminPost, adminPut, createEmployee, todayIst, updateEmployee,
  type Assignment, type Campus, type EmployeeRow,
} from './api';
import { errorText, keys, useRefresh } from './use-attendance';

const NO_CAMPUS = 'none';

function CampusSelect(props: { campuses: Campus[]; value: string; onChange(v: string): void; allowNone?: boolean; id?: string; label: string }) {
  return (
    <Select value={props.value} onValueChange={props.onChange}>
      <SelectTrigger id={props.id} aria-label={props.label}><SelectValue placeholder="Choose a campus" /></SelectTrigger>
      <SelectContent>
        {props.allowNone && <SelectItem value={NO_CAMPUS}>No campus yet</SelectItem>}
        {props.campuses.filter(c => c.isActive).map(c => <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}

function Problem({ text }: { text: string | null }) {
  return text ? <Alert variant="destructive" role="alert"><AlertDescription>{text}</AlertDescription></Alert> : null;
}

// ── Add a new employee (details, WhatsApp number and campus in one step) ──────
export function AddEmployeeDialog(props: { campuses: Campus[]; onClose(): void }) {
  const { campuses, onClose } = props;
  const { toast } = useToast();
  const refresh = useRefresh();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [designation, setDesignation] = useState('');
  const [branch, setBranch] = useState('');
  const [mobile, setMobile] = useState('');
  const [whatsapp, setWhatsapp] = useState('');
  const [whatsappTouched, setWhatsappTouched] = useState(false);
  const [campus, setCampus] = useState(NO_CAMPUS);
  const [applicable, setApplicable] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Until the admin types a different attendance number, it follows the mobile number.
  useEffect(() => { if (!whatsappTouched) setWhatsapp(mobile); }, [mobile, whatsappTouched]);

  const save = useMutation({
    mutationFn: async () => {
      const employee = await createEmployee({
        employeeCode: code, employeeName: name, designation: designation || null, branch: branch || null, mobileNumber: mobile || null,
      });
      const problems: string[] = [];
      if (whatsapp.trim() || !applicable) {
        try { await adminPut(`/employees/${employee.id}/registration`, { whatsapp, attendanceApplicable: applicable }); }
        catch (e) { problems.push(`WhatsApp number: ${errorText(e)}`); }
      }
      if (campus !== NO_CAMPUS) {
        try { await adminPost(`/employees/${employee.id}/assignments`, { campusId: Number(campus), kind: 'PRIMARY', startDate: todayIst() }); }
        catch (e) { problems.push(`Campus: ${errorText(e)}`); }
      }
      return { employee, problems };
    },
    onSuccess: ({ employee, problems }) => {
      refresh(['attendance', 'employees'], keys.campuses);
      if (problems.length === 0) toast({ title: 'Employee added', description: employee.employeeName });
      else toast({ title: 'Employee saved, but setup is incomplete', description: `${problems.join(' · ')}. Open "Set up" on the employee to finish.`, variant: 'destructive' });
      onClose();
    },
    onError: e => setError(errorText(e)),
  });

  return (
    <Dialog open onOpenChange={o => { if (!o) onClose(); }}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add an employee</DialogTitle>
          <DialogDescription>The employee is added to the portal and set up for attendance in one step.</DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={e => { e.preventDefault(); setError(null); save.mutate(); }}>
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="emp-code">Employee code</Label>
              <Input id="emp-code" value={code} onChange={e => setCode(e.target.value)} required />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="emp-name">Full name</Label>
              <Input id="emp-name" value={name} onChange={e => setName(e.target.value)} required />
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="emp-designation">Designation (optional)</Label>
              <Input id="emp-designation" value={designation} onChange={e => setDesignation(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="emp-branch">Branch name used in payroll (optional)</Label>
              <Input id="emp-branch" value={branch} onChange={e => setBranch(e.target.value)} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="emp-mobile">Mobile number (optional)</Label>
            <Input id="emp-mobile" inputMode="tel" value={mobile} onChange={e => setMobile(e.target.value)} placeholder="98491 36605" />
          </div>

          <div className="space-y-3 rounded-md border p-3">
            <p className="text-sm font-medium">Attendance</p>
            <div className="space-y-1.5">
              <Label htmlFor="emp-whatsapp">WhatsApp number for attendance</Label>
              <Input id="emp-whatsapp" inputMode="tel" value={whatsapp} placeholder="10-digit Indian mobile number"
                onChange={e => { setWhatsapp(e.target.value); setWhatsappTouched(true); }} />
              <p className="text-xs text-muted-foreground">The employee sends IN and OUT from this number. It follows the mobile number above unless you change it.</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="emp-campus">Main campus</Label>
              <CampusSelect id="emp-campus" campuses={campuses} value={campus} onChange={setCampus} allowNone label="Main campus" />
            </div>
            <div className="flex items-center gap-3">
              <Switch id="emp-applicable" checked={applicable} onCheckedChange={setApplicable} />
              <Label htmlFor="emp-applicable">This employee marks attendance</Label>
            </div>
          </div>

          <Problem text={error} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={save.isPending}>{save.isPending ? 'Saving…' : 'Add employee'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ── Set up an existing employee ───────────────────────────────────────────────
function Section(props: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3 border-t pt-4 first:border-t-0 first:pt-0">
      <div>
        <h3 className="text-sm font-semibold">{props.title}</h3>
        {props.description && <p className="text-xs text-muted-foreground">{props.description}</p>}
      </div>
      {props.children}
    </section>
  );
}

function DetailsSection({ employee, onSaved }: { employee: EmployeeRow; onSaved(): void }) {
  const { toast } = useToast();
  const [name, setName] = useState(employee.employeeName);
  const [designation, setDesignation] = useState(employee.designation ?? '');
  const [branch, setBranch] = useState(employee.branch ?? '');
  const [mobile, setMobile] = useState(employee.mobileNumber ?? '');
  const [active, setActive] = useState(employee.status === 'ACTIVE');
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: async () => {
      await updateEmployee(employee.id, { employeeName: name, designation: designation || null, branch: branch || null, mobileNumber: mobile || null });
      if ((employee.status === 'ACTIVE') !== active) {
        const response = await fetch(`/api/employees/${employee.id}/status`, {
          method: 'PATCH', credentials: 'include', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: active ? 'ACTIVE' : 'INACTIVE' }),
        });
        if (!response.ok) throw new Error('Details saved, but the active status could not be changed.');
      }
    },
    onSuccess: () => { toast({ title: 'Details saved' }); onSaved(); },
    onError: e => setError(errorText(e)),
  });

  return (
    <Section title="Details" description="The employee code cannot be changed here because payroll uploads match on it.">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5"><Label>Employee code</Label><Input value={employee.employeeCode} readOnly disabled /></div>
        <div className="space-y-1.5"><Label htmlFor="d-name">Full name</Label><Input id="d-name" value={name} onChange={e => setName(e.target.value)} /></div>
        <div className="space-y-1.5"><Label htmlFor="d-designation">Designation</Label><Input id="d-designation" value={designation} onChange={e => setDesignation(e.target.value)} /></div>
        <div className="space-y-1.5"><Label htmlFor="d-branch">Branch name used in payroll</Label><Input id="d-branch" value={branch} onChange={e => setBranch(e.target.value)} /></div>
        <div className="space-y-1.5 sm:col-span-2"><Label htmlFor="d-mobile">Mobile number</Label><Input id="d-mobile" inputMode="tel" value={mobile} onChange={e => setMobile(e.target.value)} /></div>
      </div>
      <div className="flex items-center gap-3">
        <Switch id="d-active" checked={active} onCheckedChange={setActive} />
        <Label htmlFor="d-active">Active employee (inactive employees cannot mark attendance)</Label>
      </div>
      <Problem text={error} />
      <Button type="button" onClick={() => { setError(null); save.mutate(); }} disabled={save.isPending || !name.trim()}>
        {save.isPending ? 'Saving…' : 'Save details'}
      </Button>
    </Section>
  );
}

function RegistrationSection({ employee, onSaved }: { employee: EmployeeRow; onSaved(): void }) {
  const { toast } = useToast();
  const [whatsapp, setWhatsapp] = useState(employee.whatsapp ? employee.whatsapp.replace(/^91/, '') : '');
  const [applicable, setApplicable] = useState(employee.attendanceApplicable);
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () => adminPut(`/employees/${employee.id}/registration`, { whatsapp, attendanceApplicable: applicable }),
    onSuccess: () => { toast({ title: 'Attendance registration saved' }); onSaved(); },
    onError: e => setError(errorText(e)),
  });

  return (
    <Section title="Attendance registration" description="Only a registered number can send IN and OUT. Anyone else gets no reply.">
      <div className="space-y-1.5">
        <Label htmlFor="r-whatsapp">WhatsApp number</Label>
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">+91</span>
          <Input id="r-whatsapp" inputMode="tel" value={whatsapp} onChange={e => setWhatsapp(e.target.value)} placeholder="98491 36605" />
        </div>
      </div>
      <div className="flex items-center gap-3">
        <Switch id="r-applicable" checked={applicable} onCheckedChange={setApplicable} />
        <Label htmlFor="r-applicable">This employee marks attendance (shown as expected, and as unmarked if no check-in)</Label>
      </div>
      <Problem text={error} />
      <Button type="button" onClick={() => { setError(null); save.mutate(); }} disabled={save.isPending}>
        {save.isPending ? 'Saving…' : 'Save registration'}
      </Button>
    </Section>
  );
}

function CampusSection({ employee, campuses, onChanged }: { employee: EmployeeRow; campuses: Campus[]; onChanged(): void }) {
  const { toast } = useToast();
  const assignments = useQuery({
    queryKey: keys.assignments(employee.id),
    queryFn: () => adminGet<{ assignments: Assignment[]; today: string }>(`/employees/${employee.id}/assignments`),
    retry: false,
  });
  const today = assignments.data?.today ?? todayIst();

  const [primaryCampus, setPrimaryCampus] = useState(NO_CAMPUS);
  const [primaryFrom, setPrimaryFrom] = useState(todayIst());
  const [tempCampus, setTempCampus] = useState(NO_CAMPUS);
  const [tempFrom, setTempFrom] = useState(todayIst());
  const [tempTo, setTempTo] = useState(todayIst());
  const [tempMode, setTempMode] = useState<'REPLACE' | 'ADDITIONAL'>('REPLACE');
  const [tempNote, setTempNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  const done = (title: string) => { toast({ title }); setError(null); void assignments.refetch(); onChanged(); };

  const addPrimary = useMutation({
    mutationFn: () => adminPost(`/employees/${employee.id}/assignments`, { campusId: Number(primaryCampus), kind: 'PRIMARY', startDate: primaryFrom }),
    onSuccess: () => done('Main campus saved'), onError: e => setError(errorText(e)),
  });
  const addTemp = useMutation({
    mutationFn: () => adminPost(`/employees/${employee.id}/assignments`, {
      campusId: Number(tempCampus), kind: 'TEMPORARY', mode: tempMode, startDate: tempFrom, endDate: tempTo, note: tempNote,
    }),
    onSuccess: () => done('Temporary duty added'), onError: e => setError(errorText(e)),
  });
  const remove = useMutation({
    mutationFn: (id: number) => adminDelete(`/assignments/${id}`),
    onSuccess: () => done('Assignment removed'), onError: e => setError(errorText(e)),
  });

  const current = (assignments.data?.assignments ?? []).filter(a => a.endDate === null || a.endDate >= today);

  return (
    <Section title="Campus" description="Where this employee marks attendance. Temporary duty at another campus has its own dates.">
      {assignments.isLoading ? <p className="text-sm text-muted-foreground">Loading…</p> : current.length === 0 ? (
        <p className="text-sm text-muted-foreground">No campus assigned yet. The employee cannot mark attendance until one is set.</p>
      ) : (
        <ul className="space-y-2">
          {current.map(a => (
            <li key={a.id} className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
              <span className="min-w-0">
                <span className="font-medium">{a.campusName}</span>{' '}
                <Badge variant={a.kind === 'PRIMARY' ? 'default' : 'outline'}>{a.kind === 'PRIMARY' ? 'Main' : a.mode === 'REPLACE' ? 'Temporary (replaces main)' : 'Temporary (plus main)'}</Badge>
                <span className="block text-xs text-muted-foreground">
                  From {a.startDate}{a.endDate ? ` to ${a.endDate}` : ''}{a.note ? ` · ${a.note}` : ''}
                </span>
              </span>
              <Button variant="ghost" size="icon" aria-label={`Remove ${a.campusName} assignment`} onClick={() => remove.mutate(a.id)} disabled={remove.isPending}>
                <Trash2 className="h-4 w-4" />
              </Button>
            </li>
          ))}
        </ul>
      )}

      <div className="space-y-2 rounded-md border p-3">
        <p className="text-sm font-medium">Set the main campus</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <CampusSelect campuses={campuses} value={primaryCampus} onChange={setPrimaryCampus} label="Main campus" />
          <Input type="date" value={primaryFrom} onChange={e => setPrimaryFrom(e.target.value)} aria-label="Main campus start date" />
        </div>
        <Button type="button" size="sm" onClick={() => { setError(null); addPrimary.mutate(); }} disabled={primaryCampus === NO_CAMPUS || addPrimary.isPending}>
          {addPrimary.isPending ? 'Saving…' : 'Set main campus'}
        </Button>
        <p className="text-xs text-muted-foreground">A new main campus ends the previous one the day before it starts.</p>
      </div>

      <div className="space-y-2 rounded-md border p-3">
        <p className="text-sm font-medium">Temporary duty at another campus</p>
        <CampusSelect campuses={campuses} value={tempCampus} onChange={setTempCampus} label="Temporary campus" />
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5"><Label htmlFor="t-from">From</Label><Input id="t-from" type="date" value={tempFrom} onChange={e => setTempFrom(e.target.value)} /></div>
          <div className="space-y-1.5"><Label htmlFor="t-to">To (last day)</Label><Input id="t-to" type="date" value={tempTo} onChange={e => setTempTo(e.target.value)} /></div>
        </div>
        <RadioGroup value={tempMode} onValueChange={v => setTempMode(v as 'REPLACE' | 'ADDITIONAL')} className="gap-2">
          <div className="flex items-center gap-2"><RadioGroupItem id="t-replace" value="REPLACE" /><Label htmlFor="t-replace" className="font-normal">Marks only at this campus on those days</Label></div>
          <div className="flex items-center gap-2"><RadioGroupItem id="t-additional" value="ADDITIONAL" /><Label htmlFor="t-additional" className="font-normal">Can mark here or at the main campus (asked which on WhatsApp)</Label></div>
        </RadioGroup>
        <Input value={tempNote} onChange={e => setTempNote(e.target.value)} placeholder="Note (optional), for example exam duty" maxLength={200} aria-label="Note" />
        <Button type="button" size="sm" onClick={() => { setError(null); addTemp.mutate(); }} disabled={tempCampus === NO_CAMPUS || addTemp.isPending}>
          {addTemp.isPending ? 'Saving…' : 'Add temporary duty'}
        </Button>
      </div>
      <Problem text={error} />
    </Section>
  );
}

export function EmployeeSetupDialog(props: { employee: EmployeeRow; campuses: Campus[]; onClose(): void }) {
  const { employee, campuses, onClose } = props;
  const refresh = useRefresh();
  const changed = () => refresh(['attendance', 'employees'], keys.campuses);

  return (
    <Dialog open onOpenChange={o => { if (!o) onClose(); }}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{employee.employeeName}</DialogTitle>
          <DialogDescription>{employee.employeeCode}{employee.designation ? ` · ${employee.designation}` : ''}</DialogDescription>
        </DialogHeader>
        <div className="space-y-5">
          <RegistrationSection employee={employee} onSaved={changed} />
          <CampusSection employee={employee} campuses={campuses} onChanged={changed} />
          <DetailsSection employee={employee} onSaved={changed} />
        </div>
        <DialogFooter><Button variant="outline" onClick={onClose}>Close</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
