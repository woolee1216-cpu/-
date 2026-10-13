-- ══════════════════════════════════════════════════════════════
-- 마진 탭 공유 스키마 (타이어핑 봇 V2)
-- Supabase SQL 편집기에 그대로 붙여넣어 실행하세요.
-- ══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS margin_tabs (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  position      INTEGER NOT NULL DEFAULT 0,
  is_exception  BOOLEAN NOT NULL DEFAULT FALSE, -- 예외탭 여부(사이즈까지 포함 매칭, 최우선 적용)
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE margin_tabs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "margin_tabs_all" ON margin_tabs;
CREATE POLICY "margin_tabs_all" ON margin_tabs USING (true) WITH CHECK (true);

CREATE TABLE IF NOT EXISTS margin_rules (
  id               TEXT PRIMARY KEY,
  tab_id           TEXT NOT NULL REFERENCES margin_tabs(id) ON DELETE CASCADE,
  manufacturer     TEXT NOT NULL,
  product_contains TEXT NOT NULL,
  size_contains    TEXT,        -- 사이즈(포함) — 예외탭에서만 사용, 선택사항
  detail_contains  TEXT,        -- 세부정보(포함) — 선택사항, 비어있으면 검사 안 함
  dot              TEXT,        -- DOT(생산년도, 정확히 일치) — 예외탭에서만 사용, 선택사항
  discount_pct     NUMERIC NOT NULL DEFAULT 0,  -- 인치기준 미사용시 기본 할인율, 사용시 "미만" 구간 할인율
  cost_override    NUMERIC,
  inch_threshold      INTEGER, -- 인치 기준값(선택, 예: 18) — 이 값 이상이면 discount_pct_above 적용
  discount_pct_above  NUMERIC, -- 기준인치 "이상"일 때 적용할 할인율(선택)
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE margin_rules ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "margin_rules_all" ON margin_rules;
CREATE POLICY "margin_rules_all" ON margin_rules USING (true) WITH CHECK (true);

-- 기존 테이블에 컬럼만 추가하려면:
-- ALTER TABLE margin_tabs ADD COLUMN IF NOT EXISTS is_exception BOOLEAN NOT NULL DEFAULT FALSE;
-- ALTER TABLE margin_rules ADD COLUMN IF NOT EXISTS size_contains TEXT;
-- ALTER TABLE margin_rules ADD COLUMN IF NOT EXISTS dot TEXT;
-- ALTER TABLE margin_rules ADD COLUMN IF NOT EXISTS inch_threshold INTEGER;
-- ALTER TABLE margin_rules ADD COLUMN IF NOT EXISTS discount_pct_above NUMERIC;
