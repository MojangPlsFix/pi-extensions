import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const statusKey = "pi-extensions:context-size";
const aliases: Record<string, number> = {
  "256k": 256_000,
  "272k": 272_000,
  "512k": 512_000,
  "1m": 1_000_000,
};

type MutableModel = { id: string; provider?: string; contextWindow: number };

export function parseContextSize(value: string): number | undefined {
  const normalized = value.trim().toLowerCase().replace(/\s+/g, "");
  if (aliases[normalized]) return aliases[normalized];
  const match = /^(\d+(?:\.\d+)?)(k|m)?$/.exec(normalized);
  if (!match) return undefined;
  const amount = Number(match[1]);
  const multiplier = match[2] === "m" ? 1_000_000 : match[2] === "k" ? 1_000 : 1;
  const result = Math.floor(amount * multiplier);
  return Number.isSafeInteger(result) && result > 0 ? result : undefined;
}

export function formatContextSize(value: number): string {
  if (value >= 1_000_000 && value % 1_000_000 === 0) return `${value / 1_000_000}M`;
  if (value >= 1_000 && value % 1_000 === 0) return `${value / 1_000}K`;
  return value.toLocaleString("en-US");
}

export default function contextSizeExtension(pi: ExtensionAPI): void {
  const originals = new WeakMap<object, number>();
  const selected = new Map<string, number>();
  const modified = new Set<MutableModel>();
  let activeContext: ExtensionContext | undefined;

  const key = (model: MutableModel): string => `${model.provider ?? "unknown"}/${model.id}`;
  const restore = (model: MutableModel): void => {
    const original = originals.get(model);
    if (original !== undefined) model.contextWindow = original;
    modified.delete(model);
    selected.delete(key(model));
  };
  const clearStatus = (ctx: ExtensionContext): void => ctx.ui.setStatus(statusKey, undefined);
  const limit = (ctx: ExtensionContext, size: number | undefined): void => {
    if (!ctx.model) return clearStatus(ctx);
    const model = ctx.model as unknown as MutableModel;
    const original = originals.get(model) ?? model.contextWindow;
    originals.set(model, original);
    if (size === undefined || size === original) {
      restore(model);
      return clearStatus(ctx);
    }
    if (size > original)
      throw new Error(
        `Context size cannot exceed the model maximum (${formatContextSize(original)}).`,
      );
    model.contextWindow = size;
    modified.add(model);
    selected.set(key(model), size);
    ctx.ui.setStatus(statusKey, ctx.ui.theme.fg("dim", `context: ${formatContextSize(size)}`));
  };
  const remember = (ctx: ExtensionContext): void => {
    activeContext = ctx;
    if (!ctx.model) return clearStatus(ctx);
    const model = ctx.model as unknown as MutableModel;
    if (!originals.has(model)) originals.set(model, model.contextWindow);
    const size = selected.get(key(model));
    if (size === undefined) clearStatus(ctx);
    else {
      try {
        limit(ctx, size);
      } catch {
        selected.delete(key(model));
        clearStatus(ctx);
      }
    }
  };

  pi.on("session_start", (_event, ctx) => remember(ctx));
  pi.on("model_select", (_event, ctx) => {
    const previous = activeContext?.model as MutableModel | undefined;
    if (previous && previous !== ctx.model) restore(previous);
    remember(ctx);
  });
  pi.on("session_shutdown", () => {
    activeContext?.ui.setStatus(statusKey, undefined);
    for (const model of modified) restore(model);
    activeContext = undefined;
  });
  pi.registerCommand("context", {
    description:
      "Limit the active model context window: /context 128k, or /context auto to restore it",
    handler: async (args, ctx) => {
      if (!ctx.model) return void ctx.ui.notify("No active model.", "warning");
      const model = ctx.model as unknown as MutableModel;
      if (!originals.has(model)) originals.set(model, model.contextWindow);
      const original = originals.get(model) ?? model.contextWindow;
      const value = args.trim();
      if (!value) {
        const options = [
          { label: `Default (${formatContextSize(original)})`, size: undefined },
          ...[272_000, 256_000, 128_000, 64_000]
            .filter((size) => size < original)
            .map((size) => ({ label: formatContextSize(size), size })),
        ];
        const choice = await ctx.ui.select(
          `${model.id} context size`,
          options.map((option) => option.label),
        );
        const option = options.find((candidate) => candidate.label === choice);
        if (!option) return;
        try {
          limit(ctx, option.size);
          ctx.ui.notify(
            option.size
              ? `${model.id}: context limited to ${formatContextSize(option.size)}`
              : `${model.id}: restored ${formatContextSize(original)} context`,
            "info",
          );
        } catch (error) {
          ctx.ui.notify(
            error instanceof Error ? error.message : "Unable to change context size.",
            "error",
          );
        }
        return;
      }
      if (/^(auto|default|max)$/i.test(value)) {
        limit(ctx, undefined);
        ctx.ui.notify(`${model.id}: restored ${formatContextSize(original)} context`, "info");
        return;
      }
      const size = parseContextSize(value);
      if (!size) return void ctx.ui.notify("Usage: /context [auto|272k|512k|1m|number]", "warning");
      try {
        limit(ctx, size);
        ctx.ui.notify(`${model.id}: context limited to ${formatContextSize(size)}`, "info");
      } catch (error) {
        ctx.ui.notify(
          error instanceof Error ? error.message : "Unable to change context size.",
          "error",
        );
      }
    },
  });
}
