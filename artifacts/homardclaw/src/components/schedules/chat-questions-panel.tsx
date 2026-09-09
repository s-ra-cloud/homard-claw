import { useState } from "react";
import {
  useListAgents,
  useListChatQuestionSchedules,
  useCreateChatQuestionSchedule,
  useUpdateChatQuestionSchedule,
  useDeleteChatQuestionSchedule,
  type ChatQuestionSchedule,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { PixelCard } from "@/components/ui/pixel-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import {
  MessageCircleQuestion,
  Plus,
  Trash2,
  Power,
  Clock,
  Pencil,
  Hourglass,
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

function cadenceSummary(schedule: ChatQuestionSchedule): string {
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

export function ChatQuestionsPanel() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: schedules, isLoading } = useListChatQuestionSchedules({
    query: { queryKey: ["/api/chat-question-schedules"], refetchInterval: 30_000 },
  });
  const { data: agents } = useListAgents();
  const activeAgents = (agents ?? []).filter((agent) => !agent.archived);

  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const emptyForm = () => ({
    name: "",
    agentId: "",
    question: "",
    cadence: "daily" as Cadence,
    timezone: browserTz,
    runAt: "",
    timeOfDay: "09:00",
    daysOfWeek: [1, 2, 3, 4, 5] as number[],
    dayOfMonth: 1,
  });
  const [form, setForm] = useState(emptyForm);

  const startEdit = (schedule: ChatQuestionSchedule) => {
    setEditingId(schedule.id);
    setForm({
      name: schedule.name,
      agentId: schedule.agentId,
      question: schedule.question,
      cadence: schedule.cadence as Cadence,
      timezone: schedule.timezone,
      runAt: schedule.runAt ? toDatetimeLocalValue(schedule.runAt) : "",
      timeOfDay: schedule.timeOfDay ?? "09:00",
      daysOfWeek: schedule.daysOfWeek ?? [1, 2, 3, 4, 5],
      dayOfMonth: schedule.dayOfMonth ?? 1,
    });
    setShowForm(true);
  };

  const closeForm = () => {
    setShowForm(false);
    setEditingId(null);
  };

  const invalidate = () => {
    void queryClient.invalidateQueries({
      queryKey: ["/api/chat-question-schedules"],
    });
  };

  const createSchedule = useCreateChatQuestionSchedule({
    mutation: {
      onSuccess: () => {
        invalidate();
        closeForm();
        setForm(emptyForm());
        toast({ title: "Chat question schedule created" });
      },
      onError: (error) =>
        toast({
          title: "Could not create schedule",
          description: error.message,
          variant: "destructive",
        }),
    },
  });
  const updateSchedule = useUpdateChatQuestionSchedule({
    mutation: {
      onSuccess: (_data, variables) => {
        invalidate();
        if (variables.scheduleId === editingId) {
          closeForm();
          setForm(emptyForm());
          toast({ title: "Chat question schedule updated" });
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
  const deleteSchedule = useDeleteChatQuestionSchedule({
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
      form.question.trim().length < 3
    ) {
      toast({
        title: "Missing details",
        description: "A schedule needs a name, a Crustabot, and a question.",
        variant: "destructive",
      });
      return;
    }
    if (form.cadence === "once" && !form.runAt) {
      toast({
        title: "Missing run time",
        description: "Pick when the one-time question should be asked.",
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
      question: form.question.trim(),
      cadence: form.cadence,
      timezone: form.timezone,
      ...timing,
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
    <div className="space-y-6 sm:space-y-8">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <p className="text-muted-foreground text-sm max-w-2xl">
          Put a question on a Crustabot's clock: it appears in Talk at the
          scheduled time and waits there for your reply.
        </p>
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
          className="pixel-shadow uppercase text-xs font-bold shrink-0"
          data-testid="button-new-chat-question-schedule"
        >
          <Plus className="w-4 h-4 mr-2" />
          {showForm && !editingId ? "Close" : "New Question"}
        </Button>
      </div>

      {showForm && (
        <PixelCard className="p-4 sm:p-6 space-y-4">
          {editingId && (
            <p className="text-xs font-bold uppercase text-muted-foreground">
              Editing chat question schedule
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
                placeholder="Weekly check-in"
                data-testid="input-chat-question-schedule-name"
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
                onChange={(e) => setForm({ ...form, agentId: e.target.value })}
                data-testid="select-chat-question-schedule-agent"
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
              Question
            </label>
            <textarea
              className={`${inputCls} min-h-[80px]`}
              value={form.question}
              maxLength={2000}
              onChange={(e) => setForm({ ...form, question: e.target.value })}
              placeholder="How did this week's launch go?"
              data-testid="input-chat-question-schedule-question"
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
                data-testid="select-chat-question-schedule-cadence"
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
                  Ask at
                </label>
                <input
                  type="datetime-local"
                  className={inputCls}
                  value={form.runAt}
                  onChange={(e) => setForm({ ...form, runAt: e.target.value })}
                  data-testid="input-chat-question-schedule-runat"
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
                  data-testid="input-chat-question-schedule-time"
                />
              </div>
            )}
            <div>
              <label className="text-xs font-bold uppercase text-muted-foreground block mb-1">
                Timezone
              </label>
              <Input
                value={form.timezone}
                onChange={(e) => setForm({ ...form, timezone: e.target.value })}
                placeholder="Europe/Paris"
                data-testid="input-chat-question-schedule-timezone"
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
                      data-testid={`toggle-chat-question-day-${day.toLowerCase()}`}
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
                data-testid="input-chat-question-schedule-daymonth"
              />
              <p className="text-[10px] text-muted-foreground mt-1">
                Short months fire on their last day.
              </p>
            </div>
          )}
          <div className="flex items-center gap-2">
            <Button
              onClick={submit}
              disabled={createSchedule.isPending || updateSchedule.isPending}
              className="pixel-shadow uppercase text-xs font-bold"
              data-testid="button-create-chat-question-schedule"
            >
              {editingId
                ? updateSchedule.isPending
                  ? "Saving…"
                  : "Save Changes"
                : createSchedule.isPending
                  ? "Creating…"
                  : "Create Question"}
            </Button>
            {editingId && (
              <Button
                variant="outline"
                onClick={closeForm}
                className="uppercase text-xs font-bold"
                data-testid="button-cancel-edit-chat-question"
              >
                Cancel
              </Button>
            )}
          </div>
        </PixelCard>
      )}

      {isLoading ? (
        <PixelCard className="p-6 text-sm text-muted-foreground">
          Loading chat question schedules…
        </PixelCard>
      ) : !schedules || schedules.length === 0 ? (
        <PixelCard className="p-8 text-center space-y-2">
          <MessageCircleQuestion className="w-8 h-8 mx-auto text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            No chat questions scheduled yet. Put a question on a Crustabot's
            clock and it will ask it for you.
          </p>
        </PixelCard>
      ) : (
        <div className="space-y-4">
          {schedules.map((schedule) => (
            <PixelCard
              key={schedule.id}
              className={`p-4 sm:p-5 ${schedule.enabled ? "" : "opacity-60"}`}
              data-testid={`card-chat-question-schedule-${schedule.id}`}
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
                    {schedule.awaitingResponse && (
                      <Badge className="bg-accent/20 text-accent uppercase text-[10px] flex items-center gap-1">
                        <Hourglass className="w-3 h-3" />
                        awaiting reply
                      </Badge>
                    )}
                  </div>
                  <p className="text-sm text-muted-foreground line-clamp-2">
                    {schedule.question}
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
                        asked{" "}
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
                    data-testid={`button-edit-chat-question-${schedule.id}`}
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
                    data-testid={`button-toggle-chat-question-${schedule.id}`}
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
                        window.confirm(`Delete chat question "${schedule.name}"?`)
                      ) {
                        deleteSchedule.mutate({ scheduleId: schedule.id });
                      }
                    }}
                    data-testid={`button-delete-chat-question-${schedule.id}`}
                  >
                    <Trash2 className="w-3 h-3" />
                  </Button>
                </div>
              </div>
            </PixelCard>
          ))}
        </div>
      )}
    </div>
  );
}
