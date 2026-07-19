import type {AccountErrorCode} from '@glint/api-accounts-dto';

export class AccountsPersistenceError extends Error {
  constructor(
    readonly code: AccountErrorCode | 'ACCOUNT_CONFLICT' | 'INSTALLATION_CONFLICT',
    message: string,
  ) {
    super(message);
    this.name = 'AccountsPersistenceError';
  }
}
