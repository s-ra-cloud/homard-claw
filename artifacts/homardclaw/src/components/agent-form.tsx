import React from "react";
import type { UseFormReturn } from "react-hook-form";
import * as z from "zod";
import {
  AgentProvider,
  AgentSecurityPreset,
  useGetProviderSettings,
  useListProviderModels,
} from "@workspace/api-client-react";
import { LOBSTER_PRESETS, MarlowLobster } from "@/components/ui/marlow-lobster";
import {
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

export const VOICE_OPTIONS = [
  { value: "none", label: "None (Text Only)" },
  { value: "warm", label: "Warm" },
  { value: "crisp", label: "Crisp" },
  { value: "deep", label: "Deep" },
  { value: "bubbly", label: "Bubbly" },
] as const;

export const agentFormSchema = z.object({
  name: z.string().min(2, "Name must be at least 2 characters").max(60),
  title: z.string().min(2).max(80),
  mission: z.string().min(5).max(2000),
  specialization: z.string().max(200),
  personality: z.string().max(2000),
  goals: z.string().max(4000),
  instructions: z.string().max(4000),
  provider: z.enum([
    "workspace_default",
    AgentProvider.claude_max,
    AgentProvider.openrouter,
  ]),
  model: z.string().max(180),
  voiceStyle: z.string().max(60),
  securityPreset: z.enum([
    AgentSecurityPreset.observer,
    AgentSecurityPreset.assistant,
    AgentSecurityPreset.operator,
  ]),
  shellColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/, "Must be a valid hex color"),
});

export type AgentFormValues = z.infer<typeof agentFormSchema>;

const inputClass =
  "font-mono bg-background border-4 border-border rounded-none focus-visible:ring-0 focus-visible:border-primary";
const textareaClass =
  "font-mono text-sm bg-background border-4 border-border rounded-none focus-visible:ring-0 focus-visible:border-primary resize-none";
const selectTriggerClass =
  "bg-background border-4 border-border rounded-none focus:ring-0 focus:border-primary font-mono uppercase text-xs font-bold";
const selectContentClass = "border-4 border-border rounded-none bg-card";
const selectItemClass =
  "font-mono text-xs uppercase focus:bg-primary focus:text-primary-foreground";
const messageClass = "text-[10px] uppercase font-bold text-destructive";

