import { describe, expect, it } from "vitest";
import {
  TASK_DETAIL_DIALOG_CLASS,
  TASK_DETAIL_TEXT_CLASS,
} from "./TasksPage";

describe("task detail responsive layout contract", () => {
  it("preserves line breaks and wraps unbroken content", () => {
    expect(TASK_DETAIL_TEXT_CLASS).toContain("whitespace-pre-wrap");
    expect(TASK_DETAIL_TEXT_CLASS).toContain("[overflow-wrap:anywhere]");
    expect(TASK_DETAIL_TEXT_CLASS).toContain("min-w-0");
    expect(TASK_DETAIL_TEXT_CLASS).toContain("max-w-full");
  });

  it("constrains the shared dialog on narrow and desktop screens", () => {
    expect(TASK_DETAIL_DIALOG_CLASS).toContain("w-[calc(100vw-2rem)]");
    expect(TASK_DETAIL_DIALOG_CLASS).toContain("max-w-2xl");
    expect(TASK_DETAIL_DIALOG_CLASS).toContain("overflow-x-hidden");
  });
});