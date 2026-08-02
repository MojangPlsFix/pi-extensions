import type { SubagentBackend } from "./backend.js";
import { RpcClient, type RpcEvent } from "./rpc-client.js";
import type { ManagedAgent } from "./types.js";

/** Persistent Pi RPC transport. The manager owns policy and state transitions. */
export class RpcBackend implements SubagentBackend {
  private readonly clients = new Map<string, RpcClient>();

  constructor(
    private readonly onEvent: (agent: ManagedAgent, event: RpcEvent) => void,
    private readonly onClose: (
      agent: ManagedAgent,
      code: number | null,
      signal: NodeJS.Signals | null,
    ) => void,
  ) {}

  spawn(agent: ManagedAgent, task: string): void {
    if (!agent.process) throw new Error("RPC backend requires a child process.");
    const client = new RpcClient(agent.process, (event) => this.onEvent(agent, event));
    this.clients.set(agent.id, client);
    agent.process.on("close", (code, signal) => {
      this.clients.delete(agent.id);
      this.onClose(agent, code, signal);
    });
    agent.process.on("error", (error) =>
      this.onEvent(agent, { type: "error", error: { message: error.message } }),
    );
    agent.process.stderr.on("data", (chunk) => {
      agent.stderr += chunk.toString("utf8");
    });
    client.prompt("initial", task);
  }

  send(agent: ManagedAgent, message: string): void {
    const client = this.clients.get(agent.id);
    if (!client)
      throw new Error(
        `Cannot send to subagent ${agent.id}: its RPC child is closed. Start a new subagent instead.`,
      );
    client.prompt(`followup-${Date.now()}`, message, "followUp");
  }
  interrupt(agent: ManagedAgent): void {
    const client = this.clients.get(agent.id);
    if (!client && !agent.process)
      throw new Error(`Cannot interrupt subagent ${agent.id}: its RPC child is closed.`);
    client?.abort();
    agent.process?.kill("SIGTERM");
  }
  redirect(agent: ManagedAgent, _message: string): void {
    const client = this.clients.get(agent.id);
    if (!client)
      throw new Error(
        `Cannot redirect subagent ${agent.id}: its RPC child is closed. Start a new subagent instead.`,
      );
    client.abort();
  }
  shutdown(agent: ManagedAgent): void {
    this.interrupt(agent);
  }
}
