export const CRUSTABOX_DOCUMENTATION = [
  {
    id: "office",
    title: "The Crustabox office",
    summary:
      "Crustabox is a private AI office presented as a point-and-click submarine on desktop and a conventional workspace on mobile.",
    items: [
      "Click office objects to open Tasks, Schedules, Inbox, Approvals, Reports, Providers, Apps, Memory, Documentation, and the retirement locations.",
      "The red emergency control pauses every active Crustabot and prevents new conversations until it is released.",
      "A working Crustabot animates its assigned computer. Sandboxed Crustabots remain isolated from other Crustabots and connected apps.",
    ],
  },
  {
    id: "crustabots",
    title: "Crustabots",
    summary:
      "Crustabots are configurable AI colleagues with their own roles, instructions, appearance, model routing, permissions, and conversation history.",
    items: [
      "Recruit, duplicate, edit, pause, archive, or permanently retire a Crustabot from the roster.",
      "Each Crustabot may follow workspace provider defaults or use its own provider, model, Codex model, and reasoning level.",
      "Security presets, autonomy, budgets, app grants, knowledge access, and the sensitive-data sandbox control what each Crustabot may do.",
    ],
  },
  {
    id: "talk",
    title: "Talk and delegation",
    summary:
      "Talk provides persistent text conversations, optional voice, attachments, task proposals, and controlled Crustabot-to-Crustabot communication.",
    items: [
      "A task discussed in Talk is queued only after confirmation unless Talk auto-approval is enabled.",
      "A permitted team lead may ask another Crustabot a question, send a message, or propose a task for that specific teammate. The hand-off and reply appear in Inbox.",
      "Delegated tasks receive a bounded context hand-off from the source Crustabot. Sensitive-data sandbox boundaries always block cross-Crustabot communication.",
      "Telegram can link one selected Crustabot for Talk, task notifications, and approval decisions when the bot integration is configured.",
    ],
  },
  {
    id: "tasks",
    title: "Tasks, schedules, and approvals",
    summary:
      "Tasks are durable pieces of work assigned to one Crustabot and executed by the background worker under workspace and policy controls.",
    items: [
      "Create tasks manually, from Talk, through delegation, or from recurring schedules. Attach images and documents when relevant.",
      "Review status, provider/model routing, estimates, token usage, logs, results, blockers, and replicated tasks from the Tasks screen.",
      "Risky or costly actions wait in Approvals unless policy explicitly allows them. Inbox reports task results and approval requests.",
    ],
  },
  {
    id: "providers",
    title: "Providers and models",
    summary:
      "Crustabox supports workspace-scoped Claude Code, OpenRouter, and Codex with ChatGPT provider credentials and routing preferences.",
    items: [
      "Providers holds health, credentials, default models, Codex reasoning, and optional fallback policy.",
      "A Crustabot can inherit those defaults or override them in its personnel file. The Documentation guide works the same way because it is a selected real Crustabot.",
      "Provider credentials are workspace-scoped server secrets; they are not exposed to Crustabot prompts or tools.",
    ],
  },
  {
    id: "memory",
    title: "Memory and knowledge",
    summary:
      "Memory stores durable facts, decisions, procedures, and private or shared context; Knowledge stores uploaded reference files.",
    items: [
      "Create, search, pin, disable, edit, reassign, export, or clear memories from the Memory screen.",
      "Upload knowledge documents and explicitly choose which Crustabots may use each file.",
      "The small library in the submarine opens Documentation. Documentation explains Crustabox itself and is separate from workspace Memory.",
    ],
  },
  {
    id: "apps",
    title: "Connected apps and capabilities",
    summary:
      "Connected Apps and capability packages add controlled external tools without giving Crustabots raw account credentials.",
    items: [
      "Connect supported accounts, enable or disable each app workspace-wide, then grant individual Crustabots read, draft, or action access.",
      "Available integrations can include Gmail, Google Drive, GitHub, Telegram, and vetted capability packages configured by the deployment.",
      "Native Brave web research is available only when its infrastructure key and the Crustabot's permissions allow it.",
    ],
  },
  {
    id: "retirement",
    title: "Retirement Island",
    summary:
      "Retirement is permanent. Retired Crustabots leave active work and relax across the beach and hotel without appearing in both places.",
    items: [
      "Click the island hotel door to enter its lounge and the interior turquoise door to return to the beach.",
      "Up to ten hotel guests use animated reading, music, coffee, arcade, stretching, aquarium, and spa poses.",
      "The submarine offshore returns to the office on desktop.",
    ],
  },
] satisfies Array<{
  id: string;
  title: string;
  summary: string;
  items: string[];
}>;

export function documentationPromptContext(): string {
  return CRUSTABOX_DOCUMENTATION.map(
    (section) =>
      `${section.title}\n${section.summary}\n${section.items.map((item) => `- ${item}`).join("\n")}`,
  ).join("\n\n");
}
