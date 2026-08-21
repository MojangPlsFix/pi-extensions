import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAgentsCommand } from "./agents-command.js";
import { SubagentManager } from "./manager.js";
import { completionMessageRenderer } from "./renderers.js";
import { registerSubagentTools } from "./tools.js";

export default function subagentsExtension(pi: ExtensionAPI): void {
  const manager = new SubagentManager(pi);
  pi.on("session_start", async (_event, ctx) => {
    await manager.attachUi(ctx);
  });
  pi.on("before_agent_start", async (event) => ({
    systemPrompt: manager.parentGuidance(event.systemPrompt),
  }));
  pi.on("tool_call", (event) => manager.guardParentTool(event.toolName, event.input));
  pi.on("session_shutdown", async () => {
    await manager.shutdown();
  });
  pi.registerMessageRenderer("subagent-completion-v2", (message, options, theme) =>
    completionMessageRenderer(message.details, options.expanded, theme, options.outputPad),
  );

  registerSubagentTools(pi, manager);
  registerAgentsCommand(pi, manager);
}

export type { AgentDiagnostic, AgentDiscoveryResult, DiscoveryOptions } from "./agents.js";
export {
  BUILTIN_PROFILES,
  discoverAgents,
  ejectBuiltinProfile,
  parseFrontmatter,
  parseFrontmatterOrThrow,
  profileAuthorityDiagnostics,
  serializeProfile,
} from "./agents.js";
export type {
  CapabilityApproval,
  CapabilityDefinition,
  CapabilityDiagnostic,
  CapabilityState,
  EffectiveCapabilityPolicy,
} from "./capabilities.js";
export {
  capabilityCeilingDiagnostics,
  matchesAnyExecutableArgvPrefix,
  matchesAnyToolPattern,
  matchesExecutableArgvPrefix,
  matchesToolPattern,
  resolveEffectiveCapabilities,
  selectEffectiveCapabilities,
  validateCapabilityCatalog,
  validateCapabilityDefinition,
} from "./capabilities.js";
export type { SubagentConfig } from "./config.js";
export {
  AGENT_DIR,
  CONFIG_PATH,
  DEFAULT_SUBAGENT_CONFIG,
  loadSubagentConfig,
  PI_AGENT_DIR,
  resolveAgentCapabilities,
  resolveAgentModelPolicy,
  SESSION_ROOT,
  SUBAGENT_ROOT,
  updateProfileControl,
} from "./config.js";
export type { DispatchInput, HubSnapshot, MissionSnapshot } from "./manager.js";
export { SubagentManager } from "./manager.js";
export type { DispatchTask } from "./orchestration.js";
export {
  ORCHESTRATION_GUIDELINES,
  TaskClaimRegistry,
  taskFingerprint,
  validateDispatchBatch,
} from "./orchestration.js";
export type { SupervisorRequest, SupervisorRequestInput } from "./supervisor.js";
export { SupervisorInbox } from "./supervisor.js";
export type {
  AgentDefinition,
  ProfileClass,
  RunnerKind,
  RunRecord,
  RunSnapshot,
  RunStatus,
} from "./types.js";
