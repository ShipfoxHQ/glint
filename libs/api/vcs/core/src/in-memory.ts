import type {
  VcsAccessLevel,
  VcsAuthorizationResult,
  VcsBranch,
  VcsCheck,
  VcsEvent,
  VcsIdentity,
  VcsIdentityProvider,
  VcsInstallation,
  VcsInstallationProvider,
  VcsNamespace,
  VcsNamespaceAccess,
  VcsNamespaceAccessProvider,
  VcsProvider,
  VcsProviderError,
  VcsProviderHealth,
  VcsPullRequest,
  VcsRepository,
  VcsUserCredential,
  VcsWebhookProvider,
} from './types.js';
import {
  InvalidWebhookError,
  VcsAccessRevocationError,
  VcsMissingInstallationError,
} from './types.js';

export class InMemoryVcsProvider implements VcsProvider {
  readonly provider = 'in-memory';
  readonly #repositories = new Map<string, VcsRepository>();
  readonly #pullRequests = new Map<string, VcsPullRequest>();
  readonly #branches = new Map<string, VcsBranch>();
  readonly #ancestry = new Map<string, Map<string, Set<string>>>();
  readonly #checks = new Map<string, VcsCheck>();
  #healthStatus: VcsProviderHealth['status'] = 'ready';

  constructor(private readonly now: () => Date = () => new Date()) {}

  seedRepository(repository: VcsRepository): void {
    this.#repositories.set(repository.id, structuredClone(repository));
  }