export function AgentFormFields({ form }: { form: UseFormReturn<AgentFormValues> }) {
  return (
    <>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem>
              <FormLabel className="uppercase font-bold text-xs">Designation (Name)</FormLabel>
              <FormControl>
                <Input {...field} className={inputClass} />
              </FormControl>
              <FormMessage className={messageClass} />
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
                <Input {...field} className={inputClass} />
              </FormControl>
              <FormMessage className={messageClass} />
            </FormItem>
          )}
        />
      </div>

      <FormField
        control={form.control}
        name="specialization"
        render={({ field }) => (
          <FormItem>
            <FormLabel className="uppercase font-bold text-xs">Specialization</FormLabel>
            <FormControl>
              <Input
                {...field}
                placeholder="e.g. Financial research, code review, copywriting"
                className={inputClass}
              />
            </FormControl>
            <FormDescription className="text-[10px] uppercase">
              Optional. What this agent is best at.
            </FormDescription>
            <FormMessage className={messageClass} />
          </FormItem>
        )}
      />

      <FormField
        control={form.control}
        name="mission"
        render={({ field }) => (
          <FormItem>
            <FormLabel className="uppercase font-bold text-xs">Core Mission / System Prompt</FormLabel>
            <FormControl>
              <Textarea {...field} rows={5} className={textareaClass} />
            </FormControl>
            <FormDescription className="text-[10px] uppercase">
              Defines the agent's primary directives and constraints.
            </FormDescription>
            <FormMessage className={messageClass} />
          </FormItem>
        )}
      />

      <FormField
        control={form.control}
        name="personality"
        render={({ field }) => (
          <FormItem>
            <FormLabel className="uppercase font-bold text-xs">Personality Profile</FormLabel>
            <FormControl>
              <Textarea
                {...field}
                rows={3}
                placeholder="e.g. Meticulous and dry-witted. Prefers bullet points over prose."
                className={textareaClass}
              />
            </FormControl>
            <FormDescription className="text-[10px] uppercase">
              Optional. Shapes tone and working style.
            </FormDescription>
            <FormMessage className={messageClass} />
          </FormItem>
        )}
      />

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <FormField
          control={form.control}
          name="goals"
          render={({ field }) => (
            <FormItem>
              <FormLabel className="uppercase font-bold text-xs">Standing Goals</FormLabel>
              <FormControl>
                <Textarea
                  {...field}
                  rows={4}
                  placeholder="e.g. Keep the weekly report current."
                  className={textareaClass}
                />
              </FormControl>
              <FormDescription className="text-[10px] uppercase">
                Optional. Long-running objectives.
              </FormDescription>
              <FormMessage className={messageClass} />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="instructions"
          render={({ field }) => (
            <FormItem>
              <FormLabel className="uppercase font-bold text-xs">Operating Instructions</FormLabel>
              <FormControl>
                <Textarea
                  {...field}
                  rows={4}
                  placeholder="e.g. Always cite sources. Never contact third parties."
                  className={textareaClass}
                />
              </FormControl>
              <FormDescription className="text-[10px] uppercase">
                Optional. Rules the agent must follow.
              </FormDescription>
              <FormMessage className={messageClass} />
            </FormItem>
          )}
        />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <FormField
          control={form.control}
          name="provider"
          render={({ field }) => (
            <FormItem>
              <FormLabel className="uppercase font-bold text-xs">Compute Provider</FormLabel>
              <Select onValueChange={field.onChange} value={field.value}>
                <FormControl>
                  <SelectTrigger className={selectTriggerClass}>
                    <SelectValue placeholder="Select provider" />
                  </SelectTrigger>
                </FormControl>
                <SelectContent className={selectContentClass}>
                  <SelectItem value="workspace_default" className={selectItemClass}>Workspace Default</SelectItem>
                  <SelectItem value={AgentProvider.claude_max} className={selectItemClass}>Claude Max</SelectItem>
                  <SelectItem value={AgentProvider.openrouter} className={selectItemClass}>OpenRouter</SelectItem>
                </SelectContent>
              </Select>
              <FormMessage className={messageClass} />
            </FormItem>
          )}
        />

        <ModelField form={form} />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <FormField
          control={form.control}
          name="securityPreset"
          render={({ field }) => (
            <FormItem>
              <FormLabel className="uppercase font-bold text-xs">Clearance Level</FormLabel>
              <Select onValueChange={field.onChange} value={field.value}>
                <FormControl>
                  <SelectTrigger className={selectTriggerClass}>
                    <SelectValue placeholder="Select clearance" />
                  </SelectTrigger>
                </FormControl>
                <SelectContent className={selectContentClass}>
                  <SelectItem value={AgentSecurityPreset.observer} className={selectItemClass}>Observer (Read Only)</SelectItem>
                  <SelectItem value={AgentSecurityPreset.assistant} className={selectItemClass}>Assistant (Ask Confirm)</SelectItem>
                  <SelectItem value={AgentSecurityPreset.operator} className={selectItemClass}>Operator (Full Auto)</SelectItem>
                </SelectContent>
              </Select>
              <FormMessage className={messageClass} />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="voiceStyle"
          render={({ field }) => (
            <FormItem>
              <FormLabel className="uppercase font-bold text-xs">Voice</FormLabel>
              <Select onValueChange={field.onChange} value={field.value || "none"}>
                <FormControl>
                  <SelectTrigger className={selectTriggerClass}>
                    <SelectValue placeholder="Select voice" />
                  </SelectTrigger>
                </FormControl>
                <SelectContent className={selectContentClass}>
                  {VOICE_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value} className={selectItemClass}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FormDescription className="text-[10px] uppercase">
                Optional. Preferred voice for spoken replies.
              </FormDescription>
              <FormMessage className={messageClass} />
            </FormItem>
          )}
        />
      </div>

      <FormField
        control={form.control}
        name="shellColor"
        render={({ field }) => (
          <FormItem>
            <FormLabel className="uppercase font-bold text-xs">Issued Shell</FormLabel>
            <div className="grid grid-cols-3 sm:grid-cols-5 gap-2">
              {LOBSTER_PRESETS.map((preset) => {
                const selected = preset.shellColor.toLowerCase() === field.value.toLowerCase();
                return (
                  <button
                    key={preset.id}
                    type="button"
                    title={`${preset.name} — ${preset.blurb}`}
                    aria-pressed={selected}
                    onClick={() => field.onChange(preset.shellColor)}
                    className={`flex flex-col items-center gap-1 p-1 border-4 transition-colors ${
                      selected
                        ? "border-primary bg-primary/10"
                        : "border-border bg-muted/30 hover:bg-muted"
                    }`}
                  >
                    <MarlowLobster size={56} preset={preset.id} status="idle" />
                    <span className="text-[9px] font-bold uppercase leading-none">{preset.name}</span>
                  </button>
                );
              })}
            </div>
            <p className="text-[10px] text-muted-foreground uppercase font-bold pt-1">
              Ten standard issue shells, same lobster underneath.
            </p>
            <FormMessage className={messageClass} />
          </FormItem>
        )}
      />
    </>
  );
}

const DEFAULT_MODEL_SENTINEL = "__workspace_default__";

/**
 * Model preference picker. Uses the live provider catalog when it is
 * available and degrades to a free-text input (with the availability
 * message) when it is not, so configuration is never lost.
 */
function ModelField({ form }: { form: UseFormReturn<AgentFormValues> }) {
  const providerChoice = form.watch("provider");
  const { data: settings } = useGetProviderSettings();
  // Agents following the workspace default pick models against the
  // effective (workspace-configured) provider.
  const provider =
    providerChoice === "workspace_default"
      ? (settings?.defaultProvider ?? AgentProvider.claude_max)
      : providerChoice;
  const { data: catalog, isLoading } = useListProviderModels(provider);
  const hasCatalog = Boolean(catalog?.available && catalog.models.length > 0);

  return (
    <FormField
      control={form.control}
      name="model"
      render={({ field }) => (
        <FormItem>
          <FormLabel className="uppercase font-bold text-xs">Preferred Model</FormLabel>
          {hasCatalog ? (
            <Select
              onValueChange={(val) =>
                field.onChange(val === DEFAULT_MODEL_SENTINEL ? "" : val)
              }
              value={field.value || DEFAULT_MODEL_SENTINEL}
            >
              <FormControl>
                <SelectTrigger className={selectTriggerClass}>
                  <SelectValue placeholder="Workspace default" />
                </SelectTrigger>
              </FormControl>
              <SelectContent className={`${selectContentClass} max-h-72`}>
                <SelectItem value={DEFAULT_MODEL_SENTINEL} className={selectItemClass}>
                  Workspace Default
                </SelectItem>
                {field.value &&
                  !catalog!.models.some((m) => m.id === field.value) && (
                    <SelectItem value={field.value} className={selectItemClass}>
                      {field.value} (current)
                    </SelectItem>
                  )}
                {catalog!.models.map((model) => (
                  <SelectItem key={model.id} value={model.id} className={selectItemClass}>
                    {model.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <FormControl>
              <Input
                {...field}
                placeholder={isLoading ? "Loading models..." : "Workspace default"}
                className={inputClass}
              />
            </FormControl>
          )}
          <FormDescription className="text-[10px] uppercase">
            {hasCatalog
              ? "Optional. Workspace default applies when unset."
              : (catalog?.message ??
                "Optional. Leave blank for the workspace default.")}
          </FormDescription>
          <FormMessage className={messageClass} />
        </FormItem>
      )}
    />
  );
}

export function AgentPreviewCard({ form }: { form: UseFormReturn<AgentFormValues> }) {
  const shellColor = form.watch("shellColor");
  return (
    <>
      <div className="flex flex-col items-center justify-center p-8 bg-muted/30 border-4 border-border border-dashed mb-6">
        <MarlowLobster size={160} status="idle" shellColor={shellColor} />
      </div>
      <div className="space-y-4">
        <div>
          <div className="text-[10px] text-muted-foreground uppercase font-bold mb-1">ID Badge</div>
          <div className="font-bold uppercase text-lg leading-tight">{form.watch("name") || "UNKNOWN"}</div>
          <div className="text-accent text-xs font-mono">{form.watch("title") || "UNASSIGNED"}</div>
          {form.watch("specialization") ? (
            <div className="text-muted-foreground text-[10px] font-mono mt-1">
              {form.watch("specialization")}
            </div>
          ) : null}
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
            <Badge variant="outline">
              {form.watch("provider") === "workspace_default"
                ? "default"
                : form.watch("provider")}
            </Badge>
          </div>
        </div>
      </div>
    </>
  );
}
