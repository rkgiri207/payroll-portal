import { type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { LayoutShell } from '@/components/layout/shell';

import LoginPage from '@/pages/login';
import DashboardPage from '@/pages/dashboard';
import SettingsPage from '@/pages/settings';
import PlaceholderPage from '@/pages/placeholder';

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
            <Route path="/employees">
              <PlaceholderPage 
                title="Employee Directory" 
                description="Manage staff details, banking info, and tax configurations."
              />
            </Route>
            <Route path="/payroll">
              <PlaceholderPage 
                title="Payroll Runs" 
                description="Execute and manage periodic payroll processing cycles."
              />
            </Route>
            <Route path="/payslips">
              <PlaceholderPage 
                title="Payslips" 
                description="Generate, review, and distribute employee payslips."
              />
            </Route>
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

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
        <RoutedErrorBoundary>
          <Router />
        </RoutedErrorBoundary>
      </WouterRouter>
      <Toaster />
    </QueryClientProvider>
  );
}

export default App;
