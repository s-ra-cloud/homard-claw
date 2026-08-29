import React from "react";
import {
  useListConnectedApps,
  useUpdateConnectedApp,
  useStartGoogleOauth,
  useDisconnectGoogleAccount,
  useStartGithubOauth,
  useDisconnectGithubAccount,
  getListConnectedAppsQueryKey,
  useListCapabilities,
  useInstallCapability,
  useUninstallCapability,
  useUpdateCapability,
  useApplyCapabilityUpdate,
  getListCapabilitiesQueryKey,
  useGetTelegramStatus,
  useCreateTelegramLinkCode,
  useRemoveTelegramLink,
  getGetTelegramStatusQueryKey,
  useListAgents,
  type ConnectedApp,
  type CapabilityPackage,
  type TelegramLinkCode,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { navigateToExternal } from "@/lib/office-window";
import { CustomApiSection } from "@/components/custom-api-manager";
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
  Package,
  Globe,
  AlertTriangle,
  Send,
} from "lucide-react";

const APP_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  gmail: Mail,
  google_drive: HardDrive,
  github: Github,
};

function StatusBadge({ app }: { app: ConnectedApp }) {
  if (app.status === "connected")
    return <Badge variant="success">Connected</Badge>;
  if (app.status === "expired")
    return <Badge variant="destructive">Reconnect Needed</Badge>;
  if (app.status === "not_connected")
    return <Badge variant="warning">Not Connected</Badge>;
  return <Badge variant="outline">Status Unknown</Badge>;
}

/** Human messages for the OAuth callback results the API redirects with. */
function oauthCallbackMessage(
  appName: string,
  code: string,
): {
  title: string;
  description: string;
  ok?: boolean;
} {
  const messages: Record<
    string,
    { title: string; description: string; ok?: boolean }
  > = {
    connected: {
      ok: true,
      title: `${appName} connected`,
      description: `Your ${appName} account is now connected to your workspace.`,
    },
    "error:denied": {
      title: "Consent declined",
      description:
        "You declined the consent screen, so nothing was connected. You can try again any time.",
    },
    "error:scopes": {
      title: "Missing permissions",
      description: `Not all requested ${appName} permissions were granted. Reconnect and allow all requested access.`,
    },
    "error:expired": {
      title: "The sign-in took too long",
      description:
        "The connection attempt expired. Start again and finish within a few minutes.",
    },
    "error:not_configured": {
      title: `${appName} sign-in unavailable`,
      description: `${appName} OAuth is not configured on this server yet.`,
    },
  };
  return (
    messages[code] ?? {
      title: `${appName} connection failed`,
      description: `Something went wrong while connecting your ${appName} account. Please try again.`,
    }
  );
}

/**
 * Every app connects right here, with the signed-in user's own account.
 * Gmail and Drive share one Google account (Drive is an incremental
 * consent); GitHub has its own OAuth app.
 */
