import { useEffect, useState } from 'react';
import { CalendarPlus } from 'lucide-react';
import { Link } from 'wouter';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { AccrualTab } from './accrual-tab';
import { AllocationsTab } from './allocations-tab';
import { formatRange } from './holiday-helpers';
import { LeaveTypesTab } from './leave-types-tab';
import { useAcademicYears } from './leave-api';
import { PolicyTab } from './policy-tab';
import { AccessMessage } from './setup';
import { useMe } from './use-attendance';

type Tab = 'policy' | 'allocations' | 'accrual' | 'types';

/** Pick the academic year that is running today, else the newest. */
function defaultYearId(years: { id: number; startDate: string; endDate: string }[]): number | null {
  const today = new Date().toISOString().slice(0, 10);
  return (years.find(y => y.startDate <= today && today <= y.endDate) ?? years[0])?.id ?? null;
}

export default function LeavePoliciesPage() {
  const me = useMe();
  const years = useAcademicYears();
  const [yearId, setYearId] = useState<number | null>(null);
  const [tab, setTab] = useState<Tab>('policy');

  useEffect(() => {
    if (yearId === null && years.data && years.data.length > 0) setYearId(defaultYearId(years.data));
  }, [years.data, yearId]);

  if (me.isLoading || years.isLoading) return <div className="space-y-6"><Skeleton className="h-10 w-64" /><Skeleton className="h-48 w-full" /></div>;
  if (me.isError) return <AccessMessage error={me.error} />;
  if (years.isError) return <AccessMessage error={years.error} />;

  const year = years.data!.find(y => y.id === yearId) ?? null;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Leave policies</h1>
        <p className="text-sm text-muted-foreground">
          How leave is given, carried forward and handled when the balance runs out. Everything follows your academic year.
        </p>
      </div>

      {years.data!.length === 0 ? (
        <Alert>
          <CalendarPlus className="h-4 w-4" />
          <AlertTitle>Set up an academic year first</AlertTitle>
          <AlertDescription>
            Leave rules belong to an academic year. <Link href="/leave/calendar" className="underline">Open the holiday calendar</Link> to
            add one or import the Andhra Pradesh calendar.
          </AlertDescription>
        </Alert>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-sm font-medium">Academic year</span>
            <Select value={yearId === null ? undefined : String(yearId)} onValueChange={v => setYearId(Number(v))}>
              <SelectTrigger className="w-48" aria-label="Academic year"><SelectValue placeholder="Choose a year" /></SelectTrigger>
              <SelectContent>{years.data!.map(y => <SelectItem key={y.id} value={String(y.id)}>{y.label}</SelectItem>)}</SelectContent>
            </Select>
            {year && <span className="text-sm text-muted-foreground">{formatRange(year.startDate, year.endDate)}</span>}
          </div>

          {year && (
            <Tabs value={tab} onValueChange={v => setTab(v as Tab)}>
              <TabsList>
                <TabsTrigger value="policy">Policy for {year.label}</TabsTrigger>
                <TabsTrigger value="allocations">Allocations</TabsTrigger>
                <TabsTrigger value="accrual">Accrual and opening balances</TabsTrigger>
                <TabsTrigger value="types">Leave types</TabsTrigger>
              </TabsList>
              <TabsContent value="policy" className="mt-4">
                <PolicyTab year={year} otherYears={years.data!.filter(y => y.id !== year.id)} />
              </TabsContent>
              <TabsContent value="allocations" className="mt-4"><AllocationsTab year={year} /></TabsContent>
              <TabsContent value="accrual" className="mt-4"><AccrualTab year={year} /></TabsContent>
              <TabsContent value="types" className="mt-4"><LeaveTypesTab /></TabsContent>
            </Tabs>
          )}
        </>
      )}
    </div>
  );
}
