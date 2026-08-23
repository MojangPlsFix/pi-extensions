import { closeSync, openSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

try {
  closeSync(2);
  const nullDescriptor = openSync(process.platform === "win32" ? "NUL" : "/dev/null", "w");
  if (nullDescriptor !== 2) closeSync(nullDescriptor);
} catch {
  // The JS-level guard below remains active if the native descriptor cannot be replaced.
}
process.stderr.write = () => true;
process.env.NODE_NO_WARNINGS = "1";
process.on("uncaughtException", () => process.exit(1));
process.on("unhandledRejection", () => process.exit(1));

if (process.argv.some((value) => value.startsWith("--pi-sdk-launcher-stderr-test="))) {
  process.stderr.write("suppressed launcher test marker");
  process.exit(0);
}

function bundledRuntimePath() {
  const arch = process.arch;
  const variants = process.platform === "linux" ? ["linux", "linuxmusl"] : [process.platform];
  for (const variant of variants) {
    try {
      const sdkUrl = import.meta.resolve(`@github/copilot-${variant}-${arch}/sdk`);
      return join(dirname(dirname(fileURLToPath(sdkUrl))), "index.js");
    } catch {
      // Try the next platform package candidate.
    }
  }
  throw new Error("The SDK-bundled Copilot runtime is unavailable for this platform.");
}

await import(pathToFileURL(bundledRuntimePath()).href);
