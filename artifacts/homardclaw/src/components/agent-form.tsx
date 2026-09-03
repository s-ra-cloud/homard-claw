import React from "react";
import { Link } from "wouter";
import type { UseFormReturn } from "react-hook-form";
import * as z from "zod";
import {
  AgentGender,
  AgentProvider,
  AgentSecurityPreset,
  useGetProviderSettings,
  useGetProviders,
  useListCapabilities,
  useListConnectedApps,
  useListCustomApis,
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
import { Switch } from "@/components/ui/switch";

export const VOICE_OPTIONS = [
  { value: "none", label: "None (Text Only)" },
  { value: "warm", label: "Warm" },
  { value: "crisp", label: "Crisp" },
  { value: "deep", label: "Deep" },
  { value: "bubbly", label: "Bubbly" },
] as const;

export const GENDER_OPTIONS = [
  { value: AgentGender.male, label: "Male" },
  { value: AgentGender.female, label: "Female" },
  { value: AgentGender.unspecified, label: "Unspecified" },
] as const;

export const AUTONOMY_OPTIONS = [
  {
    value: "supervised",
    label: "Supervised (Approve Everything)",
    blurb: "Every task waits for your sign-off before it runs.",
  },
  {
    value: "limited",
    label: "Limited (Approve Expensive)",
    blurb: "Runs freely; costly or unpriced tasks wait for sign-off.",
  },
  {
    value: "autonomous",
    label: "Autonomous (Within Limits)",
    blurb: "Runs without sign-off, still inside the hard limits below.",
  },
] as const;

// Mirrors the server-side PERMISSION_PROFILES so blank fields can show the
// profile default they fall back to. Cosmetic only — the server enforces.
const PROFILE_DEFAULTS: Record<
  string,
  {
    maxTaskBudgetCents: number;
    dailyBudgetCents: number;
    maxTasksPerDay: number;
    approvalThresholdCents: number;
  }
> = {
  observer: {
    maxTaskBudgetCents: 5,
    dailyBudgetCents: 25,
    maxTasksPerDay: 10,
    approvalThresholdCents: 0,
  },
  assistant: {
    maxTaskBudgetCents: 50,
    dailyBudgetCents: 250,
    maxTasksPerDay: 50,
    approvalThresholdCents: 20,
  },
  operator: {
    maxTaskBudgetCents: 250,
    dailyBudgetCents: 1000,
    maxTasksPerDay: 200,
    approvalThresholdCents: 100,
  },
};

const limitField = z
  .string()
  .refine(
    (v) => v.trim() === "" || (Number.isFinite(Number(v)) && Number(v) >= 0),
    "Must be a non-negative number",
  );

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
    AgentProvider.codex_chatgpt,
    AgentProvider.openrouter,
  ]),
  model: z.string().max(180),
  /** Codex-only preferences; ignored unless the agent runs on Codex. */
  codexModel: z.string().max(200),
  codexReasoning: z.string().max(20),
  voiceStyle: z.string().max(60),
  securityPreset: z.enum([
    AgentSecurityPreset.observer,
    AgentSecurityPreset.assistant,
    AgentSecurityPreset.operator,
  ]),
  autonomy: z.enum(["supervised", "limited", "autonomous"]),
  gender: z.enum([
    AgentGender.male,
    AgentGender.female,
    AgentGender.unspecified,
  ]),
  maxTaskBudgetCents: limitField,
  dailyBudgetCents: limitField,
  maxTasksPerDay: limitField,
  approvalThresholdCents: limitField,
  shellColor: z
    .string()
    .regex(/^#[0-9A-Fa-f]{6}$/, "Must be a valid hex color"),
  /**
   * Connected-app access, keyed by app id. "none" means no grant row is
   * sent — access to the owner's external accounts is always opt-in.
   */
  appGrants: z.record(z.string(), z.enum(["none", "read", "draft", "write"])),
  /**
   * Sensitive data sandbox: server-enforced isolation for agents reading
   * confidential email/files. Read-only apps, no internet, no delegation,
   * no shared memory/knowledge.
   */
  sensitiveDataSandbox: z.boolean(),
});

