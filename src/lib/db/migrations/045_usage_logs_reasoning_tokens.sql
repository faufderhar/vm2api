-- 045_usage_logs_reasoning_tokens — reasoning tokens the upstream reported.
-- OpenAI-shaped usage (Grok, Codex) carries them in output_tokens_details /
-- completion_tokens_details.reasoning_tokens. They are a subset of output_tokens,
-- so billing and token totals are unchanged; the column is for visibility only.
-- Historical rows and providers that do not report it stay NULL.

ALTER TABLE usage_logs ADD COLUMN reasoning_tokens INTEGER;
