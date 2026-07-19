import {VcsAccessRevocationError, VcsMalformedResponseError} from '@glint/api-vcs-core';
import {createAppAuth} from '@octokit/auth-app';
import {Octokit} from '@octokit/core';
import {RequestError} from '@octokit/request-error';
import {mapRequestError} from './errors.js';
import type {
  GitHubAccount,
  GitHubGateway,
  GitHubInstallation,
  GitHubNamespaceAccess,
  GitHubRepository,
  GitHubUser,
} from './gateway.js';

export interface GithubRestGatewayConfig {
  readonly appId: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly privateKey: string;
  readonly baseUrl?: string;
  readonly requestTimeoutMs?: number;
  readonly fetch?: typeof globalThis.fetch;
}

type Native = Record<string, unknown>;

function object(value: unknown): Native | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Native)
    : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function integer(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;
}

function user(value: unknown): GitHubUser {
  const native = object(value);
  const id = integer(native?.id);
  const login = string(native?.login);
  if (id === undefined || !login) throw new VcsMalformedResponseError();
  return {
    id,
    login,
    name: string(native?.name) ?? null,
    avatar_url: string(native?.avatar_url) ?? null,
  };
}

function account(value: unknown): GitHubAccount {
  const native = object(value);
  const base = user(value);
  const type = native?.type;
  if (type !== 'Organization' && type !== 'User') throw new VcsMalformedResponseError();
  const suspendedAt = native?.suspended_at;
  if (suspendedAt !== null && suspendedAt !== undefined && typeof suspendedAt !== 'string') {
    throw new VcsMalformedResponseError();
  }
  return {...base, type, ...(suspendedAt === undefined ? {} : {suspended_at: suspendedAt})};
}

function installation(value: unknown): GitHubInstallation {
  const native = object(value);
  const id = integer(native?.id);
  const selection = native?.repository_selection;
  if (id === undefined || (selection !== 'all' && selection !== 'selected')) {
    throw new VcsMalformedResponseError();
  }
  const suspendedAt = native?.suspended_at;
  if (suspendedAt !== null && suspendedAt !== undefined && typeof suspendedAt !== 'string') {
    throw new VcsMalformedResponseError();
  }
  return {
    id,
    account: account(native?.account),
    repository_selection: selection,
    ...(suspendedAt === undefined ? {} : {suspended_at: suspendedAt}),
  };
}

function repository(value: unknown): GitHubRepository {
  const native = object(value);
  const id = integer(native?.id);
  const name = string(native?.name);
  const isPrivate = native?.private;
  if (id === undefined || !name || typeof isPrivate !== 'boolean') {
    throw new VcsMalformedResponseError();
  }
  const branch = native?.default_branch;
  if (branch !== null && branch !== undefined && typeof branch !== 'string') {
    throw new VcsMalformedResponseError();
  }
  return {
    id,
    name,
    owner: user(native?.owner),
    ...(branch === undefined ? {} : {default_branch: branch}),
    private: isPrivate,
    archived: native?.archived === true,
  };
}

function positiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new VcsMalformedResponseError();
  return parsed;
}

export class GitHubRestGateway implements GitHubGateway {
  readonly #fetch: typeof globalThis.fetch;
  readonly #timeoutMs: number;
  readonly #timeoutFetch: typeof globalThis.fetch;
  readonly #appAuth;

