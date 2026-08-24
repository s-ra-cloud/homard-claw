import React from "react";
import {
  useListAgents,
  usePauseAgent,
  useRetireAgent,
  useDuplicateAgent,
  useSetAgentArchived,
  useDeleteAgent,
} from "@workspace/api-client-react";
import { Shell } from "@/components/layout/Shell";
import { PixelCard } from "@/components/ui/pixel-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { MarlowLobster } from "@/components/ui/marlow-lobster";
import {
  Archive,
  ArchiveRestore,
  Copy,
  Palmtree,
  Pause,
  Pencil,
  Play,
  Plus,
  Server,
  Shield,
  Trash2,
} from "lucide-react";
import { Link, useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";

export default function AgentsPage() {
  const { data: agents, isLoading } = useListAgents();
  const queryClient = useQueryClient();
  const [, setLocation] = useLocation();
  const { toast } = useToast();

  const invalidateRoster = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/agents"] });
    queryClient.invalidateQueries({ queryKey: ["/api/office/overview"] });
  };

  const onMutationError = (title: string) => (error: { status?: number; message: string }) => {
    toast({
      variant: "destructive",
      title,
      description: error.message,
    });
  };

  const pauseAgent = usePauseAgent({
    mutation: {
      onSuccess: invalidateRoster,
      onError: onMutationError("Could not update agent"),
    }
  });

  const retireAgent = useRetireAgent({
    mutation: {
      onSuccess: () => {
        invalidateRoster();
        queryClient.invalidateQueries({ queryKey: ["/api/island/agents"] });
        queryClient.invalidateQueries({ queryKey: ["/api/tasks"] });
      },
      onError: onMutationError("Could not retire agent"),
    }
  });

  const duplicateAgent = useDuplicateAgent({
    mutation: {
      onSuccess: (copy) => {
        invalidateRoster();
        toast({
          title: "Agent duplicated",
          description: `${copy.name} has joined the roster with the same configuration.`,
        });
      },
      onError: onMutationError("Could not duplicate agent"),
    },
  });

  const setArchived = useSetAgentArchived({
    mutation: {
      onSuccess: (agent) => {
        invalidateRoster();
        queryClient.invalidateQueries({ queryKey: ["/api/tasks"] });
        toast({
          title: agent.archived ? "Agent archived" : "Agent restored",
          description: agent.archived
            ? `${agent.name} stepped away from the office. Restore them anytime.`
            : `${agent.name} is back on the active roster.`,
        });
      },
      onError: onMutationError("Could not archive agent"),
    },
  });

  const deleteAgent = useDeleteAgent({
    mutation: {
      onSuccess: () => {
        invalidateRoster();
        queryClient.invalidateQueries({ queryKey: ["/api/tasks"] });
        queryClient.invalidateQueries({ queryKey: ["/api/approvals"] });
        toast({
          title: "Agent deleted",
          description: "The agent and their task history were permanently removed.",
        });
      },
      onError: onMutationError("Could not delete agent"),
    },
  });

  const handleRetire = (agentId: string, name: string) => {
    const confirmed = window.confirm(
      `RETIRE ${name.toUpperCase()}? This is PERMANENT.\n\n${name} will be removed from active work forever and move to the Island. Any queued work will be blocked until reassigned. This cannot be undone.`
    );
    if (confirmed) {
      retireAgent.mutate({ agentId });
    }
  };

  const handleArchive = (agentId: string, name: string) => {
    const confirmed = window.confirm(
      `ARCHIVE ${name.toUpperCase()}?\n\n${name} will step away from the office and stop taking work. Their configuration and task history are kept, and you can restore them anytime.`
    );
    if (confirmed) {
      setArchived.mutate({ agentId, data: { archived: true } });
    }
  };

  const handleDelete = (agentId: string, name: string) => {
    const confirmed = window.confirm(
      `PERMANENTLY DELETE ${name.toUpperCase()}?\n\nThis erases the agent AND their entire task history. This cannot be undone.\n\nIf you just want them out of the way, use Archive instead.`
    );
    if (confirmed) {
      deleteAgent.mutate({ agentId });
    }
  };

  const handleTogglePause = (agentId: string, currentStatus: string) => {
    const isPaused = currentStatus === 'paused';
    pauseAgent.mutate({
      agentId,
      data: { paused: !isPaused }
    });
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'idle': return <Badge variant="outline">Idle</Badge>;
      case 'working': return <Badge variant="success" className="animate-pulse">Working</Badge>;
      case 'researching': return <Badge variant="accent">Researching</Badge>;
      case 'waiting': return <Badge variant="warning">Waiting Approval</Badge>;
      case 'paused': return <Badge variant="destructive">Paused</Badge>;
      case 'error': return <Badge variant="destructive">Error</Badge>;
      default: return <Badge variant="default">{status}</Badge>;
    }
  };

  const activeAgents = (agents ?? []).filter((agent) => !agent.archived);
  const archivedAgents = (agents ?? []).filter((agent) => agent.archived);

  return (
    <Shell>
      <div className="p-4 sm:p-6 lg:p-8 max-w-7xl mx-auto space-y-6 sm:space-y-8">
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-4 border-b-4 border-border pb-6">
          <div>
            <h1 className="font-display text-lg sm:text-2xl text-foreground uppercase mb-2">Agent Roster</h1>
            <p className="text-muted-foreground text-sm">Manage your autonomous workforce.</p>
          </div>
          <Link href="/agents/new">
            <Button variant="primary">
              <Plus className="w-4 h-4 mr-2" />
              Recruit Agent
            </Button>
          </Link>
        </div>

        {isLoading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
            {[1, 2, 3].map(i => (
              <PixelCard key={i} className="animate-pulse h-64 bg-muted/50">
                <div className="w-full h-full"></div>
              </PixelCard>
            ))}
          </div>
        ) : activeAgents.length === 0 && archivedAgents.length === 0 ? (
          <PixelCard className="text-center p-6 sm:p-12">
            <div className="flex justify-center mb-6 opacity-50">
              <MarlowLobster size={112} status="idle" preset="marlow" />
            </div>
            <h3 className="font-display text-lg uppercase mb-2">No Agents Recruited</h3>
            <p className="text-muted-foreground mb-6">The office is empty. Recruit an agent to begin processing tasks.</p>
            <Link href="/agents/new">
              <Button variant="primary">Recruit First Agent</Button>
            </Link>
          </PixelCard>
        ) : (
          <>
            {activeAgents.length === 0 ? (
              <PixelCard className="text-center p-6 sm:p-12">
                <div className="flex justify-center mb-6 opacity-50">
                  <MarlowLobster size={112} status="idle" preset="marlow" />
                </div>
                <h3 className="font-display text-lg uppercase mb-2">No Active Agents</h3>
                <p className="text-muted-foreground mb-6">Everyone is in the archive. Restore an agent or recruit a new one.</p>
              </PixelCard>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
                {activeAgents.map((agent) => (
                  <PixelCard
                    key={agent.id}
                    variant={agent.status === 'working' ? 'primary' : agent.status === 'paused' ? 'destructive' : 'default'}
                    className="flex flex-col h-full"
                  >
                    <div className="flex justify-between items-start mb-4">
                      <div className="flex items-center gap-4">
                        <div className="bg-muted p-2 border-2 border-border pixel-shadow">
                          <MarlowLobster
                            size={56}
                            status={agent.status}
                            shellColor={agent.avatar.shellColor}
                            title={`${agent.name}, ${agent.status}`}
                          />
                        </div>
                        <div>
                          <h3 className="font-bold text-lg leading-none mb-1">{agent.name}</h3>
                          <div className="text-xs text-muted-foreground uppercase">{agent.title}</div>
                        </div>
                      </div>
                      <div>
                        {getStatusBadge(agent.status)}
                      </div>
                    </div>

                    <div className="flex-1 space-y-4">
                      <p className="text-sm line-clamp-3 text-foreground/80 bg-muted/30 p-3 border-2 border-border/50 font-mono text-xs">
                        "{agent.mission}"
                      </p>

                      <div className="flex flex-wrap gap-2">
                        <div className="flex items-center gap-1 text-[10px] bg-muted px-2 py-1 uppercase font-bold text-muted-foreground border-2 border-border/50">
                          <Server className="w-3 h-3" />
                          {agent.provider ?? "default"}
                        </div>
                        <div className="flex items-center gap-1 text-[10px] bg-muted px-2 py-1 uppercase font-bold text-muted-foreground border-2 border-border/50">
                          <Shield className="w-3 h-3" />
                          {agent.securityPreset}
                        </div>
                        {agent.specialization && (
                          <div className="flex items-center gap-1 text-[10px] bg-muted px-2 py-1 uppercase font-bold text-muted-foreground border-2 border-border/50">
                            {agent.specialization}
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="mt-6 pt-4 border-t-4 border-border space-y-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          title={`Edit ${agent.name}'s personnel file`}
                          onClick={() => setLocation(`/agents/${agent.id}/edit`)}
                        >
                          <Pencil className="w-3 h-3 mr-1" /> Edit
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          title={`Duplicate ${agent.name}'s configuration`}
                          onClick={() => duplicateAgent.mutate({ agentId: agent.id })}
                          disabled={duplicateAgent.isPending && duplicateAgent.variables?.agentId === agent.id}
                        >
                          <Copy className="w-3 h-3 mr-1" /> Duplicate
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          title={`Archive ${agent.name} (restorable)`}
                          onClick={() => handleArchive(agent.id, agent.name)}
                          disabled={setArchived.isPending && setArchived.variables?.agentId === agent.id}
                        >
                          <Archive className="w-3 h-3 mr-1" /> Archive
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          title={`Permanently delete ${agent.name} and their task history`}
                          onClick={() => handleDelete(agent.id, agent.name)}
                          disabled={deleteAgent.isPending && deleteAgent.variables?.agentId === agent.id}
                        >
                          <Trash2 className="w-3 h-3 mr-1" /> Delete
                        </Button>
                      </div>
                      <div className="flex flex-wrap justify-between items-center gap-3">
                        <div className="text-[10px] text-muted-foreground uppercase">
                          ID: {agent.id.slice(0, 8)}
                        </div>
                        <div className="flex items-center gap-2 ml-auto">
                          <Button
                            variant={agent.status === 'paused' ? 'primary' : 'outline'}
                            size="sm"
                            onClick={() => handleTogglePause(agent.id, agent.status)}
                            disabled={pauseAgent.isPending && pauseAgent.variables?.agentId === agent.id}
                          >
                            {agent.status === 'paused' ? (
                              <><Play className="w-3 h-3 mr-1" /> Resume</>
                            ) : (
                              <><Pause className="w-3 h-3 mr-1" /> Pause</>
                            )}
                          </Button>
                          <Button
                            variant="destructive"
                            size="sm"
                            title={`Retire ${agent.name} permanently to the Island`}
                            onClick={() => handleRetire(agent.id, agent.name)}
                            disabled={retireAgent.isPending && retireAgent.variables?.agentId === agent.id}
                          >
                            <Palmtree className="w-3 h-3 mr-1" /> Retire
                          </Button>
                        </div>
                      </div>
                    </div>
                  </PixelCard>
                ))}
              </div>
            )}

            {archivedAgents.length > 0 && (
              <div className="space-y-4">
                <div className="flex items-center gap-3 border-b-4 border-border pb-3">
                  <Archive className="w-4 h-4 text-muted-foreground" />
                  <h2 className="font-display text-sm sm:text-lg uppercase text-muted-foreground">
                    Archive
                  </h2>
                  <Badge variant="outline">{archivedAgents.length}</Badge>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
                  {archivedAgents.map((agent) => (
                    <PixelCard key={agent.id} className="flex flex-col h-full opacity-80">
                      <div className="flex justify-between items-start mb-4">
                        <div className="flex items-center gap-4">
                          <div className="bg-muted p-2 border-2 border-border pixel-shadow grayscale">
                            <MarlowLobster
                              size={56}
                              status="paused"
                              shellColor={agent.avatar.shellColor}
                              title={`${agent.name}, archived`}
                            />
                          </div>
                          <div>
                            <h3 className="font-bold text-lg leading-none mb-1">{agent.name}</h3>
                            <div className="text-xs text-muted-foreground uppercase">{agent.title}</div>
                          </div>
                        </div>
                        <Badge variant="outline">Archived</Badge>
                      </div>

                      <div className="flex-1">
                        <p className="text-sm line-clamp-2 text-foreground/60 bg-muted/30 p-3 border-2 border-border/50 font-mono text-xs">
                          "{agent.mission}"
                        </p>
                      </div>

                      <div className="mt-6 pt-4 border-t-4 border-border flex flex-wrap justify-between items-center gap-3">
                        <div className="text-[10px] text-muted-foreground uppercase">
                          {agent.archivedAt ? `Since ${new Date(agent.archivedAt).toLocaleDateString()}` : `ID: ${agent.id.slice(0, 8)}`}
                        </div>
                        <div className="flex items-center gap-2 ml-auto">
                          <Button
                            variant="primary"
                            size="sm"
                            title={`Restore ${agent.name} to the active roster`}
                            onClick={() => setArchived.mutate({ agentId: agent.id, data: { archived: false } })}
                            disabled={setArchived.isPending && setArchived.variables?.agentId === agent.id}
                          >
                            <ArchiveRestore className="w-3 h-3 mr-1" /> Restore
                          </Button>
                          <Button
                            variant="destructive"
                            size="sm"
                            title={`Permanently delete ${agent.name} and their task history`}
                            onClick={() => handleDelete(agent.id, agent.name)}
                            disabled={deleteAgent.isPending && deleteAgent.variables?.agentId === agent.id}
                          >
                            <Trash2 className="w-3 h-3 mr-1" /> Delete
                          </Button>
                        </div>
                      </div>
                    </PixelCard>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </Shell>
  );
}
