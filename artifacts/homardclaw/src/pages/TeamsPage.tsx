import { useState } from "react";
import {
  useListTeams,
  useCreateTeam,
  useUpdateTeam,
  useDeleteTeam,
  useAddTeamMember,
  useRemoveTeamMember,
  useListAgents,
  type Team,
} from "@workspace/api-client-react";
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
import { useQueryClient } from "@tanstack/react-query";
import { Crown, Plus, Trash2, UserMinus, UserPlus, Users } from "lucide-react";

const selectTriggerClass =
  "bg-background border-4 border-border rounded-none focus:ring-0 focus:border-primary font-mono text-sm uppercase";
const selectContentClass = "border-4 border-border rounded-none bg-card max-h-72";
const selectItemClass =
  "font-mono text-xs uppercase focus:bg-primary focus:text-primary-foreground";

const TEAMS_KEY = ["/api/teams"];

function useTeamsRefresh() {
  const queryClient = useQueryClient();
  return () => void queryClient.invalidateQueries({ queryKey: TEAMS_KEY });
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function NewTeamForm({ agents }: { agents: { id: string; name: string }[] }) {
  const { toast } = useToast();
  const refresh = useTeamsRefresh();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [mission, setMission] = useState("");

  const create = useCreateTeam({
    mutation: {
      onSuccess: () => {
        setName("");
        setMission("");
        setOpen(false);
        refresh();
        toast({ title: "Team assembled" });
      },
      onError: (error: unknown) =>
        toast({
          title: "Could not create the team",
          description: errorText(error, "Try a different name."),
          variant: "destructive",
        }),
    },
  });

  if (!open) {
    return (
      <Button
        onClick={() => setOpen(true)}
        className="rounded-none font-bold uppercase"
        data-testid="button-new-team"
      >
        <Plus className="w-4 h-4 mr-2" />
        New Team
      </Button>
    );
  }

  return (
    <PixelCard className="p-4 space-y-3">
      <div className="font-display uppercase text-sm">Assemble a team</div>
      <Input
        value={name}
        onChange={(event) => setName(event.target.value)}
        placeholder="Team name"
        className="border-4 border-border rounded-none font-mono"
        data-testid="input-team-name"
      />
      <Textarea
        value={mission}
        onChange={(event) => setMission(event.target.value)}
        placeholder="What is this team for?"
        rows={2}
        className="border-4 border-border rounded-none font-mono text-sm"
        data-testid="input-team-mission"
      />
      <div className="flex gap-2">
        <Button
          disabled={create.isPending || name.trim().length < 2}
          onClick={() =>
            create.mutate({
              data: {
                name: name.trim(),
                ...(mission.trim() ? { mission: mission.trim() } : {}),
              },
            })
          }
          className="rounded-none font-bold uppercase"
          data-testid="button-create-team"
        >
          {create.isPending ? "Creating..." : "Create"}
        </Button>
        <Button
          variant="outline"
          onClick={() => setOpen(false)}
          className="rounded-none font-bold uppercase"
        >
          Cancel
        </Button>
      </div>
    </PixelCard>
  );
}

function TeamCard({
  team,
  agents,
}: {
  team: Team;
  agents: { id: string; name: string; title: string }[];
}) {
  const { toast } = useToast();
  const refresh = useTeamsRefresh();
  const [pendingMember, setPendingMember] = useState("");

  const onError = (fallback: string) => (error: unknown) =>
    toast({
      title: fallback,
      description: errorText(error, "The office refused that change."),
      variant: "destructive",
    });

  const addMember = useAddTeamMember({
    mutation: {
      onSuccess: () => {
        setPendingMember("");
        refresh();
      },
      onError: onError("Could not add that agent"),
    },
  });
  const removeMember = useRemoveTeamMember({
    mutation: { onSuccess: refresh, onError: onError("Could not remove that agent") },
  });
  const updateTeam = useUpdateTeam({
    mutation: { onSuccess: refresh, onError: onError("Could not update the team") },
  });
  const deleteTeam = useDeleteTeam({
    mutation: {
      onSuccess: () => {
        refresh();
        toast({ title: "Team disbanded" });
      },
      onError: onError("Could not disband the team"),
    },
  });

  const memberIds = new Set(team.members.map((member) => member.agentId));
  const candidates = agents.filter((agent) => !memberIds.has(agent.id));

  return (
    <PixelCard className="p-4 space-y-4" data-testid={`card-team-${team.id}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-display uppercase text-base truncate">{team.name}</h3>
          {team.mission && (
            <p className="font-mono text-xs text-muted-foreground mt-1">
              {team.mission}
            </p>
          )}
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => deleteTeam.mutate({ teamId: team.id })}
          className="rounded-none text-destructive"
          title="Disband team"
          data-testid={`button-disband-${team.id}`}
        >
          <Trash2 className="w-4 h-4" />
        </Button>
      </div>

      <div>
        <div className="text-[10px] font-bold uppercase text-muted-foreground mb-1">
          Lead — the only member who may delegate
        </div>
        <Select
          value={team.leadAgentId ?? ""}
          onValueChange={(value) =>
            updateTeam.mutate({ teamId: team.id, data: { leadAgentId: value } })
          }
        >
          <SelectTrigger className={selectTriggerClass} data-testid={`select-lead-${team.id}`}>
            <SelectValue placeholder="No lead yet" />
          </SelectTrigger>
          <SelectContent className={selectContentClass}>
            {team.members.map((member) => (
              <SelectItem
                key={member.agentId}
                value={member.agentId}
                className={selectItemClass}
              >
                {member.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {team.members.length === 0 && (
          <p className="font-mono text-[10px] uppercase text-muted-foreground mt-1">
            Add members first, then pick a lead.
          </p>
        )}
      </div>

      <div className="space-y-2">
        <div className="text-[10px] font-bold uppercase text-muted-foreground">
          Members — the lead may hand work to anyone here
        </div>
        {team.members.length === 0 ? (
          <p className="font-mono text-xs text-muted-foreground">Nobody yet.</p>
        ) : (
          team.members.map((member) => (
            <div
              key={member.agentId}
              className="flex items-center justify-between gap-2 border-2 border-border/50 bg-muted/20 p-2"
            >
              <div className="min-w-0 font-mono text-xs">
                <span className="font-bold">{member.name}</span>
                <span className="text-muted-foreground"> — {member.title}</span>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                {member.isLead && (
                  <Badge variant="outline" className="rounded-none text-[10px]">
                    <Crown className="w-3 h-3 mr-1" />
                    Lead
                  </Badge>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  className="rounded-none"
                  onClick={() =>
                    removeMember.mutate({ teamId: team.id, agentId: member.agentId })
                  }
                  title="Remove from team"
                  data-testid={`button-remove-${member.agentId}`}
                >
                  <UserMinus className="w-4 h-4" />
                </Button>
              </div>
            </div>
          ))
        )}
      </div>

      {candidates.length > 0 && (
        <div className="flex gap-2">
          <Select value={pendingMember} onValueChange={setPendingMember}>
            <SelectTrigger className={selectTriggerClass} data-testid={`select-add-${team.id}`}>
              <SelectValue placeholder="Add an agent" />
            </SelectTrigger>
            <SelectContent className={selectContentClass}>
              {candidates.map((agent) => (
                <SelectItem key={agent.id} value={agent.id} className={selectItemClass}>
                  {agent.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            disabled={!pendingMember || addMember.isPending}
            onClick={() =>
              addMember.mutate({ teamId: team.id, data: { agentId: pendingMember } })
            }
            className="rounded-none font-bold uppercase shrink-0"
            data-testid={`button-add-member-${team.id}`}
          >
            <UserPlus className="w-4 h-4" />
          </Button>
        </div>
      )}
    </PixelCard>
  );
}

export default function TeamsPage() {
  const { data: teams, isLoading } = useListTeams({
    query: { queryKey: TEAMS_KEY },
  });
  const { data: agents } = useListAgents({ query: { queryKey: ["/api/agents"] } });
  const roster = (agents ?? [])
    .filter((agent) => !agent.archived)
    .map((agent) => ({ id: agent.id, name: agent.name, title: agent.title }));

  return (
    <Shell>
      <div className="p-4 sm:p-6 space-y-6 max-w-5xl">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="font-display uppercase text-2xl flex items-center gap-2">
              <Users className="w-6 h-6 text-primary" />
              Teams
            </h1>
            <p className="font-mono text-xs text-muted-foreground mt-1">
              A team's lead can hand parts of its own work to teammates. Nobody
              outside a team can be delegated to.
            </p>
          </div>
          <NewTeamForm agents={roster} />
        </div>

        {isLoading ? (
          <p className="font-mono text-xs uppercase text-muted-foreground animate-pulse">
            Loading teams...
          </p>
        ) : (teams ?? []).length === 0 ? (
          <PixelCard className="p-6">
            <p className="font-mono text-sm text-muted-foreground">
              No teams yet. Create one, add a few lobsters, and name a lead — then
              the lead can split its tasks across the team.
            </p>
          </PixelCard>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {teams!.map((team) => (
              <TeamCard key={team.id} team={team} agents={roster} />
            ))}
          </div>
        )}
      </div>
    </Shell>
  );
}
