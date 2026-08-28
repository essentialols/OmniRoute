-- Merge the `antigravity` provider into `agy`.
--
-- They were two registrations of one backend: same Cloud Code endpoint, same executor,
-- same OAuth client, same Google accounts. Keeping both split quota and cooldown state
-- across two pools that could never see each other's consumption.
--
-- `agy` is canonical; `antigravity` survives only as a routing alias in the registry.
--
-- Conflict policy: where a uniqueness constraint would collide, the existing `agy` row
-- wins and the legacy `antigravity` row is dropped. Constraint-free history tables just
-- merge, so historical usage stays intact under the canonical id.

-- 1. Connections. This is a pure rename: it touches only the `provider` column, so it works
--    against any schema shape. It deliberately does NOT dedupe accounts registered under both
--    ids, because that would require columns (email) that partial/older schemas may not have.
--    Deduping duplicate credentials is a one-off data cleanup, not a schema migration.
UPDATE OR IGNORE provider_connections SET provider = 'agy' WHERE provider = 'antigravity';
DELETE FROM provider_connections WHERE provider = 'antigravity';

-- 2. History / analytics / config tables. `compression_run_telemetry`, `model_capabilities`
--    and `cloud_agent_tasks` are created at runtime rather than by a migration, so they are
--    deliberately excluded: referencing them here aborts this migration on a fresh database.
UPDATE OR IGNORE usage_history SET provider = 'agy' WHERE provider = 'antigravity';
DELETE FROM usage_history WHERE provider = 'antigravity';
UPDATE OR IGNORE call_logs SET provider = 'agy' WHERE provider = 'antigravity';
DELETE FROM call_logs WHERE provider = 'antigravity';
UPDATE OR IGNORE proxy_logs SET provider = 'agy' WHERE provider = 'antigravity';
DELETE FROM proxy_logs WHERE provider = 'antigravity';
UPDATE OR IGNORE quota_snapshots SET provider = 'agy' WHERE provider = 'antigravity';
DELETE FROM quota_snapshots WHERE provider = 'antigravity';
UPDATE OR IGNORE request_detail_logs SET provider = 'agy' WHERE provider = 'antigravity';
DELETE FROM request_detail_logs WHERE provider = 'antigravity';
UPDATE OR IGNORE registered_keys SET provider = 'agy' WHERE provider = 'antigravity';
DELETE FROM registered_keys WHERE provider = 'antigravity';
UPDATE OR IGNORE provider_key_limits SET provider = 'agy' WHERE provider = 'antigravity';
DELETE FROM provider_key_limits WHERE provider = 'antigravity';
UPDATE OR IGNORE reasoning_cache SET provider = 'agy' WHERE provider = 'antigravity';
DELETE FROM reasoning_cache WHERE provider = 'antigravity';
UPDATE OR IGNORE compression_analytics SET provider = 'agy' WHERE provider = 'antigravity';
DELETE FROM compression_analytics WHERE provider = 'antigravity';
UPDATE OR IGNORE compression_cache_stats SET provider = 'agy' WHERE provider = 'antigravity';
DELETE FROM compression_cache_stats WHERE provider = 'antigravity';
UPDATE OR IGNORE hourly_usage_summary SET provider = 'agy' WHERE provider = 'antigravity';
DELETE FROM hourly_usage_summary WHERE provider = 'antigravity';
UPDATE OR IGNORE daily_usage_summary SET provider = 'agy' WHERE provider = 'antigravity';
DELETE FROM daily_usage_summary WHERE provider = 'antigravity';
UPDATE OR IGNORE session_account_affinity SET provider = 'agy' WHERE provider = 'antigravity';
DELETE FROM session_account_affinity WHERE provider = 'antigravity';
UPDATE OR IGNORE tier_assignments SET provider = 'agy' WHERE provider = 'antigravity';
DELETE FROM tier_assignments WHERE provider = 'antigravity';
UPDATE OR IGNORE session_model_history SET provider = 'agy' WHERE provider = 'antigravity';
DELETE FROM session_model_history WHERE provider = 'antigravity';
UPDATE OR IGNORE group_model_permissions SET provider = 'agy' WHERE provider = 'antigravity';
DELETE FROM group_model_permissions WHERE provider = 'antigravity';
UPDATE OR IGNORE provider_plans SET provider = 'agy' WHERE provider = 'antigravity';
DELETE FROM provider_plans WHERE provider = 'antigravity';
UPDATE OR IGNORE provider_quota_reset_events SET provider = 'agy' WHERE provider = 'antigravity';
DELETE FROM provider_quota_reset_events WHERE provider = 'antigravity';
UPDATE OR IGNORE model_context_overrides SET provider = 'agy' WHERE provider = 'antigravity';
DELETE FROM model_context_overrides WHERE provider = 'antigravity';
UPDATE OR IGNORE model_capability_overrides SET provider = 'agy' WHERE provider = 'antigravity';
DELETE FROM model_capability_overrides WHERE provider = 'antigravity';

-- 3. Tables keyed on provider_id.
UPDATE OR IGNORE combo_adaptation_state SET provider_id = 'agy' WHERE provider_id = 'antigravity';
DELETE FROM combo_adaptation_state WHERE provider_id = 'antigravity';
UPDATE OR IGNORE upstream_proxy_config SET provider_id = 'agy' WHERE provider_id = 'antigravity';
DELETE FROM upstream_proxy_config WHERE provider_id = 'antigravity';
UPDATE OR IGNORE cloud_agent_credentials SET provider_id = 'agy' WHERE provider_id = 'antigravity';
DELETE FROM cloud_agent_credentials WHERE provider_id = 'antigravity';
UPDATE OR IGNORE discovery_results SET provider_id = 'agy' WHERE provider_id = 'antigravity';
DELETE FROM discovery_results WHERE provider_id = 'antigravity';

-- 4. key_value: `lkgp` is a last-known-good-provider cache pointing at connection ids that
--    may no longer exist after step 1. Drop the stale entries; they repopulate on next use.
DELETE FROM key_value
WHERE namespace = 'lkgp' AND (key LIKE '%antigravity%' OR value LIKE '%"antigravity"%');

DELETE FROM key_value
WHERE namespace = 'gemini_thought_signatures' AND key LIKE '%antigravity%';

UPDATE key_value
SET value = REPLACE(value, '"antigravity"', '"agy"')
WHERE namespace = 'modelCompatOverrides' AND value LIKE '%"antigravity"%';