function ConnectActions({ app }: { app: ConnectedApp }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const onStartError = () => {
    toast({
      variant: "destructive",
      title: "Could not start the sign-in",
      description:
        "OAuth may not be configured on this server yet. Try again in a moment.",
    });
  };
  const onStartSuccess = (data: { authUrl: string }) => {
    // GitHub and Google refuse to load inside the office parchment iframe,
    // so OAuth must leave the embedded office window for the top-level page.
    navigateToExternal(data.authUrl);
  };
  const onDisconnected = () => {
    queryClient.invalidateQueries({ queryKey: getListConnectedAppsQueryKey() });
    toast({
      title: `${app.displayName} disconnected`,
      description:
        app.app === "github"
          ? "The credential was removed. Crustabots can no longer act on this account — including actions you had already approved."
          : "The Google credential was removed — Gmail and Google Drive access both ended. Crustabots can no longer act on this account, including actions you had already approved.",
    });
  };
  const onDisconnectError = (error: Error) => {
    toast({
      variant: "destructive",
      title: "Disconnect failed",
      description: error.message,
    });
  };
  const startGoogle = useStartGoogleOauth({
    mutation: { onSuccess: onStartSuccess, onError: onStartError },
  });
  const startGithub = useStartGithubOauth({
    mutation: { onSuccess: onStartSuccess, onError: onStartError },
  });
  const disconnectGoogle = useDisconnectGoogleAccount({
    mutation: { onSuccess: onDisconnected, onError: onDisconnectError },
  });
  const disconnectGithub = useDisconnectGithubAccount({
    mutation: { onSuccess: onDisconnected, onError: onDisconnectError },
  });
  const start = app.app === "github" ? startGithub : startGoogle;
  const disconnect = app.app === "github" ? disconnectGithub : disconnectGoogle;
  const beginConnect = () => {
    if (app.app === "github") {
      startGithub.mutate();
    } else {
      startGoogle.mutate({
        data: {
          service: app.app === "google_drive" ? "google_drive" : "gmail",
        },
      });
    }
  };
  const confirmText =
    app.app === "github"
      ? "Disconnect GitHub? Crustabots immediately lose access to this account, including actions you already approved."
      : `Disconnect this Google account? Gmail AND Google Drive access both end immediately — Crustabots lose access to the account, including actions you already approved.`;
  return (
    <div className="flex gap-2 flex-wrap">
      <Button
        variant={app.status === "connected" ? "outline" : "primary"}
        size="sm"
        disabled={start.isPending}
        onClick={beginConnect}
      >
        {start.isPending
          ? "..."
          : app.status === "connected" || app.status === "expired"
            ? "RECONNECT"
            : `CONNECT ${app.displayName.toUpperCase()}`}
      </Button>
      {app.status === "connected" || app.status === "expired" ? (
        <Button
          variant="outline"
          size="sm"
          disabled={disconnect.isPending}
          onClick={() => {
            if (window.confirm(confirmText)) {
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
        queryClient.invalidateQueries({
          queryKey: getListConnectedAppsQueryKey(),
        });
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
              <span className="font-display uppercase text-sm">
                {app.displayName}
              </span>
              <StatusBadge app={app} />
              {!app.enabled ? (
                <Badge variant="destructive">Disabled</Badge>
              ) : null}
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
                ? "No Crustabots have access"
                : `${app.grantedAgents} Crustabot${app.grantedAgents === 1 ? "" : "s"} with access`}
            </p>
            {app.statusDetail ? (
              <p className="text-[10px] text-muted-foreground font-mono mt-1 break-words">
                {app.statusDetail}
              </p>
            ) : null}
          </div>
        </div>
        <div className="flex gap-2 shrink-0 flex-wrap items-start">
          <ConnectActions app={app} />
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
    </PixelCard>
  );
}

/**
 * Telegram is an infrastructure-backed channel rather than an agent tool.
 * It is deliberately absent when the server has not configured both secrets.
 */
function TelegramCard() {
  const [linkCode, setLinkCode] = React.useState<TelegramLinkCode | null>(null);
  const [agentId, setAgentId] = React.useState("");
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const statusQuery = useGetTelegramStatus({
    query: {
      queryKey: getGetTelegramStatusQueryKey(),
      refetchInterval: linkCode ? 5_000 : false,
    },
  });
  const agentsQuery = useListAgents();
  const agents = (agentsQuery.data ?? []).filter((agent) => !agent.archived);

  React.useEffect(() => {
    if (statusQuery.data?.linked) setLinkCode(null);
    if (statusQuery.data?.agentId) {
      setAgentId(statusQuery.data.agentId);
    } else if (!agentId && agents[0]) {
      setAgentId(agents[0].id);
    }
  }, [
    agentId,
    agentsQuery.data,
    statusQuery.data?.agentId,
    statusQuery.data?.linked,
  ]);

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: getGetTelegramStatusQueryKey() });
  const createCode = useCreateTelegramLinkCode({
    mutation: {
      onSuccess: (data) => {
        setLinkCode(data);
        toast({
          title: "Telegram link code ready",
          description: "Send the command below to your bot within ten minutes.",
        });
      },
      onError: (error) =>
        toast({
          variant: "destructive",
          title: "Could not create link code",
          description: error.message,
        }),
    },
  });
  const removeLink = useRemoveTelegramLink({
    mutation: {
      onSuccess: () => {
        setLinkCode(null);
        void refresh();
        toast({
          title: "Telegram disconnected",
          description: "That chat can no longer reach this workspace.",
        });
      },
      onError: (error) =>
        toast({
          variant: "destructive",
          title: "Could not disconnect Telegram",
          description: error.message,
        }),
    },
  });

  const status = statusQuery.data;
  if (!status?.available) return null;

  const botUrl = status.botUsername
    ? `https://t.me/${encodeURIComponent(status.botUsername)}`
    : null;
  return (
    <PixelCard>
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
        <div className="flex items-start gap-3 min-w-0">
          <div className="border-4 border-border bg-muted/30 p-2 shrink-0">
            <Send className="w-6 h-6" />
          </div>
          <div className="min-w-0 space-y-2">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-display uppercase text-sm">Telegram</span>
              <Badge variant={status.linked ? "success" : "warning"}>
                {status.linked ? "Connected" : "Not Connected"}
              </Badge>
            </div>
            <p className="text-[10px] text-muted-foreground uppercase font-bold">
              Talk to one selected Crustabot and receive task and approval
              alerts on your phone.
            </p>
            {status.linked ? (
              <p className="text-xs font-mono">
                Default Talk Crustabot:{" "}
                <strong>{status.agentName ?? "Selected Crustabot"}</strong>
              </p>
            ) : (
              <div className="space-y-2">
                <label className="block text-[10px] uppercase font-bold text-muted-foreground">
                  Default Talk Crustabot
                </label>
                <select
                  value={agentId}
                  onChange={(event) => setAgentId(event.target.value)}
                  className="h-10 w-full max-w-sm border-4 border-border bg-background px-2 font-mono text-xs"
                >
                  {agents.map((agent) => (
                    <option key={agent.id} value={agent.id}>
                      {agent.name} — {agent.title}
                    </option>
                  ))}
                </select>
                {linkCode ? (
                  <div className="border-2 border-accent bg-accent/10 p-3 space-y-2">
                    <p className="text-xs">
                      {botUrl ? (
                        <a
                          href={botUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="font-bold underline"
                        >
                          Open @{status.botUsername}
                        </a>
                      ) : (
                        "Open your Crustabox bot"
                      )}{" "}
                      and send this exact command before{" "}
                      {new Date(linkCode.expiresAt).toLocaleTimeString()}:
                    </p>
                    <code className="block select-all break-all border-2 border-border bg-background p-2 text-sm">
                      /start {linkCode.code}
                    </code>
                    <p className="text-[10px] text-muted-foreground uppercase">
                      The code works once. This page checks automatically for
                      the connection.
                    </p>
                  </div>
                ) : null}
              </div>
            )}
          </div>
        </div>
        <div className="flex gap-2 shrink-0 flex-wrap">
          {status.linked ? (
            <Button
              variant="outline"
              size="sm"
              disabled={removeLink.isPending}
              onClick={() => {
                if (
                  window.confirm(
                    "Disconnect this Telegram chat from Crustabox?",
                  )
                ) {
                  removeLink.mutate();
                }
              }}
            >
              {removeLink.isPending ? "..." : "DISCONNECT"}
            </Button>
          ) : (
            <Button
              variant="primary"
              size="sm"
              disabled={!agentId || createCode.isPending}
              onClick={() => createCode.mutate({ data: { agentId } })}
            >
              {createCode.isPending
                ? "..."
                : linkCode
                  ? "NEW CODE"
                  : "CREATE LINK CODE"}
            </Button>
          )}
        </div>
      </div>
    </PixelCard>
  );
}

const PACKAGE_ICONS: Record<
  string,
  React.ComponentType<{ className?: string }>
> = {
  web_research: Globe,
};

function PackageHealthBadge({ pkg }: { pkg: CapabilityPackage }) {
  if (pkg.status === "quarantined")
    return <Badge variant="destructive">Quarantined</Badge>;
  if (pkg.status === "update_review")
    return <Badge variant="warning">Update Needs Review</Badge>;
  if (!pkg.installed) return <Badge variant="outline">Not Installed</Badge>;
  if (pkg.health === "connected" || pkg.health === "none_required")
    return <Badge variant="success">Ready</Badge>;
  if (pkg.health === "unavailable")
    return <Badge variant="destructive">Unavailable</Badge>;
  return <Badge variant="warning">Not Connected</Badge>;
}

/**
 * One vetted capability package: version, tools with risk levels, health,
 * install/enable switches, and the permission-diff review gate for updates.
 */
function CapabilityCard({ pkg }: { pkg: CapabilityPackage }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: getListCapabilitiesQueryKey() });
  const onError = (error: Error) =>
    toast({
      variant: "destructive",
      title: "Change failed",
      description: error.message,
    });
  const install = useInstallCapability({
    mutation: { onSuccess: refresh, onError },
  });
  const uninstall = useUninstallCapability({
    mutation: { onSuccess: refresh, onError },
  });
  const update = useUpdateCapability({
    mutation: { onSuccess: refresh, onError },
  });
  const applyUpdate = useApplyCapabilityUpdate({
    mutation: { onSuccess: refresh, onError },
  });
  const Icon = PACKAGE_ICONS[pkg.packageId] ?? Package;
  const pendingDiff = pkg.pendingDiff as {
    addedTools?: { name: string; level: string }[];
    removedTools?: string[];
    levelChanges?: { name: string; from: string; to: string }[];
    recoveryChanges?: { name: string; from: string; to: string }[];
    schemaChanges?: string[];
    connectionChange?: { from: string; to: string } | null;
    routingChanges?: string[];
  } | null;

  return (
    <PixelCard>
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3 sm:gap-4">
        <div className="flex items-start gap-3 min-w-0">
          <div className="border-4 border-border bg-muted/30 p-2 shrink-0">
            <Icon className="w-6 h-6" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-display uppercase text-sm">
                {pkg.displayName}
              </span>
              <PackageHealthBadge pkg={pkg} />
              {pkg.installed && !pkg.enabled ? (
                <Badge variant="destructive">Disabled</Badge>
              ) : null}
              {pkg.builtin ? <Badge variant="outline">Built-in</Badge> : null}
            </div>
            <p className="text-[10px] text-muted-foreground uppercase font-bold mt-1">
              {pkg.description}
            </p>
            <p className="text-[10px] text-muted-foreground uppercase font-bold mt-1">
              {pkg.installed
                ? `v${pkg.installedVersion ?? pkg.registryVersion} · ${pkg.publisher} · ${
                    pkg.grantedAgents === 0
                      ? "no Crustabots have access"
                      : `${pkg.grantedAgents} Crustabot${pkg.grantedAgents === 1 ? "" : "s"} with access`
                  }`
                : `v${pkg.registryVersion} · ${pkg.publisher}`}
            </p>
            {pkg.healthDetail || pkg.quarantineReason ? (
              <p className="text-[10px] text-destructive font-mono mt-1 break-words">
                {pkg.quarantineReason ?? pkg.healthDetail}
              </p>
            ) : null}
            <div className="mt-2 flex flex-wrap gap-1">
              {pkg.tools.map((tool) => (
                <span
                  key={tool.name}
                  className="text-[9px] font-mono border-2 border-border/50 px-1 py-0.5 uppercase"
                  title={`${tool.description} (recovery: ${tool.recovery})`}
                >
                  {tool.name} · {tool.level}
                  {tool.needsApproval ? " · approval" : ""}
                </span>
              ))}
            </div>
            {pkg.status === "update_review" && pendingDiff ? (
              <div className="mt-2 border-2 border-warning/60 bg-warning/10 p-2 text-[10px]">
                <p className="font-bold uppercase flex items-center gap-1">
                  <AlertTriangle className="w-3 h-3" />
                  Update to v{pkg.pendingVersion} expands permissions — review
                  before it activates:
                </p>
                {(pendingDiff.addedTools ?? []).map((t) => (
                  <p key={t.name} className="font-mono">
                    + {t.name} ({t.level})
                  </p>
                ))}
                {(pendingDiff.levelChanges ?? []).map((c) => (
                  <p key={c.name} className="font-mono">
                    {c.name}: access {c.from} → {c.to}
                  </p>
                ))}
                {(pendingDiff.recoveryChanges ?? []).map((c) => (
                  <p key={c.name} className="font-mono">
                    {c.name}: recovery {c.from} → {c.to}
                  </p>
                ))}
                {(pendingDiff.schemaChanges ?? []).map((name) => (
                  <p key={name} className="font-mono">
                    {name}: input schema changed
                  </p>
                ))}
                {pendingDiff.connectionChange ? (
                  <p className="font-mono">
                    connection: {pendingDiff.connectionChange.from} →{" "}
                    {pendingDiff.connectionChange.to}
                  </p>
                ) : null}
                {(pendingDiff.routingChanges ?? []).map((line) => (
                  <p key={line} className="font-mono">
                    routing: {line}
                  </p>
                ))}
                {(pendingDiff.removedTools ?? []).map((name) => (
                  <p key={name} className="font-mono">
                    - {name} (removed)
                  </p>
                ))}
              </div>
            ) : null}
          </div>
        </div>
        <div className="flex gap-2 shrink-0 flex-wrap items-start">
          {!pkg.installed ? (
            <Button
              variant="primary"
              size="sm"
              disabled={install.isPending}
              onClick={() => install.mutate({ packageId: pkg.packageId })}
            >
              {install.isPending ? "..." : "INSTALL"}
            </Button>
          ) : (
            <>
              {pkg.status === "update_review" ? (
                <Button
                  variant="primary"
                  size="sm"
                  disabled={applyUpdate.isPending}
                  onClick={() =>
                    applyUpdate.mutate({ packageId: pkg.packageId })
                  }
                >
                  {applyUpdate.isPending ? "..." : "ACCEPT UPDATE"}
                </Button>
              ) : null}
              <Button
                variant={pkg.enabled ? "outline" : "primary"}
                size="sm"
                disabled={update.isPending}
                onClick={() =>
                  update.mutate({
                    packageId: pkg.packageId,
                    data: { enabled: !pkg.enabled },
                  })
                }
              >
                {update.isPending ? "..." : pkg.enabled ? "DISABLE" : "ENABLE"}
              </Button>
              {!pkg.builtin ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={uninstall.isPending}
                  onClick={() => {
                    if (
                      window.confirm(
                        "Uninstall this package? Crustabots immediately lose its tools; per-Crustabot grants become inert until it is reinstalled.",
                      )
                    ) {
                      uninstall.mutate({ packageId: pkg.packageId });
                    }
                  }}
                >
                  {uninstall.isPending ? "..." : "UNINSTALL"}
                </Button>
              ) : null}
            </>
          )}
        </div>
      </div>
    </PixelCard>
  );
}

