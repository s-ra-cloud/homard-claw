import React from "react";
import {
  useListConnectedApps,
  useUpdateConnectedApp,
  useStartGoogleOauth,
  useDisconnectGoogleAccount,
  getListConnectedAppsQueryKey,
  type ConnectedApp,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Shell } from "@/components/layout/Shell";
import { PixelCard } from "@/components/ui/pixel-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import {
  Mail,
  HardDrive,
  Github,
  Plug,
  ShieldCheck,
  RefreshCw,
} from "lucide-react";

const APP_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  gmail: Mail,
  google_drive: HardDrive,
  github: Github,
};

function StatusBadge({ app }: { app: ConnectedApp }) {
  if (app.status === "connected") return <Badge variant="success">Connected</Badge>;
  if (app.status === "expired") return <Badge variant="destructive">Reconnect Needed</Badge>;
  if (app.status === "not_connected") return <Badge variant="warning">Not Connected</Badge>;
  return <Badge variant="outline">Status Unknown</Badge>;
}

/** Human messages for the ?gmail= callback results the API redirects with. */
const GMAIL_CALLBACK_MESSAGES: Record<string, { title: string; description: string; ok?: boolean }> = {
  connected: {
    ok: true,
    title: "Gmail connected",
    description: "Your Gmail account is now connected to your workspace.",
  },
  "error:denied": {
    title: "Consent declined",
    description:
      "You declined Google's consent screen, so nothing was connected. You can try again any time.",
  },
  "error:scopes": {
    title: "Missing permissions",
    description:
      "Google reported that not all requested Gmail permissions were granted. Reconnect and allow all requested access.",
  },
  "error:expired": {
    title: "The sign-in took too long",
    description: "The connection attempt expired. Start again and finish within a few minutes.",
  },
  "error:not_configured": {
    title: "Google sign-in unavailable",
    description: "Google OAuth is not configured on this server yet.",
  },
};

function gmailCallbackMessage(code: string) {
  return (
    GMAIL_CALLBACK_MESSAGES[code] ?? {
      title: "Gmail connection failed",
      description:
        "Something went wrong while connecting your Google account. Please try again.",
    }
  );
}

/** Gmail connects right here, with the signed-in user's own Google account. */
function GmailActions({ app }: { app: ConnectedApp }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const start = useStartGoogleOauth({
    mutation: {
      onSuccess: (data) => {
        window.location.assign(data.authUrl);
      },
      onError: () => {
        toast({
          variant: "destructive",
          title: "Could not start Google sign-in",
          description:
            "Google OAuth may not be configured on this server yet. Try again in a moment.",
        });
      },
    },
  });
  const disconnect = useDisconnectGoogleAccount({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListConnectedAppsQueryKey() });
        toast({
          title: "Gmail disconnected",
          description:
            "The credential was removed. Agents can no longer act on this account — including actions you had already approved.",
        });
      },
      onError: (error) => {
        toast({
          variant: "destructive",
          title: "Disconnect failed",
          description: error.message,
        });
      },
    },
  });
  return (
    <div className="flex gap-2 flex-wrap">
      <Button
        variant={app.status === "connected" ? "outline" : "primary"}
        size="sm"
        disabled={start.isPending}
        onClick={() => start.mutate()}
      >
        {start.isPending
          ? "..."
          : app.status === "connected"
            ? "RECONNECT"
            : app.status === "expired"
              ? "RECONNECT"
              : "CONNECT GMAIL"}
      </Button>
      {app.status === "connected" || app.status === "expired" ? (
        <Button
          variant="outline"
          size="sm"
          disabled={disconnect.isPending}
          onClick={() => {
            if (
              window.confirm(
                "Disconnect Gmail? Agents immediately lose access to this account, including actions you already approved.",
              )
            ) {
              disconnect.mutate();
            }
          }}
        >
          {disconnect.isPending ? "..." : "DISCONNECT"}
        </Button>
      ) : null}
    </div>
  );
}

