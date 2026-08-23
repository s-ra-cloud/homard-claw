import React from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { useCreateAgent, AgentProvider, AgentSecurityPreset } from "@workspace/api-client-react";
import { Shell } from "@/components/layout/Shell";
import { PixelCard } from "@/components/ui/pixel-card";
import { Button } from "@/components/ui/button";
import { LobsterAvatar } from "@/components/ui/lobster-avatar";
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft } from "lucide-react";

const agentSchema = z.object({
  name: z.string().min(2, "Name must be at least 2 characters").max(60),
  title: z.string().min(2).max(80),
  mission: z.string().min(5).max(2000),
  provider: z.enum([AgentProvider.claude_max, AgentProvider.openrouter]),
  securityPreset: z.enum([
    AgentSecurityPreset.observer,
    AgentSecurityPreset.assistant,
    AgentSecurityPreset.operator,
  ]),
  shellColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/, "Must be a valid hex color"),
});

type AgentFormValues = z.infer<typeof agentSchema>;

export default function NewAgentPage() {
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  
  const form = useForm<AgentFormValues>({
    resolver: zodResolver(agentSchema),
    defaultValues: {
      name: "New Recruit",
      title: "Data Analyst",
      mission: "Analyze inputs and provide structured reports.",
      provider: AgentProvider.claude_max,
      securityPreset: AgentSecurityPreset.assistant,
      shellColor: "#ff4500", // Default orange
    },
  });

  const shellColor = form.watch("shellColor");

  const createAgent = useCreateAgent({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: ["/api/agents"] });
        queryClient.invalidateQueries({ queryKey: ["/api/office/overview"] });
        setLocation("/agents");
      }
    }
  });

  const onSubmit = (data: AgentFormValues) => {
    createAgent.mutate({
      data: {
        name: data.name,
        title: data.title,
        mission: data.mission,
        provider: data.provider,
        securityPreset: data.securityPreset,
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
      <div className="p-8 max-w-4xl mx-auto space-y-8">
        <div className="flex items-center gap-4 border-b-4 border-border pb-6">
          <Button variant="ghost" size="icon" onClick={() => setLocation("/agents")}>
            <ArrowLeft className="w-5 h-5" />
          </Button>
          <div>
            <h1 className="font-display text-2xl text-foreground uppercase mb-1">Recruit Agent</h1>
            <p className="text-muted-foreground text-sm">Configure a new autonomous worker for the office.</p>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          <div className="lg:col-span-2">
            <PixelCard title="Configuration">
              <Form {...form}>
                <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
                  
                  <div className="grid grid-cols-2 gap-4">
                    <FormField
                      control={form.control}
                      name="name"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="uppercase font-bold text-xs">Designation (Name)</FormLabel>
                          <FormControl>
                            <Input {...field} className="font-mono bg-background border-4 border-border rounded-none focus-visible:ring-0 focus-visible:border-primary" />
                          </FormControl>
                          <FormMessage className="text-[10px] uppercase font-bold text-destructive" />
                        </FormItem>
                      )}
                    />

                    <FormField
                      control={form.control}
                      name="title"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="uppercase font-bold text-xs">Role Title</FormLabel>
                          <FormControl>
                            <Input {...field} className="font-mono bg-background border-4 border-border rounded-none focus-visible:ring-0 focus-visible:border-primary" />
                          </FormControl>
                          <FormMessage className="text-[10px] uppercase font-bold text-destructive" />
                        </FormItem>
                      )}
                    />
                  </div>

                  <FormField
                    control={form.control}
                    name="mission"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="uppercase font-bold text-xs">Core Mission / System Prompt</FormLabel>
                        <FormControl>
                          <Textarea 
                            {...field} 
                            rows={5}
                            className="font-mono text-sm bg-background border-4 border-border rounded-none focus-visible:ring-0 focus-visible:border-primary resize-none" 
                          />
                        </FormControl>
                        <FormDescription className="text-[10px] uppercase">
                          Defines the agent's primary directives and constraints.
                        </FormDescription>
                        <FormMessage className="text-[10px] uppercase font-bold text-destructive" />
                      </FormItem>
                    )}
                  />

                  <div className="grid grid-cols-2 gap-4">
                    <FormField
                      control={form.control}
                      name="provider"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="uppercase font-bold text-xs">Compute Provider</FormLabel>
                          <Select onValueChange={field.onChange} defaultValue={field.value}>
                            <FormControl>
                              <SelectTrigger className="bg-background border-4 border-border rounded-none focus:ring-0 focus:border-primary font-mono uppercase text-xs font-bold">
                                <SelectValue placeholder="Select provider" />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent className="border-4 border-border rounded-none bg-card">
                              <SelectItem value={AgentProvider.claude_max} className="font-mono text-xs uppercase focus:bg-primary focus:text-primary-foreground">Claude Max</SelectItem>
                              <SelectItem value={AgentProvider.openrouter} className="font-mono text-xs uppercase focus:bg-primary focus:text-primary-foreground">OpenRouter</SelectItem>
                            </SelectContent>
                          </Select>
                          <FormMessage className="text-[10px] uppercase font-bold text-destructive" />
                        </FormItem>
                      )}
                    />

                    <FormField
                      control={form.control}
                      name="securityPreset"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="uppercase font-bold text-xs">Clearance Level</FormLabel>
                          <Select onValueChange={field.onChange} defaultValue={field.value}>
                            <FormControl>
                              <SelectTrigger className="bg-background border-4 border-border rounded-none focus:ring-0 focus:border-primary font-mono uppercase text-xs font-bold">
                                <SelectValue placeholder="Select clearance" />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent className="border-4 border-border rounded-none bg-card">
                              <SelectItem value={AgentSecurityPreset.observer} className="font-mono text-xs uppercase focus:bg-primary focus:text-primary-foreground">Observer (Read Only)</SelectItem>
                              <SelectItem value={AgentSecurityPreset.assistant} className="font-mono text-xs uppercase focus:bg-primary focus:text-primary-foreground">Assistant (Ask Confirm)</SelectItem>
                              <SelectItem value={AgentSecurityPreset.operator} className="font-mono text-xs uppercase focus:bg-primary focus:text-primary-foreground">Operator (Full Auto)</SelectItem>
                            </SelectContent>
                          </Select>
                          <FormMessage className="text-[10px] uppercase font-bold text-destructive" />
                        </FormItem>
                      )}
                    />
                  </div>

                  <FormField
                    control={form.control}
                    name="shellColor"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="uppercase font-bold text-xs">Shell Pigment (Hex)</FormLabel>
                        <FormControl>
                          <div className="flex gap-2">
                            <Input 
                              type="color" 
                              {...field} 
                              className="w-12 h-10 p-1 bg-background border-4 border-border rounded-none cursor-pointer" 
                            />
                            <Input 
                              {...field} 
                              className="flex-1 font-mono bg-background border-4 border-border rounded-none focus-visible:ring-0 focus-visible:border-primary uppercase" 
                            />
                          </div>
                        </FormControl>
                        <FormMessage className="text-[10px] uppercase font-bold text-destructive" />
                      </FormItem>
                    )}
                  />

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
              <div className="flex flex-col items-center justify-center p-8 bg-muted/30 border-4 border-border border-dashed mb-6">
                <LobsterAvatar 
                  size={120} 
                  status="idle" 
                  primaryColor={shellColor} 
                />
              </div>
              <div className="space-y-4">
                <div>
                  <div className="text-[10px] text-muted-foreground uppercase font-bold mb-1">ID Badge</div>
                  <div className="font-bold uppercase text-lg leading-tight">{form.watch("name") || "UNKNOWN"}</div>
                  <div className="text-accent text-xs font-mono">{form.watch("title") || "UNASSIGNED"}</div>
                </div>
                
                <div className="grid grid-cols-2 gap-2 border-t-4 border-border pt-4">
                  <div>
                    <div className="text-[10px] text-muted-foreground uppercase font-bold mb-1">Clearance</div>
                    <Badge variant={
                      form.watch("securityPreset") === 'operator' ? 'destructive' :
                      form.watch("securityPreset") === 'assistant' ? 'accent' : 'default'
                    }>{form.watch("securityPreset")}</Badge>
                  </div>
                  <div>
                    <div className="text-[10px] text-muted-foreground uppercase font-bold mb-1">Provider</div>
                    <Badge variant="outline">{form.watch("provider")}</Badge>
                  </div>
                </div>
              </div>
            </PixelCard>
          </div>
        </div>
      </div>
    </Shell>
  );
}
