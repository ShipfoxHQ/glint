export interface VcsRepository {
  readonly id: string;
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
    };

export interface VcsProviderHealth {
  readonly status: 'ready' | 'unavailable';
  readonly checkedAt: Date;
  readonly provider: string;
  readonly detail?: string;
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
  verifyWebhook(input: {
    readonly headers: Readonly<Record<string, string>>;
    readonly body: Uint8Array;
  }): Promise<VcsEvent>;
  health(): Promise<VcsProviderHealth>;
}

export class InvalidWebhookError extends Error {
  readonly code = 'invalid_webhook';

  constructor(message = 'Webhook authenticity could not be verified') {
    super(message);
    this.name = 'InvalidWebhookError';
  }
}
