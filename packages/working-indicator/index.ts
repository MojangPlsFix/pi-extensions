import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { events, type SubagentsStatusEvent } from "../../shared/events.js";
import { presentationGroup } from "../subagents/presentation.js";
import { activityViewLines } from "../subagents/renderers.js";

const widgetKey = "pi-extensions:subagent-working";
const activeStatuses = new Set<string>(["queued", "starting", "running", "blocked"]);

const emptyStatus = (): SubagentsStatusEvent => ({
  active: 0,
  foreground: 0,
  attention: 0,
  history: 0,
  running: 0,
  wrappingUp: 0,
  blocked: 0,
  parked: 0,
  failed: 0,
  stopped: 0,
  writers: 0,
  total: 0,
  capacity: {
    used: 0,
    limit: 0,
    free: 0,
    sharedWritersUsed: 0,
    sharedWritersLimit: 0,
  },
  agents: [],
});

function normalized(value: unknown): SubagentsStatusEvent {
  const candidate = (value ?? {}) as Partial<SubagentsStatusEvent>;
  const count = (entry: unknown) =>
    typeof entry === "number" && Number.isFinite(entry) ? Math.max(0, Math.floor(entry)) : 0;
  const capacity = (candidate.capacity ?? {}) as Partial<SubagentsStatusEvent["capacity"]>;
  return {
    active: count(candidate.active),
    foreground: candidate.foreground === undefined ? undefined : count(candidate.foreground),
    attention: candidate.attention === undefined ? undefined : count(candidate.attention),
    history: candidate.history === undefined ? undefined : count(candidate.history),
    running: count(candidate.running),
    wrappingUp: count(candidate.wrappingUp),
    blocked: count(candidate.blocked),
    parked: count(candidate.parked),
    failed: count(candidate.failed),
    stopped: count(candidate.stopped),
    writers: count(candidate.writers),
    total: count(candidate.total),
    capacity: {
      used: count(capacity.used),
      limit: count(capacity.limit),
      free: count(capacity.free),
      sharedWritersUsed: count(capacity.sharedWritersUsed),
      sharedWritersLimit: count(capacity.sharedWritersLimit),
    },
    oldestBlockingRequest: candidate.oldestBlockingRequest,
    blockingRequestCount: count(candidate.blockingRequestCount),
    agents: Array.isArray(candidate.agents) ? candidate.agents : [],
  };
}

function foregroundCount(status: SubagentsStatusEvent): number {
  if (status.foreground !== undefined) return status.foreground;
  return status.agents.filter(
    (agent) => agent.group !== undefined || presentationGroup(agent) !== "History",
  ).length;
}

function workingMessage(status: SubagentsStatusEvent): string | undefined {
  if (foregroundCount(status) === 0) return undefined;
  if (status.blocked > 0) return "Subagents waiting for input...";
  if (status.wrappingUp > 0) return "Hackler wrapping up";
  return "Hackler hackeln...";
}

function applyWorkingMessage(
  ui: Pick<ExtensionContext["ui"], "setWorkingMessage">,
  status: SubagentsStatusEvent,
): void {
  const message = workingMessage(status);
  if (message) ui.setWorkingMessage(message);
  else ui.setWorkingMessage();
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
    if (foregroundCount(status) > 0 && !this.timer) {
      this.timer = setInterval(() => {
        this.tui.requestRender();
      }, 1_000);
      this.timer.unref?.();
    } else if (foregroundCount(status) === 0 && this.timer) {
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
    // Rendering is intentionally rebuilt from the current theme callbacks.
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
    if (ctx) applyWorkingMessage(ctx.ui, status);
    component?.update(status);
  });
  const unsubscribeStatus = typeof subscribed === "function" ? subscribed : () => {};

  pi.on("session_start", (_event, extensionContext) => {
    ctx = extensionContext;
    ctx.ui.setWorkingVisible(true);
    applyWorkingMessage(ctx.ui, status);
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
    ctx = undefined;
  });
}
