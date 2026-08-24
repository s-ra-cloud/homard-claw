import React from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useCreateAgent, AgentProvider, AgentSecurityPreset } from "@workspace/api-client-react";
import { Shell } from "@/components/layout/Shell";
import { PixelCard } from "@/components/ui/pixel-card";
import { Button } from "@/components/ui/button";
import { LOBSTER_PRESETS } from "@/components/ui/marlow-lobster";
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { Form } from "@/components/ui/form";
import { ArrowLeft } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import {
  AgentFormFields,
  AgentPreviewCard,
  agentFormSchema,
  appGrantsPayload,
  defaultAppGrants,
  permissionOverridesPayload,
  type AgentFormValues,
} from "@/components/agent-form";

export default function NewAgentPage() {
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const form = useForm<AgentFormValues>({
    resolver: zodResolver(agentFormSchema),
    defaultValues: {
      name: "New Recruit",
      title: "Data Analyst",
      mission: "Analyze inputs and provide structured reports.",
      specialization: "",
      personality: "",
      goals: "",
      instructions: "",
      provider: "workspace_default",
      model: "",
      codexModel: "",
      codexReasoning: "",
      voiceStyle: "none",
      securityPreset: AgentSecurityPreset.assistant,
      autonomy: "limited",
      maxTaskBudgetCents: "",
      dailyBudgetCents: "",
      maxTasksPerDay: "",
      approvalThresholdCents: "",
      shellColor: LOBSTER_PRESETS[0].shellColor,
      // Every supported app must start at an explicit "none" — an undefined
      // entry fails validation with a misleading red "Required" error.
      appGrants: defaultAppGrants(),
      sensitiveDataSandbox: false,
    },
  });

  const createAgent = useCreateAgent({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: ["/api/agents"] });
        queryClient.invalidateQueries({ queryKey: ["/api/office/overview"] });
        setLocation("/agents");
      },
      onError: (error) => {
        toast({
          variant: "destructive",
          title: "Recruitment failed",
          description:
            error.status === 409
              ? "An agent with that name already exists. Pick another designation."
              : error.message,
        });
      },
    }
  });

  const onSubmit = (data: AgentFormValues) => {
    createAgent.mutate({
      data: {
        name: data.name,
        title: data.title,
        mission: data.mission,
        ...(data.specialization.trim() ? { specialization: data.specialization.trim() } : {}),
        ...(data.personality.trim() ? { personality: data.personality.trim() } : {}),
        ...(data.goals.trim() ? { goals: data.goals.trim() } : {}),
        ...(data.instructions.trim() ? { instructions: data.instructions.trim() } : {}),
        provider: data.provider === "workspace_default" ? null : data.provider,
        ...(data.model.trim() ? { model: data.model.trim() } : {}),
        ...(data.codexModel.trim() ? { codexModel: data.codexModel.trim() } : {}),
        ...(data.codexReasoning.trim()
          ? {
              codexReasoning: data.codexReasoning.trim() as NonNullable<
                Parameters<typeof createAgent.mutate>[0]["data"]["codexReasoning"]
              >,
            }
          : {}),
        ...(data.voiceStyle && data.voiceStyle !== "none" ? { voiceStyle: data.voiceStyle } : {}),
        securityPreset: data.securityPreset,
        autonomy: data.autonomy,
        ...(permissionOverridesPayload(data)
          ? { permissionOverrides: permissionOverridesPayload(data) }
          : {}),
        ...(appGrantsPayload(data).length > 0
          ? { appGrants: appGrantsPayload(data) }
          : {}),
        sensitiveDataSandbox: data.sensitiveDataSandbox,
        avatar: {
          shellColor: data.shellColor,
          deskStyle: "standard",
          accessory: "none"
        }
      }
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
            <h1 className="font-display text-lg sm:text-2xl text-foreground uppercase mb-1">Recruit Agent</h1>
            <p className="text-muted-foreground text-sm">Configure a new autonomous worker for the office.</p>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 lg:gap-8">
          <div className="lg:col-span-2">
            <PixelCard title="Configuration">
              <Form {...form}>
                <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
                  <AgentFormFields form={form} />

                  <div className="pt-4 border-t-4 border-border flex justify-end">
                    <Button type="submit" variant="primary" disabled={createAgent.isPending}>
                      {createAgent.isPending ? "INITIALIZING..." : "INITIALIZE AGENT"}
                    </Button>
                  </div>
                </form>
              </Form>
            </PixelCard>
          </div>

          <div>
            <PixelCard title="Preview" className="sticky top-8">
              <AgentPreviewCard form={form} />
            </PixelCard>
          </div>
        </div>
      </div>
    </Shell>
  );
}
