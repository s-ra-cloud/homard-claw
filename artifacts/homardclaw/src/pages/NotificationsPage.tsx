import React from "react";
import { useListAgents, useListNotifications, useMarkNotificationsRead } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Shell } from "@/components/layout/Shell";
import { Button } from "@/components/ui/button";
import { MarlowLobster } from "@/components/ui/marlow-lobster";
import { Bell, CheckCheck, CheckCircle2, XCircle, ShieldQuestion, OctagonAlert, CalendarClock, Hash, Users, Sparkles } from "lucide-react";
import { Link } from "wouter";
import { format, formatDistanceToNow, isToday, isYesterday } from "date-fns";

const KIND_META: Record<string, { icon: typeof Bell; tone: string; label: string }> = {
  task_completed: { icon: CheckCircle2, tone: "text-primary", label: "completed" },
  task_failed: { icon: XCircle, tone: "text-destructive", label: "failed" },
  task_blocked: { icon: OctagonAlert, tone: "text-destructive", label: "blocked" },
  approval_needed: { icon: ShieldQuestion, tone: "text-accent", label: "needs approval" },
  schedule_error: { icon: CalendarClock, tone: "text-destructive", label: "schedule alert" },
};

function agentHandle(name: string) {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function dayLabel(value: string) {
  const date = new Date(value);
  if (isToday(date)) return "Today";
  if (isYesterday(date)) return "Yesterday";
  return format(date, "EEEE, MMMM d");
}

export default function NotificationsPage() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useListNotifications(
    { limit: 100 },
    { query: { queryKey: ["/api/notifications", "page"], refetchInterval: 30_000 } },
  );
  const { data: agents = [] } = useListAgents({ query: { queryKey: ["/api/agents"] } });
  const markRead = useMarkNotificationsRead({
    mutation: { onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["/api/notifications"] }) },
  });
  const notifications = data?.notifications ?? [];
  const activeAgents = agents.filter((agent) => !agent.archived);

  return (
    <Shell>
      <div className="p-3 sm:p-6 lg:p-8 max-w-6xl mx-auto">
        <div className="overflow-hidden border-4 border-border bg-card pixel-shadow min-h-[70vh] flex">
          <aside className="hidden md:flex w-56 lg:w-64 shrink-0 flex-col bg-foreground text-background border-r-4 border-border">
            <div className="p-5 border-b-2 border-background/20">
              <div className="font-display text-sm uppercase tracking-wide">HomardClaw HQ</div>
              <div className="flex items-center gap-2 mt-2 text-[11px] text-background/60">
                <span className="w-2 h-2 rounded-full bg-primary animate-pulse" />
                {activeAgents.length} agents in the office
              </div>
            </div>
            <nav className="p-3 space-y-1 text-sm">
              <p className="px-2 pb-2 text-[10px] uppercase font-bold tracking-widest text-background/40">Channels</p>
              <div className="flex items-center gap-2 px-3 py-2 bg-background/15 border-l-2 border-primary font-bold">
                <Hash className="w-4 h-4" /> inbox
                {(data?.unread ?? 0) > 0 && (
                  <span className="ml-auto min-w-5 h-5 px-1.5 grid place-items-center bg-primary text-primary-foreground text-[10px] font-bold rounded-full">{data?.unread}</span>
                )}
              </div>
              <div className="flex items-center gap-2 px-3 py-2 text-background/50"><Users className="w-4 h-4" /> all-agents</div>
            </nav>
            <div className="mt-auto p-4 border-t-2 border-background/20">
              <div className="flex -space-x-2 mb-3">
                {activeAgents.slice(0, 4).map((agent) => (
                  <div key={agent.id} className="relative w-9 h-9 overflow-hidden grid place-items-center bg-background border-2 border-foreground" title={`${agent.name} · ${agent.status}`}>
                    <MarlowLobster size={38} status={agent.status} shellColor={agent.avatar.shellColor} seed={agent.id} />
                  </div>
                ))}
              </div>
              <p className="text-[10px] leading-relaxed text-background/50">Live updates from your autonomous crew.</p>
            </div>
          </aside>

          <section className="min-w-0 flex-1 flex flex-col bg-background">
            <header className="px-4 sm:px-6 py-4 border-b-2 border-border flex items-center gap-3 bg-card sticky top-0 z-10">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <Hash className="w-5 h-5 text-muted-foreground" />
                  <h1 className="font-bold text-lg leading-none">inbox</h1>
                  <span className="md:hidden text-[10px] font-bold rounded-full bg-primary/15 text-primary px-2 py-0.5">{data?.unread ?? 0} new</span>
                </div>
                <p className="text-xs text-muted-foreground mt-1.5 truncate">Agent wins, blockers, and questions — as they happen.</p>
              </div>
              <Button variant="outline" size="sm" className="uppercase text-[10px] font-bold shrink-0" disabled={markRead.isPending || (data?.unread ?? 0) === 0} onClick={() => markRead.mutate({ data: {} })} data-testid="button-mark-all-read">
                <CheckCheck className="w-4 h-4 sm:mr-2" /><span className="hidden sm:inline">Mark all read</span>
              </Button>
            </header>

            <div className="flex-1 py-2" aria-live="polite">
              {isLoading ? (
                <div className="p-8 space-y-6 animate-pulse">
                  {[1, 2, 3].map((item) => <div key={item} className="flex gap-3"><div className="w-11 h-11 bg-muted border-2 border-border" /><div className="flex-1 space-y-2 pt-1"><div className="h-3 bg-muted w-40" /><div className="h-3 bg-muted w-3/4" /></div></div>)}
                </div>
              ) : notifications.length === 0 ? (
                <div className="min-h-[50vh] grid place-items-center p-8 text-center"><div>
                  <div className="w-16 h-16 mx-auto grid place-items-center bg-primary/10 border-2 border-primary/30 mb-5"><Sparkles className="w-7 h-7 text-primary" /></div>
                  <h2 className="font-display text-sm uppercase">The channel is quiet</h2>
                  <p className="text-sm text-muted-foreground mt-2 max-w-sm">When an agent finishes work, hits a blocker, or needs your approval, their update will appear here.</p>
                </div></div>
              ) : notifications.map((notification, index) => {
                const meta = KIND_META[notification.kind] ?? { icon: Bell, tone: "text-muted-foreground", label: "update" };
                const Icon = meta.icon;
                const agent = agents.find((item) => item.id === notification.agentId);
                const name = agent?.name ?? "Harbor Bot";
                const showDay = index === 0 || dayLabel(notifications[index - 1].createdAt) !== dayLabel(notification.createdAt);
                return (
                  <React.Fragment key={notification.id}>
                    {showDay && <div className="flex items-center gap-3 px-4 sm:px-6 py-3" aria-label={dayLabel(notification.createdAt)}><div className="h-px bg-border flex-1" /><span className="text-[10px] uppercase font-bold text-muted-foreground border-2 border-border bg-card px-3 py-1">{dayLabel(notification.createdAt)}</span><div className="h-px bg-border flex-1" /></div>}
                    <article className={`group relative px-4 sm:px-6 py-3 flex items-start gap-3 hover:bg-muted/35 transition-colors ${notification.read ? "" : "bg-primary/[0.04]"}`} data-testid={`card-notification-${notification.id}`}>
                      {!notification.read && <span className="absolute left-0 top-3 bottom-3 w-1 bg-primary" aria-label="Unread" />}
                      <div className="relative w-11 h-11 shrink-0 overflow-hidden grid place-items-center bg-muted border-2 border-border">
                        <MarlowLobster size={46} status={agent?.status ?? "idle"} shellColor={agent?.avatar.shellColor} seed={agent?.id} title={`${name}'s avatar`} />
                        <span className={`absolute right-0 bottom-0 w-2.5 h-2.5 border-2 border-background rounded-full ${agent?.status === "working" || agent?.status === "researching" ? "bg-primary" : "bg-muted-foreground"}`} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline gap-2 flex-wrap">
                          <span className="font-bold text-sm">@{agentHandle(name)}</span>
                          <span className="text-[10px] uppercase font-bold text-muted-foreground">{agent?.title ?? "office bot"}</span>
                          <time className="text-[10px] text-muted-foreground" dateTime={notification.createdAt} title={format(new Date(notification.createdAt), "PPpp")}>{formatDistanceToNow(new Date(notification.createdAt), { addSuffix: true })}</time>
                        </div>
                        <p className="text-sm mt-1 leading-relaxed break-words text-foreground/90">{notification.body}</p>
                        <div className="flex items-center gap-3 mt-2 flex-wrap">
                          <span className={`inline-flex items-center gap-1 text-[10px] uppercase font-bold ${meta.tone}`}><Icon className="w-3.5 h-3.5" /> {meta.label}</span>
                          {notification.taskId && <Link href="/tasks" className="text-[11px] font-bold text-accent hover:underline">Open task →</Link>}
                          {notification.kind === "approval_needed" && <Link href="/approvals" className="text-[11px] font-bold text-accent hover:underline">Review approval →</Link>}
                          {!notification.read && <button className="text-[10px] uppercase font-bold text-muted-foreground hover:text-foreground sm:opacity-0 sm:group-hover:opacity-100 focus:opacity-100 transition-opacity" onClick={() => markRead.mutate({ data: { ids: [notification.id] } })} data-testid={`button-read-${notification.id}`}>Mark read</button>}
                        </div>
                      </div>
                    </article>
                  </React.Fragment>
                );
              })}
            </div>
          </section>
        </div>
      </div>
    </Shell>
  );
}
