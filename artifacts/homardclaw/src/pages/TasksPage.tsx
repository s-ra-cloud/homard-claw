import React, { useState } from "react";
import { useListTasks, useCreateTask, useListAgents, TaskStatus, TaskInputProviderOverride } from "@workspace/api-client-react";
import { Shell } from "@/components/layout/Shell";
import { PixelCard } from "@/components/ui/pixel-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Activity, Play, Plus, Clock, AlertTriangle, CheckCircle } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatDistanceToNow } from "date-fns";

export default function TasksPage() {
  const { data: tasks, isLoading: tasksLoading } = useListTasks();
  const { data: agents, isLoading: agentsLoading } = useListAgents();
  const queryClient = useQueryClient();
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  
  const [newTask, setNewTask] = useState({
    agentId: "",
    objective: "",
    providerOverride: "" as TaskInputProviderOverride | ""
  });

  const createTask = useCreateTask({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: ["/api/tasks"] });
        queryClient.invalidateQueries({ queryKey: ["/api/office/overview"] });
        setIsDialogOpen(false);
        setNewTask({ agentId: "", objective: "", providerOverride: "" });
      }
    }
  });

  const handleCreateTask = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTask.agentId || !newTask.objective) return;
    
    createTask.mutate({
      data: {
        agentId: newTask.agentId,
        objective: newTask.objective,
        ...(newTask.providerOverride ? { providerOverride: newTask.providerOverride } : {})
      }
    });
  };

  const getStatusBadge = (status: TaskStatus) => {
    switch (status) {
      case 'queued': return <Badge variant="outline">Queued</Badge>;
      case 'running': return <Badge variant="success" className="animate-pulse">Running</Badge>;
      case 'waiting_approval': return <Badge variant="warning">Awaiting Approval</Badge>;
      case 'paused': return <Badge variant="default">Paused</Badge>;
      case 'completed': return <Badge variant="accent">Complete</Badge>;
      case 'failed': return <Badge variant="destructive">Failed</Badge>;
      default: return <Badge variant="default">{status}</Badge>;
    }
  };

  const getStatusIcon = (status: TaskStatus) => {
    switch (status) {
      case 'queued': return <Clock className="w-5 h-5 text-muted-foreground" />;
      case 'running': return <Activity className="w-5 h-5 text-green-500 animate-pulse" />;
      case 'waiting_approval': return <AlertTriangle className="w-5 h-5 text-yellow-500" />;
      case 'completed': return <CheckCircle className="w-5 h-5 text-accent" />;
      case 'failed': return <AlertTriangle className="w-5 h-5 text-destructive" />;
      default: return <Activity className="w-5 h-5 text-muted-foreground" />;
    }
  };

  return (
    <Shell>
      <div className="p-4 sm:p-6 lg:p-8 max-w-7xl mx-auto space-y-6 sm:space-y-8">
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-4 border-b-4 border-border pb-6">
          <div>
            <h1 className="font-display text-lg sm:text-2xl text-foreground uppercase mb-2">Task Queue</h1>
            <p className="text-muted-foreground text-sm">Monitor and dispatch jobs to the workforce.</p>
          </div>
          
          <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
            <DialogTrigger asChild>
              <Button variant="primary">
                <Play className="w-4 h-4 mr-2" />
                Dispatch Task
              </Button>
            </DialogTrigger>
            <DialogContent className="border-4 border-border bg-card p-0 rounded-none max-w-xl">
              <div className="border-b-4 border-border p-4 bg-muted/30">
                <DialogTitle className="font-display uppercase text-lg">New Task Directive</DialogTitle>
              </div>
              <form onSubmit={handleCreateTask} className="p-6 space-y-6">
                
                <div className="space-y-2">
                  <label className="uppercase font-bold text-xs">Assign to Agent</label>
                  <Select 
                    value={newTask.agentId} 
                    onValueChange={(val) => setNewTask({...newTask, agentId: val})}
                  >
                    <SelectTrigger className="bg-background border-4 border-border rounded-none focus:ring-0 focus:border-primary font-mono text-sm uppercase">
                      <SelectValue placeholder="Select an available agent..." />
                    </SelectTrigger>
                    <SelectContent className="border-4 border-border rounded-none bg-card">
                      {agents?.filter(a => a.status !== 'error').map(agent => (
                        <SelectItem key={agent.id} value={agent.id} className="font-mono text-xs uppercase focus:bg-primary focus:text-primary-foreground">
                          {agent.name} [{agent.status}]
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <label className="uppercase font-bold text-xs">Objective</label>
                  <Textarea 
                    value={newTask.objective}
                    onChange={(e) => setNewTask({...newTask, objective: e.target.value})}
                    placeholder="E.g. Analyze the latest sales report and extract key metrics..."
                    rows={4}
                    className="font-mono text-sm bg-background border-4 border-border rounded-none focus-visible:ring-0 focus-visible:border-primary resize-none" 
                  />
                </div>

                <div className="space-y-2">
                  <label className="uppercase font-bold text-xs flex justify-between">
                    <span>Provider Override</span>
                    <span className="text-muted-foreground font-normal">(Optional)</span>
                  </label>
                  <Select 
                    value={newTask.providerOverride || "none"} 
                    onValueChange={(val) => setNewTask({...newTask, providerOverride: val === "none" ? "" : val as TaskInputProviderOverride})}
                  >
                    <SelectTrigger className="bg-background border-4 border-border rounded-none focus:ring-0 focus:border-primary font-mono text-sm uppercase">
                      <SelectValue placeholder="Use agent default" />
                    </SelectTrigger>
                    <SelectContent className="border-4 border-border rounded-none bg-card">
                      <SelectItem value="none" className="font-mono text-xs uppercase focus:bg-primary focus:text-primary-foreground">Agent Default</SelectItem>
                      <SelectItem value={TaskInputProviderOverride.claude_max} className="font-mono text-xs uppercase focus:bg-primary focus:text-primary-foreground">Claude Max</SelectItem>
                      <SelectItem value={TaskInputProviderOverride.openrouter} className="font-mono text-xs uppercase focus:bg-primary focus:text-primary-foreground">OpenRouter</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="pt-4 border-t-4 border-border flex justify-end gap-4">
                  <Button type="button" variant="outline" onClick={() => setIsDialogOpen(false)}>CANCEL</Button>
                  <Button 
                    type="submit" 
                    variant="primary" 
                    disabled={createTask.isPending || !newTask.agentId || !newTask.objective}
                  >
                    {createTask.isPending ? "DISPATCHING..." : "DISPATCH"}
                  </Button>
                </div>
              </form>
            </DialogContent>
          </Dialog>
        </div>

        {tasksLoading ? (
          <div className="space-y-4">
            {[1, 2, 3].map(i => (
              <PixelCard key={i} className="animate-pulse h-24 bg-muted/50">
                <div className="w-full h-full"></div>
              </PixelCard>
            ))}
          </div>
        ) : !tasks || tasks.length === 0 ? (
          <PixelCard className="text-center p-6 sm:p-12">
            <div className="flex justify-center mb-6 opacity-50">
              <Activity className="w-16 h-16 text-muted-foreground" />
            </div>
            <h3 className="font-display text-lg uppercase mb-2">Queue Empty</h3>
            <p className="text-muted-foreground mb-6">No tasks are currently running or queued.</p>
            <Button variant="primary" onClick={() => setIsDialogOpen(true)}>Dispatch First Task</Button>
          </PixelCard>
        ) : (
          <div className="space-y-4">
            {tasks.map((task) => (
              <PixelCard 
                key={task.id} 
                variant={task.status === 'failed' ? 'destructive' : task.status === 'running' ? 'primary' : 'default'}
                className="flex flex-col md:flex-row gap-6 p-6"
              >
                <div className="flex flex-col items-center justify-center shrink-0 border-r-4 border-border/50 pr-6 mr-2 hidden md:flex">
                  <div className="bg-muted p-3 border-2 border-border/50 pixel-shadow mb-2">
                    {getStatusIcon(task.status)}
                  </div>
                  <div className="text-[10px] font-mono text-muted-foreground uppercase">{task.id.slice(0, 8)}</div>
                </div>
                
                <div className="flex-1 space-y-4">
                  <div className="flex justify-between items-start">
                    <div>
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-xs font-bold text-accent uppercase tracking-wider">Assigned: {task.agentName}</span>
                        <span className="text-muted-foreground text-[10px]">
                          • {formatDistanceToNow(new Date(task.createdAt), { addSuffix: true })}
                        </span>
                      </div>
                      <p className="font-mono text-sm line-clamp-2">{task.objective}</p>
                    </div>
                    <div className="shrink-0 ml-4 hidden sm:block">
                      {getStatusBadge(task.status)}
                    </div>
                  </div>
                  
                  <div className="flex flex-wrap items-center gap-4 border-t-4 border-border/30 pt-3">
                    <div className="sm:hidden mb-2 w-full">
                      {getStatusBadge(task.status)}
                    </div>
                    {task.provider && (
                      <div className="text-[10px] bg-muted px-2 py-1 uppercase font-bold text-muted-foreground border-2 border-border/50">
                        Via: {task.provider}
                      </div>
                    )}
                  </div>
                </div>
              </PixelCard>
            ))}
          </div>
        )}
      </div>
    </Shell>
  );
}
