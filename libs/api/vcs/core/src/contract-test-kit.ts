import {describe, expect, it} from '@shipfox/vitest/vi';
import type {VcsCheck, VcsProvider} from './types.js';

export interface VcsContractHarness {
  readonly provider: VcsProvider;
  readonly repositoryId: string;
  readonly pullRequestNumber: number;
  readonly branch: string;
  readonly headSha: string;
  readonly ancestorSha: string;
  readonly validWebhook: {
    readonly headers: Readonly<Record<string, string>>;
    readonly body: Uint8Array;
  };
  readonly invalidWebhook: {
    readonly headers: Readonly<Record<string, string>>;
    readonly body: Uint8Array;
  };
}

const check = (repositoryId: string, version: number, summary: string): VcsCheck => ({
  logicalId: 'glint:project:build:commit',
  repositoryId,
  commitSha: 'head',
  name: 'Glint',
  version,
  status: 'completed',
  conclusion: 'success',
  summary,
  detailsUrl: 'https://glint.invalid/build',
});

export function vcsProviderContractTests(
  name: string,
  createHarness: () => Promise<VcsContractHarness> | VcsContractHarness,
): void {
  describe(`${name} VCS-provider contract`, () => {
    it('resolves provider-neutral repositories, branches, pull requests, and ancestry', async () => {
      const harness = await createHarness();
      await expect(harness.provider.getRepository(harness.repositoryId)).resolves.toMatchObject({
        id: harness.repositoryId,
      });
      await expect(
        harness.provider.getBranch(harness.repositoryId, harness.branch),
      ).resolves.toMatchObject({headSha: harness.headSha});
      await expect(
        harness.provider.getPullRequest(harness.repositoryId, harness.pullRequestNumber),
      ).resolves.toMatchObject({headSha: harness.headSha});
      await expect(
        harness.provider.listPullRequestsForCommit(harness.repositoryId, harness.headSha),
      ).resolves.toHaveLength(1);
      await expect(
        harness.provider.isAncestor(harness.repositoryId, harness.ancestorSha, harness.headSha),
      ).resolves.toBe(true);
    });

    it('keeps one logical check and rejects out-of-order updates', async () => {
      const {provider, repositoryId} = await createHarness();
      await expect(provider.upsertCheck(check(repositoryId, 2, 'newest'))).resolves.toMatchObject({
        status: 'applied',
      });
      await expect(provider.upsertCheck(check(repositoryId, 1, 'stale'))).resolves.toMatchObject({
        status: 'stale',
        check: {version: 2, summary: 'newest'},
      });
      await expect(
        provider.upsertCheck(check(repositoryId, 2, 'idempotent retry')),
      ).resolves.toMatchObject({status: 'applied', check: {version: 2}});
    });

    it('authenticates and maps webhooks before exposing provider-neutral events', async () => {
      const {provider, validWebhook, invalidWebhook} = await createHarness();
      await expect(provider.verifyWebhook(validWebhook)).resolves.toMatchObject({type: 'push'});
      await expect(provider.verifyWebhook(invalidWebhook)).rejects.toMatchObject({
        code: 'invalid_webhook',
      });
    });

    it('reports provider-neutral readiness', async () => {
      const {provider} = await createHarness();
      await expect(provider.health()).resolves.toMatchObject({
        status: 'ready',
        provider: provider.provider,
      });
    });
  });
}
