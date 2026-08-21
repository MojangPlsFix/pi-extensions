import { describe, expect, it } from "vitest";
import { lexShellCommand } from "../shell-lexer.js";

function argv(command: string): string[] {
  const result = lexShellCommand(command);
  expect(result, command).toMatchObject({ ok: true });
  if (!result.ok) throw new Error(result.rejection.message);
  return result.argv;
}

function rejection(command: string): string {
  const result = lexShellCommand(command);
  expect(result, command).toMatchObject({ ok: false });
  if (result.ok) throw new Error(`Unexpected successful parse: ${command}`);
  return result.rejection.code;
}

describe("Plan Mode literal shell lexer", () => {
  it("allows the reported regex pipes as literal quoted text", () => {
    expect(
      argv(
        "rg -n -i -S 'working indicator|working status|session summary' README.md docs packages",
      ),
    ).toEqual([
      "rg",
      "-n",
      "-i",
      "-S",
      "working indicator|working status|session summary",
      "README.md",
      "docs",
      "packages",
    ]);
  });

  it("decodes quoted and escaped operators without losing argument boundaries", () => {
    expect(argv("rg 'a|b;c&d<e>f' \"(group)\" a\\|b c\\;d e\\&f g\\<h i\\>j")).toEqual([
      "rg",
      "a|b;c&d<e>f",
      "(group)",
      "a|b",
      "c;d",
      "e&f",
      "g<h",
      "i>j",
    ]);
  });

  it("preserves quotes, concatenation, empty arguments, and quoted substitution text", () => {
    const substitutionText = "$HOME $" + "{x} $(cmd) `cmd` $((1))";
    expect(argv(`r'g' '' a" b"c '${substitutionText}' "\\$HOME"`)).toEqual([
      "rg",
      "",
      "a bc",
      substitutionText,
      "$HOME",
    ]);
  });

  it("uses Bash-compatible backslash behavior inside double quotes", () => {
    expect(argv('rg "a\\q \\" \\\\ \\$ \\`"')).toEqual(["rg", 'a\\q " \\ $ `']);
  });

  it("allows escaped glob, brace, redirect, separator, and leading-tilde text", () => {
    expect(argv(String.raw`rg \* \? \[x\] \{a,b\} \> \; \~`)).toEqual([
      "rg",
      "*",
      "?",
      "[x]",
      "{a,b}",
      ">",
      ";",
      "~",
    ]);
  });

  it.each([
    "cat a | cat",
    "git status && git log",
    "git status || git log",
    "cat a; cat b",
    "cat a > b",
    "cat < a",
    "(cat a)",
    "cat a &",
  ])("rejects active composition: %s", (command) => {
    expect(rejection(command)).toBe("operator");
  });

  it.each([
    "printenv $HOME",
    "printenv $" + "{HOME}",
    "cat $(pwd)",
    "cat `pwd`",
    "cat $((1 + 1))",
    "cat <(pwd)",
    "cat >(wc)",
    'echo "$HOME"',
    'echo "`pwd`"',
  ])("rejects active expansion: %s", (command) => {
    expect(["expansion", "operator"]).toContain(rejection(command));
  });

  it.each([
    "rg *.ts",
    "rg file?.ts",
    "rg [ab].ts",
    "rg {a,b}.ts",
    "ls ~",
    "ls ~/src",
    "rg HOME=~",
    "rg PATH=bin:~",
    "rg PATH+=~",
    "rg PATH+=bin:~",
  ])("rejects active pathname, brace, or tilde expansion: %s", (command) => {
    expect(["glob", "brace-expansion", "tilde-expansion"]).toContain(rejection(command));
  });

  it.each([
    "rg pattern # comment",
    "rg pattern\nREADME.md",
    "rg pattern\rREADME.md",
    "rg 'unterminated",
    'rg "unterminated',
    "rg trailing\\",
    "rg $'ansi'",
    'rg $"locale"',
    "rg \\\ncontinued",
  ])("rejects malformed or active shell syntax: %s", (command) => {
    expect(rejection(command)).toBeTruthy();
  });

  it("keeps inactive hash and tilde text inside ordinary words", () => {
    expect(argv("rg foo#bar foo~bar '# still data'")).toEqual([
      "rg",
      "foo#bar",
      "foo~bar",
      "# still data",
    ]);
  });

  it("decodes options assembled through adjacent quotes or escapes", () => {
    expect(argv("s'o'rt -'o'FILE rg --sear\\ch-zip")).toEqual([
      "sort",
      "-oFILE",
      "rg",
      "--search-zip",
    ]);
  });
});
