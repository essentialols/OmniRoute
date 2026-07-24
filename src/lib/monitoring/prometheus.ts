import { collectDefaultMetrics, Gauge, Registry } from "prom-client";
import { getQuotaMonitorSummary } from "@omniroute/open-sse/services/quotaMonitor.ts";
import { getActiveSessions } from "@omniroute/open-sse/services/sessionManager.ts";
import { getProviderConnections } from "@/lib/localDb";
import { getAllCircuitBreakerStatuses } from "@/shared/utils/circuitBreaker";
import { getTelemetrySummary } from "@/shared/utils/requestTelemetry";
import { APP_CONFIG } from "@/shared/constants/config";

type LabeledGauge<Labels extends string> = Gauge<Labels>;

interface OmniRoutePrometheusMetrics {
  registry: Registry;
  buildInfo: LabeledGauge<"version" | "node_version">;
  recentRequests: Gauge;
  requestLatency: LabeledGauge<"quantile">;
  activeSessions: Gauge;
  quotaMonitors: LabeledGauge<"status">;
  circuitBreakers: LabeledGauge<"name" | "state">;
  providerConnections: LabeledGauge<"provider" | "active">;
  providerCooldowns: LabeledGauge<"provider">;
}

const GLOBAL_METRICS_KEY = Symbol.for("omniroute.prometheus.metrics");

function createMetrics(): OmniRoutePrometheusMetrics {
  const registry = new Registry();
  registry.setDefaultLabels({ service: "omniroute" });
  collectDefaultMetrics({ register: registry, prefix: "omniroute_" });

  const metrics: OmniRoutePrometheusMetrics = {
    registry,
    buildInfo: new Gauge({
      name: "omniroute_build_info",
      help: "OmniRoute build and runtime metadata.",
      labelNames: ["version", "node_version"],
      registers: [registry],
    }),
    recentRequests: new Gauge({
      name: "omniroute_requests_recent_total",
      help: "Requests recorded by in-process telemetry during the last five minutes.",
      registers: [registry],
    }),
    requestLatency: new Gauge({
      name: "omniroute_request_latency_ms",
      help: "Request latency percentiles from in-process telemetry during the last five minutes.",
      labelNames: ["quantile"],
      registers: [registry],
    }),
    activeSessions: new Gauge({
      name: "omniroute_sessions_active",
      help: "Active in-process sticky sessions.",
      registers: [registry],
    }),
    quotaMonitors: new Gauge({
      name: "omniroute_quota_monitors",
      help: "Quota monitor counts by status.",
      labelNames: ["status"],
      registers: [registry],
    }),
    circuitBreakers: new Gauge({
      name: "omniroute_circuit_breaker_state",
      help: "Circuit breaker state. A value of 1 marks the current state for each breaker.",
      labelNames: ["name", "state"],
      registers: [registry],
    }),
    providerConnections: new Gauge({
      name: "omniroute_provider_connections",
      help: "Configured provider connections by provider and active flag.",
      labelNames: ["provider", "active"],
      registers: [registry],
    }),
    providerCooldowns: new Gauge({
      name: "omniroute_provider_connections_cooling_down",
      help: "Provider connections currently in rate-limit cooldown.",
      labelNames: ["provider"],
      registers: [registry],
    }),
  };

  metrics.buildInfo.labels(APP_CONFIG.version, process.version.replace(/^v/, "")).set(1);

  return metrics;
}

function getMetrics(): OmniRoutePrometheusMetrics {
  const globalWithMetrics = globalThis as typeof globalThis & {
    [GLOBAL_METRICS_KEY]?: OmniRoutePrometheusMetrics;
  };
  globalWithMetrics[GLOBAL_METRICS_KEY] ??= createMetrics();
  return globalWithMetrics[GLOBAL_METRICS_KEY];
}

function countProviderConnections(
  connections: Array<{ provider?: string; isActive?: boolean | null; rateLimitedUntil?: unknown }>
) {
  const totals = new Map<string, { active: number; inactive: number; coolingDown: number }>();
  const now = Date.now();

  for (const connection of connections) {
    const provider = connection.provider || "unknown";
    const entry = totals.get(provider) ?? { active: 0, inactive: 0, coolingDown: 0 };
    if (connection.isActive) entry.active += 1;
    else entry.inactive += 1;

    const cooldownUntil =
      typeof connection.rateLimitedUntil === "number"
        ? connection.rateLimitedUntil
        : typeof connection.rateLimitedUntil === "string"
          ? Date.parse(connection.rateLimitedUntil)
          : NaN;
    if (Number.isFinite(cooldownUntil) && cooldownUntil > now) {
      entry.coolingDown += 1;
    }

    totals.set(provider, entry);
  }

  return totals;
}

export async function collectOmniRoutePrometheusMetrics(): Promise<void> {
  const metrics = getMetrics();
  const telemetry = getTelemetrySummary(300000);
  const quotaMonitor = getQuotaMonitorSummary();
  const activeSessions = getActiveSessions();
  const circuitBreakers = getAllCircuitBreakerStatuses();
  const connections = await getProviderConnections();
  const providerTotals = countProviderConnections(connections);

  metrics.recentRequests.set(telemetry.count);
  metrics.requestLatency.reset();
  metrics.requestLatency.labels("0.5").set(telemetry.p50);
  metrics.requestLatency.labels("0.95").set(telemetry.p95);
  metrics.requestLatency.labels("0.99").set(telemetry.p99);
  metrics.activeSessions.set(activeSessions.length);

  metrics.quotaMonitors.reset();
  metrics.quotaMonitors.labels("active").set(quotaMonitor.active);
  metrics.quotaMonitors.labels("alerting").set(quotaMonitor.alerting);
  metrics.quotaMonitors.labels("exhausted").set(quotaMonitor.exhausted);
  metrics.quotaMonitors.labels("errors").set(quotaMonitor.errors);

  metrics.circuitBreakers.reset();
  for (const breaker of circuitBreakers) {
    metrics.circuitBreakers.labels(breaker.name, breaker.state).set(1);
  }

  metrics.providerConnections.reset();
  metrics.providerCooldowns.reset();
  for (const [provider, counts] of providerTotals) {
    metrics.providerConnections.labels(provider, "true").set(counts.active);
    metrics.providerConnections.labels(provider, "false").set(counts.inactive);
    metrics.providerCooldowns.labels(provider).set(counts.coolingDown);
  }
}

export async function renderOmniRoutePrometheusMetrics(): Promise<string> {
  const metrics = getMetrics();
  await collectOmniRoutePrometheusMetrics();
  return metrics.registry.metrics();
}

export function getOmniRoutePrometheusContentType(): string {
  return getMetrics().registry.contentType;
}
