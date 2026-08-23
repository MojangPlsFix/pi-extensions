import { beforeEach, describe, expect, it } from "vitest";
import { configureBashPolicy } from "../bash-policy.js";
import {
  bashBlockReason,
  configurePlanModePolicy,
  isDirectlyDisabledInPlanMode,
  planModeToolBlockReason,
} from "../policy.js";

function expectAllowed(commands: readonly string[]): void {
  for (const command of commands) expect(bashBlockReason(command), command).toBeUndefined();
}

function expectBlocked(commands: readonly string[]): void {
  for (const command of commands) expect(bashBlockReason(command), command).toBeTruthy();
}

beforeEach(() => {
  configurePlanModePolicy({ readOnlyTools: [] });
  configureBashPolicy({ readOnlyCommands: {} });
});

describe("Plan Mode tool policy", () => {
  it("disables direct mutations and permits reviewed reads", () => {
    expect(isDirectlyDisabledInPlanMode("edit")).toBe(true);
    expect(isDirectlyDisabledInPlanMode("functions.ctx_purge")).toBe(true);
    expect(planModeToolBlockReason("read", { path: "README.md" })).toBeUndefined();
    expect(planModeToolBlockReason("memory_read", { target: "long_term" })).toBeUndefined();
    expect(planModeToolBlockReason("memory_search", { query: "plan" })).toBeUndefined();
    expect(
      planModeToolBlockReason("memory_write", { target: "daily", content: "note" }),
    ).toBeUndefined();
    expect(
      planModeToolBlockReason("memory_write", {
        target: "long_term",
        content: "fact",
        mode: "append",
      }),
    ).toBeUndefined();
    expect(
      planModeToolBlockReason("memory_write", {
        target: "long_term",
        content: "fact",
        mode: "overwrite",
      }),
    ).toContain("append-only");
    expect(
      planModeToolBlockReason("memory_write", { target: "scratchpad", content: "note" }),
    ).toContain("append-only");
    expect(planModeToolBlockReason("functions.ctx_execute", {})).toContain("disabled");
    for (const tool of [
      "search",
      "ctx_search",
      "ctx_stats",
      "ctx_doctor",
      "ctx_index",
      "ctx_fetch_and_index",
      "subagent_dispatch",
      "subagent_status",
      "subagent_collect",
      "subagent_steer",
      "subagent_stop",
      "repository_reference",
    ]) {
      expect(planModeToolBlockReason(tool, {}), tool).toBeUndefined();
    }
    expect(planModeToolBlockReason("unreviewed_tool", {})).toContain("Unreviewed");
  });

  it("continues to hard-block Context execution after a tool is reactivated", () => {
    for (const tool of ["ctx_execute", "ctx_execute_file", "ctx_batch_execute"]) {
      expect(planModeToolBlockReason(tool, {}), tool).toContain("disabled");
    }
  });
});

