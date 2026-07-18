export interface WebReadiness {
  readonly status: 'not_ready' | 'ready';
}

export async function webReadiness(
  apiUrl: string,
  request: typeof fetch = fetch,
  timeoutMs = 2_000,
): Promise<WebReadiness> {
  try {
    const response = await request(`${apiUrl}/ready`, {signal: AbortSignal.timeout(timeoutMs)});
    return {status: response.ok ? 'ready' : 'not_ready'};
  } catch {
    return {status: 'not_ready'};
  }
}
