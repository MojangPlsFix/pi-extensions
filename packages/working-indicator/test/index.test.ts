import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { events, type SubagentsStatusEvent } from "../../../shared/events.js";
import workingIndicatorExtension from "../index.js";

type Handler = (...args: any[]) => any;

type Harness = ReturnType<typeof harness>;

function status(overrides: Partial<SubagentsStatusEvent> = {}): SubagentsStatusEvent {
  return {
    active: 0,
    blocked: 0,
    parked: 0,
    failed: 0,
    writers: 0,
    total: 0,
    agents: [],
    ...overrides,
  };
}

function harness() {
  const handlers = new Map<string, Handler[]>();
  const bus = new Map<string, Handler[]>();
  const ui = {
    setWorkingIndicator: vi.fn(),
    setWorkingMessage: vi.fn(),
    setWorkingVisible: vi.fn(),
  };
  const context = { ui } as unknown as ExtensionContext;
  const api = {
    on(name: string, handler: Handler) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    events: {
      on(name: string, handler: Handler) {
        bus.set(name, [...(bus.get(name) ?? []), handler]);
        return () => {
          bus.set(
            name,
            (bus.get(name) ?? []).filter((registered) => registered !== handler),
          );
        };
      },
    },
  } as unknown as ExtensionAPI;

  workingIndicatorExtension(api);

  return {
    context,
    handlers,
    ui,
    emitExtensionEvent(name: string, data: unknown) {
      for (const handler of bus.get(name) ?? []) handler(data);
    },
  };
}

async function emit(subject: Harness, name: string): Promise<void> {
  for (const handler of subject.handlers.get(name) ?? [])
    await handler({}, subject.context as ExtensionContext);
}

describe("working indicator lifecycle", () => {
  it("uses Pi's normal spinner and Hackeln message on session start", async () => {
    const subject = harness();

    await emit(subject, "session_start");

    expect(subject.ui.setWorkingVisible).toHaveBeenLastCalledWith(true);
    expect(subject.ui.setWorkingMessage).toHaveBeenLastCalledWith("Hackeln...");
    expect(subject.ui.setWorkingIndicator).toHaveBeenLastCalledWith();
  });

  it("shows the normal loading row while native Subagents work", async () => {
    const subject = harness();
    await emit(subject, "session_start");

    subject.emitExtensionEvent(events.subagentsStatus, status({ active: 2, total: 2 }));

    expect(subject.ui.setWorkingVisible).toHaveBeenLastCalledWith(true);
    expect(subject.ui.setWorkingMessage).toHaveBeenLastCalledWith("Hackler hackeln...");
    expect(subject.ui.setWorkingIndicator).toHaveBeenCalled();
  });

  it("shows a waiting message for blocked Subagents and restores the idle message", async () => {
    const subject = harness();
    await emit(subject, "session_start");

    subject.emitExtensionEvent(events.subagentsStatus, status({ active: 1, blocked: 1, total: 1 }));
    expect(subject.ui.setWorkingMessage).toHaveBeenLastCalledWith("Hackler warten auf Polier....");

    subject.emitExtensionEvent(events.subagentsStatus, status());
    expect(subject.ui.setWorkingVisible).toHaveBeenLastCalledWith(true);
    expect(subject.ui.setWorkingMessage).toHaveBeenLastCalledWith("Hackeln...");
  });

  it("restores the normal spinner configuration on shutdown", async () => {
    const subject = harness();
    await emit(subject, "session_start");
    subject.emitExtensionEvent(events.subagentsStatus, status({ active: 1, total: 1 }));

    await emit(subject, "session_shutdown");

    expect(subject.ui.setWorkingVisible).toHaveBeenLastCalledWith(true);
    expect(subject.ui.setWorkingMessage).toHaveBeenLastCalledWith();
    expect(subject.ui.setWorkingIndicator).toHaveBeenLastCalledWith();
  });
});
