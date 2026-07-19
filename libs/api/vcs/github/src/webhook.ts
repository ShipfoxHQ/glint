import type {VcsEvent, VcsInstallation, VcsNamespace, VcsRepository} from '@glint/api-vcs-core';
import {InvalidWebhookError} from '@glint/api-vcs-core';
import {verify} from '@octokit/webhooks-methods';

type Payload = Record<string, unknown>;

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function numberId(value: unknown): string | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : undefined;
}

function record(value: unknown): Payload | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Payload)
    : undefined;
}

function installation(value: unknown): VcsInstallation | undefined {
  const source = record(value);
  const account = record(source?.account);
  const id = numberId(source?.id);
  const namespaceId = numberId(account?.id);
  const selection = source?.repository_selection;
  if (!id || !namespaceId || (selection !== 'all' && selection !== 'selected')) return undefined;
  const suspended = source?.suspended_at !== null && source?.suspended_at !== undefined;
  return {
    id,
    provider: 'github',
    namespaceId,
    state: suspended ? 'suspended' : 'active',
    repositorySelection: selection,
  };
}

function repository(
  value: unknown,
  installationId: string,
  namespaceId: string,
): VcsRepository | undefined {
  const source = record(value);
  const id = numberId(source?.id);
  const name = text(source?.name);
  const fullName = text(source?.full_name);
  const owner = fullName?.split('/')[0];
  if (!id || !owner || !name || typeof source?.private !== 'boolean') return undefined;
  return {
    id,
    provider: 'github',
    namespaceId,
    installationId,
    state: 'active',
    owner,
    name,
    defaultBranch: text(source?.default_branch) ?? 'HEAD',
    visibility: source.private ? 'private' : 'public',
  };
}

function namespace(value: unknown): VcsNamespace | undefined {
  const source = record(value);
  const id = numberId(source?.id);
  const login = text(source?.login);
  const kind =
    source?.type === 'Organization' ? 'organization' : source?.type === 'User' ? 'user' : undefined;
  const displayName = text(source?.name);
  if (!id || !login || !kind) return undefined;
  return {
    id,
    provider: 'github',
    kind,
    state: source?.suspended_at ? 'suspended' : 'active',
    login,
    ...(displayName ? {displayName} : {}),
  };
}

function requiredHeaders(headers: Readonly<Record<string, string>>) {
  const signature = headers['x-hub-signature-256'];
  const event = headers['x-github-event'];
  const deliveryId = headers['x-github-delivery'];
  return signature && event && deliveryId ? {signature, event, deliveryId} : undefined;
}

export async function verifyAndMapWebhook(input: {
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
  readonly webhookSecret: string;
}): Promise<VcsEvent> {
  const headers = requiredHeaders(input.headers);
  if (!headers) throw new InvalidWebhookError();
  const rawBody = new TextDecoder().decode(input.body);
  if (!(await verify(input.webhookSecret, rawBody, headers.signature)))
    throw new InvalidWebhookError();
  try {
    const payload = JSON.parse(rawBody) as Payload;
    if (headers.event === 'installation') {
      const mapped = installation(payload.installation);
      const action = payload.action;
      if (
        mapped &&
        (action === 'created' ||
          action === 'deleted' ||
          action === 'suspend' ||
          action === 'unsuspend')
      ) {
        return {
          type: 'installation',
          provider: 'github',
          deliveryId: headers.deliveryId,
          action:
            action === 'suspend' ? 'suspended' : action === 'unsuspend' ? 'unsuspended' : action,
          installation: {
            ...mapped,
            state: action === 'deleted' ? 'removed' : action === 'suspend' ? 'suspended' : 'active',
          },
        };
      }
    }
    if (headers.event === 'installation_repositories') {
      const mappedInstallation = installation(payload.installation);
      const action = payload.action;
      const nativeRepositories =
        action === 'added' ? payload.repositories_added : payload.repositories_removed;
      if (
        mappedInstallation &&
        (action === 'added' || action === 'removed') &&
        Array.isArray(nativeRepositories)
      ) {
        const repositories = nativeRepositories.map((candidate) =>
          repository(candidate, mappedInstallation.id, mappedInstallation.namespaceId),
        );
        if (repositories.some((candidate) => !candidate)) throw new InvalidWebhookError();
        return {
          type: 'installation-repositories',
          provider: 'github',
          deliveryId: headers.deliveryId,
          installationId: mappedInstallation.id,
          namespaceId: mappedInstallation.namespaceId,
          action,
          repositories: repositories.map((candidate) => ({
            ...(candidate as VcsRepository),
            state: action === 'removed' ? 'removed' : 'active',
          })),
        };
      }
    }
    if (
      headers.event === 'organization' &&
      (payload.action === 'member_added' || payload.action === 'member_removed')
    ) {
      const organization = record(payload.organization);
      const member = record(payload.member);
      const membership = record(payload.membership);
      const namespaceId = numberId(organization?.id);
      const identityId = numberId(member?.id) ?? numberId(record(membership?.user)?.id);
      const role = text(membership?.role);
      if (
        namespaceId &&
        identityId &&
        (payload.action === 'member_removed' || role === 'admin' || role === 'member')
      ) {
        return {
          type: 'membership',
          provider: 'github',
          deliveryId: headers.deliveryId,
          namespaceId,
          identityId,
          access:
            payload.action === 'member_removed' ? 'none' : role === 'admin' ? 'owner' : 'member',
        };
      }
    }
    if (headers.event === 'organization' && payload.action === 'deleted') {
      const mapped = namespace(payload.organization);
      if (mapped) {
        return {
          type: 'organization-lifecycle',
          provider: 'github',
          deliveryId: headers.deliveryId,
          action: 'deleted',
          namespace: {...mapped, state: 'suspended'},
        };
      }
    }
    if (headers.event === 'github_app_authorization' && payload.action === 'revoked') {
      const sender = record(payload.sender);
      const identityId = numberId(sender?.id);
      if (identityId) {
        return {
          type: 'app-authorization-revocation',
          provider: 'github',
          deliveryId: headers.deliveryId,
          identityId,
        };
      }
    }
  } catch (error) {
    if (error instanceof InvalidWebhookError) throw error;
  }
  throw new InvalidWebhookError();
}
