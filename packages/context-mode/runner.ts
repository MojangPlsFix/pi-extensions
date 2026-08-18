import { type ChildProcess, spawn } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";

export const CONTEXT_LANGUAGES = [
  "javascript",
  "typescript",
  "python",
  "shell",
  "ruby",
  "go",
  "rust",
  "php",
  "perl",
  "r",
  "elixir",
  "csharp",
] as const;
export type ContextLanguage = (typeof CONTEXT_LANGUAGES)[number];

export type ExecuteRequest = {
  language: ContextLanguage;
  code: string;
  timeout?: number;
  cwd?: string;
  intent?: string;
};

export type ExecuteFileRequest = ExecuteRequest & { path: string };

export type NativeRunResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  truncated: boolean;
};

export type NativeRunProgress = {
  elapsedMs: number;
  outputBytes: number;
};

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 15 * 60_000;
const MAX_CODE_BYTES = 1_000_000;
const MAX_OUTPUT_BYTES = 100_000;

/** Runtime variables that can inject code, replace compilers, or alter startup behavior. */
const UNSAFE_ENV_KEYS = new Set([
  "BASH_ENV",
  "ENV",
  "PROMPT_COMMAND",
  "PS4",
  "SHELLOPTS",
  "BASHOPTS",
  "CDPATH",
  "INPUTRC",
  "BASH_XTRACEFD",
  "NODE_OPTIONS",
  "NODE_PATH",
  "PYTHONSTARTUP",
  "PYTHONHOME",
  "PYTHONWARNINGS",
  "PYTHONBREAKPOINT",
  "PYTHONINSPECT",
  "RUBYOPT",
  "RUBYLIB",
  "PERL5OPT",
  "PERL5LIB",
  "PERLLIB",
  "PERL5DB",
  "ERL_AFLAGS",
  "ERL_FLAGS",
  "ELIXIR_ERL_OPTIONS",
  "ERL_LIBS",
  "GOFLAGS",
  "CGO_CFLAGS",
  "CGO_LDFLAGS",
  "RUSTC",
  "RUSTC_WRAPPER",
  "RUSTC_WORKSPACE_WRAPPER",
  "CARGO_BUILD_RUSTC",
  "CARGO_BUILD_RUSTC_WRAPPER",
  "RUSTFLAGS",
  "PHPRC",
  "PHP_INI_SCAN_DIR",
  "R_PROFILE",
  "R_PROFILE_USER",
  "DOTNET_STARTUP_HOOKS",
  "DOTNET_ADDITIONAL_DEPS",
  "DOTNET_SHARED_STORE",
  "DOTNET_ROOT",
  "DOTNET_HOST_PATH",
  "CORECLR_PROFILER",
  "CORECLR_PROFILER_PATH",
  "CORECLR_ENABLE_PROFILING",
  "LD_PRELOAD",
  "DYLD_INSERT_LIBRARIES",
  "OPENSSL_CONF",
  "OPENSSL_ENGINES",
  "CC",
  "CXX",
  "AR",
  "GIT_TEMPLATE_DIR",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_EXEC_PATH",
  "GIT_SSH",
  "GIT_SSH_COMMAND",
  "GIT_ASKPASS",
]);

/** Build a child environment without runtime startup/compiler injection variables. */
export function sanitizeExecutionEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
  tempDirectory?: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (
      value !== undefined &&
      !UNSAFE_ENV_KEYS.has(key) &&
      !key.startsWith("BASH_FUNC_") &&
      !/^COMPlus_/i.test(key)
    )
      env[key] = value;
  }
  const temporary = tempDirectory ?? tmpdir();
  env.TMPDIR = temporary;
  env.TMP = temporary;
  env.TEMP = temporary;
  env.PYTHONDONTWRITEBYTECODE = "1";
  env.PYTHONUNBUFFERED = "1";
  env.PYTHONUTF8 = "1";
  env.NO_COLOR = "1";
  if (process.platform === "win32" && !env.PATH && env.Path) {
    env.PATH = env.Path;
    delete env.Path;
  }
  return env;
}

export function shellScriptExtension(platform: NodeJS.Platform = process.platform): ".sh" | ".cmd" {
  return platform === "win32" ? ".cmd" : ".sh";
}

export function shellRuntime(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return platform === "win32" ? env.ComSpec || "cmd.exe" : env.SHELL || "/bin/sh";
}

export class ContextAbortError extends Error {
  override name = "AbortError";
  constructor() {
    super("Context Mode execution cancelled.");
  }
}

