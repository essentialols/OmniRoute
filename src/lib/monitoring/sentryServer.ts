import * as Sentry from "@sentry/node";
import { isServerSentryEnabled, isTruthyEnv } from "@/lib/monitoring/sentry";

export function initSentry() {
  if (!isServerSentryEnabled()) return;

  Sentry.init({
    dsn: process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN,
    environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || "development",
    release: process.env.SENTRY_RELEASE || process.env.OMNIROUTE_BUILD_SHA,
    tracesSampleRate: Number.parseFloat(process.env.SENTRY_TRACES_SAMPLE_RATE || "0") || 0,
    profilesSampleRate: Number.parseFloat(process.env.SENTRY_PROFILES_SAMPLE_RATE || "0") || 0,
    debug: isTruthyEnv(process.env.SENTRY_DEBUG),
  });
}
