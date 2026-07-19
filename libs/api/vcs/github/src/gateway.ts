import type {VcsProviderHealth} from '@glint/api-vcs-core';

export interface GitHubUser {
  readonly id: number;
  readonly login: string;
  readonly name?: string | null;
  readonly avatar_url?: string | null;
}

export interface GitHubAccount extends GitHubUser {
  readonly type: 'Organization' | 'User';
  readonly suspended_at?: string | null;
}

export interface GitHubInstallation {
  readonly id: number;
  readonly account: GitHubAccount;
  readonly suspended_at?: string | null;
  readonly repository_selection: 'all' | 'selected';
}

export interface GitHubRepository {
  readonly id: number;
  readonly name: string;
  readonly owner: GitHubUser;
  readonly default_branch?: string | null;
  readonly private: boolean;
  readonly archived?: boolean;
  /** Test-only synthetic state; GitHub omits removed repositories from REST lists. */
  readonly removed?: boolean;
}

export interface GitHubMembership {
  readonly state: 'active' | 'pending' | string;
  readonly role: 'admin' | 'member' | string;
}

export interface GitHubNamespaceAccess {
  readonly account: GitHubAccount | undefined;
  readonly installation: GitHubInstallation | undefined;
  readonly membership: GitHubMembership | undefined;
}

export interface GitHubGateway {
  exchangeAuthorization(input: {
    readonly authorizationCode: string;
    readonly codeVerifier: string;
    readonly redirectUri?: string;
  }): Promise<{readonly userToken: string; readonly user: GitHubUser}>;
  getAuthenticatedUser(userToken: string): Promise<GitHubUser>;
  listUserInstallations(userToken: string): Promise<readonly GitHubInstallation[]>;
  getNamespaceAccount(namespaceId: string): Promise<GitHubAccount | undefined>;
  getNamespaceAccess(namespaceId: string, identityId: string): Promise<GitHubNamespaceAccess>;
  getInstallation(installationId: string): Promise<GitHubInstallation>;
  listInstallationRepositories(installationId: string): Promise<readonly GitHubRepository[]>;
  health(): Promise<Pick<VcsProviderHealth, 'status' | 'detail'>>;
}
