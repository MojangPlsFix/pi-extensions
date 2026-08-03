const safeCommands = new Set([
  "cat",
  "head",
  "tail",
  "grep",
  "rg",
  "ls",
  "pwd",
  "wc",
  "sort",
  "uniq",
  "diff",
  "file",
  "stat",
  "du",
  "df",
  "tree",
  "which",
  "whereis",
  "type",
  "printenv",
  "uname",
  "whoami",
  "id",
  "date",
  "uptime",
  "ps",
  "free",
  "jq",
  "fd",
  "bat",
  "eza",
]);
const safeGitCommands = new Set([
  "status",
  "log",
  "diff",
  "show",
  "grep",
  "ls-files",
  "ls-tree",
  "rev-parse",
  "describe",
]);
const safePackageCommands: Record<string, ReadonlySet<string>> = {
  npm: new Set(["list", "ls", "view", "info", "search", "outdated", "audit"]),
  yarn: new Set(["list", "info", "why", "audit"]),
  pnpm: new Set(["list", "ls", "view", "info", "why", "audit", "outdated"]),
};
const safeRtkCommands = new Set([
  "deps",
  "diff",
  "discover",
  "env",
  "gain",
  "grep",
  "hook-audit",
  "json",
  "log",
  "ls",
  "read",
  "rewrite",
  "rg",
  "session",
  "tree",
  "wc",
]);
const rtkGlobalOptions = new Set([
  "--skip-env",
  "--ultra-compact",
  "--verbose",
  "-v",
  "-vv",
  "-vvv",
]);

const shellControl = /[\n\r;&|<>`]|\$\(|\$\{|\(\s*\)|\\\n/;
const findMutation =
  /(?:^|\s)-(?:delete|exec|execdir|ok|okdir|fls|fprint|fprint0|fprintf)(?:\s|$)/i;
const outputOption = /(?:^|\s)(?:-o|--output)(?:=|\s|$)/i;
const gitOutput = /(?:^|\s)--(?:output|ext-diff)(?:=|\s|$)/i;
const packageMutation = /(?:^|\s)--(?:fix|force)(?:=|\s|$)/i;

function tokens(command: string): string[] {
  return command
    .trim()
    .split(/\s+/)
    .map((token) => token.replace(/^["']|["']$/g, ""));
}

function gitBlockReason(args: string[]): string | undefined {
  const [subcommand, third] = args;
  const command = args.join(" ");
  if (subcommand === "remote")
    return !third || ["-v", "--verbose", "show", "get-url"].includes(third)
      ? undefined
      : "Mutating Git remote commands are blocked in Plan Mode.";
  if (subcommand === "config")
    return ["--get", "--get-all", "--list"].includes(third ?? "")
      ? undefined
      : "Mutating Git configuration is blocked in Plan Mode.";
  return subcommand && safeGitCommands.has(subcommand) && !gitOutput.test(command)
    ? undefined
    : "This Git command may change state and is blocked in Plan Mode.";
}

function packageBlockReason(program: "npm" | "yarn" | "pnpm", args: string[]): string | undefined {
  const [subcommand] = args;
  return subcommand &&
    safePackageCommands[program]?.has(subcommand) &&
    !packageMutation.test(args.join(" "))
    ? undefined
    : `This ${program} command may change state and is blocked in Plan Mode.`;
}

function rtkBlockReason(commandTokens: string[]): string | undefined {
  let index = 1;
  while (rtkGlobalOptions.has(commandTokens[index] ?? "")) index += 1;
  const subcommand = commandTokens[index];
  const args = commandTokens.slice(index + 1);

  if (!subcommand || ["-h", "--help", "-V", "--version", "help"].includes(subcommand))
    return undefined;
  if (subcommand === "git") return gitBlockReason(args);
  if (subcommand === "npm" || subcommand === "pnpm") return packageBlockReason(subcommand, args);
  if (subcommand === "find")
    return findMutation.test(args.join(" "))
      ? "Mutating rtk find actions are blocked in Plan Mode."
      : undefined;
  if (subcommand === "smart")
    return args.includes("--force-download")
      ? "Downloading models through rtk smart is blocked in Plan Mode."
      : undefined;
  if (safeRtkCommands.has(subcommand)) return undefined;
  return `This rtk ${subcommand} command is not approved for read-only Plan Mode use.`;
}

let configuredCommands: Record<string, ReadonlySet<string>> = {};

export function configureBashPolicy(config: { readOnlyCommands?: Record<string, string[]> }): void {
  configuredCommands = Object.fromEntries(
    Object.entries(config.readOnlyCommands ?? {}).map(([program, commands]) => [
      program,
      new Set(commands),
    ]),
  );
}

/** A conservative inspection allowlist with optional token-optimized RTK equivalents. */
export function bashBlockReason(command: string): string | undefined {
  const trimmed = command.trim();
  if (!trimmed) return "Empty Bash commands are not useful in Plan Mode.";
  if (shellControl.test(trimmed))
    return "Shell composition, redirection, substitution, and chained commands are blocked in Plan Mode.";
  const commandTokens = tokens(trimmed);
  const [program, subcommand] = commandTokens;
  if (!program || program.includes("/"))
    return "Only explicitly allowlisted inspection commands are available in Plan Mode.";
  if (program === "rtk") return rtkBlockReason(commandTokens);
  if (safeCommands.has(program)) {
    return (program === "sort" || program === "diff") && outputOption.test(trimmed)
      ? `Output-writing ${program} options are blocked in Plan Mode.`
      : undefined;
  }
  if (program === "find")
    return findMutation.test(trimmed)
      ? "Mutating find actions are blocked in Plan Mode."
      : undefined;
  if (program === "git") return gitBlockReason(commandTokens.slice(1));
  if (["node", "python", "python3", "bun"].includes(program))
    return ["--version", "-v"].includes(subcommand ?? "")
      ? undefined
      : `Arbitrary ${program} execution is blocked in Plan Mode.`;
  if (program === "npm" || program === "yarn" || program === "pnpm")
    return packageBlockReason(program, commandTokens.slice(1));
  const configuredSubcommands = configuredCommands[program];
  if (configuredSubcommands?.has(subcommand ?? "")) return undefined;
  return `Command '${program}' is not on the Plan Mode inspection allowlist.`;
}
