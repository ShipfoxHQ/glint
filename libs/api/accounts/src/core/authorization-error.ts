import type {AccountErrorCode} from '@glint/api-accounts-dto';

/** A safe, provider-neutral error that the API boundary can map without leaking internals. */
export class AccountsAuthorizationError extends Error {
  constructor(
    readonly code: AccountErrorCode,
    message = code,
  ) {
    super(message);
    this.name = 'AccountsAuthorizationError';
  }
}
