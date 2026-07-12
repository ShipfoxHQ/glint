import type {
  VcsBranch,
  VcsCheck,
  VcsEvent,
  VcsProvider,
  VcsProviderHealth,
  VcsPullRequest,
  VcsRepository,
} from './types.js';
import {InvalidWebhookError} from './types.js';

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
