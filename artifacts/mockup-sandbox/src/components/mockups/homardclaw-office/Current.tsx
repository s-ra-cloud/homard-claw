import React, { useEffect, useState } from "react";
import {
  Activity,
  AlertTriangle,
  CheckSquare,
  Clock,
  DollarSign,
  Home,
  LogOut,
  Settings,
  Shield,
  Users,
} from "lucide-react";

import "./_group.css";

type Agent = {
  id: string;
  name: string;
  title: string;
  mission: string;
  provider: "claude_max" | "openrouter";
  model: string | null;
  status: "idle" | "working" | "researching" | "waiting" | "paused" | "error" | "queued" | "complete";
  securityPreset: "observer" | "assistant" | "operator";
  avatar: { shellColor: string; deskStyle: string; accessory: string; expression?: string };
  createdAt: string;
};

type Task = {
  id: string;
  agentId: string;
  agentName: string;
  objective: string;
  status: "queued" | "running" | "waiting_approval" | "paused" | "completed" | "failed";
  provider?: "claude_max" | "openrouter";
  createdAt: string;
};

type Approval = {
  id: string;
  agentName: string;
  action: string;
  details?: string;
  status: "pending" | "approved" | "rejected" | "expired";
  createdAt: string;
  expiresAt: string;
};

type AuditEvent = { id: string; kind: string; summary: string; createdAt: string };
type OfficeOverview = {
  agents: number;
  activeTasks: number;
  pendingApprovals: number;
  emergencyStop: boolean;
  monthlyCostCents: number;
  recentEvents: AuditEvent[];
};

const mockAgents: Agent[] = [
  {
    id: "agt_01jz9m8n7p6q5r4s",
    name: "Marlow",
    title: "Operations Lead",
    mission: "Coordinate daily operations, triage incoming work, and keep the office moving.",
    provider: "claude_max",
    model: "claude-sonnet-4",
    status: "working",
    securityPreset: "operator",
    avatar: { shellColor: "#ef5b45", deskStyle: "oak", accessory: "notebook", expression: "focused" },
    createdAt: "2025-06-10T08:20:00.000Z",
  },
  {
    id: "agt_02jz9m8n7p6q5r4t",
    name: "Coral",
    title: "Research Analyst",
    mission: "Investigate market signals and turn findings into concise decision briefs.",
    provider: "openrouter",
    model: "anthropic/claude-3.7-sonnet",
    status: "researching",
    securityPreset: "assistant",
    avatar: { shellColor: "#ff7043", deskStyle: "steel", accessory: "glasses", expression: "curious" },
    createdAt: "2025-06-11T10:45:00.000Z",
  },
  {
    id: "agt_03jz9m8n7p6q5r4u",
    name: "Pincher",
    title: "Release Engineer",
    mission: "Validate releases, monitor provider health, and surface deployment risks.",
    provider: "claude_max",
    model: "claude-sonnet-4",
    status: "idle",
    securityPreset: "operator",
    avatar: { shellColor: "#e64a3b", deskStyle: "walnut", accessory: "headset", expression: "focused" },
    createdAt: "2025-06-12T15:05:00.000Z",
  },
  {
    id: "agt_04jz9m8n7p6q5r4v",
    name: "Shelly",
    title: "Finance Assistant",
    mission: "Reconcile usage, summarize spend, and flag unexpected cost changes.",
    provider: "openrouter",
    model: "google/gemini-2.5-pro",
    status: "waiting",
    securityPreset: "observer",
    avatar: { shellColor: "#ff8a65", deskStyle: "oak", accessory: "calculator" },
    createdAt: "2025-06-13T09:30:00.000Z",
  },
];

const mockTasks: Task[] = [
  {
    id: "tsk_01jz9q4s6v8x2a",
    agentId: mockAgents[0]!.id,
    agentName: mockAgents[0]!.name,
    objective: "Prepare the morning operations brief and identify blocked work.",
    status: "running",
    provider: "claude_max",
    createdAt: "2025-06-18T14:18:00.000Z",
  },
  {
    id: "tsk_02jz9q4s6v8x2b",
    agentId: mockAgents[1]!.id,
    agentName: mockAgents[1]!.name,
    objective: "Analyze this week's competitor announcements and summarize changes.",
    status: "queued",
    provider: "openrouter",
    createdAt: "2025-06-18T14:12:00.000Z",
  },
  {
    id: "tsk_03jz9q4s6v8x2c",
    agentId: mockAgents[3]!.id,
    agentName: mockAgents[3]!.name,
    objective: "Export the monthly provider usage report.",
    status: "waiting_approval",
    provider: "openrouter",
    createdAt: "2025-06-18T13:54:00.000Z",
  },
];

