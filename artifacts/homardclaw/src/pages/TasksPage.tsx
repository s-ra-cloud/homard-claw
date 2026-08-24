import React, { useEffect, useMemo, useState } from "react";
import {
  useListTasks,
  useCreateTask,
  useListAgents,
  useListProviderModels,
  useGetProviderSettings,
  useEstimateTask,
  useGetTask,
  useGetTaskTree,
  useListAgentMessages,
  useListTeams,
  useDelegateTask,
  useCancelTask,
  useRetryTask,
  TaskStatus,
  TaskInputPriority,
  TaskInputProviderOverride,
  type Task,
  type TaskEstimate,
  type TaskLog,
} from "@workspace/api-client-react";
import { Shell } from "@/components/layout/Shell";
import { PixelCard } from "@/components/ui/pixel-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Activity, Play, Clock, AlertTriangle, CheckCircle, Calculator, Ban, RotateCcw, ScrollText, XCircle, Network } from "lucide-react";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatDistanceToNow } from "date-fns";

const selectTriggerClass =
  "bg-background border-4 border-border rounded-none focus:ring-0 focus:border-primary font-mono text-sm uppercase";
const selectContentClass = "border-4 border-border rounded-none bg-card max-h-72";
const selectItemClass =
  "font-mono text-xs uppercase focus:bg-primary focus:text-primary-foreground";

const MODEL_DEFAULT_SENTINEL = "__routing_default__";

function formatCents(cents: number): string {
  if (cents === 0) return "$0.00";
  const dollars = cents / 100;
  return dollars < 0.01 ? `$${dollars.toFixed(4)}` : `$${dollars.toFixed(2)}`;
}

function formatTokens(tokens: number): string {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
}