export function isContextLanguage(value: unknown): value is ContextLanguage {
  return typeof value === "string" && (CONTEXT_LANGUAGES as readonly string[]).includes(value);
}

export function boundedTimeout(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
    throw new Error("timeout must be a positive number of milliseconds.");
  return Math.min(Math.floor(value), MAX_TIMEOUT_MS);
}

function ensureInside(candidate: string, root: string, label: string): string {
  const absolute = isAbsolute(candidate) ? resolve(candidate) : resolve(root, candidate);
  const rest = relative(root, absolute);
  if (
    rest === ".." ||
    rest.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    isAbsolute(rest)
  )
    throw new Error(`${label} must stay inside the project directory.`);
  return absolute;
}

async function ensureDirectory(candidate: string, root: string): Promise<string> {
  const directory = await ensureContained(candidate, root, "cwd");
  const stats = await import("node:fs/promises").then(({ stat }) => stat(directory));
  if (!stats.isDirectory()) throw new Error("cwd must be a directory.");
  return directory;
}

async function ensureContained(candidate: string, root: string, label: string): Promise<string> {
  const absolute = ensureInside(candidate, root, label);
  const [realRoot, realCandidate] = await Promise.all([realpath(root), realpath(absolute)]);
  const rest = relative(realRoot, realCandidate);
  if (
    rest === ".." ||
    rest.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    isAbsolute(rest)
  )
    throw new Error(`${label} must stay inside the project directory.`);
  return realCandidate;
}

function scriptName(language: ContextLanguage): string {
  const extensions: Record<ContextLanguage, string> = {
    javascript: ".cjs",
    typescript: ".ts",
    python: ".py",
    shell: shellScriptExtension(),
    ruby: ".rb",
    go: ".go",
    rust: ".rs",
    php: ".php",
    perl: ".pl",
    r: ".r",
    elixir: ".exs",
    csharp: ".cs",
  };
  return `script${extensions[language]}`;
}

function filePrelude(language: ContextLanguage, contentPath: string): string {
  const escaped = JSON.stringify(contentPath);
  switch (language) {
    case "javascript":
      return `const { readFileSync: __cmReadFile } = require("node:fs");\nconst FILE_CONTENT_PATH = ${escaped};\nconst file_path = FILE_CONTENT_PATH;\nconst FILE_CONTENT = __cmReadFile(FILE_CONTENT_PATH, "utf8");\n`;
    case "typescript":
      return `import { readFileSync as __cmReadFile } from "node:fs";\nconst FILE_CONTENT_PATH = ${escaped};\nconst file_path = FILE_CONTENT_PATH;\nconst FILE_CONTENT = __cmReadFile(FILE_CONTENT_PATH, "utf8");\n`;
    case "python":
      return `FILE_CONTENT_PATH = ${escaped}\nfile_path = FILE_CONTENT_PATH\nwith open(FILE_CONTENT_PATH, "r", encoding="utf-8") as __cmFile:\n    FILE_CONTENT = __cmFile.read()\n`;
    case "ruby":
      return `FILE_CONTENT_PATH = ${escaped}\nfile_path = FILE_CONTENT_PATH\nFILE_CONTENT = File.read(FILE_CONTENT_PATH, encoding: "utf-8")\n`;
    case "php":
      return `<?php\n$FILE_CONTENT_PATH = ${escaped};\n$file_path = $FILE_CONTENT_PATH;\n$FILE_CONTENT = file_get_contents($FILE_CONTENT_PATH);\n`;
    case "perl":
      return `my $FILE_CONTENT_PATH = ${escaped};\nmy $file_path = $FILE_CONTENT_PATH;\nopen(my $fh, '<:encoding(UTF-8)', $FILE_CONTENT_PATH) or die "Cannot open: $!";\nmy $FILE_CONTENT = do { local $/; <$fh> };\nclose($fh);\n`;
    case "r":
      return `FILE_CONTENT_PATH <- ${escaped}\nfile_path <- FILE_CONTENT_PATH\nFILE_CONTENT <- readLines(FILE_CONTENT_PATH, warn=FALSE, encoding="UTF-8")\nFILE_CONTENT <- paste(FILE_CONTENT, collapse="\\n")\n`;
    case "elixir":
      return `file_content_path = ${escaped}\nfile_path = file_content_path\nfile_content = File.read!(file_content_path)\n`;
    case "go":
      return `package main\n\nimport "os"\n\nvar FILE_CONTENT_PATH = ${escaped}\nvar file_path = FILE_CONTENT_PATH\n\nfunc main() {\n\tb, _ := os.ReadFile(FILE_CONTENT_PATH)\n\tFILE_CONTENT := string(b)\n\t_ = FILE_CONTENT\n`;
    case "shell":
      return process.platform === "win32"
        ? `set "FILE_CONTENT_PATH=%CONTEXT_MODE_FILE_CONTENT%"\r\nset "file_path=%FILE_CONTENT_PATH%"\r\nrem Use FILE_CONTENT_PATH for multiline Windows input.\r\n`
        : `FILE_CONTENT_PATH="$CONTEXT_MODE_FILE_CONTENT"\nfile_path="$FILE_CONTENT_PATH"\nFILE_CONTENT="$(cat "$FILE_CONTENT_PATH")"\n`;
    case "rust":
      return `#![allow(unused_variables)]\nuse std::fs;\n\nfn main() {\n    let file_content_path = ${escaped};\n    let file_path = file_content_path;\n    let file_content = fs::read_to_string(file_content_path).unwrap();\n`;
    case "csharp":
      return `var FILE_CONTENT_PATH = ${escaped};\nvar file_path = FILE_CONTENT_PATH;\nvar FILE_CONTENT = System.IO.File.ReadAllText(FILE_CONTENT_PATH);\n`;
  }
}

