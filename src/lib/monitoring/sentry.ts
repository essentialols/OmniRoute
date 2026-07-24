const TRUE_ENV_VALUES = new Set(["1", "true", "yes", "on"]);

export function isTruthyEnv(value: string | undefined): boolean {
  return value ? TRUE_ENV_VALUES.has(value.trim().toLowerCase()) : false;
}

export function isServerSentryEnabled(): boolean {
  return Boolean(process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN);
}

export function isClientSentryEnabled(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_SENTRY_DSN);
}
