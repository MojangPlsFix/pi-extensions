import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { events, type SubagentsStatusEvent } from "../../../shared/events.js";
import { type AgentSnapshot, emptyUsage } from "../../subagents/types.js";
import workingIndicatorExtension, { SubagentActivityComponent } from "../index.js";

type Handler = (...args: any[]) => any;

type Harness = ReturnType<typeof harness>;

function snapshot(overrides: Partial<AgentSnapshot> = {}): AgentSnapshot {
  return {
    id: "explorer-1",
    name: "explorer",
    mode: "explorer",
    status: "running",
    backend: "rpc",
    task: "Trace the authentication request flow",
    taskHistory: ["Trace the authentication request flow"],
    startedAt: "2026-01-01T00:00:00.000Z",
    elapsedMs: 12_000,
    sessionDir: "/tmp/session",
    requestedModel: "openai-codex/gpt-5.6-luna",
    requestedThinking: "low",
    latestActivity: "reading manager.ts",
    activity: [],
    report: "",
    stderr: "",
    usage: emptyUsage(),
    ...overrides,
  };
}

function status(agents: AgentSnapshot[]): SubagentsStatusEvent {
  const running = agents.filter((agent) => agent.status === "running");
  return {
    active: running.length,
    ready: agents.filter((agent) => agent.status === "completed").length,
    open: agents.filter((agent) => ["running", "completed"].includes(agent.status)).length,
    explorers: running.filter((agent) => agent.mode === "explorer").length,
    workers: running.filter((agent) => agent.mode === "worker").length,
    failed: agents.filter((agent) => agent.status === "failed").length,
    interrupted: agents.filter((agent) => agent.status === "interrupted").length,
    closed: agents.filter((agent) => agent.status === "closed").length,
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
  it("restores Pi's default spinner configuration on session start", async () => {
    const subject = harness();

    await emit(subject, "session_start");

    expect(subject.ui.setWorkingVisible).toHaveBeenLastCalledWith(true);
    expect(subject.ui.setWorkingMessage).toHaveBeenLastCalledWith("Hackeln...");
    expect(subject.ui.setWorkingIndicator).toHaveBeenLastCalledWith();
  });

  it("hides the native row while rendering task-first subagent activity", async () => {
    const subject = harness();
    await emit(subject, "session_start");

    subject.emitExtensionEvent(events.subagentsStatus, status([snapshot()]));

    expect(subject.ui.setWorkingVisible).toHaveBeenLastCalledWith(false);
    expect(subject.widget()).toBeInstanceOf(SubagentActivityComponent);
    expect(subject.widget()?.render(120).join("\n")).toContain(
      "Trace the authentication request flow",
    );

    subject.emitExtensionEvent(events.subagentsStatus, status([]));
    expect(subject.ui.setWorkingVisible).toHaveBeenLastCalledWith(true);
    await emit(subject, "session_shutdown");
  });

  it("restores native visibility and disposes the activity widget on shutdown", async () => {
    vi.useFakeTimers();
    try {
      const subject = harness();
      await emit(subject, "session_start");
      subject.emitExtensionEvent(events.subagentsStatus, status([snapshot()]));
      const rendersBeforeShutdown = subject.tui.requestRender.mock.calls.length;

      await emit(subject, "session_shutdown");
      vi.advanceTimersByTime(1_000);

      expect(subject.ui.setWorkingVisible).toHaveBeenLastCalledWith(true);
      expect(subject.ui.setWidget).toHaveBeenLastCalledWith(
        "pi-extensions:subagent-working",
        undefined,
      );
      expect(subject.tui.requestRender).toHaveBeenCalledTimes(rendersBeforeShutdown);

      subject.emitExtensionEvent(events.subagentsStatus, status([snapshot()]));
      expect(subject.ui.setWorkingVisible).toHaveBeenLastCalledWith(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
