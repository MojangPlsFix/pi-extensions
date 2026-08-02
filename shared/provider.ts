type ModelLike = { provider?: unknown } | null | undefined;

/** Returns true only when a model explicitly identifies the requested provider. */
export function isProvider(model: ModelLike, provider: string): boolean {
  return typeof model?.provider === "string" && model.provider === provider;
}

export function isCopilotModel(model: ModelLike): boolean {
  return isProvider(model, "github-copilot");
}
