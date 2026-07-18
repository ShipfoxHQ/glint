export type VcsNamespaceKind = 'organization' | 'user';
export type VcsNamespaceState = 'active' | 'suspended';
export type VcsAccessLevel = 'owner' | 'member' | 'none';
export type VcsInstallationState = 'active' | 'suspended' | 'removed';
export type VcsRepositoryState = 'active' | 'removed';

export interface VcsIdentity {
  readonly id: string;
  readonly provider: string;
  readonly login: string;
  readonly displayName?: string;
  readonly avatarUrl?: string;
}

export interface VcsNamespace {
  readonly id: string;
  readonly provider: string;
  readonly kind: VcsNamespaceKind;
  readonly state: VcsNamespaceState;
  readonly login: string;
  readonly displayName?: string;
}

export interface VcsNamespaceAccess {
  readonly namespaceId: string;
  readonly identityId: string;
  readonly level: VcsAccessLevel;
}

export interface VcsInstallation {
  readonly id: string;
  readonly provider: string;
  readonly namespaceId: string;
  readonly state: VcsInstallationState;
  readonly repositorySelection: 'all' | 'selected';
}

export interface VcsRepository {
  readonly id: string;
  readonly provider: string;
  readonly namespaceId: string;
  readonly installationId: string;
  readonly state: VcsRepositoryState;
  readonly owner: string;
  readonly name: string;
  readonly defaultBranch: string;
  readonly visibility: 'private' | 'public';
}

export interface VcsPullRequest {
  readonly id: string;
  readonly number: number;
  readonly repositoryId: string;
  readonly state: 'open' | 'closed' | 'merged';
  readonly baseBranch: string;
  readonly headRepositoryId: string;
  readonly headSha: string;
  readonly mergeSha?: string;
}

export interface VcsBranch {
  readonly repositoryId: string;
  readonly name: string;
  readonly headSha: string;
}

export type VcsCheckConclusion = 'success' | 'failure' | 'neutral' | 'action-required';

export interface VcsCheck {
  readonly logicalId: string;
  readonly repositoryId: string;
  readonly commitSha: string;
  readonly name: string;
  readonly version: number;
  readonly status: 'queued' | 'in-progress' | 'completed';
  readonly conclusion?: VcsCheckConclusion;
  readonly summary: string;
  readonly detailsUrl: string;
}

/** A transient credential. It is intentionally not serializable or DTO-safe. */
export declare const vcsUserCredentialBrand: unique symbol;
export type VcsUserCredential = {readonly [vcsUserCredentialBrand]: string};

export interface VcsAuthorizationResult {
  readonly identity: VcsIdentity;
  readonly credential: VcsUserCredential;
}

export type VcsEvent =
  | {
      readonly type: 'push';
      readonly deliveryId: string;
      readonly repositoryId: string;
      readonly branch: string;
      readonly headSha: string;
    }
  | {
      readonly type: 'pull-request';
      readonly deliveryId: string;
      readonly action: 'opened' | 'synchronize' | 'closed';
      readonly pullRequest: VcsPullRequest;
    }
  | {
      readonly type: 'installation';
      readonly provider: string;
      readonly deliveryId: string;
      readonly action: 'created' | 'suspended' | 'unsuspended' | 'deleted';
      readonly installation: VcsInstallation;
    }
  | {
      readonly type: 'installation-repositories';
      readonly provider: string;
      readonly deliveryId: string;
      readonly installationId: string;
      readonly namespaceId: string;
      readonly action: 'added' | 'removed';
      readonly repositories: readonly VcsRepository[];
    }
  | {
      readonly type: 'membership';
      readonly provider: string;
      readonly deliveryId: string;
      readonly namespaceId: string;
      readonly identityId: string;
      readonly access: VcsAccessLevel;
    }
  | {
      readonly type: 'organization-lifecycle';
      readonly provider: string;
      readonly deliveryId: string;
      readonly action: 'suspended' | 'unsuspended' | 'deleted';
      readonly namespace: VcsNamespace;
    }
  | {
      readonly type: 'app-authorization-revocation';
      readonly provider: string;
      readonly deliveryId: string;
      readonly identityId: string;
    };

