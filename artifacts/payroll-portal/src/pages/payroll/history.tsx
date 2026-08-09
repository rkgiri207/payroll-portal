import { useState, useMemo } from 'react';
import { useLocation, Link } from 'wouter';
import { useListPayrollRuns, getListPayrollRunsQueryKey } from '@workspace/api-client-react';
import { formatDate, formatINR, monthName } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { UploadCloud, Eye } from 'lucide-react';

export default function PayrollHistoryPage() {
  const [, setLocation] = useLocation();
  const [statusFilter, setStatusFilter] = useState('all');

  const queryParams = useMemo(() => {
    const p: any = {};
    if (statusFilter && statusFilter !== 'all') p.status = statusFilter;
    return p;
  }, [statusFilter]);

  const { data, isLoading } = useListPayrollRuns(queryParams, {
    query: { queryKey: getListPayrollRunsQueryKey(queryParams) }
  });

  const runs = data?.runs || [];

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
    <div className="space-y-6" data-testid="page-payroll-history">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Payroll History</h1>
          <p className="text-muted-foreground mt-1">
            View past payroll runs and their processing status.
          </p>
        </div>
        <Button onClick={() => setLocation('/payroll')} data-testid="btn-upload-payroll">
          <UploadCloud className="mr-2 h-4 w-4" />
          Upload Payroll
        </Button>
      </div>

      <div className="flex items-center gap-4 bg-card p-4 rounded-md border w-full sm:w-auto">
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-full sm:w-[200px]" data-testid="select-status-filter">
            <SelectValue placeholder="Filter by Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Statuses</SelectItem>
            <SelectItem value="IMPORTED">Imported</SelectItem>
            <SelectItem value="VALIDATED">Validated</SelectItem>
            <SelectItem value="DRAFT">Draft</SelectItem>
            <SelectItem value="CANCELLED">Cancelled</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="bg-card rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Period</TableHead>
              <TableHead className="text-right">Employees</TableHead>
              <TableHead className="text-right">Gross</TableHead>
              <TableHead className="text-right">Deductions</TableHead>
              <TableHead className="text-right">Net Salary</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Uploaded By</TableHead>
              <TableHead>Date</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              Array.from({length: 5}).map((_, i) => (
                <TableRow key={i}>
                  <TableCell><Skeleton className="h-4 w-24" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-8 ml-auto" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-20 ml-auto" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-20 ml-auto" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-20 ml-auto" /></TableCell>
                  <TableCell><Skeleton className="h-6 w-20 rounded-full" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-24" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-20" /></TableCell>
                  <TableCell><Skeleton className="h-8 w-16 ml-auto" /></TableCell>
                </TableRow>
              ))
            ) : runs.length === 0 ? (
              <TableRow>
                <TableCell colSpan={9} className="h-32 text-center text-muted-foreground">
                  No payroll runs yet. Upload your first payroll to get started.
                  <div className="mt-4">
                    <Button variant="outline" onClick={() => setLocation('/payroll')} data-testid="btn-empty-upload">
                      <UploadCloud className="mr-2 h-4 w-4" />
                      Upload Payroll
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              runs.map((run) => (
                <TableRow key={run.id} data-testid={`row-run-${run.id}`}>
                  <TableCell className="font-medium">{monthName(run.payrollMonth)} {run.payrollYear}</TableCell>
                  <TableCell className="text-right">{run.employeeCount || 0}</TableCell>
                  <TableCell className="text-right text-muted-foreground">{formatINR(run.totalGross)}</TableCell>
                  <TableCell className="text-right text-muted-foreground">{formatINR(run.totalDeductions)}</TableCell>
                  <TableCell className="text-right font-medium">{formatINR(run.totalNet)}</TableCell>
                  <TableCell>{getStatusBadge(run.status)}</TableCell>
                  <TableCell>{run.uploadedByName || 'System'}</TableCell>
                  <TableCell>{formatDate(run.createdAt)}</TableCell>
                  <TableCell className="text-right">
                    <Button variant="ghost" size="sm" asChild data-testid={`btn-view-${run.id}`}>
                      <Link href={`/payroll/runs/${run.id}`}>
                        <Eye className="mr-2 h-4 w-4" />
                        View
                      </Link>
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
