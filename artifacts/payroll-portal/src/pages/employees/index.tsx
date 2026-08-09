import { useState, useEffect, useMemo, FormEvent } from 'react';
import { useLocation } from 'wouter';
import { 
  useListEmployees, 
  useCreateEmployee, 
  useUpdateEmployee,
  useUpdateEmployeeStatus,
  getListEmployeesQueryKey
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { formatDate } from '@/lib/format';
import { Employee, EmployeeInput } from '@workspace/api-client-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { 
  Table, 
  TableBody, 
  TableCell, 
  TableHead, 
  TableHeader, 
  TableRow 
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Label } from '@/components/ui/label';
import { Search, Plus, Edit, ToggleLeft, ToggleRight } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { Skeleton } from '@/components/ui/skeleton';

export default function EmployeesPage() {
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [branchFilter, setBranchFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const queryParams = useMemo(() => {
    const p: any = {};
    if (debouncedSearch) p.search = debouncedSearch;
    if (branchFilter && branchFilter !== 'all') p.branch = branchFilter;
    if (statusFilter && statusFilter !== 'all') p.status = statusFilter;
    return p;
  }, [debouncedSearch, branchFilter, statusFilter]);

  const { data, isLoading } = useListEmployees(queryParams, {
    query: { queryKey: getListEmployeesQueryKey(queryParams) }
  });

  const employees = data?.employees || [];
  const uniqueBranches = Array.from(new Set(employees.map(e => e.branch).filter(Boolean))) as string[];

  // Dialog state
  const [isAddEditOpen, setIsAddEditOpen] = useState(false);
  const [isViewOpen, setIsViewOpen] = useState(false);
  const [selectedEmployee, setSelectedEmployee] = useState<Employee | null>(null);
  
  // Alert Dialog state
  const [isAlertOpen, setIsAlertOpen] = useState(false);
  const [employeeToToggle, setEmployeeToToggle] = useState<Employee | null>(null);

  const handleOpenAdd = () => {
    setSelectedEmployee(null);
    setIsAddEditOpen(true);
  };

  const handleOpenEdit = (e: Employee) => {
    setSelectedEmployee(e);
    setIsAddEditOpen(true);
  };

  const handleOpenView = (e: Employee) => {
    setSelectedEmployee(e);
    setIsViewOpen(true);
  };

  const handleOpenToggle = (e: Employee) => {
    setEmployeeToToggle(e);
    setIsAlertOpen(true);
  };

  return (
    <div className="space-y-6" data-testid="page-employees">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Employees</h1>
          <p className="text-muted-foreground mt-1">
            Manage your workforce and their details.
          </p>
        </div>
        <Button onClick={handleOpenAdd} data-testid="button-add-employee">
          <Plus className="mr-2 h-4 w-4" />
          Add Employee
        </Button>
      </div>

      <div className="flex flex-col sm:flex-row items-center gap-4 bg-card p-4 rounded-md border">
        <div className="relative flex-1 w-full">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input 
            placeholder="Search by name, code, designation..." 
            className="pl-9 w-full"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            data-testid="input-search-employee"
          />
        </div>
        <Select value={branchFilter} onValueChange={setBranchFilter}>
          <SelectTrigger className="w-full sm:w-[200px]" data-testid="select-filter-branch">
            <SelectValue placeholder="Branch" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Branches</SelectItem>
            {uniqueBranches.map(b => (
              <SelectItem key={b} value={b}>{b}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-full sm:w-[150px]" data-testid="select-filter-status">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Status</SelectItem>
            <SelectItem value="ACTIVE">Active</SelectItem>
            <SelectItem value="INACTIVE">Inactive</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="bg-card rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Employee ID</TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Designation</TableHead>
              <TableHead>Branch</TableHead>
              <TableHead>Joining Date</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              Array.from({length: 5}).map((_, i) => (
                <TableRow key={i}>
                  <TableCell><Skeleton className="h-4 w-16" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-32" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-24" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-20" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-24" /></TableCell>
                  <TableCell><Skeleton className="h-6 w-16 rounded-full" /></TableCell>
                  <TableCell><Skeleton className="h-8 w-20 ml-auto" /></TableCell>
                </TableRow>
              ))
            ) : employees.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="h-32 text-center text-muted-foreground">
                  No employees added yet. Add your first employee to get started.
                </TableCell>
              </TableRow>
            ) : (
              employees.map((employee) => (
                <TableRow key={employee.id} data-testid={`row-employee-${employee.id}`}>
                  <TableCell className="font-medium">{employee.employeeCode}</TableCell>
                  <TableCell>
                    <button 
                      className="hover:underline text-primary" 
                      onClick={() => handleOpenView(employee)}
                      data-testid={`link-employee-${employee.id}`}
                    >
                      {employee.employeeName}
                    </button>
                  </TableCell>
                  <TableCell>{employee.designation || '—'}</TableCell>
                  <TableCell>{employee.branch || '—'}</TableCell>
                  <TableCell>{formatDate(employee.joiningDate)}</TableCell>
                  <TableCell>
                    <Badge variant={employee.status === 'ACTIVE' ? 'default' : 'secondary'} className={employee.status === 'ACTIVE' ? 'bg-green-600 hover:bg-green-600/80 text-white' : ''}>
                      {employee.status === 'ACTIVE' ? 'Active' : 'Inactive'}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-2">
                      <Button variant="ghost" size="icon" onClick={() => handleOpenEdit(employee)} data-testid={`btn-edit-${employee.id}`} title="Edit">
                        <Edit className="h-4 w-4" />
                      </Button>
                      <Button variant="ghost" size="icon" onClick={() => handleOpenToggle(employee)} data-testid={`btn-toggle-${employee.id}`} title={employee.status === 'ACTIVE' ? 'Deactivate' : 'Activate'}>
                        {employee.status === 'ACTIVE' ? <ToggleRight className="h-4 w-4 text-green-600" /> : <ToggleLeft className="h-4 w-4 text-muted-foreground" />}
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <EmployeeFormDialog 
        open={isAddEditOpen} 
        onOpenChange={setIsAddEditOpen} 
        employee={selectedEmployee} 
        queryParams={queryParams}
      />

      <EmployeeViewDialog 
        open={isViewOpen} 
        onOpenChange={setIsViewOpen} 
        employee={selectedEmployee} 
      />

      {employeeToToggle && (
        <ToggleStatusDialog 
          open={isAlertOpen} 
          onOpenChange={setIsAlertOpen} 
          employee={employeeToToggle} 
          queryParams={queryParams}
        />
      )}
    </div>
  );
}

function EmployeeFormDialog({ 
  open, 
  onOpenChange, 
  employee,
  queryParams
}: { 
  open: boolean; 
  onOpenChange: (open: boolean) => void; 
  employee: Employee | null;
  queryParams: any;
}) {
  const isEdit = !!employee;
  const { toast } = useToast();
  const queryClient = useQueryClient();
  
  const [formData, setFormData] = useState<EmployeeInput>({
    employeeCode: '',
    employeeName: '',
    mobileNumber: '',
    email: '',
    designation: '',
    branch: '',
    joiningDate: '',
    status: 'ACTIVE'
  });

  useEffect(() => {
    if (open) {
      if (employee) {
        setFormData({
          employeeCode: employee.employeeCode,
          employeeName: employee.employeeName,
          mobileNumber: employee.mobileNumber || '',
          email: employee.email || '',
          designation: employee.designation || '',
          branch: employee.branch || '',
          joiningDate: employee.joiningDate ? employee.joiningDate.split('T')[0] : '',
          status: employee.status
        });
      } else {
        setFormData({
          employeeCode: '',
          employeeName: '',
          mobileNumber: '',
          email: '',
          designation: '',
          branch: '',
          joiningDate: '',
          status: 'ACTIVE'
        });
      }
    }
  }, [open, employee]);

  const createMut = useCreateEmployee();
  const updateMut = useUpdateEmployee();

  const isPending = createMut.isPending || updateMut.isPending;

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!formData.employeeCode || !formData.employeeName) {
      toast({ title: 'Validation Error', description: 'Employee Code and Name are required.', variant: 'destructive' });
      return;
    }

    const payload: EmployeeInput = {
      ...formData,
      joiningDate: formData.joiningDate ? new Date(formData.joiningDate).toISOString() : undefined,
    };

    if (isEdit && employee) {
      updateMut.mutate({ id: employee.id, data: payload }, {
        onSuccess: () => {
          toast({ title: 'Success', description: 'Employee updated successfully.' });
          queryClient.invalidateQueries({ queryKey: getListEmployeesQueryKey(queryParams) });
          onOpenChange(false);
        },
        onError: (err: any) => {
          toast({ title: 'Error', description: err?.message || 'Failed to update employee.', variant: 'destructive' });
        }
      });
    } else {
      createMut.mutate({ data: payload }, {
        onSuccess: () => {
          toast({ title: 'Success', description: 'Employee created successfully.' });
          queryClient.invalidateQueries({ queryKey: getListEmployeesQueryKey(queryParams) });
          onOpenChange(false);
        },
        onError: (err: any) => {
          toast({ title: 'Error', description: err?.message || 'Failed to create employee.', variant: 'destructive' });
        }
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{isEdit ? 'Edit Employee' : 'Add Employee'}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="employeeCode">Employee Code <span className="text-red-500">*</span></Label>
                <Input 
                  id="employeeCode" 
                  value={formData.employeeCode} 
                  onChange={e => setFormData({...formData, employeeCode: e.target.value})}
                  required 
                  data-testid="input-employee-code"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="employeeName">Employee Name <span className="text-red-500">*</span></Label>
                <Input 
                  id="employeeName" 
                  value={formData.employeeName} 
                  onChange={e => setFormData({...formData, employeeName: e.target.value})}
                  required 
                  data-testid="input-employee-name"
                />
              </div>
            </div>
            
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="mobileNumber">Mobile Number</Label>
                <Input 
                  id="mobileNumber" 
                  value={formData.mobileNumber} 
                  onChange={e => setFormData({...formData, mobileNumber: e.target.value})}
                  placeholder="Used for WhatsApp payslip"
                  data-testid="input-mobile"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input 
                  id="email" 
                  type="email"
                  value={formData.email} 
                  onChange={e => setFormData({...formData, email: e.target.value})}
                  data-testid="input-email"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="designation">Designation</Label>
                <Input 
                  id="designation" 
                  value={formData.designation} 
                  onChange={e => setFormData({...formData, designation: e.target.value})}
                  data-testid="input-designation"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="branch">Branch</Label>
                <Input 
                  id="branch" 
                  value={formData.branch} 
                  onChange={e => setFormData({...formData, branch: e.target.value})}
                  data-testid="input-branch"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="joiningDate">Joining Date</Label>
                <Input 
                  id="joiningDate" 
                  type="date"
                  value={formData.joiningDate} 
                  onChange={e => setFormData({...formData, joiningDate: e.target.value})}
                  data-testid="input-joining-date"
                />
              </div>
              {isEdit && (
                <div className="space-y-2">
                  <Label htmlFor="status">Status</Label>
                  <Select 
                    value={formData.status} 
                    onValueChange={(v: "ACTIVE" | "INACTIVE") => setFormData({...formData, status: v})}
                  >
                    <SelectTrigger id="status" data-testid="select-status">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="ACTIVE">Active</SelectItem>
                      <SelectItem value="INACTIVE">Inactive</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
              Cancel
            </Button>
            <Button type="submit" disabled={isPending} data-testid="btn-save-employee">
              {isPending ? 'Saving...' : 'Save Employee'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function EmployeeViewDialog({ 
  open, 
  onOpenChange, 
  employee 
}: { 
  open: boolean; 
  onOpenChange: (open: boolean) => void; 
  employee: Employee | null;
}) {
  if (!employee) return null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Employee Details</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="grid grid-cols-2 gap-y-4 text-sm">
            <div>
              <p className="text-muted-foreground">Employee Code</p>
              <p className="font-medium" data-testid="view-employee-code">{employee.employeeCode}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Name</p>
              <p className="font-medium" data-testid="view-employee-name">{employee.employeeName}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Mobile</p>
              <p className="font-medium">{employee.mobileNumber || '—'}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Email</p>
              <p className="font-medium">{employee.email || '—'}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Designation</p>
              <p className="font-medium">{employee.designation || '—'}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Branch</p>
              <p className="font-medium">{employee.branch || '—'}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Joining Date</p>
              <p className="font-medium">{formatDate(employee.joiningDate)}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Status</p>
              <Badge variant={employee.status === 'ACTIVE' ? 'default' : 'secondary'} className={employee.status === 'ACTIVE' ? 'bg-green-600 hover:bg-green-600/80 text-white' : ''}>
                {employee.status === 'ACTIVE' ? 'Active' : 'Inactive'}
              </Badge>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ToggleStatusDialog({ 
  open, 
  onOpenChange, 
  employee,
  queryParams
}: { 
  open: boolean; 
  onOpenChange: (open: boolean) => void; 
  employee: Employee;
  queryParams: any;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const toggleMut = useUpdateEmployeeStatus();
  
  const newStatus = employee.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE';
  
  const handleConfirm = () => {
    toggleMut.mutate({ id: employee.id, data: { status: newStatus } }, {
      onSuccess: () => {
        toast({ title: 'Success', description: `Employee marked as ${newStatus.toLowerCase()}.` });
        queryClient.invalidateQueries({ queryKey: getListEmployeesQueryKey(queryParams) });
        onOpenChange(false);
      },
      onError: (err: any) => {
        toast({ title: 'Error', description: err?.message || 'Failed to change status.', variant: 'destructive' });
      }
    });
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Change Employee Status</AlertDialogTitle>
          <AlertDialogDescription>
            Are you sure you want to {newStatus === 'ACTIVE' ? 'activate' : 'deactivate'} {employee.employeeName}?
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={toggleMut.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction 
            onClick={handleConfirm} 
            disabled={toggleMut.isPending}
            className={newStatus === 'INACTIVE' ? 'bg-red-600 hover:bg-red-700' : 'bg-green-600 hover:bg-green-700'}
            data-testid="btn-confirm-toggle"
          >
            {toggleMut.isPending ? 'Saving...' : 'Confirm'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
