import { lexShellCommand } from "./shell-lexer.js";

type OptionArity = "none" | "required" | "optional-attached";

type OptionSpec = {
  long?: Readonly<Record<string, OptionArity>>;
  short?: Readonly<Record<string, OptionArity>>;
  abbreviateLong?: boolean;
};

type ParsedOption = {
  kind: "option";
  raw: string;
  name: string;
  short: boolean;
  value?: string;
  known: boolean;
};

type ParsedOperand = { kind: "operand"; value: string };
type ParsedArgument = ParsedOption | ParsedOperand;

const none = "none" satisfies OptionArity;
const required = "required" satisfies OptionArity;
const optionalAttached = "optional-attached" satisfies OptionArity;

function longOptions(
  entries: Readonly<Record<string, OptionArity>>,
): Readonly<Record<string, OptionArity>> {
  return entries;
}

function resolveLongOption(
  candidate: string,
  options: Readonly<Record<string, OptionArity>>,
  abbreviate: boolean,
): { name: string; known: boolean; arity: OptionArity } {
  const exact = options[candidate];
  if (exact) return { name: candidate, known: true, arity: exact };
  if (abbreviate && candidate.length > 0) {
    const matches = Object.keys(options).filter((name) => name.startsWith(candidate));
    if (matches.length === 1) {
      const name = matches[0]!;
      return { name, known: true, arity: options[name]! };
    }
  }
  return { name: candidate, known: false, arity: none };
}

/** Parse options without joining decoded arguments or losing their boundaries. */
function parseOptions(args: readonly string[], spec: OptionSpec = {}): ParsedArgument[] {
  const parsed: ParsedArgument[] = [];
  const long = spec.long ?? {};
  const short = spec.short ?? {};
  let optionsActive = true;

  for (let index = 0; index < args.length; index += 1) {
    const raw = args[index]!;
    if (optionsActive && raw === "--") {
      optionsActive = false;
      continue;
    }
    if (optionsActive && raw.startsWith("--") && raw.length > 2) {
      const equals = raw.indexOf("=");
      const candidate = raw.slice(2, equals < 0 ? undefined : equals);
      const resolved = resolveLongOption(candidate, long, spec.abbreviateLong ?? false);
      let value = equals < 0 ? undefined : raw.slice(equals + 1);
      if (resolved.arity === required && equals < 0 && index + 1 < args.length) {
        value = args[index + 1];
        index += 1;
      }
      parsed.push({
        kind: "option",
        raw,
        name: resolved.name,
        short: false,
        known: resolved.known,
        ...(value !== undefined ? { value } : {}),
      });
      continue;
    }
    if (optionsActive && raw.startsWith("-") && raw !== "-") {
      const cluster = raw.slice(1);
      for (let offset = 0; offset < cluster.length; offset += 1) {
        const name = cluster[offset]!;
        const arity = short[name] ?? none;
        let value: string | undefined;
        if (arity === required || arity === optionalAttached) {
          const attached = cluster.slice(offset + 1);
          if (attached) value = attached;
          else if (arity === required && index + 1 < args.length) {
            value = args[index + 1];
            index += 1;
          }
          parsed.push({
            kind: "option",
            raw,
            name,
            short: true,
            known: Object.hasOwn(short, name),
            ...(value !== undefined ? { value } : {}),
          });
          break;
        }
        parsed.push({
          kind: "option",
          raw,
          name,
          short: true,
          known: Object.hasOwn(short, name),
        });
      }
      continue;
    }
    parsed.push({ kind: "operand", value: raw });
  }
  return parsed;
}

function hasLongOption(parsed: readonly ParsedArgument[], names: readonly string[]): boolean {
  const wanted = new Set(names);
  return parsed.some((entry) => entry.kind === "option" && !entry.short && wanted.has(entry.name));
}

function hasShortOption(parsed: readonly ParsedArgument[], names: string): boolean {
  return parsed.some(
    (entry) => entry.kind === "option" && entry.short && names.includes(entry.name),
  );
}

function operands(parsed: readonly ParsedArgument[]): string[] {
  return parsed.flatMap((entry) => (entry.kind === "operand" ? [entry.value] : []));
}

