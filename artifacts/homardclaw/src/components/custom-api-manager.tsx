import React from "react";
import {
  useListCustomApis,
  useCreateCustomApi,
  useUpdateCustomApi,
  useDeleteCustomApi,
  useRotateCustomApiCredential,
  useValidateCustomApi,
  useParseCustomApiSpec,
  getListCustomApisQueryKey,
  type CustomApi,
  type CustomApiOperation,
  type CustomApiParam,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { PixelCard } from "@/components/ui/pixel-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { Globe2, Plus, Trash2 } from "lucide-react";

/* ------------------------------------------------------------------ */
/* Shared bits                                                         */
/* ------------------------------------------------------------------ */

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
const inputClass =
  "h-9 w-full border-2 border-border bg-background px-2 font-mono text-xs";
const selectClass =
  "h-9 border-2 border-border bg-background px-1 font-mono text-xs";
const labelClass =
  "block text-[10px] uppercase font-bold text-muted-foreground mb-1";

function ValidationBadge({ api }: { api: CustomApi }) {
  if (!api.enabled) return <Badge variant="destructive">Disabled</Badge>;
  if (api.validationStatus === "ok")
    return <Badge variant="success">Reachable</Badge>;
  if (api.validationStatus === "failed")
    return <Badge variant="destructive">Check Failed</Badge>;
  return <Badge variant="warning">Unchecked</Badge>;
}

function levelBadgeText(op: CustomApiOperation): string {
  return `${op.method} ${op.path} · ${op.level}${op.level === "write" ? " · approval" : ""}`;
}

/* ------------------------------------------------------------------ */
/* Add / edit form                                                     */
/* ------------------------------------------------------------------ */

type ParamDraft = {
  name: string;
  in: "path" | "query" | "body";
  kind: "string" | "number";
  required: boolean;
  maxLength: string;
  multiline: boolean;
  description: string;
};

type OpDraft = {
  id: string;
  method: (typeof METHODS)[number];
  path: string;
  description: string;
  level: "read" | "draft" | "write";
  params: ParamDraft[];
};

type FormDraft = {
  slug: string;
  displayName: string;
  description: string;
  baseUrl: string;
  authType: "none" | "api_key" | "bearer";
  authHeaderName: string;
  credential: string;
  operations: OpDraft[];
};

function toParamDraft(param: CustomApiParam): ParamDraft {
  return {
    name: param.name,
    in: param.in,
    kind: param.kind,
    required: param.required,
    maxLength:
      param.maxLength === null || param.maxLength === undefined
        ? ""
        : String(param.maxLength),
    multiline: param.multiline === true,
    description: param.description ?? "",
  };
}

function toOpDraft(op: CustomApiOperation): OpDraft {
  return {
    id: op.id,
    method: op.method,
    path: op.path,
    description: op.description,
    level: op.level,
    params: op.params.map(toParamDraft),
  };
}

/** The wire shape the API expects; the server re-validates everything. */
function opPayload(op: OpDraft): CustomApiOperation {
  return {
    id: op.id.trim(),
    method: op.method,
    path: op.path.trim(),
    description: op.description.trim(),
    level: op.method === "GET" ? "read" : op.level === "read" ? "draft" : op.level,
    params: op.params.map((param) => ({
      name: param.name.trim(),
      in: param.in,
      kind: param.kind,
      required: param.in === "path" ? true : param.required,
      maxLength:
        param.maxLength.trim() === "" ? null : Number(param.maxLength.trim()),
      multiline: param.in === "body" ? param.multiline : null,
      description:
        param.description.trim() === "" ? null : param.description.trim(),
    })),
  };
}

function emptyDraft(): FormDraft {
  return {
    slug: "",
    displayName: "",
    description: "",
    baseUrl: "",
    authType: "none",
    authHeaderName: "",
    credential: "",
    operations: [],
  };
}

function draftFromApi(api: CustomApi): FormDraft {
  return {
    slug: api.slug,
    displayName: api.displayName,
    description: api.description,
    baseUrl: api.baseUrl,
    authType: api.authType,
    authHeaderName: api.authHeaderName ?? "",
    credential: "",
    operations: api.operations.map(toOpDraft),
  };
}

function slugFromName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/^([0-9])/, "api_$1")
    .slice(0, 40);
}

