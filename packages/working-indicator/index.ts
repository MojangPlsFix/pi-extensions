import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { events, type SubagentsStatusEvent } from "../../shared/events.js";

const frames = ["△", "▵", "▴", "▲", "▴", "▵"];
const widgetKey = "pi-extensions:subagent-working";
type Status = Required<Pick<SubagentsStatusEvent, "active">> & Partial<SubagentsStatusEvent>;

export default function workingIndicatorExtension(pi: ExtensionAPI): void {
  let status: Status = { active: 0 };
  let ctx: ExtensionContext | undefined;
  let parentWorking = false;
  let frame = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  const label = (): string =>
    status.active === 1
      ? `Hackeln... · 1 subagent (${status.explorers ?? 0}E, ${status.workers ?? 0}W)`
      : `Hackeln... · ${status.active} subagents (${status.explorers ?? 0}E, ${status.workers ?? 0}W)`;
  const clear = (): void => {
    ctx?.ui.setWidget(widgetKey, undefined);
    if (timer) clearInterval(timer);
    timer = undefined;
  };
  const renderReplica = (): void => {
    if (!ctx || status.active === 0 || parentWorking) return clear();
    const glyph = ctx.ui.theme.fg("warning", frames[frame++ % frames.length] ?? "△");
    ctx.ui.setWidget(widgetKey, [`${glyph} ${label()}`], { placement: "belowEditor" });
    timer ??= setInterval(renderReplica, 120);
  };
  pi.events.on(events.subagentsStatus, (data: unknown) => {
    const next = data as Partial<SubagentsStatusEvent> | undefined;
    status = {
      active: Number.isFinite(next?.active) ? Math.max(0, next?.active ?? 0) : 0,
      explorers: next?.explorers,
      workers: next?.workers,
      failed: next?.failed,
    };
    ctx?.ui.setWorkingMessage(status.active > 0 ? label() : "Hackeln...");
    renderReplica();
  });
  pi.on("session_start", (_event, extensionContext) => {
    ctx = extensionContext;
    ctx.ui.setWorkingMessage("Hackeln...");
    ctx.ui.setWorkingIndicator({
      frames: frames.map((glyph) => ctx!.ui.theme.fg("warning", glyph)),
      intervalMs: 120,
    });
  });
  pi.on("agent_start", () => {
    parentWorking = true;
    clear();
  });
  pi.on("agent_settled", () => {
    parentWorking = false;
    renderReplica();
  });
  pi.on("session_shutdown", () => {
    clear();
    ctx?.ui.setWorkingMessage();
    ctx?.ui.setWorkingIndicator();
    ctx = undefined;
  });
}
