import React, { useState } from "react";
import {
  useListApprovals,
  useDecideApproval,
  useSearchAudit,
  useVerifyAudit,
  ApprovalDecisionDecision,
} from "@workspace/api-client-react";
import { Shell } from "@/components/layout/Shell";
import { PixelCard } from "@/components/ui/pixel-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Shield,
  Check,
  X,
  Clock,
  AlertOctagon,
  ScrollText,
  Search,
  ShieldCheck,
  ShieldAlert,
} from "lucide-react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";

export default function ApprovalsPage() {
  const { data: approvals, isLoading } = useListApprovals();
  const queryClient = useQueryClient();

  const decideApproval = useDecideApproval({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: ["/api/approvals"] });
        queryClient.invalidateQueries({ queryKey: ["/api/office/overview"] });
        queryClient.invalidateQueries({ queryKey: ["/api/tasks"] });
        queryClient.invalidateQueries({ queryKey: ["/api/audit"] });
      },
    },
  });

  const handleDecision = (
    approvalId: string,
    decision: ApprovalDecisionDecision,
  ) => {
    decideApproval.mutate({
      approvalId,
      data: { decision },
    });
  };

  const pendingApprovals =
    approvals?.filter((a) => a.status === "pending") || [];
  const historyApprovals =
    approvals?.filter((a) => a.status !== "pending") || [];

  return (
    <Shell>
      <div className="p-4 sm:p-6 lg:p-8 max-w-5xl mx-auto space-y-6 sm:space-y-8">
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-4 border-b-4 border-border pb-6">
          <div>
            <h1 className="font-display text-lg sm:text-2xl text-foreground uppercase mb-2">
              Authorization Desk
            </h1>
            <p className="text-muted-foreground text-sm">
              Review restricted actions requested by Crustabots.
            </p>
          </div>

          <Badge
            variant={pendingApprovals.length > 0 ? "accent" : "outline"}
            className="px-3 py-1 text-sm"
          >
            {pendingApprovals.length} Pending
          </Badge>
        </div>

        {isLoading ? (
          <div className="space-y-4">
            {[1, 2].map((i) => (
              <PixelCard key={i} className="animate-pulse h-32 bg-muted/50">
                <div className="w-full h-full"></div>
              </PixelCard>
            ))}
          </div>
        ) : (
          <>
            {/* Pending Approvals */}
            <div className="space-y-6">
              <h2 className="font-display text-lg uppercase flex items-center gap-2 text-accent">
                <AlertOctagon className="w-5 h-5" />
                Requires Action
              </h2>

              {pendingApprovals.length === 0 ? (
                <PixelCard className="text-center p-8 border-dashed">
                  <Shield className="w-12 h-12 text-muted-foreground mx-auto mb-4 opacity-50" />
                  <p className="text-muted-foreground uppercase font-bold text-sm">
                    All clear. No pending requests.
                  </p>
                </PixelCard>
              ) : (
                <div className="space-y-4">
                  {pendingApprovals.map((approval) => (
                    <PixelCard
                      key={approval.id}
                      variant="accent"
                      className="border-accent/50"
                    >
                      <div className="flex flex-col md:flex-row gap-6">
                        <div className="flex-1 space-y-4">
                          <div>
                            <div className="flex items-center gap-2 mb-2">
                              <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider">
                                Requested By:
                              </span>
                              <Badge variant="outline">
                                {approval.agentName}
                              </Badge>
                              <span className="text-muted-foreground text-[10px] ml-auto">
                                Expires{" "}
                                {formatDistanceToNow(
                                  new Date(approval.expiresAt),
                                  { addSuffix: true },
                                )}
                              </span>
                            </div>
                            <h3 className="font-bold text-lg mb-2">
                              {approval.action}
                            </h3>
                            {approval.details && (
                              <div className="bg-muted p-3 border-2 border-border font-mono text-sm">
                                {approval.details}
                              </div>
                            )}
                            {approval.taskId && (
                              <div className="mt-2 text-xs font-mono">
                                <span className="uppercase font-bold text-muted-foreground">
                                  Task:{" "}
                                </span>
                                <Link
                                  href={`/tasks/${approval.taskId}`}
                                  className="underline decoration-2 underline-offset-2 hover:text-accent"
                                >
                                  {approval.taskObjective
                                    ? approval.taskObjective.length > 100
                                      ? `${approval.taskObjective.slice(0, 100)}…`
                                      : approval.taskObjective
                                    : "View task"}
                                </Link>
                              </div>
                            )}
                          </div>
                        </div>

                        <div className="flex flex-row md:flex-col gap-3 justify-end shrink-0 border-t-4 md:border-t-0 md:border-l-4 border-border/30 pt-4 md:pt-0 md:pl-6">
                          <Button
                            variant="primary"
                            className="flex-1 md:flex-none"
                            onClick={() =>
                              handleDecision(
                                approval.id,
                                ApprovalDecisionDecision.approved,
                              )
                            }
                            disabled={decideApproval.isPending}
                          >
                            <Check className="w-4 h-4 mr-2" />
                            Approve
                          </Button>
                          <Button
                            variant="outline"
                            className="flex-1 md:flex-none border-destructive text-destructive hover:bg-destructive hover:text-white"
                            onClick={() =>
                              handleDecision(
                                approval.id,
                                ApprovalDecisionDecision.rejected,
                              )
                            }
                            disabled={decideApproval.isPending}
                          >
                            <X className="w-4 h-4 mr-2" />
                            Reject
                          </Button>
                        </div>
                      </div>
                    </PixelCard>
                  ))}
                </div>
              )}
            </div>

            {/* History */}
            {historyApprovals.length > 0 && (
              <div className="mt-12 space-y-6 opacity-75">
                <h2 className="font-display text-sm uppercase flex items-center gap-2 text-muted-foreground">
                  <Clock className="w-4 h-4" />
                  Decision History
                </h2>

                <div className="space-y-3">
                  {historyApprovals.slice(0, 10).map((approval) => (
                    <div
                      key={approval.id}
                      className="bg-card border-2 border-border p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4"
                    >
                      <div>
                        <div className="flex items-center gap-2 mb-1">
                          <Badge
                            variant={
                              approval.status === "approved"
                                ? "success"
                                : approval.status === "rejected"
                                  ? "destructive"
                                  : "default"
                            }
                          >
                            {approval.status}
                          </Badge>
                          <span className="text-xs font-bold uppercase text-muted-foreground">
                            {approval.agentName}
                          </span>
                        </div>
                        <div className="font-mono text-sm">
                          {approval.action}
                        </div>
                        {approval.taskId && (
                          <Link
                            href={`/tasks/${approval.taskId}`}
                            className="text-[10px] font-mono uppercase underline decoration-2 underline-offset-2 hover:text-accent"
                          >
                            View task
                          </Link>
                        )}
                      </div>
                      <div className="text-[10px] text-muted-foreground uppercase text-right">
                        <div>
                          {new Date(approval.createdAt).toLocaleString()}
                        </div>
                        {approval.decidedAt && (
                          <div>
                            Decided{" "}
                            {new Date(approval.decidedAt).toLocaleString()}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <AuditLogSection />
          </>
        )}
      </div>
    </Shell>
  );
}

/**
 * Searchable, tamper-evident audit history. The verify badge recomputes
 * the server-side hash chain; any edited or deleted record flips it red.
 */
function AuditLogSection() {
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState("");
  const { data: audit, isLoading } = useSearchAudit(
    submitted ? { q: submitted, limit: 50 } : { limit: 50 },
  );
  const { data: verification } = useVerifyAudit();

  return (
    <div className="mt-12 space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <h2 className="font-display text-sm uppercase flex items-center gap-2 text-muted-foreground">
          <ScrollText className="w-4 h-4" />
          Audit History
        </h2>
        {verification &&
          (verification.valid ? (
            <Badge variant="success" className="flex items-center gap-1">
              <ShieldCheck className="w-3 h-3" />
              Chain verified ({verification.checked} records)
            </Badge>
          ) : (
            <Badge variant="destructive" className="flex items-center gap-1">
              <ShieldAlert className="w-3 h-3" />
              Tampering detected
            </Badge>
          ))}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          setSubmitted(query.trim());
        }}
        className="flex gap-2"
      >
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search the audit log…"
          className="font-mono bg-background border-4 border-border rounded-none focus-visible:ring-0 focus-visible:border-primary"
        />
        <Button type="submit" variant="outline">
          <Search className="w-4 h-4" />
        </Button>
      </form>

      {isLoading ? (
        <div className="text-muted-foreground text-xs uppercase font-bold">
          Loading…
        </div>
      ) : !audit || audit.events.length === 0 ? (
        <div className="bg-card border-2 border-dashed border-border p-6 text-center text-muted-foreground text-xs uppercase font-bold">
          {submitted
            ? `No records match "${submitted}".`
            : "No audit records yet."}
        </div>
      ) : (
        <div className="space-y-2">
          <div className="text-[10px] text-muted-foreground uppercase font-bold">
            {audit.total} record(s){submitted ? ` matching "${submitted}"` : ""}
          </div>
          {audit.events.map((event) => (
            <div
              key={event.id}
              className="bg-card border-2 border-border p-3 flex items-start justify-between gap-4"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <Badge variant="outline" className="text-[9px]">
                    {event.kind}
                  </Badge>
                  {event.chained === false && (
                    <span
                      className="text-[9px] uppercase font-bold text-muted-foreground"
                      title="Recorded before tamper-evident chaining was introduced"
                    >
                      unchained
                    </span>
                  )}
                </div>
                <div className="font-mono text-xs break-words">
                  {event.summary}
                </div>
              </div>
              <div className="text-[10px] text-muted-foreground uppercase text-right shrink-0">
                {new Date(event.createdAt).toLocaleString()}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
