import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Plus, Search, Settings2 } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { adminGet, formatWhatsapp, type EmployeeRow } from './api';
import { AddEmployeeDialog, EmployeeSetupDialog } from './employee-dialogs';
import { errorText, keys, useCampuses } from './use-attendance';

const PAGE_SIZE = 50;

export function EmployeesTab() {
  const campuses = useCampuses();
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [status, setStatus] = useState<'ACTIVE' | 'ALL'>('ACTIVE');
  const [page, setPage] = useState(1);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<EmployeeRow | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => { setDebounced(search); setPage(1); }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  const params = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE) });
  if (debounced) params.set('search', debounced);
  if (status === 'ACTIVE') params.set('status', 'ACTIVE');
  const query = params.toString();

  const list = useQuery({
    queryKey: keys.employees(query),
    queryFn: () => adminGet<{ employees: EmployeeRow[]; total: number }>(`/employees?${query}`),
    retry: false, placeholderData: previous => previous,
  });
  const total = list.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-4 space-y-0">
        <div>
          <CardTitle className="text-lg">Employees</CardTitle>
          <CardDescription>Register each employee&apos;s WhatsApp number and campus. New employees can be added here too.</CardDescription>
        </div>
        <Button onClick={() => setAdding(true)}><Plus className="mr-2 h-4 w-4" />Add employee</Button>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-col gap-3 sm:flex-row">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input className="pl-9" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search by name or code" aria-label="Search employees" />
          </div>
          <Select value={status} onValueChange={v => { setStatus(v as 'ACTIVE' | 'ALL'); setPage(1); }}>
            <SelectTrigger className="sm:w-44" aria-label="Show"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="ACTIVE">Active employees</SelectItem>
              <SelectItem value="ALL">All employees</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {list.isLoading ? <Skeleton className="h-48 w-full" /> : list.isError ? (
          <Alert variant="destructive"><AlertDescription>{errorText(list.error)}</AlertDescription></Alert>
        ) : (list.data?.employees.length ?? 0) === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            {debounced ? 'No employees match your search.' : 'No employees yet. Add one, or upload payroll to bring employees in.'}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Employee</TableHead><TableHead>Campus</TableHead><TableHead>WhatsApp number</TableHead>
                  <TableHead>Attendance</TableHead><TableHead className="w-28" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.data!.employees.map(e => (
                  <TableRow key={e.id}>
                    <TableCell>
                      <div className="font-medium">{e.employeeName}{e.status !== 'ACTIVE' && <Badge variant="secondary" className="ml-2">Inactive</Badge>}</div>
                      <div className="text-xs text-muted-foreground">{e.employeeCode}{e.designation ? ` · ${e.designation}` : ''}</div>
                    </TableCell>
                    <TableCell>
                      {e.primaryCampusName ?? <Badge variant="destructive">Not set</Badge>}
                      {e.activeTemporary > 0 && <span className="ml-2 text-xs text-muted-foreground">+{e.activeTemporary} temporary</span>}
                    </TableCell>
                    <TableCell>{e.whatsapp ? <span className="tabular-nums">{formatWhatsapp(e.whatsapp)}</span> : <Badge variant="destructive">Not registered</Badge>}</TableCell>
                    <TableCell>{e.attendanceApplicable ? <Badge>On</Badge> : <Badge variant="secondary">Off</Badge>}{!e.joiningDate && <Badge variant="destructive" className="ml-1" title="No joining date: no leave is credited">No joining date</Badge>}{e.reportsDuringVacations && <Badge variant="outline" className="ml-1" title="Works during school vacations">Vacations</Badge>}</TableCell>
                    <TableCell>
                      <Button variant="outline" size="sm" onClick={() => setEditing(e)}><Settings2 className="mr-2 h-4 w-4" />Set up</Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        {pages > 1 && (
          <div className="flex items-center justify-between text-sm text-muted-foreground">
            <span>{total} employees · page {page} of {pages}</span>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>Previous</Button>
              <Button variant="outline" size="sm" disabled={page >= pages} onClick={() => setPage(p => p + 1)}>Next</Button>
            </div>
          </div>
        )}
      </CardContent>

      {adding && <AddEmployeeDialog campuses={campuses.data ?? []} onClose={() => setAdding(false)} />}
      {editing && <EmployeeSetupDialog key={editing.id} employee={editing} campuses={campuses.data ?? []} onClose={() => setEditing(null)} />}
    </Card>
  );
}
