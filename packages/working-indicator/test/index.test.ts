import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
  events,
  type SubagentActivitySnapshot,
  type SubagentsStatusEvent,
} from "../../../shared/events.js";
import workingIndicatorExtension, { SubagentActivityComponent } from "../index.js";

type Handler = (...args: any[]) => any;

type Harness = ReturnType<typeof harness>;

function snapshot(overrides: Partial<SubagentActivitySnapshot> = {}): SubagentActivitySnapshot {
  return {
    id: "scout-1",
    name: "scout",
    profileClass: "read",
    status: "running",
    task: "Follow-up read-only inspection",
    elapsedMs: 3_631_000,
    effectiveModel: "openai-codex/gpt-5.6-luna",
    effectiveThinking: "low",
    latestActivity: "grep finished",
    ...overrides,
  };
}

function status(agents: SubagentActivitySnapshot[]): SubagentsStatusEvent {
  const active = agents.filter((agent) =>
    ["queued", "starting", "running", "blocked"].includes(agent.status),
  );
  return {
    active: active.length,
    blocked: agents.filter((agent) => agent.status === "blocked").length,
    parked: agents.filter((agent) => agent.status === "parked").length,
    failed: agents.filter((agent) => agent.status === "failed").length,
    writers: active.filter((agent) => agent.profileClass === "write").length,
    total: agents.length,
    agents,
  };
}

function theme(): Theme {
  return {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as Theme;
}

function harness() {
  const handlers = new Map<string, Handler[]>();
  const bus = new Map<string, Handler[]>();
  const tui = { requestRender: vi.fn() };
  const widgetTheme = theme();
  let widget: SubagentActivityComponent | undefined;

  const ui = {
    setWidget: vi.fn(
      (
        _key: string,
        factory:
          | ((
              tui: typeof import("@earendil-works/pi-tui"),
              theme: Theme,
            ) => SubagentActivityComponent)
          | undefined,
      ) => {
        widget = factory?.(tui as never, widgetTheme);
      },
    ),
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
    tui,
    widget: () => widget,
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
    expect(subject.widget()).toBeInstanceOf(SubagentActivityComponent);
  });

  it("shows compact subagent activity without a triangle while native spinner stays active", async () => {
    const subject = harness();
    await emit(subject, "session_start");

    subject.emitExtensionEvent(events.subagentsStatus, status([snapshot()]));

    expect(subject.ui.setWorkingVisible).toHaveBeenLastCalledWith(true);
    expect(subject.ui.setWorkingMessage).toHaveBeenLastCalledWith("Hackler hackeln...");
    const output = subject.widget()?.render(120).join("\n") ?? "";
    expect(output).toContain("Subagents · 1 active");
    expect(output).toContain("└─ Follow-up read-only inspection");
    expect(output).toContain("read · running · luna · 60:31 · grep finished");
    expect(output).not.toMatch(/[△▵▴▲]/u);
  });

  it("shows a waiting message for blocked Subagents and restores the idle message", async () => {
    const subject = harness();
    await emit(subject, "session_start");

    subject.emitExtensionEvent(events.subagentsStatus, status([snapshot({ status: "blocked" })]));
    expect(subject.ui.setWorkingMessage).toHaveBeenLastCalledWith("Hackler warten auf Polier....");

    subject.emitExtensionEvent(events.subagentsStatus, status([]));
    expect(subject.ui.setWorkingVisible).toHaveBeenLastCalledWith(true);
    expect(subject.ui.setWorkingMessage).toHaveBeenLastCalledWith("Hackeln...");
  });

  it("strips terminal controls from child activity", async () => {
    const subject = harness();
    await emit(subject, "session_start");
    subject.emitExtensionEvent(
      events.subagentsStatus,
      status([
        snapshot({
          task: "Inspect \u001b]0;spoofed\u0007 auth",
          latestActivity: "reading \u001b[31msecret\u001b[0m",
        }),
      ]),
    );

    const output = subject.widget()?.render(120).join("\n") ?? "";
    expect(output).toContain("Inspect auth");
    expect(output).toContain("reading secret");
    expect(output).not.toContain("spoofed");
    expect(output).not.toContain("\u001b");
  });

  it("restores the normal spinner configuration on shutdown", async () => {
    vi.useFakeTimers();
    try {
      const subject = harness();
      await emit(subject, "session_start");
      subject.emitExtensionEvent(events.subagentsStatus, status([snapshot()]));
      const rendersBeforeShutdown = subject.tui.requestRender.mock.calls.length;

      await emit(subject, "session_shutdown");
      vi.advanceTimersByTime(1_500);

      expect(subject.ui.setWidget).toHaveBeenLastCalledWith(
        "pi-extensions:subagent-working",
        undefined,
      );
      expect(subject.ui.setWorkingVisible).toHaveBeenLastCalledWith(true);
      expect(subject.ui.setWorkingMessage).toHaveBeenLastCalledWith();
      expect(subject.ui.setWorkingIndicator).toHaveBeenLastCalledWith();
      expect(subject.tui.requestRender).toHaveBeenCalledTimes(rendersBeforeShutdown);
    } finally {
      vi.useRealTimers();
    }
  });
});