describe("Plan Mode literal Bash policy", () => {
  it("allows the native inspection commands and the reported quoted regex", () => {
    expectAllowed([
      "cat README.md",
      "head README.md",
      "tail README.md",
      "grep Plan README.md",
      "rg Plan README.md",
      "rg -n -i -S 'working indicator|working status|session summary' README.md docs packages",
      "ls packages",
      "pwd",
      "wc README.md",
      "sort README.md",
      "uniq README.md",
      "diff README.md README.md",
      "file README.md",
      "stat README.md",
      "du .",
      "df .",
      "tree packages",
      "which node",
      "whereis node",
      "type node",
      "printenv HOME",
      "uname -a",
      "whoami",
      "id",
      "date",
      "uptime",
      "ps",
      "free",
      "jq . package.json",
      "fd policy packages",
      "bat README.md",
      "eza packages",
      "find . -name '*.ts'",
      "git status",
      "git config --get user.name",
      "npm ls",
      "yarn list",
      "pnpm outdated",
      "node --version",
      "python --version",
      "python3 --version",
      "bun --version",
    ]);
  });

  it("blocks real shell composition and expansion but permits literal metacharacters", () => {
    expectAllowed([
      "rg 'a|b' README.md",
      "rg a\\|b README.md",
      "rg '$HOME $(pwd) *.ts {a,b}' README.md",
      'rg "\\$HOME" README.md',
      String.raw`rg \*.ts README.md`,
    ]);
    expectBlocked([
      "cat a | cat",
      "git status && git log",
      "cat a > b",
      "cat $HOME",
      "cat $(pwd)",
      "cat `pwd`",
      "rg A+=~ README.md",
      "rtk rg A+=foo:~ README.md",
      "rg *.ts",
      "rg {a,b}",
      "ls ~",
      "rg pattern # active comment",
      "rg pattern\nREADME.md",
    ]);
  });

  it("blocks audited native utility write, execution, and delegation modes", () => {
    expectBlocked([
      "rg --pre cat pattern",
      "rg --pre=cat pattern",
      "rg -z pattern",
      "rg -nz pattern",
      "rg --search-zip pattern",
      "rg --search-z pattern",
      "rg --hostname-bin=hostname pattern",
      "rg --host=hostname pattern",
      "rg --sear'ch-zip' pattern",
      "sort -o result input",
      "sort -oresult input",
      "sort -uoresult input",
      "sort --output=result input",
      "sort --out=result input",
      "sort -T/tmp input",
      "sort --temporary-directory /tmp input",
      "sort --compress-program=gzip input",
      "uniq input output",
      "uniq -f 2 input output",
      "uniq --skip-chars=2 input output",
      "file -C",
      "file -bz sample.gz",
      "file -Z sample.gz",
      "file --uncompress sample.gz",
      "file --uncompress-noreport sample.gz",
      "file -S sample",
      "file --special-files /dev/null",
      "tree -o tree.txt .",
      "tree -otree.txt .",
      "tree -R .",
      "date -s tomorrow",
      "date -u tomorrow",
      "date --set=tomorrow",
      "date --s tomorrow",
      "date 010100002030",
      "fd -x echo pattern",
      "fd -p -x echo pattern",
      "fd -px echo pattern",
      "fd -p -X echo pattern",
      "fd -Xecho pattern",
      "fd --exec=echo pattern",
      "fd --exec-batch echo pattern",
      "bat --generate-config-file",
      "bat --generate-conf",
      "bat cache --build",
      "bat --tabs 4 cache --build",
      "bat -S cache --build",
      "bat --pager less README.md",
      "bat --paging=always README.md",
      "bat --paging auto README.md",
      "bat --paging=never --paging=always README.md",
      "find . -name file -delete",
      "find . -type f -exec echo '{}' ';'",
      "find . -execdir echo '{}' ';'",
      "find . -ok echo '{}' ';'",
      "find . -okdir echo '{}' ';'",
      "find . -fls out",
      "find . -fprint out",
      "find . -fprint0 out",
      "find . -fprintf out '%p\\n'",
    ]);
  });

  it("preserves safe option collisions and read-only actions", () => {
    expectAllowed([
      "rg --pre-glob '*.md' pattern",
      "rg --replace replacement pattern",
      "grep -o pattern README.md",
      "fd -o root pattern",
      "fd -p pattern",
      "fd --full-path pattern",
      "df --output=source,size .",
      "eza -o .",
      "diff --color=always a b",
      "tree -r .",
      "uniq -f 2 input",
      "uniq --check-chars 3 input",
      "date +%FT%T",
      "date -d yesterday +%F",
      "date --reference README.md +%s",
      "bat --paging=never README.md",
      "bat -P README.md",
      "find . -print",
      "find . -print0",
      "find . -printf '%p\\n'",
      "find . -ls",
    ]);
  });

  it("parses Git subcommands, options, remotes, and configuration structurally", () => {
    expectAllowed([
      "git status",
      "git -C . status --short",
      "git --no-pager log --oneline",
      "git log --format='%h %s'",
      "git diff --output-indicator-new=X",
      "git grep -o pattern",
      "git remote",
      "git remote -v",
      "git remote get-url origin",
      "git remote get-url --all origin",
      "git remote show -n origin",
      "git remote show --no-query origin",
      "git config --get user.name",
      "git config --global --get-all user.email",
      "git config --list",
      "git config --get set",
      "git config -f config.example --get user.name",
      "git config get user.name",
      "git config list",
    ]);
    expectBlocked([
      "git commit -m test",
      "git checkout main",
      "git --unknown status",
      "git status --no-pager",
      "git diff --output=result.patch",
      "git diff --ext-diff",
      "git show --textconv HEAD:file",
      "git grep -O pattern",
      "git grep -Oless pattern",
      "git grep --open-files-in-pager=less pattern",
      "git remote show origin",
      "git remote add origin example.invalid/repo",
      "git remote set-url origin example.invalid/repo",
      "git config user.name value",
      "git config set user.name value",
      "git config --add user.name value",
      "git config --append user.name value",
      "git config --replace-all user.name value",
      "git config --unset user.name",
      "git config --edit",
      "git config -e",
      "git config -f get user.name owned",
      "git config -f get -e",
      "git config rename-section old new",
      "git config remove-section old",
    ]);
  });

  it("permits only reviewed package-manager reports and blocks mutation modes", () => {
    expectAllowed([
      "npm audit",
      "npm --json audit",
      "npm audit --json",
      "npm audit --audit-level high",
      "npm outdated --json",
      "yarn audit",
      "yarn info package",
      "pnpm audit --json",
      "pnpm outdated",
    ]);
    expectBlocked([
      "npm install package",
      "npm audit fix",
      "npm audit --json fix",
      "npm --json audit fix",
      "npm audit fix --json",
      "npm audit --fix",
      "npm audit --fi",
      "npm audit --force",
      "npm audit -f",
      "npm --user-agent audit install left-pad",
      "yarn add package",
      "yarn audit --mutex network",
      "yarn --mutex network audit",
      "yarn audit --har",
      "yarn audit --force",
      "yarn audit -f",
      "pnpm install package",
      "pnpm audit fix",
      "pnpm audit --fix",
      "pnpm audit --force",
      "pnpm audit --forc",
      "pnpm audit --fix-lockfile",
      "npm unknown",
      "yarn unknown",
      "pnpm unknown",
    ]);
  });

  it("supports exact configured CLI approvals without enabling shell grammar", () => {
    configurePlanModePolicy({ readOnlyTools: ["functions.example_external_tool"] });
    configureBashPolicy({
      readOnlyCommands: { "example-cli": ["help", "inspect", "list"] },
    });
    expect(planModeToolBlockReason("functions.example_external_tool", {})).toBeUndefined();
    expect(planModeToolBlockReason("example_external_tool_extra", {})).toContain("Unreviewed");
    expect(planModeToolBlockReason("write", {})).toContain("disabled");
    expectAllowed([
      "example-cli help inspect",
      "example-cli inspect item-123",
      "example-cli in'spect' item-123",
    ]);
    expectBlocked([
      "example-cli delete item-123",
      "example-cli inspect item-123 && example-cli delete item-123",
      "example-cli inspect $HOME",
      "example-cli inspect A+=foo:~",
    ]);
  });
});

