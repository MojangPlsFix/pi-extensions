import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { registerAgentsCommand } from "./agents-command.js";
import { SubagentManager } from "./manager.js";
import {
  aggregateCompletionMessageRenderer,
  completionMessageRenderer,
  taskLabel,
} from "./renderers.js";
import { registerSubagentTools } from "./tools.js";

type WrapEntryV1 = {
  schemaVersion: 1;
  runId: string;
  cause: "wall" | "turn";
  at: string;
  deadlineAt: string;
};

export default function subagentsExtension(pi: ExtensionAPI): void {
  const manager = new SubagentManager(pi);
  pi.on("session_start", async (_event, ctx) => {
    await manager.attachUi(ctx);
  });
  pi.on("session_tree", (_event, ctx) => {
    manager.reconcileBranch(ctx);
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
  pi.registerMessageRenderer("subagent-completion-v3", (message, options, theme) =>
    aggregateCompletionMessageRenderer(message.details, options.expanded, theme, options.outputPad),
  );
  pi.registerEntryRenderer<WrapEntryV1>("subagent-wrap-v1", (entry, _options, theme) => {
    const data = entry.data;
    if (data?.schemaVersion !== 1) return new Text("", 0, 0);
    return new Text(
      theme.fg(
        "warning",
        `Hackler ${taskLabel(data.runId, 80)} is wrapping up at its ${data.cause} threshold · deadline ${taskLabel(data.deadlineAt, 40)}`,
      ),
      0,
      0,
    );
  });

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
export type {
  AvailableMetricV1,
  DurationAggregateV1,
  EvaluationActivityV1,
  EvaluationBenchmarkFixtureV1,
  EvaluationBenchmarkTaskV1,
  EvaluationCapacityPointV1,
  EvaluationLeaseV1,
  EvaluationMetricsV1,
  EvaluationRequestV1,
  EvaluationRunSourceV1,
  EvaluationRunV1,
  EvaluationStatusTransitionV1,
  EvaluationTraceInputV1,
  EvaluationTraceV1,
  EvaluationTransitionCauseV1,
  ResourceTotalsV1,
} from "./evaluation.js";
export { buildEvaluationTraceV1, evaluateTraceV1 } from "./evaluation.js";
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
