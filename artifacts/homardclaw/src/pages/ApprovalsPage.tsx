import React, { useState } from "react";
import {
  useListApprovals,
  useListAgents,
  useDecideApproval,
  useGetApprovalSettings,
  useUpdateApprovalSettings,
  getGetApprovalSettingsQueryKey,
  useGetInspectorSettings,
  useUpdateInspectorSettings,
  getGetInspectorSettingsQueryKey,
  useSearchAudit,
  useVerifyAudit,
  ApprovalDecisionDecision,
} from "@workspace/api-client-react";
import { Shell } from "@/components/layout/Shell";
import { AlwaysApproveSwitch } from "@/components/approvals/approval-preferences";
import { PixelCard } from "@/components/ui/pixel-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
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
  UserCheck,
  SearchCheck,
  BellRing,
} from "lucide-react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { approvalKindLabel } from "@/lib/continuation";

const MANUAL_REVIEW = "__manual_review__";
const NO_INSPECTOR = "__no_inspector__";
const INSPECTION_RETRY_OPTIONS = [1, 2, 3] as const;

function apiErrorMessage(error: unknown, fallback: string): string {
  return (
    (error as { response?: { data?: { error?: string } } })?.response?.data
      ?.error ?? fallback
  );
}

export default function ApprovalsPage() {
  const { data: approvals, isLoading } = useListApprovals();
  const { data: agents } = useListAgents();
  const { data: approvalSettings } = useGetApprovalSettings();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: inspectorSettings } = useGetInspectorSettings();

  const eligibleReviewers = (agents ?? []).filter(
    (agent) =>
      !agent.archived &&
      agent.status !== "paused" &&
      !agent.sensitiveDataSandbox,
  );
  // The inspector reads completed work, so the same eligibility applies.
  const eligibleInspectors = eligibleReviewers;

  const updateApprovalSettings = useUpdateApprovalSettings({
    mutation: {
      onSuccess: async (settings) => {
        queryClient.setQueryData(getGetApprovalSettingsQueryKey(), settings);
        await queryClient.invalidateQueries({ queryKey: ["/api/approvals"] });
        toast({
          title: settings.reviewerAgentName
            ? `${settings.reviewerAgentName} is on approval duty`
            : "Automatic review disabled",
          description: settings.reviewerAgentName
            ? "Clear requests can be approved automatically; uncertain ones still notify you."
            : "New approval requests will notify you directly.",
        });
      },
      onError: (error) => {
        toast({
          variant: "destructive",
          title: "Could not change the approval reviewer",
          description: apiErrorMessage(error, "Try again."),
        });
      },
    },
  });

  const updateInspectorSettings = useUpdateInspectorSettings({
    mutation: {
      onSuccess: (settings) => {
        queryClient.setQueryData(getGetInspectorSettingsQueryKey(), settings);
        toast({
          title: settings.inspectorAgentName
            ? `${settings.inspectorAgentName} is on inspection duty`
            : "Completed-work inspection disabled",
          description: settings.inspectorAgentName
            ? "Completed tasks are checked against their outputs; needs-fix results get a corrective retry."
            : "Completed tasks will no longer be inspected automatically.",
        });
      },
      onError: (error) => {
        toast({
          variant: "destructive",
          title: "Could not change the inspector",
          description: apiErrorMessage(error, "Try again."),
        });
      },
    },
  });

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

        <PixelCard className="border-border">
          <AlwaysApproveSwitch idPrefix="approvals-board" />
        </PixelCard>

        <PixelCard className="border-accent/50">
          <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_minmax(16rem,22rem)] md:items-center">
            <div className="flex items-start gap-3">
              <div className="shrink-0 border-2 border-border bg-accent/15 p-2 text-accent pixel-shadow">
                <UserCheck className="h-5 w-5" />
              </div>
              <div>
                <h2 className="font-display text-sm uppercase">
                  Automatic approval officer
                </h2>
                <p className="mt-2 text-xs leading-5 text-muted-foreground">
                  This Crustabot reads initial task requests, connected-app
                  actions, and later task continuations. It approves only a
                  clear, high-certainty request. If context is missing, the
                  request stays pending and you receive the normal notification.
                </p>
                <p className="mt-2 text-[10px] font-mono uppercase text-muted-foreground">
                  No self-approval · no auto-rejection · hard safety checks
                  still apply
                </p>
              </div>
            </div>
            <div className="space-y-2">
              <label className="text-[10px] font-bold uppercase text-muted-foreground">
                Crustabot on duty
              </label>
              <Select
                value={approvalSettings?.reviewerAgentId ?? MANUAL_REVIEW}
                onValueChange={(value) =>
                  updateApprovalSettings.mutate({
                    data: {
                      reviewerAgentId: value === MANUAL_REVIEW ? null : value,
                    },
                  })
                }
                disabled={updateApprovalSettings.isPending}
              >
                <SelectTrigger
                  className="rounded-none border-4 border-border bg-background font-mono text-xs uppercase focus:ring-0"
                  aria-label="Choose the automatic approval reviewer"
                >
                  <SelectValue placeholder="Manual notification mode" />
                </SelectTrigger>
                <SelectContent className="max-h-72 rounded-none border-4 border-border bg-card">
                  <SelectItem
                    value={MANUAL_REVIEW}
                    className="font-mono text-xs uppercase"
                  >
                    Manual notification mode
                  </SelectItem>
                  {eligibleReviewers.map((agent) => (
                    <SelectItem
                      key={agent.id}
                      value={agent.id}
                      className="font-mono text-xs uppercase"
                    >
                      {agent.name} — {agent.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[10px] leading-4 text-muted-foreground">
                Uses that Crustabot&apos;s provider and model. If the reviewer
                is unavailable or cannot safely decide, Crustabox switches this
                request to notification mode.
              </p>
            </div>
          </div>
        </PixelCard>

        <PixelCard className="border-accent/50">
          <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_minmax(16rem,22rem)] md:items-center">
            <div className="flex items-start gap-3">
              <div className="shrink-0 border-2 border-border bg-accent/15 p-2 text-accent pixel-shadow">
                <SearchCheck className="h-5 w-5" />
              </div>
              <div>
                <h2 className="font-display text-sm uppercase">
                  Completed-work inspector
                </h2>
                <p className="mt-2 text-xs leading-5 text-muted-foreground">
                  This Crustabot reviews each completed task against its actual
                  outputs — including external ones like Google Drive — and
                  records a pass, needs-fix, or cannot-verify verdict. A
                  needs-fix result queues a corrective retry for the original
                  Crustabot, up to the retry cap.
                </p>
                <p className="mt-2 text-[10px] font-mono uppercase text-muted-foreground">
                  No self-inspection · read-only review · bounded retries
                </p>
              </div>
            </div>
            <div className="space-y-4">
              <div className="space-y-2">
                <label className="text-[10px] font-bold uppercase text-muted-foreground">
                  Crustabot on duty
                </label>
                <Select
                  value={inspectorSettings?.inspectorAgentId ?? NO_INSPECTOR}
                  onValueChange={(value) =>
                    updateInspectorSettings.mutate({
                      data: {
                        inspectorAgentId:
                          value === NO_INSPECTOR ? null : value,
                      },
                    })
                  }
                  disabled={updateInspectorSettings.isPending}
                >
                  <SelectTrigger
                    className="rounded-none border-4 border-border bg-background font-mono text-xs uppercase focus:ring-0"
                    aria-label="Choose the completed-work inspector"
                  >
                    <SelectValue placeholder="Inspection disabled" />
                  </SelectTrigger>
                  <SelectContent className="max-h-72 rounded-none border-4 border-border bg-card">
                    <SelectItem
                      value={NO_INSPECTOR}
                      className="font-mono text-xs uppercase"
                    >
                      Inspection disabled
                    </SelectItem>
                    {eligibleInspectors.map((agent) => (
                      <SelectItem
                        key={agent.id}
                        value={agent.id}
                        className="font-mono text-xs uppercase"
                      >
                        {agent.name} — {agent.title}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {inspectorSettings?.inspectorAgentId && (
                <div className="flex items-start justify-between gap-3">
                  <label
                    htmlFor="inspector-retry-limit"
                    className="text-[10px] font-mono uppercase text-muted-foreground"
                  >
                    Corrective-retry cap
                    <span className="block normal-case text-muted-foreground/80">
                      Corrective retries a task lineage may spawn before the
                      inspector stops.
                    </span>
                  </label>
                  <Select
                    value={String(
                      inspectorSettings?.inspectionRetryLimit ?? 1,
                    )}
                    onValueChange={(value) =>
                      updateInspectorSettings.mutate({
                        data: {
                          inspectorAgentId:
                            inspectorSettings?.inspectorAgentId ?? null,
                          inspectionRetryLimit: Number(value),
                        },
                      })
                    }
                    disabled={updateInspectorSettings.isPending}
                  >
                    <SelectTrigger
                      id="inspector-retry-limit"
                      className="w-20 rounded-none border-4 border-border bg-background font-mono text-xs uppercase focus:ring-0"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="rounded-none border-4 border-border bg-card">
                      {INSPECTION_RETRY_OPTIONS.map((limit) => (
                        <SelectItem
                          key={limit}
                          value={String(limit)}
                          className="font-mono text-xs uppercase"
                        >
                          {limit}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>
          </div>
        </PixelCard>

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
                              {approvalKindLabel(approval.kind) && (
                                <Badge
                                  variant="accent"
                                  data-testid="badge-continuation-request"
                                >
                                  {approvalKindLabel(approval.kind)}
                                </Badge>
                              )}
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
                            {(approval.autoReviewStatus === "queued" ||
                              approval.autoReviewStatus === "reviewing") && (
                              <div className="mt-3 flex items-center gap-2 text-xs text-accent">
                                <UserCheck className="h-4 w-4" />
                                <span className="font-bold uppercase">
                                  {approval.reviewerAgentName ??
                                    "Approval officer"}{" "}
                                  is reviewing
                                </span>
                              </div>
                            )}
                            {approval.autoReviewStatus === "notified" && (
                              <div className="mt-3 border-2 border-border bg-background/60 p-3 text-xs">
                                <div className="mb-1 flex items-center gap-2 font-bold uppercase text-accent">
                                  <BellRing className="h-4 w-4" />
                                  Manual decision requested
                                </div>
                                <p className="text-muted-foreground">
                                  {approval.autoReviewReason ??
                                    "The automatic reviewer was not certain enough to approve."}
                                </p>
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
                          {approval.autoReviewStatus === "approved" && (
                            <Badge variant="outline">
                              {approval.reviewerAgentName
                                ? `Auto · ${approval.reviewerAgentName}`
                                : "Auto-reviewed"}
                            </Badge>
                          )}
                          <span className="text-xs font-bold uppercase text-muted-foreground">
                            {approval.agentName}
                          </span>
                          {approvalKindLabel(approval.kind) && (
                            <Badge variant="outline" className="text-[9px]">
                              {approvalKindLabel(approval.kind)}
                            </Badge>
                          )}
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
