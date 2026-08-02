import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { events, type SubagentsStatusEvent } from "../../shared/events.js";
import { activityViewLines } from "../subagents/renderers.js";

const frames = ["△", "▵", "▴", "▲", "▴", "▵"];
const widgetKey = "pi-extensions:subagent-working";

const emptyStatus = (): SubagentsStatusEvent => ({
  active: 0,
  ready: 0,
  open: 0,
  explorers: 0,
  workers: 0,
  failed: 0,
  interrupted: 0,
  closed: 0,
  agents: [],
});

function normalized(value: unknown): SubagentsStatusEvent {
  const candidate = (value ?? {}) as Partial<SubagentsStatusEvent>;
  const count = (entry: unknown) =>
    typeof entry === "number" && Number.isFinite(entry) ? Math.max(0, Math.floor(entry)) : 0;
  return {
    active: count(candidate.active),
    ready: count(candidate.ready),
    open: count(candidate.open),
    explorers: count(candidate.explorers),
    workers: count(candidate.workers),
    failed: count(candidate.failed),
    interrupted: count(candidate.interrupted),
    closed: count(candidate.closed),
    agents: Array.isArray(candidate.agents) ? candidate.agents.slice(0, 4) : [],
  };
}

/** Disposable, Pi-themed owner of the always-visible inline Subagent activity. */
export class SubagentActivityComponent {
  private status = emptyStatus();
  private frame = 0;
  private updatedAt = Date.now();
  private timer: ReturnType<typeof setInterval> | undefined;
  private disposed = false;

  constructor(
    private readonly tui: Pick<TUI, "requestRender">,
    private readonly theme: Theme,
  ) {}

  update(status: SubagentsStatusEvent): void {
    if (this.disposed) return;
    this.status = status;
    this.updatedAt = Date.now();
    if (status.active > 0 && !this.timer) {
      this.timer = setInterval(() => {
        this.frame = (this.frame + 1) % frames.length;
        this.tui.requestRender();
      }, 120);
    } else if (status.active === 0 && this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
      this.frame = 0;
    }
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const elapsedSinceUpdate = Math.max(0, Date.now() - this.updatedAt);
    return activityViewLines(
      {
        ...this.status,
        agents: this.status.agents.map((agent) => ({
          ...agent,
          elapsedMs:
            agent.status === "running" ? agent.elapsedMs + elapsedSinceUpdate : agent.elapsedMs,
        })),
      },
      this.theme,
      width,
      frames[this.frame] ?? "△",
    );
  }

  invalidate(): void {
    // Content is rebuilt from current theme tokens on every render.
    this.tui.requestRender();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}

export default function workingIndicatorExtension(pi: ExtensionAPI): void {
  let status = emptyStatus();
  let ctx: ExtensionContext | undefined;
  let component: SubagentActivityComponent | undefined;

  const subscribed = pi.events.on(events.subagentsStatus, (data: unknown) => {
    status = normalized(data);
    component?.update(status);
  });
  const unsubscribeStatus = typeof subscribed === "function" ? subscribed : () => {};

  pi.on("session_start", (_event, extensionContext) => {
    ctx = extensionContext;
    // Parent streaming keeps Pi's native row; Subagent counts live only in our inline component.
    ctx.ui.setWorkingMessage("Hackeln...");
    // Native Pi owns parent-turn animation and accent styling.
    ctx.ui.setWorkingIndicator();
    ctx.ui.setWidget(
      widgetKey,
      (tui, theme) => {
        component = new SubagentActivityComponent(tui, theme);
        component.update(status);
        return component;
      },
      { placement: "aboveEditor" },
    );
  });

  pi.on("session_shutdown", () => {
    unsubscribeStatus();
    component?.dispose();
    component = undefined;
    ctx?.ui.setWidget(widgetKey, undefined);
    ctx?.ui.setWorkingMessage();
    ctx?.ui.setWorkingIndicator();
    ctx = undefined;
  });
}