  seedPullRequest(pullRequest: VcsPullRequest): void {
    this.#pullRequests.set(
      `${pullRequest.repositoryId}:${pullRequest.number}`,
      structuredClone(pullRequest),
    );
  }

  seedBranch(branch: VcsBranch): void {
    this.#branches.set(`${branch.repositoryId}:${branch.name}`, structuredClone(branch));
  }

  seedAncestry(repositoryId: string, ancestorSha: string, descendantSha: string): void {
    const repository = this.#ancestry.get(repositoryId) ?? new Map<string, Set<string>>();
    const descendants = repository.get(ancestorSha) ?? new Set<string>();
    descendants.add(descendantSha);
    repository.set(ancestorSha, descendants);
    this.#ancestry.set(repositoryId, repository);
  }

  getRepository(repositoryId: string) {
    return Promise.resolve(structuredClone(this.#repositories.get(repositoryId)));
  }

  getPullRequest(repositoryId: string, number: number) {
    return Promise.resolve(structuredClone(this.#pullRequests.get(`${repositoryId}:${number}`)));
  }

  listPullRequestsForCommit(repositoryId: string, commitSha: string) {
    return Promise.resolve(
      [...this.#pullRequests.values()]
        .filter(
          (pullRequest) =>
            pullRequest.repositoryId === repositoryId && pullRequest.headSha === commitSha,
        )
        .map((pullRequest) => structuredClone(pullRequest)),
    );
  }

  getBranch(repositoryId: string, branch: string) {
    return Promise.resolve(structuredClone(this.#branches.get(`${repositoryId}:${branch}`)));
  }

  isAncestor(repositoryId: string, ancestorSha: string, descendantSha: string) {
    if (ancestorSha === descendantSha) return Promise.resolve(true);
    const repository = this.#ancestry.get(repositoryId);
    const pending = [...(repository?.get(ancestorSha) ?? [])];
    const visited = new Set<string>();
    while (pending.length > 0) {
      const current = pending.shift();
      if (!current || visited.has(current)) continue;
      if (current === descendantSha) return Promise.resolve(true);
      visited.add(current);
      pending.push(...(repository?.get(current) ?? []));
    }
    return Promise.resolve(false);
  }

  upsertCheck(check: VcsCheck) {
    const current = this.#checks.get(check.logicalId);
    if (current && current.version > check.version) {
      return Promise.resolve({status: 'stale', check: structuredClone(current)} as const);
    }
    if (current && current.version === check.version) {
      return Promise.resolve({status: 'applied', check: structuredClone(current)} as const);
    }
    this.#checks.set(check.logicalId, structuredClone(check));
    return Promise.resolve({status: 'applied', check: structuredClone(check)} as const);
  }

  verifyWebhook(input: {
    readonly headers: Readonly<Record<string, string>>;
    readonly body: Uint8Array;
  }): Promise<VcsEvent> {
    if (input.headers['x-glint-signature'] !== 'valid') {
      return Promise.reject(new InvalidWebhookError());
    }
    try {
      return Promise.resolve(JSON.parse(new TextDecoder().decode(input.body)) as VcsEvent);
    } catch {
      return Promise.reject(new InvalidWebhookError('Webhook body is not valid JSON'));
    }
  }

  health(): Promise<VcsProviderHealth> {
    return Promise.resolve({
      status: this.#healthStatus,
      checkedAt: this.now(),
      provider: this.provider,
    });
  }

  setHealthStatus(status: VcsProviderHealth['status']): void {
    this.#healthStatus = status;
  }
}

type IdentityProviderOperation =
  | 'exchangeAuthorization'
  | 'getIdentity'
  | 'listAuthorizedInstallations'
  | 'getNamespace'
  | 'getNamespaceAccess'
  | 'getInstallation'
  | 'listRepositories'
  | 'health'
  | 'verifyAndMapWebhook';

/**
 * Deterministic provider-neutral fake for identity, namespace, installation, and webhook contracts.
 * It deliberately models stable IDs; mutable logins and display names never own relationships.
 */
export class InMemoryVcsIdentityProvider
  implements
    VcsIdentityProvider,
    VcsNamespaceAccessProvider,
    VcsInstallationProvider,
    VcsWebhookProvider
{
  readonly provider = 'in-memory';
  readonly #identities = new Map<string, VcsIdentity>();
  readonly #authorizationCodes = new Map<string, string>();
  readonly #credentials = new Map<VcsUserCredential, string>();
  readonly #namespaces = new Map<string, VcsNamespace>();
  readonly #access = new Map<string, VcsAccessLevel>();
  readonly #installations = new Map<string, VcsInstallation>();
  readonly #repositories = new Map<string, VcsRepository[]>();
  readonly #failures = new Map<IdentityProviderOperation, VcsProviderError>();
  #healthStatus: VcsProviderHealth['status'] = 'ready';

  constructor(private readonly now: () => Date = () => new Date()) {}

  seedIdentity(identity: VcsIdentity): void {
    this.#identities.set(identity.id, structuredClone(identity));
  }

  seedAuthorizationCode(authorizationCode: string, identityId: string): void {
    this.#authorizationCodes.set(authorizationCode, identityId);
  }

  seedNamespace(namespace: VcsNamespace): void {
    this.#namespaces.set(namespace.id, structuredClone(namespace));
  }

  seedNamespaceAccess(namespaceId: string, identityId: string, level: VcsAccessLevel): void {
    this.#access.set(`${namespaceId}:${identityId}`, level);
  }

  seedInstallation(installation: VcsInstallation): void {
    this.#installations.set(installation.id, structuredClone(installation));
  }

  seedRepository(repository: VcsRepository): void {
    const repositories = this.#repositories.get(repository.installationId) ?? [];
    const index = repositories.findIndex((candidate) => candidate.id === repository.id);
    if (index === -1) repositories.push(structuredClone(repository));
    else repositories[index] = structuredClone(repository);
    this.#repositories.set(repository.installationId, repositories);
  }

  injectFailure(operation: IdentityProviderOperation, error: VcsProviderError): void {
    this.#failures.set(operation, error);
  }

  exchangeAuthorization(input: {
    readonly authorizationCode: string;
    readonly codeVerifier: string;
    readonly redirectUri?: string;
  }): Promise<VcsAuthorizationResult> {
    const failure = this.#takeFailure('exchangeAuthorization');
    if (failure) return Promise.reject(failure);
    const identityId = this.#authorizationCodes.get(input.authorizationCode);
    const identity = identityId ? this.#identities.get(identityId) : undefined;
    if (!identity)
      return Promise.reject(new VcsAccessRevocationError('Authorization is unavailable'));
    const credential = {} as VcsUserCredential;
    this.#credentials.set(credential, identity.id);
    return Promise.resolve({identity: structuredClone(identity), credential});
  }

  getIdentity(credential: VcsUserCredential): Promise<VcsIdentity> {
    return Promise.resolve().then(() => {
      const failure = this.#takeFailure('getIdentity');
      if (failure) throw failure;
      return structuredClone(this.#identityForCredential(credential));
    });
  }

  listAuthorizedInstallations(credential: VcsUserCredential): Promise<readonly VcsInstallation[]> {
    return Promise.resolve().then(() => {
      const failure = this.#takeFailure('listAuthorizedInstallations');
      if (failure) throw failure;
      const identity = this.#identityForCredential(credential);
      return [...this.#installations.values()]
        .filter((installation) => {
          const access = this.#accessLevel(installation.namespaceId, identity.id);
          return installation.state === 'active' && access !== 'none';
        })
        .map((installation) => structuredClone(installation));
    });
  }

  getNamespace(namespaceId: string): Promise<VcsNamespace | undefined> {
    const failure = this.#takeFailure('getNamespace');
    if (failure) return Promise.reject(failure);
    return Promise.resolve(structuredClone(this.#namespaces.get(namespaceId)));
  }

  getNamespaceAccess(input: {
    readonly namespaceId: string;
    readonly identityId: string;
  }): Promise<VcsNamespaceAccess> {
    const failure = this.#takeFailure('getNamespaceAccess');
    if (failure) return Promise.reject(failure);
    return Promise.resolve({
      namespaceId: input.namespaceId,
      identityId: input.identityId,
      level: this.#accessLevel(input.namespaceId, input.identityId),
    });
  }

  getInstallation(installationId: string): Promise<VcsInstallation> {
    const failure = this.#takeFailure('getInstallation');
    if (failure) return Promise.reject(failure);
    const installation = this.#installations.get(installationId);
    if (!installation) return Promise.reject(new VcsMissingInstallationError());
    return Promise.resolve(structuredClone(installation));
  }

  listRepositories(installationId: string): Promise<readonly VcsRepository[]> {
    const failure = this.#takeFailure('listRepositories');
    if (failure) return Promise.reject(failure);
    if (!this.#installations.has(installationId)) {
      return Promise.reject(new VcsMissingInstallationError());
    }
    return Promise.resolve(
      (this.#repositories.get(installationId) ?? []).map((repository) =>
        structuredClone(repository),
      ),
    );
  }

  health(): Promise<VcsProviderHealth> {
    const failure = this.#takeFailure('health');
    if (failure) return Promise.reject(failure);
    return Promise.resolve({
      status: this.#healthStatus,
      checkedAt: this.now(),
      provider: this.provider,
    });
  }

  setHealthStatus(status: VcsProviderHealth['status']): void {
    this.#healthStatus = status;
  }

  verifyAndMapWebhook(input: {
    readonly headers: Readonly<Record<string, string>>;
    readonly body: Uint8Array;
  }): Promise<VcsEvent> {
    const failure = this.#takeFailure('verifyAndMapWebhook');
    if (failure) return Promise.reject(failure);
    if (input.headers['x-glint-signature'] !== 'valid') {
      return Promise.reject(new InvalidWebhookError());
    }
    try {
      const event = JSON.parse(new TextDecoder().decode(input.body)) as unknown;
      if (!this.#isVcsEvent(event)) return Promise.reject(new InvalidWebhookError());
      return Promise.resolve(event);
    } catch {
      return Promise.reject(new InvalidWebhookError('Webhook body is not valid JSON'));
    }
  }

  #takeFailure(operation: IdentityProviderOperation): VcsProviderError | undefined {
    const failure = this.#failures.get(operation);
    this.#failures.delete(operation);
    return failure;
  }

  #identityForCredential(credential: VcsUserCredential): VcsIdentity {
    const identityId = this.#credentials.get(credential);
    const identity = identityId ? this.#identities.get(identityId) : undefined;
    if (!identity) throw new VcsAccessRevocationError();
    return identity;
  }

  #accessLevel(namespaceId: string, identityId: string): VcsAccessLevel {
    const namespace = this.#namespaces.get(namespaceId);
    if (namespace?.state !== 'active') return 'none';
    if (namespace.kind === 'user') return namespace.id === identityId ? 'owner' : 'none';
    return this.#access.get(`${namespaceId}:${identityId}`) ?? 'none';
  }

  #isVcsEvent(value: unknown): value is VcsEvent {
    if (!value || typeof value !== 'object') return false;
    const event = value as {readonly deliveryId?: unknown; readonly type?: unknown};
    return (
      typeof event.deliveryId === 'string' &&
      [
        'push',
        'pull-request',
        'installation',
        'installation-repositories',
        'membership',
        'organization-lifecycle',
        'app-authorization-revocation',
      ].includes(event.type as string)
    );
  }
}
