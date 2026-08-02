import type { ManagedAgent } from "./types.js";

export interface SubagentBackend {
  spawn(agent: ManagedAgent, task: string): Promise<void> | void;
  send(agent: ManagedAgent, message: string): Promise<void> | void;
  interrupt(agent: ManagedAgent): Promise<void> | void;
  redirect?(agent: ManagedAgent, message: string): Promise<void> | void;
  /** Resume passive completion observation without submitting another prompt. */
  observe?(agent: ManagedAgent): Promise<void> | void;
  shutdown?(agent: ManagedAgent): Promise<void> | void;
}
