import React from "react";
import { useListAgents, usePauseAgent } from "@workspace/api-client-react";
import { Shell } from "@/components/layout/Shell";
import { PixelCard } from "@/components/ui/pixel-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { LobsterAvatar } from "@/components/ui/lobster-avatar";
import { Pause, Play, Plus, Server, Shield } from "lucide-react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";

export default function AgentsPage() {
  const { data: agents, isLoading } = useListAgents();
  const queryClient = useQueryClient();
  
  const pauseAgent = usePauseAgent({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: ["/api/agents"] });
        queryClient.invalidateQueries({ queryKey: ["/api/office/overview"] });
      }
    }
  });

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

  return (
    <Shell>
      <div className="p-8 max-w-7xl mx-auto space-y-8">
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-4 border-b-4 border-border pb-6">
          <div>
            <h1 className="font-display text-2xl text-foreground uppercase mb-2">Agent Roster</h1>
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
        ) : !agents || agents.length === 0 ? (
          <PixelCard className="text-center p-12">
            <div className="flex justify-center mb-6 opacity-50">
              <LobsterAvatar size={96} status="idle" />
            </div>
            <h3 className="font-display text-lg uppercase mb-2">No Agents Recruited</h3>
            <p className="text-muted-foreground mb-6">The office is empty. Recruit an agent to begin processing tasks.</p>
            <Link href="/agents/new">
              <Button variant="primary">Recruit First Agent</Button>
            </Link>
          </PixelCard>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
            {agents.map((agent) => (
              <PixelCard 
                key={agent.id} 
                variant={agent.status === 'working' ? 'primary' : agent.status === 'paused' ? 'destructive' : 'default'}
                className="flex flex-col h-full"
              >
                <div className="flex justify-between items-start mb-4">
                  <div className="flex items-center gap-4">
                    <div className="bg-muted p-2 border-2 border-border pixel-shadow">
                      <LobsterAvatar 
                        size={48} 
                        status={agent.status} 
                        primaryColor={agent.avatar.shellColor} 
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
                      {agent.provider}
                    </div>
                    <div className="flex items-center gap-1 text-[10px] bg-muted px-2 py-1 uppercase font-bold text-muted-foreground border-2 border-border/50">
                      <Shield className="w-3 h-3" />
                      {agent.securityPreset}
                    </div>
                  </div>
                </div>

                <div className="mt-6 pt-4 border-t-4 border-border flex justify-between items-center">
                  <div className="text-[10px] text-muted-foreground uppercase">
                    ID: {agent.id.slice(0, 8)}
                  </div>
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
                </div>
              </PixelCard>
            ))}
          </div>
        )}
      </div>
    </Shell>
  );
}
