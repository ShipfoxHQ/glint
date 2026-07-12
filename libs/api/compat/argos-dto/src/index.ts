import {z} from 'zod';

export const ARGOS_COMPATIBILITY_VERSION = 1;
export const ARGOS_TOKEN_LENGTH = 40;

export const argosAuthorizationHeaderSchema = z
  .string()
  .regex(/^Bearer [^\s]{40}(?![\s\S])/, 'Expected Bearer followed by a 40-character token');

const nullableStringSchema = z.string().nullable();
const nullableIntegerSchema = z.number().int().nullable();
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const argosProjectResponseSchema = z.looseObject({
  defaultBaseBranch: z.string().optional(),
  hasRemoteContentAccess: z.literal(true),
});

export const argosScreenshotReferenceSchema = z.looseObject({
  key: sha256Schema,
  contentType: z.string(),
});

const createBuildCommonSchema = z.looseObject({
  commit: z.string(),
  branch: z.string(),
  name: nullableStringSchema,
  mode: nullableStringSchema,
  prNumber: nullableIntegerSchema,
  prHeadCommit: nullableStringSchema,
  referenceBranch: nullableStringSchema,
  referenceCommit: nullableStringSchema,
  argosSdk: z.string(),
  ciProvider: nullableStringSchema,
  runId: nullableStringSchema,
  runAttempt: nullableIntegerSchema,
  screenshots: z.array(argosScreenshotReferenceSchema),
  pwTraceKeys: z.array(sha256Schema),
});

export const argosCreateBuildBodySchema = z.union([
  createBuildCommonSchema.extend({
    skipped: z.literal(true),
  }),
  createBuildCommonSchema.extend({
    parallel: z.boolean(),
    parallelNonce: nullableStringSchema,
  }),
]);

export const argosScreenshotSchema = z.looseObject({
  key: sha256Schema,
  name: z.string(),
  metadata: z.unknown().nullable().nonoptional(),
  pwTraceKey: nullableStringSchema,
  threshold: z.number().nullable(),
  baseName: nullableStringSchema,
  parentName: nullableStringSchema,
  contentType: z.string(),
});

export const argosUpdateBuildBodySchema = z.looseObject({
  screenshots: z.array(argosScreenshotSchema),
  parallel: z.boolean(),
  parallelTotal: nullableIntegerSchema,
  parallelIndex: nullableIntegerSchema,
});

export const argosFinalizeBuildsBodySchema = z.looseObject({
  parallelNonce: z.string(),
});

export const argosBuildSchema = z.looseObject({
  id: z.string().optional(),
  status: z.string().optional(),
  url: z.string().optional(),
});

export const argosCreatedBuildSchema = argosBuildSchema.extend({
  id: z.string(),
});

export const argosSignedUploadSchema = z.looseObject({
  key: sha256Schema,
  postUrl: z.string(),
  fields: z.record(z.string(), z.string()),
});

export const argosCreateBuildResponseSchema = z.looseObject({
  build: argosCreatedBuildSchema,
  screenshots: z.array(argosSignedUploadSchema),
  pwTraces: z.array(argosSignedUploadSchema).optional(),
});

export const argosSkippedBuildResponseSchema = z.looseObject({
  build: argosBuildSchema,
});

export const argosUpdateBuildResponseSchema = z.looseObject({
  build: argosBuildSchema,
});

export const argosFinalizeBuildsResponseSchema = z.looseObject({
  builds: z.array(argosBuildSchema),
});

export const argosErrorResponseSchema = z.looseObject({
  error: z.string(),
  details: z.array(z.looseObject({message: z.string()})).optional(),
});

export type ArgosCreateBuildBody = z.infer<typeof argosCreateBuildBodySchema>;
export type ArgosUpdateBuildBody = z.infer<typeof argosUpdateBuildBodySchema>;
export type ArgosFinalizeBuildsBody = z.infer<typeof argosFinalizeBuildsBodySchema>;
