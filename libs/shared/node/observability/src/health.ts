export type HealthStatus = 'live' | 'not_live' | 'not_ready' | 'ready';

export interface HealthCheckResult {
  readonly durationMs: number;
  readonly message?: string;
  readonly name: string;
  readonly status: 'failed' | 'passed';
}

export interface HealthReport {
  readonly checks: readonly HealthCheckResult[];
  readonly reason?: string;
  readonly status: HealthStatus;
  readonly timestamp: string;
}

export interface ReadinessCheck {
  readonly check: () => Promise<void> | void;
  readonly name: string;
}

export class HealthRegistry {
  readonly #checks = new Map<string, {readonly check: ReadinessCheck}>();
  readonly #clock: () => number;
  #notLiveReason: string | undefined;

  constructor(options: {readonly clock?: () => number} = {}) {
    this.#clock = options.clock ?? Date.now;
  }

  liveness(): HealthReport {
    return {
      checks: [],
      ...(this.#notLiveReason ? {reason: this.#notLiveReason} : {}),
      status: this.#notLiveReason ? 'not_live' : 'live',
      timestamp: new Date(this.#clock()).toISOString(),
    };
  }

  markNotLive(reason: string): void {
    const normalizedReason = reason.trim();
    if (normalizedReason.length === 0) throw new Error('A not-live reason is required.');
    this.#notLiveReason = normalizedReason;
  }

  async readiness(): Promise<HealthReport> {
    const checks = await Promise.all(
      [...this.#checks.values()].map(async ({check: readinessCheck}) => {
        const {check, name} = readinessCheck;
        const startedAt = this.#clock();
        try {
          await check();
          return {durationMs: this.#clock() - startedAt, name, status: 'passed' as const};
        } catch (error) {
          return {
            durationMs: this.#clock() - startedAt,
            message: error instanceof Error ? error.message : 'Readiness check failed.',
            name,
            status: 'failed' as const,
          };
        }
      }),
    );

    return {
      checks,
      status: checks.some((check) => check.status === 'failed') ? 'not_ready' : 'ready',
      timestamp: new Date(this.#clock()).toISOString(),
    };
  }

  registerReadinessCheck(check: ReadinessCheck): () => void {
    if (this.#checks.has(check.name)) {
      throw new Error(`Readiness check "${check.name}" is already registered.`);
    }
    const registration = {check};
    this.#checks.set(check.name, registration);
    return () => {
      if (this.#checks.get(check.name) === registration) this.#checks.delete(check.name);
    };
  }
}
