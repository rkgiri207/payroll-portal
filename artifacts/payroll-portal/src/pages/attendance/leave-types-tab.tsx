import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Pencil, Plus } from 'lucide-react';
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
import { adminPatch, adminPost } from './api';
import { policyKeys, useLeaveTypes, type LeaveType } from './leave-policy-api';
import { errorText, useRefresh } from './use-attendance';

function TypeDialog({ type, onClose }: { type: LeaveType | null; onClose(): void }) {
  const { toast } = useToast();
  const refresh = useRefresh();
  const [form, setForm] = useState({
    code: type?.code ?? '', name: type?.name ?? '', isPaid: type?.isPaid ?? true,
    tracksBalance: type?.tracksBalance ?? true, isActive: type?.isActive ?? true,
  });
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () => type
      ? adminPatch(`/leave/types/${type.id}`, { name: form.name, isActive: form.isActive })
      : adminPost('/leave/types', { code: form.code, name: form.name, isPaid: form.isPaid, tracksBalance: form.tracksBalance }),
    onSuccess: () => {
      refresh(policyKeys.types, ['leave', 'policies']);
      toast({ title: type ? 'Leave type updated' : 'Leave type added', description: form.name });
      onClose();
    },
    onError: e => setError(errorText(e)),
  });

  return (
    <Dialog open onOpenChange={o => { if (!o) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{type ? `Edit ${type.name}` : 'Add a leave type'}</DialogTitle>
          <DialogDescription>
            {type
              ? 'You can rename a leave type or switch it off. Switching it off hides it from new requests; existing records are kept.'
              : 'For example Maternity Leave. Choose carefully whether it is paid and whether it keeps a balance: this cannot be changed once the leave type has been used.'}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {!type && (
            <div className="space-y-1.5">
              <Label htmlFor="type-code">Short code</Label>
              <Input id="type-code" placeholder="MATERNITY" value={form.code} onChange={e => setForm(f => ({ ...f, code: e.target.value }))} />
              <p className="text-xs text-muted-foreground">Letters, numbers and underscores. Cannot be changed later.</p>
            </div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="type-name">Name</Label>
            <Input id="type-name" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
          </div>
          {!type && (
            <>
              <div className="flex items-center justify-between gap-4">
                <div><Label htmlFor="type-paid">Paid leave</Label><p className="text-xs text-muted-foreground">Off means the days are without pay.</p></div>
                <Switch id="type-paid" checked={form.isPaid} onCheckedChange={v => setForm(f => ({ ...f, isPaid: v }))} />
              </div>
              <div className="flex items-center justify-between gap-4">
                <div><Label htmlFor="type-balance">Keeps a balance</Label><p className="text-xs text-muted-foreground">Off means it never runs out, like unpaid leave.</p></div>
                <Switch id="type-balance" checked={form.tracksBalance} onCheckedChange={v => setForm(f => ({ ...f, tracksBalance: v }))} />
              </div>
            </>
          )}
          {type && (
            <div className="flex items-center justify-between gap-4">
              <Label htmlFor="type-active">Available for new requests</Label>
              <Switch id="type-active" checked={form.isActive} onCheckedChange={v => setForm(f => ({ ...f, isActive: v }))} />
            </div>
          )}
          {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => { setError(null); save.mutate(); }} disabled={save.isPending}>{save.isPending ? 'Saving…' : type ? 'Save changes' : 'Add leave type'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function LeaveTypesTab() {
  const types = useLeaveTypes();
  const [dialog, setDialog] = useState<{ type: LeaveType | null } | null>(null);

  if (types.isLoading) return <Skeleton className="h-48 w-full" />;
  if (types.isError) return <Alert variant="destructive"><AlertDescription>{errorText(types.error)}</AlertDescription></Alert>;

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between space-y-0 pb-2">
        <div>
          <CardTitle className="text-base">Leave types</CardTitle>
          <CardDescription>The kinds of leave your staff can take. Rules for each type are set per academic year on the next tab.</CardDescription>
        </div>
        <Button size="sm" onClick={() => setDialog({ type: null })}><Plus className="mr-2 h-4 w-4" />Add leave type</Button>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead><TableHead>Code</TableHead><TableHead>Pay</TableHead><TableHead>Balance</TableHead><TableHead>Status</TableHead>
              <TableHead className="w-16" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {types.data!.map(t => (
              <TableRow key={t.id}>
                <TableCell className="font-medium">{t.name}</TableCell>
                <TableCell className="text-muted-foreground">{t.code}</TableCell>
                <TableCell>{t.isPaid ? 'Paid' : 'Without pay'}</TableCell>
                <TableCell>{t.tracksBalance ? 'Keeps a balance' : 'No balance'}</TableCell>
                <TableCell><Badge variant={t.isActive ? 'secondary' : 'outline'}>{t.isActive ? 'Active' : 'Off'}</Badge></TableCell>
                <TableCell className="text-right">
                  <Button size="icon" variant="ghost" aria-label={`Edit ${t.name}`} onClick={() => setDialog({ type: t })}><Pencil className="h-4 w-4" /></Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
      {dialog && <TypeDialog key={dialog.type?.id ?? 'new'} type={dialog.type} onClose={() => setDialog(null)} />}
    </Card>
  );
}
