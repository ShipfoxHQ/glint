const MAX_RETURN_LOCATION_LENGTH = 2_048;

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

export function validateReturnLocation(
  raw: string | undefined,
  options: {readonly webAppUrl: string},
): string {
  const application = new URL(options.webAppUrl);
  if (!raw) return application.toString();
  if (
    raw.length > MAX_RETURN_LOCATION_LENGTH ||
    raw.includes('\\') ||
    containsControlCharacter(raw) ||
    raw.startsWith('//') ||
    raw.startsWith('/\\')
  ) {
    return application.toString();
  }

  try {
    const location = raw.startsWith('/') ? new URL(raw, application) : new URL(raw);
    return location.origin === application.origin ? location.toString() : application.toString();
  } catch {
    return application.toString();
  }
}
