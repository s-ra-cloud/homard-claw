import React from "react";
import { useGetMe, useListBugReports } from "@workspace/api-client-react";
import { Shell } from "@/components/layout/Shell";
import { PixelCard } from "@/components/ui/pixel-card";
import { Badge } from "@/components/ui/badge";
import { Bug, ShieldAlert, Link as LinkIcon } from "lucide-react";
import { Link } from "wouter";
import { formatDistanceToNow, format } from "date-fns";

export default function BugReportsPage() {
  const { data: me, isLoading: meLoading } = useGetMe();
  const isOwner = me?.isOwner ?? false;
  const { data, isLoading } = useListBugReports({
    query: { queryKey: ["/api/bug-reports"], enabled: isOwner },
  });

  if (!meLoading && !isOwner) {
    return (
      <Shell>
        <div className="p-4 sm:p-6 lg:p-8 max-w-3xl mx-auto">
          <PixelCard className="text-center p-8 sm:p-12" variant="destructive">
            <ShieldAlert className="w-10 h-10 text-destructive mx-auto mb-4" />
            <h1 className="font-display text-lg uppercase mb-2">Restricted</h1>
            <p className="text-muted-foreground text-sm">
              Bug reports are visible to the office owner only.
            </p>
          </PixelCard>
        </div>
      </Shell>
    );
  }

  const reports = data?.reports ?? [];

  return (
    <Shell>
      <div className="p-4 sm:p-6 lg:p-8 max-w-4xl mx-auto space-y-6">
        <div className="border-b-4 border-border pb-6">
          <Link
            href="/providers"
            className="text-[10px] font-bold uppercase text-muted-foreground hover:text-foreground"
          >
            ← Providers
          </Link>
          <h1 className="font-display text-lg sm:text-2xl text-foreground uppercase mt-2 mb-2">
            Bug Reports
          </h1>
          <p className="text-muted-foreground text-sm">
            Filed from task details, newest first. Visible to you alone.
          </p>
        </div>

        {meLoading || isLoading ? (
          <div className="space-y-3">
            {[1, 2, 3].map((i) => (
              <PixelCard key={i} className="h-24 animate-pulse bg-muted/50">
                <div className="w-full h-full" />
              </PixelCard>
            ))}
          </div>
        ) : reports.length === 0 ? (
          <PixelCard className="text-center p-8 sm:p-12">
            <Bug className="w-10 h-10 text-muted-foreground mx-auto mb-4" />
            <h3 className="font-display text-sm uppercase mb-2">
              No bug reports yet
            </h3>
            <p className="text-muted-foreground text-sm">
              File one from a task's detail view when something looks wrong.
            </p>
          </PixelCard>
        ) : (
          <div className="space-y-3">
            {reports.map((report) => (
              <div key={report.id} data-testid={`card-bug-report-${report.id}`}>
                <PixelCard className="space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <Bug className="w-4 h-4 text-destructive" />
                      {report.context.agentName && (
                        <Badge variant="outline">
                          {report.context.agentName}
                        </Badge>
                      )}
                      {report.context.taskStatus && (
                        <Badge variant="outline">
                          {report.context.taskStatus}
                        </Badge>
                      )}
                    </div>
                    <time
                      className="text-[10px] font-mono text-muted-foreground uppercase"
                      dateTime={report.createdAt}
                      title={format(new Date(report.createdAt), "PPpp")}
                    >
                      {formatDistanceToNow(new Date(report.createdAt), {
                        addSuffix: true,
                      })}
                    </time>
                  </div>

                  {report.context.taskObjective && (
                    <p className="font-mono text-xs bg-muted/30 border-2 border-border/50 p-3 whitespace-pre-wrap">
                      {report.context.taskObjective}
                    </p>
                  )}

                  {report.description && (
                    <p className="text-sm whitespace-pre-wrap">
                      {report.description}
                    </p>
                  )}

                  {report.context.errorMessage && (
                    <div className="border-2 border-destructive/60 bg-destructive/10 p-2">
                      <div className="text-[10px] font-bold uppercase text-destructive mb-1">
                        {report.context.errorKind
                          ? report.context.errorKind.replace(/_/g, " ")
                          : "Error"}
                      </div>
                      <p className="font-mono text-xs">
                        {report.context.errorMessage}
                      </p>
                    </div>
                  )}

                  <div className="flex flex-wrap items-center gap-3 text-[10px] font-mono text-muted-foreground uppercase">
                    {report.context.provider && (
                      <span>
                        {report.context.provider}
                        {report.context.model
                          ? ` · ${report.context.model}`
                          : ""}
                      </span>
                    )}
                    {report.taskId && (
                      <Link
                        href="/tasks"
                        className="text-accent font-bold hover:underline inline-flex items-center gap-1 normal-case"
                      >
                        <LinkIcon className="w-3 h-3" /> Open task
                      </Link>
                    )}
                  </div>
                </PixelCard>
              </div>
            ))}
          </div>
        )}
      </div>
    </Shell>
  );
}
