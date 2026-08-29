-- Merge duplicate provider registrations into their canonical ids.
--
-- Each pair was two registrations of ONE upstream service: same endpoint, same
-- credentials, same account. Keeping them split tracked two quota/cooldown pools
-- against a single real quota.
--
--   moonshot       -> kimi     (same api.moonshot.ai endpoint, identical model ids)
--   vertex-partner -> vertex   (same endpoint; the partner executor already ran on
--                               vertex's config, so its own baseUrl was never used)
--   qianfan        -> baidu    (same qianfan.baidubce.com endpoint, both ERNIE)
--
-- `glm`/`glmt` are deliberately NOT merged here: glmt carries a distinct thinking
-- preset, so it stays a separate provider and instead shares glm's connection pool.
--
-- Pure rename: touches only the provider column, so it applies to any schema shape.
-- UPDATE OR IGNORE + DELETE resolves uniqueness collisions in favour of the existing
-- canonical row. Runtime-created tables (compression_run_telemetry, model_capabilities,
-- cloud_agent_tasks) are excluded: referencing them aborts this on a fresh database.

-- moonshot -> kimi
UPDATE OR IGNORE provider_connections SET provider = 'kimi' WHERE provider = 'moonshot';
DELETE FROM provider_connections WHERE provider = 'moonshot';
UPDATE OR IGNORE provider_connections SET provider = 'kimi' WHERE provider = 'moonshot';
DELETE FROM provider_connections WHERE provider = 'moonshot';
UPDATE OR IGNORE usage_history SET provider = 'kimi' WHERE provider = 'moonshot';
DELETE FROM usage_history WHERE provider = 'moonshot';
UPDATE OR IGNORE call_logs SET provider = 'kimi' WHERE provider = 'moonshot';
DELETE FROM call_logs WHERE provider = 'moonshot';
UPDATE OR IGNORE proxy_logs SET provider = 'kimi' WHERE provider = 'moonshot';
DELETE FROM proxy_logs WHERE provider = 'moonshot';
UPDATE OR IGNORE quota_snapshots SET provider = 'kimi' WHERE provider = 'moonshot';
DELETE FROM quota_snapshots WHERE provider = 'moonshot';
UPDATE OR IGNORE request_detail_logs SET provider = 'kimi' WHERE provider = 'moonshot';
DELETE FROM request_detail_logs WHERE provider = 'moonshot';
UPDATE OR IGNORE registered_keys SET provider = 'kimi' WHERE provider = 'moonshot';
DELETE FROM registered_keys WHERE provider = 'moonshot';
UPDATE OR IGNORE provider_key_limits SET provider = 'kimi' WHERE provider = 'moonshot';
DELETE FROM provider_key_limits WHERE provider = 'moonshot';
UPDATE OR IGNORE reasoning_cache SET provider = 'kimi' WHERE provider = 'moonshot';
DELETE FROM reasoning_cache WHERE provider = 'moonshot';
UPDATE OR IGNORE compression_analytics SET provider = 'kimi' WHERE provider = 'moonshot';
DELETE FROM compression_analytics WHERE provider = 'moonshot';
UPDATE OR IGNORE compression_cache_stats SET provider = 'kimi' WHERE provider = 'moonshot';
DELETE FROM compression_cache_stats WHERE provider = 'moonshot';
UPDATE OR IGNORE hourly_usage_summary SET provider = 'kimi' WHERE provider = 'moonshot';
DELETE FROM hourly_usage_summary WHERE provider = 'moonshot';
UPDATE OR IGNORE daily_usage_summary SET provider = 'kimi' WHERE provider = 'moonshot';
DELETE FROM daily_usage_summary WHERE provider = 'moonshot';
UPDATE OR IGNORE session_account_affinity SET provider = 'kimi' WHERE provider = 'moonshot';
DELETE FROM session_account_affinity WHERE provider = 'moonshot';
UPDATE OR IGNORE tier_assignments SET provider = 'kimi' WHERE provider = 'moonshot';
DELETE FROM tier_assignments WHERE provider = 'moonshot';
UPDATE OR IGNORE session_model_history SET provider = 'kimi' WHERE provider = 'moonshot';
DELETE FROM session_model_history WHERE provider = 'moonshot';
UPDATE OR IGNORE group_model_permissions SET provider = 'kimi' WHERE provider = 'moonshot';
DELETE FROM group_model_permissions WHERE provider = 'moonshot';
UPDATE OR IGNORE provider_plans SET provider = 'kimi' WHERE provider = 'moonshot';
DELETE FROM provider_plans WHERE provider = 'moonshot';
UPDATE OR IGNORE provider_quota_reset_events SET provider = 'kimi' WHERE provider = 'moonshot';
DELETE FROM provider_quota_reset_events WHERE provider = 'moonshot';
UPDATE OR IGNORE model_context_overrides SET provider = 'kimi' WHERE provider = 'moonshot';
DELETE FROM model_context_overrides WHERE provider = 'moonshot';
UPDATE OR IGNORE model_capability_overrides SET provider = 'kimi' WHERE provider = 'moonshot';
DELETE FROM model_capability_overrides WHERE provider = 'moonshot';
UPDATE OR IGNORE combo_adaptation_state SET provider_id = 'kimi' WHERE provider_id = 'moonshot';
DELETE FROM combo_adaptation_state WHERE provider_id = 'moonshot';
UPDATE OR IGNORE upstream_proxy_config SET provider_id = 'kimi' WHERE provider_id = 'moonshot';
DELETE FROM upstream_proxy_config WHERE provider_id = 'moonshot';
UPDATE OR IGNORE cloud_agent_credentials SET provider_id = 'kimi' WHERE provider_id = 'moonshot';
DELETE FROM cloud_agent_credentials WHERE provider_id = 'moonshot';
UPDATE OR IGNORE discovery_results SET provider_id = 'kimi' WHERE provider_id = 'moonshot';
DELETE FROM discovery_results WHERE provider_id = 'moonshot';
DELETE FROM key_value WHERE namespace = 'lkgp' AND (key LIKE '%moonshot%' OR value LIKE '%"moonshot"%');

-- vertex-partner -> vertex
UPDATE OR IGNORE provider_connections SET provider = 'vertex' WHERE provider = 'vertex-partner';
DELETE FROM provider_connections WHERE provider = 'vertex-partner';
UPDATE OR IGNORE provider_connections SET provider = 'vertex' WHERE provider = 'vertex-partner';
DELETE FROM provider_connections WHERE provider = 'vertex-partner';
UPDATE OR IGNORE usage_history SET provider = 'vertex' WHERE provider = 'vertex-partner';
DELETE FROM usage_history WHERE provider = 'vertex-partner';
UPDATE OR IGNORE call_logs SET provider = 'vertex' WHERE provider = 'vertex-partner';
DELETE FROM call_logs WHERE provider = 'vertex-partner';
UPDATE OR IGNORE proxy_logs SET provider = 'vertex' WHERE provider = 'vertex-partner';
DELETE FROM proxy_logs WHERE provider = 'vertex-partner';
UPDATE OR IGNORE quota_snapshots SET provider = 'vertex' WHERE provider = 'vertex-partner';
DELETE FROM quota_snapshots WHERE provider = 'vertex-partner';
UPDATE OR IGNORE request_detail_logs SET provider = 'vertex' WHERE provider = 'vertex-partner';
DELETE FROM request_detail_logs WHERE provider = 'vertex-partner';
UPDATE OR IGNORE registered_keys SET provider = 'vertex' WHERE provider = 'vertex-partner';
DELETE FROM registered_keys WHERE provider = 'vertex-partner';
UPDATE OR IGNORE provider_key_limits SET provider = 'vertex' WHERE provider = 'vertex-partner';
DELETE FROM provider_key_limits WHERE provider = 'vertex-partner';
UPDATE OR IGNORE reasoning_cache SET provider = 'vertex' WHERE provider = 'vertex-partner';
DELETE FROM reasoning_cache WHERE provider = 'vertex-partner';
UPDATE OR IGNORE compression_analytics SET provider = 'vertex' WHERE provider = 'vertex-partner';
DELETE FROM compression_analytics WHERE provider = 'vertex-partner';
UPDATE OR IGNORE compression_cache_stats SET provider = 'vertex' WHERE provider = 'vertex-partner';
DELETE FROM compression_cache_stats WHERE provider = 'vertex-partner';
UPDATE OR IGNORE hourly_usage_summary SET provider = 'vertex' WHERE provider = 'vertex-partner';
DELETE FROM hourly_usage_summary WHERE provider = 'vertex-partner';
UPDATE OR IGNORE daily_usage_summary SET provider = 'vertex' WHERE provider = 'vertex-partner';
DELETE FROM daily_usage_summary WHERE provider = 'vertex-partner';
UPDATE OR IGNORE session_account_affinity SET provider = 'vertex' WHERE provider = 'vertex-partner';
DELETE FROM session_account_affinity WHERE provider = 'vertex-partner';
UPDATE OR IGNORE tier_assignments SET provider = 'vertex' WHERE provider = 'vertex-partner';
DELETE FROM tier_assignments WHERE provider = 'vertex-partner';
UPDATE OR IGNORE session_model_history SET provider = 'vertex' WHERE provider = 'vertex-partner';
DELETE FROM session_model_history WHERE provider = 'vertex-partner';
UPDATE OR IGNORE group_model_permissions SET provider = 'vertex' WHERE provider = 'vertex-partner';
DELETE FROM group_model_permissions WHERE provider = 'vertex-partner';
UPDATE OR IGNORE provider_plans SET provider = 'vertex' WHERE provider = 'vertex-partner';
DELETE FROM provider_plans WHERE provider = 'vertex-partner';
UPDATE OR IGNORE provider_quota_reset_events SET provider = 'vertex' WHERE provider = 'vertex-partner';
DELETE FROM provider_quota_reset_events WHERE provider = 'vertex-partner';
UPDATE OR IGNORE model_context_overrides SET provider = 'vertex' WHERE provider = 'vertex-partner';
DELETE FROM model_context_overrides WHERE provider = 'vertex-partner';
UPDATE OR IGNORE model_capability_overrides SET provider = 'vertex' WHERE provider = 'vertex-partner';
DELETE FROM model_capability_overrides WHERE provider = 'vertex-partner';
UPDATE OR IGNORE combo_adaptation_state SET provider_id = 'vertex' WHERE provider_id = 'vertex-partner';
DELETE FROM combo_adaptation_state WHERE provider_id = 'vertex-partner';
UPDATE OR IGNORE upstream_proxy_config SET provider_id = 'vertex' WHERE provider_id = 'vertex-partner';
DELETE FROM upstream_proxy_config WHERE provider_id = 'vertex-partner';
UPDATE OR IGNORE cloud_agent_credentials SET provider_id = 'vertex' WHERE provider_id = 'vertex-partner';
DELETE FROM cloud_agent_credentials WHERE provider_id = 'vertex-partner';
UPDATE OR IGNORE discovery_results SET provider_id = 'vertex' WHERE provider_id = 'vertex-partner';
DELETE FROM discovery_results WHERE provider_id = 'vertex-partner';
DELETE FROM key_value WHERE namespace = 'lkgp' AND (key LIKE '%vertex-partner%' OR value LIKE '%"vertex-partner"%');

-- qianfan -> baidu
UPDATE OR IGNORE provider_connections SET provider = 'baidu' WHERE provider = 'qianfan';
DELETE FROM provider_connections WHERE provider = 'qianfan';
UPDATE OR IGNORE provider_connections SET provider = 'baidu' WHERE provider = 'qianfan';
DELETE FROM provider_connections WHERE provider = 'qianfan';
UPDATE OR IGNORE usage_history SET provider = 'baidu' WHERE provider = 'qianfan';
DELETE FROM usage_history WHERE provider = 'qianfan';
UPDATE OR IGNORE call_logs SET provider = 'baidu' WHERE provider = 'qianfan';
DELETE FROM call_logs WHERE provider = 'qianfan';
UPDATE OR IGNORE proxy_logs SET provider = 'baidu' WHERE provider = 'qianfan';
DELETE FROM proxy_logs WHERE provider = 'qianfan';
UPDATE OR IGNORE quota_snapshots SET provider = 'baidu' WHERE provider = 'qianfan';
DELETE FROM quota_snapshots WHERE provider = 'qianfan';
UPDATE OR IGNORE request_detail_logs SET provider = 'baidu' WHERE provider = 'qianfan';
DELETE FROM request_detail_logs WHERE provider = 'qianfan';
UPDATE OR IGNORE registered_keys SET provider = 'baidu' WHERE provider = 'qianfan';
DELETE FROM registered_keys WHERE provider = 'qianfan';
UPDATE OR IGNORE provider_key_limits SET provider = 'baidu' WHERE provider = 'qianfan';
DELETE FROM provider_key_limits WHERE provider = 'qianfan';
UPDATE OR IGNORE reasoning_cache SET provider = 'baidu' WHERE provider = 'qianfan';
DELETE FROM reasoning_cache WHERE provider = 'qianfan';
UPDATE OR IGNORE compression_analytics SET provider = 'baidu' WHERE provider = 'qianfan';
DELETE FROM compression_analytics WHERE provider = 'qianfan';
UPDATE OR IGNORE compression_cache_stats SET provider = 'baidu' WHERE provider = 'qianfan';
DELETE FROM compression_cache_stats WHERE provider = 'qianfan';
UPDATE OR IGNORE hourly_usage_summary SET provider = 'baidu' WHERE provider = 'qianfan';
DELETE FROM hourly_usage_summary WHERE provider = 'qianfan';
UPDATE OR IGNORE daily_usage_summary SET provider = 'baidu' WHERE provider = 'qianfan';
DELETE FROM daily_usage_summary WHERE provider = 'qianfan';
UPDATE OR IGNORE session_account_affinity SET provider = 'baidu' WHERE provider = 'qianfan';
DELETE FROM session_account_affinity WHERE provider = 'qianfan';
UPDATE OR IGNORE tier_assignments SET provider = 'baidu' WHERE provider = 'qianfan';
DELETE FROM tier_assignments WHERE provider = 'qianfan';
UPDATE OR IGNORE session_model_history SET provider = 'baidu' WHERE provider = 'qianfan';
DELETE FROM session_model_history WHERE provider = 'qianfan';
UPDATE OR IGNORE group_model_permissions SET provider = 'baidu' WHERE provider = 'qianfan';
DELETE FROM group_model_permissions WHERE provider = 'qianfan';
UPDATE OR IGNORE provider_plans SET provider = 'baidu' WHERE provider = 'qianfan';
DELETE FROM provider_plans WHERE provider = 'qianfan';
UPDATE OR IGNORE provider_quota_reset_events SET provider = 'baidu' WHERE provider = 'qianfan';
DELETE FROM provider_quota_reset_events WHERE provider = 'qianfan';
UPDATE OR IGNORE model_context_overrides SET provider = 'baidu' WHERE provider = 'qianfan';
DELETE FROM model_context_overrides WHERE provider = 'qianfan';
UPDATE OR IGNORE model_capability_overrides SET provider = 'baidu' WHERE provider = 'qianfan';
DELETE FROM model_capability_overrides WHERE provider = 'qianfan';
UPDATE OR IGNORE combo_adaptation_state SET provider_id = 'baidu' WHERE provider_id = 'qianfan';
DELETE FROM combo_adaptation_state WHERE provider_id = 'qianfan';
UPDATE OR IGNORE upstream_proxy_config SET provider_id = 'baidu' WHERE provider_id = 'qianfan';
DELETE FROM upstream_proxy_config WHERE provider_id = 'qianfan';
UPDATE OR IGNORE cloud_agent_credentials SET provider_id = 'baidu' WHERE provider_id = 'qianfan';
DELETE FROM cloud_agent_credentials WHERE provider_id = 'qianfan';
UPDATE OR IGNORE discovery_results SET provider_id = 'baidu' WHERE provider_id = 'qianfan';
DELETE FROM discovery_results WHERE provider_id = 'qianfan';
DELETE FROM key_value WHERE namespace = 'lkgp' AND (key LIKE '%qianfan%' OR value LIKE '%"qianfan"%');
