import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isCopilotModel } from "../../shared/provider.js";
import { fetchCopilotQuota } from "./client.js";
import type { CopilotQuota } from "./quota.js";

const refreshMs = 30_000;
const statusKey = "pi-extensions:copilot-usage";

export { fetchCopilotQuota } from "./client.js";
export type { CopilotQuota } from "./quota.js";
export { parseCopilotQuota } from "./quota.js";

function display(quota: CopilotQuota): string {
  if (quota.unlimited) return "Copilot: unlimited";
  const remaining = quota.remaining.toLocaleString("en-US", { maximumFractionDigits: 1 });
  const total =
    quota.total === undefined
      ? ""
      : `/${quota.total.toLocaleString("en-US", { maximumFractionDigits: 1 })}`;
  const percent =
    quota.percentRemaining === undefined ? "" : ` (${Math.round(quota.percentRemaining)}% left)`;
  return `Copilot: ${remaining}${total} ${quota.unit.replace("_", " ")}${percent}`;
}

export type CopilotUsageOptions = {
  fetchQuota?: () => Promise<CopilotQuota | undefined>;
  refreshIntervalMs?: number;
};

/** Exposed for deterministic lifecycle tests; normal runtime uses the capability-based defaults. */
export function registerCopilotUsage(pi: ExtensionAPI, options: CopilotUsageOptions = {}): void {
  const getQuota = options.fetchQuota ?? fetchCopilotQuota;
  const intervalMs = options.refreshIntervalMs ?? refreshMs;
  let ctx: ExtensionContext | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let refreshing: Promise<void> | undefined;
  let lastRefreshAt = 0;
  const clear = (): void => {
    ctx?.ui.setStatus(statusKey, undefined);
    if (timer) clearInterval(timer);
    timer = undefined;
  };
  const refresh = (force = false): Promise<void> => {
    if (!ctx || !isCopilotModel(ctx.model)) return Promise.resolve();
    if (!force && Date.now() - lastRefreshAt < intervalMs) return refreshing ?? Promise.resolve();
    return (refreshing ??= (async () => {
      lastRefreshAt = Date.now();
      const quota = await getQuota();
      if (!ctx || !isCopilotModel(ctx.model)) return;
      if (quota) ctx.ui.setStatus(statusKey, ctx.ui.theme.fg("dim", display(quota)));
      else ctx.ui.setStatus(statusKey, undefined);
    })().finally(() => {
      refreshing = undefined;
    }));
  };
  const updateProvider = (next: ExtensionContext): void => {
    ctx = next;
    clear();
    if (!isCopilotModel(next.model)) return;
    // Provider re-entry must repaint promptly even when the previous refresh was throttled.
    void refresh(true);
    timer = setInterval(() => {
      void refresh();
    }, intervalMs);
  };
  pi.on("session_start", (_event, next) => updateProvider(next));
  pi.on("model_select", (_event, next) => updateProvider(next));
  pi.on("agent_end", (_event, next) => {
    if (isCopilotModel(next.model)) void refresh();
  });
  pi.on("tool_result", (_event, next) => {
    if (isCopilotModel(next.model)) void refresh();
  });
  pi.on("session_shutdown", () => {
    clear();
    ctx = undefined;
  });
  pi.registerCommand("copilot-usage", {
    description: "Refresh GitHub Copilot quota when a Copilot model is active.",
    handler: async (_args, next) => {
      if (!isCopilotModel(next.model))
        return void next.ui.notify(
          "Copilot quota is available only for an active GitHub Copilot model.",
          "info",
        );
      ctx = next;
      await refresh(true);
    },
  });
}

export default function copilotUsageExtension(pi: ExtensionAPI): void {
  registerCopilotUsage(pi);
}