function OperationEditor({
  op,
  onChange,
  onRemove,
}: {
  op: OpDraft;
  onChange: (patch: Partial<OpDraft>) => void;
  onRemove: () => void;
}) {
  const isGet = op.method === "GET";
  const updateParam = (index: number, patch: Partial<ParamDraft>) => {
    onChange({
      params: op.params.map((param, i) =>
        i === index ? { ...param, ...patch } : param,
      ),
    });
  };
  return (
    <div className="border-2 border-border/60 bg-background/60 p-3 space-y-2">
      <div className="flex flex-wrap gap-2 items-end">
        <div>
          <label className={labelClass}>Method</label>
          <select
            className={selectClass}
            value={op.method}
            onChange={(event) => {
              const method = event.target.value as OpDraft["method"];
              onChange({
                method,
                level:
                  method === "GET"
                    ? "read"
                    : op.level === "read"
                      ? "draft"
                      : op.level,
              });
            }}
          >
            {METHODS.map((method) => (
              <option key={method} value={method}>
                {method}
              </option>
            ))}
          </select>
        </div>
        <div className="flex-1 min-w-[180px]">
          <label className={labelClass}>Path (use {"{param}"} for path parameters)</label>
          <input
            className={inputClass}
            value={op.path}
            placeholder="/v1/things/{id}"
            onChange={(event) => onChange({ path: event.target.value })}
          />
        </div>
        <div>
          <label className={labelClass}>Access level</label>
          <select
            className={selectClass}
            value={isGet ? "read" : op.level}
            disabled={isGet}
            onChange={(event) =>
              onChange({ level: event.target.value as OpDraft["level"] })
            }
          >
            {isGet ? (
              <option value="read">read</option>
            ) : (
              <>
                <option value="draft">draft</option>
                <option value="write">write (approval)</option>
              </>
            )}
          </select>
        </div>
        <Button variant="outline" size="sm" onClick={onRemove}>
          <Trash2 className="w-3 h-3" />
        </Button>
      </div>
      <div className="flex flex-wrap gap-2">
        <div className="flex-1 min-w-[140px]">
          <label className={labelClass}>Operation id</label>
          <input
            className={inputClass}
            value={op.id}
            placeholder="list_things"
            onChange={(event) => onChange({ id: event.target.value })}
          />
        </div>
        <div className="flex-[2] min-w-[200px]">
          <label className={labelClass}>What it does (shown to Crustabots)</label>
          <input
            className={inputClass}
            value={op.description}
            placeholder="List the newest things"
            onChange={(event) => onChange({ description: event.target.value })}
          />
        </div>
      </div>
      <div className="space-y-1">
        {op.params.map((param, index) => (
          <div
            key={index}
            className="flex flex-wrap gap-2 items-center border-2 border-border/40 p-2"
          >
            <input
              className={`${inputClass} !w-32`}
              value={param.name}
              placeholder="param name"
              onChange={(event) => updateParam(index, { name: event.target.value })}
            />
            <select
              className={selectClass}
              value={param.in}
              onChange={(event) =>
                updateParam(index, {
                  in: event.target.value as ParamDraft["in"],
                })
              }
            >
              <option value="path">path</option>
              <option value="query">query</option>
              {op.method !== "GET" && op.method !== "DELETE" ? (
                <option value="body">body</option>
              ) : null}
            </select>
            <select
              className={selectClass}
              value={param.kind}
              onChange={(event) =>
                updateParam(index, {
                  kind: event.target.value as ParamDraft["kind"],
                })
              }
            >
              <option value="string">string</option>
              <option value="number">number</option>
            </select>
            <label className="text-[10px] uppercase font-bold flex items-center gap-1">
              <input
                type="checkbox"
                checked={param.in === "path" ? true : param.required}
                disabled={param.in === "path"}
                onChange={(event) =>
                  updateParam(index, { required: event.target.checked })
                }
              />
              required
            </label>
            <input
              className={`${inputClass} !w-24`}
              value={param.maxLength}
              placeholder="max len"
              onChange={(event) =>
                updateParam(index, { maxLength: event.target.value })
              }
            />
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                onChange({ params: op.params.filter((_, i) => i !== index) })
              }
            >
              <Trash2 className="w-3 h-3" />
            </Button>
          </div>
        ))}
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            onChange({
              params: [
                ...op.params,
                {
                  name: "",
                  in: "query",
                  kind: "string",
                  required: false,
                  maxLength: "",
                  multiline: false,
                  description: "",
                },
              ],
            })
          }
        >
          <Plus className="w-3 h-3 mr-1" /> PARAMETER
        </Button>
      </div>
    </div>
  );
}

