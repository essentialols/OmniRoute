"use client";

import { useEffect } from "react";
import * as Sentry from "@sentry/browser";
import { isClientSentryEnabled } from "@/lib/monitoring/sentry";

interface SentryErrorReporterProps {
  boundary: string;
  error: Error & { digest?: string };
}

export function SentryErrorReporter({ boundary, error }: SentryErrorReporterProps) {
  useEffect(() => {
    if (!isClientSentryEnabled()) return;
    Sentry.captureException(error, {
      extra: {
        boundary,
        digest: error.digest,
      },
    });
  }, [boundary, error]);

  return null;
}
