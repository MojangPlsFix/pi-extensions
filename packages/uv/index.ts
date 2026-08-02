import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createBashTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const packageDirectory = dirname(fileURLToPath(import.meta.url));
const shimsDirectory = join(packageDirectory, "shims");
const segmentStart = String.raw`(?:^|\n|[;|&]{1,2})\s*`;
const executablePath = String.raw`(?:(?:"[^"\r\n;|&]*[\\/])|(?:'[^'\r\n;|&]*[\\/])|(?:[^\s;|&]*[\\/]))?`;
const pythonExecutable = String.raw`(?:python(?:3(?:\.\d+)?)?|py)(?:\.exe)?\b`;
const commandPattern = (name: string): RegExp =>
  new RegExp(`${segmentStart}${executablePath}${name}(?:.exe)?(?=s|$|["'])`, "m");
const modulePattern = (name: string): RegExp =>
  new RegExp(
    `${segmentStart}${executablePath}${pythonExecutable}[^\n;|&]*(?:s-ms*${name}\b|s-m${name}\b)`,
    "m",
  );
const pip = commandPattern("pip");
const pip3 = commandPattern("pip3");
const poetry = commandPattern("poetry");
const pythonPip = modulePattern("pip");
const pythonVenv = modulePattern("venv");
const pythonCompile = modulePattern("py_compile");

function hasPythonModule(command: string, module: string): boolean {
  const executable = String.raw`(?:[^\s;|&]*[\\/])?(?:python(?:3(?:\.\d+)?)?|py)(?:\.exe)?`;
  return new RegExp(String.raw`(?:^|[\s;|&])${executable}\s+-m\s*${module}\b`, "i").test(command);
}

export function getBlockedCommandMessage(command: string): string | undefined {
  if (
    pip.test(command) ||
    pip3.test(command) ||
    pythonPip.test(command) ||
    hasPythonModule(command, "pip")
  )
    return "pip is disabled. Use uv run --with PACKAGE python script.py for scripts, or uv add PACKAGE for projects.";
  if (poetry.test(command))
    return "poetry is disabled. Use uv init, uv add, uv sync, and uv run instead.";
  if (pythonVenv.test(command) || hasPythonModule(command, "venv"))
    return "python -m venv is disabled. Use uv venv instead.";
  if (pythonCompile.test(command) || hasPythonModule(command, "py_compile"))
    return "python -m py_compile is disabled because it writes bytecode. Use uv run python -m ast path/to/file.py for syntax checks.";
  return undefined;
}

export function toBashPath(path: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== "win32") return path;
  const normalized = path.replaceAll("\\", "/");
  const drive = /^([A-Za-z]):\/(.*)$/.exec(normalized);
  return drive ? `/${drive[1]?.toLowerCase()}/${drive[2]}` : normalized;
}

export function commandPrefix(path: string, platform: NodeJS.Platform = process.platform): string {
  return `export PATH="${toBashPath(path, platform).replace(/["\\$`]/g, "\\$&")}:$PATH"`;
}

export default function uvExtension(pi: ExtensionAPI): void {
  const bash = createBashTool(process.cwd(), {
    commandPrefix: commandPrefix(shimsDirectory),
    spawnHook: (context) => {
      const message = getBlockedCommandMessage(context.command);
      if (message) throw new Error(message);
      return context;
    },
  });
  // Deliberately replaces Pi's built-in Bash tool only inside this extension runtime.
  pi.registerTool(bash);
}
