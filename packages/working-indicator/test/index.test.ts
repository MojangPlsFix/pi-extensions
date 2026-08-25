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
    taskKey: "follow-up-read-only-inspection",
    task: "Follow-up read-only inspection",
    elapsedMs: 3_631_000,
    activeLeaseGeneration: 1,
    ...overrides,
  };
}

function status(agents: SubagentActivitySnapshot[]): SubagentsStatusEvent {
  const active = agents.filter((agent) =>
    ["queued", "starting", "running", "blocked"].includes(agent.status),
  );
  return {
    active: active.length,
    foreground: agents.filter(
      (agent) =>
        !(
          ["parked", "failed", "stopped"].includes(agent.status) &&
          agent.completionAcknowledgedGeneration === agent.activeLeaseGeneration
        ),
    ).length,
    history: agents.filter(
      (agent) =>
        ["parked", "failed", "stopped"].includes(agent.status) &&
        agent.activeLeaseGeneration !== undefined &&
        agent.completionAcknowledgedGeneration === agent.activeLeaseGeneration,
    ).length,
    running: agents.filter((agent) => ["queued", "starting", "running"].includes(agent.status))
      .length,
    wrappingUp: active.filter((agent) => agent.wrappingUp).length,
    blocked: agents.filter((agent) => agent.status === "blocked").length,
    parked: agents.filter((agent) => agent.status === "parked").length,
    failed: agents.filter((agent) => agent.status === "failed").length,
    stopped: agents.filter((agent) => agent.status === "stopped").length,
    writers: active.filter((agent) => agent.profileClass === "write").length,
    total: agents.length,
    capacity: {
      used: active.length,
      limit: 4,
      free: 4 - active.length,
      sharedWritersUsed: active.filter((agent) => agent.profileClass === "write").length,
      sharedWritersLimit: 1,
    },
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
  it("restores Pi's default message without replacing its native spinner", async () => {
    const subject = harness();

    await emit(subject, "session_start");

    expect(subject.ui.setWorkingVisible).toHaveBeenLastCalledWith(true);
    expect(subject.ui.setWorkingMessage).toHaveBeenLastCalledWith();
    expect(subject.ui.setWorkingIndicator).not.toHaveBeenCalled();
    expect(subject.widget()).toBeInstanceOf(SubagentActivityComponent);
  });

  it("shows compact Hackler activity without a triangle while native spinner stays active", async () => {
    const subject = harness();
    await emit(subject, "session_start");

    subject.emitExtensionEvent(events.subagentsStatus, status([snapshot()]));

    expect(subject.ui.setWorkingVisible).toHaveBeenLastCalledWith(true);
    expect(subject.ui.setWorkingMessage).toHaveBeenLastCalledWith("Hackler hackeln...");
    expect(subject.ui.setWorkingIndicator).not.toHaveBeenCalled();
    const output = subject.widget()?.render(160).join("\n") ?? "";
    expect(output).toContain("Hackler · ◐ 1/4 active");
    expect(output).toContain("◐ Follow up read only inspection · working · 60:31");
    expect(output).not.toMatch(/[!●✗△▵▴▲]/u);
  });

  it("shows the legacy waiting message for blocked Hackler runs and restores Pi's default", async () => {
    const subject = harness();
    await emit(subject, "session_start");

    subject.emitExtensionEvent(events.subagentsStatus, status([snapshot({ status: "blocked" })]));
    expect(subject.ui.setWorkingMessage).toHaveBeenLastCalledWith("Subagents waiting for input...");

    subject.emitExtensionEvent(events.subagentsStatus, status([]));
    expect(subject.ui.setWorkingVisible).toHaveBeenLastCalledWith(true);
    expect(subject.ui.setWorkingMessage).toHaveBeenLastCalledWith();
    expect(subject.widget()?.render(120)).toEqual([]);
  });

  it("keeps wrapping-up activity distinguishable", async () => {
    const subject = harness();
    await emit(subject, "session_start");

    subject.emitExtensionEvent(events.subagentsStatus, status([snapshot({ wrappingUp: true })]));

    expect(subject.ui.setWorkingMessage).toHaveBeenLastCalledWith("Hackler wrapping up");
    expect(subject.widget()?.render(120).join("\n")).toContain("wrapping up");
  });

  it("strips terminal controls from child activity", async () => {
    const subject = harness();
    await emit(subject, "session_start");
    subject.emitExtensionEvent(
      events.subagentsStatus,
      status([
        snapshot({
          taskKey: "inspect-\u001b]0;spoofed\u0007-auth",
          currentTool: "read",
          lastAction: "reading \u001b[31msecret\u001b[0m",
        }),
      ]),
    );

    const output = subject.widget()?.render(120).join("\n") ?? "";
    expect(output).toContain("Inspect auth");
    expect(output).toContain("reading secret");
    expect(output).not.toContain("spoofed");
    expect(output).not.toContain("\u001b");
  });

  it("hides History-only activity and stops elapsed refresh", async () => {
    vi.useFakeTimers();
    try {
      const subject = harness();
      await emit(subject, "session_start");
      subject.emitExtensionEvent(events.subagentsStatus, status([snapshot()]));
      subject.emitExtensionEvent(
        events.subagentsStatus,
        status([
          snapshot({
            status: "parked",
            completionAcknowledgedGeneration: 1,
          }),
        ]),
      );
      const renders = subject.tui.requestRender.mock.calls.length;
      expect(subject.widget()?.render(120)).toEqual([]);
      vi.advanceTimersByTime(2_000);
      expect(subject.tui.requestRender).toHaveBeenCalledTimes(renders);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rebuilds themed content after invalidation", () => {
    let prefix = "A:";
    const tui = { requestRender: vi.fn() };
    const dynamicTheme = {
      ...theme(),
      fg: (_color: string, text: string) => `${prefix}${text}`,
    } as Theme;
    const component = new SubagentActivityComponent(tui, dynamicTheme);
    component.update(status([snapshot()]));
    expect(component.render(120).join("\n")).toContain("A:Hackler");
    prefix = "B:";
    component.invalidate();
    expect(component.render(120).join("\n")).toContain("B:Hackler");
    component.dispose();
  });

  it("cleans up without replacing the parent spinner on shutdown", async () => {
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
      expect(subject.ui.setWorkingIndicator).not.toHaveBeenCalled();
      expect(subject.tui.requestRender).toHaveBeenCalledTimes(rendersBeforeShutdown);
    } finally {
      vi.useRealTimers();
    }
  });
});
