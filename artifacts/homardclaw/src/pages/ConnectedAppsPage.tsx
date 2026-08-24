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
import { Mail, HardDrive, Github, Plug, ShieldCheck } from "lucide-react";

const APP_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  gmail: Mail,
  google_drive: HardDrive,
  github: Github,
};

function StatusBadge({ app }: { app: ConnectedApp }) {
  if (app.status === "connected") return <Badge variant="success">Connected</Badge>;
  if (app.status === "not_connected") return <Badge variant="warning">Not Connected</Badge>;
  return <Badge variant="outline">Status Unknown</Badge>;
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
      <div className="flex items-start justify-between gap-4">
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
    </PixelCard>
  );
}

export default function ConnectedAppsPage() {
  const { data, isLoading, error } = useListConnectedApps();

  return (
    <Shell>
      <div className="p-4 sm:p-6 lg:p-8 max-w-4xl mx-auto space-y-6 sm:space-y-8">
        <div className="border-b-4 border-border pb-6">
          <h1 className="font-display text-lg sm:text-2xl text-foreground uppercase mb-1">
            Connected Apps
          </h1>
          <p className="text-muted-foreground text-sm">
            External accounts your agents can be granted access to.
          </p>
        </div>

        <PixelCard>
          <div className="flex items-start gap-3">
            <ShieldCheck className="w-5 h-5 text-accent shrink-0 mt-0.5" />
            <div className="text-xs text-muted-foreground space-y-1">
              <p>
                Accounts are connected once, by you, through Replit's connector
                panel — agents never see credentials. You then grant each agent
                an access level on its personnel file:{" "}
                <span className="font-bold uppercase">read</span> (search and
                read), <span className="font-bold uppercase">draft</span>{" "}
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
