import type {Account} from '../core/types.js';

/** Maps the account-owned provider namespace consistently across account and session responses. */
export function accountNamespaceRepresentation(account: Account) {
  return {
    id: account.providerNamespaceId,
    provider: account.provider,
    kind: account.namespaceKind,
    state: account.state,
    login: account.slug,
    displayName: account.displayName,
  };
}