describe("Plan Mode RTK policy", () => {
  it("dispatches decoded argv through the native policy with authorization parity", () => {
    const pairs = [
      ["cat README.md", "rtk cat README.md"],
      ["stat README.md", "rtk stat README.md"],
      ["date +%FT%T", "rtk date +%FT%T"],
      ["rg pattern README.md", "rtk rg pattern README.md"],
      ["find . -print", "rtk find . -print"],
      ["tree -r .", "rtk tree -r ."],
      ["grep -o pattern README.md", "rtk grep -o pattern README.md"],
      ["wc README.md", "rtk wc README.md"],
      ["ls -la", "rtk ls -la"],
      ["find . -maxdepth 3 -type f -print", "rtk find . -maxdepth 3 -type f -print"],
      ["git status --short --branch", "rtk git status --short --branch"],
      [
        "stat -c path=%n,size=%s_bytes,mode=%a,modified=%y FILE",
        "rtk stat -c path=%n,size=%s_bytes,mode=%a,modified=%y FILE",
      ],
      ["diff --color=always a b", "rtk diff --color=always a b"],
      ["git diff --output-indicator-new=X", "rtk git diff --output-indicator-new=X"],
      ["npm audit --json", "rtk npm audit --json"],
      ["yarn list", "rtk yarn list"],
      ["yarn info package", "rtk yarn info package"],
      ["pnpm outdated", "rtk pnpm outdated"],
      ["node --version", "rtk node --version"],
      ["rg --pre cat pattern", "rtk rg --pre cat pattern"],
      ["find . -delete", "rtk find . -delete"],
      ["find . -exec echo '{}' ';'", "rtk find . -exec echo '{}' ';'"],
      ["tree -o out .", "rtk tree -o out ."],
      ["git diff --output=out", "rtk git diff --output=out"],
      ["git diff --ext-diff", "rtk git diff --ext-diff"],
      ["npm audit fix", "rtk npm audit fix"],
      ["yarn add package", "rtk yarn add package"],
      ["pnpm audit --fix", "rtk pnpm audit --fix"],
      ["node script.js", "rtk node script.js"],
      ["unknown inspect", "rtk unknown inspect"],
    ] as const;
    for (const [native, delegated] of pairs) {
      expect(Boolean(bashBlockReason(delegated)), delegated).toBe(Boolean(bashBlockReason(native)));
    }
  });

  it("preserves quoted argv boundaries and literal pipes without reconstruction", () => {
    expectAllowed([
      "rtk rg 'two words' 'file name.md'",
      "rtk rg 'left|right' README.md",
      "rtk rg '|' README.md",
      "rtk --verbose rg 'working indicator|working status' 'README file.md'",
    ]);
    expectBlocked(["rtk rg two words | cat", "rtk rg pattern README.md | cat", "rtk rg $(pwd)"]);
  });

  it("accepts only the exact RTK root grammar and leading globals", () => {
    expectAllowed([
      "rtk",
      "rtk help",
      "rtk -h",
      "rtk --help",
      "rtk -V",
      "rtk --version",
      "rtk --ultra-compact rg pattern README.md",
      "rtk --verbose rg pattern README.md",
      "rtk -v rg pattern README.md",
      "rtk -vv rg pattern README.md",
      "rtk -vvv rg pattern README.md",
      "rtk --ultra-compact --verbose -v -vv -vvv rg pattern README.md",
    ]);
    expectBlocked([
      "rtk help rg",
      "rtk --help rg",
      "rtk --version rg",
      "rtk --verbose",
      "rtk --verbose help",
      "rtk --skip-env rg pattern",
      "rtk --unknown rg pattern",
      "rtk -- rg pattern",
      "rtk rg --verbose pattern",
      "rtk rg pattern -vv",
      "rtk rg --skip-env pattern",
      "rtk rtk rg pattern",
      "rtk /usr/bin/rg pattern",
    ]);
  });

  it("hard-denies RTK-owned non-wrappers and gh before configured routing", () => {
    const hardDenied = [
      "rewrite",
      "run",
      "proxy",
      "session",
      "smart",
      "gain",
      "discover",
      "learn",
      "init",
      "config",
      "hook",
      "hook-audit",
      "pipe",
      "cc-economics",
      "verify",
      "trust",
      "untrust",
      "telemetry",
      "test",
      "err",
      "summary",
      "deps",
      "log",
    ];
    configureBashPolicy({
      readOnlyCommands: Object.fromEntries(
        hardDenied.concat("gh").map((name) => [name, ["inspect"]]),
      ),
    });
    expectBlocked([
      ...hardDenied.map((name) => `rtk ${name} inspect`),
      "gh inspect",
      "rtk gh inspect",
    ]);
  });

  it("routes configured commands while preserving built-in and hard-deny collisions", () => {
    configureBashPolicy({
      readOnlyCommands: {
        "example-cli": ["inspect"],
        rg: ["unsafe"],
        gh: ["inspect"],
        run: ["inspect"],
      },
    });
    expectAllowed([
      "example-cli inspect 'item 123'",
      "rtk example-cli inspect 'item 123'",
      "run inspect",
    ]);
    expectBlocked([
      "example-cli delete item",
      "rtk example-cli delete item",
      "rg --pre cat unsafe",
      "rtk rg --pre cat unsafe",
      "gh inspect",
      "rtk gh inspect",
      "rtk run inspect",
    ]);
  });

  it("enforces the strict RTK read grammar", () => {
    expectAllowed([
      "rtk read README.md",
      "rtk read 'file one.md' file-two.md",
      "rtk read -n README.md",
      "rtk read --line-numbers README.md",
      "rtk read -l none README.md",
      "rtk read -lminimal README.md",
      "rtk read --level minimal README.md",
      "rtk read --level=aggressive README.md",
      "rtk read -m 0 README.md",
      "rtk read -m42 README.md",
      "rtk read --max-lines 12 README.md",
      "rtk read --max-lines=12 README.md",
      "rtk read --tail-lines 7 README.md",
      "rtk read -- -leading-file",
      "rtk read README.md -- '|'",
      "rtk read -h",
      "rtk read --help",
    ]);
    expectBlocked([
      "rtk read",
      "rtk read ''",
      "rtk read -- ''",
      "rtk read -h README.md",
      "rtk read --help README.md",
      "rtk read --unknown README.md",
      "rtk read -l README.md",
      "rtk read -l detailed README.md",
      "rtk read --level= README.md",
      "rtk read -m README.md",
      "rtk read -m-1 README.md",
      "rtk read --max-lines=1.5 README.md",
      "rtk read --tail-lines nope README.md",
      "rtk read --max-lines 1 --tail-lines 1 README.md",
      "rtk read --",
      "rtk read -- -- README.md",
    ]);
  });

  it("enforces the strict RTK json grammar", () => {
    expectAllowed([
      "rtk json package.json",
      "rtk json 'file name.json'",
      "rtk json --keys-only package.json",
      "rtk json -d 0 package.json",
      "rtk json -d3 package.json",
      "rtk json --depth 12 package.json",
      "rtk json --depth=12 package.json",
      "rtk json -- -leading.json",
      "rtk json -h",
      "rtk json --help",
    ]);
    expectBlocked([
      "rtk json",
      "rtk json ''",
      "rtk json -- ''",
      "rtk json one.json two.json",
      "rtk json -h package.json",
      "rtk json --help package.json",
      "rtk json --unknown package.json",
      "rtk json -d package.json",
      "rtk json -d-1 package.json",
      "rtk json --depth= package.json",
      "rtk json --depth nope package.json",
      "rtk json --",
      "rtk json -- -- package.json",
    ]);
  });

  it("enforces the strict non-executing RTK env grammar", () => {
    expectAllowed([
      "rtk env",
      "rtk env -f HOME",
      "rtk env --filter HOME",
      "rtk env --filter=HOME",
      "rtk env -f 'TWO WORDS'",
    ]);
    expectBlocked([
      "rtk env -h",
      "rtk env --help",
      "rtk env --",
      "rtk env HOME",
      "rtk env -f",
      "rtk env -f ''",
      "rtk env --filter ''",
      "rtk env --filter=",
      "rtk env -fHOME",
      "rtk env -f HOME command",
      "rtk env --filter HOME command",
      "rtk env command arg",
    ]);
  });
});
