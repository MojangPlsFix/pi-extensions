import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatModelCostPanel,
  default as modelCostBadgesExtension,
  resolveModelSelectorModulePath,
} from "../index.js";

type Handler = (...args: any[]) => unknown;
type Theme = ExtensionContext["ui"]["theme"];

type Fixture = {
  root: string;
  cli: string;
  selector: string;
};

const temporaryDirectories: string[] = [];
const originalArgv1 = process.argv[1];

const selectorSource = `
export class ModelSelectorComponent {
  filteredModels = [];
  selectedIndex = 0;
  renderCalls = 0;

  render() {
    this.renderCalls += 1;
    const selected = this.filteredModels[this.selectedIndex];
    return [
      \`→ \${selected?.id ?? "none"} [\${selected?.provider ?? "none"}]\`,
      "tail",
    ];
  }
}
`;

async function fixture(layout: "modular" | "bundled", withSelector = true): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "pi-model-cost-badges-"));
  temporaryDirectories.push(root);
  const dist = join(root, "dist");
  const cli = layout === "modular" ? join(dist, "cli.js") : join(dist, "bundle", "cli.js");
  const selector =
    layout === "modular"
      ? join(dist, "modes", "interactive", "components", "model-selector.js")
      : join(dist, "bundle", "index.js");
  await mkdir(dirname(cli), { recursive: true });
  await writeFile(cli, "// test cli\n");
  if (withSelector) {
    await mkdir(dirname(selector), { recursive: true });
    await writeFile(selector, selectorSource);
  }
  return { root, cli, selector };
}

function theme(): Theme {
  return { fg: (_color: string, text: string) => text } as Theme;
}

function testModel() {
  return {
    cost: {
      input: 1.2,
      cacheRead: 0.12,
      cacheWrite: 2.5,
      output: 9.8765,
      tiers: [
        { inputTokensAbove: 10_000, input: 2.4, cacheRead: 0.24, cacheWrite: 5, output: 19.753 },
      ],
    },
  };
}

function extensionHarness() {
  const handlers = new Map<string, Handler[]>();
  const notify = vi.fn();
  const context = {
    ui: { theme: theme(), notify },
  } as unknown as ExtensionContext;
  const api = {
    on(name: string, handler: Handler) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
  } as unknown as ExtensionAPI;
  return {
    context,
    notify,
    start: async () => {
      for (const handler of handlers.get("session_start") ?? []) await handler({}, context);
    },
    register() {
      modelCostBadgesExtension(api);
    },
  };
}

afterEach(async () => {
  if (originalArgv1 === undefined) delete process.argv[1];
  else process.argv[1] = originalArgv1;
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("model-cost-badges selector resolution", () => {
  it("resolves the modular selector from a real modular CLI path and follows symlinks", async () => {
    const subject = await fixture("modular");
    expect(resolveModelSelectorModulePath(subject.cli)).toBe(subject.selector);

    const launcher = join(subject.root, "bin", "pi");
    await mkdir(dirname(launcher), { recursive: true });
    await symlink(subject.cli, launcher);
    expect(resolveModelSelectorModulePath(launcher)).toBe(subject.selector);
  });

  it("resolves the bundled selector export from the bundled CLI path", async () => {
    const subject = await fixture("bundled");
    expect(resolveModelSelectorModulePath(subject.cli)).toBe(subject.selector);
  });

  it("quietly declines missing, broken, and unsupported CLI or selector paths", async () => {
    const missingSelector = await fixture("modular", false);
    expect(resolveModelSelectorModulePath(missingSelector.cli)).toBeUndefined();
    expect(resolveModelSelectorModulePath(undefined)).toBeUndefined();
    expect(
      resolveModelSelectorModulePath(join(missingSelector.root, "missing", "cli.js")),
    ).toBeUndefined();

    const brokenCli = join(missingSelector.root, "broken-cli.js");
    await symlink(join(missingSelector.root, "does-not-exist.js"), brokenCli);
    expect(resolveModelSelectorModulePath(brokenCli)).toBeUndefined();

    const unsupportedCli = join(missingSelector.root, "dist", "bun", "cli.js");
    await mkdir(dirname(unsupportedCli), { recursive: true });
    await writeFile(unsupportedCli, "// unsupported test cli\n");
    expect(resolveModelSelectorModulePath(unsupportedCli)).toBeUndefined();
  });
});

describe("model-cost-badges rendering", () => {
  it("formats base and long-context costs", () => {
    const panel = formatModelCostPanel(testModel() as never, theme());
    expect(panel[0]).toContain("API cost / 1M");
    expect(panel[1]).toContain("Base");
    expect(panel[1]).toContain(">10K");
    expect(panel.join("\n")).toContain("Input");
    expect(panel.join("\n")).toContain("$1.20");
    expect(panel.join("\n")).toContain("$19.753");
  });

  it("patches the modular selector, keeps narrow output unchanged, and wraps once", async () => {
    const subject = await fixture("modular");
    process.argv[1] = subject.cli;

    const first = extensionHarness();
    first.register();
    await first.start();
    const selectorModule = await import(pathToFileURL(subject.selector).href);
    const prototype = selectorModule.ModelSelectorComponent.prototype as any;
    const wrappedRender = prototype.render;

    const selector = new selectorModule.ModelSelectorComponent();
    selector.filteredModels = [{ id: "model", provider: "test", model: testModel() }];
    const narrow = selector.render(10);
    expect(narrow).toEqual(["→ model [test]", "tail"]);
    expect(selector.renderCalls).toBe(1);

    const wide = selector.render(120).join("\n");
    expect(wide).toContain("API cost / 1M");
    expect(selector.renderCalls).toBe(2);

    const second = extensionHarness();
    second.register();
    await second.start();
    expect(prototype.render).toBe(wrappedRender);
    expect(first.notify).not.toHaveBeenCalled();
    expect(second.notify).not.toHaveBeenCalled();
  });

  it("patches the selector class exported by the bundled Node layout", async () => {
    const subject = await fixture("bundled");
    process.argv[1] = subject.cli;

    const harness = extensionHarness();
    harness.register();
    await harness.start();
    const selectorModule = await import(pathToFileURL(subject.selector).href);
    const selector = new selectorModule.ModelSelectorComponent();
    selector.filteredModels = [{ id: "model", provider: "test", model: testModel() }];

    expect(selector.render(120).join("\n")).toContain("API cost / 1M");
    expect(harness.notify).not.toHaveBeenCalled();
  });

  it("stays quiet when the selector module is unavailable at import time", async () => {
    const subject = await fixture("modular");
    await writeFile(subject.selector, "export const broken = ;\n");
    process.argv[1] = subject.cli;

    const harness = extensionHarness();
    harness.register();
    await harness.start();

    expect(harness.notify).not.toHaveBeenCalled();
  });
});