const simpleReadOnlyCommands = new Set([
  "cat",
  "head",
  "tail",
  "grep",
  "ls",
  "pwd",
  "wc",
  "diff",
  "stat",
  "du",
  "df",
  "which",
  "whereis",
  "type",
  "printenv",
  "uname",
  "whoami",
  "id",
  "uptime",
  "ps",
  "free",
  "jq",
  "eza",
]);

const rgSpec: OptionSpec = {
  abbreviateLong: true,
  long: longOptions({
    "after-context": required,
    "before-context": required,
    color: required,
    colors: required,
    context: required,
    "context-separator": required,
    count: none,
    "count-matches": none,
    debug: none,
    encoding: required,
    engine: required,
    field: none,
    "field-context-separator": required,
    "field-match-separator": required,
    files: none,
    "files-with-matches": none,
    "files-without-match": none,
    glob: required,
    heading: none,
    help: none,
    hidden: none,
    "hostname-bin": required,
    "ignore-file": required,
    "ignore-file-case-insensitive": none,
    json: none,
    "line-number": none,
    "max-columns": required,
    "max-count": required,
    "max-depth": required,
    "max-filesize": required,
    "no-hostname-bin": none,
    "no-pre": none,
    "no-search-zip": none,
    "only-matching": none,
    passthru: none,
    "path-separator": required,
    pre: required,
    "pre-glob": required,
    pretty: none,
    quiet: none,
    regexp: required,
    replace: required,
    search: none,
    "search-zip": none,
    smart: none,
    "smart-case": none,
    sort: required,
    sortr: required,
    stats: none,
    trace: none,
    type: required,
    "type-add": required,
    "type-clear": required,
    "type-list": none,
    version: none,
  }),
  short: {
    A: required,
    B: required,
    C: required,
    E: required,
    e: required,
    f: required,
    g: required,
    j: required,
    m: required,
    M: required,
    r: required,
    t: required,
    T: required,
    z: none,
  },
};

function rgBlockReason(args: readonly string[]): string | undefined {
  const parsed = parseOptions(args, rgSpec);
  return hasShortOption(parsed, "z") || hasLongOption(parsed, ["pre", "search-zip", "hostname-bin"])
    ? "Preprocessors, archive search, and hostname helpers are blocked for rg in Plan Mode."
    : undefined;
}

const sortSpec: OptionSpec = {
  abbreviateLong: true,
  long: longOptions({
    "batch-size": required,
    "buffer-size": required,
    check: optionalAttached,
    "compress-program": required,
    debug: none,
    "field-separator": required,
    "files0-from": required,
    "general-numeric-sort": none,
    "human-numeric-sort": none,
    "ignore-case": none,
    "ignore-leading-blanks": none,
    "ignore-nonprinting": none,
    "ignore-diacritics": none,
    key: required,
    merge: none,
    "month-sort": none,
    "numeric-sort": none,
    output: required,
    parallel: required,
    "random-source": required,
    "random-sort": none,
    reverse: none,
    sort: required,
    stable: none,
    "temporary-directory": required,
    unique: none,
    version: none,
    "version-sort": none,
    "zero-terminated": none,
  }),
  short: {
    b: none,
    d: none,
    f: none,
    g: none,
    h: none,
    i: none,
    k: required,
    M: none,
    n: none,
    o: required,
    R: none,
    S: required,
    t: required,
    T: required,
    V: none,
  },
};

function sortBlockReason(args: readonly string[]): string | undefined {
  const parsed = parseOptions(args, sortSpec);
  return hasShortOption(parsed, "oT") ||
    hasLongOption(parsed, ["output", "temporary-directory", "compress-program"])
    ? "Output and helper-program sort options are blocked in Plan Mode."
    : undefined;
}

const uniqSpec: OptionSpec = {
  abbreviateLong: true,
  long: longOptions({
    "all-repeated": optionalAttached,
    "check-chars": required,
    count: none,
    group: optionalAttached,
    "ignore-case": none,
    repeated: none,
    "skip-chars": required,
    "skip-fields": required,
    unique: none,
    "zero-terminated": none,
  }),
  short: {
    D: optionalAttached,
    f: required,
    s: required,
    w: required,
  },
};

function uniqBlockReason(args: readonly string[]): string | undefined {
  return operands(parseOptions(args, uniqSpec)).length > 1
    ? "A second uniq operand is an output file and is blocked in Plan Mode."
    : undefined;
}

