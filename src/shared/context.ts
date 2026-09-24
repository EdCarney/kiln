/**
 * The context window a request actually gets. Cloud models run at their full length; local ones run at
 * Ollama's num_ctx, which Kiln caps at the user's setting. History trimming, meters and num_ctx must all
 * use this one number, or Kiln budgets for a window Ollama never opens.
 */
export function effectiveContext(model: { location: 'cloud' | 'local'; contextLength: number | null }, localNumCtx: number): number | null {
  if (model.location === 'cloud') return model.contextLength
  return Math.min(model.contextLength ?? localNumCtx, localNumCtx)
}
