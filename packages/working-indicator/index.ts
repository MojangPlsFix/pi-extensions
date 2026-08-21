import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { events, type SubagentsStatusEvent } from "../../shared/events.js";
import { activityViewLines } from "../subagents/renderers.js";

const widgetKey = "pi-extensions:subagent-working";
const activeStatuses = new Set<string>(["queued", "starting", "running", "blocked"]);

const emptyStatus = (): SubagentsStatusEvent => ({
  active: 0,
  blocked: 0,
  parked: 0,
  failed: 0,
  writers: 0,
  total: 0,
  agents: [],
});

function normalized(value: unknown): SubagentsStatusEvent {
  const candidate = (value ?? {}) as Partial<SubagentsStatusEvent>;
  const count = (entry: unknown) =>
    typeof entry === "number" && Number.isFinite(entry) ? Math.max(0, Math.floor(entry)) : 0;
  return {
    active: count(candidate.active),
    blocked: count(candidate.blocked),
    parked: count(candidate.parked),
    failed: count(candidate.failed),
    writers: count(candidate.writers),
    total: count(candidate.total),
    agents: Array.isArray(candidate.agents) ? candidate.agents.slice(0, 4) : [],
  };
}

function workingMessage(status: SubagentsStatusEvent): string {
  if (status.active === 0) return "Hackeln...";
  if (status.blocked > 0) return "Hackler warten auf Polier....";
  return "Hackler hackeln...";
}

/** Disposable, Pi-themed owner of the always-visible inline Subagent activity. */
export class SubagentActivityComponent {
  private status = emptyStatus();
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
        this.tui.requestRender();
      }, 1_000);
      this.timer.unref?.();
    } else if (status.active === 0 && this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
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
          elapsedMs: activeStatuses.has(agent.status)
            ? agent.elapsedMs + elapsedSinceUpdate
            : agent.elapsedMs,
        })),
      },
      this.theme,
      width,
    );
  }

  invalidate(): void {
    this.tui.requestRender();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}

/** Keeps Pi's normal working row informative while native Subagents run in parallel. */
export default function workingIndicatorExtension(pi: ExtensionAPI): void {
  let status = emptyStatus();
  let ctx: ExtensionContext | undefined;
  let component: SubagentActivityComponent | undefined;

  const subscribed = pi.events.on(events.subagentsStatus, (data: unknown) => {
    status = normalized(data);
    ctx?.ui.setWorkingVisible(true);
    ctx?.ui.setWorkingMessage(workingMessage(status));
    component?.update(status);
  });
  const unsubscribeStatus = typeof subscribed === "function" ? subscribed : () => {};

  pi.on("session_start", (_event, extensionContext) => {
    ctx = extensionContext;
    ctx.ui.setWorkingVisible(true);
    ctx.ui.setWorkingMessage(workingMessage(status));
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
    status = emptyStatus();
    ctx?.ui.setWidget(widgetKey, undefined);
    ctx?.ui.setWorkingVisible(true);
    ctx?.ui.setWorkingMessage();
    ctx?.ui.setWorkingIndicator();
    ctx = undefined;
  });
}
