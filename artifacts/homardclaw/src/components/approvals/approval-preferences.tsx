import {
  useGetApprovalSettings,
  useUpdateApprovalSettings,
  getGetApprovalSettingsQueryKey,
  type ApprovalSettings,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";

const RETRY_LIMIT_OPTIONS = [1, 2, 3] as const;

function apiErrorMessage(error: unknown, fallback: string): string {
  return (
    (error as { response?: { data?: { error?: string } } })?.response?.data
      ?.error ?? fallback
  );
}

/**
 * Shared workspace-wide approval preferences — read and written through the
 * same `/approvals/settings` endpoint the automatic reviewer selection
 * already uses. Mounting this on both the task board and the approval board
 * gives them the same live-synced state: an update from either page is
 * pushed to the other over the existing SSE "approvals" topic.
 */
function useApprovalPreferences() {
  const { data: settings } = useGetApprovalSettings();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const update = useUpdateApprovalSettings({
    mutation: {
      onSuccess: (updated: ApprovalSettings) => {
        queryClient.setQueryData(getGetApprovalSettingsQueryKey(), updated);
      },
      onError: (error) => {
        toast({
          variant: "destructive",
          title: "Could not change the approval preference",
          description: apiErrorMessage(error, "Try again."),
        });
      },
    },
  });

  return { settings, update };
}

/**
 * "Always approve everything": every new task run, connected-app action,
 * and continuation is approved the instant it would otherwise land on the
 * approval desk. Rendered on both boards; toggling it from either updates
 * the other immediately.
 */
export function AlwaysApproveSwitch({ idPrefix }: { idPrefix: string }) {
  const { settings, update } = useApprovalPreferences();
  if (!settings) return null;
  return (
    <div className="flex items-start justify-between gap-3">
      <label
        htmlFor={`${idPrefix}-always-approve`}
        className="text-[10px] font-mono uppercase text-muted-foreground"
      >
        Always approve everything
        <span className="block normal-case text-muted-foreground/80">
          New approval requests — task runs, connected-app actions, and
          continuations — are approved the instant they are created.
        </span>
      </label>
      <Switch
        id={`${idPrefix}-always-approve`}
        checked={settings.alwaysApproveEverything}
        disabled={update.isPending}
        onCheckedChange={(checked) =>
          update.mutate({
            data: {
              reviewerAgentId: settings.reviewerAgentId,
              alwaysApproveEverything: checked,
            },
          })
        }
        data-testid={`switch-${idPrefix}-always-approve`}
      />
    </div>
  );
}

/** Owner-configurable ceiling on automatic attempts for a failed task. */
export function FailedTaskRetryLimitSelect({ idPrefix }: { idPrefix: string }) {
  const { settings, update } = useApprovalPreferences();
  if (!settings) return null;
  return (
    <div className="flex items-start justify-between gap-3">
      <label
        htmlFor={`${idPrefix}-retry-limit`}
        className="text-[10px] font-mono uppercase text-muted-foreground"
      >
        Failed-task retry limit
        <span className="block normal-case text-muted-foreground/80">
          Automatic attempts a failed task gets before it stops retrying.
        </span>
      </label>
      <Select
        value={String(settings.failedTaskRetryLimit)}
        onValueChange={(value) =>
          update.mutate({
            data: {
              reviewerAgentId: settings.reviewerAgentId,
              failedTaskRetryLimit: Number(value),
            },
          })
        }
        disabled={update.isPending}
      >
        <SelectTrigger
          id={`${idPrefix}-retry-limit`}
          className="w-20 rounded-none border-4 border-border bg-background font-mono text-xs uppercase focus:ring-0"
          data-testid={`select-${idPrefix}-retry-limit`}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent className="rounded-none border-4 border-border bg-card">
          {RETRY_LIMIT_OPTIONS.map((limit) => (
            <SelectItem
              key={limit}
              value={String(limit)}
              className="font-mono text-xs uppercase"
            >
              {limit}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