export type AgentFormValues = z.infer<typeof agentFormSchema>;

/** Every app the workspace supports; mirrors the API's ConnectedApp enum. */
export const SUPPORTED_CONNECTED_APPS = [
  "gmail",
  "google_drive",
  "github",
] as const;

/**
 * Explicit "none" for every supported app. Forms must start from this (and
 * edit hydration must fill missing apps back to it): an untouched dropdown
 * whose value is `undefined` fails the enum check and shows a false red
 * "Required" error on save, even though "No Access" is exactly what it means.
 */
export function defaultAppGrants(): AgentFormValues["appGrants"] {
  return Object.fromEntries(
    SUPPORTED_CONNECTED_APPS.map((app) => [app, "none" as const]),
  );
}

/**
 * A complete, blank set of field values.
 *
 * Every form using these fields must start from a full object. React Hook
 * Form applies its `values` prop in an effect, so a form that only supplies
 * `values` renders once with no fields at all — and any field that reads its
 * value directly (the shell picker compares colours) throws on that render.
 */
export const emptyAgentFormValues: AgentFormValues = {
  name: "",
  title: "",
  mission: "",
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
  gender: AgentGender.unspecified,
  maxTaskBudgetCents: "",
  dailyBudgetCents: "",
  maxTasksPerDay: "",
  approvalThresholdCents: "",
  shellColor: LOBSTER_PRESETS[0].shellColor,
  appGrants: defaultAppGrants(),
  sensitiveDataSandbox: false,
};

/** Convert the form's app→level map into the API's grant list. */
export function appGrantsPayload(
  data: AgentFormValues,
): { app: string; accessLevel: "read" | "draft" | "write" }[] {
  return Object.entries(data.appGrants)
    .filter(
      (entry): entry is [string, "read" | "draft" | "write"] =>
        entry[1] !== "none",
    )
    .map(([app, accessLevel]) => ({ app, accessLevel }));
}

/** Convert an agent's grant list into the form's app→level map. */
export function appGrantsFormValue(
  grants: readonly { app: string; accessLevel: string }[] | undefined,
): AgentFormValues["appGrants"] {
  // Start from the full "none" set so apps the agent holds no grant for
  // still hydrate to an explicit value instead of undefined.
  const value: AgentFormValues["appGrants"] = defaultAppGrants();
  for (const grant of grants ?? []) {
    value[grant.app] = grant.accessLevel as "read" | "draft" | "write";
  }
  return value;
}

/**
 * Custom limits typed into the form, or null when every field is blank
 * (blank means "use the clearance profile default").
 */
export function permissionOverridesPayload(data: AgentFormValues): {
  maxTaskBudgetCents?: number;
  dailyBudgetCents?: number;
  maxTasksPerDay?: number;
  approvalThresholdCents?: number;
} | null {
  const num = (v: string): number | undefined =>
    v.trim() === "" ? undefined : Number(v);
  const entries = Object.entries({
    maxTaskBudgetCents: num(data.maxTaskBudgetCents),
    dailyBudgetCents: num(data.dailyBudgetCents),
    maxTasksPerDay: num(data.maxTasksPerDay),
    approvalThresholdCents: num(data.approvalThresholdCents),
  }).filter(([, v]) => v !== undefined);
  return entries.length > 0 ? Object.fromEntries(entries) : null;
}

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