const fileSpec: OptionSpec = {
  abbreviateLong: true,
  long: longOptions({
    apple: none,
    brief: none,
    checking: none,
    compile: none,
    "exclude-quiet": required,
    exclude: required,
    files: required,
    "keep-going": none,
    list: none,
    magic: required,
    "mime-encoding": none,
    "mime-type": none,
    mime: none,
    "no-buffer": none,
    "no-dereference": none,
    "no-pad": none,
    "no-sandbox": none,
    parameter: required,
    preserve: none,
    print0: none,
    separator: required,
    "special-files": none,
    uncompress: none,
    "uncompress-noreport": none,
    version: none,
  }),
  short: {
    C: none,
    e: required,
    f: required,
    F: required,
    m: required,
    P: required,
    S: none,
    s: none,
    z: none,
    Z: none,
  },
};

function fileBlockReason(args: readonly string[]): string | undefined {
  const parsed = parseOptions(args, fileSpec);
  return hasShortOption(parsed, "CzZSs") ||
    hasLongOption(parsed, [
      "compile",
      "uncompress",
      "uncompress-noreport",
      "no-sandbox",
      "special-files",
    ])
    ? "Compilation, decompression, sandbox bypass, and special-file modes are blocked for file."
    : undefined;
}

const treeSpec: OptionSpec = {
  abbreviateLong: true,
  long: longOptions({
    charset: required,
    dirsfirst: none,
    filelimit: required,
    help: none,
    matchdirs: none,
    noreport: none,
    output: required,
    prune: none,
    timefmt: required,
    version: none,
  }),
  short: {
    H: required,
    I: required,
    L: required,
    o: required,
    P: required,
    R: none,
    r: none,
    T: required,
  },
};

function treeBlockReason(args: readonly string[]): string | undefined {
  const parsed = parseOptions(args, treeSpec);
  return hasShortOption(parsed, "oR") || hasLongOption(parsed, ["output"])
    ? "Output-file and recursive HTML tree modes are blocked in Plan Mode."
    : undefined;
}

const dateSpec: OptionSpec = {
  abbreviateLong: true,
  long: longOptions({
    date: required,
    debug: none,
    file: required,
    "iso-8601": optionalAttached,
    reference: required,
    resolution: none,
    "rfc-3339": required,
    "rfc-email": none,
    set: required,
    universal: none,
    utc: none,
    version: none,
  }),
  short: {
    d: required,
    f: required,
    I: optionalAttached,
    r: required,
    R: none,
    s: required,
    u: none,
  },
};

function dateBlockReason(args: readonly string[]): string | undefined {
  const parsed = parseOptions(args, dateSpec);
  if (hasShortOption(parsed, "s") || hasLongOption(parsed, ["set"])) {
    return "System-time setting is blocked for date in Plan Mode.";
  }
  if (operands(parsed).some((operand) => !operand.startsWith("+"))) {
    return "Legacy positional time-setting operands are blocked for date in Plan Mode.";
  }
  return undefined;
}

const fdSpec: OptionSpec = {
  abbreviateLong: true,
  long: longOptions({
    "absolute-path": none,
    "base-directory": required,
    "changed-before": required,
    "changed-within": required,
    color: required,
    command: required,
    "exec-batch": required,
    exec: required,
    exclude: required,
    extension: required,
    "file-system": none,
    "full-path": none,
    glob: none,
    hidden: none,
    ignore: none,
    "max-depth": required,
    "max-results": required,
    "min-depth": required,
    owner: required,
    path: required,
    size: required,
    type: required,
  }),
  short: {
    B: required,
    c: required,
    d: required,
    e: required,
    E: required,
    j: required,
    o: required,
    p: none,
    S: required,
    t: required,
    x: required,
    X: required,
  },
};

function fdBlockReason(args: readonly string[]): string | undefined {
  const parsed = parseOptions(args, fdSpec);
  return hasShortOption(parsed, "xX") || hasLongOption(parsed, ["exec", "exec-batch"])
    ? "Command execution through fd is blocked in Plan Mode."
    : undefined;
}

