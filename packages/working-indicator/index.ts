import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { events, type SubagentsStatusEvent } from "../../shared/events.js";

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

/** Keeps Pi's normal working row informative while native Subagents run in parallel. */
export default function workingIndicatorExtension(pi: ExtensionAPI): void {
  let status = emptyStatus();
  let ctx: ExtensionContext | undefined;

  const subscribed = pi.events.on(events.subagentsStatus, (data: unknown) => {
    status = normalized(data);
    ctx?.ui.setWorkingVisible(true);
    ctx?.ui.setWorkingMessage(workingMessage(status));
  });
  const unsubscribeStatus = typeof subscribed === "function" ? subscribed : () => {};

  pi.on("session_start", (_event, extensionContext) => {
    ctx = extensionContext;
    ctx.ui.setWorkingVisible(true);
    ctx.ui.setWorkingMessage(workingMessage(status));
    ctx.ui.setWorkingIndicator();
  });

  pi.on("session_shutdown", () => {
    unsubscribeStatus();
    status = emptyStatus();
    ctx?.ui.setWorkingVisible(true);
    ctx?.ui.setWorkingMessage();
    ctx?.ui.setWorkingIndicator();
    ctx = undefined;
  });
}
