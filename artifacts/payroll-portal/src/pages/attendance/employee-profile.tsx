import { useQuery } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import { Link, useParams } from 'wouter';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { adminGet, type EmployeeProfile } from './api';
import { FeedList } from './dashboard-lists';
import { formatDay } from './dashboard-helpers';
import { AccessMessage } from './setup';
import { errorText, keys } from './use-attendance';

/** Basic employee profile. Monthly statistics, calendar and history come in a later phase. */
export function ProfileView({ profile }: { profile: EmployeeProfile }) {
  const e = profile.employee;
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">{e.employeeName}</h1>
        <p className="mt-1 text-muted-foreground">
          {e.employeeCode}{e.designation ? ` · ${e.designation}` : ''}{e.branch ? ` · ${e.branch}` : ''}
          {e.status !== 'ACTIVE' && <Badge variant="secondary" className="ml-2">Inactive</Badge>}
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">Attendance registration</CardTitle></CardHeader>
          <CardContent className="space-y-1 text-sm">
            <p>WhatsApp number: {profile.registration?.whatsapp ?? <span className="text-muted-foreground">Not registered</span>}</p>
            <p>Marks attendance: {profile.registration?.attendanceApplicable === false ? 'No' : 'Yes'}</p>
            <p>Works during school vacations: {profile.registration?.reportsDuringVacations ? 'Yes' : 'No'}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">Campus</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            {profile.assignments.length === 0 ? <p className="text-muted-foreground">No campus assigned.</p> : profile.assignments.map(a => (
              <p key={a.id}>
                <span className="font-medium">{a.campusName}</span>{' '}
                <Badge variant={a.kind === 'PRIMARY' ? 'default' : 'outline'}>{a.kind === 'PRIMARY' ? 'Main' : 'Temporary'}</Badge>
                <span className="block text-xs text-muted-foreground">From {formatDay(a.startDate)}{a.endDate ? ` to ${formatDay(a.endDate)}` : ''}</span>
              </p>
            ))}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Recent attendance</CardTitle>
          <CardDescription>The latest check-ins and check-outs. Monthly statistics and the full history arrive in a later phase.</CardDescription>
        </CardHeader>
        <CardContent>
          <FeedList events={profile.recentEvents} showSelfie={false} empty="No attendance recorded yet." />
        </CardContent>
      </Card>
    </div>
  );
}

export default function EmployeeProfilePage() {
  const params = useParams<{ id: string }>();
  const id = Number(params.id);
  const profile = useQuery({
    queryKey: keys.profile(id),
    queryFn: () => adminGet<EmployeeProfile>(`/employees/${id}/profile`),
    enabled: Number.isInteger(id) && id > 0, retry: false,
  });

  return (
    <div className="space-y-6" data-testid="page-attendance-profile">
      <Link href="/attendance" className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" />Back to attendance
      </Link>
      {profile.isLoading ? <Skeleton className="h-64 w-full" /> : profile.isError ? (
        profile.error && (profile.error as { status?: number }).status === 404
          ? <Alert variant="destructive"><AlertDescription>Employee not found.</AlertDescription></Alert>
          : <AccessMessage error={profile.error} />
      ) : profile.data ? <ProfileView profile={profile.data} /> : <Alert variant="destructive"><AlertDescription>{errorText(null)}</AlertDescription></Alert>}
    </div>
  );
}
