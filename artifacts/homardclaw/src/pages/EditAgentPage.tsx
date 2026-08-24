import React from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useGetAgent, useUpdateAgent } from "@workspace/api-client-react";
import { Shell } from "@/components/layout/Shell";
import { PixelCard } from "@/components/ui/pixel-card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useLocation, useParams } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { Form } from "@/components/ui/form";
import { ArrowLeft } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import {
  AgentFormFields,
  AgentPreviewCard,
  agentFormSchema,
  type AgentFormValues,
} from "@/components/agent-form";

function taskStatusBadge(status: string) {
  switch (status) {
    case "queued": return <Badge variant="outline">Queued</Badge>;
    case "running": return <Badge variant="success">Running</Badge>;
    case "waiting_approval": return <Badge variant="warning">Waiting Approval</Badge>;
    case "paused": return <Badge variant="destructive">Paused</Badge>;
    case "complete": return <Badge variant="accent">Complete</Badge>;
    case "failed": return <Badge variant="destructive">Failed</Badge>;
    default: return <Badge variant="default">{status}</Badge>;
  }
}

export default function EditAgentPage() {
  const params = useParams<{ agentId: string }>();
  const agentId = params.agentId ?? "";
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: detail, isLoading, error } = useGetAgent(agentId, {
    query: { queryKey: [`/api/agents/${agentId}`], enabled: Boolean(agentId) },
  });
  const agent = detail?.agent;

  const form = useForm<AgentFormValues>({
    resolver: zodResolver(agentFormSchema),
    values: agent
      ? {
          name: agent.name,
          title: agent.title,
          mission: agent.mission,
          specialization: agent.specialization ?? "",
          personality: agent.personality ?? "",
          goals: agent.goals ?? "",
          instructions: agent.instructions ?? "",
          provider: agent.provider ?? "workspace_default",
          model: agent.model ?? "",
          voiceStyle: agent.voiceStyle ?? "none",
          securityPreset: agent.securityPreset,
          shellColor: agent.avatar.shellColor,
        }
      : undefined,
  });

  const updateAgent = useUpdateAgent({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: ["/api/agents"] });
        queryClient.invalidateQueries({ queryKey: [`/api/agents/${agentId}`] });
        queryClient.invalidateQueries({ queryKey: ["/api/office/overview"] });
        queryClient.invalidateQueries({ queryKey: ["/api/tasks"] });
        toast({ title: "Profile updated", description: "The agent's file has been amended." });
        setLocation("/agents");
      },
      onError: (mutationError) => {
        toast({
          variant: "destructive",
          title: "Update failed",
          description:
            mutationError.status === 409
              ? "That change conflicts with another agent (name already in use) or the agent is retired."
              : mutationError.message,
        });
      },
    },
  });

  const onSubmit = (data: AgentFormValues) => {
    if (!agent) return;
    updateAgent.mutate({
      agentId: agent.id,
      data: {
        name: data.name,
        title: data.title,
        mission: data.mission,
        specialization: data.specialization.trim() || null,
        personality: data.personality.trim() || null,
        goals: data.goals.trim() || null,
        instructions: data.instructions.trim() || null,
        provider: data.provider === "workspace_default" ? null : data.provider,
        model: data.model.trim() || null,
        voiceStyle: data.voiceStyle && data.voiceStyle !== "none" ? data.voiceStyle : null,
        securityPreset: data.securityPreset,
        avatar: {
          ...agent.avatar,
          shellColor: data.shellColor,
        },
      },
    });
  };

  return (
    <Shell>
      <div className="p-4 sm:p-6 lg:p-8 max-w-4xl mx-auto space-y-6 sm:space-y-8">
        <div className="flex items-center gap-4 border-b-4 border-border pb-6">
          <Button variant="ghost" size="icon" onClick={() => setLocation("/agents")}>
            <ArrowLeft className="w-5 h-5" />
          </Button>
          <div>
            <h1 className="font-display text-lg sm:text-2xl text-foreground uppercase mb-1">
              Edit Agent{agent ? `: ${agent.name}` : ""}
            </h1>
            <p className="text-muted-foreground text-sm">Amend this worker's personnel file.</p>
          </div>
        </div>

        {isLoading ? (
          <PixelCard className="animate-pulse h-64 bg-muted/50">
            <div className="w-full h-full"></div>
          </PixelCard>
        ) : error || !agent ? (
          <PixelCard className="text-center p-6 sm:p-12">
            <h3 className="font-display text-lg uppercase mb-2">Agent Not Found</h3>
            <p className="text-muted-foreground mb-6">
              This personnel file does not exist or could not be loaded.
            </p>
            <Button variant="primary" onClick={() => setLocation("/agents")}>Back to Roster</Button>
          </PixelCard>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 lg:gap-8">
            <div className="lg:col-span-2 space-y-6">
              <PixelCard title="Configuration">
                <Form {...form}>
                  <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
                    <AgentFormFields form={form} />

                    <div className="pt-4 border-t-4 border-border flex justify-end gap-3">
                      <Button type="button" variant="outline" onClick={() => setLocation("/agents")}>
                        Cancel
                      </Button>
                      <Button type="submit" variant="primary" disabled={updateAgent.isPending}>
                        {updateAgent.isPending ? "SAVING..." : "SAVE CHANGES"}
                      </Button>
                    </div>
                  </form>
                </Form>
              </PixelCard>

              <PixelCard title="Task History">
                {detail.tasks.length === 0 ? (
                  <p className="text-muted-foreground text-sm p-2">
                    No tasks on record. This agent has a clean slate.
                  </p>
                ) : (
                  <div className="space-y-2">
                    {detail.tasks.map((task) => (
                      <div
                        key={task.id}
                        className="flex items-start justify-between gap-3 bg-muted/30 p-3 border-2 border-border/50"
                      >
                        <div className="min-w-0">
                          <div className="font-mono text-xs text-foreground/90 line-clamp-2">
                            {task.objective}
                          </div>
                          <div className="text-[10px] text-muted-foreground uppercase mt-1">
                            {new Date(task.createdAt).toLocaleString()}
                          </div>
                        </div>
                        <div className="shrink-0">{taskStatusBadge(task.status)}</div>
                      </div>
                    ))}
                  </div>
                )}
              </PixelCard>
            </div>

            <div>
              <PixelCard title="Preview" className="sticky top-8">
                <AgentPreviewCard form={form} />
              </PixelCard>
            </div>
          </div>
        )}
      </div>
    </Shell>
  );
}
