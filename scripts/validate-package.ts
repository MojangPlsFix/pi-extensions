import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const expectedEntrypoints = [
  "packages/ask-user-question/index.ts",
  "packages/plan-mode/index.ts",
  "packages/notify/index.ts",
  "packages/todos/index.ts",
  "packages/context-size/index.ts",
  "packages/large-paste/index.ts",
  "packages/model-cost-badges/index.ts",
  "packages/stats/index.ts",
  "packages/subagents/index.ts",
  "packages/uv/index.ts",
  "packages/working-indicator/index.ts",
  "packages/web-search/index.ts",
  "packages/copilot-usage/index.ts",
  "packages/copilot-compaction-fix/index.ts",
];

const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
  private?: unknown;
  type?: unknown;
  engines?: { node?: unknown };
  keywords?: unknown;
  scripts?: Record<string, unknown>;
  dependencies?: Record<string, unknown>;
  pi?: { extensions?: unknown; skills?: unknown };
};
const failures: string[] = [];

function expect(condition: unknown, message: string): void {
  if (!condition) failures.push(message);
}

expect(packageJson.private === true, "package must be private");
expect(packageJson.type === "module", "package must be an ES module");
expect(packageJson.engines?.node === ">=22", "package must require Node.js >=22");
expect(
  Array.isArray(packageJson.keywords) && packageJson.keywords.includes("pi-package"),
  "package must advertise the pi-package keyword",
);
expect(
  !packageJson.dependencies || Object.keys(packageJson.dependencies).length === 0,
  "no runtime dependencies are allowed",
);

const declared = packageJson.pi?.extensions;
expect(Array.isArray(declared), "pi.extensions must be an explicit array");
const normalized = Array.isArray(declared)
  ? declared.map((entry) => String(entry).replace(/^\.\//, ""))
  : [];
expect(
  JSON.stringify(normalized) === JSON.stringify(expectedEntrypoints),
  "pi.extensions differs from reviewed entrypoints",
);
expect(
  normalized.every((entry) => entry.endsWith("/index.ts")),
  "only feature index.ts files may be entrypoints",
);
expect(new Set(normalized).size === normalized.length, "duplicate extension entrypoint");
expect(
  JSON.stringify(packageJson.pi?.skills) === JSON.stringify(["./packages/web-search/skills"]),
  "pi.skills differs from reviewed resources",
);

for (const entrypoint of expectedEntrypoints) {
  try {
    const source = await readFile(entrypoint, "utf8");
    expect(
      /export\s+default\s+(?:function|\(?)/.test(source),
      `${entrypoint} has no default extension export`,
    );
  } catch {
    failures.push(`missing extension entrypoint: ${entrypoint}`);
  }
}

try {
  await access(resolve("packages/web-search/skills"));
} catch {
  failures.push("missing Web Search skill directory");
}

for (const name of ["preinstall", "install", "postinstall", "prepare"]) {
  expect(!packageJson.scripts?.[name], `forbidden lifecycle script: ${name}`);
}

if (failures.length > 0) {
  console.error(failures.map((failure) => `- ${failure}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Package manifest is valid (${expectedEntrypoints.length} explicit entrypoints).`);
}