function CustomApiForm({
  existing,
  onDone,
}: {
  existing: CustomApi | null;
  onDone: () => void;
}) {
  const [draft, setDraft] = React.useState<FormDraft>(() =>
    existing ? draftFromApi(existing) : emptyDraft(),
  );
  const [specText, setSpecText] = React.useState("");
  const [importWarnings, setImportWarnings] = React.useState<string[]>([]);
  const [slugTouched, setSlugTouched] = React.useState(existing !== null);
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: getListCustomApisQueryKey() });
  const onError = (error: Error) =>
    toast({
      variant: "destructive",
      title: "Could not save the custom API",
      description: error.message,
    });

  const create = useCreateCustomApi({
    mutation: {
      onSuccess: () => {
        refresh();
        toast({
          title: "Custom API added",
          description:
            "Crustabots have no access yet — grant it per Crustabot on their personnel files.",
        });
        onDone();
      },
      onError,
    },
  });
  const update = useUpdateCustomApi({
    mutation: {
      onSuccess: () => {
        refresh();
        toast({
          title: "Custom API updated",
          description:
            "If the definition changed, pending approvals for it were invalidated.",
        });
        onDone();
      },
      onError,
    },
  });
  const parseSpec = useParseCustomApiSpec({
    mutation: {
      onSuccess: (data) => {
        setDraft((prev) => ({
          ...prev,
          displayName: prev.displayName || (data.suggestedName ?? ""),
          baseUrl: prev.baseUrl || (data.suggestedBaseUrl ?? ""),
          operations: data.operations.map(toOpDraft),
        }));
        setImportWarnings(data.warnings);
        toast({
          title: `Imported ${data.operations.length} operation${data.operations.length === 1 ? "" : "s"}`,
          description:
            "Review each one below — only what you save can ever be called.",
        });
      },
      onError: (error) =>
        toast({
          variant: "destructive",
          title: "Import failed",
          description: error.message,
        }),
    },
  });

  const saving = create.isPending || update.isPending;
  const save = () => {
    const operations = draft.operations.map(opPayload);
    const common = {
      displayName: draft.displayName.trim(),
      description: draft.description.trim() || null,
      baseUrl: draft.baseUrl.trim(),
      authType: draft.authType,
      authHeaderName:
        draft.authType === "api_key" ? draft.authHeaderName.trim() || null : null,
      credential: draft.credential === "" ? null : draft.credential,
      operations,
    };
    if (existing) {
      update.mutate({
        id: existing.id,
        data: { ...common, description: common.description ?? undefined },
      });
    } else {
      create.mutate({ data: { ...common, slug: draft.slug.trim() } });
    }
  };

  return (
    <PixelCard>
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <span className="font-display uppercase text-sm">
            {existing ? `Edit ${existing.displayName}` : "Add Custom API"}
          </span>
          {existing ? (
            <p className="text-[10px] text-warning uppercase font-bold">
              Changing the definition invalidates pending approvals for it.
            </p>
          ) : null}
        </div>

        <div className="grid sm:grid-cols-2 gap-3">
          <div>
            <label className={labelClass}>Name</label>
            <input
              className={inputClass}
              value={draft.displayName}
              placeholder="Weather Service"
              onChange={(event) => {
                const displayName = event.target.value;
                setDraft((prev) => ({
                  ...prev,
                  displayName,
                  slug:
                    existing || slugTouched
                      ? prev.slug
                      : slugFromName(displayName),
                }));
              }}
            />
          </div>
          <div>
            <label className={labelClass}>
              Identifier {existing ? "(fixed)" : "(a-z, 0-9, _)"}
            </label>
            <input
              className={inputClass}
              value={draft.slug}
              disabled={existing !== null}
              placeholder="weather_service"
              onChange={(event) => {
                setSlugTouched(true);
                setDraft((prev) => ({ ...prev, slug: event.target.value }));
              }}
            />
          </div>
          <div className="sm:col-span-2">
            <label className={labelClass}>
              Base URL (HTTPS, public host — calls can never leave it)
            </label>
            <input
              className={inputClass}
              value={draft.baseUrl}
              placeholder="https://api.example.com/v2"
              onChange={(event) =>
                setDraft((prev) => ({ ...prev, baseUrl: event.target.value }))
              }
            />
          </div>
          <div className="sm:col-span-2">
            <label className={labelClass}>Description (optional)</label>
            <input
              className={inputClass}
              value={draft.description}
              placeholder="What this API is for"
              onChange={(event) =>
                setDraft((prev) => ({
                  ...prev,
                  description: event.target.value,
                }))
              }
            />
          </div>
        </div>

        <div className="grid sm:grid-cols-3 gap-3">
          <div>
            <label className={labelClass}>Authentication</label>
            <select
              className={`${selectClass} w-full h-9`}
              value={draft.authType}
              onChange={(event) =>
                setDraft((prev) => ({
                  ...prev,
                  authType: event.target.value as FormDraft["authType"],
                }))
              }
            >
              <option value="none">None (public API)</option>
              <option value="api_key">API key header</option>
              <option value="bearer">Bearer token</option>
            </select>
          </div>
          {draft.authType === "api_key" ? (
            <div>
              <label className={labelClass}>Header name</label>
              <input
                className={inputClass}
                value={draft.authHeaderName}
                placeholder="X-Api-Key"
                onChange={(event) =>
                  setDraft((prev) => ({
                    ...prev,
                    authHeaderName: event.target.value,
                  }))
                }
              />
            </div>
          ) : null}
          {draft.authType !== "none" ? (
            <div>
              <label className={labelClass}>
                {existing?.hasCredential
                  ? "Credential (blank = keep current)"
                  : "Credential"}
              </label>
              <input
                className={inputClass}
                type="password"
                value={draft.credential}
                autoComplete="off"
                placeholder={existing?.hasCredential ? "••••••••" : "secret value"}
                onChange={(event) =>
                  setDraft((prev) => ({
                    ...prev,
                    credential: event.target.value,
                  }))
                }
              />
            </div>
          ) : null}
        </div>

        <div className="border-2 border-border/50 bg-muted/20 p-3 space-y-2">
          <p className="text-[10px] uppercase font-bold text-muted-foreground">
            Optional: import operations from an OpenAPI 3 document (JSON).
            Nothing is saved until you review and save the form.
          </p>
          <textarea
            className="w-full h-24 border-2 border-border bg-background p-2 font-mono text-[10px]"
            value={specText}
            placeholder='{"openapi":"3.0.0", ...}'
            onChange={(event) => setSpecText(event.target.value)}
          />
          <Button
            variant="outline"
            size="sm"
            disabled={parseSpec.isPending || specText.trim() === ""}
            onClick={() => parseSpec.mutate({ data: { document: specText } })}
          >
            {parseSpec.isPending ? "..." : "IMPORT OPERATIONS"}
          </Button>
          {importWarnings.map((warning) => (
            <p key={warning} className="text-[10px] text-warning font-mono">
              {warning}
            </p>
          ))}
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="uppercase font-bold text-xs">
              Allowed operations ({draft.operations.length})
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                setDraft((prev) => ({
                  ...prev,
                  operations: [
                    ...prev.operations,
                    {
                      id: "",
                      method: "GET",
                      path: "",
                      description: "",
                      level: "read",
                      params: [],
                    },
                  ],
                }))
              }
            >
              <Plus className="w-3 h-3 mr-1" /> OPERATION
            </Button>
          </div>
          <p className="text-[10px] text-muted-foreground uppercase font-bold">
            Crustabots can call exactly these — nothing else. GET is always
            read; write operations wait for your approval every time.
          </p>
          {draft.operations.map((op, index) => (
            <OperationEditor
              key={index}
              op={op}
              onChange={(patch) =>
                setDraft((prev) => ({
                  ...prev,
                  operations: prev.operations.map((current, i) =>
                    i === index ? { ...current, ...patch } : current,
                  ),
                }))
              }
              onRemove={() =>
                setDraft((prev) => ({
                  ...prev,
                  operations: prev.operations.filter((_, i) => i !== index),
                }))
              }
            />
          ))}
        </div>

        <div className="flex gap-2 justify-end">
          <Button variant="outline" size="sm" onClick={onDone} disabled={saving}>
            CANCEL
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={saving || draft.operations.length === 0}
            onClick={save}
          >
            {saving ? "..." : existing ? "SAVE CHANGES" : "ADD CUSTOM API"}
          </Button>
        </div>
      </div>
    </PixelCard>
  );
}

