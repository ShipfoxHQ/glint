import type {preHandlerHookHandler} from 'fastify';
import {AuthenticationError} from '../core/authentication-error.js';
import type {AuthenticationService, AuthModuleConfig} from '../core/authentication-service.js';
import type {AuthorizationService} from '../core/authorization-service.js';
import {mutationGuard, requireSession, sessionCookieName} from './authentication-routes.js';

function accountIdFromRequest(request: Parameters<preHandlerHookHandler>[0]): string {
  const params = request.params;
  const accountId =
    params && typeof params === 'object' ? Reflect.get(params, 'accountId') : undefined;
  if (typeof accountId !== 'string' || accountId.length === 0) {
    throw new AuthenticationError('SESSION_EXPIRED');
  }
  return accountId;
}

export function requireCurrentNamespaceAccess(options: {
  readonly authenticationService: AuthenticationService;
  readonly authorizationService: AuthorizationService;
  readonly config: AuthModuleConfig;
}): preHandlerHookHandler {
  const sessionRequired = requireSession(
    options.authenticationService,
    sessionCookieName(options.config),
  );
  return async (request, reply) => {
    await sessionRequired.call(request.server, request, reply, () => {});
    const session = request.session;
    if (!session) throw new AuthenticationError('SESSION_EXPIRED');
    request.access = await options.authorizationService.authorizeAccountAccess({
      action: 'read',
      accountId: accountIdFromRequest(request),
      identityId: session.identityId,
    });
  };
}

export function requireFreshOwner(options: {
  readonly authenticationService: AuthenticationService;
  readonly authorizationService: AuthorizationService;
  readonly config: AuthModuleConfig;
}): preHandlerHookHandler[] {
  const sessionRequired = requireSession(
    options.authenticationService,
    sessionCookieName(options.config),
  );
  return [
    mutationGuard(options.config),
    sessionRequired,
    async (request) => {
      const session = request.session;
      if (!session) throw new AuthenticationError('SESSION_EXPIRED');
      request.access = await options.authorizationService.authorizeAccountAccess({
        action: 'owner-mutation',
        accountId: accountIdFromRequest(request),
        identityId: session.identityId,
      });
    },
  ];
}