function isNodeExecutable(path: string): boolean {
  return /^(?:node|node\.exe)$/u.test(
    path.replaceAll("\\", "/").split("/").at(-1)?.toLowerCase() ?? "",
  );
}

function usableExecutable(path: string): boolean {
  try {
    accessSync(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Resolve a real Node runtime and never recurse through a compiled Pi or Bun host. */
export function resolveNodeRuntime(
  execPath = process.execPath,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (isNodeExecutable(execPath) && usableExecutable(execPath)) return execPath;

  const configured = env.PI_CONTEXT_MODE_NODE?.trim();
  if (configured) {
    if (isAbsolute(configured))
      return isNodeExecutable(configured) && usableExecutable(configured) ? configured : null;
    if (configured !== "node" && configured !== "node.exe") return null;
  }

  const names = process.platform === "win32" ? ["node.exe", "node"] : ["node"];
  for (const directory of (env.PATH ?? env.Path ?? "").split(delimiter)) {
    if (!directory) continue;
    for (const name of names) {
      const candidate = join(directory, name);
      if (existsSync(candidate) && usableExecutable(candidate)) return candidate;
    }
  }
  return null;
}

function nodeRuntime(): string {
  const runtime = resolveNodeRuntime();
  if (!runtime)
    throw new Error(
      "Context Mode JavaScript/TypeScript execution requires a real Node runtime. Set PI_CONTEXT_MODE_NODE to the Node executable.",
    );
  return runtime;
}

function filePostlude(language: ContextLanguage): string {
  return language === "go" || language === "rust" ? "\n}\n" : "";
}

function prepareCode(language: ContextLanguage, code: string): string {
  if (language === "go" && !code.includes("package "))
    return `package main\n\nfunc main() {\n${code}\n}\n`;
  if (language === "php" && !code.trimStart().startsWith("<?")) return `<?php\n${code}`;
  return code;
}

function shellQuote(path: string): string {
  if (process.platform === "win32") return `"${path.replaceAll('"', '\\"')}"`;
  return `'${path.replaceAll("'", "'\\''")}'`;
}

function runtimeFor(
  language: ContextLanguage,
  scriptPath: string,
): { command: string; args: string[] } {
  switch (language) {
    case "shell":
      return { command: shellRuntime(), args: [] };
    case "javascript":
      return { command: nodeRuntime(), args: [scriptPath] };
    case "typescript":
      return { command: nodeRuntime(), args: ["--experimental-strip-types", scriptPath] };
    case "python":
      return { command: process.platform === "win32" ? "python" : "python3", args: [scriptPath] };
    case "ruby":
      return { command: "ruby", args: [scriptPath] };
    case "go":
      return { command: "go", args: ["run", scriptPath] };
    case "php":
      return { command: "php", args: [scriptPath] };
    case "perl":
      return { command: "perl", args: [scriptPath] };
    case "r":
      return { command: "Rscript", args: [scriptPath] };
    case "elixir":
      return { command: "elixir", args: [scriptPath] };
    case "csharp":
      return { command: "dotnet-script", args: [scriptPath] };
  }
  throw new Error(`Unsupported Context Mode language: ${language}`);
}

function abortError(): ContextAbortError {
  return new ContextAbortError();
}

function boundedUtf8(buffer: Buffer, maxBytes: number): string {
  const text = buffer.toString("utf8");
  if (Buffer.byteLength(text) <= maxBytes) return text;
  const characters: string[] = [];
  let bytes = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character);
    if (bytes + size > maxBytes) break;
    characters.push(character);
    bytes += size;
  }
  return characters.join("");
}

/** A small, Pi-owned process runner. The Context Mode engine is not copied into this package. */
export class NativeContextRunner {
  private readonly active = new Set<ChildProcess>();

  async execute(
    request: ExecuteRequest,
    signal?: AbortSignal,
    projectRoot = process.cwd(),
    onProgress?: (progress: NativeRunProgress) => void,
  ): Promise<NativeRunResult> {
    boundedTimeout(request.timeout);
    if (Buffer.byteLength(request.code, "utf8") > MAX_CODE_BYTES)
      throw new Error(`code exceeds the ${MAX_CODE_BYTES}-byte limit.`);
    const safeRoot = await realpath(projectRoot);
    const cwd = request.cwd ? await ensureDirectory(request.cwd, safeRoot) : safeRoot;
    return this.run(request.language, request.code, cwd, request.timeout, signal, onProgress);
  }

  async executeFile(
    request: ExecuteFileRequest,
    signal?: AbortSignal,
    projectRoot = process.cwd(),
    onProgress?: (progress: NativeRunProgress) => void,
  ): Promise<NativeRunResult> {
    boundedTimeout(request.timeout);
    if (Buffer.byteLength(request.code, "utf8") > MAX_CODE_BYTES)
      throw new Error(`code exceeds the ${MAX_CODE_BYTES}-byte limit.`);
    const safeRoot = await realpath(projectRoot);
    const filePath = await ensureContained(request.path, safeRoot, "path");
    const cwd = request.cwd ? await ensureDirectory(request.cwd, safeRoot) : safeRoot;
    const directory = await mkdtemp(join(tmpdir(), "pi-context-mode-"));
    const scriptPath = join(directory, scriptName(request.language));
    try {
      await writeFile(
        scriptPath,
        `${filePrelude(request.language, filePath)}${request.code}${filePostlude(request.language)}`,
        "utf8",
      );
      return await this.runScript(
        request.language,
        scriptPath,
        cwd,
        request.timeout,
        signal,
        filePath,
        onProgress,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  cleanup(): void {
    for (const child of [...this.active]) killProcessTree(child);
    this.active.clear();
  }

  private async run(
    language: ContextLanguage,
    code: string,
    cwd: string,
    timeout: number | undefined,
    signal: AbortSignal | undefined,
    onProgress?: (progress: NativeRunProgress) => void,
  ): Promise<NativeRunResult> {
    const directory = await mkdtemp(join(tmpdir(), "pi-context-mode-"));
    const scriptPath = join(directory, scriptName(language));
    try {
      await writeFile(scriptPath, prepareCode(language, code), "utf8");
      return await this.runScript(
        language,
        scriptPath,
        cwd,
        timeout,
        signal,
        undefined,
        onProgress,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  private runScript(
    language: ContextLanguage,
    scriptPath: string,
    cwd: string,
    timeout: number | undefined,
    signal: AbortSignal | undefined,
    contentPath?: string,
    onProgress?: (progress: NativeRunProgress) => void,
  ): Promise<NativeRunResult> {
    return new Promise((resolveResult, reject) => {
      if (signal?.aborted) {
        reject(abortError());
        return;
      }
      if (language === "rust") {
        const binaryPath = `${scriptPath}.bin${process.platform === "win32" ? ".exe" : ""}`;
        const command = `rustc ${shellQuote(scriptPath)} -o ${shellQuote(binaryPath)} && ${shellQuote(binaryPath)}`;
        void this.run("shell", command, cwd, timeout, signal, onProgress).then(
          resolveResult,
          reject,
        );
        return;
      }
      const runtime = runtimeFor(language, scriptPath);
      const isShell = language === "shell";
      const command = isShell ? shellRuntime() : runtime.command;
      const args = isShell
        ? process.platform === "win32"
          ? ["/d", "/s", "/c", scriptPath]
          : [scriptPath]
        : runtime.args;
      const child = spawn(command, args, {
        cwd,
        detached: process.platform !== "win32",
        shell: false,
        windowsHide: true,
        env: {
          ...sanitizeExecutionEnv(process.env, dirname(scriptPath)),
          ...(contentPath ? { CONTEXT_MODE_FILE_CONTENT: contentPath } : {}),
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      this.active.add(child);
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let bytes = 0;
      let truncated = false;
      let timedOut = false;
      let abortRequested = false;
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      let progressTimer: ReturnType<typeof setInterval> | undefined;
      const startedAt = Date.now();
      let lastProgressAt = 0;
      const emitProgress = (force = false): void => {
        const now = Date.now();
        if (!force && now - lastProgressAt < 200) return;
        lastProgressAt = now;
        onProgress?.({ elapsedMs: now - startedAt, outputBytes: bytes });
      };

      const finish = (result: NativeRunResult): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        if (progressTimer) clearInterval(progressTimer);
        emitProgress(true);
        signal?.removeEventListener("abort", onAbort);
        this.active.delete(child);
        resolveResult(result);
      };
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        if (progressTimer) clearInterval(progressTimer);
        emitProgress(true);
        signal?.removeEventListener("abort", onAbort);
        this.active.delete(child);
        reject(error);
      };
      const stop = (): void => {
        if (process.platform === "win32") {
          child.kill();
          const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
            windowsHide: true,
            stdio: "ignore",
          });
          killer.on("error", () => undefined);
        } else if (child.pid) {
          try {
            process.kill(-child.pid, "SIGTERM");
          } catch {
            child.kill("SIGTERM");
          }
          killTimer = setTimeout(() => {
            try {
              if (child.pid) process.kill(-child.pid, "SIGKILL");
            } catch {
              child.kill("SIGKILL");
            }
          }, 100);
        } else child.kill("SIGTERM");
      };
      const onAbort = (): void => {
        abortRequested = true;
        stop();
      };
      const collect = (chunk: Buffer, target: "stdout" | "stderr"): void => {
        if (truncated) return;
        const remaining = Math.max(0, MAX_OUTPUT_BYTES - bytes);
        const accepted = chunk.subarray(0, remaining);
        if (accepted.byteLength > 0) {
          if (target === "stdout") stdoutChunks.push(accepted);
          else stderrChunks.push(accepted);
          bytes += accepted.byteLength;
        }
        emitProgress();
        if (accepted.byteLength < chunk.byteLength) {
          truncated = true;
          stop();
        }
      };
      child.stdout?.on("data", (chunk: Buffer) => collect(chunk, "stdout"));
      child.stderr?.on("data", (chunk: Buffer) => collect(chunk, "stderr"));
      child.stdout?.on("error", () => undefined);
      child.stderr?.on("error", () => undefined);
      child.on("error", (error) => fail(error));
      child.on("close", (exitCode, exitSignal) => {
        if (abortRequested) {
          fail(abortError());
          return;
        }
        const stdout = boundedUtf8(Buffer.concat(stdoutChunks), MAX_OUTPUT_BYTES);
        const remaining = Math.max(0, MAX_OUTPUT_BYTES - Buffer.byteLength(stdout));
        const stderr = boundedUtf8(Buffer.concat(stderrChunks), remaining);
        finish({
          stdout,
          stderr,
          exitCode,
          signal: exitSignal,
          timedOut,
          truncated,
        });
      });
      emitProgress(true);
      progressTimer = setInterval(() => emitProgress(true), 500);
      progressTimer.unref?.();
      const effectiveTimeout = boundedTimeout(timeout) ?? DEFAULT_TIMEOUT_MS;
      timer = setTimeout(() => {
        timedOut = true;
        stop();
      }, effectiveTimeout);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}

function killProcessTree(child: ChildProcess): void {
  if (process.platform === "win32") {
    child.kill();
    if (child.pid) {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
        windowsHide: true,
        stdio: "ignore",
      });
      killer.on("error", () => undefined);
    }
    return;
  }
  if (child.pid) {
    try {
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch {
      // Fall through when a platform does not support process groups.
    }
  }
  child.kill("SIGKILL");
}

export function formatRunFailure(result: NativeRunResult): string {
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  if (result.timedOut) return `Execution timed out; partial output:\n${output}`.trim();
  if (result.truncated) return `${output}\n[output truncated at ${MAX_OUTPUT_BYTES} bytes]`.trim();
  return `Execution failed (exit ${result.exitCode ?? result.signal ?? "unknown"})${output ? `:\n${output}` : "."}`;
}

export const nativeRunnerLimits = {
  maxCodeBytes: MAX_CODE_BYTES,
  maxOutputBytes: MAX_OUTPUT_BYTES,
  maxTimeoutMs: MAX_TIMEOUT_MS,
};
