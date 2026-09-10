import { describe, expect, it, vi } from "vitest";
import { checkPinnedCompliance } from "./pinned-compliance";
import type { RuntimeExecuteInput } from "./runtime";

const request = {
  workspaceId: "workspace-1",
  clerkUserId: "user-1",
  provider: "openrouter" as const,
  model: "test-model",
  signal: new AbortController().signal,
  workingDirectory: "/tmp",
};

function runtimeReturning(output: string) {
  return {
    execute: vi.fn(async (_input: RuntimeExecuteInput) => ({
      output,
      inputTokens: 0,
      outputTokens: 0,
    })),
  };
}

describe("checkPinnedCompliance", () => {
  it.each([
    {
      name: "an unrelated positive instruction",
      objective: "Summarize the attached file.",
      pinned: "Confirm an email after sending it.",
      draft: "The file summarizes quarterly results.",
    },
    {
      name: "an untriggered conditional instruction",
      objective: "Summarize the attached file.",
      pinned: "If you send an email, include its recipient in the reply.",
      draft: "The file summarizes quarterly results.",
    },
  ])("accepts $name when the checker finds no applicable violation", async ({
    objective,
    pinned,
    draft,
  }) => {
    const runtime = runtimeReturning("COMPLIANT");

    const verdict = await checkPinnedCompliance({
      runtime,
      request,
      objective,
      pinnedInstructions: pinned,
      draft,
    });

    expect(verdict).toEqual({
      compliant: true,
      reason: null,
      conclusive: true,
    });
    const execution = runtime.execute.mock.calls[0]![0];
    expect(execution.prompt).toContain(`Task objective:\n${objective}`);
    expect(execution.prompt).toContain(pinned);
    expect(execution.prompt).toContain(draft);
    expect(execution.system).toContain(
      "condition is established by the objective or draft",
    );
  });

  it("returns an applicable violation with the checker's grounded reason", async () => {
    const runtime = runtimeReturning(
      "NON-COMPLIANT: The objective requests a public report, but the draft includes customer names contrary to the instruction.",
    );

    const verdict = await checkPinnedCompliance({
      runtime,
      request,
      objective: "Write a public report from the customer notes.",
      pinnedInstructions: "Never include customer names in public reports.",
      draft: "Customer Ada reported a problem.",
    });

    expect(verdict.compliant).toBe(false);
    expect(verdict.conclusive).toBe(true);
    expect(verdict.reason).toContain("objective requests a public report");
    expect(verdict.reason).toContain("draft includes customer names");
  });

  it.each([
    "",
    "The draft probably violates something.",
    "NON-COMPLIANT",
    "NON-COMPLIANT:",
    "COMPLIANT because no email was sent.",
    "COMPLIANT\nNON-COMPLIANT: ambiguous",
  ])("treats malformed output as inconclusive: %j", async (output) => {
    const verdict = await checkPinnedCompliance({
      runtime: runtimeReturning(output),
      request,
      objective: "Summarize the attached file.",
      pinnedInstructions: "Confirm an email after sending it.",
      draft: "The file summarizes quarterly results.",
    });

    expect(verdict).toEqual({
      compliant: true,
      reason: null,
      conclusive: false,
    });
  });
});