const batSpec: OptionSpec = {
  abbreviateLong: true,
  long: longOptions({
    acknowledgements: none,
    binary: required,
    "chop-long-lines": none,
    color: required,
    completion: required,
    decorations: required,
    diagnostic: none,
    diff: none,
    "diff-context": required,
    "file-name": required,
    "force-colorization": none,
    "generate-config-file": none,
    help: none,
    "highlight-line": required,
    "ignored-suffix": required,
    "italic-text": required,
    language: required,
    "line-range": required,
    "list-languages": none,
    "list-themes": none,
    "map-syntax": required,
    "nonprintable-notation": required,
    number: none,
    pager: required,
    paging: required,
    plain: none,
    "set-terminal-title": none,
    "show-all": none,
    "squeeze-blank": none,
    "squeeze-limit": required,
    "strip-ansi": required,
    style: required,
    tabs: required,
    "terminal-width": required,
    theme: required,
    "theme-dark": required,
    "theme-light": required,
    unbuffered: none,
    version: none,
    wrap: required,
  }),
  short: {
    A: none,
    d: none,
    f: none,
    H: required,
    h: none,
    l: required,
    L: none,
    m: required,
    n: none,
    p: none,
    P: none,
    r: required,
    s: none,
    S: none,
    t: required,
    u: none,
    V: none,
  },
};

function batBlockReason(args: readonly string[]): string | undefined {
  const parsed = parseOptions(args, batSpec);
  if (parsed.some((entry) => entry.kind === "option" && !entry.known)) {
    return "Unknown bat options are blocked because they can hide a state-changing subcommand.";
  }
  if (hasLongOption(parsed, ["generate-config-file", "pager"])) {
    return "Config-file generation and external pagers are blocked for bat in Plan Mode.";
  }
  const unsafePaging = parsed.some(
    (entry) =>
      entry.kind === "option" && !entry.short && entry.name === "paging" && entry.value !== "never",
  );
  if (unsafePaging) {
    return "Bat paging modes that can launch a pager are blocked in Plan Mode.";
  }
  if (operands(parsed)[0] === "cache") {
    return "The state-changing bat cache subcommand is blocked in Plan Mode.";
  }
  return undefined;
}

function findBlockReason(args: readonly string[]): string | undefined {
  const blocked = new Set([
    "-delete",
    "-exec",
    "-execdir",
    "-ok",
    "-okdir",
    "-fls",
    "-fprint",
    "-fprint0",
    "-fprintf",
  ]);
  return args.some((argument) => blocked.has(argument))
    ? "Mutating and command-executing find actions are blocked in Plan Mode."
    : undefined;
}

const nativeValidators: Readonly<Record<string, (args: readonly string[]) => string | undefined>> =
  {
    rg: rgBlockReason,
    sort: sortBlockReason,
    uniq: uniqBlockReason,
    file: fileBlockReason,
    tree: treeBlockReason,
    date: dateBlockReason,
    fd: fdBlockReason,
    bat: batBlockReason,
    find: findBlockReason,
  };

function nativeBlockReason(program: string, args: readonly string[]): string | undefined {
  if (simpleReadOnlyCommands.has(program)) return undefined;
  const validator = nativeValidators[program];
  return validator ? validator(args) : `Command '${program}' is not approved for Plan Mode.`;
}

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

const gitDangerSpec: OptionSpec = {
  abbreviateLong: true,
  long: longOptions({
    "ext-diff": none,
    "no-ext-diff": none,
    "no-textconv": none,
    output: required,
    "output-indicator-context": required,
    "output-indicator-new": required,
    "output-indicator-old": required,
    text: none,
    textconv: none,
  }),
};

const gitGlobalLongOptions = new Set([
  "--bare",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--no-pager",
  "--no-replace-objects",
  "--literal-pathspecs",
  "--glob-pathspecs",
  "--noglob-pathspecs",
  "--icase-pathspecs",
  "--no-optional-locks",
]);

function consumeGitGlobalOption(args: readonly string[], index: number): number | undefined {
  const token = args[index]!;
  if (token === "-C") return index + 1 < args.length ? index + 2 : args.length;
  if (token.startsWith("-C") && token.length > 2) return index + 1;
  const equals = token.indexOf("=");
  const name = equals < 0 ? token : token.slice(0, equals);
  if (!gitGlobalLongOptions.has(name)) return undefined;
  if (["--git-dir", "--work-tree", "--namespace"].includes(name) && equals < 0) {
    return index + 1 < args.length ? index + 2 : args.length;
  }
  return index + 1;
}