const mockApprovals: Approval[] = [
  {
    id: "apr_01jz9v2c4n6m8k",
    agentName: "Shelly",
    action: "Export monthly provider usage report",
    details: "Write finance/provider-usage-june.csv to the shared workspace.",
    status: "pending",
    createdAt: "2025-06-18T13:56:00.000Z",
    expiresAt: "2025-06-19T13:56:00.000Z",
  },
  {
    id: "apr_02jz9v2c4n6m8l",
    agentName: "Marlow",
    action: "Update operations runbook",
    details: "Edit RUNBOOK.md with the new escalation procedure.",
    status: "approved",
    createdAt: "2025-06-18T12:40:00.000Z",
    expiresAt: "2025-06-19T12:40:00.000Z",
  },
];

const recentEvents: AuditEvent[] = [
  { id: "evt_01", kind: "task.created", summary: "A task was queued for Coral.", createdAt: "2025-06-18T14:18:00.000Z" },
  { id: "evt_02", kind: "approval.requested", summary: "Shelly requested permission to export the monthly provider usage report.", createdAt: "2025-06-18T13:56:00.000Z" },
  { id: "evt_03", kind: "task.completed", summary: "Marlow completed the morning operations brief.", createdAt: "2025-06-18T13:42:00.000Z" },
  { id: "evt_04", kind: "agent.created", summary: "Pincher joined the office as Release Engineer.", createdAt: "2025-06-18T12:15:00.000Z" },
  { id: "evt_05", kind: "approval.approved", summary: "Update operations runbook was approved.", createdAt: "2025-06-18T11:48:00.000Z" },
];

function useGetOfficeOverview() {
  const [emergencyStop, setEmergencyStop] = useState(false);
  const overview: OfficeOverview = {
    agents: mockAgents.length,
    activeTasks: mockTasks.filter((task) => task.status === "queued" || task.status === "running").length,
    pendingApprovals: mockApprovals.filter((approval) => approval.status === "pending").length,
    emergencyStop,
    monthlyCostCents: 1847,
    recentEvents,
  };
  return { data: overview, isLoading: false, isError: false, setEmergencyStop };
}

function useSetEmergencyStop(setActive: React.Dispatch<React.SetStateAction<boolean>>) {
  return {
    isPending: false,
    mutate: ({ data }: { data: { active: boolean } }) => setActive(data.active),
  };
}

function useLocation(): [string, (path: string) => void] {
  return ["/office", () => undefined];
}

function useUser() {
  const avatar =
    "data:image/svg+xml;charset=UTF-8," +
    encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" shape-rendering="crispEdges"><rect width="40" height="40" fill="#27304d"/><rect x="8" y="8" width="24" height="24" fill="#f05a3d"/><rect x="12" y="14" width="6" height="6" fill="white"/><rect x="22" y="14" width="6" height="6" fill="white"/><rect x="14" y="16" width="3" height="3" fill="#101426"/><rect x="24" y="16" width="3" height="3" fill="#101426"/><rect x="14" y="25" width="12" height="3" fill="#101426"/></svg>',
    );
  return {
    user: {
      imageUrl: avatar,
      firstName: "Director",
      primaryEmailAddress: { emailAddress: "director@homardclaw.io" },
    },
  };
}

function useClerk() {
  return { signOut: () => undefined };
}

function Link({
  href,
  className,
  children,
}: {
  href: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <a href={href} className={className} onClick={(event) => event.preventDefault()}>
      {children}
    </a>
  );
}

type BadgeVariant = "default" | "primary" | "accent" | "destructive" | "outline" | "success" | "warning";

function Badge({
  className = "",
  variant = "default",
  children,
}: {
  className?: string;
  variant?: BadgeVariant;
  children: React.ReactNode;
}) {
  const variants: Record<BadgeVariant, string> = {
    default: "bg-secondary text-secondary-foreground border-2 border-border",
    primary: "bg-primary text-primary-foreground border-2 border-primary",
    accent: "bg-accent text-accent-foreground border-2 border-accent",
    destructive: "bg-destructive text-destructive-foreground border-2 border-destructive",
    success: "bg-green-500 text-white border-2 border-green-700",
    warning: "bg-yellow-500 text-black border-2 border-yellow-700",
    outline: "text-foreground border-2 border-border",
  };
  return (
    <div className={`inline-flex items-center px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${variants[variant]} ${className}`}>
      {children}
    </div>
  );
}

