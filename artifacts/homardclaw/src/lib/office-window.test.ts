/**
 * OAuth providers (GitHub, Google) forbid being framed, so starting a
 * connected-app sign-in from inside the office parchment iframe must escape
 * to the top-level browsing context instead of loading the provider in the
 * frame. From a normal full page the navigation stays in the same window.
 */
import { describe, expect, it } from "vitest";
import {
  OFFICE_WINDOW_NAME,
  isOfficeWindowFrame,
  navigateToExternal,
  type OfficeFrameWindow,
} from "./office-window";

type FakeWindow = OfficeFrameWindow & {
  location: { href: string; assign: (url: string) => void };
  assignedUrls: string[];
};

/** A top-level browsing context: `self === top`. */
function makeTopLevelWindow(name = ""): FakeWindow {
  const assignedUrls: string[] = [];
  const win: FakeWindow = {
    self: undefined,
    top: null,
    name,
    location: {
      href: "about:blank",
      assign(url: string) {
        assignedUrls.push(url);
      },
    },
    assignedUrls,
  };
  win.self = win;
  win.top = win;
  return win;
}

/** A child frame of `top`, e.g. the office parchment iframe. */
function makeFrame(top: OfficeFrameWindow["top"], name: string): FakeWindow {
  const assignedUrls: string[] = [];
  const win: FakeWindow = {
    self: undefined,
    top,
    name,
    location: {
      href: "about:blank",
      assign(url: string) {
        assignedUrls.push(url);
      },
    },
    assignedUrls,
  };
  win.self = win;
  return win;
}

const AUTH_URL = "https://github.com/login/oauth/authorize?client_id=abc";

describe("isOfficeWindowFrame", () => {
  it("is true only for the named frame inside another window", () => {
    const top = makeTopLevelWindow();
    expect(isOfficeWindowFrame(makeFrame(top, OFFICE_WINDOW_NAME))).toBe(true);
  });

  it("is false for a top-level window even if it carries the name", () => {
    expect(isOfficeWindowFrame(makeTopLevelWindow(OFFICE_WINDOW_NAME))).toBe(
      false,
    );
  });

  it("is false for an unrelated iframe with a different name", () => {
    const top = makeTopLevelWindow();
    expect(isOfficeWindowFrame(makeFrame(top, "some-other-frame"))).toBe(false);
  });

  it("is false when no window exists (non-browser environment)", () => {
    expect(isOfficeWindowFrame(undefined)).toBe(false);
  });
});

describe("navigateToExternal", () => {
  it("navigates the same window on the normal full-page route", () => {
    const win = makeTopLevelWindow();
    navigateToExternal(AUTH_URL, win);
    expect(win.assignedUrls).toEqual([AUTH_URL]);
    expect(win.location.href).toBe("about:blank");
  });

  it("escapes the parchment frame to the top-level browsing context", () => {
    const top = makeTopLevelWindow();
    const frame = makeFrame(top, OFFICE_WINDOW_NAME);
    navigateToExternal(AUTH_URL, frame);
    expect(top.location.href).toBe(AUTH_URL);
    // The provider page must never be attempted inside the iframe.
    expect(frame.assignedUrls).toEqual([]);
    expect(top.assignedUrls).toEqual([]);
  });

  it("stays in-window for iframes that are not the parchment frame", () => {
    const top = makeTopLevelWindow();
    const frame = makeFrame(top, "embedded-preview");
    navigateToExternal(AUTH_URL, frame);
    expect(frame.assignedUrls).toEqual([AUTH_URL]);
    expect(top.location.href).toBe("about:blank");
  });

  it("falls back to the frame when the top window is unavailable", () => {
    const frame = makeFrame(null, OFFICE_WINDOW_NAME);
    // A null top still counts as framed (self !== top); navigation must not throw.
    navigateToExternal(AUTH_URL, frame);
    expect(frame.assignedUrls).toEqual([AUTH_URL]);
  });

  it("falls back to the frame when the top window rejects the navigation", () => {
    const hostileTop: OfficeFrameWindow["top"] = {
      location: Object.defineProperty({} as { href: string }, "href", {
        set() {
          throw new Error("SecurityError: navigation blocked");
        },
      }),
    };
    const frame = makeFrame(hostileTop, OFFICE_WINDOW_NAME);
    navigateToExternal(AUTH_URL, frame);
    expect(frame.assignedUrls).toEqual([AUTH_URL]);
  });

  it("does nothing when no window exists (non-browser environment)", () => {
    expect(() => navigateToExternal(AUTH_URL, undefined)).not.toThrow();
  });
});
