import { useEffect, ReactNode } from "react"
import { Link, useLocation } from "wouter"
import { 
  Building2, 
  Banknote, 
  ChevronDown,
  FileText, 
  Settings, 
  LogOut,
  LayoutDashboard,
  History,
  Menu,
  Monitor,
  Moon,
  Palette,
  Sun,
} from "lucide-react"
import { useTheme } from "next-themes"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { useLogout, useGetCompanySettings, useGetMe, getGetMeQueryKey } from "@workspace/api-client-react"
import { useQueryClient } from "@tanstack/react-query"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { clearSessionDeadline } from "@/lib/session-expiration"

const NAV_ITEMS = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/payroll", label: "Upload Payroll", icon: Banknote },
  { href: "/payroll/history", label: "Payroll History", icon: History },
  { href: "/payslips", label: "Payslips", icon: FileText },
]

export function LayoutShell({ children }: { children: ReactNode }) {
  const [location, setLocation] = useLocation()
  const queryClient = useQueryClient()
  const { theme, setTheme } = useTheme()
  const { data: user, isLoading: isUserLoading, isError: isUserError } = useGetMe()
  const { data: settings } = useGetCompanySettings()
  
  const logout = useLogout({
    mutation: {
      onSuccess: () => {
        clearSessionDeadline()
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
    clearSessionDeadline()
    logout.mutate()
  }

  const appName = "Payroll Portal"
  const logoUrl = settings?.logoPath ? `/api/storage${settings.logoPath}` : null
  const userInitials = user.name.split(/\s+/).map(part => part[0]).join('').slice(0, 2).toUpperCase()

  return (
    <div className="min-h-[100dvh] w-full bg-background p-0 sm:p-4" data-testid="layout-shell">
      <div className="mx-auto min-h-[100dvh] max-w-[1600px] overflow-hidden border-border bg-card sm:min-h-[calc(100dvh-2rem)] sm:rounded-lg sm:border sm:shadow-[0_18px_50px_rgba(31,27,61,0.10)]">
        <header className="sticky top-0 z-30 border-b bg-card/95 backdrop-blur-md">
          <div className="flex min-h-16 items-center gap-2 px-3 sm:gap-4 sm:px-6">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-9 w-9 shrink-0 lg:hidden" aria-label="Open navigation">
                <Menu className="h-5 w-5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-56">
              <DropdownMenuLabel>Navigation</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {NAV_ITEMS.map((item) => (
                <DropdownMenuItem key={item.href} asChild>
                  <Link href={item.href} className="cursor-pointer">
                    <item.icon className="h-4 w-4" />
                    {item.label}
                  </Link>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          <Link href="/" className="flex min-w-0 shrink items-center gap-2 font-semibold transition-opacity hover:opacity-80 sm:gap-3" data-testid="link-home">
            {logoUrl ? (
              <img src={logoUrl} alt="" className="hidden h-9 w-9 rounded-md object-contain sm:block" />
            ) : (
              <span className="hidden h-9 w-9 place-items-center rounded-md bg-primary text-primary-foreground sm:grid"><Building2 className="h-5 w-5" /></span>
            )}
            <span className="truncate text-sm sm:text-base">{appName}</span>
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

          <div className="ml-auto flex shrink-0 items-center">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" className="h-10 max-w-[15rem] gap-2 border border-border px-2 sm:px-3" data-testid="profile-menu-trigger">
                  <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-secondary text-xs font-bold text-secondary-foreground">
                    {userInitials}
                  </span>
                  <span className="hidden min-w-0 flex-col items-start leading-tight md:flex">
                    <span className="max-w-28 truncate text-sm font-medium">{appName}</span>
                    <span className="hidden max-w-36 truncate text-xs text-muted-foreground xl:block">{user.email}</span>
                  </span>
                  <ChevronDown className="hidden h-4 w-4 text-muted-foreground sm:block" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-64">
                <DropdownMenuLabel className="font-normal">
                  <span className="block font-semibold">{appName}</span>
                  <span className="block truncate text-xs text-muted-foreground">{user.email}</span>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                  <Link href="/settings" className="cursor-pointer" data-testid="nav-item-settings">
                    <Settings className="h-4 w-4" />
                    Settings
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>
                    <Palette className="h-4 w-4" />
                    Appearance
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent className="w-44">
                    <DropdownMenuRadioGroup value={theme ?? 'system'} onValueChange={setTheme}>
                      <DropdownMenuRadioItem value="light"><Sun />Light</DropdownMenuRadioItem>
                      <DropdownMenuRadioItem value="dark"><Moon />Dark</DropdownMenuRadioItem>
                      <DropdownMenuRadioItem value="system"><Monitor />System</DropdownMenuRadioItem>
                    </DropdownMenuRadioGroup>
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onSelect={handleLogout}
                  disabled={logout.isPending}
                  className="text-destructive focus:text-destructive"
                  data-testid="button-logout"
                >
                  <LogOut className="h-4 w-4" />
                  Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          </div>
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
