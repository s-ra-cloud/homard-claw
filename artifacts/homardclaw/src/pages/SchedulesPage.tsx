import React, { useMemo, useState } from "react";
import {
  useListAgents,
  useListSchedules,
  useCreateSchedule,
  useUpdateSchedule,
  useDeleteSchedule,
  type Schedule,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Shell } from "@/components/layout/Shell";
import { PixelCard } from "@/components/ui/pixel-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import {
  CalendarClock,
  Plus,
  Trash2,
  Power,
  Clock,
  AlertTriangle,
  Pencil,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const CADENCES = [
  { value: "once", label: "Once" },
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
] as const;

type Cadence = (typeof CADENCES)[number]["value"];

function cadenceSummary(schedule: Schedule): string {
  if (schedule.cadence === "once") {
    return schedule.runAt
      ? `Once on ${new Date(schedule.runAt).toLocaleString(undefined, { timeZone: schedule.timezone })}`
      : "Once";
  }
  if (schedule.cadence === "daily") return `Daily at ${schedule.timeOfDay}`;
  if (schedule.cadence === "weekly") {
    const days = (schedule.daysOfWeek ?? []).map((d) => WEEKDAYS[d]).join(", ");
    return `Weekly on ${days} at ${schedule.timeOfDay}`;
  }
  return `Monthly on day ${schedule.dayOfMonth} at ${schedule.timeOfDay}`;
}

// datetime-local inputs render in the browser's local time, mirroring how
// `submit()` turns that value back into an absolute instant with `new
// Date(...).toISOString()`.
function toDatetimeLocalValue(value: string | Date): string {
  const date = new Date(value);
  const offsetMs = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
}

function statusBadge(status: string | null | undefined) {
  if (!status) return null;
  const tone =
    status === "completed"
      ? "bg-primary/20 text-primary"
      : status === "failed" || status === "blocked"
        ? "bg-destructive/20 text-destructive"
        : "bg-muted text-muted-foreground";
  return (
    <Badge className={`${tone} uppercase text-[10px]`}>
      last run: {status}
    </Badge>
  );
}