export interface VcsProviderHealth {
  readonly status: 'ready' | 'unavailable';
  readonly checkedAt: Date;
  readonly provider: string;
  readonly detail?: string;
}

export interface VcsIdentityProvider {
  readonly provider: string;
  exchangeAuthorization(input: {
    readonly authorizationCode: string;
    readonly codeVerifier: string;
    readonly redirectUri?: string;
  }): Promise<VcsAuthorizationResult>;
  getIdentity(credential: VcsUserCredential): Promise<VcsIdentity>;
  listAuthorizedInstallations(credential: VcsUserCredential): Promise<readonly VcsInstallation[]>;
}

export interface VcsNamespaceAccessProvider {
  readonly provider: string;
  getNamespace(namespaceId: string): Promise<VcsNamespace | undefined>;
  /**
   * This request-time result is authoritative: `none` and access-revocation fail closed now.
   * Lifecycle webhook events separately drive durable namespace and installation state.
   */
  getNamespaceAccess(input: {
    readonly namespaceId: string;
    readonly identityId: string;
  }): Promise<VcsNamespaceAccess>;
}

export interface VcsInstallationProvider {
  readonly provider: string;
  getInstallation(installationId: string): Promise<VcsInstallation>;
  listRepositories(installationId: string): Promise<readonly VcsRepository[]>;
  health(): Promise<VcsProviderHealth>;
}

export interface VcsWebhookProvider {
  readonly provider: string;
  verifyAndMapWebhook(input: {
    readonly headers: Readonly<Record<string, string>>;
    readonly body: Uint8Array;
  }): Promise<VcsEvent>;
}

export interface VcsProvider {
  readonly provider: string;
  getRepository(repositoryId: string): Promise<VcsRepository | undefined>;
  getPullRequest(repositoryId: string, number: number): Promise<VcsPullRequest | undefined>;
  listPullRequestsForCommit(
    repositoryId: string,
    commitSha: string,
  ): Promise<readonly VcsPullRequest[]>;
  getBranch(repositoryId: string, branch: string): Promise<VcsBranch | undefined>;
  isAncestor(repositoryId: string, ancestorSha: string, descendantSha: string): Promise<boolean>;
  upsertCheck(
    check: VcsCheck,
  ): Promise<{readonly status: 'applied' | 'stale'; readonly check: VcsCheck}>;
  /** Superseded by VcsWebhookProvider.verifyAndMapWebhook; retained for E4/E7 compatibility. */
  verifyWebhook(input: {
    readonly headers: Readonly<Record<string, string>>;
    readonly body: Uint8Array;
  }): Promise<VcsEvent>;
  health(): Promise<VcsProviderHealth>;
}

export type VcsProviderErrorCode =
  | 'timeout'
  | 'rate_limit'
  | 'malformed_response'
  | 'missing_installation'
  | 'access_revocation'
  | 'invalid_webhook';

export abstract class VcsProviderError extends Error {
  abstract readonly code: VcsProviderErrorCode;
  abstract readonly retryable: boolean;

  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class VcsTimeoutError extends VcsProviderError {
  readonly code = 'timeout';
  readonly retryable = true;
  constructor(message = 'The provider did not respond before the request timed out') {
    super(message);
  }
}

export class VcsRateLimitError extends VcsProviderError {
  readonly code = 'rate_limit';
  readonly retryable = true;
  constructor(
    readonly retryAt?: Date,
    message = 'The provider rate limit has been reached',
  ) {
    super(message);
  }
}

export class VcsMalformedResponseError extends VcsProviderError {
  readonly code = 'malformed_response';
  readonly retryable = false;
  constructor(message = 'The provider returned an unexpected response') {
    super(message);
  }
}

export class VcsMissingInstallationError extends VcsProviderError {
  readonly code = 'missing_installation';
  readonly retryable = false;
  constructor(message = 'The requested provider installation is unavailable') {
    super(message);
  }
}

export class VcsAccessRevocationError extends VcsProviderError {
  readonly code = 'access_revocation';
  readonly retryable = false;
  constructor(message = 'Provider access has been revoked') {
    super(message);
  }
}

export class InvalidWebhookError extends VcsProviderError {
  readonly code = 'invalid_webhook';
  readonly retryable = false;
  constructor(message = 'Webhook authenticity could not be verified') {
    super(message);
  }
}
