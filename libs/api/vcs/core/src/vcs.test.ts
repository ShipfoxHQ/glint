import {vcsProviderContractTests} from './contract-test-kit.js';
import {InMemoryVcsProvider} from './in-memory.js';

vcsProviderContractTests('in-memory', () => {
  const provider = new InMemoryVcsProvider(() => new Date(0));
  provider.seedRepository({
    id: 'repo-1',
    provider: 'in-memory',
    namespaceId: 'namespace-1',
    installationId: 'installation-1',
    state: 'active',
    owner: 'shipfox',
    name: 'glint',
    defaultBranch: 'main',
    visibility: 'private',
  });
  provider.seedBranch({repositoryId: 'repo-1', name: 'main', headSha: 'head'});
  provider.seedPullRequest({
    id: 'pr-1',
    number: 9,
    repositoryId: 'repo-1',
    state: 'open',
    baseBranch: 'main',
    headRepositoryId: 'repo-1',
    headSha: 'head',
  });
  provider.seedAncestry('repo-1', 'base', 'middle');
  provider.seedAncestry('repo-1', 'middle', 'head');
  const webhook = {
    type: 'push',
    deliveryId: 'delivery-1',
    repositoryId: 'repo-1',
    branch: 'main',
    headSha: 'head',
  };
  return {
    provider,
    repositoryId: 'repo-1',
    pullRequestNumber: 9,
    branch: 'main',
    headSha: 'head',
    ancestorSha: 'base',
    intermediateSha: 'middle',
    unrelatedSha: 'unrelated',
    validWebhook: {
      headers: {'x-glint-signature': 'valid'},
      body: new TextEncoder().encode(JSON.stringify(webhook)),
    },
    invalidWebhook: {headers: {}, body: new Uint8Array()},
    malformedWebhook: {
      headers: {'x-glint-signature': 'valid'},
      body: new TextEncoder().encode('{'),
    },
  };
});