export function AgentFormFields({
  form,
}: {
  form: UseFormReturn<AgentFormValues>;
}) {
  const { data: providers } = useGetProviders();
  const codexEnabled = Boolean(
    providers?.find((p) => p.provider === AgentProvider.codex_chatgpt)?.enabled,
  );
  return (
    <>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem>
              <FormLabel className="uppercase font-bold text-xs">
                Designation (Name)
              </FormLabel>
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
              <FormLabel className="uppercase font-bold text-xs">
                Role Title
              </FormLabel>
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
            <FormLabel className="uppercase font-bold text-xs">
              Specialization
            </FormLabel>
            <FormControl>
              <Input
                {...field}
                placeholder="e.g. Financial research, code review, copywriting"
                className={inputClass}
              />
            </FormControl>
            <FormDescription className="text-[10px] uppercase">
              Optional. What this Crustabot is best at.
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
            <FormLabel className="uppercase font-bold text-xs">
              Core Mission / System Prompt
            </FormLabel>
            <FormControl>
              <Textarea {...field} rows={5} className={textareaClass} />
            </FormControl>
            <FormDescription className="text-[10px] uppercase">
              Defines the Crustabot&apos;s primary directives and constraints.
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
            <FormLabel className="uppercase font-bold text-xs">
              Personality Profile
            </FormLabel>
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
              <FormLabel className="uppercase font-bold text-xs">
                Standing Goals
              </FormLabel>
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
              <FormLabel className="uppercase font-bold text-xs">
                Operating Instructions
              </FormLabel>
              <FormControl>
                <Textarea
                  {...field}
                  rows={4}
                  placeholder="e.g. Always cite sources. Never contact third parties."
                  className={textareaClass}
                />
              </FormControl>
              <FormDescription className="text-[10px] uppercase">
                Optional. Rules the Crustabot must follow.
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
              <FormLabel className="uppercase font-bold text-xs">
                Compute Provider
              </FormLabel>
              <Select onValueChange={field.onChange} value={field.value}>
                <FormControl>
                  <SelectTrigger className={selectTriggerClass}>
                    <SelectValue placeholder="Select provider" />
                  </SelectTrigger>
                </FormControl>
                <SelectContent className={selectContentClass}>
                  <SelectItem
                    value="workspace_default"
                    className={selectItemClass}
                  >
                    Workspace Default
                  </SelectItem>
                  <SelectItem
                    value={AgentProvider.claude_max}
                    className={selectItemClass}
                  >
                    Claude Code
                  </SelectItem>
                  {/* Codex appears only while the server flag is on; an
                      agent already saved on Codex keeps its value either way. */}
                  {codexEnabled ||
                  field.value === AgentProvider.codex_chatgpt ? (
                    <SelectItem
                      value={AgentProvider.codex_chatgpt}
                      className={selectItemClass}
                    >
                      Codex via ChatGPT Plus
                    </SelectItem>
                  ) : null}
                  <SelectItem
                    value={AgentProvider.openrouter}
                    className={selectItemClass}
                  >
                    OpenRouter
                  </SelectItem>
                </SelectContent>
              </Select>
              <FormMessage className={messageClass} />
            </FormItem>
          )}
        />

        <ModelField form={form} />
      </div>

      <CodexPreferenceFields form={form} />

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <FormField
          control={form.control}
          name="securityPreset"
          render={({ field }) => (
            <FormItem>
              <FormLabel className="uppercase font-bold text-xs">
                Clearance Level
              </FormLabel>
              <Select onValueChange={field.onChange} value={field.value}>
                <FormControl>
                  <SelectTrigger className={selectTriggerClass}>
                    <SelectValue placeholder="Select clearance" />
                  </SelectTrigger>
                </FormControl>
                <SelectContent className={selectContentClass}>
                  <SelectItem
                    value={AgentSecurityPreset.observer}
                    className={selectItemClass}
                  >
                    Observer (Read Only)
                  </SelectItem>
                  <SelectItem
                    value={AgentSecurityPreset.assistant}
                    className={selectItemClass}
                  >
                    Assistant (Ask Confirm)
                  </SelectItem>
                  <SelectItem
                    value={AgentSecurityPreset.operator}
                    className={selectItemClass}
                  >
                    Operator (Full Auto)
                  </SelectItem>
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
              <FormLabel className="uppercase font-bold text-xs">
                Voice
              </FormLabel>
              <Select
                onValueChange={field.onChange}
                value={field.value || "none"}
              >
                <FormControl>
                  <SelectTrigger className={selectTriggerClass}>
                    <SelectValue placeholder="Select voice" />
                  </SelectTrigger>
                </FormControl>
                <SelectContent className={selectContentClass}>
                  {VOICE_OPTIONS.map((option) => (
                    <SelectItem
                      key={option.value}
                      value={option.value}
                      className={selectItemClass}
                    >
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
        name="gender"
        render={({ field }) => (
          <FormItem>
            <FormLabel className="uppercase font-bold text-xs">
              Gender
            </FormLabel>
            <Select onValueChange={field.onChange} value={field.value}>
              <FormControl>
                <SelectTrigger className={selectTriggerClass}>
                  <SelectValue placeholder="Select gender" />
                </SelectTrigger>
              </FormControl>
              <SelectContent className={selectContentClass}>
                {GENDER_OPTIONS.map((option) => (
                  <SelectItem
                    key={option.value}
                    value={option.value}
                    className={selectItemClass}
                  >
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FormMessage className={messageClass} />
          </FormItem>
        )}
      />

      <FormField
        control={form.control}
        name="autonomy"
        render={({ field }) => (
          <FormItem>
            <FormLabel className="uppercase font-bold text-xs">
              Autonomy Level
            </FormLabel>
            <Select onValueChange={field.onChange} value={field.value}>
              <FormControl>
                <SelectTrigger className={selectTriggerClass}>
                  <SelectValue placeholder="Select autonomy" />
                </SelectTrigger>
              </FormControl>
              <SelectContent className={selectContentClass}>
                {AUTONOMY_OPTIONS.map((option) => (
                  <SelectItem
                    key={option.value}
                    value={option.value}
                    className={selectItemClass}
                  >
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FormDescription className="text-[10px] uppercase">
              {AUTONOMY_OPTIONS.find((o) => o.value === field.value)?.blurb ??
                "How much this Crustabot may do without your sign-off."}
            </FormDescription>
            <FormMessage className={messageClass} />
          </FormItem>
        )}
      />

      <CustomLimitsFields form={form} />

      <ConnectedAppsFields form={form} />

      <SensitiveDataSandboxField form={form} />

      <FormField
        control={form.control}
        name="shellColor"
        render={({ field }) => (
          <FormItem>
            <FormLabel className="uppercase font-bold text-xs">
              Issued Shell
            </FormLabel>
            <div className="grid grid-cols-3 sm:grid-cols-5 gap-2">
              {LOBSTER_PRESETS.map((preset) => {
                const selected =
                  preset.shellColor.toLowerCase() ===
                  (field.value ?? "").toLowerCase();
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
                    <span className="text-[9px] font-bold uppercase leading-none">
                      {preset.name}
                    </span>
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

/**
 * Custom budget/limit overrides. Blank fields fall back to the selected
 * clearance profile; the placeholder shows that fallback value.
 */
function CustomLimitsFields({
  form,
}: {
  form: UseFormReturn<AgentFormValues>;
}) {
  const preset = form.watch("securityPreset");
  const defaults = PROFILE_DEFAULTS[preset] ?? PROFILE_DEFAULTS.assistant;
  const limits = [
    {
      name: "maxTaskBudgetCents",
      label: "Per-Task Cap (¢)",
      hint: "Tasks estimated above this are blocked",
    },
    {
      name: "dailyBudgetCents",
      label: "Daily Budget (¢)",
      hint: "Spending stops here each day",
    },
    { name: "maxTasksPerDay", label: "Tasks / Day", hint: "Daily run limit" },
    {
      name: "approvalThresholdCents",
      label: "Approval Above (¢)",
      hint: "Costlier tasks ask first",
    },
  ] as const;
  return (
    <div className="border-4 border-border bg-muted/20 p-4 space-y-3">
      <div>
        <div className="uppercase font-bold text-xs">Custom Limits</div>
        <p className="text-[10px] text-muted-foreground uppercase font-bold">
          Optional. Blank fields use the {preset} clearance defaults.
        </p>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {limits.map((limit) => (
          <FormField
            key={limit.name}
            control={form.control}
            name={limit.name}
            render={({ field }) => (
              <FormItem>
                <FormLabel className="uppercase font-bold text-[10px]">
                  {limit.label}
                </FormLabel>
                <FormControl>
                  <Input
                    {...field}
                    inputMode="decimal"
                    placeholder={String(defaults[limit.name])}
                    className={inputClass}
                  />
                </FormControl>
                <FormDescription className="text-[9px] uppercase">
                  {limit.hint}
                </FormDescription>
                <FormMessage className={messageClass} />
              </FormItem>
            )}
          />
        ))}
      </div>
    </div>
  );
}

const ACCESS_LEVEL_OPTIONS = [
  { value: "none", label: "No Access", blurb: "Cannot touch this app at all." },
  { value: "read", label: "Read", blurb: "Search and read data only." },
  {
    value: "draft",
    label: "Draft",
    blurb: "Read, plus prepare drafts nobody outside sees.",
  },
  {
    value: "write",
    label: "Write (Approval)",
    blurb: "Full access; visible changes still wait for your approval.",
  },
] as const;

/**
 * Per-app access grants against the owner's connected accounts. Everything
 * defaults to "No Access" — grants are explicit, never inherited — and the
 * live connection status is shown so a grant to a disconnected app is
 * visibly pointless rather than silently broken.
 */
function ConnectedAppsFields({
  form,
}: {
  form: UseFormReturn<AgentFormValues>;
}) {
  const { data: connectedApps } = useListConnectedApps();
  const { data: capabilities } = useListCapabilities();
  const { data: customApis } = useListCustomApis();
  const apps = connectedApps?.apps ?? [];
  // Installed optional capability packages (e.g. Web Research) are granted
  // exactly like the built-in apps: explicit, per agent, default nothing.
  const packages = (capabilities?.packages ?? []).filter(
    (pkg) => !pkg.builtin && pkg.installed && pkg.status === "active",
  );
  // Owner-whitelisted custom APIs join the same explicit-grant model: each
  // one defaults to "No Access" for every Crustabot.
  const custom = customApis?.apis ?? [];
  if (apps.length === 0 && packages.length === 0 && custom.length === 0)
    return null;
  return (
    <div className="border-4 border-border bg-muted/20 p-4 space-y-3">
      <div>
        <div className="uppercase font-bold text-xs">Connected App Access</div>
        <p className="text-[10px] text-muted-foreground uppercase font-bold">
          What this Crustabot may do with your already-connected accounts.
          Default: nothing.
        </p>
        <p className="text-[10px] text-muted-foreground mt-1">
          These dropdowns only grant permission — they don't connect an account.
          You connect your own accounts (like your Gmail) on the{" "}
          <Link href="/connected-apps" className="underline font-bold">
            Connected Apps
          </Link>{" "}
          page; they belong to your workspace alone, and Crustabots never see
          credentials.
        </p>
      </div>
      <div className="space-y-2">
        {apps.map((app) => (
          <FormField
            key={app.app}
            control={form.control}
            name={`appGrants.${app.app}` as const}
            render={({ field }) => {
              const level = field.value ?? "none";
              return (
                <FormItem className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4 border-2 border-border/50 bg-background/50 p-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-bold uppercase text-xs">
                        {app.displayName}
                      </span>
                      {!app.enabled ? (
                        <Badge variant="destructive">Disabled</Badge>
                      ) : app.status === "connected" ? (
                        <Badge variant="success">Connected</Badge>
                      ) : app.status === "expired" ? (
                        <Badge variant="destructive">Reconnect Needed</Badge>
                      ) : app.status === "not_connected" ? (
                        <Badge variant="warning">Not Connected</Badge>
                      ) : (
                        <Badge variant="outline">Status Unknown</Badge>
                      )}
                    </div>
                    {app.status === "connected" && app.accountLabel ? (
                      <p className="text-[9px] text-muted-foreground font-mono mt-1 break-all">
                        Account: {app.accountLabel}
                      </p>
                    ) : null}
                    {app.status === "not_connected" ||
                    app.status === "expired" ? (
                      <p className="text-[9px] mt-1">
                        <Link
                          href="/connected-apps"
                          className="underline font-bold uppercase text-muted-foreground"
                        >
                          {app.status === "expired"
                            ? "Reconnect in Connected Apps →"
                            : "Set up in Connected Apps →"}
                        </Link>
                      </p>
                    ) : null}
                    <p className="text-[9px] text-muted-foreground uppercase font-bold mt-1">
                      {
                        ACCESS_LEVEL_OPTIONS.find((o) => o.value === level)
                          ?.blurb
                      }
                    </p>
                    {app.app === "github" && level === "write" ? (
                      <p className="text-[9px] text-muted-foreground mt-1">
                        Write on GitHub includes code changes: branches,
                        commits, pull requests, and merges. Each one is shown
                        to you as a concrete approval before it runs.
                      </p>
                    ) : null}
                  </div>
                  <Select onValueChange={field.onChange} value={level}>
                    <FormControl>
                      <SelectTrigger
                        className={`${selectTriggerClass} sm:w-44`}
                      >
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent className={selectContentClass}>
                      {ACCESS_LEVEL_OPTIONS.map((option) => (
                        <SelectItem
                          key={option.value}
                          value={option.value}
                          className={selectItemClass}
                        >
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage className={messageClass} />
                </FormItem>
              );
            }}
          />
        ))}
        {packages.map((pkg) => (
          <FormField
            key={pkg.packageId}
            control={form.control}
            name={`appGrants.${pkg.packageId}` as const}
            render={({ field }) => {
              const level = field.value ?? "none";
              return (
                <FormItem className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4 border-2 border-border/50 bg-background/50 p-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-bold uppercase text-xs">
                        {pkg.displayName}
                      </span>
                      <Badge variant="outline">Package</Badge>
                      {!pkg.enabled ? (
                        <Badge variant="destructive">Disabled</Badge>
                      ) : pkg.health === "connected" ||
                        pkg.health === "none_required" ? (
                        <Badge variant="success">Ready</Badge>
                      ) : (
                        <Badge variant="warning">Not Connected</Badge>
                      )}
                    </div>
                    <p className="text-[9px] text-muted-foreground uppercase font-bold mt-1">
                      {
                        ACCESS_LEVEL_OPTIONS.find((o) => o.value === level)
                          ?.blurb
                      }
                    </p>
                  </div>
                  <Select onValueChange={field.onChange} value={level}>
                    <FormControl>
                      <SelectTrigger
                        className={`${selectTriggerClass} sm:w-44`}
                      >
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent className={selectContentClass}>
                      {ACCESS_LEVEL_OPTIONS.map((option) => (
                        <SelectItem
                          key={option.value}
                          value={option.value}
                          className={selectItemClass}
                        >
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage className={messageClass} />
                </FormItem>
              );
            }}
          />
        ))}
        {custom.map((api) => (
          <FormField
            key={api.packageId}
            control={form.control}
            name={`appGrants.${api.packageId}` as const}
            render={({ field }) => {
              const level = field.value ?? "none";
              return (
                <FormItem className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4 border-2 border-border/50 bg-background/50 p-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-bold uppercase text-xs">
                        {api.displayName}
                      </span>
                      <Badge variant="outline">Custom API</Badge>
                      {!api.enabled ? (
                        <Badge variant="destructive">Disabled</Badge>
                      ) : api.validationStatus === "ok" ? (
                        <Badge variant="success">Reachable</Badge>
                      ) : api.validationStatus === "failed" ? (
                        <Badge variant="destructive">Check Failed</Badge>
                      ) : (
                        <Badge variant="warning">Unchecked</Badge>
                      )}
                    </div>
                    <p className="text-[9px] text-muted-foreground font-mono mt-1 break-all">
                      {api.baseUrl}
                    </p>
                    <p className="text-[9px] text-muted-foreground uppercase font-bold mt-1">
                      {
                        ACCESS_LEVEL_OPTIONS.find((o) => o.value === level)
                          ?.blurb
                      }
                    </p>
                  </div>
                  <Select onValueChange={field.onChange} value={level}>
                    <FormControl>
                      <SelectTrigger
                        className={`${selectTriggerClass} sm:w-44`}
                      >
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent className={selectContentClass}>
                      {ACCESS_LEVEL_OPTIONS.map((option) => (
                        <SelectItem
                          key={option.value}
                          value={option.value}
                          className={selectItemClass}
                        >
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage className={messageClass} />
                </FormItem>
              );
            }}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * Sensitive data sandbox toggle. Placed right after the app grants because
 * the two decisions belong together: an agent trusted to read confidential
 * email/files can be locked down so nothing it reads can leave — read-only
 * apps, no internet for its tools, no delegation, no shared memory.
 */
function SensitiveDataSandboxField({
  form,
}: {
  form: UseFormReturn<AgentFormValues>;
}) {
  return (
    <FormField
      control={form.control}
      name="sensitiveDataSandbox"
      render={({ field }) => (
        <FormItem className="border-4 border-border bg-muted/20 p-4 flex flex-row items-start justify-between gap-4">
          <div className="space-y-1">
            <FormLabel className="uppercase font-bold text-xs">
              Sensitive Data Sandbox
            </FormLabel>
            <p className="text-[10px] text-muted-foreground uppercase font-bold">
              For Crustabots that read confidential email or files.
            </p>
            <p className="text-[10px] text-muted-foreground">
              When on, the server locks this Crustabot down: connected apps
              become read-only (no drafts, no sends), its tools get no internet
              or web search, it cannot delegate work or receive delegated work
              or message other Crustabots, and shared memories and knowledge
              files stay out of its context. You still see its task results and
              action history.
            </p>
          </div>
          <FormControl>
            <Switch
              checked={field.value}
              onCheckedChange={field.onChange}
              aria-label="Sensitive data sandbox"
            />
          </FormControl>
        </FormItem>
      )}
    />
  );
}

const DEFAULT_MODEL_SENTINEL = "__workspace_default__";

/**
 * Codex-specific model and reasoning preferences. Both lists come from the
 * server (catalog endpoint and provider status), so the form can never
 * offer a combination the server would reject. The whole block stays
 * hidden until the agent is actually pointed at Codex.
 */
function CodexPreferenceFields({
  form,
}: {
  form: UseFormReturn<AgentFormValues>;
}) {
  const providerChoice = form.watch("provider");
  const { data: settings } = useGetProviderSettings();
  const { data: providers } = useGetProviders();
  const effective =
    providerChoice === "workspace_default"
      ? settings?.defaultProvider
      : providerChoice;
  const status = providers?.find(
    (p) => p.provider === AgentProvider.codex_chatgpt,
  );
  const { data: catalog } = useListProviderModels(AgentProvider.codex_chatgpt, {
    query: {
      queryKey: [`/api/providers/${AgentProvider.codex_chatgpt}/models`],
      enabled: effective === AgentProvider.codex_chatgpt,
    },
  });

  if (effective !== AgentProvider.codex_chatgpt) return null;
  if (status && !status.enabled) {
    return (
      <div className="border-4 border-border border-dashed p-3 text-[10px] uppercase font-bold text-muted-foreground">
        Codex is switched off on the server. This Crustabot will not be able to
        run until it is re-enabled.
      </div>
    );
  }

  const levels = status?.reasoningLevels ?? [];

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 border-4 border-border p-3">
      <FormField
        control={form.control}
        name="codexModel"
        render={({ field }) => (
          <FormItem>
            <FormLabel className="uppercase font-bold text-xs">
              Codex Model
            </FormLabel>
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
              <SelectContent className={selectContentClass}>
                <SelectItem
                  value={DEFAULT_MODEL_SENTINEL}
                  className={selectItemClass}
                >
                  Workspace Default
                </SelectItem>
                {(catalog?.models ?? []).map((model) => (
                  <SelectItem
                    key={model.id}
                    value={model.id}
                    className={selectItemClass}
                  >
                    {model.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FormDescription className="text-[10px] uppercase">
              Runs on the owner's ChatGPT Codex allowance.
            </FormDescription>
            <FormMessage className={messageClass} />
          </FormItem>
        )}
      />

      <FormField
        control={form.control}
        name="codexReasoning"
        render={({ field }) => (
          <FormItem>
            <FormLabel className="uppercase font-bold text-xs">
              Reasoning Effort
            </FormLabel>
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
              <SelectContent className={selectContentClass}>
                <SelectItem
                  value={DEFAULT_MODEL_SENTINEL}
                  className={selectItemClass}
                >
                  Workspace Default
                </SelectItem>
                {levels.map((level) => (
                  <SelectItem
                    key={level}
                    value={level}
                    className={selectItemClass}
                  >
                    {level}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FormDescription className="text-[10px] uppercase">
              Higher effort spends more of the allowance per task.
            </FormDescription>
            <FormMessage className={messageClass} />
          </FormItem>
        )}
      />
    </div>
  );
}

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
          <FormLabel className="uppercase font-bold text-xs">
            Preferred Model
          </FormLabel>
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
                <SelectItem
                  value={DEFAULT_MODEL_SENTINEL}
                  className={selectItemClass}
                >
                  Workspace Default
                </SelectItem>
                {field.value &&
                  !catalog!.models.some((m) => m.id === field.value) && (
                    <SelectItem value={field.value} className={selectItemClass}>
                      {field.value} (current)
                    </SelectItem>
                  )}
                {catalog!.models.map((model) => (
                  <SelectItem
                    key={model.id}
                    value={model.id}
                    className={selectItemClass}
                  >
                    {model.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <FormControl>
              <Input
                {...field}
                placeholder={
                  isLoading ? "Loading models..." : "Workspace default"
                }
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

export function AgentPreviewCard({
  form,
}: {
  form: UseFormReturn<AgentFormValues>;
}) {
  const shellColor = form.watch("shellColor");
  return (
    <>
      <div className="flex flex-col items-center justify-center p-8 bg-muted/30 border-4 border-border border-dashed mb-6">
        <MarlowLobster size={160} status="idle" shellColor={shellColor} />
      </div>
      <div className="space-y-4">
        <div>
          <div className="text-[10px] text-muted-foreground uppercase font-bold mb-1">
            ID Badge
          </div>
          <div className="font-bold uppercase text-lg leading-tight">
            {form.watch("name") || "UNKNOWN"}
          </div>
          <div className="text-accent text-xs font-mono">
            {form.watch("title") || "UNASSIGNED"}
          </div>
          {form.watch("specialization") ? (
            <div className="text-muted-foreground text-[10px] font-mono mt-1">
              {form.watch("specialization")}
            </div>
          ) : null}
        </div>

        <div className="grid grid-cols-2 gap-2 border-t-4 border-border pt-4">
          <div>
            <div className="text-[10px] text-muted-foreground uppercase font-bold mb-1">
              Clearance
            </div>
            <Badge
              variant={
                form.watch("securityPreset") === "operator"
                  ? "destructive"
                  : form.watch("securityPreset") === "assistant"
                    ? "accent"
                    : "default"
              }
            >
              {form.watch("securityPreset")}
            </Badge>
          </div>
          <div>
            <div className="text-[10px] text-muted-foreground uppercase font-bold mb-1">
              Provider
            </div>
            <Badge variant="outline">
              {form.watch("provider") === "workspace_default"
                ? "default"
                : form.watch("provider")}
            </Badge>
          </div>
          <div>
            <div className="text-[10px] text-muted-foreground uppercase font-bold mb-1">
              Gender
            </div>
            <Badge variant="outline">{form.watch("gender")}</Badge>
          </div>
        </div>
      </div>
    </>
  );
}