function gitDangerReason(args: readonly string[]): string | undefined {
  const parsed = parseOptions(args, gitDangerSpec);
  if (hasLongOption(parsed, ["output", "ext-diff", "textconv"])) {
    return "Git output files and external diff or textconv helpers are blocked in Plan Mode.";
  }
  return undefined;
}

function gitGrepBlockReason(args: readonly string[]): string | undefined {
  const danger = gitDangerReason(args);
  if (danger) return danger;
  const parsed = parseOptions(args, {
    abbreviateLong: true,
    long: longOptions({
      "after-context": required,
      "before-context": required,
      context: required,
      "files-with-matches": none,
      "files-without-match": none,
      "open-files-in-pager": optionalAttached,
      "only-matching": none,
      or: none,
      regexp: required,
    }),
    short: {
      A: required,
      B: required,
      C: required,
      e: required,
      f: required,
      m: required,
      O: optionalAttached,
    },
  });
  return hasShortOption(parsed, "O") || hasLongOption(parsed, ["open-files-in-pager"])
    ? "Opening Git grep matches in a pager is blocked in Plan Mode."
    : undefined;
}

function gitRemoteBlockReason(args: readonly string[]): string | undefined {
  let index = 0;
  while (args[index] === "-v" || args[index] === "--verbose") index += 1;
  if (index === args.length) return undefined;
  const action = args[index];
  const rest = args.slice(index + 1);
  if (action === "get-url") {
    const parsed = parseOptions(rest, {
      long: longOptions({ all: none, push: none }),
    });
    const unsupported = parsed.some(
      (entry) => entry.kind === "option" && (!entry.known || entry.short),
    );
    return !unsupported && operands(parsed).length === 1
      ? undefined
      : "Only read-only Git remote get-url forms are available in Plan Mode.";
  }
  if (action === "show") {
    const parsed = parseOptions(rest, {
      long: longOptions({ "no-query": none }),
      short: { n: none },
    });
    const noQuery = hasShortOption(parsed, "n") || hasLongOption(parsed, ["no-query"]);
    const unsupported = parsed.some(
      (entry) => entry.kind === "option" && (!entry.known || (entry.short && entry.name !== "n")),
    );
    return noQuery && !unsupported && operands(parsed).length > 0
      ? undefined
      : "Git remote show requires -n so that it does not query the remote in Plan Mode.";
  }
  return "Mutating Git remote commands are blocked in Plan Mode.";
}

const gitConfigMutationOptions = new Set([
  "--add",
  "--append",
  "--replace-all",
  "--unset",
  "--unset-all",
  "--edit",
  "--rename-section",
  "--remove-section",
  "--set",
]);
const gitConfigReadOptions = new Map<string, "get" | "list">([
  ["--get", "get"],
  ["--get-all", "get"],
  ["--get-regexp", "get"],
  ["--get-urlmatch", "get"],
  ["--get-color", "get"],
  ["--get-colorbool", "get"],
  ["--list", "list"],
]);
const gitConfigValueOptions = new Set(["--file", "--blob", "--type", "--default"]);
const gitConfigFlagOptions = new Set([
  "--global",
  "--system",
  "--local",
  "--worktree",
  "--includes",
  "--no-includes",
  "--show-origin",
  "--show-scope",
  "--name-only",
  "--fixed-value",
  "--null",
  "--bool",
  "--int",
  "--bool-or-int",
  "--bool-or-str",
  "--path",
  "--expiry-date",
  "--color",
]);