/** Live dispatch estimate: provider, model, tokens, and cost. */
function EstimatePanel({
  agentId,
  objective,
  providerOverride,
  modelOverride,
}: {
  agentId: string;
  objective: string;
  providerOverride: TaskInputProviderOverride | "";
  modelOverride: string;
}) {
  const estimateTask = useEstimateTask();
  const [estimate, setEstimate] = useState<TaskEstimate | null>(null);
  const [failed, setFailed] = useState(false);
  const ready = Boolean(agentId) && objective.trim().length >= 3;

  useEffect(() => {
    if (!ready) {
      setEstimate(null);
      setFailed(false);
      return;
    }
    const timer = setTimeout(() => {
      estimateTask
        .mutateAsync({
          data: {
            agentId,
            objective,
            ...(providerOverride ? { providerOverride } : {}),
            ...(modelOverride ? { modelOverride } : {}),
          },
        })
        .then((result) => {
          setEstimate(result);
          setFailed(false);
        })
        .catch(() => setFailed(true));
    }, 400);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, agentId, objective, providerOverride, modelOverride]);

  if (!ready) return null;

  return (
    <div className="bg-muted/30 border-2 border-border/50 p-3 space-y-2">
      <div className="flex items-center gap-2 text-[10px] font-bold uppercase text-muted-foreground">
        <Calculator className="w-3 h-3" />
        Dispatch Estimate
      </div>
      {failed ? (
        <div className="text-[10px] font-mono text-destructive uppercase">
          Estimate unavailable.
        </div>
      ) : !estimate ? (
        <div className="text-[10px] font-mono text-muted-foreground uppercase animate-pulse">
          Calculating...
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 font-mono text-xs">
            <div>
              <div className="text-[9px] text-muted-foreground uppercase font-bold">Provider</div>
              <div className="uppercase">{estimate.provider.replace("_", " ")}</div>
            </div>
            <div className="col-span-1 sm:col-span-1 min-w-0">
              <div className="text-[9px] text-muted-foreground uppercase font-bold">Model</div>
              <div className="truncate" title={estimate.model}>{estimate.model}</div>
            </div>
            <div>
              <div className="text-[9px] text-muted-foreground uppercase font-bold">Est. Tokens</div>
              <div>~{formatTokens(estimate.estimatedTokens)}</div>
            </div>
            <div>
              <div className="text-[9px] text-muted-foreground uppercase font-bold">Est. Cost</div>
              <div>{estimate.costKnown ? `~${formatCents(estimate.estimatedCostCents)}` : "Unknown"}</div>
            </div>
          </div>
          {estimate.note && (
            <div className="text-[10px] font-mono text-muted-foreground border-l-4 border-border pl-2">
              {estimate.note}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** Optional model override select fed by the effective provider's catalog. */
function ModelOverrideSelect({
  provider,
  value,
  onChange,
}: {
  provider: "claude_max" | "openrouter";
  value: string;
  onChange: (value: string) => void;
}) {
  const { data: catalog } = useListProviderModels(provider);
  const hasCatalog = Boolean(catalog?.available && catalog.models.length > 0);
  if (!hasCatalog) {
    return (
      <div className="text-[10px] font-mono text-muted-foreground uppercase border-l-4 border-border pl-2">
        {catalog?.message ?? "Model catalog unavailable — routing default will be used."}
      </div>
    );
  }
  return (
    <Select
      value={value || MODEL_DEFAULT_SENTINEL}
      onValueChange={(val) => onChange(val === MODEL_DEFAULT_SENTINEL ? "" : val)}
    >
      <SelectTrigger className={selectTriggerClass}>
        <SelectValue placeholder="Routing default" />
      </SelectTrigger>
      <SelectContent className={selectContentClass}>
        <SelectItem value={MODEL_DEFAULT_SENTINEL} className={selectItemClass}>
          Routing Default
        </SelectItem>
        {catalog!.models.map((model) => (
          <SelectItem key={model.id} value={model.id} className={selectItemClass}>
            {model.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

const LOG_LEVEL_CLASS: Record<string, string> = {
  info: "text-muted-foreground",
  warn: "text-yellow-600 dark:text-yellow-500",
  error: "text-destructive",
};

function TaskLogList({ logs }: { logs: TaskLog[] }) {
  if (logs.length === 0) {
    return (
      <div className="text-[10px] font-mono text-muted-foreground uppercase">
        No log entries yet.
      </div>
    );
  }
  return (
    <div className="space-y-1 max-h-56 overflow-y-auto bg-background border-2 border-border/50 p-3">
      {logs.map((log) => (
        <div key={log.id} className="font-mono text-[11px] leading-relaxed flex gap-2">
          <span className="text-muted-foreground shrink-0">
            {new Date(log.createdAt).toLocaleTimeString()}
          </span>
          <span className={LOG_LEVEL_CLASS[log.level] ?? "text-muted-foreground"}>
            {log.message}
          </span>
        </div>
      ))}
    </div>
  );
}

const CANCELLABLE: TaskStatus[] = [
  TaskStatus.queued,
  TaskStatus.running,
  TaskStatus.waiting_approval,
  TaskStatus.blocked,
];
const RETRYABLE: TaskStatus[] = [
  TaskStatus.failed,
  TaskStatus.cancelled,
  TaskStatus.blocked,
];

/** Full task inspector: live status, output, error, and execution logs. */
/**
 * The delegation view for one task: who handed it over, the tree of
 * sub-tasks it belongs to, the messages exchanged around it, and — when the
 * agent leads a team — a form to hand a slice of work to a teammate.
 */
function DelegationSection({ task }: { task: Task }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [objective, setObjective] = useState("");
  const [teammateId, setTeammateId] = useState("");

  const { data: tree } = useGetTaskTree(task.id, {
    query: { queryKey: [`/api/tasks/${task.id}/tree`] },
  });
  const { data: messages } = useListAgentMessages(
    { taskId: task.id },
    { query: { queryKey: [`/api/messages?taskId=${task.id}`] } },
  );
  const { data: teams } = useListTeams({ query: { queryKey: ["/api/teams"] } });

  // Only a lead may delegate, and only to its own team's members.
  const ledTeam = teams?.find((team) => team.leadAgentId === task.agentId);
  const teammates =
    ledTeam?.members.filter((member) => member.agentId !== task.agentId) ?? [];
  const canDelegate =
    teammates.length > 0 &&
    !["completed", "failed", "cancelled"].includes(task.status);

  const delegate = useDelegateTask({
    mutation: {
      onSuccess: () => {
        setObjective("");
        setTeammateId("");
        void queryClient.invalidateQueries({ queryKey: [`/api/tasks/${task.id}/tree`] });
        void queryClient.invalidateQueries({
          queryKey: [`/api/messages?taskId=${task.id}`],
        });
        void queryClient.invalidateQueries({ queryKey: ["/api/tasks"] });
        toast({ title: "Sub-task delegated" });
      },
      onError: (error: unknown) => {
        toast({
          title: "Could not delegate",
          description:
            error instanceof Error ? error.message : "The office refused that hand-off.",
          variant: "destructive",
        });
      },
    },
  });

  const nodes = tree?.nodes ?? [];
  const hasTree = nodes.length > 1;
  const hasMessages = (messages?.length ?? 0) > 0;
  if (!hasTree && !hasMessages && !canDelegate) return null;

  return (
    <div className="space-y-4 border-t-4 border-border pt-4">
      <div className="flex items-center gap-2 text-[10px] font-bold uppercase text-muted-foreground">
        <Network className="w-3 h-3" />
        Delegation
      </div>

      {task.delegatedByAgentName && (
        <p className="font-mono text-xs text-muted-foreground">
          Handed over by{" "}
          <span className="text-accent font-bold">{task.delegatedByAgentName}</span>
          {task.teamName ? ` · ${task.teamName}` : ""}
        </p>
      )}

      {hasTree && (
        <div className="space-y-1" data-testid="task-tree">
          {nodes.map((node) => (
            <div
              key={node.id}
              className={`flex items-start gap-2 border-2 p-2 font-mono text-xs ${
                node.id === task.id
                  ? "border-primary bg-primary/10"
                  : "border-border/50 bg-muted/20"
              }`}
              style={{ marginLeft: `${Math.min(node.depth, 4) * 16}px` }}
            >
              <TaskStatusBadge status={node.status} />
              <div className="min-w-0 flex-1">
                <div className="truncate">{node.objective}</div>
                <div className="text-[10px] uppercase text-muted-foreground">
                  {node.agentName}
                  {node.delegatedByAgentName ? ` ← ${node.delegatedByAgentName}` : ""}
                  {node.actualCostCents != null
                    ? ` · ${formatCents(node.actualCostCents)}`
                    : ""}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {hasMessages && (
        <div className="space-y-1">
          <div className="text-[10px] font-bold uppercase text-muted-foreground">
            Messages
          </div>
          {messages!.map((message) => (
            <div
              key={message.id}
              className="border-2 border-border/50 bg-background p-2 font-mono text-xs"
            >
              <div className="text-[10px] uppercase text-muted-foreground">
                {message.fromAgentName ?? "Office"} →{" "}
                {message.toAgentName ?? "Office"} · {message.kind}
              </div>
              <p className="whitespace-pre-wrap">{message.body}</p>
            </div>
          ))}
        </div>
      )}

      {canDelegate && (
        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!teammateId || objective.trim().length < 3) return;
            delegate.mutate({
              taskId: task.id,
              data: { agentId: teammateId, objective: objective.trim() },
            });
          }}
        >
          <div className="text-[10px] font-bold uppercase text-muted-foreground">
            Hand a slice to a teammate
          </div>
          <Select value={teammateId} onValueChange={setTeammateId}>
            <SelectTrigger className={selectTriggerClass} data-testid="select-teammate">
              <SelectValue placeholder="Choose a teammate" />
            </SelectTrigger>
            <SelectContent className={selectContentClass}>
              {teammates.map((member) => (
                <SelectItem
                  key={member.agentId}
                  value={member.agentId}
                  className={selectItemClass}
                >
                  {member.name} — {member.title}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Textarea
            value={objective}
            onChange={(event) => setObjective(event.target.value)}
            placeholder="What should they do?"
            className="border-4 border-border rounded-none font-mono text-sm"
            rows={2}
            data-testid="input-delegate-objective"
          />
          <Button
            type="submit"
            disabled={delegate.isPending || !teammateId || objective.trim().length < 3}
            className="rounded-none font-bold uppercase"
            data-testid="button-delegate"
          >
            <Network className="w-3 h-3 mr-2" />
            {delegate.isPending ? "Delegating..." : "Delegate"}
          </Button>
        </form>
      )}
    </div>
  );
}

function TaskDetailDialog({
  taskId,
  onClose,
}: {
  taskId: string;
  onClose: () => void;
}) {
  const { data: detail } = useGetTask(taskId, {
    query: {
      queryKey: [`/api/tasks/${taskId}`],
      refetchInterval: (query) => {
        const status = (query.state.data as { task?: Task } | undefined)?.task?.status;
        return status === "running" || status === "queued" ? 2000 : false;
      },
    },
  });
  const task = detail?.task;
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="border-4 border-border bg-card p-0 rounded-none max-w-2xl max-h-[90vh] overflow-y-auto">
        <div className="border-b-4 border-border p-4 bg-muted/30 flex items-center justify-between gap-3">
          <DialogTitle className="font-display uppercase text-lg truncate">
            Task Detail
          </DialogTitle>
        </div>
        {!task ? (
          <div className="p-6 font-mono text-xs uppercase text-muted-foreground animate-pulse">
            Loading task...
          </div>
        ) : (
          <div className="p-6 space-y-5">
            <div className="flex flex-wrap items-center gap-2">
              <TaskStatusBadge status={task.status} />
              <Badge variant="outline">{task.priority} priority</Badge>
              {task.provider && <Badge variant="outline">{task.provider}</Badge>}
              {task.budgetCents != null && (
                <Badge variant="outline">Budget {formatCents(task.budgetCents)}</Badge>
              )}
              {task.attempts > 0 && (
                <Badge variant="outline">Attempt {task.attempts}</Badge>
              )}
            </div>

            <div>
              <div className="text-[10px] font-bold uppercase text-muted-foreground mb-1">
                Objective — {task.agentName}
              </div>
              <p className="font-mono text-sm bg-muted/30 border-2 border-border/50 p-3 whitespace-pre-wrap">
                {task.objective}
              </p>
            </div>

            {task.errorMessage && (
              <div className="border-4 border-destructive/60 bg-destructive/10 p-3">
                <div className="text-[10px] font-bold uppercase text-destructive mb-1">
                  {task.errorKind ? task.errorKind.replace(/_/g, " ") : "Error"}
                </div>
                <p className="font-mono text-xs">{task.errorMessage}</p>
              </div>
            )}

            {task.contextSources && task.contextSources.length > 0 && (
              <div>
                <div className="text-[10px] font-bold uppercase text-muted-foreground mb-1">
                  Context Sources
                </div>
                <div className="flex flex-wrap gap-2">
                  {task.contextSources.map((source) => (
                    <Badge
                      key={source.label}
                      variant="outline"
                      className="rounded-none font-mono text-[10px] max-w-full"
                      title={source.title}
                      data-testid={`badge-source-${source.label}`}
                    >
                      <span className="font-bold mr-1">[{source.label}]</span>
                      <span className="truncate">
                        {source.type === "file" ? "📄 " : ""}
                        {source.title}
                      </span>
                    </Badge>
                  ))}
                </div>
              </div>
            )}

            {task.output && (
              <div>
                <div className="text-[10px] font-bold uppercase text-muted-foreground mb-1">
                  Result
                </div>
                <pre className="font-mono text-xs bg-background border-2 border-border/50 p-3 whitespace-pre-wrap max-h-72 overflow-y-auto">
                  {task.output}
                </pre>
              </div>
            )}

            {task.files.length > 0 && (
              <div>
                <div className="text-[10px] font-bold uppercase text-muted-foreground mb-1">
                  Files
                </div>
                <div className="space-y-2">
                  {task.files.map((file) => (
                    <details key={file.name} className="border-2 border-border/50">
                      <summary className="font-mono text-xs px-3 py-2 cursor-pointer uppercase">
                        {file.name}
                      </summary>
                      <pre className="font-mono text-xs p-3 whitespace-pre-wrap max-h-48 overflow-y-auto border-t-2 border-border/50">
                        {file.content}
                      </pre>
                    </details>
                  ))}
                </div>
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2">
              <TaskCostLine task={task} />
            </div>

            <DelegationSection task={task} />

            <div>
              <div className="flex items-center gap-2 text-[10px] font-bold uppercase text-muted-foreground mb-1">
                <ScrollText className="w-3 h-3" />
                Execution Log
              </div>
              <TaskLogList logs={detail?.logs ?? []} />
            </div>

            <div className="pt-2 border-t-4 border-border flex justify-between items-center gap-3">
              <div className="text-[10px] font-mono text-muted-foreground uppercase">
                Created {formatDistanceToNow(new Date(task.createdAt), { addSuffix: true })}
              </div>
              <TaskActions task={task} />
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Cancel / retry controls shared by cards and the detail dialog. */
function TaskActions({ task }: { task: Task }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/tasks"] });
    queryClient.invalidateQueries({ queryKey: [`/api/tasks/${task.id}`] });
    queryClient.invalidateQueries({ queryKey: ["/api/office/overview"] });
  };
  const onError = (error: unknown) => {
    const message =
      (error as { response?: { data?: { error?: string } } })?.response?.data?.error ??
      "The action could not be completed.";
    toast({ title: "Task action failed", description: message, variant: "destructive" });
  };
  const cancelTask = useCancelTask({ mutation: { onSuccess: invalidate, onError } });
  const retryTask = useRetryTask({ mutation: { onSuccess: invalidate, onError } });
  return (
    <div className="flex gap-2">
      {CANCELLABLE.includes(task.status) && (
        <Button
          size="sm"
          variant="outline"
          disabled={cancelTask.isPending}
          onClick={() => cancelTask.mutate({ taskId: task.id })}
        >
          <Ban className="w-3 h-3 mr-1" />
          {cancelTask.isPending ? "CANCELLING..." : "CANCEL"}
        </Button>
      )}
      {RETRYABLE.includes(task.status) && (
        <Button
          size="sm"
          variant="outline"
          disabled={retryTask.isPending}
          onClick={() => retryTask.mutate({ taskId: task.id })}
        >
          <RotateCcw className="w-3 h-3 mr-1" />
          {retryTask.isPending ? "RETRYING..." : "RETRY"}
        </Button>
      )}
    </div>
  );
}

function TaskStatusBadge({ status }: { status: TaskStatus }) {
  switch (status) {
    case 'queued': return <Badge variant="outline">Queued</Badge>;
    case 'running': return <Badge variant="success" className="animate-pulse">Running</Badge>;
    case 'waiting_approval': return <Badge variant="warning">Awaiting Approval</Badge>;
    case 'blocked': return <Badge variant="warning">Blocked</Badge>;
    case 'completed': return <Badge variant="accent">Complete</Badge>;
    case 'failed': return <Badge variant="destructive">Failed</Badge>;
    case 'cancelled': return <Badge variant="default">Cancelled</Badge>;
    default: return <Badge variant="default">{status}</Badge>;
  }
}

function TaskCostLine({ task }: { task: Task }) {
  const parts: React.ReactNode[] = [];
  if (task.model) {
    parts.push(
      <div key="model" className="text-[10px] bg-muted px-2 py-1 uppercase font-bold text-muted-foreground border-2 border-border/50 max-w-[16rem] truncate" title={task.model}>
        {task.model}
      </div>,
    );
  }
  if (task.estimatedTokens != null) {
    parts.push(
      <div key="est" className="text-[10px] bg-muted px-2 py-1 uppercase font-bold text-muted-foreground border-2 border-border/50">
        Est: ~{formatTokens(task.estimatedTokens)} tok
        {task.estimatedCostCents != null ? ` / ~${formatCents(task.estimatedCostCents)}` : ""}
      </div>,
    );
  }
  if (task.actualInputTokens != null && task.actualOutputTokens != null) {
    const used = task.actualInputTokens + task.actualOutputTokens;
    parts.push(
      <div key="actual" className="text-[10px] bg-accent/10 px-2 py-1 uppercase font-bold text-accent border-2 border-border/50">
        Used: {formatTokens(used)} tok
        {task.actualCostCents != null ? ` / ${formatCents(task.actualCostCents)}` : ""}
      </div>,
    );
  }
  return <>{parts}</>;
}

export default function TasksPage() {
  // The queue advances server-side; poll so status transitions appear live.
  const { data: tasks, isLoading: tasksLoading } = useListTasks({
    query: { queryKey: ["/api/tasks"], refetchInterval: 4000 },
  });
  const { data: agents } = useListAgents();
  const queryClient = useQueryClient();
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [inspectedTaskId, setInspectedTaskId] = useState<string | null>(null);

  const [newTask, setNewTask] = useState({
    agentId: "",
    objective: "",
    priority: TaskInputPriority.normal as TaskInputPriority,
    budgetDollars: "",
    providerOverride: "" as TaskInputProviderOverride | "",
    modelOverride: "",
  });

  const selectedAgent = useMemo(
    () => agents?.find((a) => a.id === newTask.agentId),
    [agents, newTask.agentId],
  );
  const { data: providerSettings } = useGetProviderSettings();
  // Override → agent preference → workspace default, mirroring the server.
  const effectiveProvider: "claude_max" | "openrouter" =
    (newTask.providerOverride ||
      (selectedAgent?.provider as "claude_max" | "openrouter" | null | undefined)) ??
    providerSettings?.defaultProvider ??
    "claude_max";

  const createTask = useCreateTask({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: ["/api/tasks"] });
        queryClient.invalidateQueries({ queryKey: ["/api/office/overview"] });
        setIsDialogOpen(false);
        setNewTask({
          agentId: "",
          objective: "",
          priority: TaskInputPriority.normal,
          budgetDollars: "",
          providerOverride: "",
          modelOverride: "",
        });
      }
    }
  });

  const budgetCents = newTask.budgetDollars.trim()
    ? Math.round(Number(newTask.budgetDollars) * 10000) / 100
    : null;
  const budgetInvalid =
    newTask.budgetDollars.trim() !== "" &&
    (!Number.isFinite(budgetCents) || (budgetCents ?? 0) <= 0);

  const handleCreateTask = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTask.agentId || !newTask.objective || budgetInvalid) return;

    createTask.mutate({
      data: {
        agentId: newTask.agentId,
        objective: newTask.objective,
        priority: newTask.priority,
        ...(budgetCents != null && !budgetInvalid ? { budgetCents } : {}),
        ...(newTask.providerOverride ? { providerOverride: newTask.providerOverride } : {}),
        ...(newTask.modelOverride ? { modelOverride: newTask.modelOverride } : {})
      }
    });
  };

  const getStatusIcon = (status: TaskStatus) => {
    switch (status) {
      case 'queued': return <Clock className="w-5 h-5 text-muted-foreground" />;
      case 'running': return <Activity className="w-5 h-5 text-green-500 animate-pulse" />;
      case 'waiting_approval': return <AlertTriangle className="w-5 h-5 text-yellow-500" />;
      case 'blocked': return <AlertTriangle className="w-5 h-5 text-yellow-500" />;
      case 'completed': return <CheckCircle className="w-5 h-5 text-accent" />;
      case 'failed': return <AlertTriangle className="w-5 h-5 text-destructive" />;
      case 'cancelled': return <XCircle className="w-5 h-5 text-muted-foreground" />;
      default: return <Activity className="w-5 h-5 text-muted-foreground" />;
    }
  };

  return (
    <Shell>
      <div className="p-4 sm:p-6 lg:p-8 max-w-7xl mx-auto space-y-6 sm:space-y-8">
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-4 border-b-4 border-border pb-6">
          <div>
            <h1 className="font-display text-lg sm:text-2xl text-foreground uppercase mb-2">Task Queue</h1>
            <p className="text-muted-foreground text-sm">Monitor and dispatch jobs to the workforce.</p>
          </div>

          <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
            <DialogTrigger asChild>
              <Button variant="primary">
                <Play className="w-4 h-4 mr-2" />
                Dispatch Task
              </Button>
            </DialogTrigger>
            <DialogContent className="border-4 border-border bg-card p-0 rounded-none max-w-xl max-h-[90vh] overflow-y-auto">
              <div className="border-b-4 border-border p-4 bg-muted/30">
                <DialogTitle className="font-display uppercase text-lg">New Task Directive</DialogTitle>
              </div>
              <form onSubmit={handleCreateTask} className="p-6 space-y-6">

                <div className="space-y-2">
                  <label className="uppercase font-bold text-xs">Assign to Agent</label>
                  <Select
                    value={newTask.agentId}
                    onValueChange={(val) => setNewTask({...newTask, agentId: val, modelOverride: ""})}
                  >
                    <SelectTrigger className={selectTriggerClass}>
                      <SelectValue placeholder="Select an available agent..." />
                    </SelectTrigger>
                    <SelectContent className={selectContentClass}>
                      {agents?.filter(a => a.status !== 'error' && !a.archived).map(agent => (
                        <SelectItem key={agent.id} value={agent.id} className={selectItemClass}>
                          {agent.name} [{agent.status}]
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <label className="uppercase font-bold text-xs">Objective</label>
                  <Textarea
                    value={newTask.objective}
                    onChange={(e) => setNewTask({...newTask, objective: e.target.value})}
                    placeholder="E.g. Analyze the latest sales report and extract key metrics..."
                    rows={4}
                    className="font-mono text-sm bg-background border-4 border-border rounded-none focus-visible:ring-0 focus-visible:border-primary resize-none"
                  />
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <label className="uppercase font-bold text-xs">Priority</label>
                    <Select
                      value={newTask.priority}
                      onValueChange={(val) => setNewTask({...newTask, priority: val as TaskInputPriority})}
                    >
                      <SelectTrigger className={selectTriggerClass}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className={selectContentClass}>
                        <SelectItem value={TaskInputPriority.high} className={selectItemClass}>High</SelectItem>
                        <SelectItem value={TaskInputPriority.normal} className={selectItemClass}>Normal</SelectItem>
                        <SelectItem value={TaskInputPriority.low} className={selectItemClass}>Low</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <label className="uppercase font-bold text-xs flex justify-between">
                      <span>Budget (USD)</span>
                      <span className="text-muted-foreground font-normal">(Optional)</span>
                    </label>
                    <Input
                      type="number"
                      min="0.01"
                      step="0.01"
                      value={newTask.budgetDollars}
                      onChange={(e) => setNewTask({...newTask, budgetDollars: e.target.value})}
                      placeholder="No spending cap"
                      className="bg-background border-4 border-border rounded-none focus-visible:ring-0 focus-visible:border-primary font-mono text-sm"
                    />
                    {budgetInvalid && (
                      <div className="text-[10px] font-mono text-destructive uppercase">
                        Enter a positive dollar amount.
                      </div>
                    )}
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <label className="uppercase font-bold text-xs flex justify-between">
                      <span>Provider Override</span>
                      <span className="text-muted-foreground font-normal">(Optional)</span>
                    </label>
                    <Select
                      value={newTask.providerOverride || "none"}
                      onValueChange={(val) => setNewTask({...newTask, providerOverride: val === "none" ? "" : val as TaskInputProviderOverride, modelOverride: ""})}
                    >
                      <SelectTrigger className={selectTriggerClass}>
                        <SelectValue placeholder="Use agent default" />
                      </SelectTrigger>
                      <SelectContent className={selectContentClass}>
                        <SelectItem value="none" className={selectItemClass}>Agent Default</SelectItem>
                        <SelectItem value={TaskInputProviderOverride.claude_max} className={selectItemClass}>Claude Max</SelectItem>
                        <SelectItem value={TaskInputProviderOverride.openrouter} className={selectItemClass}>OpenRouter</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <label className="uppercase font-bold text-xs flex justify-between">
                      <span>Model Override</span>
                      <span className="text-muted-foreground font-normal">(Optional)</span>
                    </label>
                    <ModelOverrideSelect
                      provider={effectiveProvider}
                      value={newTask.modelOverride}
                      onChange={(val) => setNewTask({ ...newTask, modelOverride: val })}
                    />
                  </div>
                </div>

                <EstimatePanel
                  agentId={newTask.agentId}
                  objective={newTask.objective}
                  providerOverride={newTask.providerOverride}
                  modelOverride={newTask.modelOverride}
                />

                <div className="pt-4 border-t-4 border-border flex justify-end gap-4">
                  <Button type="button" variant="outline" onClick={() => setIsDialogOpen(false)}>CANCEL</Button>
                  <Button
                    type="submit"
                    variant="primary"
                    disabled={createTask.isPending || !newTask.agentId || !newTask.objective || budgetInvalid}
                  >
                    {createTask.isPending ? "DISPATCHING..." : "DISPATCH"}
                  </Button>
                </div>
              </form>
            </DialogContent>
          </Dialog>
        </div>

        {tasksLoading ? (
          <div className="space-y-4">
            {[1, 2, 3].map(i => (
              <PixelCard key={i} className="animate-pulse h-24 bg-muted/50">
                <div className="w-full h-full"></div>
              </PixelCard>
            ))}
          </div>
        ) : !tasks || tasks.length === 0 ? (
          <PixelCard className="text-center p-6 sm:p-12">
            <div className="flex justify-center mb-6 opacity-50">
              <Activity className="w-16 h-16 text-muted-foreground" />
            </div>
            <h3 className="font-display text-lg uppercase mb-2">Queue Empty</h3>
            <p className="text-muted-foreground mb-6">No tasks are currently running or queued.</p>
            <Button variant="primary" onClick={() => setIsDialogOpen(true)}>Dispatch First Task</Button>
          </PixelCard>
        ) : (
          <div className="space-y-4">
            {tasks.map((task) => (
              <PixelCard
                key={task.id}
                variant={task.status === 'failed' ? 'destructive' : task.status === 'running' ? 'primary' : 'default'}
                className="flex flex-col md:flex-row gap-6 p-6"
              >
                <div className="flex flex-col items-center justify-center shrink-0 border-r-4 border-border/50 pr-6 mr-2 hidden md:flex">
                  <div className="bg-muted p-3 border-2 border-border/50 pixel-shadow mb-2">
                    {getStatusIcon(task.status)}
                  </div>
                  <div className="text-[10px] font-mono text-muted-foreground uppercase">{task.id.slice(0, 8)}</div>
                </div>

                <div className="flex-1 space-y-4">
                  <div className="flex justify-between items-start">
                    <div>
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-xs font-bold text-accent uppercase tracking-wider">Assigned: {task.agentName}</span>
                        <span className="text-muted-foreground text-[10px]">
                          • {formatDistanceToNow(new Date(task.createdAt), { addSuffix: true })}
                        </span>
                      </div>
                      <p className="font-mono text-sm line-clamp-2">{task.objective}</p>
                    </div>
                    <div className="shrink-0 ml-4 hidden sm:block">
                      <TaskStatusBadge status={task.status} />
                    </div>
                  </div>

                  {task.errorMessage && (
                    <div className="text-[10px] font-mono text-destructive border-l-4 border-destructive/60 pl-2">
                      {task.errorMessage}
                    </div>
                  )}

                  <div className="flex flex-wrap items-center gap-4 border-t-4 border-border/30 pt-3">
                    <div className="sm:hidden mb-2 w-full">
                      <TaskStatusBadge status={task.status} />
                    </div>
                    {task.provider && (
                      <div className="text-[10px] bg-muted px-2 py-1 uppercase font-bold text-muted-foreground border-2 border-border/50">
                        Via: {task.provider}
                      </div>
                    )}
                    {task.priority !== "normal" && (
                      <div className="text-[10px] bg-muted px-2 py-1 uppercase font-bold text-muted-foreground border-2 border-border/50">
                        {task.priority} priority
                      </div>
                    )}
                    <TaskCostLine task={task} />
                    <div className="ml-auto flex items-center gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setInspectedTaskId(task.id)}
                      >
                        <ScrollText className="w-3 h-3 mr-1" />
                        DETAILS
                      </Button>
                      <TaskActions task={task} />
                    </div>
                  </div>
                </div>
              </PixelCard>
            ))}
          </div>
        )}

        {inspectedTaskId && (
          <TaskDetailDialog
            taskId={inspectedTaskId}
            onClose={() => setInspectedTaskId(null)}
          />
        )}
      </div>
    </Shell>
  );
}
