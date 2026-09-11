import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BUG_REPORT_SUCCESS_DESCRIPTION,
  BUG_REPORT_SUCCESS_TITLE,
  buildBugReportInput,
} from "./TasksPage";

const tasksPage = readFileSync(
  new URL("./TasksPage.tsx", import.meta.url),
  "utf8",
);
const providersPage = readFileSync(
  new URL("./ProvidersPage.tsx", import.meta.url),
  "utf8",
);
const bugReportsPage = readFileSync(
  new URL("./BugReportsPage.tsx", import.meta.url),
  "utf8",
);

describe("task bug report controls", () => {
  it("renders the report action for both non-owner and owner task viewers", () => {
    expect(tasksPage).toContain("<SendBugReportButton task={task} />");
    expect(tasksPage).not.toContain("useGetMe");
    expect(tasksPage).not.toContain("me?.isOwner");
  });

  it("submits the task id and only a trimmed optional description", () => {
    expect(
      buildBugReportInput("task-123", "  The lobster is stuck.  "),
    ).toEqual({
      taskId: "task-123",
      description: "The lobster is stuck.",
    });
    expect(buildBugReportInput("task-123", " \n\t ")).toEqual({
      taskId: "task-123",
    });
    expect(tasksPage).toContain("createBugReport.mutate");
    expect(tasksPage).toContain("buildBugReportInput(task.id, description)");
  });

  it("acknowledges a submitted report without exposing the admin destination", () => {
    expect(BUG_REPORT_SUCCESS_TITLE).toBe("Bug report received");
    expect(BUG_REPORT_SUCCESS_DESCRIPTION).toBe(
      "Thanks for helping us improve HomardClaw.",
    );
    expect(BUG_REPORT_SUCCESS_DESCRIPTION).not.toContain("Providers");
    expect(tasksPage).not.toContain("Saved to Providers");
  });
});

describe("bug report administration access", () => {
  it("keeps the Providers menu card owner-only", () => {
    expect(providersPage).toContain("function BugReportsMenuCard()");
    expect(providersPage).toContain("const { data: me } = useGetMe()");
    expect(providersPage).toContain("if (!me?.isOwner) return null");
    expect(providersPage).toContain('href="/providers/bug-reports"');
  });

  it("keeps the bug report page and data query owner-only", () => {
    expect(bugReportsPage).toContain("const isOwner = me?.isOwner ?? false");
    expect(bugReportsPage).toContain("enabled: isOwner");
    expect(bugReportsPage).toContain(
      "Bug reports are visible to the office owner only.",
    );
  });
});
