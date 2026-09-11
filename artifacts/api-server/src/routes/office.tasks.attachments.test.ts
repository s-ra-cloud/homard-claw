import { describe, expect, it } from "vitest";
import { CreateTaskBody, DelegateFromTalkBody } from "@workspace/api-zod";

// Content length that a 25 MB source file expands to once base64-encoded
// (ceil(n/3)*4), the shape every binary attachment (images, PDFs) takes.
const MAX_ATTACHMENT_CONTENT_LENGTH = 34_000_000;

function bodyWithAttachmentContent(length: number) {
  return {
    agentId: "agent-1",
    objective: "Review the attached file.",
    attachments: [
      {
        name: "scan.pdf",
        mimeType: "application/pdf",
        encoding: "base64" as const,
        content: "a".repeat(length),
      },
    ],
  };
}

describe("CreateTaskBody attachment size validation", () => {
  it("accepts an attachment right at the 25 MB (base64) boundary", () => {
    const result = CreateTaskBody.safeParse(
      bodyWithAttachmentContent(MAX_ATTACHMENT_CONTENT_LENGTH),
    );
    expect(result.success).toBe(true);
  });

  it("rejects an attachment one character over the boundary", () => {
    const result = CreateTaskBody.safeParse(
      bodyWithAttachmentContent(MAX_ATTACHMENT_CONTENT_LENGTH + 1),
    );
    expect(result.success).toBe(false);
  });

  it("rejects a fifth attachment beyond the 4-file cap", () => {
    const body = bodyWithAttachmentContent(10);
    body.attachments = [
      body.attachments[0],
      body.attachments[0],
      body.attachments[0],
      body.attachments[0],
      body.attachments[0],
    ];
    const result = CreateTaskBody.safeParse(body);
    expect(result.success).toBe(false);
  });
});

describe("DelegateFromTalkBody attachment validation", () => {
  const delegationBody = (length: number) => {
    const task = bodyWithAttachmentContent(length);
    return {
      targetAgentId: "agent-2",
      objective: task.objective,
      attachments: task.attachments,
    };
  };

  it("accepts the same attachment boundary as direct task creation", () => {
    expect(
      DelegateFromTalkBody.safeParse(
        delegationBody(MAX_ATTACHMENT_CONTENT_LENGTH),
      ).success,
    ).toBe(true);
  });

  it("rejects oversized and excess attachments", () => {
    expect(
      DelegateFromTalkBody.safeParse(
        delegationBody(MAX_ATTACHMENT_CONTENT_LENGTH + 1),
      ).success,
    ).toBe(false);
    const body = delegationBody(10);
    body.attachments = Array(5).fill(body.attachments[0]);
    expect(DelegateFromTalkBody.safeParse(body).success).toBe(false);
  });
});