/* ------------------------------------------------------------------ */
/* Card + section                                                      */
/* ------------------------------------------------------------------ */

function CustomApiCard({
  api,
  onEdit,
}: {
  api: CustomApi;
  onEdit: () => void;
}) {
  const [rotating, setRotating] = React.useState(false);
  const [newCredential, setNewCredential] = React.useState("");
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: getListCustomApisQueryKey() });
  const onError = (error: Error) =>
    toast({
      variant: "destructive",
      title: "Change failed",
      description: error.message,
    });
  const update = useUpdateCustomApi({
    mutation: { onSuccess: refresh, onError },
  });
  const remove = useDeleteCustomApi({
    mutation: {
      onSuccess: () => {
        refresh();
        toast({
          title: `${api.displayName} removed`,
          description:
            "All Crustabot grants for it were revoked and pending approvals invalidated.",
        });
      },
      onError,
    },
  });
  const rotate = useRotateCustomApiCredential({
    mutation: {
      onSuccess: () => {
        refresh();
        setRotating(false);
        setNewCredential("");
        toast({
          title: "Credential rotated",
          description: "The new secret takes effect on the very next call.",
        });
      },
      onError,
    },
  });
  const validate = useValidateCustomApi({
    mutation: {
      onSuccess: (data) => {
        refresh();
        toast({
          variant: data.status === "ok" ? "default" : "destructive",
          title: data.status === "ok" ? "API reachable" : "Check failed",
          description: data.detail ?? undefined,
        });
      },
      onError,
    },
  });

  return (
    <PixelCard>
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3 sm:gap-4">
        <div className="flex items-start gap-3 min-w-0">
          <div className="border-4 border-border bg-muted/30 p-2 shrink-0">
            <Globe2 className="w-6 h-6" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-display uppercase text-sm">
                {api.displayName}
              </span>
              <ValidationBadge api={api} />
              <Badge variant="outline">Custom API</Badge>
            </div>
            <p className="text-[10px] text-muted-foreground font-mono mt-1 break-all">
              {api.baseUrl}
            </p>
            <p className="text-[10px] text-muted-foreground uppercase font-bold mt-1">
              {api.authType === "none"
                ? "No authentication"
                : api.authType === "bearer"
                  ? `Bearer token ${api.hasCredential ? "saved" : "MISSING"}`
                  : `API key (${api.authHeaderName ?? "header"}) ${api.hasCredential ? "saved" : "MISSING"}`}
              {" · "}
              {api.grantedAgents === 0
                ? "no Crustabots have access"
                : `${api.grantedAgents} Crustabot${api.grantedAgents === 1 ? "" : "s"} with access`}
            </p>
            {api.validationDetail ? (
              <p className="text-[10px] text-muted-foreground font-mono mt-1 break-words">
                {api.validationDetail}
              </p>
            ) : null}
            <div className="mt-2 flex flex-wrap gap-1">
              {api.operations.map((op) => (
                <span
                  key={op.id}
                  className="text-[9px] font-mono border-2 border-border/50 px-1 py-0.5 uppercase"
                  title={op.description}
                >
                  {levelBadgeText(op)}
                </span>
              ))}
            </div>
            {rotating ? (
              <div className="mt-2 flex gap-2 items-center flex-wrap">
                <input
                  className={`${inputClass} !w-56`}
                  type="password"
                  autoComplete="off"
                  placeholder="new secret value"
                  value={newCredential}
                  onChange={(event) => setNewCredential(event.target.value)}
                />
                <Button
                  variant="primary"
                  size="sm"
                  disabled={rotate.isPending || newCredential === ""}
                  onClick={() =>
                    rotate.mutate({
                      id: api.id,
                      data: { credential: newCredential },
                    })
                  }
                >
                  {rotate.isPending ? "..." : "SAVE SECRET"}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setRotating(false);
                    setNewCredential("");
                  }}
                >
                  CANCEL
                </Button>
              </div>
            ) : null}
          </div>
        </div>
        <div className="flex gap-2 shrink-0 flex-wrap items-start">
          <Button variant="outline" size="sm" onClick={onEdit}>
            EDIT
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={validate.isPending}
            onClick={() => validate.mutate({ id: api.id })}
          >
            {validate.isPending ? "..." : "CHECK"}
          </Button>
          {api.authType !== "none" && !rotating ? (
            <Button variant="outline" size="sm" onClick={() => setRotating(true)}>
              ROTATE SECRET
            </Button>
          ) : null}
          <Button
            variant={api.enabled ? "outline" : "primary"}
            size="sm"
            disabled={update.isPending}
            onClick={() => {
              if (
                api.enabled &&
                !window.confirm(
                  `Disable ${api.displayName}? Crustabots immediately lose access, and pending approvals for it are invalidated.`,
                )
              ) {
                return;
              }
              update.mutate({ id: api.id, data: { enabled: !api.enabled } });
            }}
          >
            {update.isPending ? "..." : api.enabled ? "DISABLE" : "ENABLE"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={remove.isPending}
            onClick={() => {
              if (
                window.confirm(
                  `Remove ${api.displayName}? The saved credential is deleted, every Crustabot grant is revoked, and pending approvals are invalidated. This cannot be undone.`,
                )
              ) {
                remove.mutate({ id: api.id });
              }
            }}
          >
            {remove.isPending ? "..." : "REMOVE"}
          </Button>
        </div>
      </div>
    </PixelCard>
  );
}

