import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const testState = {
  isOwner: false,
  stateHooks: [] as Array<{ setState: ReturnType<typeof vi.fn> }>,
  buttons: [] as Array<Record<string, unknown>>,
  toast: vi.fn(),
  mutation: {
    isPending: false,
    mutate: vi.fn(),
  },
  mutationOptions: undefined as
    | {
        mutation?: {
          onSuccess?: () => void;
          onError?: (error: unknown) => void;
        };
      }
    | undefined,
};

vi.doMock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");
  return {
    ...actual,
    useState: (initialState: unknown) => {
      const setState = vi.fn();
      testState.stateHooks.push({ setState });
      return [initialState, setState];
    },
  };
});

vi.doMock("@workspace/api-client-react", async () => {
  const actual = await vi.importActual<
    typeof import("@workspace/api-client-react")
  >("@workspace/api-client-react");
  return {
    ...actual,
    useGetMe: () => ({ data: { isOwner: testState.isOwner } }),
    useCreateBugReport: (options: typeof testState.mutationOptions) => {
      testState.mutationOptions = options;
      return testState.mutation;
    },
  };
});

vi.doMock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: testState.toast }),
}));

vi.doMock("@/components/ui/button", () => ({
  Button: ({
    children,
    ...props
  }: {
    children?: ReactNode;
    [key: string]: unknown;
  }) => {
    testState.buttons.push(props);
    return createElement("button", props, children);
  },
}));

vi.doMock("@/components/ui/dialog", () => ({
  Dialog: ({ children }: { children?: ReactNode }) =>
    createElement("div", null, children),
  DialogTrigger: ({ children }: { children?: ReactNode }) => children,
  DialogContent: ({ children }: { children?: ReactNode }) =>
    createElement("section", null, children),
  DialogTitle: ({ children }: { children?: ReactNode }) =>
    createElement("h2", null, children),
}));

vi.doMock("@/components/ui/textarea", () => ({
  Textarea: (props: Record<string, unknown>) =>
    createElement("textarea", props),
}));

let SendBugReportButton: (props: { task: { id: string } }) => ReactNode;
let TalkBugReportButton: typeof import("@/components/talk/call-view").TalkBugReportButton;
let buildTalkBugReportInput: typeof import("@/components/talk/call-view").buildTalkBugReportInput;

beforeAll(async () => {
  ({ SendBugReportButton } = await import("./TasksPage"));
  ({ TalkBugReportButton, buildTalkBugReportInput } =
    await import("@/components/talk/call-view"));
});

beforeEach(() => {
  testState.stateHooks = [];
  testState.buttons = [];
  testState.toast.mockReset();
  testState.mutation.mutate.mockReset();
  testState.mutationOptions = undefined;
});

function renderReportButton() {
  return renderToStaticMarkup(
    createElement(SendBugReportButton, { task: { id: "task-42" } }),
  );
}

describe("SendBugReportButton component behavior", () => {
  it("renders the report control for an authenticated non-owner and owner", () => {
    testState.isOwner = false;
    const nonOwnerMarkup = renderReportButton();
    testState.isOwner = true;
    const ownerMarkup = renderReportButton();

    expect(nonOwnerMarkup).toContain('data-testid="button-send-bug-report"');
    expect(ownerMarkup).toContain('data-testid="button-send-bug-report"');
  });

  it("submits the current task when SEND is clicked", () => {
    renderReportButton();

    const sendButton = testState.buttons.find(
      (props) => props["data-testid"] === "button-confirm-send-bug-report",
    );
    expect(sendButton?.onClick).toEqual(expect.any(Function));

    (sendButton?.onClick as () => void)();

    expect(testState.mutation.mutate).toHaveBeenCalledWith({
      data: { taskId: "task-42" },
    });
  });

  it("acknowledges success and resets the dialog form", () => {
    renderReportButton();
    testState.mutationOptions?.mutation?.onSuccess?.();

    expect(testState.toast).toHaveBeenCalledWith({
      title: "Bug report received",
      description: "Thanks for helping us improve HomardClaw.",
    });
    expect(testState.stateHooks[0].setState).toHaveBeenCalledWith(false);
    expect(testState.stateHooks[1].setState).toHaveBeenCalledWith("");
  });
});

describe("TalkBugReportButton component behavior", () => {
  const turns = Array.from({ length: 12 }, (_, index) => ({
    role: index % 2 === 0 ? ("user" as const) : ("agent" as const),
    text: `message ${index}`,
    key: `turn-${index}`,
    failed: index === 10,
  }));

  function renderTalkReportButton() {
    return renderToStaticMarkup(
      createElement(TalkBugReportButton, {
        agentId: "agent-7",
        agentName: "Marlow",
        turns,
      }),
    );
  }

  it("renders the Talk report control for an authenticated non-owner and owner", () => {
    testState.isOwner = false;
    const nonOwnerMarkup = renderTalkReportButton();
    testState.isOwner = true;
    const ownerMarkup = renderTalkReportButton();

    expect(nonOwnerMarkup).toContain(
      'data-testid="button-talk-send-bug-report"',
    );
    expect(ownerMarkup).toContain(
      'data-testid="button-talk-send-bug-report"',
    );
  });

  it("submits the selected agent, trimmed description, and bounded successful transcript", () => {
    const input = buildTalkBugReportInput(
      "agent-7",
      "  The reply stopped.  ",
      turns,
    );

    expect(input).toEqual({
      agentId: "agent-7",
      description: "The reply stopped.",
      talkMessages: turns
        .filter((turn) => !turn.failed)
        .slice(-10)
        .map(({ role, text }) => ({ role, text })),
    });
    expect(input.talkMessages).toHaveLength(10);
    expect(buildTalkBugReportInput("agent-7", " \n ", turns)).not.toHaveProperty(
      "description",
    );
  });

  it("uses an account-neutral success confirmation", () => {
    renderTalkReportButton();
    testState.mutationOptions?.mutation?.onSuccess?.();

    expect(testState.toast).toHaveBeenCalledWith({
      title: "Bug report received",
      description: "Thanks for helping us improve HomardClaw.",
    });
  });
});
