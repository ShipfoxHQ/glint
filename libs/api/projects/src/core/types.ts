export interface RepositoryProjection {
  readonly id: string;
  readonly accountId: string;
  readonly provider: string;
  readonly installationId: string;
  readonly providerRepositoryId: string;
  readonly ownerLogin: string;
  readonly name: string;
  readonly defaultBranch: string;
  readonly visibility: string;
  readonly accessState: 'active' | 'removed' | 'suspended';
  readonly createdAt: Date;
  readonly updatedAt: Date;
}
export interface Project {
  readonly id: string;
  readonly accountId: string;
  readonly repositoryId: string;
  readonly slug: string;
  readonly name: string;
  readonly visibility: 'private' | 'public';
  readonly state: 'active' | 'suspended';
  readonly createdBy: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}
export interface ProjectToken {
  readonly id: string;
  readonly accountId: string;
  readonly projectId: string;
  readonly label: string;
  readonly tokenPrefix: string;
  readonly tokenDigest: string;
  readonly scope: 'build-write';
  readonly createdBy: string;
  readonly lastUsedAt?: Date;
  readonly revokedAt?: Date;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}
export interface IdempotencyRecord {
  readonly id: string;
  readonly accountId: string;
  readonly actor: string;
  readonly route: string;
  readonly idempotencyKey: string;
  readonly requestDigest: string;
  readonly resultReference?: string;
  readonly expiresAt: Date;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}
