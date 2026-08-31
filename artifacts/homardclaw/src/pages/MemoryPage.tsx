import React, { useMemo, useRef, useState } from "react";
import {
  useListMemories,
  useCreateMemory,
  useUpdateMemory,
  useDeleteMemory,
  useClearMemories,
  useListAgents,
  useListKnowledgeFiles,
  useUploadKnowledgeFile,
  useDeleteKnowledgeFile,
  useSetKnowledgeAssignments,
  useListWorkspaceSkills,
  useCreateWorkspaceSkill,
  useUpdateWorkspaceSkill,
  useDeleteWorkspaceSkill,
  useGetMemorySettings,
  useUpdateMemorySettings,
  useRefreshAgentMemory,
  exportMemories,
  getListMemoriesQueryKey,
  getListKnowledgeFilesQueryKey,
  getListWorkspaceSkillsQueryKey,
  getGetMemorySettingsQueryKey,
  MemoryInputKind,
  type Memory,
  type KnowledgeFile,
  type WorkspaceSkill,
} from "@workspace/api-client-react";
import { Shell } from "@/components/layout/Shell";
import { PixelCard } from "@/components/ui/pixel-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Brain,
  Pin,
  PinOff,
  EyeOff,
  Eye,
  Trash2,
  Pencil,
  Download,
  Upload,
  FileText,
  Search,
  Plus,
  Users,
  Sparkles,
  Wrench,
  RefreshCw,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";

const selectTriggerClass =
  "bg-background border-4 border-border rounded-none focus:ring-0 focus:border-primary font-mono text-sm uppercase";
const selectContentClass =
  "border-4 border-border rounded-none bg-card max-h-72";
const selectItemClass =
  "font-mono text-xs uppercase focus:bg-primary focus:text-primary-foreground";
const inputClass =
  "bg-background border-4 border-border rounded-none focus-visible:ring-0 focus-visible:border-primary font-mono text-sm";

const ALL_SENTINEL = "__all__";
const SHARED_SENTINEL = "shared";
const UNASSIGNED_SENTINEL = "__unassigned__";

const KIND_STYLES: Record<string, string> = {
  fact: "bg-accent/20 text-accent border-accent",
  decision: "bg-primary/20 text-primary border-primary",
  context: "bg-secondary/40 text-secondary-foreground border-border",
  task_outcome: "bg-muted text-muted-foreground border-border",
  relationship: "bg-destructive/10 text-destructive border-destructive/60",
};

const MEMORY_KINDS = Object.values(MemoryInputKind);

/** Read a File as text, rejecting anything that looks binary. */
async function readTextFile(file: File): Promise<string> {
  const text = await file.text();
  if (text.includes("\u0000")) {
    throw new Error(
      `"${file.name}" looks binary; only text files are supported.`,
    );
  }
  return text;
}

function apiErrorMessage(error: unknown, fallback: string): string {
  const data = (error as { response?: { data?: { error?: string } } })?.response
    ?.data;
  return data?.error ?? fallback;
}

