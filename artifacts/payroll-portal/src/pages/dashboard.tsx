import * as React from "react"
import { 
  Users, 
  Banknote, 
  FileText, 
  Activity,
  ArrowRight
} from "lucide-react"

import { useGetDashboardStats } from "@workspace/api-client-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { formatDate } from "@/lib/utils"
import { Link } from "wouter"

export default function DashboardPage() {
  const { data: stats, isLoading } = useGetDashboardStats()

  return (
    <div className="space-y-8" data-testid="page-dashboard">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Overview</h1>
        <p className="text-muted-foreground mt-1">
          Key metrics and recent administrative actions.
        </p>
      </div>

      {/* Stats Grid */}
      <div className="grid gap-4 md:grid-cols-3">
        <StatCard 
          title="Total Employees" 
          value={stats?.totalEmployees} 
          icon={Users} 
          isLoading={isLoading} 
          emptyMessage="No employees found"
          testid="stat-employees"
          href="/employees"
        />
        <StatCard 
          title="Payroll Runs" 
          value={stats?.payrollRuns} 
          icon={Banknote} 
          isLoading={isLoading} 
          emptyMessage="No runs executed"
          testid="stat-payroll-runs"
          href="/payroll/history"
        />
        <StatCard 
          title="Payslips Generated" 
          value={stats?.payslipsGenerated} 
          icon={FileText} 
          isLoading={isLoading} 
          emptyMessage="No payslips yet"
          testid="stat-payslips"
          href="/payslips"
        />
      </div>

      {/* Recent Activity */}
      <Card className="col-span-full">
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <div className="space-y-1">
            <CardTitle>Recent Activity</CardTitle>
            <p className="text-sm text-muted-foreground">
              Audit log of recent system events
            </p>
          </div>
          <Activity className="h-4 w-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-4 mt-4">
              {[1, 2, 3].map((i) => (
                <div key={i} className="flex items-center space-x-4">
                  <Skeleton className="h-10 w-10 rounded-full" />
                  <div className="space-y-2 flex-1">
                    <Skeleton className="h-4 w-[250px]" />
                    <Skeleton className="h-4 w-[200px]" />
                  </div>
                </div>
              ))}
            </div>
          ) : !stats?.recentActivity?.length ? (
            <div className="flex flex-col items-center justify-center py-12 text-center" data-testid="empty-activity">
              <div className="rounded-full bg-muted p-3 mb-4">
                <Activity className="h-6 w-6 text-muted-foreground" />
              </div>
              <h3 className="text-lg font-semibold">No recent activity</h3>
              <p className="text-sm text-muted-foreground max-w-sm mt-1">
                When administrative actions occur in the system, they will appear in this audit log.
              </p>
            </div>
          ) : (
            <div className="space-y-6 mt-4">
              {stats.recentActivity.map((log) => (
                <div key={log.id} className="flex items-start gap-4" data-testid={`activity-item-${log.id}`}>
                  <div className="mt-1 flex h-8 w-8 items-center justify-center rounded-full border bg-background">
                    <ArrowRight className="h-4 w-4 text-muted-foreground" />
                  </div>
                  <div className="flex-1 space-y-1">
                    <p className="text-sm font-medium leading-none">
                      {log.action}
                      {log.entityType && (
                        <span className="text-muted-foreground font-normal">
                          {" "}on {log.entityType} {log.entityId ? `#${log.entityId}` : ""}
                        </span>
                      )}
                    </p>
                    <p className="text-sm text-muted-foreground">
                      {log.details || "No additional details"}
                    </p>
                    <div className="flex items-center gap-2 pt-1">
                      <span className="text-xs font-medium bg-muted px-2 py-0.5 rounded-md">
                        {log.performedByName || "System"}
                      </span>
                      <span className="text-xs text-muted-foreground font-mono">
                        {formatDate(log.performedAt)}
                      </span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function StatCard({ 
  title, 
  value, 
  icon: Icon, 
  isLoading, 
  emptyMessage,
  testid,
  href,
}: { 
  title: string
  value?: number
  icon: React.ElementType
  isLoading: boolean
  emptyMessage: string
  testid: string
  href: string
}) {
  return (
    <Link href={href} className="block rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" data-testid={`${testid}-link`}>
    <Card data-testid={testid} className="h-full cursor-pointer transition-colors hover:bg-muted/40">
      <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          {title}
        </CardTitle>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-8 w-[100px] mt-2" />
        ) : (
          <div className="mt-2 flex flex-col gap-1">
            <span className="text-3xl font-bold font-mono tracking-tight">
              {value || 0}
            </span>
            {value === 0 && (
              <span className="text-xs text-muted-foreground font-medium">
                {emptyMessage}
              </span>
            )}
          </div>
        )}
      </CardContent>
    </Card>
    </Link>
  )
}
