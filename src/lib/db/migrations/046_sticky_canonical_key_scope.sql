-- 046_sticky_canonical_key_scope — canonical session / device / family rows
-- are scoped to the managed key (k<id>:sess:, k<id>:dev2:, k<id>:family2:).
-- The unscoped rows written before do not record which key bound them, so no
-- key can prove it owns one. They are dropped once: each live conversation
-- picks a VM again on its next turn, and the operator key (still unscoped)
-- never lands on a pin a tenant left behind. Legacy p:<platform>:k<id>: rows
-- are untouched and still migrate onto their own key's canonical row.

DELETE FROM sticky_sessions
WHERE key LIKE 'sess:%'
  OR key LIKE 'dev2:%'
  OR key LIKE 'family2:%';