function MemoryEditorDialog({
  memory,
  agents,
  open,
  onOpenChange,
}: {
  memory: Memory | null;
  agents: { id: string; name: string }[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const createMemory = useCreateMemory();
  const updateMemory = useUpdateMemory();
  const [content, setContent] = useState("");
  const [kind, setKind] = useState<string>("fact");
  const [agentId, setAgentId] = useState<string>(SHARED_SENTINEL);
  const [pinned, setPinned] = useState(false);

  // Reset form state each time the dialog opens for a different target.
  const openedFor = useRef<string | null>(null);
  if (open && openedFor.current !== (memory?.id ?? "new")) {
    openedFor.current = memory?.id ?? "new";
    setContent(memory?.content ?? "");
    setKind(memory?.kind ?? "fact");
    setAgentId(memory?.agentId ?? SHARED_SENTINEL);
    setPinned(memory?.pinned ?? false);
  }
  if (!open && openedFor.current !== null) openedFor.current = null;

  const busy = createMemory.isPending || updateMemory.isPending;

  const save = async () => {
    const data = {
      content: content.trim(),
      kind: kind as (typeof MEMORY_KINDS)[number],
      agentId: agentId === SHARED_SENTINEL ? null : agentId,
      pinned,
    };
    try {
      if (memory) {
        await updateMemory.mutateAsync({ memoryId: memory.id, data });
      } else {
        await createMemory.mutateAsync({ data });
      }
      await queryClient.invalidateQueries({
        queryKey: getListMemoriesQueryKey(),
      });
      onOpenChange(false);
      toast({ title: memory ? "Memory updated" : "Memory saved" });
    } catch (error) {
      toast({
        title: "Could not save memory",
        description: apiErrorMessage(error, "Try again."),
        variant: "destructive",
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-card border-4 border-border rounded-none max-w-lg">
        <DialogTitle className="font-display text-sm text-primary uppercase">
          {memory ? "Edit Memory" : "New Memory"}
        </DialogTitle>
        <div className="space-y-4">
          <div>
            <label className="text-[10px] font-bold uppercase text-muted-foreground">
              Memory
            </label>
            <Textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              maxLength={4000}
              rows={5}
              placeholder="A fact, decision, or context the Crustabots should remember..."
              className={inputClass}
              data-testid="input-memory-content"
            />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="text-[10px] font-bold uppercase text-muted-foreground">
                Kind
              </label>
              <Select value={kind} onValueChange={setKind}>
                <SelectTrigger
                  className={selectTriggerClass}
                  data-testid="select-memory-kind"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className={selectContentClass}>
                  {MEMORY_KINDS.map((k) => (
                    <SelectItem key={k} value={k} className={selectItemClass}>
                      {k.replace("_", " ")}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-[10px] font-bold uppercase text-muted-foreground">
                Belongs To
              </label>
              <Select value={agentId} onValueChange={setAgentId}>
                <SelectTrigger
                  className={selectTriggerClass}
                  data-testid="select-memory-agent"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className={selectContentClass}>
                  <SelectItem
                    value={SHARED_SENTINEL}
                    className={selectItemClass}
                  >
                    Shared (all Crustabots)
                  </SelectItem>
                  {agents.map((agent) => (
                    <SelectItem
                      key={agent.id}
                      value={agent.id}
                      className={selectItemClass}
                    >
                      {agent.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <label className="flex items-center gap-2 text-xs font-bold uppercase cursor-pointer">
            <input
              type="checkbox"
              checked={pinned}
              onChange={(e) => setPinned(e.target.checked)}
              className="w-4 h-4 accent-[hsl(13,90%,55%)]"
              data-testid="checkbox-memory-pinned"
            />
            <Pin className="w-3 h-3" /> Always include in prompts
          </label>
          <Button
            onClick={save}
            disabled={busy || content.trim().length < 3}
            className="w-full bg-primary text-primary-foreground font-bold uppercase rounded-none pixel-shadow"
            data-testid="button-save-memory"
          >
            {busy ? "Saving..." : memory ? "Save Changes" : "Save Memory"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function MemoriesTab({ agents }: { agents: { id: string; name: string }[] }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [agentFilter, setAgentFilter] = useState<string>(ALL_SENTINEL);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<Memory | null>(null);

  const params = {
    ...(agentFilter !== ALL_SENTINEL ? { agentId: agentFilter } : {}),
    ...(search.trim() ? { q: search.trim() } : {}),
  };
  const { data, isLoading } = useListMemories(params);
  const updateMemory = useUpdateMemory();
  const deleteMemory = useDeleteMemory();
  const clearMemories = useClearMemories();

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: getListMemoriesQueryKey() });

  const toggle = async (
    memory: Memory,
    patch: { pinned?: boolean; disabled?: boolean },
  ) => {
    try {
      await updateMemory.mutateAsync({ memoryId: memory.id, data: patch });
      await invalidate();
    } catch (error) {
      toast({
        title: "Update failed",
        description: apiErrorMessage(error, "Try again."),
        variant: "destructive",
      });
    }
  };

  const remove = async (memory: Memory) => {
    if (!window.confirm("Delete this memory permanently?")) return;
    try {
      await deleteMemory.mutateAsync({ memoryId: memory.id });
      await invalidate();
      toast({ title: "Memory deleted" });
    } catch (error) {
      toast({
        title: "Delete failed",
        description: apiErrorMessage(error, "Try again."),
        variant: "destructive",
      });
    }
  };

  const clearAll = async () => {
    const scoped =
      agentFilter !== ALL_SENTINEL && agentFilter !== SHARED_SENTINEL;
    const message = scoped
      ? "Clear ALL memories for this Crustabot? This cannot be undone."
      : "Clear ALL memories in the office? This cannot be undone.";
    if (!window.confirm(message)) return;
    try {
      const result = await clearMemories.mutateAsync({
        params: scoped ? { agentId: agentFilter } : {},
      });
      await invalidate();
      toast({ title: `Cleared ${result.deleted} memories` });
    } catch (error) {
      toast({
        title: "Clear failed",
        description: apiErrorMessage(error, "Try again."),
        variant: "destructive",
      });
    }
  };

  const exportAll = async () => {
    try {
      const result = await exportMemories();
      const blob = new Blob([JSON.stringify(result, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `crustabox-memories-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      URL.revokeObjectURL(url);
      toast({ title: `Exported ${result.total} memories` });
    } catch {
      toast({ title: "Export failed", variant: "destructive" });
    }
  };

  const memories = data?.memories ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="SEARCH MEMORIES..."
            className={`${inputClass} pl-9 uppercase`}
            data-testid="input-memory-search"
          />
        </div>
        <Select value={agentFilter} onValueChange={setAgentFilter}>
          <SelectTrigger
            className={`${selectTriggerClass} sm:w-56`}
            data-testid="select-memory-filter"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent className={selectContentClass}>
            <SelectItem value={ALL_SENTINEL} className={selectItemClass}>
              All Memories
            </SelectItem>
            <SelectItem value={SHARED_SENTINEL} className={selectItemClass}>
              Shared Only
            </SelectItem>
            {agents.map((agent) => (
              <SelectItem
                key={agent.id}
                value={agent.id}
                className={selectItemClass}
              >
                {agent.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button
          onClick={() => {
            setEditing(null);
            setEditorOpen(true);
          }}
          className="bg-primary text-primary-foreground font-bold uppercase rounded-none pixel-shadow text-xs"
          data-testid="button-new-memory"
        >
          <Plus className="w-4 h-4 mr-1" /> New Memory
        </Button>
        <Button
          onClick={exportAll}
          variant="outline"
          className="font-bold uppercase rounded-none border-2 border-border pixel-shadow text-xs"
          data-testid="button-export-memories"
        >
          <Download className="w-4 h-4 mr-1" /> Export
        </Button>
        <Button
          onClick={clearAll}
          variant="outline"
          className="font-bold uppercase rounded-none border-2 border-destructive text-destructive pixel-shadow text-xs ml-auto"
          data-testid="button-clear-memories"
        >
          <Trash2 className="w-4 h-4 mr-1" /> Clear
          {agentFilter !== ALL_SENTINEL && agentFilter !== SHARED_SENTINEL
            ? " Crustabot"
            : " All"}
        </Button>
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {[...Array(3)].map((_, i) => (
            <PixelCard key={i} className="animate-pulse h-20 bg-muted/50">
              <div />
            </PixelCard>
          ))}
        </div>
      ) : memories.length === 0 ? (
        <PixelCard className="text-center p-8">
          <Brain className="w-8 h-8 mx-auto text-muted-foreground mb-2" />
          <div className="font-bold uppercase text-sm">No memories yet</div>
          <div className="text-xs text-muted-foreground mt-1">
            Crustabots remember task outcomes automatically; you can add facts
            and decisions here.
          </div>
        </PixelCard>
      ) : (
        <div className="space-y-2">
          {memories.map((memory) => (
            <PixelCard
              key={memory.id}
              className={`p-4 ${memory.disabled ? "opacity-50" : ""}`}
              data-testid={`card-memory-${memory.id}`}
            >
              <div className="flex flex-wrap items-center gap-2 mb-2">
                <Badge
                  className={`rounded-none border-2 text-[9px] uppercase font-bold ${KIND_STYLES[memory.kind] ?? KIND_STYLES.fact}`}
                >
                  {memory.kind.replace("_", " ")}
                </Badge>
                <span className="text-[10px] font-mono uppercase text-muted-foreground flex items-center gap-1">
                  <Users className="w-3 h-3" />
                  {memory.agentName ?? "Shared"}
                </span>
                {memory.pinned && (
                  <Badge className="rounded-none border-2 border-accent bg-accent/10 text-accent text-[9px] uppercase font-bold">
                    <Pin className="w-3 h-3 mr-0.5" /> Pinned
                  </Badge>
                )}
                {memory.disabled && (
                  <Badge className="rounded-none border-2 border-border bg-muted text-muted-foreground text-[9px] uppercase font-bold">
                    Disabled
                  </Badge>
                )}
                <span className="text-[10px] font-mono text-muted-foreground ml-auto">
                  {formatDistanceToNow(new Date(memory.updatedAt), {
                    addSuffix: true,
                  })}
                </span>
              </div>
              <p className="text-sm font-mono whitespace-pre-wrap break-words">
                {memory.content}
              </p>
              <div className="flex gap-1 mt-3">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => toggle(memory, { pinned: !memory.pinned })}
                  className="rounded-none text-[10px] uppercase font-bold h-7"
                  data-testid={`button-pin-${memory.id}`}
                >
                  {memory.pinned ? (
                    <PinOff className="w-3 h-3 mr-1" />
                  ) : (
                    <Pin className="w-3 h-3 mr-1" />
                  )}
                  {memory.pinned ? "Unpin" : "Pin"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => toggle(memory, { disabled: !memory.disabled })}
                  className="rounded-none text-[10px] uppercase font-bold h-7"
                  data-testid={`button-disable-${memory.id}`}
                >
                  {memory.disabled ? (
                    <Eye className="w-3 h-3 mr-1" />
                  ) : (
                    <EyeOff className="w-3 h-3 mr-1" />
                  )}
                  {memory.disabled ? "Enable" : "Disable"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setEditing(memory);
                    setEditorOpen(true);
                  }}
                  className="rounded-none text-[10px] uppercase font-bold h-7"
                  data-testid={`button-edit-${memory.id}`}
                >
                  <Pencil className="w-3 h-3 mr-1" /> Edit
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => remove(memory)}
                  className="rounded-none text-[10px] uppercase font-bold h-7 text-destructive ml-auto"
                  data-testid={`button-delete-${memory.id}`}
                >
                  <Trash2 className="w-3 h-3 mr-1" /> Delete
                </Button>
              </div>
            </PixelCard>
          ))}
        </div>
      )}

      <MemoryEditorDialog
        memory={editing}
        agents={agents}
        open={editorOpen}
        onOpenChange={setEditorOpen}
      />
    </div>
  );
}

function KnowledgeTab({ agents }: { agents: { id: string; name: string }[] }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: files, isLoading } = useListKnowledgeFiles();
  const uploadFile = useUploadKnowledgeFile();
  const deleteFile = useDeleteKnowledgeFile();
  const setAssignments = useSetKnowledgeAssignments();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const invalidate = () =>
    queryClient.invalidateQueries({
      queryKey: getListKnowledgeFilesQueryKey(),
    });

  const onUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const content = await readTextFile(file);
      await uploadFile.mutateAsync({
        data: {
          name: file.name,
          mimeType: file.type || "text/plain",
          content,
        },
      });
      await invalidate();
      toast({ title: `"${file.name}" uploaded` });
    } catch (error) {
      toast({
        title: "Upload failed",
        description:
          error instanceof Error && !("response" in error)
            ? error.message
            : apiErrorMessage(error, "Try a smaller text file."),
        variant: "destructive",
      });
    }
  };

  const remove = async (file: KnowledgeFile) => {
    if (!window.confirm(`Delete "${file.name}" and its Crustabot assignments?`))
      return;
    try {
      await deleteFile.mutateAsync({ fileId: file.id });
      await invalidate();
      toast({ title: "File deleted" });
    } catch (error) {
      toast({
        title: "Delete failed",
        description: apiErrorMessage(error, "Try again."),
        variant: "destructive",
      });
    }
  };

  const toggleAssignment = async (file: KnowledgeFile, agentId: string) => {
    const next = file.agentIds.includes(agentId)
      ? file.agentIds.filter((id) => id !== agentId)
      : [...file.agentIds, agentId];
    try {
      await setAssignments.mutateAsync({
        fileId: file.id,
        data: { agentIds: next },
      });
      await invalidate();
    } catch (error) {
      toast({
        title: "Assignment failed",
        description: apiErrorMessage(error, "Try again."),
        variant: "destructive",
      });
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <input
          ref={fileInputRef}
          type="file"
          accept=".txt,.md,.markdown,.csv,.json,.yaml,.yml,.xml,.html,.js,.ts,.py,.sql,.toml,text/*"
          onChange={onUpload}
          className="hidden"
          data-testid="input-knowledge-file"
        />
        <Button
          onClick={() => fileInputRef.current?.click()}
          disabled={uploadFile.isPending}
          className="bg-primary text-primary-foreground font-bold uppercase rounded-none pixel-shadow text-xs"
          data-testid="button-upload-knowledge"
        >
          <Upload className="w-4 h-4 mr-1" />
          {uploadFile.isPending ? "Uploading..." : "Upload Text File"}
        </Button>
        <span className="text-[10px] font-mono uppercase text-muted-foreground">
          txt, md, csv, json, code — max 200k chars each
        </span>
      </div>

      {isLoading ? (
        <PixelCard className="animate-pulse h-24 bg-muted/50">
          <div />
        </PixelCard>
      ) : !files || files.length === 0 ? (
        <PixelCard className="text-center p-8">
          <FileText className="w-8 h-8 mx-auto text-muted-foreground mb-2" />
          <div className="font-bold uppercase text-sm">No knowledge files</div>
          <div className="text-xs text-muted-foreground mt-1">
            Upload documents, then assign them to the Crustabots allowed to use
            them.
          </div>
        </PixelCard>
      ) : (
        <div className="space-y-2">
          {files.map((file) => (
            <PixelCard
              key={file.id}
              className="p-4"
              data-testid={`card-file-${file.id}`}
            >
              <div className="flex flex-wrap items-center gap-2">
                <FileText className="w-4 h-4 text-accent shrink-0" />
                <span className="font-bold text-sm break-all">{file.name}</span>
                <span className="text-[10px] font-mono text-muted-foreground uppercase">
                  {(file.sizeBytes / 1000).toFixed(1)} kB · {file.wordCount}{" "}
                  words · {file.mimeType}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => remove(file)}
                  className="rounded-none text-[10px] uppercase font-bold h-7 text-destructive ml-auto"
                  data-testid={`button-delete-file-${file.id}`}
                >
                  <Trash2 className="w-3 h-3 mr-1" /> Delete
                </Button>
              </div>
              {file.description && (
                <p className="text-xs font-mono text-muted-foreground mt-1">
                  {file.description}
                </p>
              )}
              <div className="mt-3">
                <div className="text-[10px] font-bold uppercase text-muted-foreground mb-1">
                  Authorized Crustabots
                </div>
                {agents.length === 0 ? (
                  <div className="text-[10px] font-mono text-muted-foreground uppercase">
                    No Crustabots to assign.
                  </div>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {agents.map((agent) => {
                      const assigned = file.agentIds.includes(agent.id);
                      return (
                        <button
                          key={agent.id}
                          onClick={() => toggleAssignment(file, agent.id)}
                          className={`px-2 py-1 border-2 text-[10px] font-bold uppercase transition-colors ${
                            assigned
                              ? "bg-primary text-primary-foreground border-primary"
                              : "bg-background text-muted-foreground border-border hover:border-primary"
                          }`}
                          data-testid={`button-assign-${file.id}-${agent.id}`}
                        >
                          {agent.name}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </PixelCard>
          ))}
        </div>
      )}
    </div>
  );
}

function SkillEditorDialog({
  skill,
  open,
  onOpenChange,
}: {
  skill: WorkspaceSkill | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const createSkill = useCreateWorkspaceSkill();
  const updateSkill = useUpdateWorkspaceSkill();
  const [title, setTitle] = useState("");
  const [triggersText, setTriggersText] = useState("");
  const [instructions, setInstructions] = useState("");
  const [enabled, setEnabled] = useState(true);
  const openedFor = useRef<string | null>(null);

  if (open && openedFor.current !== (skill?.id ?? "new")) {
    openedFor.current = skill?.id ?? "new";
    setTitle(skill?.title ?? "");
    setTriggersText(skill?.triggers.join(", ") ?? "");
    setInstructions(skill?.instructions ?? "");
    setEnabled(skill?.enabled ?? true);
  }
  if (!open && openedFor.current !== null) openedFor.current = null;

  const triggers = triggersText
    .split(/[,\n]/)
    .map((trigger) => trigger.trim())
    .filter(Boolean);
  const validTriggers =
    triggers.length > 0 &&
    triggers.length <= 10 &&
    triggers.every((trigger) => trigger.length <= 40);
  const busy = createSkill.isPending || updateSkill.isPending;

  const save = async () => {
    const data = {
      title: title.trim(),
      triggers: [...new Set(triggers)],
      instructions: instructions.trim(),
      enabled,
    };
    try {
      if (skill) {
        await updateSkill.mutateAsync({ skillId: skill.id, data });
      } else {
        await createSkill.mutateAsync({ data });
      }
      await queryClient.invalidateQueries({
        queryKey: getListWorkspaceSkillsQueryKey(),
      });
      onOpenChange(false);
      toast({ title: skill ? "Skill updated" : "Skill created" });
    } catch (error) {
      toast({
        title: "Could not save skill",
        description: apiErrorMessage(error, "Try again."),
        variant: "destructive",
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-card border-4 border-border rounded-none max-w-xl">
        <DialogTitle className="font-display text-sm text-primary uppercase">
          {skill ? "Edit Workspace Skill" : "New Workspace Skill"}
        </DialogTitle>
        <div className="space-y-4">
          <div>
            <label className="text-[10px] font-bold uppercase text-muted-foreground">
              Title
            </label>
            <Input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              maxLength={80}
              className={inputClass}
              placeholder="Weekly research brief"
              data-testid="input-skill-title"
            />
          </div>
          <div>
            <label className="text-[10px] font-bold uppercase text-muted-foreground">
              Triggers
            </label>
            <Input
              value={triggersText}
              onChange={(event) => setTriggersText(event.target.value)}
              className={inputClass}
              placeholder="research, market update, competitors"
              data-testid="input-skill-triggers"
            />
            <p className="mt-1 text-[10px] font-mono text-muted-foreground uppercase">
              Comma-separated · up to 10 · 40 characters each
            </p>
          </div>
          <div>
            <label className="text-[10px] font-bold uppercase text-muted-foreground">
              Instructions
            </label>
            <Textarea
              value={instructions}
              onChange={(event) => setInstructions(event.target.value)}
              maxLength={2000}
              rows={8}
              className={inputClass}
              placeholder="Guidance the Crustabot should follow when a trigger matches..."
              data-testid="input-skill-instructions"
            />
            <p className="mt-1 text-[10px] font-mono text-muted-foreground text-right">
              {instructions.length}/2000
            </p>
          </div>
          <label className="flex items-center gap-2 text-xs font-bold uppercase cursor-pointer">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(event) => setEnabled(event.target.checked)}
              className="w-4 h-4 accent-[hsl(13,90%,55%)]"
              data-testid="checkbox-skill-enabled"
            />
            Enabled for matching tasks
          </label>
          <Button
            onClick={save}
            disabled={
              busy ||
              !title.trim() ||
              title.trim().length > 80 ||
              !validTriggers ||
              !instructions.trim()
            }
            className="w-full bg-primary text-primary-foreground font-bold uppercase rounded-none pixel-shadow"
            data-testid="button-save-skill"
          >
            {busy ? "Saving..." : skill ? "Save Changes" : "Create Skill"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function SkillsTab() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: skills, isLoading } = useListWorkspaceSkills();
  const updateSkill = useUpdateWorkspaceSkill();
  const deleteSkill = useDeleteWorkspaceSkill();
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<WorkspaceSkill | null>(null);

  const invalidate = () =>
    queryClient.invalidateQueries({
      queryKey: getListWorkspaceSkillsQueryKey(),
    });

  const toggle = async (skill: WorkspaceSkill) => {
    try {
      await updateSkill.mutateAsync({
        skillId: skill.id,
        data: { enabled: !skill.enabled },
      });
      await invalidate();
    } catch (error) {
      toast({
        title: "Update failed",
        description: apiErrorMessage(error, "Try again."),
        variant: "destructive",
      });
    }
  };

  const remove = async (skill: WorkspaceSkill) => {
    if (!window.confirm(`Delete the skill “${skill.title}”?`)) return;
    try {
      await deleteSkill.mutateAsync({ skillId: skill.id });
      await invalidate();
      toast({ title: "Skill deleted" });
    } catch (error) {
      toast({
        title: "Delete failed",
        description: apiErrorMessage(error, "Try again."),
        variant: "destructive",
      });
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Button
          onClick={() => {
            setEditing(null);
            setEditorOpen(true);
          }}
          disabled={(skills?.length ?? 0) >= 20}
          className="bg-primary text-primary-foreground font-bold uppercase rounded-none pixel-shadow text-xs"
          data-testid="button-new-skill"
        >
          <Plus className="w-4 h-4 mr-1" /> New Skill
        </Button>
        <span className="text-[10px] font-mono uppercase text-muted-foreground">
          {skills?.length ?? 0}/20 · guidance only · grants no tools
        </span>
      </div>

      {isLoading ? (
        <PixelCard className="animate-pulse h-24 bg-muted/50">
          <div />
        </PixelCard>
      ) : !skills || skills.length === 0 ? (
        <PixelCard className="text-center p-8">
          <Sparkles className="w-8 h-8 mx-auto text-muted-foreground mb-2" />
          <div className="font-bold uppercase text-sm">No workspace skills</div>
          <div className="text-xs text-muted-foreground mt-1">
            Add trigger-based working guidance without granting any new tools.
          </div>
        </PixelCard>
      ) : (
        <div className="space-y-2">
          {skills.map((skill) => (
            <PixelCard
              key={skill.id}
              className={`p-4 ${skill.enabled ? "" : "opacity-50"}`}
              data-testid={`card-skill-${skill.id}`}
            >
              <div className="flex flex-wrap items-center gap-2">
                <Sparkles className="w-4 h-4 text-accent" />
                <span className="font-bold text-sm uppercase">
                  {skill.title}
                </span>
                <Badge className="rounded-none border-2 border-border bg-muted text-[9px] uppercase">
                  {skill.enabled ? "Enabled" : "Disabled"}
                </Badge>
                <span className="text-[10px] font-mono text-muted-foreground ml-auto">
                  {formatDistanceToNow(new Date(skill.updatedAt), {
                    addSuffix: true,
                  })}
                </span>
              </div>
              <div className="flex flex-wrap gap-1 mt-2">
                {skill.triggers.map((trigger) => (
                  <Badge
                    key={trigger}
                    variant="outline"
                    className="rounded-none text-[9px] font-mono"
                  >
                    {trigger}
                  </Badge>
                ))}
              </div>
              <p className="text-sm font-mono whitespace-pre-wrap break-words mt-3">
                {skill.instructions}
              </p>
              <div className="flex gap-1 mt-3">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => toggle(skill)}
                  className="rounded-none text-[10px] uppercase font-bold h-7"
                  data-testid={`button-toggle-skill-${skill.id}`}
                >
                  {skill.enabled ? (
                    <EyeOff className="w-3 h-3 mr-1" />
                  ) : (
                    <Eye className="w-3 h-3 mr-1" />
                  )}
                  {skill.enabled ? "Disable" : "Enable"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setEditing(skill);
                    setEditorOpen(true);
                  }}
                  className="rounded-none text-[10px] uppercase font-bold h-7"
                  data-testid={`button-edit-skill-${skill.id}`}
                >
                  <Pencil className="w-3 h-3 mr-1" /> Edit
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => remove(skill)}
                  className="rounded-none text-[10px] uppercase font-bold h-7 text-destructive ml-auto"
                  data-testid={`button-delete-skill-${skill.id}`}
                >
                  <Trash2 className="w-3 h-3 mr-1" /> Delete
                </Button>
              </div>
            </PixelCard>
          ))}
        </div>
      )}

      <SkillEditorDialog
        skill={editing}
        open={editorOpen}
        onOpenChange={setEditorOpen}
      />
    </div>
  );
}

export default function MemoryPage() {
  const [tab, setTab] = useState<"memories" | "knowledge" | "skills">(
    "memories",
  );
  const { data: agents } = useListAgents();
  const { data: memorySettings } = useGetMemorySettings();
  const updateMemorySettings = useUpdateMemorySettings();
  const refreshAgentMemory = useRefreshAgentMemory();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const activeAgents = useMemo(
    () =>
      (agents ?? [])
        .filter((a) => !a.archived)
        .map((a) => ({ id: a.id, name: a.name })),
    [agents],
  );
  const [refreshAgentId, setRefreshAgentId] = useState("");
  const compressionAgents = useMemo(
    () =>
      (agents ?? []).filter(
        (agent) =>
          !agent.archived &&
          agent.status !== "paused" &&
          !agent.sensitiveDataSandbox,
      ),
    [agents],
  );

  const assignCompressionAgent = async (value: string) => {
    try {
      const updated = await updateMemorySettings.mutateAsync({
        data: {
          compressionAgentId: value === UNASSIGNED_SENTINEL ? null : value,
        },
      });
      queryClient.setQueryData(getGetMemorySettingsQueryKey(), updated);
      toast({
        title: updated.compressionAgentName
          ? `${updated.compressionAgentName} assigned to memory compression`
          : "Memory compression role cleared",
      });
    } catch (error) {
      toast({
        title: "Could not update memory compression",
        description: apiErrorMessage(error, "Try again."),
        variant: "destructive",
      });
    }
  };

  const triggerMemoryRefresh = async () => {
    if (!refreshAgentId) return;
    try {
      const result = await refreshAgentMemory.mutateAsync({
        agentId: refreshAgentId,
      });
      toast({
        title: `Memory refresh triggered for ${result.agentName}`,
        description: "It's now queued and will run shortly.",
      });
    } catch (error) {
      toast({
        title: "Could not trigger memory refresh",
        description: apiErrorMessage(error, "Try again."),
        variant: "destructive",
      });
    }
  };

  return (
    <Shell>
      <div className="p-4 sm:p-8 max-w-5xl mx-auto space-y-6">
        <div>
          <h1 className="font-display text-xl sm:text-2xl text-primary uppercase flex items-center gap-3">
            <Brain className="w-6 h-6" /> Memory
          </h1>
          <p className="text-xs text-muted-foreground uppercase mt-1">
            What your Crustabots remember and which documents they may use
          </p>
        </div>

        <PixelCard className="p-4 sm:p-5">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
            <div className="flex min-w-0 flex-1 items-start gap-3">
              <Wrench className="mt-0.5 h-5 w-5 shrink-0 text-accent" />
              <div>
                <h2 className="text-sm font-bold uppercase">
                  Memory compression Crustabot
                </h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Assign an active, non-sandboxed Crustabot to steward automatic
                  memory housekeeping. In the office it will maintain the cables
                  at the memory terminal.
                </p>
              </div>
            </div>
            <Select
              value={memorySettings?.compressionAgentId ?? UNASSIGNED_SENTINEL}
              onValueChange={assignCompressionAgent}
              disabled={updateMemorySettings.isPending}
            >
              <SelectTrigger
                className={`${selectTriggerClass} sm:w-64`}
                data-testid="select-memory-compression-agent"
              >
                <SelectValue placeholder="Not assigned" />
              </SelectTrigger>
              <SelectContent className={selectContentClass}>
                <SelectItem
                  value={UNASSIGNED_SENTINEL}
                  className={selectItemClass}
                >
                  Not assigned
                </SelectItem>
                {compressionAgents.map((agent) => (
                  <SelectItem
                    key={agent.id}
                    value={agent.id}
                    className={selectItemClass}
                  >
                    {agent.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </PixelCard>

        <PixelCard className="p-4 sm:p-5">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
            <div className="flex min-w-0 flex-1 items-start gap-3">
              <RefreshCw className="mt-0.5 h-5 w-5 shrink-0 text-accent" />
              <div>
                <h2 className="text-sm font-bold uppercase">
                  Force memory update
                </h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Queue an immediate memory refresh for one Crustabot instead
                  of waiting for it to happen automatically.
                </p>
              </div>
            </div>
            <div className="flex gap-2 sm:w-auto">
              <Select value={refreshAgentId} onValueChange={setRefreshAgentId}>
                <SelectTrigger
                  className={`${selectTriggerClass} sm:w-56`}
                  data-testid="select-memory-refresh-agent"
                >
                  <SelectValue placeholder="Choose a Crustabot" />
                </SelectTrigger>
                <SelectContent className={selectContentClass}>
                  {activeAgents.map((agent) => (
                    <SelectItem
                      key={agent.id}
                      value={agent.id}
                      className={selectItemClass}
                    >
                      {agent.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                onClick={triggerMemoryRefresh}
                disabled={!refreshAgentId || refreshAgentMemory.isPending}
                className="rounded-none text-xs font-bold uppercase shrink-0"
                data-testid="button-refresh-agent-memory"
              >
                <RefreshCw className="w-4 h-4 mr-1" />
                {refreshAgentMemory.isPending ? "Triggering..." : "Update now"}
              </Button>
            </div>
          </div>
        </PixelCard>

        <div className="flex gap-2">
          {(["memories", "knowledge", "skills"] as const).map((key) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`px-4 py-2 border-4 text-xs font-bold uppercase pixel-shadow transition-colors ${
                tab === key
                  ? "bg-primary text-primary-foreground border-primary"
                  : "bg-card text-foreground border-border hover:bg-muted"
              }`}
              data-testid={`tab-${key}`}
            >
              {key === "memories"
                ? "Memories"
                : key === "knowledge"
                  ? "Knowledge Files"
                  : "Skills"}
            </button>
          ))}
        </div>

        {tab === "memories" ? (
          <MemoriesTab agents={activeAgents} />
        ) : tab === "knowledge" ? (
          <KnowledgeTab agents={activeAgents} />
        ) : (
          <SkillsTab />
        )}
      </div>
    </Shell>
  );
}
