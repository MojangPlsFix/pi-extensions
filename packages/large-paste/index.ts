import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const largePasteThreshold = 20_000;
const maximumAgeMs = 3 * 24 * 60 * 60 * 1_000;
const maximumFiles = 160;
const prefix = "pi-extensions-paste-";

export function cacheDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(
    env.PI_EXTENSIONS_LARGE_PASTE_CACHE_DIR?.trim() ||
      join(tmpdir(), "pi-extensions", "large-pastes"),
  );
}

export function pasteFileName(now = new Date(), id: string = randomUUID()): string {
  return `${prefix}${now.toISOString().replace(/[.:]/g, "-")}-${id}.txt`;
}

export async function pruneCache(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  const cutoff = Date.now() - maximumAgeMs;
  const files: Array<{ path: string; modified: number }> = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.startsWith(prefix) || !entry.name.endsWith(".txt")) continue;
    const path = join(directory, entry.name);
    try {
      const info = await stat(path);
      if (info.mtimeMs < cutoff) await rm(path, { force: true });
      else files.push({ path, modified: info.mtimeMs });
    } catch {
      /* another process may have removed it */
    }
  }
  files.sort((left, right) => right.modified - left.modified);
  await Promise.all(files.slice(maximumFiles).map((file) => rm(file.path, { force: true })));
}

export default function largePasteExtension(pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => {
    try {
      await pruneCache(cacheDirectory());
    } catch (error) {
      ctx.ui.notify(
        `Could not prune large-paste cache: ${error instanceof Error ? error.message : String(error)}`,
        "warning",
      );
    }
  });
  pi.on("input", async (event, ctx) => {
    if (event.source === "extension" || event.text.length < largePasteThreshold)
      return { action: "continue" };
    const directory = cacheDirectory();
    const path = join(directory, pasteFileName());
    try {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, event.text, { encoding: "utf8", mode: 0o600 });
    } catch (error) {
      ctx.ui.notify(
        `Large paste was not sent because it could not be saved: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
      return { action: "handled" };
    }
    try {
      await pruneCache(directory);
    } catch (error) {
      ctx.ui.notify(
        `Large-paste cache cleanup failed; the saved paste remains available: ${error instanceof Error ? error.message : String(error)}`,
        "warning",
      );
    }
    ctx.ui.notify(
      `Large paste saved to ${path} (${event.text.length.toLocaleString()} characters)`,
      "info",
    );
    return {
      action: "transform",
      text: `The pasted content was too large to include inline.\nIt was saved to: ${path}\n\nRead that file when needed.`,
      images: event.images,
    };
  });
}