function gitConfigBlockReason(args: readonly string[]): string | undefined {
  let action: "get" | "list" | undefined;
  const actionOperands: string[] = [];
  const setAction = (candidate: "get" | "list"): boolean => {
    if (action) return false;
    action = candidate;
    return true;
  };

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (token === "--") {
      return "Git config -- placement is not approved in Plan Mode.";
    }
    if (token.startsWith("--")) {
      const equals = token.indexOf("=");
      const name = equals < 0 ? token : token.slice(0, equals);
      if (gitConfigMutationOptions.has(name)) {
        return "Mutating Git configuration actions are blocked in Plan Mode.";
      }
      const readAction = gitConfigReadOptions.get(name);
      if (readAction) {
        if (equals >= 0 || !setAction(readAction)) {
          return "Unsupported Git configuration action syntax is blocked in Plan Mode.";
        }
        continue;
      }
      if (gitConfigValueOptions.has(name)) {
        if (equals < 0) {
          if (index + 1 >= args.length) {
            return "A Git configuration option value is missing in Plan Mode.";
          }
          index += 1;
        }
        continue;
      }
      if (gitConfigFlagOptions.has(name) && equals < 0) continue;
      return "Unreviewed Git configuration options are blocked in Plan Mode.";
    }
    if (token.startsWith("-") && token !== "-") {
      const cluster = token.slice(1);
      for (let offset = 0; offset < cluster.length; offset += 1) {
        const name = cluster[offset]!;
        if (name === "e") {
          return "Mutating Git configuration actions are blocked in Plan Mode.";
        }
        if (name === "l") {
          if (!setAction("list")) {
            return "Unsupported Git configuration action syntax is blocked in Plan Mode.";
          }
          continue;
        }
        if (name === "z") continue;
        if (name === "f") {
          const attached = cluster.slice(offset + 1);
          if (!attached) {
            if (index + 1 >= args.length) {
              return "A Git configuration file option value is missing in Plan Mode.";
            }
            index += 1;
          }
          break;
        }
        return "Unreviewed Git configuration options are blocked in Plan Mode.";
      }
      continue;
    }
    if (!action && (token === "get" || token === "list")) {
      action = token;
      continue;
    }
    if (!action) {
      return "Only explicit read-only Git configuration forms are available in Plan Mode.";
    }
    actionOperands.push(token);
  }

  if (action === "list") {
    return actionOperands.length === 0
      ? undefined
      : "Git config list operands are not approved in Plan Mode.";
  }
  if (action === "get" && actionOperands.length > 0) return undefined;
  return "Only explicit read-only Git configuration forms are available in Plan Mode.";
}

function gitBlockReason(args: readonly string[]): string | undefined {
  if (args.length === 1 && ["-h", "--help", "-v", "--version"].includes(args[0]!)) {
    return undefined;
  }
  let index = 0;
  while (index < args.length && args[index]!.startsWith("-")) {
    if (args[index] === "--") {
      return "Git requires a reviewed subcommand before -- in Plan Mode.";
    }
    const next = consumeGitGlobalOption(args, index);
    if (next === undefined) {
      return "This Git global option is not approved in Plan Mode.";
    }
    index = next;
  }
  const subcommand = args[index];
  if (!subcommand) return "A reviewed Git subcommand is required in Plan Mode.";
  const subcommandArgs = args.slice(index + 1);
  const misplacedGlobal = subcommandArgs.some((argument) => {
    const name = argument.split("=", 1)[0]!;
    return gitGlobalLongOptions.has(name);
  });
  if (misplacedGlobal) return "Git global options must appear before the subcommand in Plan Mode.";
  if (subcommand === "remote") return gitRemoteBlockReason(subcommandArgs);
  if (subcommand === "config") return gitConfigBlockReason(subcommandArgs);
  if (!safeGitCommands.has(subcommand)) {
    return "This Git subcommand may change state and is blocked in Plan Mode.";
  }
  if (subcommand === "grep") return gitGrepBlockReason(subcommandArgs);
  return gitDangerReason(subcommandArgs);
}

const safePackageCommands: Readonly<Record<"npm" | "yarn" | "pnpm", ReadonlySet<string>>> = {
  npm: new Set(["list", "ls", "view", "info", "search", "outdated", "audit"]),
  yarn: new Set(["list", "info", "why", "audit"]),
  pnpm: new Set(["list", "ls", "view", "info", "why", "audit", "outdated"]),
};

