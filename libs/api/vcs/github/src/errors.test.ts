import {
  VcsAccessRevocationError,
  VcsMalformedResponseError,
  VcsMissingInstallationError,
  VcsRateLimitError,
  VcsTimeoutError,
} from '@glint/api-vcs-core';
import {RequestError} from '@octokit/request-error';
import {describe, expect, it} from '@shipfox/vitest/vi';
import {mapRequestError} from './errors.js';

function requestError(status: number, headers: Record<string, string> = {}) {
  return new RequestError('GitHub request failed', status, {
    request: {method: 'GET', url: 'https://api.github.invalid/test', headers: {}},
    response: {url: 'https://api.github.invalid/test', status, headers, data: {}},
  });
}

describe('mapRequestError', () => {
  it('maps revoked OAuth and missing installation responses without native details', () => {
    expect(mapRequestError(requestError(401))).toBeInstanceOf(VcsAccessRevocationError);
    expect(mapRequestError(requestError(404))).toBeInstanceOf(VcsMissingInstallationError);
  });

  it('maps rate limits with the provider reset timestamp', () => {
    const error = mapRequestError(
      requestError(403, {'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1'}),
    );
    expect(error).toBeInstanceOf(VcsRateLimitError);
    expect((error as VcsRateLimitError).retryAt).toEqual(new Date(1_000));
  });

  it('maps aborts and unexpected response shapes to safe typed errors', () => {
    expect(
      mapRequestError(Object.assign(new Error('aborted'), {name: 'AbortError'})),
    ).toBeInstanceOf(VcsTimeoutError);
    expect(mapRequestError(requestError(500))).toBeInstanceOf(VcsMalformedResponseError);
    expect(mapRequestError(new Error('unexpected'))).toBeInstanceOf(VcsMalformedResponseError);
  });

  it('preserves an Octokit timeout wrapped as an HTTP failure', () => {
    const timeout = Object.assign(new Error('request timed out'), {name: 'TimeoutError'});
    const error = new RequestError('GitHub request failed', 500, {
      cause: timeout,
      request: {method: 'GET', url: 'https://api.github.invalid/test', headers: {}},
    });
    expect(mapRequestError(error)).toBeInstanceOf(VcsTimeoutError);
  });
});
