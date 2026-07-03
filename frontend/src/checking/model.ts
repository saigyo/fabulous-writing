import type { ProviderInfo } from '../types'

/**
 * Resolve which model to request: the user's choice if it still exists,
 * otherwise the provider's default (which the backend guarantees is
 * installed when any model is).
 */
export function effectiveModel(
  chosen: string | null,
  providerName: string,
  providers: ProviderInfo[],
): string | null {
  const info = providers.find((p) => p.name === providerName)
  if (!info) return chosen
  if (chosen && (info.models.length === 0 || info.models.includes(chosen))) {
    return chosen
  }
  return info.default_model
}
