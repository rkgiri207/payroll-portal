import * as React from "react"
import { Link, useLocation } from "wouter"
import { 
  Building2, 
  Users, 
  Banknote, 
  FileText, 
  Settings, 
  LogOut,
  LayoutDashboard 
} from "lucide-react"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { useLogout, useGetCompanySettings, useGetMe, getGetMeQueryKey } from "@workspace/api-client-react"
import { useQueryClient } from "@tanstack/react-query"

const NAV_ITEMS = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/employees", label: "Employees", icon: Users },
  { href: "/payroll", label: "Payroll Runs", icon: Banknote },
  { href: "/payslips", label: "Payslips", icon: FileText },
]

export function LayoutShell({ children }: { children: React.ReactNode }) {
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
  React.useEffect(() => {
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
    <div className="flex min-h-[100dvh] w-full bg-background" data-testid="layout-shell">
      {/* Sidebar */}
      <aside className="fixed inset-y-0 left-0 z-10 hidden w-64 flex-col border-r bg-sidebar sm:flex">
        <div className="flex h-16 shrink-0 items-center px-6 border-b">
          <Link href="/" className="flex items-center gap-3 font-semibold text-lg hover:opacity-90 transition-opacity" data-testid="link-home">
            {logoUrl ? (
              <img src={logoUrl} alt={companyName} className="h-8 w-8 object-contain" />
            ) : (
              <Building2 className="h-6 w-6 text-primary" />
            )}
            <span className="truncate">{companyName}</span>
          </Link>
        </div>
        
        <nav className="flex-1 overflow-auto py-4 px-3 space-y-1">
          {NAV_ITEMS.map((item) => {
            const isActive = location === item.href
            return (
              <Link 
                key={item.href} 
                href={item.href}
                data-testid={`nav-item-${item.label.toLowerCase().replace(/\s+/g, '-')}`}
                className={cn(
                  "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                  isActive 
                    ? "bg-primary text-primary-foreground" 
                    : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                )}
              >
                <item.icon className="h-4 w-4" />
                {item.label}
              </Link>
            )
          })}
        </nav>

        <div className="border-t p-4 space-y-4">
          <Link
            href="/settings"
            data-testid="nav-item-settings"
            className={cn(
              "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
              location === "/settings"
                ? "bg-primary text-primary-foreground"
                : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
            )}
          >
            <Settings className="h-4 w-4" />
            Settings
          </Link>
          
          <div className="flex items-center justify-between px-3">
            <div className="flex flex-col truncate">
              <span className="text-sm font-medium truncate">{user.name}</span>
              <span className="text-xs text-muted-foreground truncate">{user.email}</span>
            </div>
            <Button 
              variant="ghost" 
              size="icon" 
              onClick={handleLogout}
              disabled={logout.isPending}
              data-testid="button-logout"
              title="Log out"
            >
              <LogOut className="h-4 w-4 text-muted-foreground" />
            </Button>
          </div>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 sm:pl-64">
        {/* Mobile Header */}
        <header className="sticky top-0 z-10 flex h-16 items-center gap-4 border-b bg-background px-4 sm:hidden">
          <Link href="/" className="flex items-center gap-2 font-semibold">
            {logoUrl ? (
              <img src={logoUrl} alt={companyName} className="h-6 w-6 object-contain" />
            ) : (
              <Building2 className="h-5 w-5" />
            )}
            <span className="truncate">{companyName}</span>
          </Link>
        </header>
        
        <div className="p-6 md:p-8 max-w-7xl mx-auto w-full">
          {children}
        </div>
      </main>
    </div>
  )
}
