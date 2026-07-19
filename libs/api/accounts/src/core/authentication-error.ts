import type {AuthErrorCode} from '@glint/api-accounts-dto';

export class AuthenticationError extends Error {
  constructor(
    readonly code: AuthErrorCode,
    message = code,
  ) {
    super(message);
    this.name = 'AuthenticationError';
  }
}
