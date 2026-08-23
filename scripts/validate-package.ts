import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const expectedEntrypoints = [
  "packages/ask-user-question/index.ts",
  "packages/workflow-finalization/index.ts",
  "packages/plan-mode/index.ts",
  "packages/repository-reference/index.ts",
  "packages/notify/index.ts",
  "packages/todos/index.ts",
  "packages/context-size/index.ts",
  "packages/codex-compaction/index.ts",
  "packages/large-paste/index.ts",
  "packages/model-cost-badges/index.ts",
  "packages/stats/index.ts",
  "packages/subagents/index.ts",
  "packages/uv/index.ts",
  "packages/working-indicator/index.ts",
  "packages/web-search/index.ts",
  "packages/context-mode/index.ts",
  "packages/usage-meter/index.ts",
  "packages/session-summary/index.ts",
];

const expectedProductionDependencies = {
  "@github/copilot-sdk": "1.0.9",
};

const expectedSkills = [
  "./packages/web-search/skills",
  "./packages/subagents/skills",
  "./packages/bro/skills",
  "./packages/ste-writing/skills",
  "./packages/grilling/skills",
];

const expectedSkillFiles = [
  { path: "packages/bro/skills/bro/SKILL.md", name: "bro", requiresManualInvocation: false },
  {
    path: "packages/grilling/skills/grilling/SKILL.md",
    name: "grilling",
    requiresManualInvocation: false,
  },
  {
    path: "packages/grilling/skills/grill-me/SKILL.md",
    name: "grill-me",
    requiresManualInvocation: true,
  },
] as const;

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
expect(packageJson.engines?.node === ">=22.12.0", "package must require Node.js >=22.12.0");
expect(
  Array.isArray(packageJson.keywords) && packageJson.keywords.includes("pi-package"),
  "package must advertise the pi-package keyword",
);
expect(
  JSON.stringify(packageJson.dependencies) === JSON.stringify(expectedProductionDependencies),
  "production dependencies differ from the reviewed allowlist",
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
  JSON.stringify(packageJson.pi?.skills) === JSON.stringify(expectedSkills),
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

for (const skillDirectory of expectedSkills.map((entry) => entry.replace(/^\.\//, ""))) {
  try {
    await access(resolve(skillDirectory));
  } catch {
    failures.push(`missing skill directory: ${skillDirectory}`);
  }
}

for (const skill of expectedSkillFiles) {
  try {
    const source = await readFile(skill.path, "utf8");
    expect(
      new RegExp(`^name: ${skill.name}$`, "m").test(source),
      `${skill.name} skill must declare name: ${skill.name}`,
    );
    if (skill.requiresManualInvocation)
      expect(
        /^disable-model-invocation: true$/m.test(source),
        "grill-me skill must disable model invocation",
      );
  } catch {
    failures.push(`missing skill: ${skill.path}`);
  }
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
