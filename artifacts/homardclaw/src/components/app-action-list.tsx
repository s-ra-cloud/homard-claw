import React from "react";
import { Link } from "wouter";
import type { AppAction } from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";
import { ExternalLink } from "lucide-react";
import { formatDistanceToNow } from "date-fns";

/** Human-readable names for the connected-app catalog ids. */
const APP_LABELS: Record<string, string> = {
  gmail: "Gmail",
  google_drive: "Google Drive",
  github: "GitHub",
};

export function appLabel(app: string): string {
  return APP_LABELS[app] ?? app;
}

export function AppActionStatusBadge({ status }: { status: AppAction["status"] }) {
  switch (status) {
    case "executed":
      return <Badge variant="accent">Executed</Badge>;
    case "executing":
      return <Badge variant="success" className="animate-pulse">Executing</Badge>;
    case "approved":
      return <Badge variant="success">Approved</Badge>;
    case "waiting_approval":
      return <Badge variant="warning">Waiting Approval</Badge>;
    case "failed":
      return <Badge variant="destructive">Failed</Badge>;
    case "denied":
      return <Badge variant="destructive">Denied</Badge>;
    case "rejected":
      return <Badge variant="destructive">Rejected</Badge>;
    case "expired":
      return <Badge variant="default">Expired</Badge>;
    default:
      return <Badge variant="default">{status}</Badge>;
  }
}

/**
 * Timeline of durable connected-app actions: what the agent did (or tried to
 * do) in Gmail, Drive, and GitHub, with outcome and timestamps.
 */
export function AppActionList({
  actions,
  showTaskObjective = false,
}: {
  actions: AppAction[];
  showTaskObjective?: boolean;
}) {
  if (actions.length === 0) {
    return (
      <p className="font-mono text-xs text-muted-foreground p-2">
        No connected-app actions on record.
      </p>
    );
  }
  return (
    <div className="space-y-2">
      {actions.map((action) => (
        <div
          key={action.id}
          className="bg-muted/30 border-2 border-border/50 p-3 space-y-1.5"
          data-testid={`app-action-${action.id}`}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="font-mono text-xs font-bold uppercase">
                {appLabel(action.app)}
                <span className="text-muted-foreground font-normal normal-case">
                  {" "}· {action.operation}
                </span>
              </div>
              <div className="font-mono text-xs text-foreground/90 mt-0.5 break-words">
                {action.targetSummary}
              </div>
            </div>
            <div className="shrink-0">
              <AppActionStatusBadge status={action.status} />
            </div>
          </div>
          {showTaskObjective && action.taskObjective && (
            <div className="font-mono text-[10px] text-muted-foreground line-clamp-1">
              Task: {action.taskObjective}
            </div>
          )}
          {action.resultSummary && (
            <div className="font-mono text-[10px] text-muted-foreground break-words">
              {action.resultSummary}
            </div>
          )}
          {action.errorMessage && (
            <div className="font-mono text-[10px] text-destructive break-words">
              {action.errorMessage}
            </div>
          )}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-[10px] font-mono text-muted-foreground uppercase">
              {action.executedAt
                ? `Executed ${formatDistanceToNow(new Date(action.executedAt), { addSuffix: true })}`
                : `Requested ${formatDistanceToNow(new Date(action.createdAt), { addSuffix: true })}`}
            </div>
            {action.status === "waiting_approval" && (
              <Link
                href="/approvals"
                className="inline-flex items-center gap-1 text-[10px] font-mono font-bold uppercase text-primary hover:underline"
                data-testid={`link-approval-${action.id}`}
              >
                <ExternalLink className="w-3 h-3" />
                Review in Approvals
              </Link>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
