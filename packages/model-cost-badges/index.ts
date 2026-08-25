import { existsSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
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
type SelectorModule = { ModelSelectorComponent?: unknown };
const originalRender = Symbol.for("pi-extensions.model-cost-badges.original-render");
const panelTop = Symbol.for("pi-extensions.model-cost-badges.panel-top");
const patchState = Symbol.for("pi-extensions.model-cost-badges.patch-state");
type SelectorPatchState = { getTheme: () => Theme | undefined };
type PatchedSelector = Selector & {
  [originalRender]?: Selector["render"];
  [panelTop]?: number;
  [patchState]?: SelectorPatchState;
};

const selectorRelativePath = join("modes", "interactive", "components", "model-selector.js");

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Resolve the selector module belonging to Pi's real Node CLI entrypoint.
 *
 * Pi ships either an unbundled `dist/cli.js` with a sibling `dist/modes` tree,
 * or a bundled `dist/bundle/cli.js` whose selector class is re-exported by
 * `dist/bundle/index.js`. Other entrypoints are intentionally unsupported.
 */
export function resolveModelSelectorModulePath(
  cliPath: string | undefined = process.argv[1],
): string | undefined {
  if (!cliPath) return undefined;

  let resolvedCliPath: string;
  try {
    resolvedCliPath = realpathSync(cliPath);
  } catch {
    return undefined;
  }
  if (!isFile(resolvedCliPath) || basename(resolvedCliPath) !== "cli.js") return undefined;

  const cliDirectory = dirname(resolvedCliPath);
  const parentDirectory = dirname(cliDirectory);
  const selectorPath =
    basename(cliDirectory) === "dist"
      ? join(cliDirectory, selectorRelativePath)
      : basename(cliDirectory) === "bundle" && basename(parentDirectory) === "dist"
        ? join(cliDirectory, "index.js")
        : undefined;

  return selectorPath && existsSync(selectorPath) && isFile(selectorPath)
    ? selectorPath
    : undefined;
}

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

function getSelectorPrototype(module: SelectorModule): PatchedSelector | undefined {
  const component = module.ModelSelectorComponent;
  if (typeof component !== "function") return undefined;
  const prototype = (component as { prototype?: unknown }).prototype;
  if (!prototype || typeof prototype !== "object") return undefined;
  const selector = prototype as PatchedSelector;
  return typeof selector.render === "function" ? selector : undefined;
}

function patchSelector(module: SelectorModule, getTheme: () => Theme | undefined): boolean {
  const prototype = getSelectorPrototype(module);
  if (!prototype) return false;

  const existingState = prototype[patchState];
  if (existingState) {
    existingState.getTheme = getTheme;
    return true;
  }

  const original = prototype[originalRender] ?? prototype.render;
  if (typeof original !== "function") return false;
  const state: SelectorPatchState = { getTheme };
  prototype[originalRender] = original;
  prototype[patchState] = state;
  prototype.render = function render(width: number): string[] {
    const selector = this as PatchedSelector;
    const lines = original.call(this, width);
    const selected = selector.filteredModels[selector.selectedIndex];
    const theme = state.getTheme();
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
  return true;
}

export default function modelCostBadgesExtension(pi: ExtensionAPI): void {
  let theme: Theme | undefined;
  let patched = false;
  pi.on("session_start", async (_event, ctx) => {
    theme = ctx.ui.theme;
    if (patched) return;
    const selectorPath = resolveModelSelectorModulePath();
    if (!selectorPath) return;
    try {
      const selectorModule = (await import(
        pathToFileURL(selectorPath).href
      )) as unknown as SelectorModule;
      patched = patchSelector(selectorModule, () => theme);
    } catch {
      // Model cost badges are optional. Unsupported or broken Pi layouts stay quiet.
    }
  });
}
