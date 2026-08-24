import React from "react";
import {
  useListNotifications,
  useMarkNotificationsRead,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Shell } from "@/components/layout/Shell";
import { PixelCard } from "@/components/ui/pixel-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Bell,
  CheckCheck,
  CheckCircle2,
  XCircle,
  ShieldQuestion,
  OctagonAlert,
  CalendarClock,
} from "lucide-react";
import { Link } from "wouter";
import { formatDistanceToNow } from "date-fns";

const KIND_META: Record<string, { icon: typeof Bell; tone: string; label: string }> = {
  task_completed: { icon: CheckCircle2, tone: "text-primary", label: "Completed" },
  task_failed: { icon: XCircle, tone: "text-destructive", label: "Failed" },
  task_blocked: { icon: OctagonAlert, tone: "text-destructive", label: "Blocked" },
  approval_needed: { icon: ShieldQuestion, tone: "text-accent", label: "Approval" },
  schedule_error: { icon: CalendarClock, tone: "text-destructive", label: "Schedule" },
};

export default function NotificationsPage() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useListNotifications(
    { limit: 100 },
    { query: { queryKey: ["/api/notifications", "page"], refetchInterval: 30_000 } },
  );
  const markRead = useMarkNotificationsRead({
    mutation: {
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: ["/api/notifications"] });
      },
    },
  });

  const notifications = data?.notifications ?? [];

  return (
    <Shell>
      <div className="p-4 sm:p-6 lg:p-8 max-w-3xl mx-auto space-y-6">
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-4 border-b-4 border-border pb-6">
          <div>
            <h1 className="font-display text-lg sm:text-2xl text-foreground uppercase mb-2">
              Message Tube
            </h1>
            <p className="text-muted-foreground text-sm">
              What your agents finished, fumbled, or need you for —{" "}
              {data ? `${data.unread} unread` : "loading"}.
            </p>
          </div>
          <Button
            variant="outline"
            className="uppercase text-xs font-bold"
            disabled={markRead.isPending || (data?.unread ?? 0) === 0}
            onClick={() => markRead.mutate({ data: {} })}
            data-testid="button-mark-all-read"
          >
            <CheckCheck className="w-4 h-4 mr-2" />
            Mark all read
          </Button>
        </div>

        {isLoading ? (
          <PixelCard className="p-6 text-sm text-muted-foreground">
            Loading notifications…
          </PixelCard>
        ) : notifications.length === 0 ? (
          <PixelCard className="p-8 text-center space-y-2">
            <Bell className="w-8 h-8 mx-auto text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              Quiet so far. Agent outcomes and approvals will land here.
            </p>
          </PixelCard>
        ) : (
          <div className="space-y-3">
            {notifications.map((notification) => {
              const meta = KIND_META[notification.kind] ?? {
                icon: Bell,
                tone: "text-muted-foreground",
                label: notification.kind,
              };
              const Icon = meta.icon;
              return (
                <PixelCard
                  key={notification.id}
                  className={`p-4 ${notification.read ? "opacity-60" : ""}`}
                  data-testid={`card-notification-${notification.id}`}
                >
                  <div className="flex items-start gap-3">
                    <Icon className={`w-5 h-5 shrink-0 mt-0.5 ${meta.tone}`} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-bold text-sm uppercase">
                          {notification.title}
                        </span>
                        {!notification.read && (
                          <Badge className="bg-primary/20 text-primary uppercase text-[10px]">
                            new
                          </Badge>
                        )}
                        <span className="text-[10px] text-muted-foreground ml-auto shrink-0">
                          {formatDistanceToNow(new Date(notification.createdAt), {
                            addSuffix: true,
                          })}
                        </span>
                      </div>
                      <p className="text-sm text-muted-foreground mt-1 break-words">
                        {notification.body}
                      </p>
                      <div className="flex items-center gap-3 mt-2">
                        {notification.taskId && (
                          <Link
                            href="/tasks"
                            className="text-[11px] uppercase font-bold text-accent hover:underline"
                          >
                            View tasks
                          </Link>
                        )}
                        {notification.kind === "approval_needed" && (
                          <Link
                            href="/approvals"
                            className="text-[11px] uppercase font-bold text-accent hover:underline"
                          >
                            Review approval
                          </Link>
                        )}
                        {!notification.read && (
                          <button
                            className="text-[11px] uppercase font-bold text-muted-foreground hover:text-foreground"
                            onClick={() =>
                              markRead.mutate({ data: { ids: [notification.id] } })
                            }
                            data-testid={`button-read-${notification.id}`}
                          >
                            Mark read
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                </PixelCard>
              );
            })}
          </div>
        )}
      </div>
    </Shell>
  );
}