const packageLeadingSpecs: Readonly<Record<"npm" | "yarn" | "pnpm", OptionSpec>> = {
  npm: {
    long: longOptions({
      all: none,
      cache: required,
      color: optionalAttached,
      depth: required,
      force: none,
      global: none,
      json: none,
      loglevel: required,
      long: none,
      parseable: none,
      prefix: required,
      registry: required,
      scope: required,
      silent: none,
      tag: required,
      unicode: optionalAttached,
      userconfig: required,
      workspace: required,
      workspaces: optionalAttached,
    }),
    short: { C: required, f: none, g: none, l: none, p: none, s: none, w: required },
  },
  yarn: {
    long: longOptions({
      "cache-folder": required,
      cwd: required,
      force: none,
      "global-folder": required,
      har: none,
      "ignore-scripts": none,
      json: none,
      "modules-folder": required,
      mutex: required,
      "network-timeout": required,
      "no-progress": none,
      offline: none,
      proxy: required,
      registry: required,
      silent: none,
      verbose: none,
    }),
    short: { f: none, s: none, v: none },
  },
  pnpm: {
    long: longOptions({
      color: optionalAttached,
      config: required,
      dir: required,
      filter: required,
      force: none,
      "global-dir": required,
      "global-pnpmfile": required,
      json: none,
      "lockfile-dir": required,
      recursive: none,
      registry: required,
      silent: none,
      "store-dir": required,
      "virtual-store-dir": required,
      "workspace-root": none,
    }),
    short: { C: required, F: required, r: none, s: none, w: none },
  },
};

function packageSubcommand(
  program: "npm" | "yarn" | "pnpm",
  args: readonly string[],
): { subcommand: string; args: string[] } | undefined {
  const spec = packageLeadingSpecs[program];
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (token === "--") return undefined;
    if (!token.startsWith("-") || token === "-") {
      return { subcommand: token, args: args.slice(index + 1) };
    }
    if (token.startsWith("--")) {
      const equals = token.indexOf("=");
      const name = token.slice(2, equals < 0 ? undefined : equals);
      const arity = spec.long?.[name];
      if (!arity) return undefined;
      if (arity === required && equals < 0) {
        if (index + 1 >= args.length) return undefined;
        index += 1;
      }
      continue;
    }
    const cluster = token.slice(1);
    for (let offset = 0; offset < cluster.length; offset += 1) {
      const arity = spec.short?.[cluster[offset]!];
      if (!arity) return undefined;
      if (arity === required) {
        if (offset === cluster.length - 1) {
          if (index + 1 >= args.length) return undefined;
          index += 1;
        }
        break;
      }
    }
  }
  return undefined;
}

const npmMutationSpec: OptionSpec = {
  abbreviateLong: true,
  long: longOptions({
    fix: none,
    force: none,
    "foreground-scripts": none,
    fund: none,
  }),
  short: { f: none },
};
const yarnMutationSpec: OptionSpec = {
  abbreviateLong: true,
  long: longOptions({
    force: none,
    "frozen-lockfile": none,
    har: none,
    help: none,
    mutex: required,
  }),
  short: { f: none },
};
const pnpmMutationSpec: OptionSpec = {
  abbreviateLong: true,
  long: longOptions({ fix: none, force: none, "fix-lockfile": none }),
};
const auditOperandSpec: OptionSpec = {
  long: longOptions({
    "audit-level": required,
    dev: none,
    filter: required,
    ignore: required,
    "ignore-registry-errors": none,
    json: none,
    "no-optional": none,
    omit: required,
    optional: none,
    prod: none,
    production: none,
    workspace: required,
  }),
  short: { F: required, w: required },
};

function packageBlockReason(
  program: "npm" | "yarn" | "pnpm",
  args: readonly string[],
): string | undefined {
  const invocation = packageSubcommand(program, args);
  if (!invocation || !safePackageCommands[program].has(invocation.subcommand)) {
    return `This ${program} subcommand may change state and is blocked in Plan Mode.`;
  }
  const allArgs = args;
  if (program === "npm") {
    const parsed = parseOptions(allArgs, npmMutationSpec);
    if (hasShortOption(parsed, "f") || hasLongOption(parsed, ["fix", "force"])) {
      return "Npm fix and force modes are blocked in Plan Mode.";
    }
  } else if (program === "yarn") {
    const parsed = parseOptions(allArgs, yarnMutationSpec);
    if (hasShortOption(parsed, "f") || hasLongOption(parsed, ["mutex", "har", "force"])) {
      return "Yarn mutex, HAR, and force modes are blocked in Plan Mode.";
    }
  } else {
    const parsed = parseOptions(allArgs, pnpmMutationSpec);
    if (hasLongOption(parsed, ["fix", "fix-lockfile", "force"])) {
      return "Pnpm fix and force modes are blocked in Plan Mode.";
    }
  }
  if (
    invocation.subcommand === "audit" &&
    operands(parseOptions(invocation.args, auditOperandSpec)).includes("fix")
  ) {
    return `${program} audit fix is blocked in Plan Mode.`;
  }
  return undefined;
}