export default function SchedulesPage() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: schedules, isLoading } = useListSchedules({
    query: { queryKey: ["/api/schedules"], refetchInterval: 30_000 },
  });
  // The agents endpoint already excludes retired agents; drop archived ones.
  const { data: agents } = useListAgents();
  const activeAgents = useMemo(
    () => (agents ?? []).filter((agent) => !agent.archived),
    [agents],
  );

  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const emptyForm = () => ({
    name: "",
    agentId: "",
    objective: "",
    priority: "normal" as "low" | "normal" | "high",
    cadence: "daily" as Cadence,
    timezone: browserTz,
    runAt: "",
    timeOfDay: "09:00",
    daysOfWeek: [1, 2, 3, 4, 5] as number[],
    dayOfMonth: 1,
    budgetCents: "",
    notify: {
      onCompleted: true,
      onFailed: true,
      onBlocked: true,
      onApprovalNeeded: true,
    },
  });
  const [form, setForm] = useState(emptyForm);

  const startEdit = (schedule: Schedule) => {
    setEditingId(schedule.id);
    setForm({
      name: schedule.name,
      agentId: schedule.agentId,
      objective: schedule.objective,
      priority: schedule.priority as "low" | "normal" | "high",
      cadence: schedule.cadence as Cadence,
      timezone: schedule.timezone,
      runAt: schedule.runAt ? toDatetimeLocalValue(schedule.runAt) : "",
      timeOfDay: schedule.timeOfDay ?? "09:00",
      daysOfWeek: schedule.daysOfWeek ?? [1, 2, 3, 4, 5],
      dayOfMonth: schedule.dayOfMonth ?? 1,
      budgetCents:
        schedule.budgetCents != null ? String(schedule.budgetCents) : "",
      notify: schedule.notify,
    });
    setShowForm(true);
  };

  const closeForm = () => {
    setShowForm(false);
    setEditingId(null);
  };

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["/api/schedules"] });
  };

  const createSchedule = useCreateSchedule({
    mutation: {
      onSuccess: () => {
        invalidate();
        closeForm();
        setForm(emptyForm());
        toast({ title: "Schedule created" });
      },
      onError: (error) =>
        toast({
          title: "Could not create schedule",
          description: error.message,
          variant: "destructive",
        }),
    },
  });
  const updateSchedule = useUpdateSchedule({
    mutation: {
      onSuccess: (_data, variables) => {
        invalidate();
        // The Pause/Resume toggle also goes through this hook and should
        // keep working without popping the edit panel open or shut.
        if (variables.scheduleId === editingId) {
          closeForm();
          setForm(emptyForm());
          toast({ title: "Schedule updated" });
        }
      },
      onError: (error) =>
        toast({
          title: "Could not update schedule",
          description: error.message,
          variant: "destructive",
        }),
    },
  });
  const deleteSchedule = useDeleteSchedule({
    mutation: {
      onSuccess: invalidate,
      onError: (error) =>
        toast({
          title: "Could not delete schedule",
          description: error.message,
          variant: "destructive",
        }),
    },
  });

  const submit = () => {
    if (
      !form.name.trim() ||
      !form.agentId ||
      form.objective.trim().length < 3
    ) {
      toast({
        title: "Missing details",
        description: "A schedule needs a name, a Crustabot, and an objective.",
        variant: "destructive",
      });
      return;
    }
    if (form.cadence === "once" && !form.runAt) {
      toast({
        title: "Missing run time",
        description: "Pick when the one-time schedule should fire.",
        variant: "destructive",
      });
      return;
    }
    if (form.cadence === "weekly" && form.daysOfWeek.length === 0) {
      toast({
        title: "Missing weekdays",
        description: "Pick at least one day of the week.",
        variant: "destructive",
      });
      return;
    }
    const timing =
      form.cadence === "once"
        ? { runAt: new Date(form.runAt).toISOString() }
        : form.cadence === "weekly"
          ? { timeOfDay: form.timeOfDay, daysOfWeek: form.daysOfWeek }
          : form.cadence === "monthly"
            ? { timeOfDay: form.timeOfDay, dayOfMonth: form.dayOfMonth }
            : { timeOfDay: form.timeOfDay };
    const common = {
      name: form.name.trim(),
      objective: form.objective.trim(),
      priority: form.priority,
      cadence: form.cadence,
      timezone: form.timezone,
      notify: form.notify,
      ...timing,
      ...(form.budgetCents !== "" && Number(form.budgetCents) > 0
        ? { budgetCents: Number(form.budgetCents) }
        : {}),
    };
    if (editingId) {
      updateSchedule.mutate({ scheduleId: editingId, data: common });
    } else {
      createSchedule.mutate({ data: { ...common, agentId: form.agentId } });
    }
  };

  const inputCls =
    "w-full bg-background border-2 border-border px-3 py-2 text-sm focus:outline-none focus:border-primary";

  return (
    <Shell>
      <div className="p-4 sm:p-6 lg:p-8 max-w-5xl mx-auto space-y-6 sm:space-y-8">
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-4 border-b-4 border-border pb-6">
          <div>
            <h1 className="font-display text-lg sm:text-2xl text-foreground uppercase mb-2">
              Duty Roster
            </h1>
            <p className="text-muted-foreground text-sm">
              Put agents on a clock: one-time and recurring work, fired on
              schedule even after a restart.
            </p>
          </div>
          <Button
            onClick={() => {
              if (showForm && !editingId) {
                closeForm();
              } else {
                setEditingId(null);
                setForm(emptyForm());
                setShowForm(true);
              }
            }}
            className="pixel-shadow uppercase text-xs font-bold"
            data-testid="button-new-schedule"
          >
            <Plus className="w-4 h-4 mr-2" />
            {showForm && !editingId ? "Close" : "New Schedule"}
          </Button>
        </div>

        {showForm && (
          <PixelCard className="p-4 sm:p-6 space-y-4">
            {editingId && (
              <p className="text-xs font-bold uppercase text-muted-foreground">
                Editing schedule
              </p>
            )}
            <div className="grid sm:grid-cols-2 gap-4">
              <div>
                <label className="text-xs font-bold uppercase text-muted-foreground block mb-1">
                  Name
                </label>
                <Input
                  value={form.name}
                  maxLength={80}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="Morning briefing"
                  data-testid="input-schedule-name"
                />
              </div>
              <div>
                <label className="text-xs font-bold uppercase text-muted-foreground block mb-1">
                  Crustabot
                </label>
                <select
                  className={inputCls}
                  value={form.agentId}
                  disabled={!!editingId}
                  onChange={(e) =>
                    setForm({ ...form, agentId: e.target.value })
                  }
                  data-testid="select-schedule-agent"
                >
                  <option value="">Choose a Crustabot…</option>
                  {activeAgents.map((agent) => (
                    <option key={agent.id} value={agent.id}>
                      {agent.name} — {agent.title}
                    </option>
                  ))}
                </select>
                {editingId && (
                  <p className="text-[10px] text-muted-foreground mt-1">
                    Delete and recreate the schedule to reassign it.
                  </p>
                )}
              </div>
            </div>
            <div>
              <label className="text-xs font-bold uppercase text-muted-foreground block mb-1">
                Objective
              </label>
              <textarea
                className={`${inputCls} min-h-[80px]`}
                value={form.objective}
                maxLength={5000}
                onChange={(e) =>
                  setForm({ ...form, objective: e.target.value })
                }
                placeholder="Summarize overnight developments and flag anything urgent."
                data-testid="input-schedule-objective"
              />
            </div>
            <div className="grid sm:grid-cols-3 gap-4">
              <div>
                <label className="text-xs font-bold uppercase text-muted-foreground block mb-1">
                  Repeats
                </label>
                <select
                  className={inputCls}
                  value={form.cadence}
                  onChange={(e) =>
                    setForm({ ...form, cadence: e.target.value as Cadence })
                  }
                  data-testid="select-schedule-cadence"
                >
                  {CADENCES.map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </div>
              {form.cadence === "once" ? (
                <div>
                  <label className="text-xs font-bold uppercase text-muted-foreground block mb-1">
                    Run at
                  </label>
                  <input
                    type="datetime-local"
                    className={inputCls}
                    value={form.runAt}
                    onChange={(e) =>
                      setForm({ ...form, runAt: e.target.value })
                    }
                    data-testid="input-schedule-runat"
                  />
                </div>
              ) : (
                <div>
                  <label className="text-xs font-bold uppercase text-muted-foreground block mb-1">
                    Time of day
                  </label>
                  <input
                    type="time"
                    className={inputCls}
                    value={form.timeOfDay}
                    onChange={(e) =>
                      setForm({ ...form, timeOfDay: e.target.value })
                    }
                    data-testid="input-schedule-time"
                  />
                </div>
              )}
              <div>
                <label className="text-xs font-bold uppercase text-muted-foreground block mb-1">
                  Timezone
                </label>
                <Input
                  value={form.timezone}
                  onChange={(e) =>
                    setForm({ ...form, timezone: e.target.value })
                  }
                  placeholder="Europe/Paris"
                  data-testid="input-schedule-timezone"
                />
              </div>
            </div>
            {form.cadence === "weekly" && (
              <div>
                <label className="text-xs font-bold uppercase text-muted-foreground block mb-2">
                  On days
                </label>
                <div className="flex flex-wrap gap-2">
                  {WEEKDAYS.map((day, index) => {
                    const active = form.daysOfWeek.includes(index);
                    return (
                      <button
                        key={day}
                        type="button"
                        onClick={() =>
                          setForm({
                            ...form,
                            daysOfWeek: active
                              ? form.daysOfWeek.filter((d) => d !== index)
                              : [...form.daysOfWeek, index].sort(),
                          })
                        }
                        className={`px-3 py-1 border-2 text-xs font-bold uppercase pixel-shadow ${
                          active
                            ? "bg-primary text-primary-foreground border-primary"
                            : "bg-background text-muted-foreground border-border"
                        }`}
                        data-testid={`toggle-day-${day.toLowerCase()}`}
                      >
                        {day}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
            {form.cadence === "monthly" && (
              <div className="max-w-[10rem]">
                <label className="text-xs font-bold uppercase text-muted-foreground block mb-1">
                  Day of month
                </label>
                <Input
                  type="number"
                  min={1}
                  max={31}
                  value={form.dayOfMonth}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      dayOfMonth: Math.min(
                        31,
                        Math.max(1, Number(e.target.value) || 1),
                      ),
                    })
                  }
                  data-testid="input-schedule-daymonth"
                />
                <p className="text-[10px] text-muted-foreground mt-1">
                  Short months fire on their last day.
                </p>
              </div>
            )}
            <div className="grid sm:grid-cols-2 gap-4">
              <div>
                <label className="text-xs font-bold uppercase text-muted-foreground block mb-1">
                  Priority
                </label>
                <select
                  className={inputCls}
                  value={form.priority}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      priority: e.target.value as "low" | "normal" | "high",
                    })
                  }
                >
                  <option value="low">Low</option>
                  <option value="normal">Normal</option>
                  <option value="high">High</option>
                </select>
              </div>
              <div>
                <label className="text-xs font-bold uppercase text-muted-foreground block mb-1">
                  Budget per run (¢, optional)
                </label>
                <Input
                  type="number"
                  min={1}
                  value={form.budgetCents}
                  onChange={(e) =>
                    setForm({ ...form, budgetCents: e.target.value })
                  }
                  placeholder="No limit"
                  data-testid="input-schedule-budget"
                />
              </div>
            </div>
            <div>
              <label className="text-xs font-bold uppercase text-muted-foreground block mb-2">
                Notify me when a run…
              </label>
              <div className="flex flex-wrap gap-4">
                {(
                  [
                    ["onCompleted", "completes"],
                    ["onFailed", "fails"],
                    ["onBlocked", "is blocked"],
                    ["onApprovalNeeded", "needs approval"],
                  ] as const
                ).map(([key, label]) => (
                  <label key={key} className="flex items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={form.notify[key]}
                      onChange={(e) =>
                        setForm({
                          ...form,
                          notify: { ...form.notify, [key]: e.target.checked },
                        })
                      }
                      data-testid={`checkbox-notify-${key}`}
                    />
                    {label}
                  </label>
                ))}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button
                onClick={submit}
                disabled={createSchedule.isPending || updateSchedule.isPending}
                className="pixel-shadow uppercase text-xs font-bold"
                data-testid="button-create-schedule"
              >
                {editingId
                  ? updateSchedule.isPending
                    ? "Saving…"
                    : "Save Changes"
                  : createSchedule.isPending
                    ? "Creating…"
                    : "Create Schedule"}
              </Button>
              {editingId && (
                <Button
                  variant="outline"
                  onClick={closeForm}
                  className="uppercase text-xs font-bold"
                  data-testid="button-cancel-edit"
                >
                  Cancel
                </Button>
              )}
            </div>
          </PixelCard>
        )}

        {isLoading ? (
          <PixelCard className="p-6 text-sm text-muted-foreground">
            Loading schedules…
          </PixelCard>
        ) : !schedules || schedules.length === 0 ? (
          <PixelCard className="p-8 text-center space-y-2">
            <CalendarClock className="w-8 h-8 mx-auto text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              No schedules yet. Put a Crustabot on the roster and their work
              will run itself.
            </p>
          </PixelCard>
        ) : (
          <div className="space-y-4">
            {schedules.map((schedule) => (
              <PixelCard
                key={schedule.id}
                className={`p-4 sm:p-5 ${schedule.enabled ? "" : "opacity-60"}`}
                data-testid={`card-schedule-${schedule.id}`}
              >
                <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
                  <div className="min-w-0 space-y-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-bold text-sm uppercase">
                        {schedule.name}
                      </span>
                      <Badge className="bg-muted text-muted-foreground uppercase text-[10px]">
                        {schedule.agentName}
                      </Badge>
                      {!schedule.enabled && (
                        <Badge className="bg-destructive/20 text-destructive uppercase text-[10px]">
                          off
                        </Badge>
                      )}
                      {statusBadge(schedule.lastTaskStatus)}
                    </div>
                    <p className="text-sm text-muted-foreground line-clamp-2">
                      {schedule.objective}
                    </p>
                    <div className="flex items-center gap-4 flex-wrap text-[11px] text-muted-foreground">
                      <span className="flex items-center gap-1">
                        <Clock className="w-3 h-3" />
                        {cadenceSummary(schedule)} ({schedule.timezone})
                      </span>
                      {schedule.enabled && schedule.nextRunAt && (
                        <span>
                          next{" "}
                          {formatDistanceToNow(new Date(schedule.nextRunAt), {
                            addSuffix: true,
                          })}
                        </span>
                      )}
                      {schedule.lastRunAt && (
                        <span>
                          last{" "}
                          {formatDistanceToNow(new Date(schedule.lastRunAt), {
                            addSuffix: true,
                          })}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Button
                      variant="outline"
                      size="sm"
                      className="uppercase text-[10px] font-bold"
                      onClick={() => startEdit(schedule)}
                      data-testid={`button-edit-${schedule.id}`}
                    >
                      <Pencil className="w-3 h-3 mr-1" />
                      Edit
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="uppercase text-[10px] font-bold"
                      disabled={updateSchedule.isPending}
                      onClick={() =>
                        updateSchedule.mutate({
                          scheduleId: schedule.id,
                          data: { enabled: !schedule.enabled },
                        })
                      }
                      data-testid={`button-toggle-${schedule.id}`}
                    >
                      <Power className="w-3 h-3 mr-1" />
                      {schedule.enabled ? "Pause" : "Resume"}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="uppercase text-[10px] font-bold text-destructive border-destructive"
                      disabled={deleteSchedule.isPending}
                      onClick={() => {
                        if (
                          window.confirm(`Delete schedule "${schedule.name}"?`)
                        ) {
                          deleteSchedule.mutate({ scheduleId: schedule.id });
                        }
                      }}
                      data-testid={`button-delete-${schedule.id}`}
                    >
                      <Trash2 className="w-3 h-3" />
                    </Button>
                  </div>
                </div>
                {!schedule.enabled &&
                  schedule.cadence === "once" &&
                  schedule.lastRunAt && (
                    <p className="mt-2 text-[11px] text-muted-foreground flex items-center gap-1">
                      <AlertTriangle className="w-3 h-3" />
                      One-time schedules turn off after firing.
                    </p>
                  )}
              </PixelCard>
            ))}
          </div>
        )}
      </div>
    </Shell>
  );
}
