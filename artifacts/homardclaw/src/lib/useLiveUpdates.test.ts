import { describe, expect, it, vi } from "vitest";
import { subscribeToLiveUpdates } from "./useLiveUpdates";

class FakeDocument {
  visibilityState: DocumentVisibilityState = "visible";
  private listener: (() => void) | undefined;

  addEventListener(_type: string, listener: EventListenerOrEventListenerObject) {
    this.listener = listener as () => void;
  }

  removeEventListener(
    _type: string,
    listener: EventListenerOrEventListenerObject,
  ) {
    if (this.listener === listener) this.listener = undefined;
  }

  setVisibility(state: DocumentVisibilityState) {
    this.visibilityState = state;
    this.listener?.();
  }
}

class FakeEventSource {
  readyState = 1;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  close = vi.fn();
}

function setup() {
  const document = new FakeDocument();
  const streams: FakeEventSource[] = [];
  const invalidateQueries = vi.fn();
  const cleanup = subscribeToLiveUpdates(
    { invalidateQueries } as never,
    {
      document: document as never,
      createEventSource: () => {
        const stream = new FakeEventSource();
        streams.push(stream);
        return stream;
      },
      eventSourceClosed: 2,
      setTimeout,
      clearTimeout,
      baseUrl: "/",
    },
  );
  return { cleanup, document, streams, invalidateQueries };
}

describe("live update lifecycle", () => {
  it("immediately refreshes agent caches and opens only one stream when a hidden tab returns", () => {
    const state = setup();
    expect(state.streams).toHaveLength(1);

    state.document.setVisibility("hidden");
    expect(state.streams[0].close).toHaveBeenCalledOnce();
    expect(state.invalidateQueries).not.toHaveBeenCalled();

    state.document.setVisibility("visible");
    expect(state.streams).toHaveLength(2);
    expect(state.invalidateQueries).toHaveBeenCalledOnce();

    const predicate = state.invalidateQueries.mock.calls[0][0].predicate;
    expect(predicate({ queryKey: ["/api/agents"] })).toBe(true);
    expect(predicate({ queryKey: ["/api/office/overview"] })).toBe(true);
    expect(predicate({ queryKey: ["/unrelated"] })).toBe(false);

    state.document.setVisibility("visible");
    expect(state.streams).toHaveLength(2);
    state.cleanup();
  });

  it("refreshes stale caches when a dropped stream reconnects", () => {
    vi.useFakeTimers();
    const state = setup();
    state.streams[0].readyState = 2;
    state.streams[0].onerror?.(new Event("error"));

    expect(state.invalidateQueries).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2_000);
    expect(state.streams).toHaveLength(2);
    expect(state.invalidateQueries).toHaveBeenCalledOnce();

    state.cleanup();
    vi.useRealTimers();
  });
});