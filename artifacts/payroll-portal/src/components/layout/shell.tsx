import { useEffect, ReactNode } from "react"
import { Link, useLocation } from "wouter"
import { 
  Building2, 
  Banknote, 
  FileText, 
  Settings, 
  LogOut,
  LayoutDashboard,
  History
} from "lucide-react"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { useLogout, useGetCompanySettings, useGetMe, getGetMeQueryKey } from "@workspace/api-client-react"
import { useQueryClient } from "@tanstack/react-query"

const NAV_ITEMS = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/payroll", label: "Upload Payroll", icon: Banknote },
  { href: "/payroll/history", label: "Payroll History", icon: History },
  { href: "/payslips", label: "Payslips", icon: FileText },
]

export function LayoutShell({ children }: { children: ReactNode }) {
  const [location, setLocation] = useLocation()
  const queryClient = useQueryClient()
  const { data: user, isLoading: isUserLoading, isError: isUserError } = useGetMe()
  const { data: settings } = useGetCompanySettings()
  
  const logout = useLogout({
    mutation: {
      onSuccess: () => {
        queryClient.setQueryData(getGetMeQueryKey(), null);
        setLocation("/login")
      }
    }
  })

  // If not logged in and we're done checking, redirect
  useEffect(() => {
    if (!isUserLoading && (isUserError || !user) && location !== "/login") {
      setLocation("/login")
    }
  }, [user, isUserLoading, isUserError, location, setLocation])

  if (isUserLoading || !user) {
    return null; // Wait for redirect or loading
  }

  const handleLogout = () => {
    logout.mutate()
  }

  const companyName = settings?.companyName || "Payroll Portal"
  const logoUrl = settings?.logoPath ? `/api/storage${settings.logoPath}` : null

  return (
    <div className="min-h-[100dvh] w-full bg-background p-0 sm:p-4" data-testid="layout-shell">
      <div className="mx-auto min-h-[100dvh] max-w-[1600px] overflow-hidden border-border bg-card sm:min-h-[calc(100dvh-2rem)] sm:rounded-lg sm:border sm:shadow-[0_18px_50px_rgba(31,27,61,0.10)]">
        <header className="sticky top-0 z-30 border-b bg-card/95 backdrop-blur-md">
          <div className="flex min-h-16 items-center gap-4 px-4 sm:px-6">
          <Link href="/" className="flex min-w-0 shrink-0 items-center gap-3 font-semibold hover:opacity-80 transition-opacity" data-testid="link-home">
            {logoUrl ? (
              <img src={logoUrl} alt={companyName} className="h-9 w-9 rounded-md object-contain" />
            ) : (
              <span className="grid h-9 w-9 place-items-center rounded-md bg-primary text-primary-foreground"><Building2 className="h-5 w-5" /></span>
            )}
            <span className="hidden max-w-48 truncate text-base sm:block">{companyName}</span>
          </Link>

          <nav className="hidden min-w-0 flex-1 items-center justify-center gap-1 lg:flex">
          {NAV_ITEMS.map((item) => {
            const isActive = location === item.href || (item.href === '/payroll' && location.startsWith('/payroll/runs/'));
            return (
              <Link 
                key={item.href} 
                href={item.href}
                data-testid={`nav-item-${item.label.toLowerCase().replace(/\s+/g, '-')}`}
                className={cn(
                  "flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-all duration-200",
                  isActive 
                    ? "bg-primary text-primary-foreground" 
                    : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                )}
              >
                <item.icon className="h-4 w-4" />
                {item.label}
              </Link>
            )
          })}
          </nav>

          <div className="ml-auto flex shrink-0 items-center gap-1.5">
          <Link
            href="/settings"
            data-testid="nav-item-settings"
            title="Settings"
            className={cn(
              "grid h-9 w-9 place-items-center rounded-md border transition-all duration-200",
              location === "/settings"
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            )}
          >
            <Settings className="h-4 w-4" />
          </Link>
            <div className="hidden min-w-0 items-center gap-2 pl-2 md:flex">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-secondary text-xs font-bold text-secondary-foreground">
                {user.name.split(/\s+/).map(part => part[0]).join('').slice(0, 2).toUpperCase()}
              </span>
              <div className="flex max-w-40 flex-col truncate leading-tight">
                <span className="truncate text-sm font-medium">{user.name}</span>
                <span className="truncate text-xs text-muted-foreground">{user.email}</span>
              </div>
            </div>
            <Button 
              variant="ghost" 
              size="icon"
              className="h-9 w-9 border border-border"
              onClick={handleLogout}
              disabled={logout.isPending}
              data-testid="button-logout"
              title="Log out"
            >
              <LogOut className="h-4 w-4 text-muted-foreground" />
            </Button>
          </div>
          </div>

          <nav className="flex gap-1 overflow-x-auto border-t px-3 py-2 lg:hidden">
            {NAV_ITEMS.map((item) => {
              const isActive = location === item.href || (item.href === '/payroll' && location.startsWith('/payroll/runs/'));
              return (
                <Link key={item.href} href={item.href} className={cn(
                  "flex shrink-0 items-center gap-2 rounded-md px-3 py-2 text-xs font-medium transition-all duration-200",
                  isActive ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent",
                )}>
                  <item.icon className="h-4 w-4" />{item.label}
                </Link>
              );
            })}
          </nav>
        </header>

        <main>
        <div className="mx-auto w-full max-w-7xl p-4 sm:p-6 lg:p-8">
          {children}
        </div>
        </main>
      </div>
    </div>
  )
}