const rtkGlobalOptions = new Set([
  "--skip-env",
  "--ultra-compact",
  "--verbose",
  "-v",
  "-vv",
  "-vvv",
]);

type RtkDelegate =
  | { kind: "simple" }
  | { kind: "native"; command: string }
  | { kind: "git" }
  | { kind: "package"; program: "npm" | "pnpm" };

const rtkDelegates: Readonly<Record<string, RtkDelegate>> = {
  read: { kind: "simple" },
  grep: { kind: "native", command: "grep" },
  rg: { kind: "native", command: "rg" },
  find: { kind: "native", command: "find" },
  ls: { kind: "native", command: "ls" },
  tree: { kind: "native", command: "tree" },
  wc: { kind: "native", command: "wc" },
  diff: { kind: "native", command: "diff" },
  json: { kind: "simple" },
  env: { kind: "simple" },
  git: { kind: "git" },
  npm: { kind: "package", program: "npm" },
  pnpm: { kind: "package", program: "pnpm" },
};

let configuredCommands: Record<string, ReadonlySet<string>> = {};
let rtkDelegationApproved = false;

export function isSupportedRtkVersion(output: string | undefined): boolean {
  return typeof output === "string" && /^rtk 0\.27\.\d+(?:\r\n|\n)?(?![\s\S])/.test(output);
}

export function configureBashPolicy(config: {
  readOnlyCommands?: Record<string, string[]>;
  rtkVersion?: string;
}): void {
  configuredCommands = Object.fromEntries(
    Object.entries(config.readOnlyCommands ?? {}).map(([program, commands]) => [
      program,
      new Set(commands),
    ]),
  );
  rtkDelegationApproved = isSupportedRtkVersion(config.rtkVersion);
}

function rtkBlockReason(args: readonly string[]): string | undefined {
  if (args.length === 0) return undefined;
  if (args.length === 1 && ["-h", "--help", "-V", "--version", "help"].includes(args[0]!)) {
    return undefined;
  }
  let index = 0;
  while (rtkGlobalOptions.has(args[index] ?? "")) index += 1;
  const subcommand = args[index];
  if (!subcommand || subcommand === "--" || subcommand.startsWith("-")) {
    return "Unknown RTK global options and unsupported -- placement are blocked in Plan Mode.";
  }
  if (!rtkDelegationApproved) {
    return "Delegated RTK commands require an audited RTK 0.27.x version in Plan Mode.";
  }
  const delegate = rtkDelegates[subcommand];
  if (!delegate) {
    return `This rtk ${subcommand} command is not approved for Plan Mode.`;
  }
  const delegatedArgs = args.slice(index + 1);
  if (delegate.kind === "simple") return undefined;
  if (delegate.kind === "git") return gitBlockReason(delegatedArgs);
  if (delegate.kind === "package") {
    return packageBlockReason(delegate.program, delegatedArgs);
  }
  return nativeBlockReason(delegate.command, delegatedArgs);
}

/** A conservative literal-command allowlist with version-gated RTK equivalents. */
export function bashBlockReason(command: string): string | undefined {
  const lexed = lexShellCommand(command);
  if (!lexed.ok) return lexed.rejection.message;
  const [program, ...args] = lexed.argv;
  if (!program) return "Empty Bash commands are not useful in Plan Mode.";
  if (program.includes("/")) {
    return "Only explicitly allowlisted inspection commands are available in Plan Mode.";
  }
  if (program === "rtk") return rtkBlockReason(args);
  if (simpleReadOnlyCommands.has(program) || nativeValidators[program]) {
    return nativeBlockReason(program, args);
  }
  if (program === "git") return gitBlockReason(args);
  if (["node", "python", "python3", "bun"].includes(program)) {
    return args.length === 1 && ["--version", "-v"].includes(args[0]!)
      ? undefined
      : `Arbitrary ${program} execution is blocked in Plan Mode.`;
  }
  if (program === "npm" || program === "yarn" || program === "pnpm") {
    return packageBlockReason(program, args);
  }
  const configuredSubcommands = configuredCommands[program];
  if (configuredSubcommands?.has(args[0] ?? "")) return undefined;
  return `Command '${program}' is not on the Plan Mode inspection allowlist.`;
}
