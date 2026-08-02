import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

type Theme = ExtensionContext["ui"]["theme"];
type ModelItem = { provider: string; id: string; model: Model<any> };
type Selector = {
  filteredModels: ModelItem[];
  selectedIndex: number;
  render(width: number): string[];
};
type SelectorModule = { ModelSelectorComponent: { prototype: Selector } };
const originalRender = Symbol.for("pi-extensions.model-cost-badges.original-render");
const panelTop = Symbol.for("pi-extensions.model-cost-badges.panel-top");
type PatchedSelector = Selector & { [originalRender]?: Selector["render"]; [panelTop]?: number };

const dollars = (value: number): string =>
  `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;
const tokenCount = (value: number): string =>
  value >= 1_000_000 ? `${value / 1_000_000}M` : `${value / 1_000}K`;

export function formatModelCostPanel(model: Model<any>, theme: Theme): string[] {
  const tier = model.cost.tiers?.at(-1);
  const longLabel = tier ? `>${tokenCount(tier.inputTokensAbove)}` : "Long";
  const rows: ReadonlyArray<readonly [string, number, number | undefined]> = [
    ["Input", model.cost.input, tier?.input],
    ["Cache read", model.cost.cacheRead, tier?.cacheRead],
    ["Cache write", model.cost.cacheWrite, tier?.cacheWrite],
    ["Output", model.cost.output, tier?.output],
  ];
  const baseWidth = Math.max(4, ...rows.map(([, base]) => dollars(base).length));
  const longWidth = Math.max(
    longLabel.length,
    ...rows.map(([, , value]) => (value === undefined ? 1 : dollars(value).length)),
  );
  const width = Math.max(
    "API cost / 1M".length,
    ...rows.map(([label]) => label.length + 4 + baseWidth + longWidth),
  );
  const border = (text: string): string => theme.fg("muted", text);
  return [
    `${border("┌─")}${theme.fg("accent", "API cost / 1M")}${border(`${"─".repeat(width - 14)}─┐`)}`,
    `${border("│ ")}${theme.fg("muted", `${" ".repeat(width - baseWidth - longWidth - 2)}${"Base".padStart(baseWidth)}  ${longLabel.padStart(longWidth)}`)}${border(" │")}`,
    ...rows.map(([label, base, long]) => {
      const values = `${dollars(base).padStart(baseWidth)}  ${(long === undefined ? "—" : dollars(long)).padStart(longWidth)}`;
      return `${border("│ ")}${label}${" ".repeat(width - label.length - values.length)}${values}${border(" │")}`;
    }),
    border(`└${"─".repeat(width + 2)}┘`),
  ];
}

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}
function overlay(lines: string[], panel: string[], start: number, width: number): string[] {
  const panelWidth = visibleWidth(panel[0] ?? "");
  const leftWidth = width - panelWidth - 1;
  if (leftWidth < 20) return lines;
  const result = [...lines];
  panel.forEach((line, offset) => {
    const row = start + offset;
    const left = truncateToWidth(result[row] ?? "", leftWidth, "");
    result[row] = truncateToWidth(
      `${left}${" ".repeat(Math.max(1, width - visibleWidth(left) - panelWidth))}${line}`,
      width,
      "",
    );
  });
  return result;
}

export default function modelCostBadgesExtension(pi: ExtensionAPI): void {
  let theme: Theme | undefined;
  let patched = false;
  pi.on("session_start", async (_event, ctx) => {
    theme = ctx.ui.theme;
    if (patched) return;
    try {
      const cliPath = process.argv[1];
      if (!cliPath) return;
      const selectorPath = join(
        dirname(realpathSync(cliPath)),
        "modes",
        "interactive",
        "components",
        "model-selector.js",
      );
      const { ModelSelectorComponent } = (await import(
        pathToFileURL(selectorPath).href
      )) as SelectorModule;
      const prototype = ModelSelectorComponent.prototype as PatchedSelector;
      const original = prototype[originalRender] ?? prototype.render;
      prototype[originalRender] = original;
      prototype.render = function render(width: number): string[] {
        const selector = this as PatchedSelector;
        const lines = original.call(this, width);
        const selected = this.filteredModels[this.selectedIndex];
        if (!selected || !theme) return lines;
        const selectedRow = lines.findIndex((line) =>
          stripAnsi(line).includes(`→ ${selected.id} [${selected.provider}]`),
        );
        if (selectedRow < 0) return lines;
        const panel = formatModelCostPanel(selected.model, theme);
        selector[panelTop] ??= Math.max(0, Math.min(selectedRow, lines.length - panel.length - 1));
        return overlay(
          lines,
          panel,
          Math.min(selector[panelTop] ?? 0, Math.max(0, lines.length - panel.length - 1)),
          width,
        );
      };
      patched = true;
    } catch (error) {
      ctx.ui.notify(
        `Model cost badges are unavailable in this Pi build: ${error instanceof Error ? error.message : String(error)}`,
        "warning",
      );
    }
  });
}
