import { useState, ChangeEvent } from 'react';
import { useLocation, Link } from 'wouter';
import { 
  useRequestPayrollUploadUrl, 
  useParsePayrollExcel, 
  useValidatePayroll,
  useImportPayroll,
  useGetColumnMapping,
  useSaveColumnMapping,
  useListPayrollRuns,
  getListPayrollRunsQueryKey
} from '@workspace/api-client-react';
import { formatINR, monthName, MONTHS } from '@/lib/format';
import { useQueryClient } from '@tanstack/react-query';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Label } from '@/components/ui/label';
import { useToast } from '@/hooks/use-toast';
import { CheckCircle2, ChevronRight, FileSpreadsheet, AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';

type Step = 1 | 2 | 3 | 4 | 5;

// Required fields to map
const REQUIRED_FIELDS = [
  { key: 'employeeId', label: 'Employee ID' },
  { key: 'employeeName', label: 'Employee Name' }
];

// Optional fields
const OPTIONAL_FIELDS = [
  { key: 'basic', label: 'Basic' },
  { key: 'da', label: 'DA' },
  { key: 'hra', label: 'HRA' },
  { key: 'otherEarnings', label: 'Other Earnings' },
  { key: 'grossSalary', label: 'Gross Salary' },
  { key: 'pf', label: 'PF' },
  { key: 'esi', label: 'ESI' },
  { key: 'tds', label: 'TDS' },
  { key: 'otherDeductions', label: 'Other Deductions' },
  { key: 'netSalary', label: 'Net Salary' }
];

export default function PayrollWizardPage() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [step, setStep] = useState<Step>(1);
  const [payrollMonth, setPayrollMonth] = useState<number>(new Date().getMonth() + 1);
  const [payrollYear, setPayrollYear] = useState<number>(new Date().getFullYear());
  const [file, setFile] = useState<File | null>(null);
  
  // Step 1 -> 2 state
  const [objectPath, setObjectPath] = useState('');
  const [fileName, setFileName] = useState('');
  const [sheets, setSheets] = useState<string[]>([]);
  const [selectedSheet, setSelectedSheet] = useState('');
  const [excelHeaders, setExcelHeaders] = useState<string[]>([]);
  const [rowCount, setRowCount] = useState(0);
  
  // Step 2 mapping
  const { data: savedMapping } = useGetColumnMapping();
  const saveMappingMut = useSaveColumnMapping();
  const [columnMapping, setColumnMapping] = useState<Record<string, string>>({});
  
  // Step 3 state
  const [validationResult, setValidationResult] = useState<any>(null);
  
  // Step 5 state
  const [completedRunId, setCompletedRunId] = useState<number | null>(null);

  // Mutations
  const reqUrlMut = useRequestPayrollUploadUrl();
  const parseMut = useParsePayrollExcel();
  const validateMut = useValidatePayroll();
  const importMut = useImportPayroll();

  // Reset wizard
  const resetWizard = () => {
    setStep(1);
    setFile(null);
    setObjectPath('');
    setFileName('');
    setSheets([]);
    setSelectedSheet('');
    setExcelHeaders([]);
    setRowCount(0);
    setValidationResult(null);
    setCompletedRunId(null);
  };

  // --- Step 1 Handlers ---
  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      const f = e.target.files[0];
      if (f.size > 20 * 1024 * 1024) {
        toast({ title: 'File too large', description: 'Maximum file size is 20MB.', variant: 'destructive' });
        e.target.value = '';
        setFile(null);
        return;
      }
      setFile(f);
    }
  };

  const handleStep1Next = async () => {
    if (!file) return;
    
    try {
      // 1. Get upload URL
      const { uploadURL, objectPath: path } = await reqUrlMut.mutateAsync({
        data: {
          name: file.name,
          size: file.size,
          contentType: file.type || "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        }
      });
      
      // 2. Upload file directly via fetch (bypassing custom-fetch to avoid JSON parsing/headers)
      const uploadRes = await fetch(uploadURL, {
        method: 'PUT',
        headers: { 'Content-Type': file.type || "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
        body: file
      });
      
      if (!uploadRes.ok) {
        throw new Error('Failed to upload file to storage');
      }
      
      // 3. Parse Excel
      const parseRes = await parseMut.mutateAsync({
        data: { objectPath: path }
      });
      
      setObjectPath(path);
      setFileName(file.name);
      setSheets(parseRes.sheets);
      setSelectedSheet(parseRes.selectedSheet || '');
      setExcelHeaders(parseRes.headers);
      setRowCount(parseRes.rowCount);
      
      // Pre-fill mapping
      const newMapping: Record<string, string> = { ...savedMapping?.mapping };
      
      // Auto-suggest for empty ones
      const allFields = [...REQUIRED_FIELDS, ...OPTIONAL_FIELDS];
      allFields.forEach(f => {
        if (!newMapping[f.key]) {
          const match = parseRes.headers.find(h => h.toLowerCase().replace(/[^a-z0-9]/g, '') === f.label.toLowerCase().replace(/[^a-z0-9]/g, ''));
          if (match) newMapping[f.key] = match;
        }
      });
      
      setColumnMapping(newMapping);
      setStep(2);
    } catch (err: any) {
      toast({ title: 'Upload Failed', description: err.message || 'An error occurred during upload', variant: 'destructive' });
    }
  };

  // --- Step 2 Handlers ---
  const handleSheetChange = async (sheet: string) => {
    setSelectedSheet(sheet);
    try {
      const parseRes = await parseMut.mutateAsync({
        data: { objectPath, sheetName: sheet }
      });
      setExcelHeaders(parseRes.headers);
      setRowCount(parseRes.rowCount);
    } catch (err: any) {
      toast({ title: 'Parse Failed', description: err.message, variant: 'destructive' });
    }
  };

  const handleStep2Next = async () => {
    if (!columnMapping['employeeId'] || !columnMapping['employeeName']) {
      toast({ title: 'Validation Error', description: 'Employee ID and Employee Name must be mapped.', variant: 'destructive' });
      return;
    }
    
    // Save mapping for future
    saveMappingMut.mutate({ data: { mapping: columnMapping } });
    
    try {
      const res = await validateMut.mutateAsync({
        data: {
          objectPath,
          sheetName: selectedSheet,
          columnMapping,
          payrollMonth,
          payrollYear
        }
      });
      
      setValidationResult(res);
      setStep(3);
    } catch (err: any) {
      toast({ title: 'Validation Failed', description: err.message, variant: 'destructive' });
    }
  };

  // --- Step 3 Handlers ---
  const handleStep3Next = () => {
    setStep(4);
  };

  // --- Step 4 Handlers ---
  const handleImport = async (confirmedWithWarnings: boolean) => {
    try {
      const res = await importMut.mutateAsync({
        data: {
          objectPath,
          fileName,
          sheetName: selectedSheet,
          columnMapping,
          payrollMonth,
          payrollYear,
          confirmedWithWarnings
        }
      });
      setCompletedRunId(Number(res.payrollRunId));
      setStep(5);
      queryClient.invalidateQueries({ queryKey: getListPayrollRunsQueryKey() });
    } catch (err: any) {
      toast({ title: 'Import Failed', description: err.message, variant: 'destructive' });
    }
  };

  // Render Helpers
  const isWorking = reqUrlMut.isPending || parseMut.isPending || validateMut.isPending || importMut.isPending;
  const allFields = [...REQUIRED_FIELDS, ...OPTIONAL_FIELDS];
  const unmappedExcelHeaders = excelHeaders.filter(h => !Object.values(columnMapping).includes(h));

  return (
    <div className="space-y-6 max-w-5xl mx-auto" data-testid="page-payroll-wizard">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Upload Payroll</h1>
        <p className="text-muted-foreground mt-1">
          Import payroll data from Excel in 5 easy steps.
        </p>
      </div>

      <div className="flex items-center justify-between mb-8">
        {[1, 2, 3, 4, 5].map((s) => (
          <div key={s} className="flex items-center flex-1 last:flex-none">
            <div className={cn(
              "flex items-center justify-center w-8 h-8 rounded-full border-2 text-sm font-semibold transition-colors",
              step === s ? "border-primary bg-primary text-primary-foreground" :
              step > s ? "border-primary bg-primary text-primary-foreground" :
              "border-muted bg-background text-muted-foreground"
            )}>
              {step > s ? <CheckCircle2 className="w-5 h-5" /> : s}
            </div>
            {s < 5 && (
              <div className={cn(
                "flex-1 h-1 mx-2 transition-colors",
                step > s ? "bg-primary" : "bg-muted"
              )} />
            )}
          </div>
        ))}
      </div>

      {step === 1 && (
        <Card>
          <CardHeader>
            <CardTitle>Step 1: Upload Excel File</CardTitle>
            <CardDescription>Select the payroll period and upload your Excel file (.xlsx, .xls).</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Payroll Month</Label>
                <Select value={payrollMonth.toString()} onValueChange={(v) => setPayrollMonth(parseInt(v))}>
                  <SelectTrigger data-testid="select-month">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {MONTHS.map((m, i) => (
                      <SelectItem key={i+1} value={(i+1).toString()}>{m}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Payroll Year</Label>
                <Input 
                  type="number" 
                  value={payrollYear} 
                  onChange={(e) => setPayrollYear(parseInt(e.target.value))} 
                  min={2000} 
                  max={2100}
                  data-testid="input-year"
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label>File Upload</Label>
              <div className="border-2 border-dashed rounded-md p-8 text-center bg-muted/20">
                <Input 
                  type="file" 
                  accept=".xlsx,.xls" 
                  onChange={handleFileChange} 
                  className="hidden" 
                  id="file-upload" 
                  data-testid="input-file"
                />
                <Label htmlFor="file-upload" className="cursor-pointer flex flex-col items-center">
                  <FileSpreadsheet className="h-10 w-10 text-muted-foreground mb-4" />
                  <span className="text-sm font-medium">Click to select file</span>
                  <span className="text-xs text-muted-foreground mt-1">Excel files up to 20MB</span>
                </Label>
              </div>
              {file && (
                <div className="flex items-center gap-2 mt-4 p-3 bg-secondary rounded-md text-sm">
                  <FileSpreadsheet className="h-4 w-4" />
                  <span className="font-medium truncate">{file.name}</span>
                  <span className="text-muted-foreground">({(file.size / 1024 / 1024).toFixed(2)} MB)</span>
                </div>
              )}
            </div>
          </CardContent>
          <CardFooter className="justify-end border-t p-4">
            <Button onClick={handleStep1Next} disabled={!file || isWorking} data-testid="btn-next-1">
              {isWorking ? 'Uploading...' : 'Next Step'}
              {!isWorking && <ChevronRight className="ml-2 h-4 w-4" />}
            </Button>
          </CardFooter>
        </Card>
      )}

      {step === 2 && (
        <Card>
          <CardHeader>
            <CardTitle>Step 2: Select Worksheet & Map Columns</CardTitle>
            <CardDescription>Tell us which Excel columns correspond to our required payroll fields.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="flex items-center justify-between p-4 bg-muted/30 rounded-md">
              <div className="space-y-1">
                <Label>Selected Worksheet</Label>
                {sheets.length > 1 ? (
                  <Select value={selectedSheet} onValueChange={handleSheetChange}>
                    <SelectTrigger className="w-[250px]" data-testid="select-sheet">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {sheets.map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                    </SelectContent>
                  </Select>
                ) : (
                  <p className="font-medium">{selectedSheet}</p>
                )}
              </div>
              <div className="text-right">
                <p className="text-sm text-muted-foreground">Found Data Rows</p>
                <p className="font-medium text-lg">{rowCount}</p>
              </div>
            </div>

            <div className="space-y-4">
              <h3 className="font-medium">Column Mapping</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {allFields.map((field) => {
                  const isReq = REQUIRED_FIELDS.some(r => r.key === field.key);
                  return (
                    <div key={field.key} className="flex flex-col gap-2">
                      <Label className="flex items-center gap-2">
                        {field.label}
                        {isReq && <span className="text-red-500">*</span>}
                        {isReq && <Badge variant="outline" className="text-[10px] h-4 px-1">Required</Badge>}
                      </Label>
                      <Select 
                        value={columnMapping[field.key] || 'none'} 
                        onValueChange={(v) => setColumnMapping({...columnMapping, [field.key]: v === 'none' ? '' : v})}
                      >
                        <SelectTrigger data-testid={`select-map-${field.key}`}>
                          <SelectValue placeholder="(Not mapped)" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none" className="text-muted-foreground italic">(Not mapped)</SelectItem>
                          {excelHeaders.map(h => (
                            <SelectItem key={h} value={h}>{h}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )
                })}
              </div>
            </div>

            {unmappedExcelHeaders.length > 0 && (
              <div className="space-y-2 pt-4 border-t">
                <Label>Unmapped Excel Columns (will be ignored)</Label>
                <div className="flex flex-wrap gap-2">
                  {unmappedExcelHeaders.map(h => (
                    <Badge key={h} variant="secondary" className="font-normal text-muted-foreground">{h}</Badge>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
          <CardFooter className="justify-between border-t p-4">
            <Button variant="outline" onClick={() => setStep(1)} disabled={isWorking}>Back</Button>
            <Button onClick={handleStep2Next} disabled={isWorking} data-testid="btn-next-2">
              {isWorking ? 'Validating...' : 'Preview & Validate'}
              {!isWorking && <ChevronRight className="ml-2 h-4 w-4" />}
            </Button>
          </CardFooter>
        </Card>
      )}

      {step === 3 && validationResult && (
        <Card>
          <CardHeader>
            <CardTitle>Step 3: Preview & Validate</CardTitle>
            <CardDescription>Review the data before importing. Fix errors in Excel and re-upload if necessary.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {validationResult.existingRunWarning && (
              <div className="p-4 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-md flex items-start gap-3 text-yellow-800 dark:text-yellow-200">
                <AlertTriangle className="h-5 w-5 shrink-0" />
                <div>
                  <p className="font-medium">Warning: Existing Payroll Run</p>
                  <p className="text-sm">{validationResult.existingRunWarning}</p>
                </div>
              </div>
            )}

            {validationResult.duplicateIds?.length > 0 && (
              <div className="p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-md flex items-start gap-3 text-red-800 dark:text-red-200">
                <AlertTriangle className="h-5 w-5 shrink-0" />
                <div>
                  <p className="font-medium">Error: Duplicate Employee IDs</p>
                  <div className="flex flex-wrap gap-2 mt-2">
                    {validationResult.duplicateIds.map((id: string) => (
                      <Badge key={id} variant="destructive">{id}</Badge>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {validationResult.unmappedColumns?.length > 0 && (
              <div className="p-4 bg-muted/50 border rounded-md">
                <p className="font-medium text-sm text-muted-foreground mb-2">Unmapped columns (ignored)</p>
                <div className="flex flex-wrap gap-2">
                  {validationResult.unmappedColumns.map((c: string) => (
                    <Badge key={c} variant="secondary" className="font-normal">{c}</Badge>
                  ))}
                </div>
              </div>
            )}

            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div className="p-4 bg-muted/30 rounded-md border text-center">
                <p className="text-sm text-muted-foreground">Total Rows</p>
                <p className="text-2xl font-bold">{validationResult.summary.totalRows}</p>
              </div>
              <div className="p-4 bg-green-50 dark:bg-green-900/10 border-green-200 dark:border-green-900 rounded-md border text-center">
                <p className="text-sm text-green-700 dark:text-green-400">Valid</p>
                <p className="text-2xl font-bold text-green-700 dark:text-green-400">{validationResult.summary.validRows}</p>
              </div>
              <div className="p-4 bg-yellow-50 dark:bg-yellow-900/10 border-yellow-200 dark:border-yellow-900 rounded-md border text-center">
                <p className="text-sm text-yellow-700 dark:text-yellow-400">Warnings</p>
                <p className="text-2xl font-bold text-yellow-700 dark:text-yellow-400">{validationResult.summary.warningRows}</p>
              </div>
              <div className="p-4 bg-red-50 dark:bg-red-900/10 border-red-200 dark:border-red-900 rounded-md border text-center">
                <p className="text-sm text-red-700 dark:text-red-400">Errors</p>
                <p className="text-2xl font-bold text-red-700 dark:text-red-400">{validationResult.summary.errorRows}</p>
              </div>
            </div>

            <div className="flex gap-8 justify-center py-4 border-y">
              <div className="text-center">
                <p className="text-sm text-muted-foreground">Total Gross</p>
                <p className="font-mono font-medium">{formatINR(validationResult.summary.totalGross)}</p>
              </div>
              <div className="text-center">
                <p className="text-sm text-muted-foreground">Total Deductions</p>
                <p className="font-mono font-medium">{formatINR(validationResult.summary.totalDeductions)}</p>
              </div>
              <div className="text-center">
                <p className="text-sm text-muted-foreground">Net Salary</p>
                <p className="font-mono font-bold text-primary">{formatINR(validationResult.summary.totalNet)}</p>
              </div>
            </div>

            <div className="border rounded-md overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-16">Row</TableHead>
                    <TableHead>Employee ID</TableHead>
                    <TableHead>Name</TableHead>
                    <TableHead className="text-right">Gross</TableHead>
                    <TableHead className="text-right">Deductions</TableHead>
                    <TableHead className="text-right">Net</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {validationResult.rows.slice(0, 100).map((row: any, i: number) => (
                    <TableRow key={i} className={row.errors.length > 0 ? "bg-red-50/50 dark:bg-red-950/20" : row.warnings.length > 0 ? "bg-yellow-50/50 dark:bg-yellow-950/20" : ""}>
                      <TableCell>{row.rowNumber}</TableCell>
                      <TableCell className="font-medium">{row.data.employeeId || '—'}</TableCell>
                      <TableCell>{row.data.employeeName || '—'}</TableCell>
                      <TableCell className="text-right">{formatINR(row.data.grossSalary)}</TableCell>
                      <TableCell className="text-right">{formatINR(row.data.totalDeductions || (row.data.pf + row.data.esi + row.data.tds + row.data.otherDeductions))}</TableCell>
                      <TableCell className="text-right font-bold">{formatINR(row.data.netSalary)}</TableCell>
                      <TableCell>
                        {row.errors.length > 0 ? (
                          <div className="flex flex-col gap-1">
                            <Badge variant="destructive" className="w-fit">Error</Badge>
                            <span className="text-xs text-red-600 truncate max-w-[200px]" title={row.errors.join(', ')}>{row.errors[0]}</span>
                          </div>
                        ) : row.warnings.length > 0 ? (
                          <div className="flex flex-col gap-1">
                            <Badge className="bg-yellow-500 hover:bg-yellow-600 text-white w-fit">Warning</Badge>
                            <span className="text-xs text-yellow-700 truncate max-w-[200px]" title={row.warnings.join(', ')}>{row.warnings[0]}</span>
                          </div>
                        ) : (
                          <Badge className="bg-green-600 text-white hover:bg-green-700">Valid</Badge>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                  {validationResult.rows.length > 100 && (
                    <TableRow>
                      <TableCell colSpan={7} className="text-center text-muted-foreground py-4">
                        ...and {validationResult.rows.length - 100} more rows
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          </CardContent>
          <CardFooter className="justify-between border-t p-4">
            <Button variant="outline" onClick={() => setStep(2)}>Back</Button>
            {validationResult.summary.errorRows > 0 ? (
              <Button disabled variant="secondary" data-testid="btn-import-disabled">
                Fix errors to continue
              </Button>
            ) : validationResult.summary.warningRows > 0 ? (
              <Button onClick={handleStep3Next} className="bg-yellow-600 hover:bg-yellow-700 text-white" data-testid="btn-next-3-warning">
                Continue with Warnings
                <ChevronRight className="ml-2 h-4 w-4" />
              </Button>
            ) : (
              <Button onClick={handleStep3Next} data-testid="btn-next-3">
                Continue to Import
                <ChevronRight className="ml-2 h-4 w-4" />
              </Button>
            )}
          </CardFooter>
        </Card>
      )}

      {step === 4 && validationResult && (
        <Card>
          <CardHeader>
            <CardTitle>Step 4: Confirm Import</CardTitle>
            <CardDescription>Final check before creating the payroll run.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="bg-muted p-6 rounded-lg grid grid-cols-2 gap-8">
              <div className="space-y-4">
                <div>
                  <p className="text-sm text-muted-foreground">Payroll Period</p>
                  <p className="font-semibold text-xl">{monthName(payrollMonth)} {payrollYear}</p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Valid Employees</p>
                  <p className="font-semibold text-xl">{validationResult.summary.validRows + validationResult.summary.warningRows}</p>
                </div>
                {validationResult.summary.warningRows > 0 && (
                  <div>
                    <p className="text-sm text-yellow-600">Importing with {validationResult.summary.warningRows} warnings</p>
                  </div>
                )}
              </div>
              <div className="space-y-4">
                <div>
                  <p className="text-sm text-muted-foreground">Total Gross</p>
                  <p className="font-mono font-medium text-lg">{formatINR(validationResult.summary.totalGross)}</p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Total Deductions</p>
                  <p className="font-mono font-medium text-lg text-muted-foreground">{formatINR(validationResult.summary.totalDeductions)}</p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Total Net Salary</p>
                  <p className="font-mono font-bold text-xl text-primary">{formatINR(validationResult.summary.totalNet)}</p>
                </div>
              </div>
            </div>
          </CardContent>
          <CardFooter className="justify-between border-t p-4">
            <Button variant="outline" onClick={() => setStep(3)} disabled={isWorking}>Cancel</Button>
            <Button 
              onClick={() => handleImport(validationResult.summary.warningRows > 0)} 
              disabled={isWorking}
              data-testid="btn-confirm-import"
            >
              {isWorking ? 'Importing...' : 'Confirm Import'}
            </Button>
          </CardFooter>
        </Card>
      )}

      {step === 5 && (
        <Card className="text-center py-12">
          <CardContent className="space-y-6 flex flex-col items-center">
            <div className="w-16 h-16 bg-green-100 text-green-600 rounded-full flex items-center justify-center">
              <CheckCircle2 className="w-8 h-8" />
            </div>
            <div className="space-y-2">
              <h2 className="text-2xl font-bold">Import Successful</h2>
              <p className="text-muted-foreground">Your payroll data has been imported successfully.</p>
            </div>
            <div className="flex gap-4 pt-4">
              <Button variant="outline" onClick={resetWizard} data-testid="btn-upload-another">
                Upload Another
              </Button>
              <Button asChild data-testid="btn-view-run">
                <Link href={`/payroll/runs/${completedRunId}`}>View Payroll Run</Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
