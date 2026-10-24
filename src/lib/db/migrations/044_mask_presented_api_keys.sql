-- 044_mask_presented_api_keys — failed-auth rows stored the token the client sent, up to
-- 240 characters. A valid key over quota, disabled or rate limited lands there too, so
-- old rows held whole working keys. Keep only the first 8 and last 4 characters, the
-- same form presentedApiKeyForLog writes now. Debug records carry a copy of the summary.

UPDATE usage_logs
SET api_key_presented = CASE
  WHEN length(api_key_presented) > 16 THEN substr(api_key_presented, 1, 8) || '…' || substr(api_key_presented, -4)
  ELSE '…'
END
WHERE api_key_presented IS NOT NULL
  AND api_key_presented <> ''
  AND instr(api_key_presented, '…') = 0;

UPDATE request_log_debug
SET record_json = json_set(
  record_json,
  '$.api_key_presented',
  CASE
    WHEN length(json_extract(record_json, '$.api_key_presented')) > 16
      THEN substr(json_extract(record_json, '$.api_key_presented'), 1, 8) || '…'
        || substr(json_extract(record_json, '$.api_key_presented'), -4)
    ELSE '…'
  END
)
WHERE json_valid(record_json)
  AND json_type(record_json, '$.api_key_presented') = 'text'
  AND json_extract(record_json, '$.api_key_presented') <> ''
  AND instr(json_extract(record_json, '$.api_key_presented'), '…') = 0;