function AppCard({ app }: { app: ConnectedApp }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const update = useUpdateConnectedApp({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListConnectedAppsQueryKey() });
      },
      onError: (error) => {
        toast({
          variant: "destructive",
          title: "Change failed",
          description: error.message,
        });
      },
    },
  });
  const Icon = APP_ICONS[app.app] ?? Plug;

  return (
    <PixelCard>
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3 sm:gap-4">
        <div className="flex items-start gap-3 min-w-0">
          <div className="border-4 border-border bg-muted/30 p-2 shrink-0">
            <Icon className="w-6 h-6" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-display uppercase text-sm">{app.displayName}</span>
              <StatusBadge app={app} />
              {!app.enabled ? <Badge variant="destructive">Disabled</Badge> : null}
            </div>
            <p className="text-[10px] text-muted-foreground uppercase font-bold mt-1">
              {app.status === "connected"
                ? app.accountLabel
                  ? `Account: ${app.accountLabel}`
                  : "Account connected"
                : app.status === "expired"
                  ? "Account authorization expired — reconnect to resume"
                  : app.status === "not_connected"
                    ? "No account connected yet"
                    : "Connection status temporarily unavailable"}
            </p>
            <p className="text-[10px] text-muted-foreground uppercase font-bold mt-1">
              {app.grantedAgents === 0
                ? "No agents have access"
                : `${app.grantedAgents} agent${app.grantedAgents === 1 ? "" : "s"} with access`}
            </p>
            {app.statusDetail ? (
              <p className="text-[10px] text-muted-foreground font-mono mt-1 break-words">
                {app.statusDetail}
              </p>
            ) : null}
          </div>
        </div>
        <div className="flex gap-2 shrink-0 flex-wrap items-start">
          {app.app === "gmail" ? <GmailActions app={app} /> : null}
          <Button
            variant={app.enabled ? "outline" : "primary"}
            size="sm"
            disabled={update.isPending}
            onClick={() =>
              update.mutate({ app: app.app, data: { enabled: !app.enabled } })
            }
          >
            {update.isPending ? "..." : app.enabled ? "DISABLE" : "ENABLE"}
          </Button>
        </div>
      </div>
      {app.app !== "gmail" && app.status === "not_connected" ? (
        <p className="text-[11px] text-muted-foreground mt-3 border-2 border-dashed border-border bg-muted/20 p-3">
          Personal {app.displayName} connections aren't available yet — each
          user will be able to connect their own account here in a future
          update.
        </p>
      ) : null}
    </PixelCard>
  );
}

export default function ConnectedAppsPage() {
  const { data, isLoading, error, refetch, isFetching } = useListConnectedApps();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // Surface the OAuth callback result exactly once, then clean the URL.
  React.useEffect(() => {
    const url = new URL(window.location.href);
    const result = url.searchParams.get("gmail");
    if (!result) return;
    url.searchParams.delete("gmail");
    window.history.replaceState(null, "", url.pathname + url.search);
    const message = gmailCallbackMessage(result);
    toast({
      variant: message.ok ? "default" : "destructive",
      title: message.title,
      description: message.description,
    });
    if (message.ok) {
      queryClient.invalidateQueries({ queryKey: getListConnectedAppsQueryKey() });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Shell>
      <div className="p-4 sm:p-6 lg:p-8 max-w-4xl mx-auto space-y-6 sm:space-y-8">
        <div className="border-b-4 border-border pb-6 flex items-end justify-between gap-3 flex-wrap">
          <div>
            <h1 className="font-display text-lg sm:text-2xl text-foreground uppercase mb-1">
              Connected Apps
            </h1>
            <p className="text-muted-foreground text-sm">
              Your own external accounts, connected privately to your
              workspace, that your agents can be granted access to.
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={isFetching}
            onClick={() => refetch()}
          >
            <RefreshCw className={`w-3 h-3 mr-1 ${isFetching ? "animate-spin" : ""}`} />
            {isFetching ? "CHECKING..." : "REFRESH STATUS"}
          </Button>
        </div>

        <PixelCard>
          <div className="flex items-start gap-3">
            <ShieldCheck className="w-5 h-5 text-accent shrink-0 mt-0.5" />
            <div className="text-xs text-muted-foreground space-y-1">
              <p>
                Connecting an account and granting an agent access are two
                different things. You connect{" "}
                <span className="font-bold">your own account</span> right here
                — it belongs to your workspace alone, other users can never
                see or use it, and agents never see credentials. Then, on each
                agent's personnel file, you choose what that agent may do with
                it: <span className="font-bold uppercase">read</span>{" "}
                (search and read), <span className="font-bold uppercase">draft</span>{" "}
                (prepare drafts nobody outside sees), or{" "}
                <span className="font-bold uppercase">write</span> — and every
                write still waits for your approval before it happens.
              </p>
              <p>
                Disabling an app here blocks it for every agent at once,
                whatever their individual grants say. Disconnecting Gmail
                removes the credential immediately — even already-approved
                actions can no longer run against it.
              </p>
            </div>
          </div>
        </PixelCard>

        {isLoading ? (
          <PixelCard className="animate-pulse h-40 bg-muted/50">
            <div className="w-full h-full"></div>
          </PixelCard>
        ) : error || !data ? (
          <PixelCard className="text-center p-6">
            <p className="text-muted-foreground text-sm">
              The connected-app inventory could not be loaded. Try again in a
              moment.
            </p>
          </PixelCard>
        ) : (
          <div className="space-y-4">
            {data.apps.map((app) => (
              <AppCard key={app.app} app={app} />
            ))}
          </div>
        )}
      </div>
    </Shell>
  );
}
