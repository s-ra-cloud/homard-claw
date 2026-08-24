import { type ReactNode, useEffect, useRef } from 'react';
import { QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { queryClient } from './lib/queryClient';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import {
  Route,
  Switch,
  useLocation,
  Router as WouterRouter,
  Redirect,
} from 'wouter';
import { ClerkProvider, SignIn, SignUp, Show, useClerk } from '@clerk/react';
import { publishableKeyFromHost } from '@clerk/react/internal';
import { dark } from '@clerk/themes';

import PublicWelcome from '@/pages/PublicWelcome';
import OfficeDashboard from '@/pages/OfficeDashboard';
import AgentsPage from '@/pages/AgentsPage';
import NewAgentPage from '@/pages/NewAgentPage';
import EditAgentPage from '@/pages/EditAgentPage';
import TasksPage from '@/pages/TasksPage';
import TeamsPage from '@/pages/TeamsPage';
import ApprovalsPage from '@/pages/ApprovalsPage';
import ProvidersPage from '@/pages/ProvidersPage';
import IslandPage from '@/pages/IslandPage';
import MemoryPage from '@/pages/MemoryPage';

const clerkPubKey = publishableKeyFromHost(
  window.location.hostname,
  import.meta.env.VITE_CLERK_PUBLISHABLE_KEY,
);

const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;
const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

function stripBase(path: string): string {
  return basePath && path.startsWith(basePath)
    ? path.slice(basePath.length) || "/"
    : path;
}

if (!clerkPubKey) {
  throw new Error('Missing VITE_CLERK_PUBLISHABLE_KEY in .env file');
}

const clerkAppearance = {
  theme: dark,
  cssLayerName: "clerk",
  options: {
    logoPlacement: "inside" as const,
    logoLinkUrl: basePath || "/",
  },
  variables: {
    colorPrimary: "hsl(13, 90%, 55%)",
    colorBackground: "hsl(224, 40%, 11%)",
    colorInput: "hsl(224, 40%, 15%)",
    colorInputForeground: "hsl(180, 20%, 90%)",
    colorText: "hsl(180, 20%, 90%)",
    colorTextSecondary: "hsl(224, 20%, 60%)",
    colorDanger: "hsl(350, 80%, 50%)",
    colorNeutral: "hsl(224, 40%, 20%)",
    fontFamily: "'Space Mono', monospace",
    borderRadius: "0px",
  },
  elements: {
    rootBox: "w-full flex justify-center",
    cardBox: "bg-card border-4 border-primary rounded-none shadow-[4px_4px_0px_0px_hsl(var(--primary))] w-[440px] max-w-full overflow-hidden",
    card: "!shadow-none !border-0 !bg-transparent !rounded-none",
    footer: "!shadow-none !border-0 !bg-transparent !rounded-none bg-muted/30 border-t-4 border-border",
    headerTitle: "font-display text-primary uppercase text-lg",
    headerSubtitle: "font-mono text-muted-foreground text-xs uppercase",
    socialButtonsBlockButtonText: "font-bold uppercase text-xs",
    formFieldLabel: "font-bold uppercase text-xs",
    footerActionLink: "font-bold text-accent hover:text-accent/80",
    footerActionText: "text-muted-foreground",
    dividerText: "text-muted-foreground font-bold uppercase text-xs",
    formButtonPrimary: "bg-primary text-primary-foreground font-bold uppercase rounded-none border-0 hover:bg-primary/90 transition-none",
    formFieldInput: "bg-background border-4 border-border rounded-none focus:ring-0 focus:border-primary font-mono text-sm",
  },
};

function SignInPage() {
  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-background px-4 relative overflow-hidden">
      <div className="absolute inset-0 scanlines z-50 pointer-events-none opacity-50 mix-blend-overlay"></div>
      <div className="z-10 w-full flex justify-center">
        <SignIn routing="path" path={`${basePath}/sign-in`} signUpUrl={`${basePath}/sign-up`} />
      </div>
    </div>
  );
}

function SignUpPage() {
  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-background px-4 relative overflow-hidden">
      <div className="absolute inset-0 scanlines z-50 pointer-events-none opacity-50 mix-blend-overlay"></div>
      <div className="z-10 w-full flex justify-center">
        <SignUp routing="path" path={`${basePath}/sign-up`} signInUrl={`${basePath}/sign-in`} />
      </div>
    </div>
  );
}

function ClerkQueryClientCacheInvalidator() {
  const { addListener } = useClerk();
  const queryClientInstance = useQueryClient();
  const prevUserIdRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    const unsubscribe = addListener(({ user }) => {
      const userId = user?.id ?? null;
      if (
        prevUserIdRef.current !== undefined &&
        prevUserIdRef.current !== userId
      ) {
        queryClientInstance.clear();
      }
      prevUserIdRef.current = userId;
    });
    return unsubscribe;
  }, [addListener, queryClientInstance]);

  return null;
}

function ProtectedRoute({ component: Component }: { component: React.ComponentType<any> }) {
  return (
    <>
      <Show when="signed-in">
        <Component />
      </Show>
      <Show when="signed-out">
        <Redirect to="/sign-in" />
      </Show>
    </>
  );
}

function HomeRedirect() {
  return (
    <>
      <Show when="signed-in">
        <Redirect to="/office" />
      </Show>
      <Show when="signed-out">
        <PublicWelcome />
      </Show>
    </>
  );
}

function ClerkProviderWithRoutes() {
  const [, setLocation] = useLocation();

  return (
    <ClerkProvider
      publishableKey={clerkPubKey}
      proxyUrl={clerkProxyUrl}
      appearance={clerkAppearance}
      signInUrl={`${basePath}/sign-in`}
      signUpUrl={`${basePath}/sign-up`}
      routerPush={(to) => setLocation(stripBase(to))}
      routerReplace={(to) => setLocation(stripBase(to), { replace: true })}
    >
      <QueryClientProvider client={queryClient}>
        <ClerkQueryClientCacheInvalidator />
        <RoutedErrorBoundary>
          <Switch>
            <Route path="/" component={HomeRedirect} />
            <Route path="/sign-in/*?" component={SignInPage} />
            <Route path="/sign-up/*?" component={SignUpPage} />

            <Route path="/office">
              <ProtectedRoute component={OfficeDashboard} />
            </Route>

            <Route path="/agents">
              <ProtectedRoute component={AgentsPage} />
            </Route>

            <Route path="/agents/new">
              <ProtectedRoute component={NewAgentPage} />
            </Route>

            <Route path="/agents/:agentId/edit">
              <ProtectedRoute component={EditAgentPage} />
            </Route>

            <Route path="/tasks">
              <ProtectedRoute component={TasksPage} />
            </Route>

            <Route path="/teams">
              <ProtectedRoute component={TeamsPage} />
            </Route>

            <Route path="/memory">
              <ProtectedRoute component={MemoryPage} />
            </Route>

            <Route path="/approvals">
              <ProtectedRoute component={ApprovalsPage} />
            </Route>

            <Route path="/island">
              <ProtectedRoute component={IslandPage} />
            </Route>

            <Route path="/providers">
              <ProtectedRoute component={ProvidersPage} />
            </Route>

            <Route component={NotFound} />
          </Switch>
        </RoutedErrorBoundary>
      </QueryClientProvider>
    </ClerkProvider>
  );
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function App() {
  return (
    <TooltipProvider>
      <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
        <ClerkProviderWithRoutes />
      </WouterRouter>
      <Toaster />
    </TooltipProvider>
  );
}

export default App;
