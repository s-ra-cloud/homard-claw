import React from "react";
import {
  useListConnectedApps,
  useUpdateConnectedApp,
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

/** Connector names as Replit's Integrations panel lists them. */
const CONNECTOR_PANEL_NAMES: Record<string, string> = {
  gmail: "Google Mail",
  google_drive: "Google Drive",
  github: "GitHub",
};

function StatusBadge({ app }: { app: ConnectedApp }) {
  if (app.status === "connected") return <Badge variant="success">Connected</Badge>;
  if (app.status === "expired") return <Badge variant="destructive">Reconnect Needed</Badge>;
  if (app.status === "not_connected") return <Badge variant="warning">Not Connected</Badge>;
  return <Badge variant="outline">Status Unknown</Badge>;
}

/**
 * Where authorization actually happens: Replit's own Integrations panel.
 * HomardClaw never sees credentials, so the honest affordance is precise
 * directions plus a status refresh for when the owner comes back.
 */
function ConnectHelp({ app }: { app: ConnectedApp }) {
  const connectorName = CONNECTOR_PANEL_NAMES[app.app] ?? app.displayName;
  return (
    <div className="border-2 border-dashed border-border bg-muted/20 p-3 mt-3 text-[11px] text-muted-foreground space-y-1">
      <p className="font-bold uppercase text-foreground">
        {app.status === "connected"
          ? "Manage this account"
          : app.status === "expired"
            ? "Reconnect this account"
            : "Connect this account"}
      </p>
      <p>
        Authorization happens in Replit, not here: open this workspace on
        Replit and choose <span className="font-bold">Integrations</span> (the
        plug icon / "All tools" menu), then{" "}
        {app.status === "connected"
          ? `find "${connectorName}" to switch or disconnect the account.`
          : `connect "${connectorName}" and sign in with the account your agents should use.`}
      </p>
      <p>
        This connects your owner account once, for the whole workspace — it is
        separate from the per-agent Read / Draft / Write grants, which you set
        on each agent's file. When you're done, come back and hit{" "}
        <span className="font-bold uppercase">Refresh Status</span>.
      </p>
    </div>
  );
}

function AppCard({ app }: { app: ConnectedApp }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [helpOpen, setHelpOpen] = React.useState(false);
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
  const connectLabel =
    app.status === "connected"
      ? "MANAGE ACCOUNT"
      : app.status === "expired"
        ? "RECONNECT"
        : "CONNECT";

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
                  : "Account connected (name not shared by the platform)"
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
        <div className="flex gap-2 shrink-0 flex-wrap">
          <Button
            variant={app.status === "connected" ? "outline" : "primary"}
            size="sm"
            aria-expanded={helpOpen}
            onClick={() => setHelpOpen((open) => !open)}
          >
            {connectLabel}
          </Button>
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
      {helpOpen ? <ConnectHelp app={app} /> : null}
    </PixelCard>
  );
}

export default function ConnectedAppsPage() {
  const { data, isLoading, error, refetch, isFetching } = useListConnectedApps();

  return (
    <Shell>
      <div className="p-4 sm:p-6 lg:p-8 max-w-4xl mx-auto space-y-6 sm:space-y-8">
        <div className="border-b-4 border-border pb-6 flex items-end justify-between gap-3 flex-wrap">
          <div>
            <h1 className="font-display text-lg sm:text-2xl text-foreground uppercase mb-1">
              Connected Apps
            </h1>
            <p className="text-muted-foreground text-sm">
              External accounts your agents can be granted access to.
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
                different things. You connect each account{" "}
                <span className="font-bold">once</span>, as the owner, through
                Replit's Integrations panel (use the Connect button on a card
                below for directions) — agents never see credentials. Then, on
                each agent's personnel file, you choose what that agent may do
                with it: <span className="font-bold uppercase">read</span>{" "}
                (search and read), <span className="font-bold uppercase">draft</span>{" "}
                (prepare drafts nobody outside sees), or{" "}
                <span className="font-bold uppercase">write</span> — and every
                write still waits for your approval before it happens.
              </p>
              <p>
                Disabling an app here blocks it for every agent at once,
                whatever their individual grants say.
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
