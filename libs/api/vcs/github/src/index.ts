import type {
  VcsIdentityProvider,
  VcsInstallationProvider,
  VcsNamespaceAccessProvider,
  VcsWebhookProvider,
} from '@glint/api-vcs-core';
import type {GitHubGateway} from './gateway.js';
import {GithubVcsProvider} from './provider.js';
import {createGitHubRestGateway} from './rest-gateway.js';

export interface GithubVcsProviderConfig {
  readonly appId: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly privateKey: string;
  readonly webhookSecret: string;
  readonly baseUrl?: string;
  readonly requestTimeoutMs?: number;
  readonly fetch?: typeof globalThis.fetch;
}

export function createGithubVcsProvider(
  config: GithubVcsProviderConfig,
): VcsIdentityProvider & VcsNamespaceAccessProvider & VcsInstallationProvider & VcsWebhookProvider {
  const gateway: GitHubGateway = createGitHubRestGateway(config);
  return new GithubVcsProvider(gateway, {webhookSecret: config.webhookSecret});
}
