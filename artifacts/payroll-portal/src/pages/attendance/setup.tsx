import { useEffect, useRef, useState } from 'react';
import { ShieldAlert, TestTube2 } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ApiError, type SetupTab } from './api';
import { CampusesTab } from './campuses-tab';
import { EmployeesTab } from './employees-tab';
import { SettingsTab } from './settings-tab';
import { SetupChecklist } from './setup-checklist';
import { ShiftsTab } from './shifts-tab';
import { errorText, useMe, useSetupStatus } from './use-attendance';

type Tab = Exclude<SetupTab, 'system'>;

/** Shown instead of the page when the module is off (404) or the user has no role (403). */
export function AccessMessage({ error }: { error: unknown }) {
  const status = error instanceof ApiError ? error.status : 0;
  if (status === 404) {
    return (
      <Alert data-testid="attendance-off">
        <ShieldAlert className="h-4 w-4" />
        <AlertTitle>Attendance is not switched on yet</AlertTitle>
        <AlertDescription>
          An administrator needs to set ATTENDANCE_ENABLED=true in the Netlify settings for this site, then redeploy.
        </AlertDescription>
      </Alert>
    );
  }
  if (status === 403) {
    return (
      <Alert variant="destructive" data-testid="attendance-no-access">
        <ShieldAlert className="h-4 w-4" />
        <AlertTitle>You do not have access to attendance</AlertTitle>
        <AlertDescription>Ask the Director to give your login access.</AlertDescription>
      </Alert>
    );
  }
  return <Alert variant="destructive"><AlertDescription>{errorText(error)}</AlertDescription></Alert>;
}

export default function AttendanceSetupPage() {
  const me = useMe();
  const status = useSetupStatus();
  const [tab, setTab] = useState<Tab>('campuses');
  const picked = useRef(false);

  // Open the first tab that still has something to do (once, when the checklist first loads).
  useEffect(() => {
    if (picked.current || !status.data) return;
    picked.current = true;
    const next = status.data.items.find(i => !i.done && i.tab !== 'system');
    if (next) setTab(next.tab as Tab);
  }, [status.data]);

  if (me.isLoading) {
    return <div className="space-y-6"><Skeleton className="h-10 w-64" /><Skeleton className="h-48 w-full" /></div>;
  }
  if (me.isError) return <AccessMessage error={me.error} />;

  return (
    <div className="space-y-6" data-testid="page-attendance-setup">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Attendance Setup</h1>
        <p className="mt-1 text-muted-foreground">Campuses, shifts, employees and alerts. Everything here can be changed at any time.</p>
      </div>

      {me.data?.whatsappMode === 'stub' && (
        <Alert data-testid="stub-banner">
          <TestTube2 className="h-4 w-4" />
          <AlertTitle>WhatsApp is in test mode</AlertTitle>
          <AlertDescription>Messages are recorded but not actually sent until live mode is switched on in the server settings.</AlertDescription>
        </Alert>
      )}

      {status.data && <SetupChecklist items={status.data.items} onOpenTab={setTab} />}

      <Tabs value={tab} onValueChange={v => setTab(v as Tab)}>
        <TabsList className="h-auto w-full flex-wrap justify-start sm:w-auto">
          <TabsTrigger value="campuses">Campuses</TabsTrigger>
          <TabsTrigger value="shifts">Shifts</TabsTrigger>
          <TabsTrigger value="employees">Employees</TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
        </TabsList>
        <TabsContent value="campuses" className="mt-4"><CampusesTab /></TabsContent>
        <TabsContent value="shifts" className="mt-4"><ShiftsTab /></TabsContent>
        <TabsContent value="employees" className="mt-4"><EmployeesTab /></TabsContent>
        <TabsContent value="settings" className="mt-4"><SettingsTab /></TabsContent>
      </Tabs>
    </div>
  );
}
