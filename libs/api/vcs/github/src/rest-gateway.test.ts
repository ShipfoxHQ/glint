import {generateKeyPairSync} from 'node:crypto';
import {describe, expect, it} from '@shipfox/vitest/vi';
import {GitHubRestGateway} from './rest-gateway.js';

describe('GitHubRestGateway', () => {
  it('exchanges a PKCE authorization code before fetching the provider identity', async () => {
    const requests: {url: string; body: string}[] = [];
    const gateway = new GitHubRestGateway({
      appId: '1',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      privateKey: 'unused-in-this-test',
      fetch: async (input, init) => {
        await Promise.resolve();
        const url = String(input);
        requests.push({url, body: String(init?.body ?? '')});
        if (url.endsWith('/login/oauth/access_token')) {
          return Response.json({access_token: 'user-token'});
        }
        if (url.endsWith('/user')) {
          return Response.json({id: 1, login: 'noe', name: 'Noé Charmet'});
        }
        return new Response(null, {status: 404});
      },
    });

    await expect(
      gateway.exchangeAuthorization({
        authorizationCode: 'authorization-code',
        codeVerifier: 'pkce-verifier',
        redirectUri: 'https://glint.invalid/callback',
      }),
    ).resolves.toEqual({
      userToken: 'user-token',
      user: {id: 1, login: 'noe', name: 'Noé Charmet', avatar_url: null},
    });
    expect(JSON.parse(requests[0]?.body ?? '{}')).toMatchObject({
      code_verifier: 'pkce-verifier',
      redirect_uri: 'https://glint.invalid/callback',
    });
  });

  it('loads every page of user installations', async () => {
    const installation = (id: number) => ({
      id,
      account: {id, login: `org-${id}`, type: 'Organization'},
      repository_selection: 'all',
    });
    const gateway = new GitHubRestGateway({
      appId: '1',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      privateKey: 'unused-in-this-test',
      fetch: async (input) => {
        await Promise.resolve();
        const url = new URL(String(input));
        if (url.pathname !== '/user/installations') return new Response(null, {status: 404});
        const page = url.searchParams.get('page');
        return Response.json({
          installations:
            page === '2'
              ? [installation(101)]
              : Array.from({length: 100}, (_, id) => installation(id + 1)),
        });
      },
    });

    await expect(gateway.listUserInstallations('user-token')).resolves.toHaveLength(101);
  });

  it('uses the configured Enterprise API base URL and caches installation tokens', async () => {
    const privateKey = generateKeyPairSync('rsa', {modulusLength: 2_048})
      .privateKey.export({type: 'pkcs1', format: 'pem'})
      .toString();
    const requests: string[] = [];
    const gateway = new GitHubRestGateway({
      appId: '1',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      privateKey,
      baseUrl: 'https://github.example/api/v3',
      fetch: async (input) => {
        await Promise.resolve();
        const url = String(input);
        requests.push(url);
        if (url.includes('/app/installations/100/access_tokens')) {
          return Response.json({
            token: 'installation-token',
            expires_at: '2030-01-01T00:00:00Z',
            permissions: {},
            repository_selection: 'all',
          });
        }
        if (url.includes('/installation/repositories')) return Response.json({repositories: []});
        return new Response(null, {status: 404});
      },
    });

    await gateway.listInstallationRepositories('100');
    await gateway.listInstallationRepositories('100');
    expect(requests).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          'https://github.example/api/v3/app/installations/100/access_tokens',
        ),
        expect.stringContaining('https://github.example/api/v3/installation/repositories'),
      ]),
    );
    expect(requests.filter((url) => url.includes('/access_tokens'))).toHaveLength(1);
  });
});
