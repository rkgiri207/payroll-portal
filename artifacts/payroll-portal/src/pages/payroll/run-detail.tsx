import { useParams, Link } from 'wouter';
import { useGetPayrollRun, getGetPayrollRunQueryKey, useCancelPayrollRun } from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { formatDate, formatINR, monthName } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { ArrowLeft, FileDown, XCircle } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export default function PayrollRunDetailPage() {
  const { id } = useParams<{ id: string }>();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const numericId = parseInt(id || '0', 10);
  const { data: run, isLoading } = useGetPayrollRun(numericId, {
    query: {
      enabled: !!numericId,
      queryKey: getGetPayrollRunQueryKey(numericId)
    }
  });

  const cancelMut = useCancelPayrollRun();

  const handleCancelRun = () => {
    if (!id) return;
    cancelMut.mutate({ id: numericId }, {
      onSuccess: () => {
        toast({ title: 'Success', description: 'Payroll run cancelled.' });
        queryClient.invalidateQueries({ queryKey: getGetPayrollRunQueryKey(numericId) });
      },
      onError: (err: any) => {
        toast({ title: 'Error', description: err?.message || 'Failed to cancel payroll run.', variant: 'destructive' });
      }
    });
  };

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="flex gap-4 items-center">
          <Skeleton className="h-10 w-10" />
          <Skeleton className="h-10 w-48" />
        </div>
        <div className="grid grid-cols-4 gap-4">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  if (!run) {
    return (
      <div className="text-center py-12">
        <h2 className="text-lg font-semibold">Payroll run not found</h2>
        <Button variant="link" asChild className="mt-4">
          <Link href="/payroll/history">Back to History</Link>
        </Button>
      </div>
    );
  }

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'IMPORTED':
        return <Badge className="bg-green-600 hover:bg-green-600/80 text-white border-transparent">Imported</Badge>;
      case 'VALIDATED':
        return <Badge className="bg-yellow-500 hover:bg-yellow-500/80 text-white border-transparent">Validated</Badge>;
      case 'CANCELLED':
        return <Badge variant="destructive">Cancelled</Badge>;
      case 'DRAFT':
      default:
        return <Badge variant="secondary">Draft</Badge>;
    }
  };

  return (
    <div className="space-y-6" data-testid={`page-run-detail-${id}`}>
      <div className="flex items-center gap-4">
        <Button variant="outline" size="icon" asChild>
          <Link href="/payroll/history" data-testid="btn-back">
            <ArrowLeft className="h-4 w-4" />
          </Link>
        </Button>
        <div className="flex-1">
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-3">
            Payroll: {monthName(run.payrollMonth)} {run.payrollYear}
            {getStatusBadge(run.status)}
          </h1>
          <p className="text-muted-foreground mt-1">
            Uploaded by {run.uploadedByName || 'System'} on {formatDate(run.createdAt)}
          </p>
        </div>
        
        {run.status !== 'CANCELLED' && (
          <Button variant="outline" asChild>
            <Link href={`/payslips?runId=${id}`}>
              <FileDown className="mr-2 h-4 w-4" />
              View Payslips
            </Link>
          </Button>
        )}

        {run.status !== 'CANCELLED' && (
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="destructive" data-testid="btn-cancel-run">
                <XCircle className="mr-2 h-4 w-4" />
                Cancel Run
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Cancel Payroll Run</AlertDialogTitle>
                <AlertDialogDescription>
                  Are you sure you want to cancel this payroll run? This will mark all associated records as cancelled and they will not be processed further.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={cancelMut.isPending}>Close</AlertDialogCancel>
                <AlertDialogAction onClick={handleCancelRun} disabled={cancelMut.isPending} className="bg-red-600 hover:bg-red-700" data-testid="btn-confirm-cancel">
                  {cancelMut.isPending ? 'Cancelling...' : 'Confirm Cancel'}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total Employees</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold font-mono">{run.employeeCount || 0}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total Gross</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold font-mono text-muted-foreground">{formatINR(run.totalGross)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total Deductions</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold font-mono text-muted-foreground">{formatINR(run.totalDeductions)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total Net Salary</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold font-mono">{formatINR(run.totalNet)}</div>
          </CardContent>
        </Card>
      </div>

      <div className="bg-card rounded-md border overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="whitespace-nowrap">Employee Code</TableHead>
              <TableHead className="whitespace-nowrap">Name</TableHead>
              <TableHead className="whitespace-nowrap">Mobile</TableHead>
              <TableHead className="whitespace-nowrap">Designation</TableHead>
              <TableHead className="whitespace-nowrap">Branch</TableHead>
              <TableHead className="text-right whitespace-nowrap">Basic</TableHead>
              <TableHead className="text-right whitespace-nowrap">DA</TableHead>
              <TableHead className="text-right whitespace-nowrap">HRA</TableHead>
              <TableHead className="text-right whitespace-nowrap">Other Earn</TableHead>
              <TableHead className="text-right font-semibold whitespace-nowrap">Gross</TableHead>
              <TableHead className="text-right whitespace-nowrap">PF</TableHead>
              <TableHead className="text-right whitespace-nowrap">ESI</TableHead>
              <TableHead className="text-right whitespace-nowrap">TDS</TableHead>
              <TableHead className="text-right whitespace-nowrap">Other Ded</TableHead>
              <TableHead className="text-right font-semibold whitespace-nowrap">Net Salary</TableHead>
              <TableHead className="text-center whitespace-nowrap">Additional</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {run.records?.length === 0 ? (
              <TableRow>
                <TableCell colSpan={16} className="h-32 text-center text-muted-foreground">
                  No records found in this run.
                </TableCell>
              </TableRow>
            ) : (
              run.records?.map((record) => {
                const addKeys = record.additionalComponents ? Object.keys(record.additionalComponents) : [];
                return (
                  <TableRow key={record.id} className={run.status === 'CANCELLED' ? 'opacity-50' : ''}>
                    <TableCell className="font-medium">{record.employeeCode}</TableCell>
                    <TableCell>{record.employeeName}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{(record as any).mobileNumber || '—'}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{(record as any).designation || '—'}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{(record as any).branch || '—'}</TableCell>
                    <TableCell className="text-right">{formatINR(record.basic)}</TableCell>
                    <TableCell className="text-right">{formatINR(record.da)}</TableCell>
                    <TableCell className="text-right">{formatINR(record.hra)}</TableCell>
                    <TableCell className="text-right">{formatINR(record.otherEarnings)}</TableCell>
                    <TableCell className="text-right font-medium">{formatINR(record.grossSalary)}</TableCell>
                    <TableCell className="text-right">{formatINR(record.pf)}</TableCell>
                    <TableCell className="text-right">{formatINR(record.esi)}</TableCell>
                    <TableCell className="text-right">{formatINR(record.tds)}</TableCell>
                    <TableCell className="text-right">{formatINR(record.otherDeductions)}</TableCell>
                    <TableCell className="text-right font-bold">{formatINR(record.netSalary)}</TableCell>
                    <TableCell className="text-center">
                      {addKeys.length > 0 ? (
                        <TooltipProvider>
                          <Tooltip>
                            <TooltipTrigger>
                              <Badge variant="outline" className="text-xs">{addKeys.length}</Badge>
                            </TooltipTrigger>
                            <TooltipContent>
                              <div className="flex flex-col gap-1 text-xs">
                                {addKeys.map(k => (
                                  <span key={k}>{k}: {formatINR((record.additionalComponents as any)[k])}</span>
                                ))}
                              </div>
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
