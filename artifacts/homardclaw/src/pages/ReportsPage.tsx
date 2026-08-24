import React from "react";
import { useGetUsageReport } from "@workspace/api-client-react";
import { Shell } from "@/components/layout/Shell";
import { PixelCard } from "@/components/ui/pixel-card";
import { Badge } from "@/components/ui/badge";
import {
  BarChart3,
  Coins,
  OctagonAlert,
  CheckCircle2,
  XCircle,
  Hourglass,
} from "lucide-react";
import { Link } from "wouter";
import { formatDistanceToNow } from "date-fns";

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return String(tokens);
}

export default function ReportsPage() {
  const { data: report, isLoading } = useGetUsageReport({
    query: { queryKey: ["/api/reports/usage"], refetchInterval: 30_000 },
  });

  return (
    <Shell>
      <div className="p-4 sm:p-6 lg:p-8 max-w-5xl mx-auto space-y-6 sm:space-y-8">
        <div className="border-b-4 border-border pb-6">
          <h1 className="font-display text-lg sm:text-2xl text-foreground uppercase mb-2">
            Ledger
          </h1>
          <p className="text-muted-foreground text-sm">
            Real spend, work outcomes, and blockers — recorded actuals, not
            estimates.
          </p>
        </div>

        {isLoading || !report ? (
          <PixelCard className="p-6 text-sm text-muted-foreground">
            Crunching the numbers…
          </PixelCard>
        ) : (
          <>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <PixelCard className="p-4">
                <div className="text-[10px] uppercase text-muted-foreground mb-1">
                  Last 24h spend
                </div>
                <div className="font-display text-lg text-foreground" data-testid="text-today-cost">
                  {formatCents(report.totals.todayCostCents)}
                </div>
              </PixelCard>
              <PixelCard className="p-4">
                <div className="text-[10px] uppercase text-muted-foreground mb-1">
                  Last 7 days
                </div>
                <div className="font-display text-lg text-foreground">
                  {formatCents(report.totals.last7dCostCents)}
                </div>
              </PixelCard>
              <PixelCard className="p-4">
                <div className="text-[10px] uppercase text-muted-foreground mb-1">
                  This month
                </div>
                <div className="font-display text-lg text-foreground">
                  {formatCents(report.totals.monthCostCents)}
                </div>
              </PixelCard>
              <PixelCard className="p-4">
                <div className="text-[10px] uppercase text-muted-foreground mb-1">
                  Month tokens in / out
                </div>
                <div className="font-display text-lg text-foreground">
                  {formatTokens(report.totals.monthInputTokens)} /{" "}
                  {formatTokens(report.totals.monthOutputTokens)}
                </div>
              </PixelCard>
            </div>

            <PixelCard className="p-4 sm:p-6">
              <h2 className="font-display text-sm uppercase mb-4 flex items-center gap-2">
                <BarChart3 className="w-4 h-4" /> Outcomes (30 days)
              </h2>
              <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3 text-center">
                {(
                  [
                    ["completed", report.outcomes.completed, "text-primary", CheckCircle2],
                    ["failed", report.outcomes.failed, "text-destructive", XCircle],
                    ["blocked", report.outcomes.blocked, "text-destructive", OctagonAlert],
                    ["cancelled", report.outcomes.cancelled, "text-muted-foreground", XCircle],
                    ["queued", report.outcomes.queued, "text-muted-foreground", Hourglass],
                    ["running", report.outcomes.running, "text-accent", Hourglass],
                    ["awaiting approval", report.outcomes.waitingApproval, "text-accent", Hourglass],
                  ] as const
                ).map(([label, count, tone, Icon]) => (
                  <div key={label} className="border-2 border-border p-2">
                    <Icon className={`w-4 h-4 mx-auto mb-1 ${tone}`} />
                    <div className="font-display text-base">{count}</div>
                    <div className="text-[9px] uppercase text-muted-foreground">{label}</div>
                  </div>
                ))}
              </div>
            </PixelCard>

            <PixelCard className="p-4 sm:p-6 overflow-x-auto">
              <h2 className="font-display text-sm uppercase mb-4 flex items-center gap-2">
                <Coins className="w-4 h-4" /> By agent (30 days)
              </h2>
              {report.agents.length === 0 ? (
                <p className="text-sm text-muted-foreground">No active agents.</p>
              ) : (
                <table className="w-full text-sm min-w-[540px]">
                  <thead>
                    <tr className="text-left text-[10px] uppercase text-muted-foreground border-b-2 border-border">
                      <th className="py-2 pr-2">Agent</th>
                      <th className="py-2 pr-2">Status</th>
                      <th className="py-2 pr-2 text-right">Done</th>
                      <th className="py-2 pr-2 text-right">Failed</th>
                      <th className="py-2 pr-2 text-right">Tokens in/out</th>
                      <th className="py-2 text-right">Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.agents.map((agent) => (
                      <tr
                        key={agent.agentId}
                        className="border-b border-border/40"
                        data-testid={`row-agent-${agent.agentId}`}
                      >
                        <td className="py-2 pr-2 font-bold">{agent.name}</td>
                        <td className="py-2 pr-2">
                          <Badge className="bg-muted text-muted-foreground uppercase text-[9px]">
                            {agent.status}
                          </Badge>
                        </td>
                        <td className="py-2 pr-2 text-right">{agent.tasksCompleted}</td>
                        <td className="py-2 pr-2 text-right">{agent.tasksFailed}</td>
                        <td className="py-2 pr-2 text-right">
                          {formatTokens(agent.inputTokens)} / {formatTokens(agent.outputTokens)}
                        </td>
                        <td className="py-2 text-right">{formatCents(agent.costCents)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </PixelCard>

            <PixelCard className="p-4 sm:p-6 overflow-x-auto">
              <h2 className="font-display text-sm uppercase mb-4">By provider (30 days)</h2>
              {report.providers.length === 0 ? (
                <p className="text-sm text-muted-foreground">No tasks yet.</p>
              ) : (
                <table className="w-full text-sm min-w-[420px]">
                  <thead>
                    <tr className="text-left text-[10px] uppercase text-muted-foreground border-b-2 border-border">
                      <th className="py-2 pr-2">Provider</th>
                      <th className="py-2 pr-2 text-right">Tasks</th>
                      <th className="py-2 pr-2 text-right">Tokens in/out</th>
                      <th className="py-2 text-right">Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.providers.map((provider) => (
                      <tr key={provider.provider} className="border-b border-border/40">
                        <td className="py-2 pr-2 font-bold uppercase">{provider.provider}</td>
                        <td className="py-2 pr-2 text-right">{provider.tasks}</td>
                        <td className="py-2 pr-2 text-right">
                          {formatTokens(provider.inputTokens)} /{" "}
                          {formatTokens(provider.outputTokens)}
                        </td>
                        <td className="py-2 text-right">{formatCents(provider.costCents)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </PixelCard>

            <PixelCard className="p-4 sm:p-6">
              <h2 className="font-display text-sm uppercase mb-4 flex items-center gap-2">
                <OctagonAlert className="w-4 h-4 text-destructive" /> Needs attention
              </h2>
              {report.blockers.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  Nothing blocked or waiting on you.
                </p>
              ) : (
                <div className="space-y-3">
                  {report.blockers.map((blocker) => (
                    <div
                      key={blocker.taskId}
                      className="border-2 border-border p-3"
                      data-testid={`card-blocker-${blocker.taskId}`}
                    >
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-bold text-xs uppercase">{blocker.agentName}</span>
                        {blocker.errorKind && (
                          <Badge className="bg-destructive/20 text-destructive uppercase text-[9px]">
                            {blocker.errorKind}
                          </Badge>
                        )}
                        <span className="text-[10px] text-muted-foreground ml-auto">
                          {formatDistanceToNow(new Date(blocker.createdAt), { addSuffix: true })}
                        </span>
                      </div>
                      <p className="text-sm text-muted-foreground mt-1 line-clamp-2">
                        {blocker.objective}
                      </p>
                      {blocker.errorMessage && (
                        <p className="text-[11px] text-destructive mt-1">{blocker.errorMessage}</p>
                      )}
                      <Link
                        href="/tasks"
                        className="text-[11px] uppercase font-bold text-accent hover:underline mt-1 inline-block"
                      >
                        View tasks
                      </Link>
                    </div>
                  ))}
                </div>
              )}
            </PixelCard>
          </>
        )}
      </div>
    </Shell>
  );
}
