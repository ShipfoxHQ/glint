import {VcsProviderError, type VcsProviderErrorCode} from './types.js';

/**
 * Keeps consumers from coupling error handling to a concrete provider adapter while still
 * preserving the provider-neutral failure taxonomy.
 */
export function classifyVcsProviderError(error: unknown): VcsProviderErrorCode | 'unknown' {
  return error instanceof VcsProviderError ? error.code : 'unknown';
}
