import {
  VcsAccessRevocationError,
  VcsMalformedResponseError,
  VcsMissingInstallationError,
  VcsProviderError,
  VcsRateLimitError,
  VcsTimeoutError,
} from '@glint/api-vcs-core';
import {RequestError} from '@octokit/request-error';

function header(headers: unknown, name: string): string | undefined {
  if (!headers || typeof headers !== 'object') return undefined;
  const value = Reflect.get(headers, name) ?? Reflect.get(headers, name.toLowerCase());
  return typeof value === 'string' ? value : undefined;
}

function retryAt(headers: unknown): Date | undefined {
  const reset = header(headers, 'x-ratelimit-reset');
  if (reset) {
    const seconds = Number(reset);
    if (Number.isFinite(seconds)) return new Date(seconds * 1_000);
  }
  const retryAfter = header(headers, 'retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return new Date(Date.now() + seconds * 1_000);
  }
  return undefined;
}

function isTimeout(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === 'AbortError' || error.name === 'TimeoutError') return true;
  const cause = error.cause;
  return cause instanceof Error && (cause.name === 'AbortError' || cause.name === 'TimeoutError');
}

/** Converts GitHub transport failures to the neutral, safe provider error set. */
export function mapRequestError(error: unknown): VcsProviderError {
  if (error instanceof VcsProviderError) return error;
  if (isTimeout(error)) return new VcsTimeoutError();
  if (error instanceof RequestError) {
    const {status, response} = error;
    if (status === 401) return new VcsAccessRevocationError();
    if (status === 404) return new VcsMissingInstallationError();
    const headers = response?.headers;
    if (
      status === 429 ||
      (status === 403 &&
        (header(headers, 'x-ratelimit-remaining') === '0' || header(headers, 'retry-after')))
    ) {
      return new VcsRateLimitError(retryAt(headers));
    }
    if (status === 403) return new VcsAccessRevocationError();
    return new VcsMalformedResponseError();
  }
  return new VcsMalformedResponseError();
}
