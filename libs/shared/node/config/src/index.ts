import {type CleanedEnv, cleanEnv} from '@shipfox/config';

export {bool, email, host, num, port, str, url} from '@shipfox/config';

export interface EnvironmentValidator {
  readonly _parse: (input: string) => unknown;
}

export interface EnvironmentVariable<TValidator extends EnvironmentValidator> {
  readonly description: string;
  readonly sensitive: boolean;
  readonly validator: TValidator;
}

export type EnvironmentSchema = Readonly<Record<string, EnvironmentVariable<EnvironmentValidator>>>;

export type ValidatorsFor<TSchema extends EnvironmentSchema> = {
  readonly [TKey in keyof TSchema]: TSchema[TKey]['validator'];
};

export type EnvironmentFor<TSchema extends EnvironmentSchema> = CleanedEnv<ValidatorsFor<TSchema>>;

export interface ConfigurationIssue {
  readonly description: string;
  readonly key: string;
  readonly problem: string;
}

export interface EnvironmentVariableDescription {
  readonly description: string;
  readonly key: string;
  readonly sensitive: boolean;
}

export class InvalidConfigurationError extends Error {
  readonly issues: readonly ConfigurationIssue[];

  constructor(issues: readonly ConfigurationIssue[]) {
    const details = issues
      .map((issue) => `- ${issue.key}: ${issue.problem} ${issue.description}`)
      .join('\n');
    super(`Invalid environment configuration:\n${details}`);
    this.name = 'InvalidConfigurationError';
    this.issues = issues;
  }
}

export function environmentVariable<TValidator extends EnvironmentValidator>(
  validator: TValidator,
  options: {readonly description: string; readonly sensitive?: boolean},
): EnvironmentVariable<TValidator> {
  return Object.freeze({
    description: options.description.trim(),
    sensitive: options.sensitive ?? false,
    validator,
  });
}

export function defineEnvironmentSchema<const TSchema extends EnvironmentSchema>(
  schema: TSchema,
): TSchema {
  for (const [key, variable] of Object.entries(schema)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) {
      throw new Error(`Environment schema key "${key}" must be flat UPPER_SNAKE_CASE.`);
    }
    if (variable.description.length === 0) {
      throw new Error(`Environment schema key "${key}" must include a description.`);
    }
  }

  return Object.freeze(schema);
}

export function describeEnvironment<TSchema extends EnvironmentSchema>(
  schema: TSchema,
): readonly EnvironmentVariableDescription[] {
  return Object.entries(schema).map(([key, variable]) => ({
    description: variable.description,
    key,
    sensitive: variable.sensitive,
  }));
}

export function loadEnvironment<TSchema extends EnvironmentSchema>(
  schema: TSchema,
  environment: NodeJS.ProcessEnv = process.env,
): EnvironmentFor<TSchema> {
  const validators = Object.fromEntries(
    Object.entries(schema).map(([key, variable]) => [key, variable.validator]),
  ) as ValidatorsFor<TSchema>;

  return cleanEnv({...environment}, validators, {
    reporter: ({errors}) => {
      const issues = Object.entries(errors).flatMap(([key, error]) => {
        if (!error) return [];
        const variable = schema[key];
        if (!variable) return [];

        return [
          {
            description: variable.description,
            key,
            problem: variable.sensitive
              ? 'Invalid or missing secret.'
              : error.message === 'undefined'
                ? 'Required value is missing.'
                : error.message,
          },
        ];
      });

      if (issues.length > 0) throw new InvalidConfigurationError(issues);
    },
  });
}

export function collectSensitiveValues<TSchema extends EnvironmentSchema>(
  schema: TSchema,
  environment: EnvironmentFor<TSchema>,
): readonly string[] {
  const values = environment as unknown as Readonly<Record<string, unknown>>;
  const secrets = new Set<string>();

  for (const [key, variable] of Object.entries(schema)) {
    if (!variable.sensitive) continue;
    const value = values[key];
    if (typeof value === 'string' && value.length > 0) secrets.add(value);
  }

  return [...secrets];
}
