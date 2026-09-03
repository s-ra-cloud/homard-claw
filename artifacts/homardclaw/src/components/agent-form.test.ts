/**
 * Form-level regression coverage for connected-app grants:
 *  - every supported app initializes to an explicit "none" (an undefined
 *    entry used to fail the enum check and paint a false red "Required")
 *  - all-No-Access submissions validate and produce an empty grant payload
 *  - mixed grants convert both ways, and edit hydration fills missing apps
 */
import { describe, expect, it } from "vitest";
import {
  GENDER_OPTIONS,
  SUPPORTED_CONNECTED_APPS,
  agentFormSchema,
  appGrantsFormValue,
  appGrantsPayload,
  defaultAppGrants,
  emptyAgentFormValues,
} from "./agent-form";

describe("connected-app form state", () => {
  it("initializes every supported app to an explicit No Access", () => {
    expect(defaultAppGrants()).toEqual({
      gmail: "none",
      google_drive: "none",
      github: "none",
    });
    expect(emptyAgentFormValues.appGrants).toEqual(defaultAppGrants());
  });

  it("validates a blank form with all apps at No Access — no Required errors", () => {
    const result = agentFormSchema.safeParse({
      ...emptyAgentFormValues,
      name: "Test Agent",
      title: "Analyst",
      mission: "Do useful analysis.",
    });
    expect(result.success).toBe(true);
  });

  it("still rejects an undefined grant entry (the old regression)", () => {
    const result = agentFormSchema.safeParse({
      ...emptyAgentFormValues,
      name: "Test Agent",
      title: "Analyst",
      mission: "Do useful analysis.",
      appGrants: { gmail: undefined },
    });
    expect(result.success).toBe(false);
  });

  it("sends no grant rows when everything is No Access", () => {
    expect(
      appGrantsPayload({ ...emptyAgentFormValues, appGrants: defaultAppGrants() }),
    ).toEqual([]);
  });

  it("sends only non-none grants for mixed selections", () => {
    const payload = appGrantsPayload({
      ...emptyAgentFormValues,
      appGrants: { gmail: "draft", google_drive: "none", github: "read" },
    });
    expect(payload).toEqual(
      expect.arrayContaining([
        { app: "gmail", accessLevel: "draft" },
        { app: "github", accessLevel: "read" },
      ]),
    );
    expect(payload).toHaveLength(2);
  });

  it("hydrates edit forms with explicit none for ungranted apps", () => {
    expect(appGrantsFormValue([{ app: "gmail", accessLevel: "write" }])).toEqual({
      gmail: "write",
      google_drive: "none",
      github: "none",
    });
    expect(appGrantsFormValue(undefined)).toEqual(defaultAppGrants());
    expect(appGrantsFormValue([])).toEqual(defaultAppGrants());
  });

  it("keeps the supported list in sync with the API enum", () => {
    expect([...SUPPORTED_CONNECTED_APPS]).toEqual([
      "gmail",
      "google_drive",
      "github",
    ]);
  });
});

describe("gender form state", () => {
  it("defaults blank forms to unspecified", () => {
    expect(emptyAgentFormValues.gender).toBe("unspecified");
  });

  it("offers exactly male, female, and unspecified", () => {
    expect(GENDER_OPTIONS.map((option) => option.value)).toEqual([
      "male",
      "female",
      "unspecified",
    ]);
  });

  it("accepts each supported gender value", () => {
    for (const gender of ["male", "female", "unspecified"] as const) {
      const result = agentFormSchema.safeParse({
        ...emptyAgentFormValues,
        name: "Test Agent",
        title: "Analyst",
        mission: "Do useful analysis.",
        gender,
      });
      expect(result.success).toBe(true);
    }
  });

  it("rejects a gender value outside the supported set", () => {
    const result = agentFormSchema.safeParse({
      ...emptyAgentFormValues,
      name: "Test Agent",
      title: "Analyst",
      mission: "Do useful analysis.",
      gender: "nonbinary",
    });
    expect(result.success).toBe(false);
  });
});
