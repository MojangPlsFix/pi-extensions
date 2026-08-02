import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAgentsCommand } from "./agents-command.js";
import { SubagentManager } from "./manager.js";
import { completionMessageRenderer } from "./renderers.js";
import { registerSubagentTools } from "./tools.js";

export default function subagentsExtension(pi: ExtensionAPI): void {
  const manager = new SubagentManager(pi);
  pi.on("session_start", (_event, ctx) => {
    manager.attachUi(ctx);
  });
  pi.on("session_shutdown", async () => {
    await manager.shutdown();
  });
  pi.registerMessageRenderer("subagent-completion", (message, options, theme) =>
    completionMessageRenderer(message.details, options.expanded, theme, options.outputPad),
  );

  registerSubagentTools(pi, manager);
  registerAgentsCommand(pi, manager);
}

export { discoverAgents, parseFrontmatter } from "./agents.js";
export {
  AGENT_DIR,
  CONFIG_PATH,
  CONTEXT_TOOLS,
  EXPLORER_TOOLS,
  LEGACY_SESSION_ROOT,
  MAX_ACTIVE,
  MAX_WORKERS,
  SESSION_ROOT,
  WORKER_TOOLS,
} from "./config.js";
