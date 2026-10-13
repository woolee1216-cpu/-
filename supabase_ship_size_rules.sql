-- ══════════════════════════════════════════════════════════════
-- 사이즈별 택배비 공유 스키마 (타이어핑 봇 V2)
-- Supabase SQL 편집기에 그대로 붙여넣어 실행하세요.
-- ══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS ship_size_rules (
  id           TEXT PRIMARY KEY,
  size         TEXT NOT NULL,
  price        NUMERIC NOT NULL DEFAULT 0,
  bundle       BOOLEAN NOT NULL DEFAULT FALSE,
  bundle_price NUMERIC NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE ship_size_rules ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ship_size_rules_all" ON ship_size_rules;
CREATE POLICY "ship_size_rules_all" ON ship_size_rules USING (true) WITH CHECK (true);