export default function ConnectedAppsPage() {
  const { data, isLoading, error, refetch, isFetching } =
    useListConnectedApps();
  const capabilitiesQuery = useListCapabilities();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // Surface the OAuth callback result exactly once, then clean the URL.
  React.useEffect(() => {
    const url = new URL(window.location.href);
    const params: { key: string; appName: string }[] = [
      { key: "gmail", appName: "Gmail" },
      { key: "google_drive", appName: "Google Drive" },
      { key: "github", appName: "GitHub" },
    ];
    let anyOk = false;
    let found = false;
    for (const { key, appName } of params) {
      const result = url.searchParams.get(key);
      if (!result) continue;
      found = true;
      url.searchParams.delete(key);
      const message = oauthCallbackMessage(appName, result);
      toast({
        variant: message.ok ? "default" : "destructive",
        title: message.title,
        description: message.description,
      });
      if (message.ok) anyOk = true;
    }
    if (!found) return;
    window.history.replaceState(null, "", url.pathname + url.search);
    if (anyOk) {
      queryClient.invalidateQueries({
        queryKey: getListConnectedAppsQueryKey(),
      });
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
              Your own external accounts, connected privately to your workspace,
              that your Crustabots can be granted access to.
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={isFetching}
            onClick={() => refetch()}
          >
            <RefreshCw
              className={`w-3 h-3 mr-1 ${isFetching ? "animate-spin" : ""}`}
            />
            {isFetching ? "CHECKING..." : "REFRESH STATUS"}
          </Button>
        </div>

        <PixelCard>
          <div className="flex items-start gap-3">
            <ShieldCheck className="w-5 h-5 text-accent shrink-0 mt-0.5" />
            <div className="text-xs text-muted-foreground space-y-1">
              <p>
                Connecting an account and granting a Crustabot access are two
                different things. You connect{" "}
                <span className="font-bold">your own account</span> right here —
                it belongs to your workspace alone, other users can never see or
                use it, and Crustabots never see credentials. Then, on each
                Crustabot&apos;s personnel file, you choose what that Crustabot
                may do with it:{" "}
                <span className="font-bold uppercase">read</span> (search and
                read), <span className="font-bold uppercase">draft</span>{" "}
                (prepare drafts nobody outside sees), or{" "}
                <span className="font-bold uppercase">write</span> — and every
                write still waits for your approval before it happens.
              </p>
              <p>
                Disabling an app here blocks it for every Crustabot at once,
                whatever their individual grants say. Disconnecting an account
                removes the credential immediately — even already-approved
                actions can no longer run against it. Gmail and Google Drive
                share one Google account, so disconnecting it ends both.
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
            <TelegramCard />
          </div>
        )}

        <CustomApiSection />

        <div className="border-b-4 border-border pb-4 pt-2">
          <h2 className="font-display text-base sm:text-xl text-foreground uppercase mb-1">
            Capabilities
          </h2>
          <p className="text-muted-foreground text-sm">
            Vetted capability packages add skills and tools your Crustabots can
            be granted — installed and updated here, never by changing the app.
            Updates that expand permissions wait for your review; nothing new
            activates silently.
          </p>
        </div>
        {capabilitiesQuery.isLoading ? (
          <PixelCard className="animate-pulse h-24 bg-muted/50">
            <div className="w-full h-full"></div>
          </PixelCard>
        ) : capabilitiesQuery.error || !capabilitiesQuery.data ? (
          <PixelCard className="text-center p-6">
            <p className="text-muted-foreground text-sm">
              The capability catalog could not be loaded. Try again in a moment.
            </p>
          </PixelCard>
        ) : (
          <div className="space-y-4">
            {capabilitiesQuery.data.packages.map((pkg) => (
              <CapabilityCard key={pkg.packageId} pkg={pkg} />
            ))}
          </div>
        )}
      </div>
    </Shell>
  );
}
