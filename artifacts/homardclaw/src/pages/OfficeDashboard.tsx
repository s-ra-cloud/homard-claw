import React from "react";
import { Link } from "wouter";
import { useGetOfficeOverview, useSetEmergencyStop } from "@workspace/api-client-react";
import { Shell } from "@/components/layout/Shell";
import { PixelCard } from "@/components/ui/pixel-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Activity, AlertTriangle, Shield, Users, DollarSign, Clock } from "lucide-react";
import { LobsterAvatar } from "@/components/ui/lobster-avatar";
import { useQueryClient } from "@tanstack/react-query";

export default function OfficeDashboard() {
  const { data: overview, isLoading, isError } = useGetOfficeOverview();
  const queryClient = useQueryClient();
  
  const setEmergencyStop = useSetEmergencyStop({
    mutation: {
      onSuccess: () => {
        // Invalidate queries to refresh state
        queryClient.invalidateQueries({ queryKey: ["/api/office/overview"] });
        queryClient.invalidateQueries({ queryKey: ["/api/agents"] });
      }
    }
  });

  const handleEmergencyStop = () => {
    if (overview) {
      const newState = !overview.emergencyStop;
      if (newState) {
        if (confirm("INITIATE EMERGENCY STOP? This will halt ALL active agents and tasks immediately.")) {
          setEmergencyStop.mutate({ data: { active: true } });
        }
      } else {
        if (confirm("LIFT EMERGENCY STOP? Agents will resume normal operations.")) {
          setEmergencyStop.mutate({ data: { active: false } });
        }
      }
    }
  };

  if (isLoading) {
    return (
      <Shell>
        <div className="p-8 h-full flex flex-col items-center justify-center">
          <LobsterAvatar size={128} status="working" />
          <p className="mt-8 font-display text-primary animate-pulse uppercase">Booting Office Core...</p>
        </div>
      </Shell>
    );
  }

  if (isError || !overview) {
    return (
      <Shell>
        <div className="p-8">
          <PixelCard variant="destructive" title="SYSTEM ERROR">
            <p className="text-destructive-foreground">Failed to connect to office mainframe.</p>
          </PixelCard>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <div className="p-8 max-w-7xl mx-auto space-y-8">
        {/* Header */}
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-4 border-b-4 border-border pb-6">
          <div>
            <h1 className="font-display text-2xl text-foreground uppercase mb-2">Command Center</h1>
            <p className="text-muted-foreground text-sm">System operational. Agents standing by.</p>
          </div>
          
          <div className="flex items-center gap-4">
            <Badge variant={overview.emergencyStop ? "destructive" : "success"} className="text-sm px-3 py-1">
              {overview.emergencyStop ? "HALTED" : "SYSTEM NOMINAL"}
            </Badge>
            <Button 
              variant={overview.emergencyStop ? "default" : "destructive"} 
              size="lg"
              onClick={handleEmergencyStop}
              disabled={setEmergencyStop.isPending}
              className={overview.emergencyStop ? "animate-pulse" : ""}
            >
              <AlertTriangle className="w-5 h-5 mr-2" />
              {overview.emergencyStop ? "LIFT EMERGENCY STOP" : "EMERGENCY STOP"}
            </Button>
          </div>
        </div>

        {/* Global Alert */}
        {overview.emergencyStop && (
          <div className="bg-destructive/20 border-4 border-destructive p-4 flex items-start gap-4 pixel-shadow">
            <AlertTriangle className="w-8 h-8 text-destructive shrink-0" />
            <div>
              <h3 className="font-display text-destructive uppercase mb-1">GLOBAL HALT ACTIVE</h3>
              <p className="text-sm text-foreground">All agents are currently paused. Task processing is suspended until the halt is lifted.</p>
            </div>
          </div>
        )}

        {/* Stats Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          <PixelCard title="Active Agents">
            <div className="flex items-center justify-between">
              <div className="text-4xl font-display text-primary">{overview.agents}</div>
              <Users className="w-8 h-8 text-muted-foreground opacity-50" />
            </div>
            <Link href="/agents" className="text-xs text-accent mt-4 inline-block hover:underline uppercase font-bold">
              Manage Roster →
            </Link>
          </PixelCard>

          <PixelCard title="Running Tasks">
            <div className="flex items-center justify-between">
              <div className="text-4xl font-display text-primary">{overview.activeTasks}</div>
              <Activity className="w-8 h-8 text-muted-foreground opacity-50" />
            </div>
            <Link href="/tasks" className="text-xs text-accent mt-4 inline-block hover:underline uppercase font-bold">
              View Queue →
            </Link>
          </PixelCard>

          <PixelCard title="Pending Approvals" variant={overview.pendingApprovals > 0 ? "accent" : "default"}>
            <div className="flex items-center justify-between">
              <div className="text-4xl font-display text-accent">{overview.pendingApprovals}</div>
              <Shield className="w-8 h-8 text-muted-foreground opacity-50" />
            </div>
            <Link href="/approvals" className="text-xs text-accent mt-4 inline-block hover:underline uppercase font-bold">
              Review Actions →
            </Link>
          </PixelCard>

          <PixelCard title="Compute Cost">
            <div className="flex items-center justify-between">
              <div className="text-4xl font-display text-muted-foreground">
                ${(overview.monthlyCostCents / 100).toFixed(2)}
              </div>
              <DollarSign className="w-8 h-8 text-muted-foreground opacity-50" />
            </div>
            <div className="text-xs text-muted-foreground mt-4 uppercase font-bold">
              Current Month
            </div>
          </PixelCard>
        </div>

        {/* Audit Log */}
        <div>
          <h2 className="font-display text-lg mb-4 uppercase">Recent Activity</h2>
          <PixelCard className="p-0">
            {overview.recentEvents.length === 0 ? (
              <div className="p-8 text-center text-muted-foreground text-sm uppercase">No recent activity detected.</div>
            ) : (
              <div className="divide-y-4 divide-border">
                {overview.recentEvents.map((event) => (
                  <div key={event.id} className="p-4 hover:bg-muted/30 transition-colors flex items-start gap-4">
                    <div className="mt-1 shrink-0">
                      <Clock className="w-4 h-4 text-muted-foreground" />
                    </div>
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <Badge variant="outline">{event.kind}</Badge>
                        <span className="text-xs text-muted-foreground">
                          {new Date(event.createdAt).toLocaleTimeString()}
                        </span>
                      </div>
                      <p className="text-sm font-bold">{event.summary}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </PixelCard>
        </div>
      </div>
    </Shell>
  );
}
