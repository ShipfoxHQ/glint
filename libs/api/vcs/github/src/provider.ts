import type {
  VcsAuthorizationResult,
  VcsIdentity,
  VcsIdentityProvider,
  VcsInstallation,
  VcsInstallationProvider,
  VcsNamespace,
  VcsNamespaceAccess,
  VcsNamespaceAccessProvider,
  VcsProviderHealth,
  VcsRepository,
  VcsUserCredential,
  VcsWebhookProvider,
} from '@glint/api-vcs-core';
import {VcsAccessRevocationError} from '@glint/api-vcs-core';
import type {
  GitHubAccount,
  GitHubGateway,
  GitHubInstallation,
  GitHubNamespaceAccess,
  GitHubRepository,
  GitHubUser,
} from './gateway.js';
import {verifyAndMapWebhook} from './webhook.js';

export interface GithubVcsProviderOptions {
  readonly webhookSecret: string;
  readonly now?: () => Date;
}

function identity(user: GitHubUser): VcsIdentity {
  return {
    id: String(user.id),
    provider: 'github',
    login: user.login,
    ...(user.name ? {displayName: user.name} : {}),
    ...(user.avatar_url ? {avatarUrl: user.avatar_url} : {}),
  };
}

function namespace(account: GitHubAccount): VcsNamespace {
  return {
    id: String(account.id),
    provider: 'github',
    kind: account.type === 'Organization' ? 'organization' : 'user',
    state: account.suspended_at ? 'suspended' : 'active',
    login: account.login,
    ...(account.name ? {displayName: account.name} : {}),
  };
}

function installation(nativeInstallation: GitHubInstallation): VcsInstallation {
  return {
    id: String(nativeInstallation.id),
    provider: 'github',
    namespaceId: String(nativeInstallation.account.id),
    state: nativeInstallation.suspended_at ? 'suspended' : 'active',
    repositorySelection: nativeInstallation.repository_selection,
  };
}

function repository(nativeRepository: GitHubRepository, installationId: string): VcsRepository {
  return {
    id: String(nativeRepository.id),
    provider: 'github',
    namespaceId: String(nativeRepository.owner.id),
    installationId,
    state: nativeRepository.removed ? 'removed' : 'active',
    owner: nativeRepository.owner.login,
    name: nativeRepository.name,
    defaultBranch: nativeRepository.default_branch ?? 'HEAD',
    visibility: nativeRepository.private ? 'private' : 'public',
  };
}

/**
 * The concrete E1 adapter. GitHub data and secrets end at this boundary; only
 * provider-neutral values are returned to feature packages.
 */
export class GithubVcsProvider
  implements
    VcsIdentityProvider,
    VcsNamespaceAccessProvider,
    VcsInstallationProvider,
    VcsWebhookProvider
{
  readonly provider = 'github';
  readonly #credentials = new WeakMap<VcsUserCredential, string>();
  readonly #now: () => Date;

  constructor(
    private readonly gateway: GitHubGateway,
    private readonly options: GithubVcsProviderOptions,
  ) {
    this.#now = options.now ?? (() => new Date());
  }

  async exchangeAuthorization(input: {
    readonly authorizationCode: string;
    readonly codeVerifier: string;
    readonly redirectUri?: string;
  }): Promise<VcsAuthorizationResult> {
    const authorization = await this.gateway.exchangeAuthorization(input);
    const credential = {} as VcsUserCredential;
    this.#credentials.set(credential, authorization.userToken);
    return {identity: identity(authorization.user), credential};
  }

  async getIdentity(credential: VcsUserCredential): Promise<VcsIdentity> {
    return identity(await this.gateway.getAuthenticatedUser(this.#token(credential)));
  }

  async listAuthorizedInstallations(
    credential: VcsUserCredential,
  ): Promise<readonly VcsInstallation[]> {
    const installations = await this.gateway.listUserInstallations(this.#token(credential));
    return installations
      .filter((candidate) => !candidate.suspended_at)
      .map((candidate) => installation(candidate));
  }

  async getNamespace(namespaceId: string): Promise<VcsNamespace | undefined> {
    const account = await this.gateway.getNamespaceAccount(namespaceId);
    return account ? namespace(account) : undefined;
  }

  async getNamespaceAccess(input: {
    readonly namespaceId: string;
    readonly identityId: string;
  }): Promise<VcsNamespaceAccess> {
    const access = await this.gateway.getNamespaceAccess(input.namespaceId, input.identityId);
    const level = this.#accessLevel(input, access);
    return {
      namespaceId: input.namespaceId,
      identityId: input.identityId,
      level,
    };
  }

  async getInstallation(installationId: string): Promise<VcsInstallation> {
    return installation(await this.gateway.getInstallation(installationId));
  }

  async listRepositories(installationId: string): Promise<readonly VcsRepository[]> {
    const repositories = await this.gateway.listInstallationRepositories(installationId);
    return repositories.map((candidate) => repository(candidate, installationId));
  }

  async health(): Promise<VcsProviderHealth> {
    const health = await this.gateway.health();
    return {
      provider: this.provider,
      status: health.status,
      checkedAt: this.#now(),
      ...(health.detail ? {detail: health.detail} : {}),
    };
  }

  async verifyAndMapWebhook(input: {
    readonly headers: Readonly<Record<string, string>>;
    readonly body: Uint8Array;
  }) {
    return await verifyAndMapWebhook({...input, webhookSecret: this.options.webhookSecret});
  }

  #token(credential: VcsUserCredential): string {
    const token = this.#credentials.get(credential);
    if (!token) throw new VcsAccessRevocationError();
    return token;
  }

  #accessLevel(
    input: {readonly namespaceId: string; readonly identityId: string},
    access: GitHubNamespaceAccess,
  ): 'owner' | 'member' | 'none' {
    if (!access.account || access.account.suspended_at || access.installation?.suspended_at) {
      return 'none';
    }
    if (access.account.type === 'User') {
      return input.namespaceId === input.identityId && access.installation ? 'owner' : 'none';
    }
    if (!access.installation || access.membership?.state !== 'active') return 'none';
    return access.membership.role === 'admin'
      ? 'owner'
      : access.membership.role === 'member'
        ? 'member'
        : 'none';
  }
}
