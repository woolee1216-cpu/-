-- ══════════════════════════════════════════════════════════════
-- 거래처 탭 공유 스키마 (타이어핑 봇 V1)
-- 기존 테이블 있으면 먼저:
--   DROP TABLE IF EXISTS biz_assign; DROP TABLE IF EXISTS biz_tabs;
-- 그 다음 이 파일 전체 실행
-- ══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS biz_tabs (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  position   INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE biz_tabs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "biz_tabs_all" ON biz_tabs;
CREATE POLICY "biz_tabs_all" ON biz_tabs USING (true) WITH CHECK (true);

-- snapshot: 배정 당시 상품 정보 저장 → 검색 없이 상시 표시용
CREATE TABLE IF NOT EXISTS biz_assign (
  biz_key    TEXT NOT NULL,
  tab_id     TEXT NOT NULL REFERENCES biz_tabs(id) ON DELETE CASCADE,
  snapshot   JSONB,          -- 제조사·제품명·사이즈·가격 등 상품 스냅샷
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (biz_key, tab_id)
);
ALTER TABLE biz_assign ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "biz_assign_all" ON biz_assign;
CREATE POLICY "biz_assign_all" ON biz_assign USING (true) WITH CHECK (true);

-- 기존 테이블에 snapshot 컬럼만 추가하려면:
-- ALTER TABLE biz_assign ADD COLUMN IF NOT EXISTS snapshot JSONB;
