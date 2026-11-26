-- grok-4.7 left the Grok account catalog (grok models lists grok-4.6 and grok-4.5). Existing installations move their Grok
-- catalog entry and profiles to grok-4.6 in place: profile ids stay, so policy chains keep pointing at them, and the revision
-- moves for optimistic concurrency. Idempotent: every statement only touches rows still on grok-4.7.
INSERT INTO ac_model_catalog(provider, model, efforts, roles, source)
SELECT provider, 'grok-4.6', efforts, roles, 'migration://123_grok_model_4_6'
FROM ac_model_catalog WHERE provider = 'grok' AND model = 'grok-4.7'
ON CONFLICT (provider, model) DO UPDATE SET
  efforts = ARRAY(SELECT DISTINCT e FROM unnest(ac_model_catalog.efforts || excluded.efforts) e ORDER BY e),
  roles = ARRAY(SELECT DISTINCT r FROM unnest(ac_model_catalog.roles || excluded.roles) r ORDER BY r);

UPDATE ac_profiles p SET model = 'grok-4.6', revision = p.revision + 1
FROM ac_accounts a WHERE a.id = p.account_id AND a.provider = 'grok' AND p.model = 'grok-4.7';

DELETE FROM ac_model_catalog WHERE provider = 'grok' AND model = 'grok-4.7'
  AND NOT EXISTS (SELECT 1 FROM ac_profiles p JOIN ac_accounts a ON a.id = p.account_id WHERE a.provider = 'grok' AND p.model = 'grok-4.7');