function Button({
  className = "",
  variant = "default",
  size = "default",
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "default" | "primary" | "accent" | "destructive" | "ghost" | "outline";
  size?: "default" | "sm" | "md" | "lg" | "icon";
}) {
  const variants = {
    default: "bg-secondary text-secondary-foreground pixel-shadow hover:bg-secondary/90",
    primary: "bg-primary text-primary-foreground pixel-shadow-primary hover:bg-primary/90",
    accent: "bg-accent text-accent-foreground pixel-shadow-accent hover:bg-accent/90",
    destructive: "bg-destructive text-destructive-foreground pixel-shadow hover:bg-destructive/90",
    ghost: "hover:bg-muted text-foreground",
    outline: "border-2 border-border text-foreground hover:bg-muted pixel-shadow",
  };
  const sizes = {
    default: "h-10 px-4 py-2 text-sm",
    sm: "h-8 px-3 text-xs",
    md: "h-10 px-4 py-2 text-sm",
    lg: "h-12 px-8 text-base",
    icon: "h-10 w-10",
  };
  return (
    <button
      className={`inline-flex items-center justify-center font-bold uppercase transition-transform active:translate-y-1 disabled:opacity-50 disabled:pointer-events-none ${variants[variant]} ${sizes[size]} ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}

function PixelCard({
  children,
  className = "",
  variant = "default",
  title,
}: {
  children: React.ReactNode;
  className?: string;
  variant?: "default" | "primary" | "accent" | "destructive";
  title?: React.ReactNode;
}) {
  const borderClasses = {
    default: "border-4 border-border",
    primary: "border-4 border-primary",
    accent: "border-4 border-accent",
    destructive: "border-4 border-destructive",
  };
  const shadowClasses = {
    default: "pixel-shadow",
    primary: "pixel-shadow-primary",
    accent: "pixel-shadow-accent",
    destructive: "pixel-shadow",
  };
  return (
    <div className={`bg-card relative ${borderClasses[variant]} ${shadowClasses[variant]} ${className}`}>
      {title && (
        <div className={`border-b-4 ${borderClasses[variant]} p-3 bg-muted/30`}>
          <div className="font-display text-xs uppercase tracking-tight">{title}</div>
        </div>
      )}
      <div className="p-4">{children}</div>
    </div>
  );
}

function LobsterAvatar({
  size = 64,
  status = "idle",
  primaryColor = "#ff4500",
  secondaryColor = "#00ffff",
}: {
  size?: number;
  status?: Agent["status"];
  primaryColor?: string;
  secondaryColor?: string;
}) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (status === "paused" || status === "error" || status === "idle" || status === "queued") return;
    const interval = window.setInterval(() => setFrame((value) => (value + 1) % 2), status === "working" ? 400 : 800);
    return () => window.clearInterval(interval);
  }, [status]);

  const pixels: React.ReactElement[] = [];
  const renderPixel = (x: number, y: number, color: string) => (
    <rect x={x} y={y} width="1" height="1" fill={color} key={`${x}-${y}-${pixels.length}`} />
  );
  const drawRect = (startX: number, startY: number, width: number, height: number, color: string) => {
    for (let x = 0; x < width; x += 1) {
      for (let y = 0; y < height; y += 1) pixels.push(renderPixel(startX + x, startY + y, color));
    }
  };
  const isAnimating = frame === 1;
  const clawY = isAnimating || status === "waiting" ? 3 : 2;
  const clawColor = status === "working" ? secondaryColor : primaryColor;
  drawRect(2, clawY, 3, 4, clawColor);
  drawRect(3, clawY + 4, 1, 3, primaryColor);
  drawRect(11, clawY, 3, 4, clawColor);
  drawRect(12, clawY + 4, 1, 3, primaryColor);
  drawRect(6, 1, 1, 3, primaryColor);
  drawRect(9, 1, 1, 3, primaryColor);
  drawRect(5, 4, 6, 8, primaryColor);
  drawRect(4, 12, 8, 3, primaryColor);
  drawRect(3, 14, 10, 1, primaryColor);

  if (status === "error") {
    drawRect(6, 5, 1, 1, "#000");
    drawRect(7, 6, 1, 1, "#000");
    drawRect(6, 7, 1, 1, "#000");
    drawRect(9, 5, 1, 1, "#000");
    drawRect(8, 6, 1, 1, "#000");
    drawRect(9, 7, 1, 1, "#000");
  } else if (status === "waiting") {
    drawRect(6, 6, 2, 1, "#000");
    drawRect(8, 6, 2, 1, "#000");
  } else if (status === "researching") {
    drawRect(5, 5, 3, 2, secondaryColor);
    drawRect(8, 5, 3, 2, secondaryColor);
    drawRect(6, 5, 1, 1, "#000");
    drawRect(9, 5, 1, 1, "#000");
  } else {
    drawRect(6, 5, 2, 2, "#fff");
    drawRect(8, 5, 2, 2, "#fff");
    const pupilX = isAnimating ? 7 : 6;
    drawRect(pupilX, 6, 1, 1, "#000");
    drawRect(pupilX + 2, 6, 1, 1, "#000");
  }
  if (status === "working" || status === "researching") {
    drawRect(3, 10, 10, 5, "#333");
    drawRect(4, 11, 8, 3, secondaryColor);
    if (isAnimating) {
      drawRect(5, 12, 2, 1, "#fff");
      drawRect(5, 13, 4, 1, "#fff");
    } else {
      drawRect(5, 11, 3, 1, "#fff");
      drawRect(5, 12, 5, 1, "#fff");
    }
  }
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" shapeRendering="crispEdges" className="pixelated" style={{ imageRendering: "pixelated" }}>
      <rect width="16" height="16" fill="transparent" />
      {pixels}
    </svg>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const { user } = useUser();
  const { signOut } = useClerk();
  const navItems = [
    { href: "/office", label: "Office", icon: Home },
    { href: "/agents", label: "Agents", icon: Users },
    { href: "/tasks", label: "Tasks", icon: Activity },
    { href: "/approvals", label: "Approvals", icon: CheckSquare },
    { href: "/providers", label: "Providers", icon: Settings },
  ];
  return (
    <div className="flex min-h-screen h-[100dvh] w-full overflow-hidden bg-background relative">
      <div className="absolute inset-0 scanlines z-50 pointer-events-none opacity-50 mix-blend-overlay" />
      <aside className="w-64 flex flex-col border-r-4 border-border bg-card pixel-shadow z-10 shrink-0">
        <div className="p-6 border-b-4 border-border bg-muted/30">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-primary pixel-shadow flex items-center justify-center shrink-0">
              <span className="font-display text-white text-xs">HC</span>
            </div>
            <h1 className="font-display text-sm text-primary uppercase tracking-tighter">HomardClaw</h1>
          </div>
          <div className="mt-2 text-[10px] text-muted-foreground uppercase">Control Room v1.0</div>
        </div>
        <div className="flex-1 overflow-y-auto p-4 py-6 space-y-2">
          {navItems.map((item) => {
            const isActive = location === item.href || location.startsWith(`${item.href}/`);
            return (
              <Link key={item.href} href={item.href} className="block">
                <div className={`flex items-center gap-3 px-4 py-3 cursor-pointer transition-colors ${isActive ? "bg-primary text-primary-foreground pixel-shadow" : "text-foreground hover:bg-muted pixel-shadow"}`}>
                  <item.icon className="w-4 h-4 shrink-0" />
                  <span className="font-bold text-sm tracking-wide uppercase">{item.label}</span>
                </div>
              </Link>
            );
          })}
        </div>
        <div className="p-4 border-t-4 border-border bg-muted/30">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 bg-secondary pixel-shadow border-2 border-border overflow-hidden flex items-center justify-center">
              <img src={user.imageUrl} alt="Avatar" className="w-full h-full object-cover" style={{ imageRendering: "pixelated" }} />
            </div>
            <div className="overflow-hidden">
              <div className="text-xs font-bold truncate text-accent">{user.firstName || "Director"}</div>
              <div className="text-[10px] text-muted-foreground truncate">{user.primaryEmailAddress.emailAddress}</div>
            </div>
          </div>
          <button onClick={signOut} className="w-full flex items-center justify-center gap-2 py-2 bg-destructive/10 text-destructive hover:bg-destructive hover:text-destructive-foreground transition-colors pixel-shadow border-2 border-destructive uppercase text-xs font-bold">
            <LogOut className="w-4 h-4" />
            Sign Out
          </button>
        </div>
      </aside>
      <main className="flex-1 overflow-y-auto bg-background relative z-0">{children}</main>
    </div>
  );
}

export function Current() {
  const { data: overview, isLoading, isError, setEmergencyStop } = useGetOfficeOverview();
  const emergencyStopMutation = useSetEmergencyStop(setEmergencyStop);

  const handleEmergencyStop = () => {
    if (!overview) return;
    const newState = !overview.emergencyStop;
    const message = newState
      ? "INITIATE EMERGENCY STOP? This will halt ALL active agents and tasks immediately."
      : "LIFT EMERGENCY STOP? Agents will resume normal operations.";
    if (window.confirm(message)) emergencyStopMutation.mutate({ data: { active: newState } });
  };

  if (isLoading) {
    return (
      <Shell>
        <div className="p-8 h-full flex flex-col items-center justify-center">
          <LobsterAvatar size={128} status="working" />
          <p className="mt-8 font-display text-primary animate-pulse uppercase">Booting Office Core...</p>
        </div>
      </Shell>
    );
  }
  if (isError || !overview) {
    return (
      <Shell>
        <div className="p-8">
          <PixelCard variant="destructive" title="SYSTEM ERROR">
            <p className="text-destructive-foreground">Failed to connect to office mainframe.</p>
          </PixelCard>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <div className="p-8 max-w-7xl mx-auto space-y-8">
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-4 border-b-4 border-border pb-6">
          <div>
            <h1 className="font-display text-2xl text-foreground uppercase mb-2">Command Center</h1>
            <p className="text-muted-foreground text-sm">System operational. Agents standing by.</p>
          </div>
          <div className="flex items-center gap-4">
            <Badge variant={overview.emergencyStop ? "destructive" : "success"} className="text-sm px-3 py-1">
              {overview.emergencyStop ? "HALTED" : "SYSTEM NOMINAL"}
            </Badge>
            <Button variant={overview.emergencyStop ? "default" : "destructive"} size="lg" onClick={handleEmergencyStop} disabled={emergencyStopMutation.isPending} className={overview.emergencyStop ? "animate-pulse" : ""}>
              <AlertTriangle className="w-5 h-5 mr-2" />
              {overview.emergencyStop ? "LIFT EMERGENCY STOP" : "EMERGENCY STOP"}
            </Button>
          </div>
        </div>

        {overview.emergencyStop && (
          <div className="bg-destructive/20 border-4 border-destructive p-4 flex items-start gap-4 pixel-shadow">
            <AlertTriangle className="w-8 h-8 text-destructive shrink-0" />
            <div>
              <h3 className="font-display text-destructive uppercase mb-1">GLOBAL HALT ACTIVE</h3>
              <p className="text-sm text-foreground">All agents are currently paused. Task processing is suspended until the halt is lifted.</p>
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          <PixelCard title="Active Agents">
            <div className="flex items-center justify-between">
              <div className="text-4xl font-display text-primary">{overview.agents}</div>
              <Users className="w-8 h-8 text-muted-foreground opacity-50" />
            </div>
            <Link href="/agents" className="text-xs text-accent mt-4 inline-block hover:underline uppercase font-bold">Manage Roster →</Link>
          </PixelCard>
          <PixelCard title="Running Tasks">
            <div className="flex items-center justify-between">
              <div className="text-4xl font-display text-primary">{overview.activeTasks}</div>
              <Activity className="w-8 h-8 text-muted-foreground opacity-50" />
            </div>
            <Link href="/tasks" className="text-xs text-accent mt-4 inline-block hover:underline uppercase font-bold">View Queue →</Link>
          </PixelCard>
          <PixelCard title="Pending Approvals" variant={overview.pendingApprovals > 0 ? "accent" : "default"}>
            <div className="flex items-center justify-between">
              <div className="text-4xl font-display text-accent">{overview.pendingApprovals}</div>
              <Shield className="w-8 h-8 text-muted-foreground opacity-50" />
            </div>
            <Link href="/approvals" className="text-xs text-accent mt-4 inline-block hover:underline uppercase font-bold">Review Actions →</Link>
          </PixelCard>
          <PixelCard title="Compute Cost">
            <div className="flex items-center justify-between">
              <div className="text-4xl font-display text-muted-foreground">${(overview.monthlyCostCents / 100).toFixed(2)}</div>
              <DollarSign className="w-8 h-8 text-muted-foreground opacity-50" />
            </div>
            <div className="text-xs text-muted-foreground mt-4 uppercase font-bold">Current Month</div>
          </PixelCard>
        </div>

        <div>
          <h2 className="font-display text-lg mb-4 uppercase">Recent Activity</h2>
          <PixelCard className="p-0">
            {overview.recentEvents.length === 0 ? (
              <div className="p-8 text-center text-muted-foreground text-sm uppercase">No recent activity detected.</div>
            ) : (
              <div className="divide-y-4 divide-border">
                {overview.recentEvents.map((event) => (
                  <div key={event.id} className="p-4 hover:bg-muted/30 transition-colors flex items-start gap-4">
                    <div className="mt-1 shrink-0"><Clock className="w-4 h-4 text-muted-foreground" /></div>
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <Badge variant="outline">{event.kind}</Badge>
                        <span className="text-xs text-muted-foreground">{new Date(event.createdAt).toLocaleTimeString()}</span>
                      </div>
                      <p className="text-sm font-bold">{event.summary}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </PixelCard>
        </div>
      </div>
    </Shell>
  );
}