/**
 * Owner-whitelisted third-party REST APIs: add, review, and manage the
 * exact operations Crustabots may call. Secrets are write-only — the server
 * never sends a saved credential back.
 */
export function CustomApiSection() {
  const { data, isLoading } = useListCustomApis();
  const [formOpen, setFormOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<CustomApi | null>(null);
  const apis = data?.apis ?? [];
  return (
    <>
      <div className="border-b-4 border-border pb-4 pt-2 flex items-end justify-between gap-3 flex-wrap">
        <div>
          <h2 className="font-display text-base sm:text-xl text-foreground uppercase mb-1">
            Custom APIs
          </h2>
          <p className="text-muted-foreground text-sm">
            Whitelist any public HTTPS API and define exactly which endpoints
            Crustabots may call. They see only the operations you approve —
            never your credentials — and every write still waits for your
            approval.
          </p>
        </div>
        {!formOpen ? (
          <Button
            variant="primary"
            size="sm"
            onClick={() => {
              setEditing(null);
              setFormOpen(true);
            }}
          >
            <Plus className="w-3 h-3 mr-1" /> ADD CUSTOM API
          </Button>
        ) : null}
      </div>
      {formOpen ? (
        <CustomApiForm
          existing={editing}
          onDone={() => {
            setFormOpen(false);
            setEditing(null);
          }}
        />
      ) : null}
      {isLoading ? (
        <PixelCard className="animate-pulse h-24 bg-muted/50">
          <div className="w-full h-full"></div>
        </PixelCard>
      ) : apis.length === 0 && !formOpen ? (
        <PixelCard className="text-center p-6">
          <p className="text-muted-foreground text-sm">
            No custom APIs yet. Add one to let Crustabots use a service that
            isn&apos;t in the built-in catalog — on exactly your terms.
          </p>
        </PixelCard>
      ) : (
        <div className="space-y-4">
          {apis.map((api) => (
            <CustomApiCard
              key={api.id}
              api={api}
              onEdit={() => {
                setEditing(api);
                setFormOpen(true);
              }}
            />
          ))}
        </div>
      )}
    </>
  );
}
