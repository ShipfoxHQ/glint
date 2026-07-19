export function postgresCode(error: unknown): string | undefined {
  let candidate = error;
  while (candidate && typeof candidate === 'object') {
    if ('code' in candidate && typeof candidate.code === 'string') return candidate.code;
    candidate = 'cause' in candidate ? candidate.cause : undefined;
  }
  return undefined;
}
