import { type ReactNode, useEffect, useRef, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from 'next-themes';
import { Clock3 } from 'lucide-react';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { LayoutShell } from '@/components/layout/shell';
import { toast } from '@/hooks/use-toast';
import {
  clearSessionDeadline,
  getSessionDeadline,
  installSessionActivityMonitor,
  SESSION_EXPIRED_EVENT,
  SESSION_STARTED_EVENT,
} from '@/lib/session-expiration';

import LoginPage from '@/pages/login';
import DashboardPage from '@/pages/dashboard';
import SettingsPage from '@/pages/settings';

import PayrollWizardPage from '@/pages/payroll/index';
import PayrollHistoryPage from '@/pages/payroll/history';
import PayrollRunDetailPage from '@/pages/payroll/run-detail';
import PayslipsPage from '@/pages/payslips/index';

import {
  Route,
  Switch,
  useLocation,
  Router as WouterRouter,
} from 'wouter';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      refetchOnWindowFocus: false,
    },
  },
});

function NotFound() {
  return (
    <div className="min-h-[50vh] flex flex-col items-center justify-center text-center">
      <h1 className="text-2xl font-bold tracking-tight">404 - Not Found</h1>
      <p className="text-muted-foreground mt-2">The page you're looking for does not exist.</p>
    </div>
  );
}

function Router() {
  return (
    <Switch>
      <Route path="/login" component={LoginPage} />
      
      {/* Protected Routes wrapped in Shell */}
      <Route path="/.*">
        <LayoutShell>
          <Switch>
            <Route path="/" component={DashboardPage} />
            <Route path="/settings" component={SettingsPage} />
            <Route path="/payroll" component={PayrollWizardPage} />
            <Route path="/payroll/history" component={PayrollHistoryPage} />
            <Route path="/payroll/runs/:id" component={PayrollRunDetailPage} />
            <Route path="/payslips" component={PayslipsPage} />
            <Route component={NotFound} />
          </Switch>
        </LayoutShell>
      </Route>
    </Switch>
  );
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function SessionExpirationHandler() {
  const [location, setLocation] = useLocation();
  const redirectingRef = useRef(false);

  useEffect(() => {
    if (location === '/login') {
      redirectingRef.current = false;
    }

    const handleSessionExpired = () => {
      if (location === '/login' || redirectingRef.current) return;

      redirectingRef.current = true;
      clearSessionDeadline();
      queryClient.clear();
      toast({
        title: 'Session expired',
        description: 'Your session has expired. Please log in again.',
        variant: 'destructive',
      });
      setLocation('/login');
    };

    window.addEventListener(SESSION_EXPIRED_EVENT, handleSessionExpired);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, handleSessionExpired);
  }, [location, setLocation]);

  return null;
}

function SessionExpiryWarning() {
  const [location] = useLocation();
  const [secondsRemaining, setSecondsRemaining] = useState<number | null>(null);

  useEffect(() => {
    const updateCountdown = () => {
      const deadline = getSessionDeadline();
      if (!deadline) {
        setSecondsRemaining(null);
        return;
      }

      setSecondsRemaining(Math.max(0, Math.ceil((deadline - Date.now()) / 1000)));
    };

    updateCountdown();
    const interval = window.setInterval(updateCountdown, 1_000);
    window.addEventListener(SESSION_STARTED_EVENT, updateCountdown);
    window.addEventListener(SESSION_EXPIRED_EVENT, updateCountdown);

    return () => {
      window.clearInterval(interval);
      window.removeEventListener(SESSION_STARTED_EVENT, updateCountdown);
      window.removeEventListener(SESSION_EXPIRED_EVENT, updateCountdown);
    };
  }, []);

  if (location === '/login' || secondsRemaining === null || secondsRemaining > 10) {
    return null;
  }

  return (
    <div
      className="fixed inset-x-3 top-3 z-[90] mx-auto flex max-w-md items-center gap-3 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-amber-950 shadow-lg dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100"
      role="status"
      aria-live="polite"
      data-testid="session-expiry-warning"
    >
      <Clock3 className="h-5 w-5 shrink-0" />
      <div className="min-w-0">
        <p className="text-sm font-semibold">
          {secondsRemaining > 0 ? 'Your session is about to expire.' : 'Your session has reached its time limit.'}
        </p>
        <p className="text-xs opacity-80">
          {secondsRemaining > 0
            ? `${secondsRemaining} second${secondsRemaining === 1 ? '' : 's'} remaining.`
            : 'Your next protected action will return you to sign in.'}
        </p>
      </div>
    </div>
  );
}

function SessionActivityMonitor() {
  const [location] = useLocation();
  const isLoginPage = location === '/login';

  useEffect(() => {
    if (isLoginPage) return;
    return installSessionActivityMonitor();
  }, [isLoginPage]);

  return null;
}

function App() {
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem storageKey="payroll-portal-theme">
      <QueryClientProvider client={queryClient}>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
          <SessionExpirationHandler />
          <SessionActivityMonitor />
          <SessionExpiryWarning />
          <RoutedErrorBoundary>
            <Router />
          </RoutedErrorBoundary>
        </WouterRouter>
        <Toaster />
      </QueryClientProvider>
    </ThemeProvider>
  );
}

export default App;
