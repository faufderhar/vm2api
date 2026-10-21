-- 041_usage_logs_inbound_device — client device id captured before outbound rewrite.
-- Source: metadata.user_id.device_id, body device_id, or x-kin-device-id.
-- Absent on the inbound request stays NULL. Historical rows stay NULL.

ALTER TABLE usage_logs ADD COLUMN inbound_device_id TEXT;
CREATE INDEX IF NOT EXISTS idx_usage_logs_inbound_device ON usage_logs(inbound_device_id, created_at);
