import React, { useEffect, useState } from "react";
import {
  useGetProviders,
  useGetProviderSettings,
  useListProviderModels,
  useUpdateProviderSettings,
  useTestCodexConnection,
  useConnectCodex,
  useDisconnectCodex,
  useSetProviderCredential,
  useDeleteProviderCredential,
  getGetProvidersQueryKey,
  getGetProviderSettingsQueryKey,
  ProviderSettingsDefaultProvider,
  ProviderSettingsCodexReasoning,
  type ProviderStatus,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Shell } from "@/components/layout/Shell";
import { PixelCard } from "@/components/ui/pixel-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import {
  CheckCircle,
  AlertTriangle,
  Server,
  Network,
  Route,
  CreditCard,
} from "lucide-react";

const selectTriggerClass =
  "bg-background border-4 border-border rounded-none focus:ring-0 focus:border-primary font-mono text-xs uppercase font-bold";
const selectContentClass =
  "border-4 border-border rounded-none bg-card max-h-72";
const selectItemClass =
  "font-mono text-xs uppercase focus:bg-primary focus:text-primary-foreground";

const DEFAULT_SENTINEL = "__provider_default__";

/** Default-model picker for one provider inside the routing card. */
function DefaultModelPicker({
  provider,
  label,
  value,
  onChange,
}: {
  provider: ProviderSettingsDefaultProvider;
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const { data: catalog, isLoading } = useListProviderModels(provider);
  const hasCatalog = Boolean(catalog?.available && catalog.models.length > 0);

  return (
    <div className="space-y-2">
      <label className="uppercase font-bold text-xs">{label}</label>
      {hasCatalog ? (
        <Select
          value={value || DEFAULT_SENTINEL}
          onValueChange={(val) => onChange(val === DEFAULT_SENTINEL ? "" : val)}
        >
          <SelectTrigger className={selectTriggerClass}>
            <SelectValue placeholder="Built-in default" />
          </SelectTrigger>
          <SelectContent className={selectContentClass}>
            <SelectItem value={DEFAULT_SENTINEL} className={selectItemClass}>
              Built-in Default
            </SelectItem>
            {value && !catalog!.models.some((m) => m.id === value) && (
              <SelectItem value={value} className={selectItemClass}>
                {value} (current)
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
        <Input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={isLoading ? "Loading models..." : "Built-in default"}
          className="font-mono bg-background border-4 border-border rounded-none focus-visible:ring-0 focus-visible:border-primary text-xs"
        />
      )}
      <p className="text-[10px] text-muted-foreground uppercase font-bold">
        {hasCatalog
          ? `${catalog!.models.length} models available`
          : (catalog?.message ??
            "Model catalog unavailable — enter a model id manually.")}
      </p>
    </div>
  );
}

function RoutingDefaultsCard() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: settings, isLoading } = useGetProviderSettings();
  const [defaultProvider, setDefaultProvider] =
    useState<ProviderSettingsDefaultProvider>(
      ProviderSettingsDefaultProvider.claude_max,
    );
  const [claudeModel, setClaudeModel] = useState("");
  const [openrouterModel, setOpenrouterModel] = useState("");
  const [codexModel, setCodexModel] = useState("");
  const [codexReasoning, setCodexReasoning] = useState("");
  const [paidFallbackConsent, setPaidFallbackConsent] = useState(false);
  const [paidFallbackLimit, setPaidFallbackLimit] = useState("");
  const { data: providers } = useGetProviders();
  const codex = providers?.find((p) => p.provider === "codex_chatgpt");

  useEffect(() => {
    if (!settings) return;
    setDefaultProvider(settings.defaultProvider);
    setClaudeModel(settings.claudeModel ?? "");
    setOpenrouterModel(settings.openrouterModel ?? "");
    setCodexModel(settings.codexModel ?? "");
    setCodexReasoning(settings.codexReasoning ?? "");
    setPaidFallbackConsent(settings.paidFallbackConsent);
    setPaidFallbackLimit(
      settings.paidFallbackLimitCents != null
        ? String(settings.paidFallbackLimitCents / 100)
        : "",
    );
  }, [settings]);

  const update = useUpdateProviderSettings({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({
          queryKey: getGetProviderSettingsQueryKey(),
        });
        toast({ title: "Routing defaults saved" });
      },
      onError: (error) => {
        toast({
          variant: "destructive",
          title: "Could not save routing defaults",
          description: error.message,
        });
      },
    },
  });

  const limitDollars = Number(paidFallbackLimit);
  const limitInvalid =
    paidFallbackLimit.trim() !== "" &&
    (!Number.isFinite(limitDollars) || limitDollars < 0);

  const save = () => {
    update.mutate({
      data: {
        defaultProvider,
        claudeModel: claudeModel.trim() === "" ? null : claudeModel.trim(),
        openrouterModel:
          openrouterModel.trim() === "" ? null : openrouterModel.trim(),
        codexModel: codexModel.trim() === "" ? null : codexModel.trim(),
        codexReasoning:
          codexReasoning.trim() === ""
            ? null
            : (codexReasoning.trim() as ProviderSettingsCodexReasoning),
        paidFallbackConsent,
        paidFallbackLimitCents:
          paidFallbackLimit.trim() === ""
            ? null
            : Math.round(limitDollars * 100),
      },
    });
  };

  return (
    <PixelCard title="Routing Defaults">
      {isLoading ? (
        <div className="animate-pulse h-32 bg-muted/50" />
      ) : (
        <div className="space-y-6">
          <div className="flex items-start gap-3">
            <div className="p-2 border-2 border-border pixel-shadow bg-accent/20 text-accent shrink-0">
              <Route className="w-5 h-5" />
            </div>
            <p className="text-xs text-muted-foreground">
              Workspace-wide defaults. Crustabots without their own provider or
              model preference route here; task-level overrides always win.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="space-y-2">
              <label className="uppercase font-bold text-xs">
                Default Provider
              </label>
              <Select
                value={defaultProvider}
                onValueChange={(val) =>
                  setDefaultProvider(val as ProviderSettingsDefaultProvider)
                }
              >
                <SelectTrigger className={selectTriggerClass}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className={selectContentClass}>
                  <SelectItem
                    value={ProviderSettingsDefaultProvider.claude_max}
                    className={selectItemClass}
                  >
                    Claude Code
                  </SelectItem>
                  {codex?.enabled || defaultProvider === "codex_chatgpt" ? (
                    <SelectItem
                      value={ProviderSettingsDefaultProvider.codex_chatgpt}
                      className={selectItemClass}
                    >
                      Codex via ChatGPT Plus
                    </SelectItem>
                  ) : null}
                  <SelectItem
                    value={ProviderSettingsDefaultProvider.openrouter}
                    className={selectItemClass}
                  >
                    OpenRouter
                  </SelectItem>
                </SelectContent>
              </Select>
              <p className="text-[10px] text-muted-foreground uppercase font-bold">
                Used when a Crustabot has no provider preference.
              </p>
            </div>

            <DefaultModelPicker
              provider={ProviderSettingsDefaultProvider.claude_max}
              label="Claude Code Default Model"
              value={claudeModel}
              onChange={setClaudeModel}
            />
            <DefaultModelPicker
              provider={ProviderSettingsDefaultProvider.openrouter}
              label="OpenRouter Default Model"
              value={openrouterModel}
              onChange={setOpenrouterModel}
            />
          </div>

          {codex?.enabled ? (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 border-t-4 border-border pt-6">
              <DefaultModelPicker
                provider={ProviderSettingsDefaultProvider.codex_chatgpt}
                label="Codex Default Model"
                value={codexModel}
                onChange={setCodexModel}
              />
              <div className="space-y-2">
                <label className="uppercase font-bold text-xs">
                  Codex Reasoning Effort
                </label>
                <Select
                  value={codexReasoning || DEFAULT_SENTINEL}
                  onValueChange={(val) =>
                    setCodexReasoning(val === DEFAULT_SENTINEL ? "" : val)
                  }
                >
                  <SelectTrigger className={selectTriggerClass}>
                    <SelectValue placeholder="Built-in default" />
                  </SelectTrigger>
                  <SelectContent className={selectContentClass}>
                    <SelectItem
                      value={DEFAULT_SENTINEL}
                      className={selectItemClass}
                    >
                      Built-in Default
                    </SelectItem>
                    {(codex.reasoningLevels ?? []).map((level) => (
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
                <p className="text-[10px] text-muted-foreground uppercase font-bold">
                  Higher effort spends more of the ChatGPT allowance per task.
                </p>
              </div>
            </div>
          ) : null}

          <div className="border-t-4 border-border pt-6 space-y-3">
            <div className="flex items-start gap-3">
              <div className="p-2 border-2 border-border pixel-shadow bg-destructive/20 text-destructive shrink-0">
                <CreditCard className="w-5 h-5" />
              </div>
              <p className="text-xs text-muted-foreground">
                Subscription providers (Claude Code, Codex) never switch to a
                paid provider on their own. Leave this off and a stopped task
                waits for your decision instead.
              </p>
            </div>
            <label className="flex items-center gap-3 text-xs font-bold uppercase cursor-pointer">
              <input
                type="checkbox"
                checked={paidFallbackConsent}
                onChange={(e) => setPaidFallbackConsent(e.target.checked)}
                className="w-5 h-5 accent-primary border-4 border-border"
                data-testid="checkbox-paid-fallback-consent"
              />
              Allow automatic fallback to a paid provider
            </label>
            {paidFallbackConsent ? (
              <div className="space-y-2 max-w-xs">
                <label className="uppercase font-bold text-xs">
                  Per-task paid fallback limit ($)
                </label>
                <Input
                  value={paidFallbackLimit}
                  onChange={(e) => setPaidFallbackLimit(e.target.value)}
                  placeholder="No limit"
                  className="font-mono bg-background border-4 border-border rounded-none focus-visible:ring-0 focus-visible:border-primary text-xs"
                  data-testid="input-paid-fallback-limit"
                />
                {limitInvalid ? (
                  <p className="text-[10px] text-destructive uppercase font-bold">
                    Enter a non-negative dollar amount.
                  </p>
                ) : (
                  <p className="text-[10px] text-muted-foreground uppercase font-bold">
                    A task whose estimate exceeds this stops for your approval.
                  </p>
                )}
              </div>
            ) : null}
          </div>

          <div className="pt-4 border-t-4 border-border flex justify-end">
            <Button
              variant="primary"
              onClick={save}
              disabled={update.isPending || limitInvalid}
              data-testid="button-save-routing-defaults"
            >
              {update.isPending ? "SAVING..." : "SAVE DEFAULTS"}
            </Button>
          </div>
        </div>
      )}
    </PixelCard>
  );
}

/**
 * Connecting your own ChatGPT account to Codex.
 *
 * There is no official "sign in with ChatGPT" flow on the web, so the
 * session has to come from `codex login` on a desktop. The pasted file is
 * encrypted server-side and stored against your account — your Crustabots run
 * on your allowance, and the box is cleared the moment it is sent.
 */
function CodexActions({ provider }: { provider: ProviderStatus }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [checks, setChecks] = useState<
    { name: string; ok: boolean; detail: string }[] | null
  >(null);
  const [authJson, setAuthJson] = useState("");
  const connected = provider.authMode !== null;

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: getGetProvidersQueryKey() });

  const test = useTestCodexConnection({
    mutation: {
      onSuccess: (result) => {
        setChecks(result.checks);
        refresh();
      },
      onError: (error) =>
        toast({
          variant: "destructive",
          title: "Connection test failed",
          description: error.message,
        }),
    },
  });

  const connect = useConnectCodex({
    mutation: {
      onSuccess: (result) => {
        setAuthJson("");
        setChecks(null);
        refresh();
        toast({ title: "Codex account connected", description: result.detail });
      },
      onError: (error) =>
        toast({
          variant: "destructive",
          title: "Could not connect that account",
          description: error.message,
        }),
    },
  });

  const disconnect = useDisconnectCodex({
    mutation: {
      onSuccess: (result) => {
        setChecks(null);
        refresh();
        toast({
          title: "Codex account disconnected",
          description: result.detail,
        });
      },
      onError: (error) =>
        toast({
          variant: "destructive",
          title: "Could not disconnect",
          description: error.message,
        }),
    },
  });

  return (
    <div className="mt-4 border-t-2 border-border/30 pt-4 space-y-3">
      <div className="space-y-2">
        <label
          className="uppercase font-bold text-xs"
          htmlFor="codex-auth-json"
        >
          {connected
            ? "Replace your ChatGPT session"
            : "Connect your ChatGPT account"}
        </label>
        <p className="text-[10px] text-muted-foreground uppercase font-bold leading-relaxed">
          On a desktop, run <span className="text-foreground">codex login</span>{" "}
          and choose the ChatGPT sign-in, then paste the contents of{" "}
          <span className="text-foreground">~/.codex/auth.json</span> here. It
          is encrypted before it is stored and is never shown again.
        </p>
        <Textarea
          id="codex-auth-json"
          value={authJson}
          onChange={(event) => setAuthJson(event.target.value)}
          placeholder='{"auth_mode":"chatgpt", ...}'
          rows={3}
          spellCheck={false}
          autoComplete="off"
          className="font-mono text-[11px]"
          data-testid="input-codex-auth-json"
        />
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          onClick={() => {
            const pasted = authJson.trim();
            // Cleared as it leaves the browser, success or not — a session
            // token has no business sitting in a text box.
            setAuthJson("");
            connect.mutate({ data: { authJson: pasted } });
          }}
          disabled={connect.isPending || authJson.trim().length < 2}
          data-testid="button-connect-codex"
        >
          {connect.isPending ? "CONNECTING..." : "CONNECT ACCOUNT"}
        </Button>
        <Button
          variant="outline"
          onClick={() => test.mutate()}
          disabled={test.isPending}
          data-testid="button-test-codex"
        >
          {test.isPending ? "CHECKING..." : "TEST CONNECTION"}
        </Button>
        {connected ? (
          <Button
            variant="outline"
            onClick={() => disconnect.mutate()}
            disabled={disconnect.isPending}
            data-testid="button-disconnect-codex"
          >
            {disconnect.isPending ? "REMOVING..." : "DISCONNECT"}
          </Button>
        ) : null}
      </div>
      <p className="text-[10px] text-muted-foreground uppercase font-bold">
        The test runs locally only — it never calls OpenAI and never uses your
        allowance.
      </p>
      {checks ? (
        <ul className="space-y-1" data-testid="list-codex-checks">
          {checks.map((check) => (
            <li
              key={check.name}
              className="flex items-start gap-2 text-[11px] font-mono"
            >
              {check.ok ? (
                <CheckCircle className="w-3 h-3 mt-0.5 text-green-500 shrink-0" />
              ) : (
                <AlertTriangle className="w-3 h-3 mt-0.5 text-destructive shrink-0" />
              )}
              <span className="uppercase font-bold">{check.name}:</span>
              <span className="text-muted-foreground">{check.detail}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * Entering this workspace's own Claude Code setup token or OpenRouter API
 * key. The value is encrypted server-side, never echoed back, and the box
 * is cleared the moment it is sent — success or not.
 */
function ProviderCredentialActions({ provider }: { provider: ProviderStatus }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [credential, setCredential] = useState("");
  const providerId = provider.provider as "claude_max" | "openrouter";
  const isClaude = providerId === "claude_max";

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: getGetProvidersQueryKey() });

  const save = useSetProviderCredential({
    mutation: {
      onSuccess: (status) => {
        refresh();
        if (status.healthy) {
          toast({
            title: `${provider.label} is online`,
            description: status.message,
          });
        } else {
          toast({
            variant: "destructive",
            title: `${provider.label} credential saved, but the check failed`,
            description: status.message,
          });
        }
      },
      onError: (error) =>
        toast({
          variant: "destructive",
          title: "Could not save the credential",
          description: error.message,
        }),
    },
  });

  const remove = useDeleteProviderCredential({
    mutation: {
      onSuccess: () => {
        refresh();
        toast({ title: `${provider.label} credential removed` });
      },
      onError: (error) =>
        toast({
          variant: "destructive",
          title: "Could not remove the credential",
          description: error.message,
        }),
    },
  });

  return (
    <div className="mt-4 border-t-2 border-border/30 pt-4 space-y-3">
      <div className="space-y-2">
        <label
          className="uppercase font-bold text-xs"
          htmlFor={`credential-${providerId}`}
        >
          {provider.configured
            ? isClaude
              ? "Replace your setup token"
              : "Replace your API key"
            : isClaude
              ? "Connect with a setup token"
              : "Connect with an API key"}
        </label>
        <p className="text-[10px] text-muted-foreground uppercase font-bold leading-relaxed">
          {isClaude ? (
            <>
              On a machine where Claude Code is signed in, run{" "}
              <span className="text-foreground">claude setup-token</span> and
              paste the long-lived token it prints. It is encrypted before it
              is stored and is never shown again.
            </>
          ) : (
            <>
              Paste an API key from your own OpenRouter account. It is
              encrypted before it is stored and is never shown again.
            </>
          )}
        </p>
        <Input
          id={`credential-${providerId}`}
          type="password"
          value={credential}
          onChange={(event) => setCredential(event.target.value)}
          placeholder={isClaude ? "Claude Code setup token" : "OpenRouter API key"}
          spellCheck={false}
          autoComplete="off"
          className="font-mono bg-background border-4 border-border rounded-none focus-visible:ring-0 focus-visible:border-primary text-xs"
          data-testid={`input-credential-${providerId}`}
        />
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          onClick={() => {
            const pasted = credential.trim();
            // Cleared as it leaves the browser — a credential has no
            // business sitting in a text box.
            setCredential("");
            save.mutate({ provider: providerId, data: { credential: pasted } });
          }}
          disabled={save.isPending || credential.trim().length < 8}
          data-testid={`button-save-credential-${providerId}`}
        >
          {save.isPending ? "CHECKING..." : "SAVE & TEST"}
        </Button>
        {provider.configured ? (
          <Button
            variant="outline"
            onClick={() => remove.mutate({ provider: providerId })}
            disabled={remove.isPending}
            data-testid={`button-remove-credential-${providerId}`}
          >
            {remove.isPending ? "REMOVING..." : "REMOVE"}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/** Codex-only rows: what the credential actually bills, and what we cannot know. */
function CodexStatusRows({ provider }: { provider: ProviderStatus }) {
  const apiBilled = provider.authMode === "api_key";
  return (
    <>
      <div className="flex justify-between items-center">
        <span className="text-xs font-bold uppercase text-muted-foreground">
          Billing Source
        </span>
        <span
          className={`text-xs font-bold uppercase ${apiBilled ? "text-destructive" : "text-muted-foreground"}`}
          data-testid="text-codex-billing-source"
        >
          {provider.usesSubscriptionAllowance
            ? "Uses ChatGPT Codex allowance"
            : apiBilled
              ? "API key billing — NOT your ChatGPT plan"
              : "Unconfirmed"}
        </span>
      </div>
      <div className="flex justify-between items-center">
        <span className="text-xs font-bold uppercase text-muted-foreground">
          Remaining Allowance
        </span>
        <span className="text-xs font-bold uppercase text-muted-foreground">
          {provider.allowanceBalanceKnown ? "See status" : "Not reported"}
        </span>
      </div>
      {!provider.allowanceBalanceKnown ? (
        <p className="text-[10px] text-muted-foreground uppercase font-bold">
          OpenAI does not expose a remaining balance, so none is shown here.
          Check it on the{" "}
          <a
            href="https://chatgpt.com/codex/settings/usage"
            target="_blank"
            rel="noreferrer"
            className="underline"
            data-testid="link-codex-usage-dashboard"
          >
            official Codex usage dashboard
          </a>
          .
        </p>
      ) : null}
      {apiBilled ? (
        <div className="p-2 text-xs font-mono bg-destructive/10 border-l-4 border-destructive text-destructive">
          The stored credential authenticates with an API key, so runs are
          billed by OpenAI rather than covered by your ChatGPT plan. Run `codex
          login` and choose the ChatGPT sign-in to switch.
        </div>
      ) : null}
    </>
  );
}

export default function ProvidersPage() {
  const { data: providers, isLoading } = useGetProviders();

  return (
    <Shell>
      <div className="p-4 sm:p-6 lg:p-8 max-w-5xl mx-auto space-y-6 sm:space-y-8">
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-4 border-b-4 border-border pb-6">
          <div>
            <h1 className="font-display text-lg sm:text-2xl text-foreground uppercase mb-2">
              Network Infrastructure
            </h1>
            <p className="text-muted-foreground text-sm">
              LLM Provider connection status and configuration.
            </p>
          </div>
        </div>

        {isLoading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {[1, 2].map((i) => (
              <PixelCard key={i} className="animate-pulse h-48 bg-muted/50">
                <div className="w-full h-full"></div>
              </PixelCard>
            ))}
          </div>
        ) : !providers || providers.length === 0 ? (
          <PixelCard className="text-center p-6 sm:p-12" variant="destructive">
            <Network className="w-12 h-12 text-destructive mx-auto mb-4" />
            <h3 className="font-display text-lg uppercase mb-2">
              Network Disconnected
            </h3>
            <p className="text-muted-foreground">
              Unable to fetch provider status from the mainframe.
            </p>
          </PixelCard>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {providers
              .filter((provider) => provider.enabled)
              .map((provider) => {
                const isReady = provider.configured && provider.healthy;
                const isCodex = provider.provider === "codex_chatgpt";

                return (
                  <PixelCard
                    key={provider.provider}
                    variant={isReady ? "default" : "destructive"}
                    className="flex flex-col h-full"
                  >
                    <div className="flex justify-between items-start mb-6">
                      <div className="flex items-center gap-3">
                        <div
                          className={`p-2 border-2 border-border pixel-shadow ${isReady ? "bg-primary/20 text-primary" : "bg-muted text-muted-foreground"}`}
                        >
                          <Server className="w-6 h-6" />
                        </div>
                        <div>
                          <h3
                            className="font-display text-lg uppercase"
                            data-testid={`text-provider-${provider.provider}`}
                          >
                            {provider.label}
                          </h3>
                          <Badge variant="outline" className="mt-1">
                            {provider.billing === "subscription"
                              ? "SUBSCRIPTION"
                              : "PAY PER TOKEN"}
                          </Badge>
                        </div>
                      </div>
                      <Badge variant={isReady ? "success" : "destructive"}>
                        {isReady ? "ONLINE" : "OFFLINE"}
                      </Badge>
                    </div>

                    <div className="space-y-4 flex-1 bg-muted/30 p-4 border-2 border-border/50">
                      <div className="flex justify-between items-center">
                        <span className="text-xs font-bold uppercase text-muted-foreground">
                          Configuration
                        </span>
                        {provider.configured ? (
                          <span className="flex items-center text-green-500 text-xs font-bold uppercase">
                            <CheckCircle className="w-3 h-3 mr-1" /> Valid
                          </span>
                        ) : (
                          <span className="flex items-center text-destructive text-xs font-bold uppercase">
                            <AlertTriangle className="w-3 h-3 mr-1" />
                            {isCodex ? "Not signed in" : "Missing API Key"}
                          </span>
                        )}
                      </div>

                      <div className="flex justify-between items-center">
                        <span className="text-xs font-bold uppercase text-muted-foreground">
                          Endpoint Health
                        </span>
                        {provider.healthy ? (
                          <span className="flex items-center text-green-500 text-xs font-bold uppercase">
                            <CheckCircle className="w-3 h-3 mr-1" /> Reachable
                          </span>
                        ) : (
                          <span className="flex items-center text-destructive text-xs font-bold uppercase">
                            <AlertTriangle className="w-3 h-3 mr-1" />{" "}
                            Unreachable
                          </span>
                        )}
                      </div>

                      {isCodex ? <CodexStatusRows provider={provider} /> : null}

                      {provider.message && (
                        <div
                          className={`mt-4 p-2 text-xs font-mono ${isReady ? "bg-muted/50 border-l-4 border-border text-muted-foreground" : "bg-destructive/10 border-l-4 border-destructive text-destructive"}`}
                        >
                          {provider.message}
                        </div>
                      )}
                    </div>

                    {isCodex ? (
                      <CodexActions provider={provider} />
                    ) : (
                      <ProviderCredentialActions provider={provider} />
                    )}
                  </PixelCard>
                );
              })}
          </div>
        )}

        <RoutingDefaultsCard />
      </div>
    </Shell>
  );
}
