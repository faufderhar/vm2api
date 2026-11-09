-- 047_api_key_limits_managed — a key whose limits an admin set for a tenant.
-- The tenant keeps using, renaming and rotating the key, but cannot raise its quota, rate
-- limits or expiry. Existing rows stay 0: nothing records who set their limits. An admin
-- edit of a tenant key's limits sets the flag.

ALTER TABLE api_keys ADD COLUMN limits_managed INTEGER NOT NULL DEFAULT 0;