  constructor(private readonly config: GithubRestGatewayConfig) {
    this.#fetch = config.fetch ?? globalThis.fetch;
    this.#timeoutMs = config.requestTimeoutMs ?? 10_000;
    this.#timeoutFetch = (input, init) =>
      this.#fetch(input, {...init, signal: AbortSignal.timeout(this.#timeoutMs)});
    const request = new Octokit({
      ...(config.baseUrl ? {baseUrl: config.baseUrl} : {}),
      request: {fetch: this.#timeoutFetch},
    }).request;
    this.#appAuth = createAppAuth({
      appId: config.appId,
      privateKey: config.privateKey,
      request,
    });
  }

  async exchangeAuthorization(input: {
    readonly authorizationCode: string;
    readonly codeVerifier: string;
    readonly redirectUri?: string;
  }): Promise<{readonly userToken: string; readonly user: GitHubUser}> {
    return await this.#map(async () => {
      const response = await new Octokit({request: {fetch: this.#timeoutFetch}}).request(
        'POST /login/oauth/access_token',
        {
          baseUrl: this.#oauthBaseUrl(),
          headers: {accept: 'application/json'},
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
          code: input.authorizationCode,
          code_verifier: input.codeVerifier,
          ...(input.redirectUri ? {redirect_uri: input.redirectUri} : {}),
        },
      );
      const oauthResponse = object(response.data);
      if (oauthResponse?.error) throw new VcsAccessRevocationError();
      const userToken = string(oauthResponse?.access_token);
      if (!userToken) throw new VcsMalformedResponseError();
      const nativeUser = await this.#client(userToken).request('GET /user');
      const resolvedUser = user(nativeUser.data);
      return {userToken, user: resolvedUser};
    });
  }

  async getAuthenticatedUser(userToken: string): Promise<GitHubUser> {
    return await this.#map(async () => {
      const response = await this.#client(userToken).request('GET /user');
      return user(response.data);
    });
  }

  async listUserInstallations(userToken: string): Promise<readonly GitHubInstallation[]> {
    return await this.#map(async () => {
      const installations = await this.#allPages(
        this.#client(userToken),
        'GET /user/installations',
        (data) => object(data)?.installations,
      );
      return installations.map((candidate) => installation(candidate));
    });
  }

  async getNamespaceAccount(namespaceId: string): Promise<GitHubAccount | undefined> {
    try {
      const response = await this.#appClient().then((client) =>
        client.request('GET /user/{account_id}', {account_id: positiveInteger(namespaceId)}),
      );
      return account(response.data);
    } catch (error) {
      if (error instanceof RequestError && error.status === 404) return undefined;
      throw mapRequestError(error);
    }
  }

  async getNamespaceAccess(
    namespaceId: string,
    identityId: string,
  ): Promise<GitHubNamespaceAccess> {
    try {
      const appClient = await this.#appClient();
      const response = await appClient.request('GET /user/{account_id}', {
        account_id: positiveInteger(namespaceId),
      });
      const resolvedAccount = account(response.data);
      const installations = await this.#allPages(
        appClient,
        'GET /app/installations',
        (data) => data,
      );
      const resolvedInstallation = installations
        .map((candidate) => installation(candidate))
        .find((candidate) => String(candidate.account.id) === namespaceId);
      if (
        resolvedAccount.type === 'User' ||
        !resolvedInstallation ||
        resolvedAccount.suspended_at ||
        resolvedInstallation.suspended_at
      ) {
        return {
          account: resolvedAccount,
          installation: resolvedInstallation,
          membership: undefined,
        };
      }
      const identityResponse = await appClient.request('GET /user/{account_id}', {
        account_id: positiveInteger(identityId),
      });
      const identity = user(identityResponse.data);
      const installationClient = await this.#installationClient(resolvedInstallation.id);
      const membershipResponse = await installationClient.request(
        'GET /orgs/{org}/memberships/{username}',
        {
          org: resolvedAccount.login,
          username: identity.login,
        },
      );
      const membership = object(membershipResponse.data);
      const state = string(membership?.state);
      const role = string(membership?.role);
      if (!state || !role) throw new VcsMalformedResponseError();
      return {
        account: resolvedAccount,
        installation: resolvedInstallation,
        membership: {state, role},
      };
    } catch (error) {
      if (error instanceof RequestError && error.status === 404) {
        return {account: undefined, installation: undefined, membership: undefined};
      }
      throw mapRequestError(error);
    }
  }

  async getInstallation(installationId: string): Promise<GitHubInstallation> {
    return await this.#map(async () => {
      const response = await this.#appClient().then((client) =>
        client.request('GET /app/installations/{installation_id}', {
          installation_id: positiveInteger(installationId),
        }),
      );
      return installation(response.data);
    });
  }

  async listInstallationRepositories(installationId: string): Promise<readonly GitHubRepository[]> {
    return await this.#map(async () => {
      const client = await this.#installationClient(positiveInteger(installationId));
      const repositories = await this.#allPages(
        client,
        'GET /installation/repositories',
        (data) => object(data)?.repositories,
      );
      return repositories.map((candidate) => repository(candidate));
    });
  }

  async health(): Promise<{readonly status: 'ready' | 'unavailable'; readonly detail?: string}> {
    try {
      const client = await this.#appClient();
      await client.request('GET /app');
      return {status: 'ready'};
    } catch {
      return {status: 'unavailable', detail: 'GitHub App endpoint is unavailable'};
    }
  }

  async #appClient(): Promise<Octokit> {
    const authentication = await this.#appAuth({type: 'app'});
    return this.#client(authentication.token);
  }

  async #installationClient(installationId: number): Promise<Octokit> {
    const authentication = await this.#appAuth({type: 'installation', installationId});
    return this.#client(authentication.token);
  }

  #client(token: string): Octokit {
    return new Octokit({
      auth: token,
      ...(this.config.baseUrl ? {baseUrl: this.config.baseUrl} : {}),
      request: {fetch: this.#timeoutFetch},
    });
  }

  #oauthBaseUrl(): string {
    const baseUrl = this.config.baseUrl;
    if (!baseUrl || /^https:\/\/(api\.)?github\.com\/?$/.test(baseUrl)) return 'https://github.com';
    return baseUrl.replace(/\/api\/v3\/?$/, '');
  }

  async #allPages(
    client: Octokit,
    route: string,
    items: (data: unknown) => unknown,
  ): Promise<unknown[]> {
    const results: unknown[] = [];
    for (let page = 1; ; page += 1) {
      const response = await client.request(route, {per_page: 100, page});
      const currentPage = items(response.data);
      if (!Array.isArray(currentPage)) throw new VcsMalformedResponseError();
      results.push(...currentPage);
      if (currentPage.length < 100) return results;
    }
  }

  async #map<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      throw mapRequestError(error);
    }
  }
}

export function createGitHubRestGateway(config: GithubRestGatewayConfig): GitHubRestGateway {
  return new GitHubRestGateway(config);
}
