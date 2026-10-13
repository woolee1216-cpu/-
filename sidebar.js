// 타이어핑 최저가 봇 - sidebar.js

const BASE = "https://www.tireping.com";

// ── Supabase (거래처 탭 실시간 공유에 사용)
const SUPABASE_URL      = "https://yhhsqyknhcxvnaehamxy.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InloaHNxeWtuaGN4dm5hZWhhbXh5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ0OTkwNzYsImV4cCI6MjEwMDA3NTA3Nn0.WucsHv9iqVA1rzgkjfnfwCpMdpNrDUQYVINVe53Ls1c";

// Supabase REST 호출 래퍼 (anon key로 직접 호출 — 거래처탭은 RLS 공개)
async function supaFetch(path, opts = {}) {
  return fetch(`${SUPABASE_URL}${path}`, {
    ...opts,
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });
}

// ── 전역 상태
let allProducts   = [];
let _searchToken  = 0; // 연속검색 시 이전 rAF 콜백이 현재 loading 건드리지 못하게
let shownProducts = [];
let filterState   = {};   // {colName: Set(값)}
let quickFilter   = "";   // 결과 내 검색 (전역 텍스트 필터)
let sortCol       = null;
let sortRev       = false;

// 결과 내 검색: 입력 단어가 모두(AND) 들어간 행만 통과
// 대상 컬럼: 제조사·제품명·사이즈·세부정보·DOT·경쟁판매점
// 사이즈는 띄어쓰기/구분자 무시하고 비교 (245 45 18 ↔ 2454518 ↔ 245/45R18)
function _matchesQuick(p, q) {
  if (!q) return true;
  const sizeNorm = String(p.size || "").toLowerCase().replace(/[^0-9a-z]/g, "");
  const hay = [
    p.manufacturer, p.product, p.size, p.detail, p.dot, p.lowest_seller,
  ].map(v => String(v ?? "").toLowerCase()).join(" ") + " " + sizeNorm;
  // 공백으로 나눈 모든 토큰이 포함돼야 통과 (AND). 숫자만 있는 토큰은 사이즈 정규화본과도 비교
  return q.split(/\s+/).filter(Boolean).every(tok => {
    if (hay.includes(tok)) return true;
    const t = tok.replace(/[^0-9a-z]/g, "");
    return t && (hay.includes(t) || sizeNorm.includes(t));
  });
}

// ── 즐겨찾기 (favorites) ─────────────────────────────────────
let viewMode    = "search";   // "search" | "fav" | "mine" — 현재 표가 검색결과/즐겨찾기/내판매현황인지
let favData     = {};         // favKey → 상품 스냅샷 (계정별 저장)
let _savedSearch = null;      // 즐겨찾기 진입 전 검색결과 백업 {all, shown}
let _favSaveTimer = null;
let _favAcct      = null;     // 현재 favData가 로드된 계정 (변경 감지용)
let _favLastStarIdx = null;   // Shift+클릭 범위선택용: 마지막으로 별표 클릭한 행의 shownProducts 인덱스

// 행 고유키: tireIdxMap과 동일한 규칙 (tire_id + dot)
function _favKey(p) { return `${p.tire_id || ""}__${p.dot || ""}`; }
function isFav(p) { return !!(p && p.tire_id && favData[_favKey(p)]); }

function _favStoreKey() { return myStoreId ? `favorites__${myStoreId}` : "favorites"; }

// 로컬 + sync 동시 보관:
//  - 로컬(빠름)을 주 저장소로 사용
//  - sync(크롬 계정)에는 백업 → 확장 삭제/재설치 후에도 복원됨
//    (단, sync 8KB/item 제한 때문에 압축 후 청크로 나눠 저장)
let _favSyncTimer = null;
const _FAV_SYNC_CHUNK = 2000; // 글자수 기준 (한글 3바이트 고려해 8KB 미만 보장)

// 동기화 용량 절약: 렌더/자동재고에 필요한 필드만 남김
function _favCompact(data) {
  const KEEP = ["tire_id","dot","manufacturer","product","size","detail","pid","is_mine",
                "my_price","my_stock","factory_price","dc_rate","market_lowest","market_stock",
                "lowest_price","second_price","lowest_seller","my_rank","is_soldout"];
  const out = {};
  for (const key in data) {
    const f = data[key] || {}; const o = {};
    for (const kk of KEEP) if (f[kk] !== undefined) o[kk] = f[kk];
    out[key] = o;
  }
  return out;
}
function _favSyncBase() { return `favsync_${myStoreId || "_"}`; }

function saveFavToSync() {
  const base = _favSyncBase();
  let json;
  try { json = JSON.stringify(_favCompact(favData)); } catch (e) { return; }
  const chunks = [];
  for (let i = 0; i < json.length; i += _FAV_SYNC_CHUNK) chunks.push(json.slice(i, i + _FAV_SYNC_CHUNK));
  const obj = { [`${base}_meta`]: { n: chunks.length, ts: Date.now() } };
  chunks.forEach((c, i) => { obj[`${base}_${i}`] = c; });
  chrome.storage.sync.get(null, all => {
    // 이전에 더 많던 청크 잔재 제거
    const stale = Object.keys(all).filter(k => k.startsWith(base + "_") && k !== `${base}_meta` && !(k in obj));
    chrome.storage.sync.set(obj, () => {
      if (chrome.runtime.lastError) {
        console.warn("[즐겨찾기 sync 백업 실패]", chrome.runtime.lastError.message);
        return;
      }
      if (stale.length) chrome.storage.sync.remove(stale);
    });
  });
}
function loadFavFromSync() {
  return new Promise(resolve => {
    const base = _favSyncBase();
    chrome.storage.sync.get(null, all => {
      const meta = all[`${base}_meta`];
      if (!meta || !meta.n) return resolve(null);
      let json = "";
      for (let i = 0; i < meta.n; i++) json += all[`${base}_${i}`] || "";
      try { resolve(JSON.parse(json)); } catch (e) { resolve(null); }
    });
  });
}

async function loadFavorites() {
  const k = _favStoreKey();
  const local = await new Promise(r => chrome.storage.local.get(k, d => r(d[k] || null)));
  if (local && Object.keys(local).length) { favData = local; return; }
  // 로컬이 비어있음(재설치/초기화 가능성) → sync 백업에서 복원
  const fromSync = await loadFavFromSync();
  if (fromSync && Object.keys(fromSync).length) {
    favData = fromSync;
    chrome.storage.local.set({ [k]: favData }); // 로컬에 다시 깔아둠
    console.log("[즐겨찾기] sync 백업에서 복원:", Object.keys(favData).length, "개");
  } else {
    favData = {};
  }
}
function saveFavorites() {
  const k = _favStoreKey();
  clearTimeout(_favSaveTimer);
  _favSaveTimer = setTimeout(() => {
    chrome.storage.local.set({ [k]: favData }, () => {});
  }, 200);
  // sync 백업은 더 느슨하게 (쓰기 횟수 제한 보호)
  clearTimeout(_favSyncTimer);
  _favSyncTimer = setTimeout(saveFavToSync, 3000);
}

// 렌더에 필요한 필드만 복사 (_로 시작하는 임시 필드 제외)
function _favSnapshot(p) {
  const o = {};
  for (const key in p) { if (key[0] !== "_") o[key] = p[key]; }
  o._favAt = Date.now();
  return o;
}
function toggleFav(p) {
  if (!p || !p.tire_id) return;
  const key = _favKey(p);
  if (favData[key]) delete favData[key];
  else favData[key] = _favSnapshot(p);
  saveFavorites();
  updateFavCount();
}
// 검색결과에 즐겨찾기 상품이 있으면 스냅샷을 최신 데이터로 갱신
function syncFavSnapshots(products) {
  let dirty = false;
  for (const p of products) {
    const key = _favKey(p);
    if (favData[key]) { favData[key] = _favSnapshot(p); dirty = true; }
  }
  if (dirty) saveFavorites();
}
function updateFavCount() {
  const n = Object.keys(favData).length;
  const btn = document.querySelector('.tab-btn[data-tab="fav"]');
  if (btn) btn.textContent = n ? `⭐ 즐겨찾기 (${n})` : "⭐ 즐겨찾기";
}

// 즐겨찾기 보기 진입: 검색결과+필터 백업 후 표를 즐겨찾기로 교체 (필터는 초기화)
// 즐겨찾기/내판매현황 등에서 출고(당일/익일)·출고시간 정보를 백그라운드로 최신화 (거래처 탭 새로고침과 동일한 방식)
// 즐겨찾기·판매현황은 스냅샷/이전 검색결과 데이터를 그대로 보여줄 때가 많아서 출고 상태가 실제와 다르게 보일 수 있음
let _sendInfoHydrateToken = 0;
async function _hydrateSendInfoForVisible(products, stillActive) {
  const myToken = ++_sendInfoHydrateToken;
  const targets = products.filter(p => p.is_mine && p.pid);
  if (!targets.length) return;
  for (let i = 0; i < targets.length; i += 5) {
    if (myToken !== _sendInfoHydrateToken || !stillActive()) return;
    await Promise.all(targets.slice(i, i + 5).map(async p => {
      try {
        const info = await fetchMySendInfo(p.pid);
        if (info) { p.send_kind = info.send_kind; p.send_time = info.send_time; }
      } catch(e) { /* 개별 조회 실패는 무시하고 나머지는 계속 진행 */ }
      if (p._cacheKey) { _rowCache.delete(p._cacheKey); p._cacheKey = ""; }
      refreshRowByTireId(p.tire_id, p.dot);
    }));
  }
}

function enterFavView() {
  if (viewMode === "fav") return;
  viewMode = "fav";
  // mine 보기에서 바로 넘어온 경우를 대비해 mine 전용 UI는 항상 정리 (leaveMineView를 거치지 않는 경로가 있었음)
  $("mine-mfr-bar").style.display = "none";
  $("biz-tab-bar").style.display = "none";
  $("price-mfr-bar").style.display = "none";
  $("table-wrap")?.classList.remove("mine-mode");
  _favLastStarIdx = null; // 표가 바뀌므로 범위선택 기준 초기화
  _savedSearch = { all: allProducts, shown: shownProducts, filter: filterState, quick: quickFilter };
  filterState = {}; quickFilter = "";
  const qi = $("inp-quick-filter"); if (qi) qi.value = "";
  checkedSet.clear();
  allProducts = Object.values(favData);
  _lastFilterKey = ""; applyFilters._ref = null; _rowCache.clear();
  applyFilters();
  updateFilterLabel();
  const _asb = $("fav-autostock-bar"); if (_asb) _asb.style.display = "flex";
  renderAutoStockStatus();
  st(`⭐ 즐겨찾기 ${allProducts.length}개 — ★ 클릭으로 해제`);
  _hydrateSendInfoForVisible(allProducts, () => viewMode === "fav");
}
// 검색 보기로 복귀: 백업된 검색결과+필터 복원
function enterSearchView() {
  if (viewMode === "search") return;
  viewMode = "search";
  // mine/fav 보기에서 바로 넘어온 경우를 대비해 mine 전용 UI는 항상 정리
  $("mine-mfr-bar").style.display = "none";
  $("biz-tab-bar").style.display = "none";
  $("table-wrap")?.classList.remove("mine-mode");
  _sendInfoHydrateToken++; // 진행 중이던 즐겨찾기 출고정보 조회 중단
  _favLastStarIdx = null; // 표가 바뀌므로 범위선택 기준 초기화
  checkedSet.clear();
  if (_savedSearch) {
    allProducts = _savedSearch.all; shownProducts = _savedSearch.shown;
    filterState = _savedSearch.filter || {}; quickFilter = _savedSearch.quick || "";
    const qi = $("inp-quick-filter"); if (qi) qi.value = quickFilter;
  }
  _lastFilterKey = ""; applyFilters._ref = null; _rowCache.clear();
  applyFilters();
  updateFilterLabel();
  _updatePriceMfrTabs();
  const _asb = $("fav-autostock-bar"); if (_asb) _asb.style.display = "none";
  const _asl = $("fav-as-log"); if (_asl) _asl.style.display = "none";
}
// 즐겨찾기 보기 중일 때 표를 favData로 다시 그림 (해제 즉시 반영)
function refreshFavViewIfActive() {
  if (viewMode !== "fav") return;
  allProducts = Object.values(favData);
  _lastFilterKey = ""; applyFilters._ref = null;
  applyFilters();
}

// ── 거래처 탭 (로컬 우선 + Supabase 동기화) ──────────────────
// 키: tire_id__dot (= favKey) — pid 없어도 DOT별로 정확히 구분
// bizData.products: bizKey → 상품 스냅샷 (검색 없이 상시 표시용)
let bizData = { tabs: [], assign: {}, products: {} };
let _activeBizTabId = null;

// ── 키 함수 ────────────────────────────────────────
function _bizKey(p) { return `${p.tire_id||""}__${p.dot||""}`; }

// ── 로컬 저장/로드 ─────────────────────────────────
function _bizLocalKey() { return "bizData_v2"; }
function _saveBizLocal() {
  chrome.storage.local.set({ [_bizLocalKey()]: bizData });
}
async function _loadBizLocal() {
  return new Promise(r => chrome.storage.local.get(_bizLocalKey(), d => r(d[_bizLocalKey()] || null)));
}

// ── Supabase 상태 표시 헬퍼 ─────────────────────────
async function _bizSupaErr(r, label) {
  let msg = "";
  try { const j = await r.clone().json(); msg = j?.message || j?.hint || ""; } catch(_) {}
  if (r.status === 404 || msg.includes("does not exist")) {
    return `${label} 실패: 테이블 없음 → Supabase SQL 편집기에서 supabase_biz_tabs.sql 실행 필요`;
  }
  return `${label} 실패(${r.status})${msg ? ": " + msg : ""}`;
}

// ── 로드: 로컬 먼저 즉시 적용 → Supabase로 최신화 ──
async function loadBizData() {
  // 1. 로컬 캐시 즉시 적용
  const local = await _loadBizLocal();
  if (local) bizData = local;

  // 2. Supabase에서 최신 탭 + 배정 로드
  try {
    const [tabsR, assignR] = await Promise.all([
      supaFetch("/rest/v1/biz_tabs?select=*&order=position.asc,created_at.asc"),
      supaFetch("/rest/v1/biz_assign?select=biz_key,tab_id,snapshot"),
    ]);
    if (!tabsR.ok) {
      const msg = await _bizSupaErr(tabsR, "거래처 탭 로드");
      if (typeof st === "function") st("⚠️ " + msg);
      return;
    }
    if (!assignR.ok) {
      const msg = await _bizSupaErr(assignR, "거래처 배정 로드");
      if (typeof st === "function") st("⚠️ " + msg);
      return;
    }
    const tabs    = await tabsR.json();
    const assigns = await assignR.json();
    bizData.tabs     = tabs.map(t => ({ id: t.id, name: t.name }));
    bizData.assign   = {};
    bizData.products = {};
    for (const a of assigns) {
      if (!bizData.assign[a.biz_key]) bizData.assign[a.biz_key] = [];
      bizData.assign[a.biz_key].push(a.tab_id);
      if (a.snapshot) bizData.products[a.biz_key] = a.snapshot; // 스냅샷 저장 → 검색 없이 표시
    }
    _saveBizLocal();
    console.log("[거래처] Supabase 로드 완료:", bizData.tabs.length, "탭,", assigns.length, "배정");
  } catch(e) {
    console.warn("[거래처] Supabase 연결 오류:", e.message);
    if (typeof st === "function") st("⚠️ 거래처 Supabase 연결 오류: " + e.message);
  }
}

// ── 탭 추가 ────────────────────────────────────────
async function addBizTab(name) {
  if (!name?.trim()) return;
  const id = "bt_" + Date.now();
  bizData.tabs.push({ id, name: name.trim() });
  _saveBizLocal();
  _renderBizTabBar();
  // Supabase 비동기 저장 — 실패 시 화면에 표시
  try {
    const r = await supaFetch("/rest/v1/biz_tabs", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({ id, name: name.trim(), position: bizData.tabs.length - 1 }),
    });
    if (!r.ok) {
      let errMsg = ""; try { const j = await r.json(); errMsg = j?.message || j?.hint || ""; } catch(_) {}
      st(`⚠️ 거래처 탭 서버 저장 실패(${r.status}): ${errMsg || "테이블 없음 — supabase_biz_tabs.sql 실행 필요"}`);
    } else {
      console.log("[거래처] 탭 Supabase 저장 완료:", name);
    }
  } catch(e) { st("⚠️ 거래처 탭 서버 저장 실패: " + e.message); }
  return id;
}

// ── 탭 삭제 ────────────────────────────────────────
async function deleteBizTab(id) {
  bizData.tabs = bizData.tabs.filter(t => t.id !== id);
  for (const k in bizData.assign) {
    bizData.assign[k] = bizData.assign[k].filter(tid => tid !== id);
    if (!bizData.assign[k].length) delete bizData.assign[k];
  }
  if (_activeBizTabId === id) { _activeBizTabId = null; _renderMineView(); }
  _saveBizLocal(); _renderBizTabBar();
  try {
    await supaFetch(`/rest/v1/biz_tabs?id=eq.${encodeURIComponent(id)}`, { method: "DELETE" });
  } catch(e) { console.warn("[거래처] 탭 삭제 Supabase 실패:", e.message); }
}

// ── 탭 이름 변경 ───────────────────────────────────
async function renameBizTab(id, newName) {
  const t = bizData.tabs.find(t => t.id === id);
  if (!t || !newName.trim()) return;
  t.name = newName.trim();
  _saveBizLocal(); _renderBizTabBar();
  try {
    await supaFetch(`/rest/v1/biz_tabs?id=eq.${encodeURIComponent(id)}`, {
      method: "PATCH", body: JSON.stringify({ name: newName.trim() }),
    });
  } catch(e) { console.warn("[거래처] 이름변경 Supabase 실패:", e.message); }
}

// ── 상품 배정 토글 ─────────────────────────────────
// key: tire_id__dot (pid 불필요, DOT별 정확히 구분)
async function toggleBizAssign(bizKeyOrP, tabId) {
  const key = (typeof bizKeyOrP === "object") ? _bizKey(bizKeyOrP) : String(bizKeyOrP);
  if (!key || key === "__") return;

  // 스냅샷: 배정 시 상품 정보 저장 (검색 없이 상시 표시용)
  // _mineAllProducts(내 판매현황 캐시)뿐 아니라 현재 표시중인 shownProducts(검색결과)에서도 찾음
  const srcP = (typeof bizKeyOrP === "object") ? bizKeyOrP
    : (_mineAllProducts?.find(x => _bizKey(x) === key)
       || shownProducts?.find(x => _bizKey(x) === key)
       || allProducts?.find(x => _bizKey(x) === key));
  const snap = srcP ? {
    tire_id: srcP.tire_id, dot: srcP.dot, pid: srcP.pid||null,
    manufacturer: srcP.manufacturer||"", product: srcP.product||"",
    size: srcP.size||"", detail: srcP.detail||"",
    my_price: srcP.my_price||0, my_stock: srcP.my_stock||0,
    factory_price: srcP.factory_price||0, dc_rate: srcP.dc_rate||0,
    is_soldout: !!srcP.is_soldout, is_mine: true,
    send_kind: srcP.send_kind, send_time: srcP.send_time||"",
  } : null;

  const arr = bizData.assign[key] ? [...bizData.assign[key]] : [];
  const idx = arr.indexOf(tabId);
  const removing = idx !== -1;
  if (removing) arr.splice(idx, 1); else arr.push(tabId);
  if (arr.length) bizData.assign[key] = arr; else delete bizData.assign[key];
  // 스냅샷도 로컬에 저장 (배정 해제해도 다른 탭에 있으면 유지)
  if (!removing && snap) bizData.products[key] = snap;
  else if (removing && !arr.length) delete bizData.products[key]; // 모든 탭에서 해제 시 삭제
  _saveBizLocal();

  const p = _mineAllProducts?.find(x => _bizKey(x) === key)
    || shownProducts?.find(x => _bizKey(x) === key)
    || allProducts?.find(x => _bizKey(x) === key);
  if (p && p._cacheKey) { _rowCache.delete(p._cacheKey); p._cacheKey = ""; refreshRow(p); }
  _renderBizTabBar();

  // Supabase 동기화 (스냅샷 포함)
  try {
    let r;
    if (removing) {
      r = await supaFetch(
        `/rest/v1/biz_assign?biz_key=eq.${encodeURIComponent(key)}&tab_id=eq.${encodeURIComponent(tabId)}`,
        { method: "DELETE" }
      );
    } else {
      r = await supaFetch("/rest/v1/biz_assign", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({ biz_key: key, tab_id: tabId, snapshot: snap }),
      });
    }
    if (!r.ok) st("⚠️ " + await _bizSupaErr(r, "거래처 배정"));
  } catch(e) { st("⚠️ 거래처 배정 서버 저장 실패: " + e.message); }
}

// ── 배정 개수 (행 아이콘용) ────────────────────────
function getBizCount(p) { return bizData.assign?.[_bizKey(p)]?.length || 0; }

// ── 거래처 탭 바 렌더 ──────────────────────────────
function _renderBizTabBar() {
  const bar = $("biz-tab-bar");
  if (!bar) return;
  const cnt = (id) => _mineAllProducts
    ? _mineAllProducts.filter(p => bizData.assign?.[_bizKey(p)]?.includes(id)).length : 0;
  const all = `<button class="biz-tab-btn${!_activeBizTabId ? " active" : ""}" data-bid="">전체 (${_mineAllProducts?.length||0})</button>`;
  const tabs = bizData.tabs.map(t =>
    `<button class="biz-tab-btn${_activeBizTabId === t.id ? " active" : ""}" data-bid="${t.id}" title="우클릭: 이름변경/삭제">${escHtml(t.name)} (${cnt(t.id)})</button>`
  ).join("");
  const add = `<button class="biz-tab-btn biz-add" id="biz-tab-add-btn">+ 탭 추가</button>`;
  const noTabs = !bizData.tabs.length ? `<span style="color:#9ca3af;font-size:10px;margin-left:4px;">탭 없음 — + 탭 추가로 만드세요</span>` : "";
  const refresh = `<button class="btn-gray btn-sm" id="biz-refresh-btn" title="서버에서 최신 데이터 가져오기" style="margin-left:auto;">🔄</button>`;
  bar.innerHTML = `<span style="color:#15803d;font-weight:bold;white-space:nowrap;margin-right:4px;font-size:11px;">거래처</span>${all}${tabs}${noTabs}${add}${refresh}`;

  bar.querySelectorAll(".biz-tab-btn[data-bid]").forEach(btn => {
    btn.addEventListener("click", () => {
      const bid = btn.dataset.bid;
      if (viewMode === "mine") {
        // 내판매현황: 그 폴더로 필터링해서 보여줌 (기존 동작)
        _activeBizTabId = bid || null;
        _renderMineView();
      } else if (bid) {
        // 최저가봇 등 다른 화면: 체크된 상품들을 클릭한 폴더로 바로 배정
        _assignCheckedToBizTab(bid);
      }
    });
    btn.addEventListener("contextmenu", e => { e.preventDefault(); const bid = btn.dataset.bid; if (bid) _showBizTabMenu(bid); });
  });
  $("biz-tab-add-btn")?.addEventListener("click", () => {
    const name = prompt("새 거래처 탭 이름:");
    if (name?.trim()) addBizTab(name.trim());
  });
  $("biz-refresh-btn")?.addEventListener("click", async () => {
    st("🔄 거래처 탭 서버에서 가져오는 중...");
    await loadBizData();
    _renderBizTabBar();
    if (viewMode === "mine") _renderMineView();
    st(`✅ 거래처 탭 새로고침 완료 — ${bizData.tabs.length}개`);
  });
}

// 거래처 탭 바에서 폴더 버튼을 클릭했을 때 — 체크된 상품들을 그 폴더로 바로 배정 (검색/즐겨찾기 등에서 사용)
async function _assignCheckedToBizTab(tabId) {
  const tab = bizData.tabs.find(t => t.id === tabId);
  if (!tab) return;
  const targets = [...checkedSet].map(k => shownProducts[_keyIdx(k)]).filter(p => p && p.tire_id);
  if (!targets.length) { alert(`배정할 상품을 먼저 체크박스로 선택하세요.\n(체크 후 "${tab.name}" 폴더를 다시 클릭하면 배정됩니다)`); return; }
  if (!confirm(`선택한 ${targets.length}개 상품을 [${tab.name}] 탭으로 배정할까요?`)) return;
  let assigned = 0;
  for (const p of targets) {
    const key = _bizKey(p);
    const already = bizData.assign[key]?.includes(tabId);
    if (!already) { await toggleBizAssign(p, tabId); assigned++; }
  }
  checkedSet.clear(); rerenderChecks();
  _renderBizTabBar(); // 폴더별 개수 갱신
  st(`✅ [${tab.name}]로 ${assigned}개 배정 완료 (이미 있던 것 제외)`);
}

function _showBizTabMenu(bid) {
  const tab = bizData.tabs.find(t => t.id === bid);
  if (!tab) return;
  const action = prompt(`"${tab.name}" 탭 관리\n\n1 → 이름 변경\n2 → 삭제\n\n번호를 입력하세요:`);
  if (action === "1") {
    const n = prompt("새 이름:", tab.name);
    if (n?.trim()) renameBizTab(bid, n.trim());
  } else if (action === "2") {
    if (confirm(`"${tab.name}" 탭을 삭제할까요?\n배정된 상품 연결도 전부 해제됩니다.`)) deleteBizTab(bid);
  }
}

// ── 배정 팝업 ──────────────────────────────────────
function _showBizAssignPopup(bizKey, anchorEl) {
  const popup = $("biz-assign-popup");
  if (!popup) return;
  _hideBizAssignPopup._key = bizKey;
  const assigned = bizData.assign?.[bizKey] || [];
  if (!bizData.tabs.length) {
    popup.innerHTML = `<div style="color:#6b7280;margin-bottom:6px;">거래처 탭이 없습니다.</div><a href="#" id="biz-pop-add" style="color:#0284c7;">+ 탭 추가하기</a>`;
    popup.querySelector("#biz-pop-add")?.addEventListener("click", e => {
      e.preventDefault();
      const name = prompt("새 거래처 탭 이름:");
      if (name?.trim()) addBizTab(name.trim()).then(() => _showBizAssignPopup(bizKey, anchorEl));
    });
  } else {
    popup.innerHTML = `<div style="font-size:10px;color:#6b7280;margin-bottom:5px;font-weight:bold;">거래처 탭 배정</div>`
      + bizData.tabs.map(t => `
        <label style="display:flex;align-items:center;gap:6px;padding:3px 4px;cursor:pointer;border-radius:4px;" class="biz-pop-label">
          <input type="checkbox" data-tid="${t.id}" ${assigned.includes(t.id) ? "checked" : ""}> ${escHtml(t.name)}
        </label>`).join("")
      + `<div style="margin-top:6px;border-top:1px solid #f3f4f6;padding-top:5px;"><a href="#" id="biz-pop-add2" style="font-size:10px;color:#0284c7;">+ 새 탭 추가</a></div>`;
    popup.querySelectorAll("input[data-tid]").forEach(cb => {
      cb.addEventListener("change", () => {
        toggleBizAssign(bizKey, cb.dataset.tid);
        // 저장 완료를 기다리지 않고 아이콘을 즉시 초록색으로 반영
        const nowAssigned = (bizData.assign?.[bizKey]?.length || 0) > 0;
        anchorEl?.classList.toggle("biz-assigned", nowAssigned);
        _hideBizAssignPopup(); // 선택 즉시 팝업 닫기
      });
    });
    popup.querySelector("#biz-pop-add2")?.addEventListener("click", e => {
      e.preventDefault();
      const name = prompt("새 거래처 탭 이름:");
      if (name?.trim()) addBizTab(name.trim()).then(() => _showBizAssignPopup(bizKey, anchorEl));
    });
  }
  const rect = anchorEl.getBoundingClientRect();
  popup.style.display = "block";
  popup.style.top  = Math.min(rect.bottom + 4, window.innerHeight - 220) + "px";
  popup.style.left = Math.max(4, rect.left - 100) + "px";
}
function _hideBizAssignPopup() {
  const popup = $("biz-assign-popup");
  if (popup) { popup.style.display = "none"; popup.innerHTML = ""; }
  _hideBizAssignPopup._key = null;
}

// ── 내 판매현황 탭 ───────────────────────────────────────────
// 검색 결과에서 is_mine=true 상품만 따로 보여주는 뷰
// (별도 fetch 없음 — 검색 결과를 그대로 활용하므로 제조사/제품명 완벽하게 표시됨)
let _mineMfrFilter = "";
let _mineAllProducts = null; // 현재 is_mine 상품 전체 (제조사 필터용)
let _mineSavedSearch = null; // mine 진입 전 search 상태 백업

// 거래처 탭에 배정된 상품들 (스냅샷 기반, 검색 불필요)
function _getBizTabProducts(tabId) {
  const out = [];
  for (const [key, tabIds] of Object.entries(bizData.assign)) {
    if (!tabIds.includes(tabId)) continue;
    const snap = bizData.products[key];
    if (!snap) continue;
    out.push({ ...snap, is_mine: true, lowest_price: 0, second_price: 0, market_lowest: 0, my_rank: 0, lowest_seller: "", _noCompData: true });
  }
  return out;
}
// 거래처 전체 배정 상품 (모든 탭 합산, 중복 제거)
function _getAllBizProducts() {
  const seen = new Set();
  const out = [];
  for (const [key, tabIds] of Object.entries(bizData.assign)) {
    if (!tabIds.length) continue;
    if (seen.has(key)) continue; seen.add(key);
    const snap = bizData.products[key];
    if (!snap) continue;
    out.push({ ...snap, is_mine: true, lowest_price: 0, second_price: 0, market_lowest: 0, my_rank: 0, lowest_seller: "", _noCompData: true });
  }
  return out;
}

function enterMineView() {
  if (viewMode === "mine") return;
  if (viewMode === "fav") enterSearchView();
  viewMode = "mine";
  _mineMfrFilter = "";
  _activeBizTabId = null;
  checkedSet.clear();
  $("price-mfr-bar").style.display = "none"; // 최저가봇 전용 제조사 빠른필터는 내 판매현황에서 숨김
  _mineSavedSearch = { all: allProducts, shown: shownProducts, filter: {...filterState}, quick: quickFilter };
  _mineAllProducts = allProducts.filter(p => p.is_mine); // 검색 결과의 내 상품
  _renderMineView();
  // Supabase에서 최신 거래처 탭·배정·스냅샷 로드
  loadBizData().then(() => {
    if (viewMode === "mine") _renderMineView();
  });
}

// 검색 완료 후 mine 탭이 열려있으면 자동 갱신
function refreshMineViewIfActive(products) {
  if (viewMode !== "mine") return;
  const mine = (products || allProducts).filter(p => p.is_mine);
  _mineAllProducts = mine;
  _renderMineView();
}

// 내 상품의 현재 출고방식(send_kind)/출고기준시간(send_time)/공장도가/판매가를 실제 수정 페이지에서 읽어옴 (저장 없이 조회만)
async function fetchMySendInfo(pid) {
  if (!pid) return null;
  try {
    const getR = await bgFetch(`${BASE}/sell/price/update/${pid}`);
    if (!getR.ok) return null;
    const html = getR.text;
    if (/name=['"]login_id['"]|action=['"]\/login['"]|id=['"]login-form['"]/i.test(html)) return null;
    const kindM = html.match(/name=['"]send_kind['"][^>]*value=['"]([^'"]*)['"][^>]*checked/i)
               || html.match(/name=['"]send_kind['"][^>]*checked[^>]*value=['"]([^'"]*)['"]/i);
    const hourBlock = (html.match(/<select[^>]+name=['"]send_hour['"][\s\S]*?<\/select>/i) || [])[0] || "";
    const minBlock  = (html.match(/<select[^>]+name=['"]send_min['"][\s\S]*?<\/select>/i)  || [])[0] || "";
    const hourSel = (hourBlock.match(/<option[^>]+value=['"]([^'"]*)['"][^>]*selected/i)
                  || hourBlock.match(/<option[^>]+selected[^>]*value=['"]([^'"]*)['"]/i) || [])[1];
    const minSel  = (minBlock.match(/<option[^>]+value=['"]([^'"]*)['"][^>]*selected/i)
                  || minBlock.match(/<option[^>]+selected[^>]*value=['"]([^'"]*)['"]/i) || [])[1];
    // 공장도가(divFactoryprice)와 현재 판매가(input#price) — 내DC% 재계산용
    const factoryM = html.match(/id=['"]divFactoryprice['"][^>]*>([\d,]+)</i);
    const priceM   = html.match(/name=['"]price['"][^>]*value=['"]([\d,]*)['"]/i);
    const factory_price = factoryM ? parseInt(factoryM[1].replace(/,/g, ""), 10) : undefined;
    const my_price       = priceM ? parseInt(priceM[1].replace(/,/g, ""), 10) : undefined;
    return {
      send_kind: kindM ? parseInt(kindM[1], 10) : undefined,
      send_time: (hourSel && minSel) ? `${hourSel}:${minSel}` : "",
      factory_price, my_price,
    };
  } catch(e) { return null; }
}

// 거래처 탭: 스냅샷(경쟁가 없음) 상품들의 실제 경쟁가를 백그라운드로 조회해 채움
// → 조회 완료된 상품은 최저가봇 검색결과와 동일하게 ⬇최저가/↑2등-10원 버튼과 가격수정이 활성화됨
let _bizHydrateToken = 0;
async function _hydrateBizTabPrices(tabId, force = false) {
  const myToken = ++_bizHydrateToken;
  const targets = force
    ? shownProducts.filter(p => p.tire_id)
    : shownProducts.filter(p => p._noCompData && p.tire_id);
  if (!targets.length) return;
  st(`🔎 거래처 탭 경쟁가 조회 중... (0/${targets.length})`);
  let done = 0;
  for (let i = 0; i < targets.length; i += 5) {
    if (myToken !== _bizHydrateToken || viewMode !== "mine" || _activeBizTabId !== tabId) return; // 탭 전환/이탈 시 중단
    await Promise.all(targets.slice(i, i + 5).map(async p => {
      try {
        if (force) clearLowestCache(p.tire_id, p.dot);
        const [low, sec, mlow, seller, rank] = await fetchOneLowest(p);
        p.lowest_price  = low  || 0;
        p.second_price  = sec  || 0;
        p.market_lowest = mlow || 0;
        p.lowest_seller = seller || "";
        p.my_rank       = rank || 0;
      } catch(e) { /* 조회 실패 시 스냅샷 값 유지 */ }
      // 출고방식/출고시간/공장도가/판매가 정보가 없거나(옛 스냅샷), 강제 새로고침이면 실제 수정페이지에서 (재)조회
      if ((p.send_kind === undefined || force) && p.pid) {
        const sendInfo = await fetchMySendInfo(p.pid);
        if (sendInfo) {
          p.send_kind = sendInfo.send_kind; p.send_time = sendInfo.send_time;
          if (sendInfo.factory_price !== undefined) p.factory_price = sendInfo.factory_price;
          if (sendInfo.my_price !== undefined)       p.my_price      = sendInfo.my_price;
          if (p.factory_price && p.my_price) p.dc_rate = calcDc(p.factory_price, p.my_price);
        }
      }
      delete p._noCompData;
      p._derivedKey = ""; calcDerivedFields(p);
      if (p._cacheKey) { _rowCache.delete(p._cacheKey); p._cacheKey = ""; }
      refreshRowByTireId(p.tire_id, p.dot);
      done++;
    }));
    if (myToken !== _bizHydrateToken || viewMode !== "mine" || _activeBizTabId !== tabId) return;
    st(`🔎 거래처 탭 경쟁가 조회 중... (${done}/${targets.length})`);
  }
  if (myToken === _bizHydrateToken) st(`✅ 거래처 탭 경쟁가 조회 완료 (${done}개)`);
}

// ── 행사(연도합산) 최저가 사전 계산 ─────────────────────────
// 각 상품마다 DOT 해당연도~올해까지를 모두 조회해 합산 최저가(_eventLow)를 구해둠.
// 내 판매가가 그 합산 최저가보다 비쌀 때만 🎪행사최저 버튼이 표시됨.
let _eventLowToken = 0;
async function _hydrateEventLowest(force = false) {
  const myToken = ++_eventLowToken;
  const nowYear = new Date().getFullYear();
  const targets = shownProducts.filter(p =>
    p.is_mine && p.tire_id && p.dot && p.my_price > 0 && !p.is_soldout && p.my_stock > 0 &&
    (force || p._eventChecked === undefined)
  );
  if (!targets.length) return;
  st(`🎪 행사(연도합산) 최저가 확인 중... (0/${targets.length})`);
  let done = 0;
  for (let i = 0; i < targets.length; i += 3) {
    if (myToken !== _eventLowToken || viewMode !== "mine") return; // 탭 이탈/재실행 시 중단
    await Promise.all(targets.slice(i, i + 3).map(async p => {
      const y0 = parseInt(p.dot, 10);
      if (!y0 || y0 < 2000) { p._eventChecked = true; p._eventLow = 0; done++; return; }
      const yEnd = Math.max(y0, nowYear);
      let best = 0, bestYear = null;
      for (let y = y0; y <= yEnd; y++) {
        try {
          if (force) clearLowestCache(p.tire_id, String(y));
          const [low] = await fetchOneLowest({ tire_id: p.tire_id, dot: String(y) });
          if (low > 0 && (best === 0 || low < best)) { best = low; bestYear = y; }
        } catch(e) { /* 개별 연도 조회 실패는 무시하고 나머지 연도로 진행 */ }
      }
      p._eventLow      = best;
      p._eventLowYear  = bestYear;
      p._eventChecked  = true;
      if (p._cacheKey) { _rowCache.delete(p._cacheKey); p._cacheKey = ""; }
      refreshRowByTireId(p.tire_id, p.dot);
      done++;
    }));
    if (myToken !== _eventLowToken || viewMode !== "mine") return;
    st(`🎪 행사(연도합산) 최저가 확인 중... (${done}/${targets.length})`);
  }
  if (myToken === _eventLowToken) {
    const need = shownProducts.filter(p => p._eventLow > 0 && p.my_price > p._eventLow).length;
    st(`✅ 행사 최저가 확인 완료 — 조정 필요 ${need}개`);
  }
}

// 내 판매현황: 제조사·거래처 필터 적용해 표 갱신
function _renderMineView() {
  if (viewMode !== "mine") return;
  _renderBizTabBar();

  let src, filtered;
  if (_activeBizTabId) {
    // 거래처 탭 선택: 스냅샷 기반 (검색 무관, 상시 표시)
    src = _getBizTabProducts(_activeBizTabId);
  } else {
    // 전체: 검색 결과의 is_mine 상품
    src = (_mineAllProducts || []);
  }

  filtered = _mineMfrFilter ? src.filter(p => p.manufacturer === _mineMfrFilter) : src;
  _updateMineMfrTabs(src);

  filtered.forEach(calcDerivedFields);
  allProducts = filtered;
  shownProducts = [...filtered];
  _lastFilterKey = ""; applyFilters._ref = null; _rowCache.clear();
  applyFilters();

  $("mine-mfr-bar").style.display = "flex";
  $("biz-tab-bar").style.display = "flex";
  $("table-wrap")?.classList.add("mine-mode");

  const bizName = _activeBizTabId ? ` — ${bizData.tabs.find(t=>t.id===_activeBizTabId)?.name||""}` : "";
  const hint = !_activeBizTabId && !src.length ? " (검색 후 내 상품이 표시됩니다)" : "";
  st(`🏪 내 판매현황 ${filtered.length}개${bizName}${_mineMfrFilter ? ` / ${_mineMfrFilter}` : ""}${hint}`);

  // 거래처 탭이면 실제 경쟁가를 백그라운드로 조회해 최저가봇처럼 가격조정 가능하게 함
  if (_activeBizTabId) _hydrateBizTabPrices(_activeBizTabId).then(() => _hydrateEventLowest());
  else {
    _hydrateEventLowest();
    // 전체 보기는 마지막 검색 시점 데이터라 출고(당일/익일) 상태가 오래됐을 수 있어 최신화
    _hydrateSendInfoForVisible(filtered, () => viewMode === "mine" && !_activeBizTabId);
  }
}

// 제조사 서브탭 버튼 목록 갱신 (내 상품 목록에서 자동 감지)
function _updateMineMfrTabs(mineProducts) {
  const bar = $("mine-mfr-bar");
  if (!bar) return;
  const mfrs = [...new Set(mineProducts.map(p => p.manufacturer).filter(Boolean))].sort();
  bar.innerHTML = `<button class="mfr-tab-btn${!_mineMfrFilter ? " active" : ""}" data-mfr="">전체 (${mineProducts.length})</button>`
    + mfrs.map(m => {
        const cnt = mineProducts.filter(p => p.manufacturer === m).length;
        return `<button class="mfr-tab-btn${_mineMfrFilter === m ? " active" : ""}" data-mfr="${m}">${m} (${cnt})</button>`;
      }).join("")
    + `<button class="btn-gray btn-sm" id="btn-mine-refresh" style="margin-left:auto;"
        title="${_activeBizTabId ? "이 거래처 탭의 경쟁가·출고정보를 다시 조회합니다" : "검색을 다시 실행해 내 판매현황을 최신 상태로 갱신합니다"}">🔄 새로고침</button>`;
  $("btn-mine-refresh")?.addEventListener("click", async () => {
    if (_activeBizTabId) {
      st("🔄 거래처 탭 경쟁가/출고정보 새로고침 중...");
      await _hydrateBizTabPrices(_activeBizTabId, true);
      await _hydrateEventLowest(true);
    } else {
      st("🔄 내 판매현황 새로고침 — 검색을 다시 실행합니다...");
      await doSearch(true);
      // doSearch는 실행 중 mine 탭에서 벗어나므로(내부적으로 검색보기로 전환됨) 다시 mine으로 복귀
      document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
      document.querySelector('.tab-btn[data-tab="mine"]')?.classList.add("active");
      enterMineView();
    }
  });
}

// ── 최저가봇 검색결과: 제조사 빠른필터 (검색 후 제조사 하나만 골라 선택→가격설정/수정) ──
// 기존 "제조사" 컬럼 헤더의 ▾ 필터와 filterState["제조사"]를 공유하므로 둘 다 항상 서로 동기화됨
function _updatePriceMfrTabs() {
  const bar = $("price-mfr-bar");
  if (!bar) return;
  if (viewMode !== "search" || !allProducts.length) { bar.style.display = "none"; return; }

  const mfrs = [...new Set(allProducts.map(p => p.manufacturer).filter(Boolean))].sort();
  if (!mfrs.length) { bar.style.display = "none"; return; }

  const activeSet = filterState["제조사"] instanceof Set ? filterState["제조사"] : null;
  const activeMfr = (activeSet && activeSet.size === 1) ? [...activeSet][0] : "";

  bar.style.display = "flex";
  bar.innerHTML = `<span style="color:#0369a1;font-weight:bold;white-space:nowrap;margin-right:2px;font-size:11px;">제조사</span>`
    + `<button class="mfr-tab-btn${!activeSet ? " active" : ""}" data-mfr="">전체 (${allProducts.length})</button>`
    + mfrs.map(m => {
        const cnt = allProducts.filter(p => p.manufacturer === m).length;
        return `<button class="mfr-tab-btn${activeMfr === m ? " active" : ""}" data-mfr="${m}">${m} (${cnt})</button>`;
      }).join("");
}

// 검색 보기로 복귀
function leaveMineView() {
  if (viewMode !== "mine") return;
  _bizHydrateToken++; // 진행 중이던 거래처 탭 경쟁가 조회 중단
  _eventLowToken++;   // 진행 중이던 행사(연도합산) 최저가 계산 중단
  _sendInfoHydrateToken++; // 진행 중이던 출고정보 조회 중단
  viewMode = "search";
  checkedSet.clear();
  $("mine-mfr-bar").style.display = "none";
  $("biz-tab-bar").style.display = "none";
  $("table-wrap")?.classList.remove("mine-mode");
  _hideBizAssignPopup();
  _mineMfrFilter = "";
  _activeBizTabId = null;
  // 검색 상태 복원
  if (_mineSavedSearch) {
    allProducts = _mineSavedSearch.all;
    shownProducts = _mineSavedSearch.shown;
    filterState = _mineSavedSearch.filter || {};
    quickFilter = _mineSavedSearch.quick || "";
    const qi = $("inp-quick-filter"); if (qi) qi.value = quickFilter;
    _mineSavedSearch = null;
  }
  _lastFilterKey = ""; applyFilters._ref = null; _rowCache.clear();
  applyFilters();
  updateFilterLabel();
  _updatePriceMfrTabs();
}

// ── 판매내역 탭 ─────────────────────────────────────────────
const ORD_BASE = `${BASE}/sell/orderlist`;
let _ordRows     = [];
let _ordExcelRows = null;
let _ordDetailCache = {}; // orderId → {dot, product, size, detail, ...}

// ── 출고지 드롭다운 (주문확인 시 선택, 게러지 그리드 G열에 표시) ──
let _shipFromOptions = ["창고","넥센","황제","매일","오후"]; // 기본 목록 (직접 추가 가능)
let _shipFromMap = {}; // orderId(문자열) → 선택된 출고지 값
const SHIPFROM_OPT_KEY = "shipfrom_options";
const SHIPFROM_MAP_KEY = "shipfrom_by_order";

async function loadShipFromData() {
  return new Promise(resolve => {
    chrome.storage.local.get([SHIPFROM_OPT_KEY, SHIPFROM_MAP_KEY], d => {
      if (Array.isArray(d[SHIPFROM_OPT_KEY]) && d[SHIPFROM_OPT_KEY].length) _shipFromOptions = d[SHIPFROM_OPT_KEY];
      if (d[SHIPFROM_MAP_KEY]) _shipFromMap = d[SHIPFROM_MAP_KEY];
      resolve();
    });
  });
}
function _saveShipFromOptions() { chrome.storage.local.set({ [SHIPFROM_OPT_KEY]: _shipFromOptions }); }
function _saveShipFromMap()     { chrome.storage.local.set({ [SHIPFROM_MAP_KEY]: _shipFromMap }); }

function addShipFromOption(name) {
  const v = (name || "").trim();
  if (!v || _shipFromOptions.includes(v)) return;
  _shipFromOptions.push(v);
  _saveShipFromOptions();
}
function removeShipFromOption(name) {
  const i = _shipFromOptions.indexOf(name);
  if (i === -1) return;
  _shipFromOptions.splice(i, 1);
  _saveShipFromOptions();
}
function setOrderShipFrom(orderId, value) {
  if (!orderId) return;
  if (value) _shipFromMap[orderId] = value; else delete _shipFromMap[orderId];
  _saveShipFromMap();
  _renderGarageGrid(); // 게러지 그리드 G열(출고지) 즉시 갱신
}

// ── 직접출고 여부 (F열: 직접출고 / 직배송(경기·서울) / 택배) ──
let _directShipMap = {}; // orderId → true (직접출고로 표시)
const DIRECTSHIP_KEY = "direct_ship_orders";
async function loadDirectShipData() {
  return new Promise(resolve => {
    chrome.storage.local.get(DIRECTSHIP_KEY, d => {
      if (d[DIRECTSHIP_KEY]) _directShipMap = d[DIRECTSHIP_KEY];
      resolve();
    });
  });
}
function _saveDirectShipMap() { chrome.storage.local.set({ [DIRECTSHIP_KEY]: _directShipMap }); }
function setOrderDirectShip(orderId, isDirect) {
  if (!orderId) return;
  if (isDirect) _directShipMap[orderId] = true; else delete _directShipMap[orderId];
  _saveDirectShipMap();
  _renderGarageGrid();
}

// ── 마진 탭 (창고/거래처 등) — 제조사+상품명 규칙별 할인율 계산 ──
// 탭마다 여러 규칙(제조사 정확히 일치 + 상품명 포함 + 할인율%)을 등록해두면,
// 주문상세를 열 때 그 주문의 제조사/상품명과 일치하는 모든 탭이 나란히 표시됨
// 거래처 탭과 동일한 방식: 로컬 저장(항상 성공) 먼저 → Supabase 비동기 동기화(팀 공유)
let _marginTabs = []; // [{id, name, rules:[{id,manufacturer,productContains,discountPct,costOverride}]}]
const MARGIN_TABS_KEY = "margin_tabs_cfg";

function _saveMarginTabsLocal() {
  chrome.storage.local.set({ [MARGIN_TABS_KEY]: { feeRatePct, tabs: _marginTabs } });
  _marginMatchCache.clear(); // 규칙이 바뀌었으니 캐시된 매칭 결과 무효화
  _rowCache.clear(); // 행 HTML 렌더 캐시도 같이 비워야 새 마진값이 화면에 바로 반영됨 (안 그러면 다른 값이 바뀌기 전까진 옛 마진이 계속 보임)
  if (typeof shownProducts !== "undefined" && shownProducts.length) renderTable(shownProducts); // 지금 보이는 표 즉시 다시 그림
}

// ── 사이즈별 택배비 설정 ────────────────────────────────────
// 사이즈가 일치하는 규칙이 있으면 전역 택배가격 대신 이걸 우선 사용
// 묶음 옵션: 켜져 있으면 수량을 2개씩 묶어서(올림) 묶음배송비로 계산
// 예: 사이즈=145/80R13, 배송비=4000, 묶음=O, 묶음배송비=6000 → 4개 판매 시 ceil(4/2)=2 × 6000 = 12,000원
let _shipSizeRules = []; // [{id, size, price, bundle, bundlePrice}]
const SHIP_SIZE_KEY = "ship_size_rules";

async function loadShipSizeRules() {
  // 1. 로컬 캐시 즉시 적용
  await new Promise(resolve => {
    chrome.storage.local.get(SHIP_SIZE_KEY, d => {
      _shipSizeRules = Array.isArray(d[SHIP_SIZE_KEY]) ? d[SHIP_SIZE_KEY] : [];
      resolve();
    });
  });
  // 2. Supabase에서 최신 규칙 가져와 병합 (테이블 없으면 조용히 스킵)
  try {
    const r = await supaFetch("/rest/v1/ship_size_rules?select=*&order=created_at.asc");
    if (r.ok) {
      const rows = await r.json();
      _shipSizeRules = rows.map(row => ({
        id: row.id, size: row.size,
        price: Number(row.price) || 0,
        bundle: !!row.bundle,
        bundlePrice: Number(row.bundle_price) || 0,
      }));
      _saveShipSizeRulesLocal();
      console.log("[사이즈별택배비] Supabase 로드 완료:", _shipSizeRules.length, "건");
      return { ok: true };
    } else {
      let msg = "";
      try { const j = await r.json(); msg = j?.message || j?.hint || ""; } catch(_) {}
      const errText = `Supabase 로드 실패 (${r.status})${msg ? " — " + msg : ""}`;
      console.warn("[사이즈별택배비]", errText);
      return { ok: false, error: errText };
    }
  } catch(e) {
    console.warn("[사이즈별택배비] Supabase 연결 오류:", e.message);
    return { ok: false, error: "연결 오류: " + e.message };
  }
}
function _saveShipSizeRulesLocal() {
  chrome.storage.local.set({ [SHIP_SIZE_KEY]: _shipSizeRules });
  _shipSizeMatchCache.clear(); // 규칙이 바뀌었으니 캐시된 매칭 결과 무효화
}
async function addShipSizeRule(size, price, bundle, bundlePrice) {
  const v = (size || "").trim();
  if (!v) return null;
  const rule = {
    id: "ss_" + Date.now() + "_" + Math.random().toString(36).slice(2,6),
    size: v,
    price: parseInt(String(price||"").replace(/[^\d]/g,""), 10) || 0,
    bundle: !!bundle,
    bundlePrice: parseInt(String(bundlePrice||"").replace(/[^\d]/g,""), 10) || 0,
  };
  _shipSizeRules.push(rule);
  _saveShipSizeRulesLocal();
  try {
    const r = await supaFetch("/rest/v1/ship_size_rules", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({ id: rule.id, size: rule.size, price: rule.price, bundle: rule.bundle, bundle_price: rule.bundlePrice }),
    });
    if (!r.ok) st(`⚠️ 택배비 서버 저장 실패(${r.status}) — supabase_ship_size_rules.sql 실행 확인`);
  } catch(e) { st("⚠️ 택배비 서버 저장 실패: " + e.message); }
  return rule;
}
async function deleteShipSizeRule(ruleId) {
  _shipSizeRules = _shipSizeRules.filter(r => r.id !== ruleId);
  _saveShipSizeRulesLocal();
  try { await supaFetch(`/rest/v1/ship_size_rules?id=eq.${encodeURIComponent(ruleId)}`, { method: "DELETE" }); }
  catch(e) { console.warn("[사이즈별택배비] 삭제 Supabase 실패:", e.message); }
}
async function deleteShipSizeRules(ruleIds) {
  const idSet = new Set(ruleIds);
  _shipSizeRules = _shipSizeRules.filter(r => !idSet.has(r.id));
  _saveShipSizeRulesLocal();
  try {
    const orFilter = ruleIds.map(id => `id.eq.${encodeURIComponent(id)}`).join(",");
    await supaFetch(`/rest/v1/ship_size_rules?or=(${orFilter})`, { method: "DELETE" });
  } catch(e) { console.warn("[사이즈별택배비] 일괄삭제 Supabase 실패:", e.message); }
}
async function updateShipSizeRule(ruleId, size, price, bundle, bundlePrice) {
  const rule = _shipSizeRules.find(r => r.id === ruleId);
  if (!rule) return;
  rule.size = (size || "").trim();
  rule.price = parseInt(String(price||"").replace(/[^\d]/g,""), 10) || 0;
  rule.bundle = !!bundle;
  rule.bundlePrice = parseInt(String(bundlePrice||"").replace(/[^\d]/g,""), 10) || 0;
  _saveShipSizeRulesLocal();
  try {
    const r = await supaFetch(`/rest/v1/ship_size_rules?id=eq.${encodeURIComponent(ruleId)}`, {
      method: "PATCH",
      body: JSON.stringify({ size: rule.size, price: rule.price, bundle: rule.bundle, bundle_price: rule.bundlePrice }),
    });
    if (!r.ok) st(`⚠️ 택배비 서버 수정 실패(${r.status})`);
  } catch(e) { st("⚠️ 택배비 서버 수정 실패: " + e.message); }
}
// 사이즈를 정규화(공백/대소문자 무시)해서 비교 — "145/80R13" vs "145/80 R13" 등 표기 차이 흡수
function _normSizeForShip(s) {
  return (s || "").toUpperCase().replace(/\s+/g, "");
}
// 해당 사이즈+수량에 대한 총 택배비 계산. 일치하는 규칙이 없으면 null 반환(호출측에서 전역 기본값으로 폴백)
function computeShipTotalBySize(size, qtyNum) {
  const target = _normSizeForShip(size);
  if (!target) return null;
  const rule = _shipSizeRules.find(r => _normSizeForShip(r.size) === target);
  if (!rule) return null;
  const qty = qtyNum || 1;
  if (rule.bundle) {
    // 2개씩 묶어서 묶음배송비, 남는 1개는 일반 배송비
    // 예: 1개→배송비, 2개→묶음배송비, 3개→묶음배송비+배송비, 4개→묶음배송비×2
    const pairs = Math.floor(qty / 2);
    const remainder = qty % 2;
    return pairs * rule.bundlePrice + remainder * rule.price;
  }
  return rule.price * qty;
}

async function loadMarginTabsConfig() {
  // 1. 로컬 캐시 즉시 적용
  await new Promise(resolve => {
    chrome.storage.local.get(MARGIN_TABS_KEY, d => {
      const cfg = d[MARGIN_TABS_KEY];
      if (cfg) {
        _marginTabs = cfg.tabs || [];
        if (typeof cfg.feeRatePct === "number") feeRatePct = cfg.feeRatePct;
      }
      resolve();
    });
  });
  // 2. Supabase에서 최신 탭/규칙 가져와 병합 (테이블 없으면 조용히 스킵)
  try {
    const [tabsR, rulesR] = await Promise.all([
      supaFetch("/rest/v1/margin_tabs?select=*&order=position.asc,created_at.asc"),
      supaFetch("/rest/v1/margin_rules?select=*"),
    ]);
    if (tabsR.ok && rulesR.ok) {
      const tabs = await tabsR.json();
      const rules = await rulesR.json();
      _marginTabs = tabs.map(t => ({
        id: t.id, name: t.name, isException: !!t.is_exception,
        rules: rules.filter(r => r.tab_id === t.id).map(r => ({
          id: r.id,
          manufacturer: r.manufacturer,
          productContains: r.product_contains,
          sizeContains: r.size_contains || "",
          detailContains: r.detail_contains || "",
          dot: r.dot || "",
          discountPct: Number(r.discount_pct) || 0,
          costOverride: (r.cost_override === null || r.cost_override === undefined) ? null : Number(r.cost_override),
          inchThreshold: (r.inch_threshold === null || r.inch_threshold === undefined) ? null : Number(r.inch_threshold),
          discountPctAbove: (r.discount_pct_above === null || r.discount_pct_above === undefined) ? null : Number(r.discount_pct_above),
        })),
      }));
      _saveMarginTabsLocal();
      console.log("[마진탭] Supabase 로드 완료:", _marginTabs.length, "탭");
      return { ok: true };
    } else {
      let msg = "";
      try { const j = await tabsR.json(); msg = j?.message || j?.hint || ""; } catch(_) {}
      const errText = `Supabase 로드 실패 (탭:${tabsR.status} 규칙:${rulesR.status})${msg ? " — " + msg : ""}`;
      console.warn("[마진탭]", errText);
      return { ok: false, error: errText };
    }
  } catch(e) {
    console.warn("[마진탭] Supabase 연결 오류:", e.message);
    return { ok: false, error: "연결 오류: " + e.message };
  }
}

async function addMarginTab(name, isException) {
  const v = (name || "").trim();
  if (!v) return null;
  const tab = { id: "mt_" + Date.now(), name: v, isException: !!isException, rules: [] };
  _marginTabs.push(tab);
  _saveMarginTabsLocal();
  try {
    const r = await supaFetch("/rest/v1/margin_tabs", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({ id: tab.id, name: v, position: _marginTabs.length - 1, is_exception: !!isException }),
    });
    if (!r.ok) st(`⚠️ 마진탭 서버 저장 실패(${r.status}) — supabase_margin_tabs.sql 실행 확인`);
  } catch(e) { st("⚠️ 마진탭 서버 저장 실패: " + e.message); }
  return tab;
}
async function deleteMarginTab(tabId) {
  _marginTabs = _marginTabs.filter(t => t.id !== tabId);
  _saveMarginTabsLocal();
  try { await supaFetch(`/rest/v1/margin_tabs?id=eq.${encodeURIComponent(tabId)}`, { method: "DELETE" }); }
  catch(e) { console.warn("[마진탭] 삭제 Supabase 실패:", e.message); }
}
async function addMarginRule(tabId, manufacturer, productContains, discountPct, costOverride, detailContains, sizeContains, dot, inchThreshold, discountPctAbove) {
  const tab = _marginTabs.find(t => t.id === tabId);
  if (!tab) return;
  const rule = {
    id: "mr_" + Date.now(),
    manufacturer: (manufacturer || "").trim(),
    productContains: (productContains || "").trim(),
    sizeContains: (sizeContains || "").trim(),     // 예외탭 전용 — 비어있으면 검사 안 함
    detailContains: (detailContains || "").trim(), // 선택사항 — 비어있으면 검사 안 함
    dot: (dot || "").trim(),                       // 예외탭 전용 — 비어있으면 검사 안 함, 입력 시 정확히 일치해야 함
    discountPct: parseFloat(discountPct) || 0,     // 인치기준 미사용 시, 또는 "미만" 구간 할인율
    costOverride: (costOverride !== undefined && costOverride !== null && costOverride !== "") ? parseInt(String(costOverride).replace(/[^\d]/g,""),10) : null,
    inchThreshold: (inchThreshold !== undefined && inchThreshold !== null && inchThreshold !== "") ? parseInt(inchThreshold, 10) : null,       // 선택사항 — 예: 18
    discountPctAbove: (discountPctAbove !== undefined && discountPctAbove !== null && discountPctAbove !== "") ? parseFloat(discountPctAbove) : null, // "이상" 구간 할인율
  };
  tab.rules.push(rule);
  _saveMarginTabsLocal();
  try {
    const r = await supaFetch("/rest/v1/margin_rules", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({
        id: rule.id, tab_id: tabId, manufacturer: rule.manufacturer,
        product_contains: rule.productContains, size_contains: rule.sizeContains || null,
        detail_contains: rule.detailContains || null, dot: rule.dot || null,
        discount_pct: rule.discountPct, cost_override: rule.costOverride,
        inch_threshold: rule.inchThreshold, discount_pct_above: rule.discountPctAbove,
      }),
    });
    if (!r.ok) st(`⚠️ 마진규칙 서버 저장 실패(${r.status})`);
  } catch(e) { st("⚠️ 마진규칙 서버 저장 실패: " + e.message); }
}
async function updateMarginRule(tabId, ruleId, fields) {
  const tab = _marginTabs.find(t => t.id === tabId);
  const rule = tab?.rules.find(r => r.id === ruleId);
  if (!rule) return;
  if (fields.manufacturer !== undefined) rule.manufacturer = (fields.manufacturer || "").trim();
  if (fields.productContains !== undefined) rule.productContains = (fields.productContains || "").trim();
  if (fields.sizeContains !== undefined) rule.sizeContains = (fields.sizeContains || "").trim();
  if (fields.detailContains !== undefined) rule.detailContains = (fields.detailContains || "").trim();
  if (fields.dot !== undefined) rule.dot = (fields.dot || "").trim();
  if (fields.discountPct !== undefined) rule.discountPct = parseFloat(fields.discountPct) || 0;
  if (fields.costOverride !== undefined) {
    rule.costOverride = (fields.costOverride !== null && fields.costOverride !== "") ? parseInt(String(fields.costOverride).replace(/[^\d]/g,""),10) : null;
  }
  if (fields.inchThreshold !== undefined) {
    rule.inchThreshold = (fields.inchThreshold !== null && fields.inchThreshold !== "") ? parseInt(fields.inchThreshold, 10) : null;
  }
  if (fields.discountPctAbove !== undefined) {
    rule.discountPctAbove = (fields.discountPctAbove !== null && fields.discountPctAbove !== "") ? parseFloat(fields.discountPctAbove) : null;
  }
  _saveMarginTabsLocal();
  try {
    const r = await supaFetch(`/rest/v1/margin_rules?id=eq.${encodeURIComponent(ruleId)}`, {
      method: "PATCH",
      body: JSON.stringify({
        manufacturer: rule.manufacturer, product_contains: rule.productContains,
        size_contains: rule.sizeContains || null, detail_contains: rule.detailContains || null,
        dot: rule.dot || null,
        discount_pct: rule.discountPct, cost_override: rule.costOverride,
        inch_threshold: rule.inchThreshold, discount_pct_above: rule.discountPctAbove,
      }),
    });
    if (!r.ok) st(`⚠️ 마진규칙 서버 수정 실패(${r.status})`);
  } catch(e) { st("⚠️ 마진규칙 서버 수정 실패: " + e.message); }
}
async function deleteMarginRule(tabId, ruleId) {
  const tab = _marginTabs.find(t => t.id === tabId);
  if (!tab) return;
  tab.rules = tab.rules.filter(r => r.id !== ruleId);
  _saveMarginTabsLocal();
  try { await supaFetch(`/rest/v1/margin_rules?id=eq.${encodeURIComponent(ruleId)}`, { method: "DELETE" }); }
  catch(e) { console.warn("[마진탭] 규칙삭제 Supabase 실패:", e.message); }
}
async function deleteMarginRules(tabId, ruleIds) {
  const tab = _marginTabs.find(t => t.id === tabId);
  if (!tab) return;
  const idSet = new Set(ruleIds);
  tab.rules = tab.rules.filter(r => !idSet.has(r.id));
  _saveMarginTabsLocal();
  try {
    const orFilter = ruleIds.map(id => `id.eq.${encodeURIComponent(id)}`).join(",");
    await supaFetch(`/rest/v1/margin_rules?or=(${orFilter})`, { method: "DELETE" });
  } catch(e) { console.warn("[마진탭] 규칙 일괄삭제 Supabase 실패:", e.message); }
}

// 주문의 제조사/상품명/세부정보/사이즈에 매칭되는 탭들을 찾아 각 탭의 할인율/원가직접입력을 반환
// 예외탭(isException)에 매칭되는 규칙이 있으면, 그것만 최우선 반환하고 다른 탭은 전부 무시함
// 반환: [{tabName, discountPct, costOverride}]
// 사이즈 문자열에서 인치(마지막 숫자, 보통 R 뒤 숫자)를 추출 — "235/45R18", "235 / 45 R 18", "235 45 18" 다 지원
function _parseInchFromSize(size) {
  const nums = String(size || "").match(/\d+/g);
  if (!nums || !nums.length) return null;
  const last = parseInt(nums[nums.length - 1], 10);
  return (last >= 8 && last <= 30) ? last : null; // 타이어 인치 범위 안전장치
}
// 규칙에 인치기준(inchThreshold)이 설정돼 있으면 사이즈의 인치에 따라 할인율을 다르게 적용
// (예: 17인치 미만 50%, 18인치 이상 52% → discountPct=50(미만), inchThreshold=18, discountPctAbove=52)
function _effectiveRuleDiscount(rule, size) {
  if (rule.inchThreshold === null || rule.inchThreshold === undefined || rule.inchThreshold === "") return rule.discountPct;
  const inch = _parseInchFromSize(size);
  if (inch === null) return rule.discountPct; // 인치 파악 안 되면 기본(미만) 할인율로 폴백
  return inch >= rule.inchThreshold ? rule.discountPctAbove : rule.discountPct;
}
function matchMarginTabs(maker, product, detail, size, dot) {
  const mk = (maker || "").trim();
  const pd = (product || "").trim();
  const dt = (detail || "").trim();
  const sz = (size || "").trim();
  const dtot = String(dot || "").trim();

  // ── 1단계: 예외탭 먼저 검사 — 매칭되면 그 결과만 반환하고 종료 (최우선 적용) ──
  for (const tab of _marginTabs) {
    if (!tab.isException) continue;
    let best = null;
    let bestHasSize = false; // best가 "상품명+사이즈 일치(1순위)"인지 여부
    for (const rule of (tab.rules || [])) {
      const mfrOk = rule.manufacturer && mk && rule.manufacturer === mk;
      const prodOk = rule.productContains && pd && pd.includes(rule.productContains);
      // 사이즈는 이제 선택사항: 규칙에 사이즈가 없으면 검사 안 함(=상품명만 일치해도 매칭, 2순위)
      // 사이즈가 있으면 표기차이(공백/슬래시/R 유무)를 모두 무시하고 비교해야 함(일치하면 1순위)
      const sizeSpecified = !!rule.sizeContains;
      const sizeOk = !sizeSpecified || (sz && sz.replace(/[\s\/rR]/g, "").includes(rule.sizeContains.replace(/[\s\/rR]/g, "")));
      const detailOk = !rule.detailContains || (dt && dt.includes(rule.detailContains));
      const dotOk = !rule.dot || (dtot && dtot === String(rule.dot).trim()); // DOT 입력 시에만 정확히 일치해야 함
      // 근접매칭(제조사는 맞는데 나머지가 어긋남) 디버그 로그 — 콘솔(F12)에서 원인 확인 가능
      if (mfrOk && !(prodOk && sizeOk && detailOk && dotOk)) {
        console.log(`[예외탭 매칭실패] 탭="${tab.name}" 규칙:[제품포함="${rule.productContains}" 사이즈포함="${rule.sizeContains||""}" DOT="${rule.dot||""}"] ` +
          `실제:[제품명="${pd}"(포함:${prodOk}) 사이즈="${sz}"(포함:${sizeOk}) DOT="${dtot}"(일치:${dotOk})]`);
      }
      if (mfrOk && prodOk && sizeOk && detailOk && dotOk) {
        // 우선순위: 상품명+사이즈 일치(1순위) > 상품명만 일치(2순위). 같은 순위 안에서는 상품명(포함) 문자열이 더 긴(구체적인) 쪽 우선
        if (!best) { best = rule; bestHasSize = sizeSpecified; }
        else if (sizeSpecified && !bestHasSize) { best = rule; bestHasSize = true; } // 2순위 → 1순위로 승격
        else if (sizeSpecified === bestHasSize && rule.productContains.length > best.productContains.length) { best = rule; }
      }
    }
    if (best) return [{ tabName: tab.name, discountPct: _effectiveRuleDiscount(best, sz), costOverride: best.costOverride ?? null, isException: true }];
  }

  // ── 2단계: 예외탭에 매칭 없으면 일반 탭들 전부 검사 (기존 방식) ──
  const out = [];
  for (const tab of _marginTabs) {
    if (tab.isException) continue; // 예외탭은 이미 위에서 처리했으므로 제외
    // 같은 탭 안에서 여러 규칙이 동시에 매칭되면:
    // 1순위 = 세부정보가 입력돼 있고 일치하는 규칙, 2순위 = 세부정보 없는(=조건 없는) 규칙
    // 같은 순위 안에서는 "상품명(포함) 문자열이 가장 긴(구체적인) 규칙"을 우선 적용
    let best = null;
    let bestHasDetail = false;
    for (const rule of (tab.rules || [])) {
      const mfrOk = rule.manufacturer && mk && rule.manufacturer === mk;
      const prodOk = rule.productContains && pd && pd.includes(rule.productContains);
      const detailSpecified = !!rule.detailContains;
      const detailOk = !detailSpecified || (dt && dt.includes(rule.detailContains));
      if (mfrOk && prodOk && detailOk) {
        if (!best) { best = rule; bestHasDetail = detailSpecified; }
        else if (detailSpecified && !bestHasDetail) { best = rule; bestHasDetail = true; } // 2순위 → 1순위로 승격
        else if (detailSpecified === bestHasDetail && rule.productContains.length > best.productContains.length) { best = rule; }
      }
    }
    if (best) out.push({ tabName: tab.name, discountPct: _effectiveRuleDiscount(best, sz), costOverride: best.costOverride ?? null, isException: false });
  }
  return out;
}

// 주문상세 화면 하단에 탭별 마진(원가) 계산 결과를 렌더링
function _renderOrderMarginResult(factoryPrice, maker, product, settleAmount, orderId, qty, detail, size, dot) {
  const box = $("ord-margin-result");
  if (!box) return;
  if (!factoryPrice) { box.innerHTML = ""; return; }
  const matches = matchMarginTabs(maker, product, detail, size, dot);
  const settle = parseInt(String(settleAmount || "").replace(/[^\d]/g, ""), 10) || 0;
  const qtyNum = parseInt(String(qty || "1").replace(/[^\d]/g, ""), 10) || 1;
  // 사이즈별 택배비 규칙이 있으면 우선 사용, 없으면 전역 기본 택배비×수량으로 폴백
  const shipTotalBySize = computeShipTotalBySize(size, qtyNum);
  const shipTotalAll = shipTotalBySize !== null ? shipTotalBySize : (shippingCostDefault || 0) * qtyNum;
  // 이 주문에서 실제 선택된 출고지 (익일출고 표기는 제거하고 이름만 비교)
  const curShipFrom = (_shipFromMap[orderId] || "").replace(/ 익일출고$/, "");

  const renderGroup = (title, withShipping, groupKey) => {
    // 여러 탭이 매칭되면 그 중 할인율(실질 — 원가직접입력은 공장도가 대비 환산)이 가장 높은 것을 찾아 초록 테두리로 강조
    let bestIdx = -1, bestRate = -Infinity;
    matches.forEach((m, i) => {
      const r = _effDiscountRate(m, factoryPrice);
      if (r > bestRate) { bestRate = r; bestIdx = i; }
    });
    const cards = matches.map((m, idx) => {
      // 원가를 직접 입력해둔 규칙이면 그 값을 그대로 사용(개당), 없으면 공장도가×(1−할인율/100)으로 계산(개당)
      const unitCost = (m.costOverride !== null && m.costOverride !== undefined)
        ? m.costOverride
        : Math.round(factoryPrice * (1 - m.discountPct / 100));
      const cost = unitCost * qtyNum; // 수량 반영 (정산금액은 주문 전체 금액이므로 원가도 전체 수량 기준이어야 함)
      const margin = withShipping ? (settle - cost - shipTotalAll) : (settle - cost);
      const marginPerUnit = Math.round(margin / qtyNum);
      const marginColor = margin >= 0 ? "#16a34a" : "#dc2626";
      const isCurShip = curShipFrom && m.tabName === curShipFrom;
      const isBest = idx === bestIdx && matches.length > 1; // 매칭된 탭이 하나뿐이면 강조 의미 없으므로 생략
      const bg = isCurShip ? "background:#fef9c3;" : "background:#fff;";
      const borderStyle = isBest ? "border:2px solid #16a34a;" : `border:1px solid ${isCurShip ? "#f59e0b" : "#c7d2fe"};`;
      const shipDisplay = withShipping ? shipTotalAll : 0; // 직배송 그룹은 배송비 미적용 → 0으로 표시
      return `<div style="border-radius:6px;padding:6px 10px;min-width:130px;${bg}${borderStyle}">
        <div style="font-weight:700;color:#4338ca;font-size:11px;">${isCurShip ? "★ " : ""}${escHtml(m.tabName)}${isBest ? ` <span style="color:#16a34a;">(최고할인)</span>` : ""}</div>
        <div style="font-size:10px;color:#6b7280;">공장도가 <b>${comma(factoryPrice)}원</b></div>
        <div style="font-size:10px;color:#6b7280;">할인율 <b>${m.costOverride!=null ? "원가직접입력" : m.discountPct + "%"}</b></div>
        <div style="font-size:10px;color:#374151;">원가 <b>${comma(cost)}원</b>${qtyNum>1?` <span style="color:#9ca3af;">(개당 ${comma(unitCost)}원×${qtyNum})</span>`:""}</div>
        <div style="font-size:10px;color:#374151;">배송비 <b>${comma(shipDisplay)}원</b></div>
        <div style="font-size:10px;color:${marginColor};">개당마진 <b>${comma(marginPerUnit)}원</b></div>
        <div style="font-size:10px;color:${marginColor};">전체마진 <b>${comma(margin)}원</b></div>
      </div>`;
    }).join("");
    // 맨 오른쪽: 할인율 또는 원가 직접입력 계산기 (탭 규칙과 무관하게 즉석 계산)
    const manualId = `margin-manual-${groupKey}`;
    const savedOv = orderCostOverrides[orderId];
    const savedDc   = savedOv && savedOv.discountPct  != null ? savedOv.discountPct  : "";
    const savedCost = savedOv && savedOv.costOverride != null ? savedOv.costOverride : "";
    const manualCard = `<div style="border:1px dashed #9ca3af;border-radius:6px;padding:6px 10px;min-width:150px;background:#f9fafb;">
      <div style="font-weight:700;color:#6b7280;font-size:11px;margin-bottom:2px;">직접입력${savedOv ? ` <span style="color:#16a34a;">(저장됨 — 게러지 T값에 적용중)</span>` : ""}</div>
      <div style="font-size:10px;color:#374151;display:flex;align-items:center;gap:3px;margin-bottom:2px;">할인율
        <input type="number" class="margin-manual-dc" data-group="${groupKey}" data-with-ship="${withShipping?1:0}" placeholder="%" value="${savedDc}" style="width:44px;padding:1px 4px;border:1px solid #d1d5db;border-radius:4px;font-size:10px;">%
      </div>
      <div style="font-size:10px;color:#374151;display:flex;align-items:center;gap:3px;">원가
        <input type="number" class="margin-manual-cost" data-group="${groupKey}" data-with-ship="${withShipping?1:0}" placeholder="원 (개당)" value="${savedCost}" style="width:70px;padding:1px 4px;border:1px solid #d1d5db;border-radius:4px;font-size:10px;">원
      </div>
      <div style="color:#9ca3af;font-size:9px;">※ 원가를 적으면 할인율은 무시 · 저장하면 이 주문의 게러지(주문확인) T열(개별원가)에 그대로 반영됨</div>
      <div style="font-size:10px;color:#6b7280;">공장도가 <b>${comma(factoryPrice)}원</b></div>
      <div style="font-size:10px;color:#6b7280;" id="${manualId}-dc">할인율 <b>${savedDc!==""?savedDc+"%":(savedCost!==""?"원가직접입력":"-")}</b></div>
      <div style="font-size:10px;color:#374151;" id="${manualId}-cost">원가 <b>-</b></div>
      <div style="font-size:10px;color:#374151;">배송비 <b>${comma(withShipping ? shipTotalAll : 0)}원</b></div>
      <div style="font-size:10px;" id="${manualId}-unit-out">개당마진 <b>-</b></div>
      <div style="font-size:10px;" id="${manualId}-out">전체마진 <b>-</b></div>
      <button class="btn-sky btn-sm margin-manual-save" data-group="${groupKey}" data-orderid="${orderId}" style="margin-top:4px;font-size:10px;">💾 이 주문에 저장</button>
      ${savedOv ? `<button class="btn-gray btn-sm margin-manual-clear" data-orderid="${orderId}" style="margin-top:4px;font-size:10px;">✕ 저장취소</button>` : ""}
    </div>`;
    return `<div style="flex-basis:100%;font-weight:700;color:#1e40af;font-size:11px;margin-top:4px;">${title}</div>${cards}${manualCard}`;
  };

  if (!matches.length) {
    box.innerHTML = `<div style="flex-basis:100%;color:#9ca3af;font-size:10px;margin-bottom:4px;">일치하는 마진탭 규칙이 없습니다 (⚙️ 마진탭 설정에서 등록하세요) — 아래에서 직접 계산은 가능합니다</div>`
      + renderGroup("직배송", false, "direct") + renderGroup("택배", true, "parcel");
  } else {
    box.innerHTML = renderGroup("직배송", false, "direct") + renderGroup("택배", true, "parcel");
  }

  // 할인율 또는 원가 직접입력 → 실시간 원가·마진 계산 (원가가 입력돼 있으면 원가 우선, 할인율은 무시)
  const recalcManual = group => {
    const withShipping = box.querySelector(`.margin-manual-dc[data-group="${group}"]`)?.dataset.withShip === "1";
    const dcInp   = box.querySelector(`.margin-manual-dc[data-group="${group}"]`);
    const costInp = box.querySelector(`.margin-manual-cost[data-group="${group}"]`);
    const costOut = document.getElementById(`margin-manual-${group}-cost`);
    const dcOut   = document.getElementById(`margin-manual-${group}-dc`);
    const unitOut = document.getElementById(`margin-manual-${group}-unit-out`);
    const out     = document.getElementById(`margin-manual-${group}-out`);
    const costRaw = costInp?.value;
    const dc = parseFloat(dcInp?.value);
    let unitCost, usedCostDirectly = false;
    if (costRaw !== "" && costRaw !== undefined && !isNaN(parseFloat(costRaw))) {
      unitCost = parseInt(String(costRaw).replace(/[^\d]/g,""), 10) || 0;
      usedCostDirectly = true;
    } else if (!isNaN(dc)) {
      unitCost = Math.round(factoryPrice * (1 - dc / 100));
    } else {
      if (costOut) costOut.innerHTML = "원가 <b>-</b>";
      if (dcOut) dcOut.innerHTML = "할인율 <b>-</b>";
      if (unitOut) unitOut.innerHTML = "개당마진 <b>-</b>";
      if (out) out.innerHTML = "전체마진 <b>-</b>";
      return;
    }
    const cost = unitCost * qtyNum;
    const margin = withShipping ? (settle - cost - shipTotalAll) : (settle - cost);
    const marginPerUnit = Math.round(margin / qtyNum);
    const marginColor = margin >= 0 ? "#16a34a" : "#dc2626";
    if (costOut) costOut.innerHTML = `원가 <b>${comma(cost)}원</b>${qtyNum>1?` <span style="color:#9ca3af;">(개당 ${comma(unitCost)}원×${qtyNum})</span>`:""}${usedCostDirectly?` <span style="color:#f59e0b;">(직접입력)</span>`:""}`;
    if (dcOut) dcOut.innerHTML = usedCostDirectly ? "할인율 <b>원가직접입력</b>" : `할인율 <b>${dc}%</b>`;
    if (unitOut) unitOut.innerHTML = `개당마진 <b style="color:${marginColor}">${comma(marginPerUnit)}원</b>`;
    if (out) out.innerHTML = `전체마진 <b style="color:${marginColor}">${comma(margin)}원</b>`;
  };
  box.querySelectorAll(".margin-manual-dc, .margin-manual-cost").forEach(inp => {
    inp.addEventListener("input", () => recalcManual(inp.dataset.group));
  });
  box.querySelectorAll(".margin-manual-save").forEach(btn => {
    btn.addEventListener("click", async () => {
      const group = btn.dataset.group;
      const oid   = btn.dataset.orderid;
      const dcInp   = box.querySelector(`.margin-manual-dc[data-group="${group}"]`);
      const costInp = box.querySelector(`.margin-manual-cost[data-group="${group}"]`);
      const dcRaw   = dcInp?.value;
      const costRaw = costInp?.value;
      if ((dcRaw === "" || dcRaw === undefined) && (costRaw === "" || costRaw === undefined)) {
        alert("할인율 또는 원가를 입력한 후 저장하세요."); return;
      }
      const ov = {
        discountPct:  (costRaw !== "" && costRaw !== undefined) ? null : (parseFloat(dcRaw) || 0),
        costOverride: (costRaw !== "" && costRaw !== undefined) ? (parseInt(String(costRaw).replace(/[^\d]/g,""),10) || 0) : null,
      };
      await saveOrderCostOverride(oid, ov);
      st(`✅ 주문 #${oid} 원가 직접입력 저장 완료 — 게러지 T열에 반영됩니다`);
      _showOrderDetail(oid); // 저장됨 표시 갱신
      _renderGarageGrid(); // 이미 로드된 게러지 그리드에도 즉시 반영
    });
  });
  box.querySelectorAll(".margin-manual-clear").forEach(btn => {
    btn.addEventListener("click", async () => {
      const oid = btn.dataset.orderid;
      if (!confirm("저장된 원가 직접입력을 취소할까요? (마진탭 매칭 기준으로 돌아갑니다)")) return;
      await clearOrderCostOverride(oid);
      st(`↩️ 주문 #${oid} 원가 직접입력 저장취소`);
      _showOrderDetail(oid);
      _renderGarageGrid();
    });
  });
}

function showMarginTabsSettings() {
  document.getElementById("margintabs-settings-popup")?.remove();
  const popup = document.createElement("div");
  popup.id = "margintabs-settings-popup";
  popup.style.cssText = "position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.35);z-index:20000;display:flex;align-items:center;justify-content:center;";

  let _mtEditingId = null; // 현재 인라인 편집 중인 규칙 id
  let _ssCollapsed = true; // 사이즈별 택배비 섹션 접힘 상태 (기본 접힘)
  const _mtExpandedTabs = new Set(); // 펼쳐진 마진탭 id들 (기본 전부 접힘)
  let _mtDeleteMode = false; // 탭삭제 모드 (켜지면 탭 클릭 시 펼치기 대신 삭제선택)
  const _mtTabsToDelete = new Set(); // 삭제 모드에서 선택된 탭 id들
  const renderTabsHtml = () => _marginTabs.map(tab => {
    const isEx = !!tab.isException;
    const colCount = isEx ? 11 : 9; // 체크박스+제조사+상품명+(사이즈)+(DOT)+세부정보+할인율+원가+기준인치+이상할인율+버튼
    const rows = tab.rules.map(r => {
      if (r.id === _mtEditingId) {
        return `
            <tr style="background:#fffbeb;">
              <td style="padding:2px;border:1px solid #e5e7eb;"></td>
              <td style="padding:2px;border:1px solid #e5e7eb;"><input type="text" class="mt-edit-mfr" value="${escHtml(r.manufacturer)}" style="width:100%;padding:2px 3px;border:1px solid #d1d5db;border-radius:3px;font-size:10px;"></td>
              <td style="padding:2px;border:1px solid #e5e7eb;"><input type="text" class="mt-edit-prod" value="${escHtml(r.productContains)}" style="width:100%;padding:2px 3px;border:1px solid #d1d5db;border-radius:3px;font-size:10px;"></td>
              ${isEx ? `<td style="padding:2px;border:1px solid #e5e7eb;"><input type="text" class="mt-edit-size" value="${escHtml(r.sizeContains||"")}" style="width:100%;padding:2px 3px;border:1px solid #d1d5db;border-radius:3px;font-size:10px;"></td>` : ""}
              ${isEx ? `<td style="padding:2px;border:1px solid #e5e7eb;"><input type="text" class="mt-edit-dot" value="${escHtml(r.dot||"")}" placeholder="예: 2024" style="width:100%;padding:2px 3px;border:1px solid #d1d5db;border-radius:3px;font-size:10px;"></td>` : ""}
              <td style="padding:2px;border:1px solid #e5e7eb;"><input type="text" class="mt-edit-detail" value="${escHtml(r.detailContains||"")}" style="width:100%;padding:2px 3px;border:1px solid #d1d5db;border-radius:3px;font-size:10px;"></td>
              <td style="padding:2px;border:1px solid #e5e7eb;"><input type="number" class="mt-edit-dc" value="${r.discountPct}" style="width:100%;padding:2px 3px;border:1px solid #d1d5db;border-radius:3px;font-size:10px;"></td>
              <td style="padding:2px;border:1px solid #e5e7eb;"><input type="number" class="mt-edit-cost" value="${r.costOverride ?? ""}" style="width:100%;padding:2px 3px;border:1px solid #d1d5db;border-radius:3px;font-size:10px;"></td>
              <td style="padding:2px;border:1px solid #e5e7eb;"><input type="number" class="mt-edit-inch" value="${r.inchThreshold ?? ""}" placeholder="예: 18" style="width:100%;padding:2px 3px;border:1px solid #d1d5db;border-radius:3px;font-size:10px;"></td>
              <td style="padding:2px;border:1px solid #e5e7eb;"><input type="number" class="mt-edit-dc-above" value="${r.discountPctAbove ?? ""}" placeholder="예: 52" style="width:100%;padding:2px 3px;border:1px solid #d1d5db;border-radius:3px;font-size:10px;"></td>
              <td style="padding:3px;border:1px solid #e5e7eb;text-align:center;white-space:nowrap;">
                <button class="btn-sky btn-sm mt-save-edit" data-tid="${tab.id}" data-rid="${r.id}">💾</button>
                <button class="btn-gray btn-sm mt-cancel-edit">✕</button>
              </td>
            </tr>`;
      }
      return `
            <tr>
              <td style="padding:3px;border:1px solid #e5e7eb;text-align:center;"><input type="checkbox" class="mt-row-chk" data-tid="${tab.id}" data-rid="${r.id}"></td>
              <td style="padding:3px;border:1px solid #e5e7eb;text-align:center;">${escHtml(r.manufacturer)}</td>
              <td style="padding:3px;border:1px solid #e5e7eb;text-align:center;">${escHtml(r.productContains)}</td>
              ${isEx ? `<td style="padding:3px;border:1px solid #e5e7eb;text-align:center;${r.sizeContains?"":"color:#d1d5db;"}">${r.sizeContains?escHtml(r.sizeContains):"-"}</td>` : ""}
              ${isEx ? `<td style="padding:3px;border:1px solid #e5e7eb;text-align:center;${r.dot?"":"color:#d1d5db;"}">${r.dot?escHtml(r.dot):"-"}</td>` : ""}
              <td style="padding:3px;border:1px solid #e5e7eb;text-align:center;${r.detailContains?"":"color:#d1d5db;"}">${r.detailContains?escHtml(r.detailContains):"-"}</td>
              <td style="padding:3px;border:1px solid #e5e7eb;text-align:center;${r.costOverride!=null?"color:#9ca3af;text-decoration:line-through;":""}">${r.discountPct}%</td>
              <td style="padding:3px;border:1px solid #e5e7eb;text-align:center;${r.costOverride!=null?"font-weight:700;color:#16a34a;":"color:#9ca3af;"}">${r.costOverride!=null?comma(r.costOverride)+"원":"-"}</td>
              <td style="padding:3px;border:1px solid #e5e7eb;text-align:center;${r.inchThreshold!=null?"":"color:#d1d5db;"}">${r.inchThreshold!=null?r.inchThreshold+"인치~":"-"}</td>
              <td style="padding:3px;border:1px solid #e5e7eb;text-align:center;${r.discountPctAbove!=null?"":"color:#d1d5db;"}">${r.discountPctAbove!=null?r.discountPctAbove+"%":"-"}</td>
              <td style="padding:3px;border:1px solid #e5e7eb;text-align:center;white-space:nowrap;">
                <button class="btn-gray btn-sm mt-edit-rule" data-tid="${tab.id}" data-rid="${r.id}">✎</button>
                <button class="btn-gray btn-sm mt-del-rule" data-tid="${tab.id}" data-rid="${r.id}">✕</button>
              </td>
            </tr>`;
    }).join("") || `<tr><td colspan="${colCount}" style="padding:6px;text-align:center;color:#9ca3af;">규칙 없음</td></tr>`;

    const isOpen = _mtExpandedTabs.has(tab.id);
    const isMarkedForDelete = _mtTabsToDelete.has(tab.id);
    return `
    <div style="border:1px solid ${isMarkedForDelete?"#dc2626":(isEx?"#f59e0b":"#d1d5db")};border-radius:6px;padding:8px;margin-bottom:8px;${isMarkedForDelete?"background:#fef2f2;":(isEx?"background:#fffbeb;":"")}">
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:${isOpen?"6px":"0"};cursor:pointer;" class="mt-tab-toggle" data-tid="${tab.id}">
        ${_mtDeleteMode
          ? `<input type="checkbox" class="mt-tab-del-chk" data-tid="${tab.id}" ${isMarkedForDelete?"checked":""} style="cursor:pointer;">`
          : `<span style="font-size:10px;color:#6b7280;width:12px;">${isOpen ? "▼" : "▶"}</span>`}
        <strong style="color:${isMarkedForDelete?"#dc2626":(isEx?"#b45309":"#1e40af")};">${isEx?"⚡ ":""}${escHtml(tab.name)}${isEx?" (예외탭 · 최우선)":""}</strong>
        <span style="color:#9ca3af;font-size:10px;">(${tab.rules.length}건)</span>
      </div>
      ${(!isOpen || _mtDeleteMode) ? "" : `
      <table style="width:100%;border-collapse:collapse;font-size:10px;margin-bottom:6px;">
        <thead><tr style="background:#f1f5f9;">
          <th style="padding:3px;border:1px solid #e5e7eb;"><input type="checkbox" class="mt-check-all" data-tid="${tab.id}"></th>
          <th style="padding:3px;border:1px solid #e5e7eb;">제조사(일치)</th>
          <th style="padding:3px;border:1px solid #e5e7eb;">상품명(포함)</th>
          ${isEx ? `<th style="padding:3px;border:1px solid #e5e7eb;">사이즈(포함,선택)</th>` : ""}
          ${isEx ? `<th style="padding:3px;border:1px solid #e5e7eb;">DOT(일치,선택)</th>` : ""}
          <th style="padding:3px;border:1px solid #e5e7eb;">세부정보(포함,선택)</th>
          <th style="padding:3px;border:1px solid #e5e7eb;">할인율%</th>
          <th style="padding:3px;border:1px solid #e5e7eb;">원가(직접입력)</th>
          <th style="padding:3px;border:1px solid #e5e7eb;" title="인치별로 할인율을 다르게 적용하고 싶을 때 사용. 예: 기준인치=18, 할인율%=50(미만용), 이상할인율%=52 → 17인치 이하는 50%, 18인치 이상은 52%">기준인치(선택)</th>
          <th style="padding:3px;border:1px solid #e5e7eb;">이상할인율%(선택)</th>
          <th style="padding:3px;border:1px solid #e5e7eb;"></th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div style="margin-bottom:4px;"><button class="btn-gray btn-sm mt-del-selected" data-tid="${tab.id}" style="color:#dc2626;">🗑 선택 삭제</button></div>
      <div style="display:flex;gap:4px;flex-wrap:wrap;">
        <input type="text" class="mt-new-mfr" data-tid="${tab.id}" placeholder="제조사 (예: 넥센)" style="width:90px;padding:3px 5px;border:1px solid #d1d5db;border-radius:4px;font-size:10px;">
        <input type="text" class="mt-new-prod" data-tid="${tab.id}" placeholder="상품명 일부 (예: CP321)" style="width:110px;padding:3px 5px;border:1px solid #d1d5db;border-radius:4px;font-size:10px;">
        ${isEx ? `<input type="text" class="mt-new-size" data-tid="${tab.id}" placeholder="사이즈(선택, 예: 145/80R13)" style="width:110px;padding:3px 5px;border:1px solid #d1d5db;border-radius:4px;font-size:10px;">` : ""}
        ${isEx ? `<input type="text" class="mt-new-dot" data-tid="${tab.id}" placeholder="DOT(선택, 예: 2024)" style="width:90px;padding:3px 5px;border:1px solid #d1d5db;border-radius:4px;font-size:10px;">` : ""}
        <input type="text" class="mt-new-detail" data-tid="${tab.id}" placeholder="세부정보(선택)" style="width:90px;padding:3px 5px;border:1px solid #d1d5db;border-radius:4px;font-size:10px;">
        <input type="number" class="mt-new-dc" data-tid="${tab.id}" placeholder="할인율%" style="width:60px;padding:3px 5px;border:1px solid #d1d5db;border-radius:4px;font-size:10px;">
        <input type="number" class="mt-new-cost" data-tid="${tab.id}" placeholder="원가(직접입력, 선택)" style="width:110px;padding:3px 5px;border:1px solid #d1d5db;border-radius:4px;font-size:10px;">
        <input type="number" class="mt-new-inch" data-tid="${tab.id}" placeholder="기준인치(선택,예:18)" style="width:110px;padding:3px 5px;border:1px solid #d1d5db;border-radius:4px;font-size:10px;">
        <input type="number" class="mt-new-dc-above" data-tid="${tab.id}" placeholder="이상할인율%(선택)" style="width:110px;padding:3px 5px;border:1px solid #d1d5db;border-radius:4px;font-size:10px;">
        <button class="btn-sky btn-sm mt-add-rule" data-tid="${tab.id}">+ 규칙추가</button>
      </div>
      <div style="color:#9ca3af;font-size:9px;margin-top:2px;">※ 원가를 입력하면 할인율 계산은 건너뛰고 입력한 원가를 그대로 사용합니다 (할인율은 비워둬도 됨) · 세부정보는 안 적어도 되고, 적으면 타이어핑 제품정보의 세부정보에 그 문자열이 포함될 때만 매칭됩니다 · 기준인치를 입력하면 그 인치 미만은 "할인율%", 그 인치 이상은 "이상할인율%"가 적용됩니다(예: 기준인치18, 할인율50, 이상할인율52 → 17인치 이하 50%, 18인치 이상 52%)${isEx?" · 예외탭은 사이즈가 선택사항입니다 — 상품명+사이즈가 모두 일치하면 1순위, 상품명만 일치해도 2순위로 매칭되며, 매칭되면 다른 탭보다 최우선 적용됩니다":""}</div>
      <div style="margin-top:8px;border-top:1px dashed #d1d5db;padding-top:6px;">
        <div style="font-size:10px;color:#6b7280;margin-bottom:3px;">📋 엑셀에서 복사해 붙여넣기 (제조사 [Tab] 상품명 [Tab] ${isEx?"사이즈(선택) [Tab] DOT(선택) [Tab] ":""}세부정보(선택) [Tab] 할인율 [Tab] 원가(선택)) — 여러 줄 한 번에 추가</div>
        <textarea class="mt-bulk-paste" data-tid="${tab.id}" data-exception="${isEx?1:0}" placeholder="${isEx?"넥센\tCP321\t145/80R13\t2024\t\t40":"넥센\tCP321\t\t40"}" rows="3" style="width:100%;font-size:10px;padding:4px;border:1px solid #d1d5db;border-radius:4px;resize:vertical;"></textarea>
        <button class="btn-sky btn-sm mt-bulk-add" data-tid="${tab.id}" style="margin-top:3px;">📥 일괄추가</button>
      </div>`}
    </div>
  `; }).join("") || `<div style="color:#9ca3af;text-align:center;padding:10px;">아직 마진 탭이 없습니다. 아래에서 추가하세요.</div>`;

  let _ssEditingId = null; // 현재 인라인 편집 중인 규칙 id (한 번에 하나만 편집)
  const renderShipSizeHtml = () => {
    const rows = _shipSizeRules.map(r => {
      if (r.id === _ssEditingId) {
        // 편집 모드: 값들을 입력칸으로 표시
        return `
      <tr style="background:#fffbeb;">
        <td style="padding:3px;border:1px solid #e5e7eb;text-align:center;"></td>
        <td style="padding:2px;border:1px solid #e5e7eb;"><input type="text" class="ss-edit-size" value="${escHtml(r.size)}" style="width:100%;padding:2px 3px;border:1px solid #d1d5db;border-radius:3px;font-size:10px;"></td>
        <td style="padding:2px;border:1px solid #e5e7eb;"><input type="number" class="ss-edit-price" value="${r.price}" style="width:100%;padding:2px 3px;border:1px solid #d1d5db;border-radius:3px;font-size:10px;"></td>
        <td style="padding:2px;border:1px solid #e5e7eb;text-align:center;"><input type="checkbox" class="ss-edit-bundle" ${r.bundle?"checked":""}></td>
        <td style="padding:2px;border:1px solid #e5e7eb;"><input type="number" class="ss-edit-bundle-price" value="${r.bundlePrice}" style="width:100%;padding:2px 3px;border:1px solid #d1d5db;border-radius:3px;font-size:10px;"></td>
        <td style="padding:3px;border:1px solid #e5e7eb;text-align:center;white-space:nowrap;">
          <button class="btn-sky btn-sm ss-save-edit" data-rid="${r.id}">💾</button>
          <button class="btn-gray btn-sm ss-cancel-edit">✕</button>
        </td>
      </tr>`;
      }
      return `
      <tr>
        <td style="padding:3px;border:1px solid #e5e7eb;text-align:center;"><input type="checkbox" class="ss-row-chk" data-rid="${r.id}"></td>
        <td style="padding:3px;border:1px solid #e5e7eb;text-align:center;">${escHtml(r.size)}</td>
        <td style="padding:3px;border:1px solid #e5e7eb;text-align:center;${r.bundle?"color:#9ca3af;text-decoration:line-through;":""}">${comma(r.price)}원</td>
        <td style="padding:3px;border:1px solid #e5e7eb;text-align:center;">${r.bundle?"O":"-"}</td>
        <td style="padding:3px;border:1px solid #e5e7eb;text-align:center;${r.bundle?"font-weight:700;color:#16a34a;":"color:#d1d5db;"}">${r.bundle?comma(r.bundlePrice)+"원":"-"}</td>
        <td style="padding:3px;border:1px solid #e5e7eb;text-align:center;white-space:nowrap;">
          <button class="btn-gray btn-sm ss-edit-rule" data-rid="${r.id}">✎</button>
          <button class="btn-gray btn-sm ss-del-rule" data-rid="${r.id}">✕</button>
        </td>
      </tr>`;
    }).join("") || `<tr><td colspan="6" style="padding:6px;text-align:center;color:#9ca3af;">등록된 사이즈 없음 (없으면 위 전역 택배가격 사용)</td></tr>`;
    return `
    <div style="border:1px solid #d1d5db;border-radius:6px;padding:8px;margin-bottom:8px;">
      <div style="display:flex;align-items:center;gap:6px;cursor:pointer;" id="ss-toggle">
        <span style="font-size:10px;color:#6b7280;width:12px;">${_ssCollapsed ? "▶" : "▼"}</span>
        <strong style="color:#0369a1;">🚚 사이즈별 택배비</strong>
        <span style="color:#9ca3af;font-size:10px;">(${_shipSizeRules.length}건)</span>
        <button class="btn-gray btn-sm" id="ss-refresh" style="margin-left:auto;">🔄 새로고침</button>
      </div>
      ${_ssCollapsed ? "" : `
      <table style="width:100%;border-collapse:collapse;font-size:10px;margin:6px 0;">
        <thead><tr style="background:#f1f5f9;">
          <th style="padding:3px;border:1px solid #e5e7eb;"><input type="checkbox" id="ss-check-all"></th>
          <th style="padding:3px;border:1px solid #e5e7eb;">사이즈(일치)</th>
          <th style="padding:3px;border:1px solid #e5e7eb;">배송비</th>
          <th style="padding:3px;border:1px solid #e5e7eb;">묶음</th>
          <th style="padding:3px;border:1px solid #e5e7eb;">묶음배송비</th>
          <th style="padding:3px;border:1px solid #e5e7eb;"></th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div style="display:flex;gap:4px;flex-wrap:wrap;align-items:center;margin-bottom:4px;">
        <button class="btn-gray btn-sm" id="ss-del-selected" style="color:#dc2626;">🗑 선택 삭제</button>
      </div>
      <div style="display:flex;gap:4px;flex-wrap:wrap;align-items:center;">
        <input type="text" id="ss-new-size" placeholder="사이즈 (예: 145/80R13)" style="width:110px;padding:3px 5px;border:1px solid #d1d5db;border-radius:4px;font-size:10px;">
        <input type="number" id="ss-new-price" placeholder="배송비" style="width:70px;padding:3px 5px;border:1px solid #d1d5db;border-radius:4px;font-size:10px;">
        <label style="display:flex;align-items:center;gap:3px;font-size:10px;"><input type="checkbox" id="ss-new-bundle"> 묶음</label>
        <input type="number" id="ss-new-bundle-price" placeholder="묶음배송비" style="width:80px;padding:3px 5px;border:1px solid #d1d5db;border-radius:4px;font-size:10px;">
        <button class="btn-sky btn-sm" id="ss-add-rule">+ 추가</button>
      </div>
      <div style="color:#9ca3af;font-size:9px;margin-top:2px;">※ 묶음 체크 시: 2개씩 묶음배송비, 남는 1개는 배송비로 계산 (예: 3개=묶음배송비+배송비, 4개=묶음배송비×2)</div>
      <div style="margin-top:8px;border-top:1px dashed #d1d5db;padding-top:6px;">
        <div style="font-size:10px;color:#6b7280;margin-bottom:3px;">📋 엑셀에서 복사해 붙여넣기 (사이즈 [Tab] 배송비 [Tab] 묶음(O 또는 빈칸) [Tab] 묶음배송비) — 여러 줄 한 번에 추가</div>
        <textarea id="ss-bulk-paste" placeholder="145/80R13	4000	O	6000&#10;185/65R14	5000" rows="3" style="width:100%;font-size:10px;padding:4px;border:1px solid #d1d5db;border-radius:4px;resize:vertical;"></textarea>
        <button class="btn-sky btn-sm" id="ss-bulk-add" style="margin-top:3px;">📥 일괄추가</button>
      </div>`}
    </div>`;
  };

  popup.innerHTML = `
    <div style="background:#fff;border-radius:10px;padding:16px;width:460px;max-width:94vw;max-height:80vh;overflow:auto;font-size:12px;box-shadow:0 8px 24px rgba(0,0,0,.25);">
      <div style="font-weight:700;font-size:13px;margin-bottom:10px;color:#1e40af;">⚙️ 마진 탭 설정</div>
      <label style="display:block;margin-bottom:10px;">
        수수료율(%) <input type="number" step="0.01" id="mt-fee-rate" value="${feeRatePct}" style="width:70px;padding:3px 5px;border:1px solid #d1d5db;border-radius:4px;font-size:11px;margin-left:4px;">
        택배가격(원) <input type="number" id="mt-ship-cost" value="${shippingCostDefault}" style="width:80px;padding:3px 5px;border:1px solid #d1d5db;border-radius:4px;font-size:11px;margin-left:4px;">
        <span style="color:#9ca3af;font-size:10px;">(사이즈별 규칙이 없을 때만 쓰이는 기본값)</span>
      </label>
      <div id="ss-section">${renderShipSizeHtml()}</div>
      ${_mtDeleteMode ? `<div style="background:#fef2f2;border:1px solid #fecaca;color:#dc2626;font-size:11px;padding:6px 8px;border-radius:6px;margin-bottom:8px;">🗑 삭제모드 — 삭제할 탭을 클릭해서 선택한 후, 아래 "선택한 N개 삭제" 버튼을 누르세요.</div>` : ""}
      <div id="mt-tabs-list">${renderTabsHtml()}</div>
      <div style="display:flex;gap:6px;margin:10px 0;">
        <input type="text" id="mt-new-tab-name" placeholder="새 탭 이름 (예: 창고, 거래처)" style="flex:1;padding:4px 6px;border:1px solid #d1d5db;border-radius:4px;font-size:11px;">
        <button class="btn-sky btn-sm" id="mt-add-tab">+ 탭 추가</button>
        <button class="btn-sky btn-sm" id="mt-add-exception-tab" style="background:#f59e0b;">⚡ + 예외탭 추가</button>
        ${_mtDeleteMode
          ? `<button class="btn-red btn-sm" id="mt-del-mode-confirm">🗑 선택한 ${_mtTabsToDelete.size}개 삭제</button>
             <button class="btn-gray btn-sm" id="mt-del-mode-cancel">취소</button>`
          : `<button class="btn-gray btn-sm" id="mt-del-mode-start" style="color:#dc2626;">🗑 탭삭제</button>`}
      </div>
      <div style="display:flex;gap:6px;justify-content:flex-end;">
        <button class="btn-gray btn-sm" id="mt-refresh">🔄 새로고침</button>
        <button class="btn-gray btn-sm" id="mt-close">닫기</button>
        <button class="btn-sky btn-sm" id="mt-save-fee">수수료율/택배가격 저장</button>
      </div>
    </div>`;
  document.body.appendChild(popup);

  const rerenderSs = () => {
    document.getElementById("ss-section").innerHTML = renderShipSizeHtml();
    bindSsButtons();
  };
  const rerender = () => {
    document.getElementById("mt-tabs-list").innerHTML = renderTabsHtml();
    bindRuleButtons();
  };
  const bindSsButtons = () => {
    popup.querySelector("#ss-toggle")?.addEventListener("click", (e) => {
      if (e.target.closest("#ss-refresh")) return; // 새로고침 버튼 클릭은 토글 안 함
      _ssCollapsed = !_ssCollapsed;
      rerenderSs();
    });
    popup.querySelector("#ss-refresh")?.addEventListener("click", async () => {
      st("🔄 사이즈별 택배비 서버에서 가져오는 중...");
      const result = await loadShipSizeRules();
      rerenderSs();
      if (result?.ok) {
        st(`✅ 택배비 새로고침 완료 — ${_shipSizeRules.length}건 (서버에서 정상 로드됨)`);
      } else {
        st(`❌ 서버 로드 실패: ${result?.error || "알 수 없는 오류"} — 로컬 저장된 내용만 표시 중`);
        alert(`Supabase 로드 실패:\n${result?.error || "알 수 없는 오류"}\n\nsupabase_ship_size_rules.sql이 정상 실행됐는지 확인해주세요.`);
      }
    });
    popup.querySelector("#ss-add-rule")?.addEventListener("click", () => {
      const size = popup.querySelector("#ss-new-size").value;
      const price = popup.querySelector("#ss-new-price").value;
      const bundle = popup.querySelector("#ss-new-bundle").checked;
      const bundlePrice = popup.querySelector("#ss-new-bundle-price").value;
      if (!size.trim()) { alert("사이즈를 입력하세요."); return; }
      if (!bundle && price === "") { alert("배송비를 입력하거나 묶음을 체크하고 묶음배송비를 입력하세요."); return; }
      if (bundle && bundlePrice === "") { alert("묶음배송비를 입력하세요."); return; }
      addShipSizeRule(size, price || 0, bundle, bundlePrice || 0);
      rerenderSs();
    });
    popup.querySelectorAll(".ss-del-rule").forEach(btn => {
      btn.addEventListener("click", () => { deleteShipSizeRule(btn.dataset.rid); rerenderSs(); });
    });
    // 전체선택 체크박스
    popup.querySelector("#ss-check-all")?.addEventListener("change", (e) => {
      popup.querySelectorAll(".ss-row-chk").forEach(cb => { cb.checked = e.target.checked; });
    });
    // 선택 삭제
    popup.querySelector("#ss-del-selected")?.addEventListener("click", () => {
      const ids = [...popup.querySelectorAll(".ss-row-chk:checked")].map(cb => cb.dataset.rid);
      if (!ids.length) { alert("삭제할 항목을 먼저 체크하세요."); return; }
      if (!confirm(`선택한 ${ids.length}개 사이즈 규칙을 삭제할까요?`)) return;
      deleteShipSizeRules(ids);
      rerenderSs();
    });
    // 인라인 편집 시작
    popup.querySelectorAll(".ss-edit-rule").forEach(btn => {
      btn.addEventListener("click", () => { _ssEditingId = btn.dataset.rid; rerenderSs(); });
    });
    // 편집 저장
    popup.querySelectorAll(".ss-save-edit").forEach(btn => {
      btn.addEventListener("click", () => {
        const tr = btn.closest("tr");
        const size = tr.querySelector(".ss-edit-size").value;
        const price = tr.querySelector(".ss-edit-price").value;
        const bundle = tr.querySelector(".ss-edit-bundle").checked;
        const bundlePrice = tr.querySelector(".ss-edit-bundle-price").value;
        if (!size.trim()) { alert("사이즈를 입력하세요."); return; }
        updateShipSizeRule(btn.dataset.rid, size, price, bundle, bundlePrice);
        _ssEditingId = null;
        rerenderSs();
        st("✅ 배송비 수정됨");
      });
    });
    // 편집 취소
    popup.querySelectorAll(".ss-cancel-edit").forEach(btn => {
      btn.addEventListener("click", () => { _ssEditingId = null; rerenderSs(); });
    });
    popup.querySelector("#ss-bulk-add")?.addEventListener("click", () => {
      const ta = popup.querySelector("#ss-bulk-paste");
      const raw = ta?.value || "";
      const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      if (!lines.length) { alert("붙여넣을 내용이 없습니다."); return; }
      let added = 0, skipped = 0;
      for (const line of lines) {
        const cols = line.split(/\t|,/).map(c => c.trim());
        if (cols[0] === "사이즈" || cols[0] === "size") { skipped++; continue; }
        const [size, priceRaw, bundleRaw, bundlePriceRaw] = cols;
        if (!size) { skipped++; continue; }
        const bundle = (bundleRaw || "").toUpperCase() === "O";
        const price = (priceRaw || "").replace(/[^\d]/g,"");
        const bundlePrice = (bundlePriceRaw || "").replace(/[^\d]/g,"");
        if (!bundle && price === "") { skipped++; continue; }
        addShipSizeRule(size, price || 0, bundle, bundlePrice || 0);
        added++;
      }
      if (ta) ta.value = "";
      rerenderSs();
      st(`✅ 사이즈별 택배비 일괄추가 완료: ${added}건 추가${skipped ? `, ${skipped}건 건너뜀` : ""}`);
    });
  };
  bindSsButtons();
  const bindRuleButtons = () => {
    popup.querySelectorAll(".mt-tab-toggle").forEach(el => {
      el.addEventListener("click", (e) => {
        const tid = el.dataset.tid;
        if (_mtDeleteMode) {
          if (_mtTabsToDelete.has(tid)) _mtTabsToDelete.delete(tid);
          else _mtTabsToDelete.add(tid);
          rerender();
          return;
        }
        if (e.target.closest(".mt-del-tab")) return; // 탭삭제 버튼 클릭은 토글 안 함
        if (_mtExpandedTabs.has(tid)) _mtExpandedTabs.delete(tid);
        else _mtExpandedTabs.add(tid);
        rerender();
      });
    });
    popup.querySelectorAll(".mt-add-rule").forEach(btn => {
      btn.addEventListener("click", () => {
        const tid = btn.dataset.tid;
        const tab = _marginTabs.find(t => t.id === tid);
        const mfr = popup.querySelector(`.mt-new-mfr[data-tid="${tid}"]`).value;
        const prod = popup.querySelector(`.mt-new-prod[data-tid="${tid}"]`).value;
        const sizeInp = popup.querySelector(`.mt-new-size[data-tid="${tid}"]`);
        const size = sizeInp ? sizeInp.value : "";
        const dotInp = popup.querySelector(`.mt-new-dot[data-tid="${tid}"]`);
        const dotVal = dotInp ? dotInp.value : "";
        const detail = popup.querySelector(`.mt-new-detail[data-tid="${tid}"]`).value;
        const dc = popup.querySelector(`.mt-new-dc[data-tid="${tid}"]`).value;
        const cost = popup.querySelector(`.mt-new-cost[data-tid="${tid}"]`).value;
        const inchThreshold = popup.querySelector(`.mt-new-inch[data-tid="${tid}"]`)?.value ?? "";
        const dcAbove = popup.querySelector(`.mt-new-dc-above[data-tid="${tid}"]`)?.value ?? "";
        if (!mfr.trim() || !prod.trim()) { alert("제조사·상품명을 입력하세요."); return; }
        if (dc === "" && cost === "") { alert("할인율 또는 원가 중 하나는 입력해야 합니다."); return; }
        addMarginRule(tid, mfr, prod, dc || 0, cost, detail, size, dotVal, inchThreshold, dcAbove);
        rerender();
      });
    });
    popup.querySelectorAll(".mt-del-rule").forEach(btn => {
      btn.addEventListener("click", () => { deleteMarginRule(btn.dataset.tid, btn.dataset.rid); rerender(); });
    });
    popup.querySelector("#mt-del-mode-start")?.addEventListener("click", () => {
      _mtDeleteMode = true;
      _mtTabsToDelete.clear();
      rerender();
    });
    popup.querySelector("#mt-del-mode-cancel")?.addEventListener("click", () => {
      _mtDeleteMode = false;
      _mtTabsToDelete.clear();
      rerender();
    });
    popup.querySelector("#mt-del-mode-confirm")?.addEventListener("click", async () => {
      if (!_mtTabsToDelete.size) { alert("삭제할 탭을 먼저 선택하세요."); return; }
      const names = [..._mtTabsToDelete].map(tid => _marginTabs.find(t => t.id === tid)?.name || tid).join(", ");
      if (!confirm(`선택한 탭 ${_mtTabsToDelete.size}개(${names})와 안의 규칙을 모두 삭제할까요?`)) return;
      for (const tid of _mtTabsToDelete) await deleteMarginTab(tid);
      _mtDeleteMode = false;
      _mtTabsToDelete.clear();
      rerender();
    });
    popup.querySelectorAll(".mt-tab-del-chk").forEach(cb => {
      cb.addEventListener("click", e => e.stopPropagation()); // 체크박스 자체 클릭은 헤더 클릭과 중복 토글되지 않도록
      cb.addEventListener("change", () => {
        const tid = cb.dataset.tid;
        if (cb.checked) _mtTabsToDelete.add(tid); else _mtTabsToDelete.delete(tid);
        rerender();
      });
    });
    // 탭별 전체선택 체크박스
    popup.querySelectorAll(".mt-check-all").forEach(cb => {
      cb.addEventListener("change", () => {
        const tid = cb.dataset.tid;
        popup.querySelectorAll(`.mt-row-chk[data-tid="${tid}"]`).forEach(rowCb => { rowCb.checked = cb.checked; });
      });
    });
    // 선택 삭제 (탭별)
    popup.querySelectorAll(".mt-del-selected").forEach(btn => {
      btn.addEventListener("click", () => {
        const tid = btn.dataset.tid;
        const ids = [...popup.querySelectorAll(`.mt-row-chk[data-tid="${tid}"]:checked`)].map(cb => cb.dataset.rid);
        if (!ids.length) { alert("삭제할 규칙을 먼저 체크하세요."); return; }
        if (!confirm(`선택한 ${ids.length}개 규칙을 삭제할까요?`)) return;
        deleteMarginRules(tid, ids);
        rerender();
      });
    });
    // 인라인 편집 시작
    popup.querySelectorAll(".mt-edit-rule").forEach(btn => {
      btn.addEventListener("click", () => { _mtEditingId = btn.dataset.rid; rerender(); });
    });
    // 편집 저장
    popup.querySelectorAll(".mt-save-edit").forEach(btn => {
      btn.addEventListener("click", () => {
        const tr = btn.closest("tr");
        const mfr = tr.querySelector(".mt-edit-mfr").value;
        const prod = tr.querySelector(".mt-edit-prod").value;
        const sizeEl = tr.querySelector(".mt-edit-size");
        const size = sizeEl ? sizeEl.value : undefined;
        const dotEl = tr.querySelector(".mt-edit-dot");
        const dotVal = dotEl ? dotEl.value : undefined;
        const detail = tr.querySelector(".mt-edit-detail").value;
        const dc = tr.querySelector(".mt-edit-dc").value;
        const cost = tr.querySelector(".mt-edit-cost").value;
        const inchThreshold = tr.querySelector(".mt-edit-inch")?.value ?? "";
        const dcAbove = tr.querySelector(".mt-edit-dc-above")?.value ?? "";
        if (!mfr.trim() || !prod.trim()) { alert("제조사·상품명을 입력하세요."); return; }
        updateMarginRule(btn.dataset.tid, btn.dataset.rid, {
          manufacturer: mfr, productContains: prod, detailContains: detail,
          discountPct: dc, costOverride: cost === "" ? null : cost,
          inchThreshold: inchThreshold === "" ? null : inchThreshold,
          discountPctAbove: dcAbove === "" ? null : dcAbove,
          ...(size !== undefined ? { sizeContains: size } : {}),
          ...(dotVal !== undefined ? { dot: dotVal } : {}),
        });
        _mtEditingId = null;
        rerender();
        st("✅ 마진 규칙 수정됨");
      });
    });
    // 편집 취소
    popup.querySelectorAll(".mt-cancel-edit").forEach(btn => {
      btn.addEventListener("click", () => { _mtEditingId = null; rerender(); });
    });
    // 📥 엑셀 붙여넣기 일괄추가 (탭 구분 또는 콤마 구분, 여러 줄)
    popup.querySelectorAll(".mt-bulk-add").forEach(btn => {
      btn.addEventListener("click", async () => {
        const tid = btn.dataset.tid;
        const ta = popup.querySelector(`.mt-bulk-paste[data-tid="${tid}"]`);
        const isEx = ta?.dataset.exception === "1";
        const raw = ta?.value || "";
        const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
        if (!lines.length) { alert("붙여넣을 내용이 없습니다."); return; }
        let added = 0, skipped = 0;
        for (const line of lines) {
          // 헤더 줄로 보이면 스킵 (첫 칸이 "제조사"인 경우)
          const cols = line.split(/\t|,/).map(c => c.trim());
          if (cols[0] === "제조사" || cols[0] === "manufacturer") { skipped++; continue; }
          let mfr, prod, size, dot, detail, dcRaw, costRaw;
          if (isEx) {
            // 순서: 제조사, 상품명, 사이즈(선택), DOT(선택), 세부정보(선택), 할인율, 원가(선택)
            [mfr, prod, size, dot, detail, dcRaw, costRaw] = cols;
          } else {
            // 순서: 제조사, 상품명, 세부정보(선택), 할인율, 원가(선택)
            [mfr, prod, detail, dcRaw, costRaw] = cols;
          }
          if (!mfr || !prod) { skipped++; continue; }
          const dc = (dcRaw || "").replace(/[%\s]/g,"");
          const cost = (costRaw || "").replace(/[^\d]/g,"");
          if (dc === "" && cost === "") { skipped++; continue; }
          await addMarginRule(tid, mfr, prod, dc || 0, cost || "", detail || "", size || "", dot || "");
          added++;
        }
        if (ta) ta.value = "";
        rerender();
        st(`✅ 일괄추가 완료: ${added}건 추가${skipped ? `, ${skipped}건 건너뜀` : ""}`);
      });
    });
  };
  bindRuleButtons();

  popup.querySelector("#mt-add-tab").addEventListener("click", async () => {
    const name = popup.querySelector("#mt-new-tab-name").value;
    if (!name.trim()) { alert("탭 이름을 입력하세요."); return; }
    const tab = await addMarginTab(name, false);
    if (tab?.id) _mtExpandedTabs.add(tab.id); // 새로 만든 탭은 바로 보이도록 펼침
    popup.querySelector("#mt-new-tab-name").value = "";
    rerender();
  });
  popup.querySelector("#mt-add-exception-tab").addEventListener("click", async () => {
    const name = popup.querySelector("#mt-new-tab-name").value;
    if (!name.trim()) { alert("탭 이름을 입력하세요."); return; }
    const tab = await addMarginTab(name, true);
    if (tab?.id) _mtExpandedTabs.add(tab.id); // 새로 만든 탭은 바로 보이도록 펼침
    popup.querySelector("#mt-new-tab-name").value = "";
    rerender();
  });
  popup.querySelector("#mt-save-fee").addEventListener("click", async () => {
    const v = parseFloat(popup.querySelector("#mt-fee-rate").value);
    const s = parseFloat(popup.querySelector("#mt-ship-cost").value);
    if (isNaN(v) || isNaN(s)) return;
    await saveGlobalMarginSettings(costRatePct, v, s);
    _saveMarginTabsLocal();
    st("✅ 수수료율/택배가격 저장됨");
  });
  popup.querySelector("#mt-close").addEventListener("click", () => popup.remove());
  popup.querySelector("#mt-refresh").addEventListener("click", async () => {
    st("🔄 마진탭 서버에서 가져오는 중...");
    const result = await loadMarginTabsConfig();
    rerender();
    if (result?.ok) {
      st(`✅ 마진탭 새로고침 완료 — ${_marginTabs.length}개 (서버에서 정상 로드됨)`);
    } else {
      st(`❌ 서버 로드 실패: ${result?.error || "알 수 없는 오류"} — 로컬 저장된 내용만 표시 중`);
      alert(`Supabase 로드 실패:\n${result?.error || "알 수 없는 오류"}\n\n로컬에 저장된 내용만 보이고 있으며, 다른 컴퓨터와 공유되지 않은 상태입니다.\nsupabase_margin_tabs.sql이 정상 실행됐는지, anon 키가 맞는지 확인해주세요.`);
    }
  });
  popup.addEventListener("click", e => { if (e.target === popup) popup.remove(); });
}

// ── 구글 스프레드시트 연동 (주문확인 시 자동 입력) ──────────────
// Apps Script 웹앱을 다리로 사용 (OAuth 불필요, 사용자가 스크립트를 배포해 URL만 입력)
let _gsheetWebAppUrl = "";
let _gsheetTabName   = "";
let _gsheetEnabled   = false;
const GSHEET_CFG_KEY = "gsheet_sync_cfg";

async function loadGSheetConfig() {
  return new Promise(resolve => {
    chrome.storage.local.get(GSHEET_CFG_KEY, d => {
      const cfg = d[GSHEET_CFG_KEY];
      if (cfg) { _gsheetWebAppUrl = cfg.url || ""; _gsheetTabName = cfg.tab || ""; _gsheetEnabled = !!cfg.enabled; }
      resolve();
    });
  });
}
function saveGSheetConfig(url, tab, enabled) {
  _gsheetWebAppUrl = url || ""; _gsheetTabName = tab || ""; _gsheetEnabled = !!enabled;
  chrome.storage.local.set({ [GSHEET_CFG_KEY]: { url: _gsheetWebAppUrl, tab: _gsheetTabName, enabled: _gsheetEnabled } });
}

// 주문확인 성공 시 호출 — 해당 주문 1건을 시트에 한 행 추가
async function sendConfirmedRowToSheet(orderId) {
  if (!_gsheetEnabled || !_gsheetWebAppUrl) return;
  try {
    const r = _ordRows.find(row => row.orderId === String(orderId)) || { orderId: String(orderId), cells: [] };
    const rowArr = _buildGarageRow(r);
    const res = await fetch(_gsheetWebAppUrl, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" }, // Apps Script doPost 호환을 위해 text/plain 사용 (CORS preflight 회피)
      body: JSON.stringify({ tab: _gsheetTabName || "", values: rowArr }),
    });
    if (!res.ok) { st(`⚠️ 시트 연동 실패 (${res.status})`); return; }
    let data = {};
    try { data = await res.json(); } catch(e) {}
    if (data && data.ok === false) st(`⚠️ 시트 연동 오류: ${data.error || "알 수 없음"}`);
    else st(`✅ 주문 #${orderId} → 스프레드시트에도 기록됨`);
  } catch(e) {
    st(`⚠️ 시트 연동 실패: ${e.message}`);
  }
}

function showGSheetSettings() {
  document.getElementById("gsheet-settings-popup")?.remove();
  const popup = document.createElement("div");
  popup.id = "gsheet-settings-popup";
  popup.style.cssText = "position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.35);z-index:20000;display:flex;align-items:center;justify-content:center;";
  popup.innerHTML = `
    <div style="background:#fff;border-radius:10px;padding:16px;width:360px;max-width:92vw;font-size:12px;box-shadow:0 8px 24px rgba(0,0,0,.25);">
      <div style="font-weight:700;font-size:13px;margin-bottom:10px;color:#1e40af;">📊 구글 스프레드시트 연동 설정</div>
      <p style="color:#6b7280;font-size:11px;line-height:1.5;margin-bottom:10px;">
        스프레드시트에 <b>Apps Script 웹앱</b>을 배포한 뒤, 그 주소(URL)를 아래에 입력하세요.
        주문확인이 실제로 성공할 때마다 그 주문 1건이 지정한 시트 탭에 한 줄씩 자동으로 추가됩니다.
      </p>
      <label style="display:block;margin-bottom:6px;">Apps Script 웹앱 URL
        <input type="text" id="gs-url" placeholder="https://script.google.com/macros/s/…/exec" value="${escHtml(_gsheetWebAppUrl)}"
          style="width:100%;padding:4px 6px;border:1px solid #d1d5db;border-radius:4px;font-size:11px;margin-top:2px;">
      </label>
      <label style="display:block;margin-bottom:10px;">시트(탭) 이름
        <input type="text" id="gs-tab" placeholder="예: 주문확인목록 (비우면 첫 번째 시트)" value="${escHtml(_gsheetTabName)}"
          style="width:100%;padding:4px 6px;border:1px solid #d1d5db;border-radius:4px;font-size:11px;margin-top:2px;">
      </label>
      <label style="display:flex;align-items:center;gap:5px;margin-bottom:12px;cursor:pointer;">
        <input type="checkbox" id="gs-enabled" ${_gsheetEnabled?"checked":""}> 연동 사용함
      </label>
      <div style="display:flex;gap:6px;justify-content:flex-end;">
        <button class="btn-gray btn-sm" id="gs-test">테스트 전송</button>
        <button class="btn-gray btn-sm" id="gs-cancel">취소</button>
        <button class="btn-sky btn-sm" id="gs-save">저장</button>
      </div>
    </div>`;
  document.body.appendChild(popup);
  const close = () => popup.remove();
  popup.querySelector("#gs-cancel").addEventListener("click", close);
  popup.addEventListener("click", e => { if (e.target === popup) close(); });
  popup.querySelector("#gs-save").addEventListener("click", () => {
    const url = popup.querySelector("#gs-url").value.trim();
    const tab = popup.querySelector("#gs-tab").value.trim();
    const enabled = popup.querySelector("#gs-enabled").checked;
    saveGSheetConfig(url, tab, enabled);
    st("✅ 시트 연동 설정 저장됨");
    close();
  });
  popup.querySelector("#gs-test").addEventListener("click", async () => {
    const url = popup.querySelector("#gs-url").value.trim();
    const tab = popup.querySelector("#gs-tab").value.trim();
    if (!url) { alert("웹앱 URL을 먼저 입력하세요."); return; }
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({ tab, values: ["","테스트","TEST-0000","","","","","테스트상품","000/00R00","테스트","2026","테스트","1","00000","테스트 주소","테스트","010-0000-0000","","0"] }),
      });
      const txt = await res.text();
      alert(res.ok ? "✅ 테스트 전송 성공 — 시트를 확인해보세요.\n응답: " + txt.slice(0,200) : `❌ 실패 (${res.status})\n${txt.slice(0,200)}`);
    } catch(e) { alert("오류: " + e.message); }
  });
}
// F열 값 계산: 직접출고 지정 > 배송지에 경기/서울 포함(직배송) > 그 외(택배)
function _computeShipMethod(orderId, addr) {
  if (_directShipMap[orderId]) return "직접출고";
  const a = addr || "";
  if (a.includes("경기") || a.includes("서울")) return "직배송";
  return "택배";
}
let _ordFiltered = [];
let _ordLoading  = false;
let _ordHeaders  = [];
let _ordST       = null;
let _ordDotCache = {};
let _ordPage     = 1;
let _ordMaxPage  = 1;
const _ORD_DOT_COLORS = { cur: "#000", prev: "#0d6efd", old: "#dc3545" };

function _ordDotColor(year) {
  if (!year) return "";
  const y = new Date().getFullYear();
  return year >= y ? _ORD_DOT_COLORS.cur : year === y-1 ? _ORD_DOT_COLORS.prev : _ORD_DOT_COLORS.old;
}

// /sell/orderlist/view/{id} 상세 파싱 — 실제 페이지 구조 기반
async function _fetchOrderDetail(orderId) {
  console.log("[상세] 호출:", orderId, "캐시있음:", !!_ordDetailCache[orderId]);
  if (_ordDetailCache[orderId]) return _ordDetailCache[orderId];
  const empty = { dot:null, product:"", size:"", detail:"", maker:"", qty:"", zip:"", addr:"", recipient:"", phone:"", request:"", settle:"", makerCode:"", orderDate:"", orderNo:"", factoryPrice:0, orderHash:"", curStatus:"" };
  try {
    const res = await bgFetch(`${BASE}/sell/orderlist/view/${orderId}`);
    if (!res.ok) return (_ordDetailCache[orderId] = empty);
    const html = res.text;

    // 주문확인/재고없음 버튼의 보안 토큰(hash) — 두 버튼이 같은 값을 공유함
    const hashM = html.match(/orderconfirm\(\s*\d+\s*,\s*'([a-f0-9]+)'\s*\)/i)
               || html.match(/ordersoldout\(\s*\d+\s*,\s*'([a-f0-9]+)'\s*\)/i);
    const orderHash = hashM ? hashM[1] : "";
    // 현재 주문상태 텍스트 (예: "입금완료", "주문확인") — span 유무 등 구조 변화에 안전한 방식
    const curStatus = _extractStatusNear(html, "주문상태");

    // ── 1. 제품 정보 테이블 파싱 ─────────────────────────────
    // thead에서 컬럼 순서 파악 → tbody 첫 행 값 추출
    const prodTable = html.match(/<table[^>]*>([\s\S]*?)<\/table>/gi) || [];
    let prodCols = [], prodVals = [];
    for (const tbl of prodTable) {
      const thM = [...tbl.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi)].map(m=>m[1].replace(/<[^>]+>/g,"").replace(/\s+/g," ").trim());
      if (thM.some(h => h.includes("주문상품") || h.includes("세부정보") || h.includes("생산년도"))) {
        prodCols = thM;
        const tdM = [...tbl.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(m=>m[1]);
        prodVals = tdM;
        console.log("[상세파싱]", orderId, "cols:", prodCols, "cell[0]raw:", (prodVals[0]||"").slice(0,300));
        break;
      }
    }
    const pci = k => prodCols.findIndex(h => h.includes(k));
    const pval = k => {
      const i = pci(k); if (i < 0 || i >= prodVals.length) return "";
      return prodVals[i].replace(/<[^>]+>/g," ").replace(/&nbsp;/g," ").replace(/\s+/g," ").trim();
    };

    // 품명 + 사이즈: t-name / t-size 클래스로 추출
    let product = "", size = "";
    if (pci("주문상품") >= 0) {
      const rawCell = prodVals[pci("주문상품")] || "";
      const nameM = rawCell.match(/<p[^>]*class="[^"]*t-name[^"]*"[^>]*>([\s\S]*?)<\/p>/i);
      const szM   = rawCell.match(/<p[^>]*class="[^"]*t-size[^"]*"[^>]*>([\s\S]*?)<\/p>/i);
      if (nameM) product = nameM[1].replace(/<[^>]+>/g,"").trim();
      if (szM)   size    = szM[1].replace(/<[^>]+>/g,"").trim();
      // 폴백: a 링크 or 텍스트 줄
      if (!product) {
        const linkM = rawCell.match(/<a[^>]*>([\s\S]*?)<\/a>/i);
        if (linkM) product = linkM[1].replace(/<[^>]+>/g,"").trim();
      }
      if (!size) {
        const lines = rawCell.replace(/<br\s*\/?>/gi,"\n").replace(/<[^>]+>/g,"").split("\n").map(s=>s.trim()).filter(Boolean);
        if (lines.length >= 2) size = lines[1];
      }
      console.log("[상세] product/size 추출:", orderId, "product:", product, "size:", size);
    }

    const detail   = pval("세부정보");
    const dot      = parseInt(pval("생산년도"), 10);
    const qty      = pval("수량").replace(/본$/,"").trim();
    const settle   = pval("합계금액") || pval("정산금액");
    const factoryPrice = parseInt((pval("공장도가")||"").replace(/[^\d]/g,""), 10) || 0;

    // ── 2. 라벨:값 쌍 전체 수집 (주문 정보·배송 주소·업체 섹션) ─
    const pairs = {};
    // th + td / dt + dd / "라벨" + "값" 패턴 모두 커버
    const trRx2 = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let m2;
    while ((m2 = trRx2.exec(html)) !== null) {
      const cells = [...m2[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)]
        .map(c => c[1].replace(/<[^>]+>/g," ").replace(/&nbsp;/g," ").replace(/\s+/g," ").trim());
      for (let i = 0; i + 1 < cells.length; i += 2) {
        if (cells[i] && cells[i].length < 30) pairs[cells[i]] = cells[i+1] || "";
      }
      if (cells.length === 4 && cells[0].length < 20 && cells[2].length < 20) {
        if (cells[0]) pairs[cells[0]] = cells[1] || "";
        if (cells[2]) pairs[cells[2]] = cells[3] || "";
      }
    }
    // dt/dd 패턴
    const dtRx = /<dt[^>]*>([\s\S]*?)<\/dt>[\s\S]*?<dd[^>]*>([\s\S]*?)<\/dd>/gi;
    let dtm;
    while ((dtm = dtRx.exec(html)) !== null) {
      const k = dtm[1].replace(/<[^>]+>/g,"").replace(/>/g,"").trim();
      const v = dtm[2].replace(/<[^>]+>/g," ").replace(/\s+/g," ").trim();
      if (k && k.length < 30) pairs[k] = v;
    }
    // ul/li "라벨 값" 패턴 (화면의 "> 배송지 주소 ..." 형태)
    const liRx = /<li[^>]*>([\s\S]*?)<\/li>/gi;
    let lim;
    while ((lim = liRx.exec(html)) !== null) {
      const txt = lim[1].replace(/<[^>]+>/g," ").replace(/&nbsp;/g," ").replace(/\s+/g," ").trim().replace(/^>\s*/,"");
      // 패턴: "라벨 값" 형태 (e.g. "배송지 주소 (31710) 충남...")
      const colonM = txt.match(/^(.{2,15}?)\s{2,}(.+)$/);
      if (colonM) pairs[colonM[1].trim()] = colonM[2].trim();
    }
    // span/div 라벨+값 쌍 (class에 label/value 포함 구조 대비)
    const labelValRx = /class="[^"]*label[^"]*"[^>]*>([\s\S]*?)<\/[^>]+>[\s\S]{0,50}?class="[^"]*value[^"]*"[^>]*>([\s\S]*?)<\/[^>]+>/gi;
    let lvm;
    while ((lvm = labelValRx.exec(html)) !== null) {
      const k = lvm[1].replace(/<[^>]+>/g,"").trim();
      const v = lvm[2].replace(/<[^>]+>/g," ").replace(/\s+/g," ").trim();
      if (k && k.length < 30) pairs[k] = v;
    }

    // label/div 패턴 (실제 구조: <li><label>라벨</label><div>값</div></li>)
    const labelDivRx = /<label[^>]*>([\s\S]*?)<\/label>\s*<div[^>]*>([\s\S]*?)<\/div>/gi;
    let ldm;
    while ((ldm = labelDivRx.exec(html)) !== null) {
      const k = ldm[1].replace(/<[^>]+>/g,"").trim();
      // div 안에 <p> 여러 개(우편번호+주소)면 합쳐서, 없으면 텍스트 그대로
      const ps = [...ldm[2].matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)].map(p=>p[1].replace(/<[^>]+>/g," ").replace(/\s+/g," ").trim());
      const v = ps.length ? ps.join(" ") : ldm[2].replace(/<[^>]+>/g," ").replace(/\s+/g," ").trim();
      if (k && k.length < 30) pairs[k] = v;
    }

    console.log("[상세파싱] pairs:", orderId, Object.keys(pairs).join(" | "));
    // 배송지 주소 라벨 주변 원본 HTML 덤프 (구조 확인용)
    const addrIdx = html.indexOf("배송지 주소");
    if (addrIdx !== -1) {
      console.log("[상세] 배송지주소 주변 HTML:", orderId, html.slice(addrIdx, addrIdx+400));
    } else {
      console.log("[상세] '배송지 주소' 텍스트를 못 찾음:", orderId);
    }

    const pg = (...keys) => {
      for (const k of keys) {
        for (const pk in pairs) { if (pk.includes(k)) return pairs[pk]; }
      }
      return "";
    };

    // ── 배송 주소·주문 정보: 라벨 텍스트 직접 검색 ──────────────
    // pairs 방식 대신, 실제 라벨 텍스트 바로 뒤 값 추출 (구조 무관)
    const findVal = (label) => {
      // 라벨 태그 닫힌 직후 또는 다음 태그 안의 텍스트
      const esc = label.replace(/[.*+?^${}()|[\]\\]/g,"\\$&").replace(/\s+/g,"\\s*");
      const m = html.match(new RegExp(esc + "[^<]*<\\/[^>]+>[\\s\\S]{0,80}?<[^>]+>([^<]{2,300})"));
      if (m) return m[1].replace(/\s+/g," ").trim();
      // 같은 태그 안에 "라벨 값" 형태
      const m2 = html.match(new RegExp(esc + "[\\s\\S]{0,30}?>?\\s*([\\uAC00-\\uD7A3\\w()\\-\\.\\s]{3,200})"));
      return m2 ? m2[1].replace(/\s+/g," ").trim() : "";
    };

    // 제조사 조회는 "제조사코드"와 헷갈리기 쉬움(라벨 텍스트/pairs 키 둘 다 "제조사"를 포함) → 코드 결과는 명시적으로 걸러냄
    const findValNoCode = (label) => {
      const esc = label.replace(/[.*+?^${}()|[\]\\]/g,"\\$&").replace(/\s+/g,"\\s*");
      const m = html.match(new RegExp(esc + "(?!\\s*코드)[^<]*<\\/[^>]+>[\\s\\S]{0,80}?<[^>]+>([^<]{2,300})"));
      if (m) return m[1].replace(/\s+/g," ").trim();
      const m2 = html.match(new RegExp(esc + "(?!\\s*코드)[\\s\\S]{0,30}?>?\\s*([\\uAC00-\\uD7A3\\w()\\-\\.\\s]{3,200})"));
      return m2 ? m2[1].replace(/\s+/g," ").trim() : "";
    };
    const pgNoCode = (...keys) => {
      for (const k of keys) {
        for (const pk in pairs) { if (pk.includes(k) && !pk.includes("코드")) return pairs[pk]; }
      }
      return "";
    };

    const rawAddr   = pg("배송지 주소","배송주소","배송지") || findVal("배송지 주소");
    const zipM      = rawAddr.match(/^\((\d{5})\)\s*/);
    const zip       = zipM ? zipM[1] : (pg("우편번호","우편") || findVal("우편번호"));
    const addr      = zipM ? rawAddr.replace(zipM[0],"").trim() : rawAddr;
    const recipient = pg("받는분 이름","받는분","수취인") || findVal("받는분 이름");
    const phone     = pg("배송지 연락처","연락처","전화번호") || findVal("배송지 연락처");
    const request   = pg("요청사항","배송메모","메모","요청") || findVal("요청사항");

    // 주문번호: "통합 N 상품 M" → 상품 번호(M)
    const rawOrderNo = pg("주문번호") || findVal("주문번호");
    const orderNoM = rawOrderNo.match(/상품\s*(\d+)/);
    const orderNo = orderNoM ? orderNoM[1] : rawOrderNo.replace(/통합.*$/,"").trim() || rawOrderNo;

    // "업체코드"는 주문업체(구매자) 코드로 제조사코드와 다른 개념이라 여기서 쓰면 안 됨 — 제조사코드만 정확히 찾음
    const makerCode = pg("제조사코드","제조사 코드") || findVal("제조사코드");
    const orderDate = (pg("주문일자","주문일") || findVal("주문일자")).replace(/\s+\d{2}:\d{2}:\d{2}$/,"");

    const result = {
      dot:       isNaN(dot) ? null : dot,
      product:   product || pval("품명"),
      size:      size     || pval("규격"),
      detail,
      maker:     findValNoCode("제조사") || pgNoCode("제조사","브랜드"),
      makerCode,
      qty:       qty || pg("수량").replace(/본$/,"").trim(),
      zip, addr, recipient, phone, request,
      settle:    settle || findVal("합계금액") || pg("정산금액","합계금액","결제금액"),
      orderDate, orderNo,
      factoryPrice,
      orderHash, curStatus,
    };
    console.log("[상세결과]", orderId, "addr:", addr, "zip:", zip, "recipient:", recipient);
    return (_ordDetailCache[orderId] = result);
  } catch(e) { console.warn("[상세오류]", orderId, e.message); return (_ordDetailCache[orderId] = empty); }
}

// 기존 DOT용 래퍼
async function _fetchDot(orderId) {
  const d = await _fetchOrderDetail(orderId);
  return d.dot;
}

// 주문 상세 패널 표시
// 주문 처리상태 변경 (주문확인 / 재고없음)
// GET /ajax/order/{action}?oid={주문ID}&hash={보안토큰} — 상세페이지에서 토큰을 추출해 재사용
async function _changeOrderStatus(orderId, hash, action, shipFromValue, isDirect) {
  const label = action === "orderconfirm" ? "주문확인" : "재고없음";
  console.log(`[주문상태변경] 클릭됨 action=${action} orderId=${orderId} hash=${hash ? "있음" : "없음(!)"}`);
  if (!hash) { alert("보안 토큰을 찾지 못했습니다. 상세 화면을 다시 열어 시도해주세요."); return; }
  if (action === "orderconfirm" && !shipFromValue) { alert("출고지를 먼저 선택하세요."); return; }
  const shipLine = shipFromValue ? `\n출고지: ${shipFromValue}${isDirect ? " (직접출고)" : ""}` : "";
  if (!confirm(`이 주문을 [${label}] 상태로 변경할까요?${shipLine}\n(실제 타이어핑 주문 상태가 바뀝니다)`)) {
    console.log(`[주문상태변경] 확인창에서 취소됨(또는 브라우저가 대화상자를 막고 있을 수 있음) action=${action}`);
    return;
  }
  try {
    // 실제 사이트 네트워크 요청을 캡처해서 확인한 건 "재고없음(ordersoldout)"뿐이라,
    // 그것만 새 방식(POST + URL 쿼리스트링, 경로도 order 접두사 뗀 "soldout")을 적용하고,
    // "주문확인(orderconfirm)"은 원래 정상 동작하던 방식(POST + body, 경로 그대로) 그대로 유지함
    // (추측으로 둘 다 바꿨다가 정상이던 주문확인까지 같이 깨졌던 적이 있어서, 확인 안 된 쪽은 손대지 않음)
    let res;
    if (action === "ordersoldout") {
      const url = `${BASE}/ajax/order/soldout?${new URLSearchParams({ oid: orderId, hash, type: "undefined" }).toString()}`;
      res = await bgFetch(url, { method: "POST" });
    } else {
      const body = new URLSearchParams({ oid: orderId, hash });
      res = await bgFetch(`${BASE}/ajax/order/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      });
    }
    console.log(`[주문상태변경] 서버 응답 action=${action} status=${res.status} ok=${res.ok} body=${(res.text||"").slice(0,200)}`);
    if (!res.ok) { alert(`처리 실패 (${res.status})`); return; }
    st(`✅ 주문 #${orderId} → [${label}] 처리 완료`);
    // 주문확인을 누른 순서를 기록 (게러지 그리드를 이 순서대로 보여주기 위함 — 사이트 자체 순서와 무관)
    if (action === "orderconfirm") {
      _confirmSeqCounter++;
      _confirmSeq[orderId] = _confirmSeqCounter;
      chrome.storage.local.set({ garage_confirm_seq: _confirmSeq, garage_confirm_seq_counter: _confirmSeqCounter });
    }
    // 주문확인이 실제로 성공했을 때만 출고지/직접출고 여부를 저장 (게러지 그리드 F·G열에 반영)
    if (action === "orderconfirm" && shipFromValue) {
      setOrderShipFrom(orderId, shipFromValue);
      setOrderDirectShip(orderId, !!isDirect);
      // 구글 스프레드시트 연동이 켜져 있으면 이 시점(캐시 삭제 전)에 바로 전송
      sendConfirmedRowToSheet(orderId);
    }
    // 캐시 무효화 후 상세 패널 다시 로드 (최신 상태 반영)
    delete _ordDetailCache[orderId];
    _showOrderDetail(orderId);
    // 목록 화면도 다시 불러와 상태 텍스트 갱신
    if (viewMode === "orders") _loadOrders(_ordPage);
    // 타이어게러지 그리드도 주문확인 즉시 백그라운드로 새로고침 (전체 페이지 재수집 — 수동 새로고침 불필요)
    if (action === "orderconfirm") {
      _garageAllParamsKey = ""; // 캐시 무효화 → 아래 호출이 반드시 재로딩하도록
      _loadAllConfirmedForGarage();
    }
  } catch(e) {
    alert("오류: " + e.message);
  }
}

async function _showOrderDetail(orderId) {
  const panel = $("ord-detail-panel");
  const body  = $("ord-detail-body");
  const idEl  = $("ord-detail-id");
  if (!panel || !body) return;
  panel.style.display = "block";
  if (idEl) idEl.textContent = `#${orderId}`;
  body.innerHTML = `<div style="color:#9ca3af;padding:8px;">불러오는 중...</div>`;
  const marginBox = $("ord-margin-result"); if (marginBox) marginBox.innerHTML = "";
  try {
    const res = await bgFetch(`${BASE}/sell/orderlist/view/${orderId}`);
    if (!res.ok) { body.innerHTML = `<span style="color:#dc2626;">오류 (${res.status})</span>`; return; }
    // 상태 변경용 토큰(hash) + 현재 상태도 함께 추출 (상세페이지 재요청 없이 재사용)
    const hashM = res.text.match(/orderconfirm\(\s*\d+\s*,\s*'([a-f0-9]+)'\s*\)/i)
               || res.text.match(/ordersoldout\(\s*\d+\s*,\s*'([a-f0-9]+)'\s*\)/i);
    const orderHash = hashM ? hashM[1] : "";
    const curStatus = _extractStatusNear(res.text, "주문상태");

    // 마진 탭 계산용: 제조사/상품명/공장도가/정산금액
    // (상세페이지엔 "제조사"·"정산금액" 라벨이 따로 없어서 상세페이지 파싱값(d.maker/d.settle)이
    //  비어있거나 엉뚱하게(합계금액) 채워질 수 있음 → 목록(리스트) 행의 실제 컬럼값을 우선 사용)
    _fetchOrderDetail(orderId).then(d => {
      const row = _ordRows.find(r => r.orderId === String(orderId));
      let maker = d.maker;
      if (!maker && row) {
        const mIdx = _ordHeaders.findIndex(h => h.includes("제조사") && !h.includes("코드"));
        if (mIdx !== -1) maker = row.cells[mIdx] || "";
      }
      // 정산금액: 목록의 "정산금액" 컬럼을 최우선으로 사용 (상세페이지엔 이 라벨이 없어서
      // 잘못 "합계금액"을 대신 가져오는 문제가 있었음)
      let settleForMargin = "";
      if (row) {
        const sIdx = _ordHeaders.findIndex(h => h.includes("정산금액"));
        if (sIdx !== -1) settleForMargin = row.cells[sIdx] || "";
      }
      if (!settleForMargin) settleForMargin = d.settle; // 폴백 (목록에 컬럼이 없을 때만)
      console.log("[마진탭] 매칭 시도:", orderId, "제조사:", maker, "상품명:", d.product, "공장도가:", d.factoryPrice, "정산금액:", settleForMargin);
      _renderOrderMarginResult(d.factoryPrice, maker, d.product, settleForMargin, orderId, d.qty, d.detail, d.size, d.dot);
    });

    // 핵심 테이블들 추출
    const tables = [...res.text.matchAll(/<table[^>]*>([\s\S]*?)<\/table>/gi)];
    if (!tables.length) { body.innerHTML = `<span style="color:#9ca3af;">상세 정보를 불러오지 못했습니다.</span>`; return; }

    let html = "";
    // 주문상태 변경 버튼 (토큰이 있을 때만 표시)
    if (orderHash) {
      const curShipFromFull = _shipFromMap[orderId] || "";
      const curNextDay = / 익일출고$/.test(curShipFromFull);
      const curShipFrom = curShipFromFull.replace(/ 익일출고$/, ""); // 드롭다운엔 출고지 이름만 표시
      const shipOptsHtml = _shipFromOptions.map(o =>
        `<option value="${escHtml(o)}"${o===curShipFrom?" selected":""}>${escHtml(o)}</option>`
      ).join("");
      html += `<div style="display:flex;align-items:center;gap:6px;margin-bottom:8px;padding:5px 8px;background:#fffbeb;border:1px solid #fde68a;border-radius:6px;font-size:11px;flex-wrap:wrap;">
        <strong>현재상태:</strong> <span style="color:#b45309;">${escHtml(curStatus || "확인불가")}</span>
        <select id="ord-shipfrom-sel" data-oid="${orderId}" style="font-size:11px;padding:2px 4px;">
          <option value="">출고지 선택</option>
          ${shipOptsHtml}
          <option value="__add__">+ 새 항목 추가</option>
        </select>
        <button class="btn-gray btn-sm" id="ord-shipfrom-del" title="드롭다운에서 선택된 항목을 목록에서 삭제">🗑</button>
        <label style="display:flex;align-items:center;gap:3px;cursor:pointer;">
          <input type="checkbox" id="ord-nextday-chk" ${curNextDay?"checked":""}> 🌙 익일출고
        </label>
        <label style="display:flex;align-items:center;gap:3px;cursor:pointer;">
          <input type="checkbox" id="ord-direct-chk" ${_directShipMap[orderId]?"checked":""}> 📦 직접출고
        </label>
        <button class="btn-sky btn-sm ord-status-btn" data-oid="${orderId}" data-hash="${escHtml(orderHash)}" data-action="orderconfirm" ${curShipFrom?"":"disabled"}
          title="${curShipFrom?"":"출고지를 먼저 선택하세요"}">✅ 주문확인</button>
        <button class="btn-gray btn-sm ord-status-btn" data-oid="${orderId}" data-hash="${escHtml(orderHash)}" data-action="ordersoldout">⚠️ 재고없음</button>
      </div>`;
    }
    html += `<div style="display:flex;flex-wrap:wrap;gap:8px;">`;
    let tblIdx = 0;
    for (const tbl of tables) {
      const rows = [];
      const trRx = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
      let m;
      while ((m = trRx.exec(tbl[1])) !== null) {
        const cells = [];
        const cellRx = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
        let cm;
        while ((cm = cellRx.exec(m[1])) !== null) {
          cells.push(cm[1].replace(/<[^>]+>/g," ").replace(/\s+/g," ").trim());
        }
        if (cells.length && cells.some(c => c.length > 0)) rows.push(cells);
      }
      if (!rows.length) continue;
      const tId = tblIdx++;
      html += `<table class="ord-detail-table" data-tid="${tId}" style="border-collapse:collapse;font-size:10px;min-width:160px;">`;
      rows.forEach((row, ri) => {
        html += `<tr>${row.map((c,ci) => {
          const isHeader = ci === 0 || row.length === 2 && ci === 0;
          return `<td class="ord-detail-cell" data-tid="${tId}" data-ri="${ri}" data-ci="${ci}" title="${escHtml(c)}"
            style="padding:2px 5px;border:1px solid #e5e7eb;${isHeader?"background:#f1f5f9;font-weight:600;color:#374151;":"color:#111827;"}user-select:text;cursor:cell;">${escHtml(c)}</td>`;
        }).join("")}</tr>`;
      });
      html += `</table>`;
    }
    html += `</div>`;
    body.innerHTML = html;
    // 셀 클릭: 단일 선택 / Shift+클릭: 같은 표 안에서 범위 선택 + 자동 복사
    let _detailAnchor = null;
    let _detailRangeCells = [];
    const clearDetailHighlight = () => {
      body.querySelectorAll(".ord-detail-cell").forEach(td => td.style.background = "");
    };
    body.addEventListener("click", e => {
      const td = e.target.closest(".ord-detail-cell");
      if (!td) return;
      const tid = td.dataset.tid, ri = parseInt(td.dataset.ri,10), ci = parseInt(td.dataset.ci,10);

      if (e.shiftKey && _detailAnchor && _detailAnchor.dataset.tid === tid) {
        clearDetailHighlight();
        const ar = parseInt(_detailAnchor.dataset.ri,10), ac = parseInt(_detailAnchor.dataset.ci,10);
        const rLo=Math.min(ar,ri), rHi=Math.max(ar,ri), cLo=Math.min(ac,ci), cHi=Math.max(ac,ci);
        const tbl = body.querySelector(`.ord-detail-table[data-tid="${tid}"]`);
        const cells = [];
        for (let r = rLo; r <= rHi; r++) {
          for (let c = cLo; c <= cHi; c++) {
            const cell = tbl?.querySelector(`.ord-detail-cell[data-ri="${r}"][data-ci="${c}"]`);
            if (cell) cells.push(cell);
          }
        }
        cells.forEach(c => c.style.background = "#93c5fd");
        _detailRangeCells = cells;
        // 행 단위로 TSV 구성
        const byRow = {};
        cells.forEach(c => { const r = c.dataset.ri; (byRow[r] ||= []).push(c.title || c.textContent); });
        const tsv = Object.keys(byRow).sort((a,b)=>a-b).map(r => byRow[r].join("\t")).join("\n");
        navigator.clipboard?.writeText(tsv).then(() => st(`📋 범위 ${cells.length}칸 복사됨`)).catch(()=>{});
        return;
      }

      // 일반 클릭: 텍스트 선택 + 다음 shift 시작점으로 기록
      clearDetailHighlight();
      td.style.background = "#bfdbfe";
      _detailAnchor = td;
      const sel = window.getSelection(); sel.removeAllRanges(); const r = document.createRange(); r.selectNodeContents(td); sel.addRange(r);
    });
    // 주문상태 변경 버튼 클릭 — 주문확인 성공 시에만 출고지가 실제로 저장됨
    body.querySelectorAll(".ord-status-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        let shipVal = "";
        let isDirect = false;
        if (btn.dataset.action === "orderconfirm") {
          const base = body.querySelector("#ord-shipfrom-sel")?.value || "";
          const nextDay = body.querySelector("#ord-nextday-chk")?.checked;
          isDirect = !!body.querySelector("#ord-direct-chk")?.checked;
          shipVal = base ? (nextDay ? `${base} 익일출고` : base) : "";
        }
        _changeOrderStatus(btn.dataset.oid, btn.dataset.hash, btn.dataset.action, shipVal, isDirect);
      });
    });
    // 출고지 드롭다운: 선택은 임시값일 뿐 — 주문확인을 눌러야만 실제 저장됨
    const shipSel = body.querySelector("#ord-shipfrom-sel");
    if (shipSel) {
      shipSel.addEventListener("change", () => {
        const oid = shipSel.dataset.oid;
        const confirmBtn = body.querySelector('.ord-status-btn[data-action="orderconfirm"]');
        if (shipSel.value === "__add__") {
          const name = prompt("새 출고지 이름을 입력하세요:");
          if (name?.trim()) {
            addShipFromOption(name.trim());
            const opt = document.createElement("option");
            opt.value = name.trim(); opt.textContent = name.trim();
            shipSel.insertBefore(opt, shipSel.lastElementChild);
            shipSel.value = name.trim();
          } else {
            shipSel.value = "";
          }
        }
        const val = shipSel.value;
        if (confirmBtn) {
          confirmBtn.disabled = !val;
          confirmBtn.title = val ? "" : "출고지를 먼저 선택하세요";
        }
      });
    }
    // 🗑 삭제 버튼: 드롭다운에서 현재 선택된 항목을 목록 자체에서 제거
    const delBtn = body.querySelector("#ord-shipfrom-del");
    if (delBtn && shipSel) {
      delBtn.addEventListener("click", () => {
        const val = shipSel.value;
        if (!val || val === "__add__") { alert("삭제할 출고지를 먼저 선택하세요."); return; }
        if (!confirm(`"${val}" 항목을 출고지 목록에서 삭제할까요?`)) return;
        removeShipFromOption(val);
        shipSel.querySelector(`option[value="${CSS.escape(val)}"]`)?.remove();
        shipSel.value = "";
        const confirmBtn = body.querySelector('.ord-status-btn[data-action="orderconfirm"]');
        if (confirmBtn) { confirmBtn.disabled = true; confirmBtn.title = "출고지를 먼저 선택하세요"; }
      });
    }
  } catch(e) {
    body.innerHTML = `<span style="color:#dc2626;">오류: ${e.message}</span>`;
  }
}

function _parseOrderPage(html) {
  const rows = [], orderIds = [];
  const tbM = html.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/i);
  if (!tbM) return { rows, orderIds, maxPage: 1 };
  const trRx = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let m;
  while ((m = trRx.exec(tbM[1])) !== null) {
    const tr = m[1];
    const tds = [];
    const tdRx = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let tdM;
    while ((tdM = tdRx.exec(tr)) !== null)
      tds.push(tdM[1].replace(/<[^>]+>/g," ").replace(/\s+/g," ").trim());
    if (tds.length < 3) continue;
    // orderId: 다양한 패턴 시도
    const idM =
      tr.match(/\/orderlist\/view\/(\d+)/) ||       // href="/sell/orderlist/view/123"
      tr.match(/data-id="(\d+)"/) ||                // data-id="123"
      tr.match(/data-no="(\d+)"/) ||                // data-no="123"
      tr.match(/data-order="(\d+)"/) ||             // data-order="123"
      tr.match(/onclick="[^"]*?(\d{5,9})[^"]*"/) || // onclick="...123..."
      tr.match(/view\(?'(\d+)'\)?/) ||              // view('123')
      tr.match(/view\((\d+)\)/);                    // view(123)
    orderIds.push(idM ? idM[1] : "");
    rows.push(tds);
  }
  // 디버그: 첫 2행 로그
  if (rows.length) {
    console.log("[판매내역] 파싱 결과 row[0] cells:", rows[0]);
    console.log("[판매내역] 파싱 결과 orderId[0]:", orderIds[0]);
    if (rows.length > 1) console.log("[판매내역] orderId[1]:", orderIds[1]);
  }
  const pageNums = [...html.matchAll(/[?&]page=(\d+)/g)].map(m2=>parseInt(m2[1],10));
  const maxPage = pageNums.length ? Math.max(...pageNums) : 1;
  return { rows, orderIds, maxPage };
}
function _parseOrderHeader(html) {
  const thM = html.match(/<thead[^>]*>([\s\S]*?)<\/thead>/i);
  if (!thM) return [];
  const hdrs = [];
  const thRx = /<th[^>]*>([\s\S]*?)<\/th>/gi;
  let m;
  while ((m = thRx.exec(thM[1])) !== null) hdrs.push(m[1].replace(/<[^>]+>/g,"").trim());
  return hdrs;
}
// 주문확인 여부: 상태 필터가 주문확인(1)이면 전체 = 확인건
// 전체 조회 시에는 셀에서 텍스트로 판별 (한국 타이어핑 실제 텍스트 기준)
// 타이어핑 처리상태 알려진 값 목록 (여러 곳에서 공유)
const _KNOWN_STATUSES = ["입금완료","주문확인","배송 준비중","배송중","배송완료","구매확정","입금대기","입금전취소","입금후취소","상품미도착","교환","반품","환불","취소","재고없음"];
// 라벨(예: "주문상태") 뒤 블록 텍스트에서 알려진 상태어를 찾아 반환
// - <button>...</button> 안의 텍스트(주문확인/재고없음 등 액션 버튼 라벨)는 먼저 제거해야
//   실제 현재상태와 혼동되지 않음 (버튼 라벨도 상태어와 같은 단어라서)
// - 남은 텍스트에서 "가장 먼저(왼쪽에) 나오는" 상태어를 실제 현재상태로 판단
function _extractStatusNear(html, labelText) {
  const m = html.match(new RegExp(`<label[^>]*>${labelText}<\\/label>([\\s\\S]{0,500})`, "i"));
  if (!m) return "";
  const noButtons = m[1].replace(/<button[\s\S]*?<\/button>/gi, " ");
  const block = noButtons.replace(/<[^>]+>/g, " ");
  let bestIdx = Infinity, bestStatus = "";
  for (const k of _KNOWN_STATUSES) {
    const idx = block.indexOf(k);
    if (idx !== -1 && idx < bestIdx) { bestIdx = idx; bestStatus = k; }
  }
  return bestStatus;
}
function _isConfirmed(cells, forceTextCheck = false) {
  const statusFilter = $("ord-status")?.value || "";
  if (!forceTextCheck && (statusFilter === "6" || statusFilter === "7")) return true; // 서버에서 이미 입금완료/주문확인으로 필터됨
  // 전체 조회 시(또는 강제 텍스트체크 시): 셀 텍스트에 주문확인/입금완료 포함 여부
  return cells.some(c =>
    c.includes("주문확인") || c.includes("결제완료") || c.includes("입금완료") ||
    c === "확인" || c.includes("주문완료")
  );
}
// 목록 행에서 처리상태 원본 텍스트 추출 ("처리상태" 헤더 컬럼)
function _rowStatusText(cells) {
  const i = _ordHeaders.findIndex(h => h.includes("처리상태") || h.includes("주문상태"));
  if (i !== -1 && cells[i]) return cells[i].trim();
  // 폴백: 알려진 상태어가 들어있는 셀 찾기
  for (const c of cells) { for (const k of _KNOWN_STATUSES) if (c.includes(k)) return c.trim(); }
  return "";
}
// 타이어핑 처리상태별 색상 (배경/글자색)
function _statusColor(statusText) {
  const s = (statusText || "").trim();
  if (s.includes("입금완료"))                 return { bg: "#dcfce7", fg: "#15803d" }; // 초록
  if (s.includes("주문확인"))                  return { bg: "#ffedd5", fg: "#c2410c" }; // 주황
  if (s.includes("입금대기"))                  return { bg: "#fef9c3", fg: "#a16207" }; // 노랑
  if (s.includes("배송 준비중") || s.includes("배송준비")) return { bg: "#e0f2fe", fg: "#0369a1" }; // 하늘
  if (s.includes("배송중"))                    return { bg: "#dbeafe", fg: "#1d4ed8" }; // 파랑
  if (s.includes("배송완료"))                  return { bg: "#ede9fe", fg: "#6d28d9" }; // 보라
  if (s.includes("구매확정"))                  return { bg: "#f0fdf4", fg: "#166534" }; // 연초록
  if (s.includes("재고없음"))                  return { bg: "#fee2e2", fg: "#b91c1c" }; // 빨강
  if (s.includes("취소") || s.includes("미도착") || s.includes("반품") || s.includes("환불"))
    return { bg: "#f3f4f6", fg: "#6b7280" }; // 회색
  return { bg: "", fg: "" };
}

// 페이지네이션 렌더
function _renderOrdPagination() {
  const el = $("ord-pagination");
  if (!el || _ordMaxPage <= 1) { if(el) el.innerHTML=""; return; }
  const cur = _ordPage;
  const max = _ordMaxPage;
  // 윈도우: cur-2 ~ cur+2, 항상 1과 max 포함
  const pages = new Set([1, max]);
  for (let p = Math.max(1, cur-2); p <= Math.min(max, cur+2); p++) pages.add(p);
  const sorted = [...pages].sort((a,b)=>a-b);
  let html = `<button class="btn-gray btn-sm ord-pgbtn" data-p="${cur-1}" ${cur<=1?"disabled":""}>‹</button>`;
  let prev = 0;
  for (const p of sorted) {
    if (p - prev > 1) html += `<span style="color:#9ca3af;padding:0 2px;">…</span>`;
    html += `<button class="btn-sm ord-pgbtn" data-p="${p}" style="min-width:24px;${p===cur?"background:#3b82f6;color:#fff;border:1px solid #2563eb;":"background:#fff;border:1px solid #d1d5db;color:#374151;"}">${p}</button>`;
    prev = p;
  }
  html += `<button class="btn-gray btn-sm ord-pgbtn" data-p="${cur+1}" ${cur>=max?"disabled":""}>›</button>`;
  el.innerHTML = html;
  // 이벤트 위임으로 클릭 처리 (CSP: inline onclick 속성 사용 불가)
  el.querySelectorAll(".ord-pgbtn:not([disabled])").forEach(btn => {
    btn.addEventListener("click", () => { const p=parseInt(btn.dataset.p,10); if(p>=1&&p<=_ordMaxPage) _loadOrders(p); });
  });
}

async function _fetchExcelData(status) {
  // /sell/downloadexcel에서 실제 엑셀을 받아 파싱 → 게러지 그리드 표시용
  try {
    if (typeof XLSX === "undefined") return null;
    const url = `${BASE}/sell/downloadexcel${status ? `?status=${status}` : ""}`;
    const res = await fetch(url, { credentials: "include" });
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    const wb = XLSX.read(buf, { type: "array" });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: "" });
    if (!rows || rows.length < 2) return null;
    const header = rows[0].map(h => (h===null||h===undefined?"":String(h)).trim());
    return { header, rows: rows.slice(1) };
  } catch(e) { console.warn("[판매내역 엑셀]", e.message); return null; }
}

// 제조사/제품명 드롭다운을 실제 orderlist 페이지의 select 옵션으로 채움 (최초 1회만)
let _ordSelectsPopulated = false;
function _populateOrdSelects(html) {
  if (_ordSelectsPopulated) return;
  const fillSelect = (elId, selectName) => {
    const sel = $(elId);
    if (!sel) return;
    const m = html.match(new RegExp(`<select[^>]*name=["']${selectName}["'][^>]*>([\\s\\S]*?)<\\/select>`, "i"));
    if (!m) return;
    const opts = [...m[1].matchAll(/<option[^>]*value=["']([^"']*)["'][^>]*>([\s\S]*?)<\/option>/gi)]
      .map(o => ({ value: o[1], label: o[2].replace(/<[^>]+>/g,"").trim() }))
      .filter(o => o.label);
    if (!opts.length) return;
    sel.innerHTML = opts.map(o => `<option value="${escHtml(o.value)}">${escHtml(o.label)}</option>`).join("");
  };
  fillSelect("ord-company", "company");
  fillSelect("ord-pattern", "pattern");
  _ordSelectsPopulated = true;
}

// ── 타이어게러지용: 1페이지가 아니라 전체 페이지의 주문확인/입금완료 건을 모두 모음 ──
let _garageAllRows = [];      // 전체 페이지에서 모은 주문확인/입금완료 행
// 게러지 그리드를 "주문확인을 누른 순서"대로 보여주기 위한 순번 기록 { orderId: seq }
// (사이트 자체 목록 순서는 주문일자 기준이라, 확인한 순서와 다르게 중간에 섞여 보이는 문제 해결용)
let _confirmSeq = {};
let _confirmSeqCounter = 0;
chrome.storage.local.get(["garage_confirm_seq", "garage_confirm_seq_counter"], r => {
  if (r.garage_confirm_seq) _confirmSeq = r.garage_confirm_seq;
  if (typeof r.garage_confirm_seq_counter === "number") _confirmSeqCounter = r.garage_confirm_seq_counter;
});
let _garageAllLoading = false;
let _garageAllParamsKey = ""; // 마지막으로 전체 로드한 필터 조건(바뀌면 다시 로드)

async function _loadAllConfirmedForGarage() {
  if (_garageAllLoading) return;
  const gv = id => $(id)?.value || "";
  const baseParams = {
    status:         "", // 게러지는 화면의 상태필터(입금완료 등)와 무관하게 항상 전체(주문확인+입금완료 모두)로 조회함
    accountstatus:  gv("ord-accountstatus"),
    sesstype:       gv("ord-sesstype") || "item",
    sessnum:        gv("ord-sessnum"),
    company:        gv("ord-company") || "0",
    pattern:        gv("ord-pattern") || "0",
    width: "0", height: "0", inch: "0",
    startdate:      gv("ord-startdate"),
    enddate:        gv("ord-enddate"),
    search:         gv("ord-search"),
    code:           gv("ord-code"),
  };
  const paramsKey = JSON.stringify(baseParams);
  if (paramsKey === _garageAllParamsKey && _garageAllRows.length) return; // 조건 그대로면 재사용
  _garageAllParamsKey = paramsKey;
  _garageAllLoading = true;
  const st2 = s => { const el=$("ord-status-txt"); if(el) el.textContent=s; };

  try {
    // 1페이지를 먼저 읽어 전체 페이지 수 파악
    const url1 = `${ORD_BASE}?${new URLSearchParams({ ...baseParams, page: 1 }).toString()}`;
    const res1 = await bgFetch(url1);
    if (!res1.ok) { _garageAllLoading = false; return; }
    const p1 = _parseOrderPage(res1.text);
    const maxPage = Math.min(p1.maxPage || 1, 50); // 안전 상한 50페이지

    const collected = [];
    const seen = new Set();
    const addRows = (rows, orderIds) => {
      rows.forEach((cells, i) => {
        const oid = orderIds[i];
        if (!oid || seen.has(oid)) return;
        if (!_isConfirmed(cells, true)) return; // 주문확인/입금완료 등만 게러지 대상 (항상 텍스트로 직접 판별)
        seen.add(oid);
        collected.push({ cells, orderId: oid, dot: undefined });
      });
    };
    addRows(p1.rows, p1.orderIds);
    st2(`전체 로딩 중... (1/${maxPage}페이지, ${collected.length}건)`);

    // 나머지 페이지를 5개씩 병렬로 순회
    for (let base = 2; base <= maxPage; base += 5) {
      const pages = [];
      for (let pg = base; pg < base + 5 && pg <= maxPage; pg++) pages.push(pg);
      const results = await Promise.all(pages.map(pg =>
        bgFetch(`${ORD_BASE}?${new URLSearchParams({ ...baseParams, page: pg }).toString()}`)
      ));
      results.forEach(res => {
        if (!res.ok) return;
        const p = _parseOrderPage(res.text);
        addRows(p.rows, p.orderIds);
      });
      st2(`전체 로딩 중... (${Math.min(base+4,maxPage)}/${maxPage}페이지, ${collected.length}건)`);
    }

    _garageAllRows = collected;
    st2(`${_ordFiltered.length}건 (게러지: 전체 ${collected.length}건)`);
    _renderGarageGrid();
    // DOT/품명/사이즈/배송지 등 상세정보 로드 (백그라운드, 완료될 때마다 갱신)
    _loadDots(_garageAllRows, () => _renderGarageGrid());
  } catch(e) {
    console.warn("[게러지 전체로드] 오류:", e.message);
  } finally {
    _garageAllLoading = false;
  }
}

async function _loadOrders(page = 1) {
  if (_ordLoading) return;
  _ordLoading = true;
  const st2 = s => { const el=$("ord-status-txt"); if(el) el.textContent=s; };
  st2("조회 중…");

  // 타이어핑 실제 검색바와 동일한 파라미터 구성
  const gv = id => $(id)?.value || "";
  const params = new URLSearchParams({
    page,
    status:         gv("ord-status"),
    accountstatus:  gv("ord-accountstatus"),
    sesstype:       gv("ord-sesstype") || "item",
    sessnum:        gv("ord-sessnum"),
    company:        gv("ord-company") || "0",
    pattern:        gv("ord-pattern") || "0",
    width: "0", height: "0", inch: "0",
    startdate:      gv("ord-startdate"),
    enddate:        gv("ord-enddate"),
    search:         gv("ord-search"),
    code:           gv("ord-code"),
  });
  const url = `${ORD_BASE}?${params.toString()}`;

  try {
    const res = await bgFetch(url);
    if (!res.ok) { st2(`오류 (${res.status})`); return; }
    const { rows, orderIds, maxPage } = _parseOrderPage(res.text);
    _ordHeaders = _parseOrderHeader(res.text);
    _ordRows = rows.map((r, i) => ({ cells: r, orderId: orderIds[i], dot: undefined }));
    _ordMaxPage = maxPage;
    _ordPage = page;
    _ordExcelRows = null; // 새 조회 시 초기화
    _populateOrdSelects(res.text); // 제조사/제품명 드롭다운 채우기 (최초 1회)
    _applyOrderFilter();
    st2(`${_ordFiltered.length}건`);
    _renderOrdPagination();
    // DOT 비동기 로드 (품명·사이즈·세부정보·배송지 등 포함)
    _loadDots(_ordRows, () => { _renderOrderTable(); _renderGarageGrid(); });
    _fetchExcelData(gv("ord-status")).then(data => {
      if (data) { _ordExcelRows = data; _renderGarageGrid(); }
    });
    // 타이어게러지는 1페이지가 아니라 전체 페이지의 주문확인/입금완료 건을 모아서 표시
    _garageAllRows = []; // 필터가 바뀌었을 수 있으니 일단 비우고 새로 모음
    _loadAllConfirmedForGarage();
  } catch(e) { st2("오류: " + e.message); }
  finally { _ordLoading = false; }
}

async function _loadDots(rows, onUpdate) {
  const need = rows.filter(r => r.orderId && r.dot === undefined);
  console.log("[상세] _loadDots 시작: 총", rows.length, "행, 조회필요", need.length, "건");
  for (let i = 0; i < need.length; i += 10) {
    await Promise.all(need.slice(i, i+10).map(async r => {
      const d = await _fetchOrderDetail(r.orderId); // 품명·사이즈·세부정보 등 전체 로드
      r.dot = d.dot;
    }));
    onUpdate();
  }
}

function _applyOrderFilter() {
  const q = ($("ord-search")?.value || "").trim().toLowerCase();
  _ordFiltered = q ? _ordRows.filter(r => r.cells.some(c=>c.toLowerCase().includes(q))) : [..._ordRows];
  _renderOrderTable();
  _renderGarageGrid();
}

function _renderOrderTable() {
  const thead = $("orders-thead"), tbody = $("orders-tbody");
  if (!thead || !tbody) return;
  const baseHdrs = _ordHeaders.length ? _ordHeaders : (_ordRows[0]?.cells.map((_,i)=>`열${i+1}`) || []);
  // DOT 컬럼을 "수량" 바로 오른쪽에 삽입 (없으면 맨 끝에 추가)
  const qtyIdx = baseHdrs.findIndex(h => h.includes("수량"));
  const dotInsertAt = qtyIdx === -1 ? baseHdrs.length : qtyIdx + 1;
  const hdrs = [...baseHdrs.slice(0, dotInsertAt), "DOT", ...baseHdrs.slice(dotInsertAt)];
  thead.innerHTML = `<tr>${hdrs.map(h =>
    `<th style="padding:4px 6px;border:1px solid #d1d5db;background:#e5eaf1;text-align:center;white-space:nowrap;font-size:12px;color:#111827;font-weight:700;">${escHtml(h)}</th>`
  ).join("")}</tr>`;
  if (!_ordFiltered.length) {
    tbody.innerHTML = `<tr><td colspan="${hdrs.length}" style="text-align:center;padding:16px;color:#9ca3af;">주문 내역이 없습니다</td></tr>`;
    return;
  }
  const statusColIdx = _ordHeaders.findIndex(h => h.includes("처리상태") || h.includes("주문상태"));
  tbody.innerHTML = _ordFiltered.map((row, ri) => {
    const bg = ri%2===0?"#fff":"#f9fafb";
    const dotYear = row.dot;
    const dotColor = dotYear ? _ordDotColor(dotYear) : "#9ca3af";
    const dotTxt = row.dot === undefined ? "…" : (dotYear || "-");
    const dotCellHtml = `<td style="padding:3px 6px;border:1px solid #e5e7eb;text-align:center;font-weight:700;color:${dotColor};font-size:12px;">${dotTxt}</td>`;
    const cellsHtml = row.cells.map((c,ci) => {
      let td;
      if (ci === statusColIdx && c) {
        const sc = _statusColor(c);
        const badge = sc.bg
          ? `<span style="background:${sc.bg};color:${sc.fg};padding:2px 7px;border-radius:8px;font-size:11px;font-weight:700;white-space:nowrap;">${escHtml(c)}</span>`
          : escHtml(c);
        td = `<td style="padding:3px 6px;border:1px solid #e5e7eb;white-space:nowrap;font-size:12px;text-align:center;color:#1f2937;font-weight:500;">${badge}</td>`;
      } else {
        td = `<td style="padding:3px 6px;border:1px solid #e5e7eb;white-space:nowrap;font-size:12px;color:#1f2937;font-weight:500;">${escHtml(c)}</td>`;
      }
      // 수량 컬럼 바로 다음에 DOT 셀 끼워넣기
      return (ci === dotInsertAt - 1) ? td + dotCellHtml : td;
    }).join("") + (dotInsertAt >= row.cells.length ? dotCellHtml : "");
    return `<tr data-ri="${ri}" data-orderid="${row.orderId||""}" style="background:${bg};cursor:pointer;">${cellsHtml}</tr>`;
  }).join("");
  // 이벤트 위임으로 행 클릭 (CSP: inline onclick 불가)
  tbody.addEventListener("click", e => {
    const tr = e.target.closest("tr"); if (!tr) return;
    document.querySelectorAll("#orders-tbody tr").forEach(r => { r.style.outline=""; r.style.background=r.dataset.ri%2===0?"#fff":"#f9fafb"; });
    tr.style.outline = "2px solid #3b82f6";
    tr.style.background = "#eff6ff";
    const orderId = tr.dataset.orderid;
    if (orderId) _showOrderDetail(orderId);
  });
  tbody.addEventListener("mouseover", e => { const tr=e.target.closest("tr"); if(tr&&tr.style.outline!=="2px solid #3b82f6") tr.style.background="#eff6ff"; });
  tbody.addEventListener("mouseout",  e => { const tr=e.target.closest("tr"); if(tr&&tr.style.outline!=="2px solid #3b82f6") tr.style.background=tr.dataset.ri%2===0?"#fff":"#f9fafb"; });
}

// ── 하단 게러지 그리드
const _GARAGE_COLS = ["A","B\n주문일","C\n주문번호","D\n제조사코드","E\n오늘날짜","F\n배송방법","G\n출고지","H\n품명","I\n사이즈","J\n세부정보","K\nDOT","L\n제조사","M\n수량","N\n우편번호","O\n배송지","P\n받는분","Q\n연락처","R\n요청사항","S\n정산금액","T\n개별원가","U\n총원가합계","V\n택배","W\n택배합계","X\n마진","Y\n공장도가"];
const _GARAGE_PLAIN_HEADERS = ["","주문일","주문번호","제조사코드","오늘날짜","","","품명","사이즈","세부정보","DOT","제조사","수량","우편번호","배송지","받는분","연락처","요청사항","정산금액","개별원가","총원가합계","택배","택배합계","마진","공장도가"];
let _garageSelectedCell = null;
let _garageSelectedRows  = []; // 행 전체 선택된 <tr> 요소들 (단일/다중 모두 여기에 기록)
let _garageAnchorCell   = null; // Shift+클릭 범위선택 시작점
let _garageRowAnchor    = null; // Shift+행번호 클릭 범위선택 시작 행 (ri)
let _garageRangeCells   = [];   // 현재 범위선택된 td들
let _lastGarageRows = [];       // 마지막으로 그린 행 데이터 (전체 복사용)
let _lastGarageStatuses = [];   // 행별 처리상태 텍스트 (색상 표시용, gRows와 병렬)

// 한 주문(r: {cells, orderId, dot})을 게러지 A~Y 배열로 변환 (그리드/시트연동 공용)
function _buildGarageRow(r) {
  const mm = String(new Date().getMonth()+1).padStart(2,"0");
  const dd2 = String(new Date().getDate()).padStart(2,"0");
  const today = mm+"-"+dd2;
  const d = (r.orderId && _ordDetailCache[r.orderId]) ? _ordDetailCache[r.orderId] : {};
  const hx = (...keys) => {
    for (const k of keys) {
      const i = _ordHeaders.findIndex(h => h===k || h.includes(k));
      if (i !== -1) return i;
    }
    return -1;
  };
  const c = r.cells || [];
  const gl = i => i>=0&&i<c.length ? c[i] : "";
  const dot = d.dot ?? (r.dot===undefined ? "…" : (r.dot||""));
  const qtyNum = parseInt(String(d.qty || gl(hx("수량")) || "1").replace(/[^\d]/g,""), 10) || 1;
  const factoryPrice = d.factoryPrice || 0;
  const hasShipFrom = !!(_shipFromMap[r.orderId]); // 출고지가 기록돼 있을 때만 원가/마진 계산
  // T(개별원가): 전역 원가율이 아니라 마진탭(예외탭 포함) 매칭 결과를 최저가봇 표와 동일하게 적용
  // 제조사 컬럼은 "제조사코드"와 헷갈리기 쉬워서(둘 다 "제조사"를 포함) 코드 컬럼은 명시적으로 제외 (주문상세 화면과 동일한 방식)
  const makerColIdx = _ordHeaders.findIndex(h => h.includes("제조사") && !h.includes("코드"));
  const makerForCost   = d.maker   || (makerColIdx !== -1 ? gl(makerColIdx) : "");
  const productForCost = d.product || gl(hx("품명","상품명","타이어명"));
  const detailForCost  = d.detail  || gl(hx("세부정보","옵션"));
  const sizeForCost    = d.size    || gl(hx("사이즈","규격"));
  const dotForCost      = (dot && dot !== "…") ? dot : "";
  const marginMatch = matchMarginTabs(makerForCost, productForCost, detailForCost, sizeForCost, dotForCost);
  console.log(`[게러지 T값] 매칭 시도: 주문#${r.orderId} 제조사="${makerForCost}" 상품명="${productForCost}" 사이즈="${sizeForCost}" DOT="${dotForCost}" → 매칭된탭=[${marginMatch.map(m=>m.tabName).join(", ")}]`);
  // 우선순위: ① 이 주문에 직접 저장해둔 원가입력 > ② 매칭된 탭이 1개뿐이면 그대로 > ③ 출고지 이름과 겹치는 탭 > ④ 제조사명과 겹치는 탭(예: 제조사가 "한국"이면 "한국" 거래처탭과 매칭)
  const curShipFromForCost = (_shipFromMap[r.orderId] || "").replace(/ 익일출고$/, "");
  const savedOv = orderCostOverrides[r.orderId];
  // 이름 비교는 완전일치가 아니라 서로 포함관계(양방향)로 비교 — "한국" 탭 ↔ "한국타이어" 제조사처럼 표기가 달라도 매칭되게
  const _nameMatch = (a, b) => !!a && !!b && (a === b || a.includes(b) || b.includes(a));
  const matchedForShip = savedOv ? null // 저장된 직접입력이 있으면 마진탭 매칭 자체를 안 씀 (아래에서 우선 처리)
    : (marginMatch.length === 1)
      ? marginMatch[0] // 매칭된 탭이 하나뿐이면 애매함이 없으므로(주문상세와 동일하게) 그대로 사용
      : (marginMatch.find(m => _nameMatch(m.tabName, curShipFromForCost))
        || marginMatch.find(m => _nameMatch(m.tabName, makerForCost))
        || null); // 여러 개 매칭될 때만 출고지/제조사명으로 골라냄 (안 그러면 어느 창고 단가인지 특정 불가)
  if (marginMatch.length && !matchedForShip && !savedOv) {
    console.log(`[게러지 T값 매칭실패] 주문#${r.orderId} 제조사="${makerForCost}" 출고지="${curShipFromForCost}" ` +
      `매칭된탭들=[${marginMatch.map(m=>m.tabName).join(", ")}] → 이름이 둘 다 안 겹쳐서 특정 불가(빈칸)`);
  }
  let unitCost = 0;
  const hasCostMatch = factoryPrice && hasShipFrom && (!!savedOv || !!matchedForShip);
  if (factoryPrice && hasShipFrom) {
    if (savedOv) {
      unitCost = (savedOv.costOverride !== null && savedOv.costOverride !== undefined)
        ? savedOv.costOverride
        : Math.round(factoryPrice * (1 - (savedOv.discountPct || 0) / 100));
    } else if (matchedForShip) {
      const m = matchedForShip;
      unitCost = (m.costOverride !== null && m.costOverride !== undefined)
        ? m.costOverride
        : Math.round(factoryPrice * (1 - m.discountPct / 100));
    }
  }
  // 매칭되는 마진탭 규칙이 없거나, 선택된 출고지와 이름이 일치하는 탭이 없으면 T/U/X를 빈칸으로 남김
  const totalCost  = unitCost * qtyNum;
  const shipCost   = shippingCostDefault || 0;
  const sizeForShip = d.size || gl(hx("사이즈","규격"));
  const shipTotalBySize = computeShipTotalBySize(sizeForShip, qtyNum);
  const shipTotal  = shipTotalBySize !== null ? shipTotalBySize : shipCost * qtyNum; // 사이즈별 규칙 우선, 없으면 전역×수량
  const shipUnitDisplay = Math.round(shipTotal / qtyNum); // V열(택배) 표시용 — 묶음배송도 개당 환산값으로 보여줌
  const settleNum  = parseInt(String(gl(hx("정산금액")) || d.settle || "").replace(/[^\d]/g,""), 10) || 0;
  const marginX    = settleNum - totalCost - shipTotal; // 실제 마진 = 정산금액 − 총원가합계 − 택배합계
  const addrForF   = d.addr || gl(hx("배송지","주소"));
  const shipMethod = _computeShipMethod(r.orderId, addrForF);
  return [
    "",                                                                         // A
    (d.orderDate || gl(hx("주문일","주문일시"))).replace(/-/g, ""),               // B 주문일 (하이픈 제거)
    d.orderNo    || gl(hx("주문번호")),                                         // C 주문번호
    d.makerCode  || gl(hx("제조사코드")),                                       // D 제조사코드
    today,                                                                      // E 오늘날짜
    shipMethod, _shipFromMap[r.orderId] || "",                                  // F(직배송/택배/직접출고), G(출고지)
    d.product    || gl(hx("품명","상품명","타이어명")),                         // H 품명
    (d.size || gl(hx("사이즈","규격"))).replace(/r/gi, " ").replace(/\s+/g, " ").trim(), // I 사이즈 (R 제거하고 띄어쓰기로)
    d.detail     || gl(hx("세부정보","옵션")),                                  // J 세부정보
    dot,                                                                        // K DOT
    d.maker      || (makerColIdx !== -1 ? gl(makerColIdx) : ""),                 // L 제조사
    (d.qty       || gl(hx("수량"))).replace(/본$/,"").trim(),                  // M 수량
    d.zip        || gl(hx("우편번호")),                                         // N 우편번호
    d.addr       || gl(hx("배송지","주소")),                                    // O 배송지
    d.recipient  || gl(hx("받는분 이름","받는분")),                             // P 받는분
    d.phone      || gl(hx("배송지 연락처","연락처")),                           // Q 연락처
    d.request    || gl(hx("요청사항")),                                         // R 요청사항
    (gl(hx("정산금액")) || d.settle || "").replace(/원\s*$/, "").trim(),          // S 정산금액
    hasCostMatch ? comma(unitCost)  : "",                                       // T 개별원가 (마진탭 매칭 없으면 빈값)
    hasCostMatch ? comma(totalCost) : "",                                       // U 총원가합계 (마진탭 매칭 없으면 빈값)
    comma(shipUnitDisplay),                                                     // V 택배 (개당, 사이즈별 규칙 반영)
    comma(shipTotal),                                                          // W 택배합계
    hasCostMatch ? comma(marginX) : "",                                         // X 마진 (마진탭 매칭 없으면 빈값)
    factoryPrice ? comma(factoryPrice) : "",                                    // Y 공장도가
  ];
}

function _buildGarageRows() {
  // 상세 페이지 캐시(_ordDetailCache)에서 직접 데이터 사용 — 다운로드 불필요
  // DOT 조회 시 이미 품명·사이즈·세부정보·배송지 등이 같이 로드됨
  _lastGarageStatuses = []; // 행별 처리상태 (색상 표시용, 병렬 배열)
  const statusFilter = $("garage-status-filter")?.value || ""; // "" 전체 / "입금완료" / "주문확인"
  // 전체 페이지에서 모은 목록이 있으면 그걸 사용 (이미 주문확인/입금완료로 필터됨), 없으면 현재 페이지만
  const confirmedRows = _garageAllRows.length
    ? _garageAllRows
    : _ordFiltered.filter(r => _isConfirmed(r.cells));
  const filteredRows = confirmedRows.filter(r => {
    if (!statusFilter) return true;
    const d = (r.orderId && _ordDetailCache[r.orderId]) ? _ordDetailCache[r.orderId] : {};
    const statusText = d.curStatus || _rowStatusText(r.cells);
    return statusText.includes(statusFilter);
  });
  filteredRows.forEach(r => {
    const d = (r.orderId && _ordDetailCache[r.orderId]) ? _ordDetailCache[r.orderId] : {};
    _lastGarageStatuses.push(d.curStatus || _rowStatusText(r.cells));
  });
  // 주문확인을 누른 순서대로 정렬 (최근에 확인한 건이 위로) — 순번 기록이 없는 항목(확장 설치 전 데이터 등)은
  // 원래 순서(사이트 목록 순서)를 유지한 채 맨 뒤로 밀림
  const withSeqIdx = filteredRows.map((r, i) => ({ r, statusText: _lastGarageStatuses[i], origIdx: i, seq: _confirmSeq[r.orderId] }));
  withSeqIdx.sort((a, b) => {
    if (a.seq !== undefined && b.seq !== undefined) return b.seq - a.seq; // 최근 확인건이 위로
    if (a.seq !== undefined) return -1;
    if (b.seq !== undefined) return 1;
    return a.origIdx - b.origIdx; // 기록 없는 것끼리는 원래 순서 유지
  });
  _lastGarageStatuses = withSeqIdx.map(x => x.statusText);
  return withSeqIdx.map(x => x.r).map(_buildGarageRow);
}

function _renderGarageGrid() {
  const wrap = $("garage-grid-wrap");
  if (!wrap) return;
  const gRows = _buildGarageRows();
  const gStatuses = _lastGarageStatuses; // _buildGarageRows 실행 중 채워짐 (병렬 배열)
  _lastGarageRows = gRows; // 전체 복사 버튼용으로 보관
  const cnt = $("garage-count"); if(cnt) cnt.textContent = gRows.length ? `${gRows.length}건` : "없음";
  // 실제 헤더 표시 (컬럼 매핑 확인용)
  const hdrEl = $("garage-headers-debug");
  if (hdrEl) hdrEl.title = "실제 헤더: " + _ordHeaders.join(" | ");
  if (!gRows.length) {
    const allLoaded = _ordFiltered.filter(r => _isConfirmed(r.cells)).every(r => r.dot !== undefined);
    wrap.innerHTML = allLoaded
      ? `<div style="padding:10px;color:#9ca3af;text-align:center;font-size:10px;">주문확인 건 없음</div>`
      : `<div style="padding:10px;color:#6b7280;text-align:center;font-size:10px;">⏳ 상세 정보 로드 중... (품명·사이즈·세부정보 포함)</div>`;
    return;
  }
  const colW = [20,64,84,64,52,20,20,110,64,64,40,56,32,56,150,66,84,84,60,64,72,54,64,72,64];
  const thHtml = _GARAGE_COLS.map((h,i)=>
    `<th style="width:${colW[i]||56}px;min-width:${colW[i]||56}px;padding:1px 2px;background:#d9e1f2;border:1px solid #b4c4e0;text-align:center;font-size:8px;white-space:pre-line;line-height:1.2;color:#1f3864;">${h.replace("\n","<br>")}</th>`
  ).join("");
  const tbHtml = gRows.map((row,ri)=>{
    const statusC = _statusColor(gStatuses[ri]);
    const rowBg = statusC.bg || (ri%2===0 ? "#ffffff" : "#fafafa");
    return `<tr data-ri="${ri}" data-basebg="${rowBg}" title="${escHtml(gStatuses[ri]||"")}"><td class="garage-rownum" data-ri="${ri}" title="클릭: 이 행 전체 복사"
        style="width:20px;padding:1px 2px;border:1px solid #d1d5db;text-align:center;font-size:8px;color:#6366f1;background:#eef2ff;cursor:pointer;font-weight:600;">${ri+1}</td>${row.map((v,ci)=>{
      const isDot=ci===10, color=isDot&&v&&v!=="…"?_ordDotColor(parseInt(v,10)):"";
      return `<td data-ci="${ci}" data-ri="${ri}" title="${escHtml(String(v))}"
        style="width:${colW[ci]||56}px;padding:1px 2px;border:1px solid #d1d5db;white-space:nowrap;overflow:hidden;font-size:8px;background:${rowBg};cursor:cell;${isDot&&color?`color:${color};font-weight:700;`:(statusC.fg?`color:${statusC.fg};`:"")}">${escHtml(String(v))}</td>`;
    }).join("")}</tr>`;
  }).join("");
  wrap.innerHTML = `<table id="garage-table" style="border-collapse:collapse;font-family:'맑은 고딕',sans-serif;table-layout:fixed;">
    <thead><tr><th style="width:20px;background:#d9e1f2;border:1px solid #b4c4e0;font-size:8px;">#</th>${thHtml}</tr></thead>
    <tbody>${tbHtml}</tbody>
  </table>`;
  const tbl = wrap.querySelector("#garage-table");

  const baseBg = td => td.closest("tr")?.dataset.basebg || "";
  const clearRowHighlight = () => {
    _garageSelectedRows.forEach(tr => { [...(tr.children||[])].forEach(td => td.style.background = baseBg(td)); });
    _garageSelectedRows = [];
  };
  const clearCellHighlight = () => {
    if (_garageSelectedCell) { _garageSelectedCell.style.background = baseBg(_garageSelectedCell); _garageSelectedCell = null; }
  };
  const clearRangeHighlight = () => {
    _garageRangeCells.forEach(td => td.style.background = baseBg(td));
    _garageRangeCells = [];
  };

  // 범위 내 td들 수집 (ri1~ri2, ci1~ci2 사각형)
  const collectRange = (ri1, ci1, ri2, ci2) => {
    const [rLo, rHi] = [Math.min(ri1,ri2), Math.max(ri1,ri2)];
    const [cLo, cHi] = [Math.min(ci1,ci2), Math.max(ci1,ci2)];
    const out = [];
    for (let ri = rLo; ri <= rHi; ri++) {
      const tr = tbl.querySelector(`tbody tr[data-ri="${ri}"]`);
      if (!tr) continue;
      for (let ci = cLo; ci <= cHi; ci++) {
        const td = tr.querySelector(`td[data-ci="${ci}"]`);
        if (td) out.push(td);
      }
    }
    return out;
  };
  const rangeToTsv = (ri1, ci1, ri2, ci2) => {
    const [rLo, rHi] = [Math.min(ri1,ri2), Math.max(ri1,ri2)];
    const [cLo, cHi] = [Math.min(ci1,ci2), Math.max(ci1,ci2)];
    const lines = [];
    for (let ri = rLo; ri <= rHi; ri++) {
      const row = gRows[ri] || [];
      lines.push(row.slice(cLo, cHi+1).join("\t"));
    }
    return lines.join("\n");
  };

  tbl.addEventListener("click", e => {
    // 행 번호 클릭 → 한 줄 전체 복사 (Shift+클릭이면 이전 행번호부터 여러 행 전체 선택)
    const rownumTd = e.target.closest(".garage-rownum");
    if (rownumTd) {
      clearCellHighlight(); clearRangeHighlight();
      const ri = parseInt(rownumTd.dataset.ri, 10);

      if (e.shiftKey && _garageRowAnchor !== null) {
        clearRowHighlight();
        const rLo = Math.min(_garageRowAnchor, ri), rHi = Math.max(_garageRowAnchor, ri);
        const lines = [];
        const selectedTrs = [];
        for (let r = rLo; r <= rHi; r++) {
          const tr = tbl.querySelector(`tbody tr[data-ri="${r}"]`);
          if (tr) { [...tr.children].forEach(td => td.style.background = "#bfdbfe"); selectedTrs.push(tr); }
          lines.push((gRows[r] || []).join("\t"));
        }
        _garageSelectedRows = selectedTrs;
        const tsv = lines.join("\n");
        navigator.clipboard?.writeText(tsv).then(() => {
          st(`📋 ${rLo+1}~${rHi+1}번 행 (${rHi-rLo+1}개) 복사됨 (엑셀에 Ctrl+V로 붙여넣기)`);
        }).catch(() => {});
        const el = $("garage-cell-val"); if (el) { el.value = tsv; el.select(); }
        _garageRowAnchor = ri; // 다음 shift+클릭 이어서 범위 확장 가능하도록 갱신
        return;
      }

      clearRowHighlight();
      _garageAnchorCell = null;
      _garageRowAnchor = ri;
      const tr = rownumTd.closest("tr");
      [...tr.children].forEach(td => td.style.background = "#bfdbfe");
      _garageSelectedRows = [tr];
      const rowVals = gRows[ri] || [];
      const tsv = rowVals.join("\t");
      navigator.clipboard?.writeText(tsv).then(() => {
        st(`📋 ${ri+1}번 행 복사됨 (엑셀에 Ctrl+V로 붙여넣기)`);
      }).catch(() => {});
      const el = $("garage-cell-val"); if (el) { el.value = tsv; el.select(); }
      return;
    }
    // 일반 셀 클릭
    const td = e.target.closest("td"); if(!td) return;
    const ri = parseInt(td.dataset.ri, 10), ci = parseInt(td.dataset.ci, 10);

    // Shift+클릭 → 범위 선택 + 즉시 복사 (엑셀처럼 부분부분 긁기)
    if (e.shiftKey && _garageAnchorCell) {
      clearRowHighlight(); clearRangeHighlight(); clearCellHighlight();
      const ar = parseInt(_garageAnchorCell.dataset.ri, 10), ac = parseInt(_garageAnchorCell.dataset.ci, 10);
      const cells = collectRange(ar, ac, ri, ci);
      cells.forEach(c => c.style.background = "#93c5fd");
      _garageRangeCells = cells;
      const tsv = rangeToTsv(ar, ac, ri, ci);
      navigator.clipboard?.writeText(tsv).then(() => {
        st(`📋 범위 ${cells.length}칸 복사됨 (엑셀에 Ctrl+V로 붙여넣기)`);
      }).catch(() => {});
      const el = $("garage-cell-val"); if (el) { el.value = tsv; el.select(); }
      return;
    }

    // 단일 셀 클릭 → 선택 + 범위선택 시작점 갱신
    clearRowHighlight(); clearRangeHighlight(); clearCellHighlight();
    td.style.background="#bfdbfe"; _garageSelectedCell=td; _garageAnchorCell = td;
    _garageRowAnchor = null;
    const val=td.title||td.textContent;
    const el=$("garage-cell-val"); if(el){el.value=val;el.select();}
  });
  tbl.addEventListener("keydown", e => {
    if((e.ctrlKey||e.metaKey)&&e.key==="c"){
      if (_garageRangeCells.length) {
        const ar = parseInt(_garageAnchorCell?.dataset.ri, 10);
        // 범위는 이미 복사됐으므로 재복사만
        const el = $("garage-cell-val"); if (el) navigator.clipboard?.writeText(el.value);
      } else if (_garageSelectedRows.length) {
        const tsv = _garageSelectedRows.map(tr => (gRows[parseInt(tr.dataset.ri,10)]||[]).join("\t")).join("\n");
        navigator.clipboard?.writeText(tsv);
      } else if (_garageSelectedCell) {
        const val=_garageSelectedCell.title||_garageSelectedCell.textContent;
        navigator.clipboard?.writeText(val);
      }
    }
  });
  tbl.setAttribute("tabindex","0");
}

// 전체 그리드 내용을 탭 구분 텍스트로 복사 (엑셀에 그대로 붙여넣기 가능)
function _copyGarageAll() {
  if (!_lastGarageRows.length) { alert("복사할 주문확인 건이 없습니다."); return; }
  const tsv = [_GARAGE_PLAIN_HEADERS, ..._lastGarageRows].map(r => r.join("\t")).join("\n");
  navigator.clipboard?.writeText(tsv).then(() => {
    st(`📋 전체 ${_lastGarageRows.length}건 복사됨 (엑셀에 Ctrl+V로 붙여넣기)`);
  }).catch(e => {
    st("❌ 복사 실패: " + e.message);
  });
}

async function _exportGarageExcel() {
  // 게러지 확장과 동일: /sell/downloadexcel에서 실제 엑셀을 받아 A~S 컬럼으로 변환
  const btn = $("garage-excel");
  if (btn) { btn.disabled = true; btn.textContent = "⏳ 변환중..."; }
  try {
    if (typeof XLSX === "undefined") throw new Error("XLSX 라이브러리 로드 안됨 — 확장 새로고침 후 재시도");

    // 현재 상태 필터 반영
    const status = $("ord-status")?.value || "";
    const dlUrl = `${BASE}/sell/downloadexcel${status ? `?status=${status}` : ""}`;
    const res = await fetch(dlUrl, { credentials: "include" });
    if (!res.ok) throw new Error(`다운로드 실패 (${res.status})`);
    const buf = await res.arrayBuffer();

    const wb = XLSX.read(buf, { type: "array" });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: "" });
    if (!rows || rows.length < 2) throw new Error("엑셀 데이터가 비어 있습니다");

    const header = rows[0].map(h => (h===null||h===undefined?"":String(h)).trim());
    const ci = k => header.indexOf(k);
    const idx = {
      orderDate:     ci("주문일"),
      orderNo:       ci("주문번호"),
      makerCode:     ci("제조사코드"),
      name:          ci("품명"),
      size:          ci("사이즈"),
      detail:        ci("세부정보"),
      dot:           ci("DOT"),
      maker:         ci("제조사"),
      qty:           ci("수량"),
      zip:           ci("우편번호"),
      addr:          ci("배송지"),
      recipient:     ci("받는분 이름"),
      phone:         ci("배송지 연락처"),
      request:       ci("요청사항"),
      settleAmount:  ci("정산금액"),
      status:        ci("상태"),
    };

    const mm = String(new Date().getMonth()+1).padStart(2,"0");
    const dd2 = String(new Date().getDate()).padStart(2,"0");
    const today = mm+"-"+dd2;
    const g = (row, k) => { const i=idx[k]; return i===-1?"":row[i]===undefined?"":String(row[i]); };

    // 주문확인 건만 필터 (+ 화면의 상태 필터(전체/입금완료만/주문확인만)도 그대로 반영)
    const gStatusFilter = $("garage-status-filter")?.value || "";
    const dataRows = rows.slice(1).filter(row => {
      const st = g(row,"status");
      const isConfirmedLike = st.includes("주문확인") || st.includes("결제완료") || st.includes("입금완료") || !idx.status || idx.status===-1;
      if (!isConfirmedLike) return false;
      if (gStatusFilter) return st.includes(gStatusFilter);
      return true;
    });
    if (!dataRows.length) throw new Error("주문확인 건이 없습니다");

    // 공장도가: 주문 상세 캐시(_ordDetailCache)에서 주문번호로 매칭 (다운로드 엑셀엔 공장도가가 없음)
    const factoryByOrderNo = {};
    for (const key in _ordDetailCache) {
      const d = _ordDetailCache[key];
      if (d?.orderNo) factoryByOrderNo[d.orderNo] = d.factoryPrice || 0;
    }

    const outHdrs = ["A","주문일","주문번호","제조사코드","오늘날짜","","","품명","사이즈","세부정보","DOT","제조사","수량","우편번호","배송지","받는분","연락처","요청사항","정산금액","개별원가","총원가합계","택배","택배합계","마진","공장도가"];
    const outRows = dataRows.map(row => {
      const orderNo = g(row,"orderNo");
      const factoryPrice = factoryByOrderNo[orderNo] || 0;
      const hasShipFrom = !!(_shipFromMap[orderNo]); // 출고지 기록 전엔 원가/마진 계산 안 함
      const qtyNum = parseInt(String(g(row,"qty")).replace(/[^\d]/g,""), 10) || 1;
      const unitCost   = (factoryPrice && hasShipFrom) ? Math.round(factoryPrice * (1 - costRatePct / 100)) : 0;
      const totalCost  = unitCost * qtyNum;
      const shipCost   = shippingCostDefault || 0;
      const sizeForShip = g(row,"size");
      const shipTotalBySize = computeShipTotalBySize(sizeForShip, qtyNum);
      const shipTotal  = shipTotalBySize !== null ? shipTotalBySize : shipCost * qtyNum;
      const shipUnitDisplay = Math.round(shipTotal / qtyNum);
      const settleNum  = parseInt(String(g(row,"settleAmount")).replace(/[^\d]/g,""), 10) || 0;
      const marginX    = settleNum - totalCost - shipTotal;
      return [
        "",
        g(row,"orderDate"),
        orderNo,
        g(row,"makerCode"),
        today,
        "","",
        g(row,"name"),
        g(row,"size"),
        g(row,"detail"),
        g(row,"dot"),
        g(row,"maker"),
        String(g(row,"qty")).replace(/본$/,""),
        g(row,"zip"),
        g(row,"addr"),
        g(row,"recipient"),
        g(row,"phone"),
        g(row,"request"),
        g(row,"settleAmount"),
        factoryPrice && hasShipFrom ? comma(unitCost)  + "원" : "",
        factoryPrice && hasShipFrom ? comma(totalCost) + "원" : "",
        comma(shipUnitDisplay) + "원",
        comma(shipTotal) + "원",
        factoryPrice && hasShipFrom ? comma(marginX) + "원" : "",
        factoryPrice ? comma(factoryPrice) : "",
      ];
    });

    // TSV로 내보내기 (맑은 고딕 스타일은 ExcelJS 필요, 여기선 TSV로 충분)
    const tsv = [outHdrs, ...outRows].map(r => r.map(c=>`"${String(c).replace(/"/g,'""')}"`).join("\t")).join("\n");
    const blob = new Blob(["\uFEFF"+tsv], { type:"text/tab-separated-values" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob);
    const y = new Date().getFullYear();
    a.download = `타이어게러지_${y}${mm}${dd2}.xls`;
    document.body.appendChild(a); a.click(); a.remove();
    st(`✅ 타이어게러지 엑셀 ${outRows.length}건 추출 완료`);
  } catch(e) {
    st(`❌ 게러지 엑셀 오류: ${e.message}`);
    alert("오류: " + e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "📥 게러지 엑셀"; }
  }
}
function _exportOrdersExcel() {
  if(!_ordFiltered.length){alert("내보낼 데이터가 없습니다.");return;}
  const hdrs=[..._ordHeaders,"DOT"];
  const tsv=[hdrs,..._ordFiltered.map(r=>[...r.cells,r.dot??""])].map(r=>r.map(c=>`"${String(c).replace(/"/g,'""')}"`).join("\t")).join("\n");
  const blob=new Blob(["\uFEFF"+tsv],{type:"text/tab-separated-values"});
  const a=document.createElement("a");a.href=URL.createObjectURL(blob);
  a.download=`판매내역_${new Date().toISOString().slice(0,10)}.xls`;
  document.body.appendChild(a);a.click();a.remove();
}

function enterOrdersView() {
  if(viewMode==="fav")enterSearchView();
  if(viewMode==="mine")leaveMineView();
  viewMode="orders";
  $("table-wrap").style.display="none";
  $("orders-panel").style.display="flex";
  $("summary-bar").style.display="none";
  $("mine-mfr-bar").style.display="none";
  $("biz-tab-bar").style.display="none";
  $("price-mfr-bar").style.display="none"; // 최저가봇 전용 제조사 빠른필터는 판매내역에서 숨김
  $("fav-autostock-bar").style.display="none";
  $("fav-as-log").style.display="none";
  $("search-bar").style.display="none"; // 최저가봇 검색 필터바(사이즈/제조사/단면폭/편평비/인치 등)는 판매내역에서 안 보이게
  $("action-bar").style.display="none"; // 전체선택/거래처로넘기기 등 최저가봇 액션바 전체도 판매내역에서 안 보이게
  if(!_ordRows.length) _loadOrders(1);
}
function leaveOrdersView() {
  viewMode="search";
  $("table-wrap").style.display="";
  $("orders-panel").style.display="none";
  $("summary-bar").style.display="";
  $("search-bar").style.display=""; // 최저가봇 탭으로 복귀 시 검색 필터바 다시 표시
  $("action-bar").style.display=""; // 액션바도 다시 표시
  _updatePriceMfrTabs();
}
// ── 자동 재고 채우기 (UI 제어) ───────────────────────────────
function _asFmtTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  const p = n => String(n).padStart(2, "0");
  return `${p(d.getMonth()+1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
// 설정/상태를 storage에서 읽어 UI에 반영
function renderAutoStockStatus() {
  chrome.storage.local.get(["auto_stock_cfg", "auto_stock_last"], d => {
    const cfg  = d.auto_stock_cfg || {};
    const last = d.auto_stock_last;
    const tgl  = $("fav-as-toggle");
    const stEl = $("fav-as-status");
    const iv   = $("fav-as-interval");
    const tg   = $("fav-as-target");
    if (iv && cfg.intervalMin) iv.value = String(cfg.intervalMin);
    if (tg && cfg.target)      tg.value = String(cfg.target);
    const on = !!cfg.enabled;
    if (tgl) {
      tgl.textContent = on ? "⏹ 중지" : "▶ 시작";
      tgl.classList.toggle("btn-sky", !on);
      tgl.classList.toggle("btn-red", on);
    }
    if (stEl) {
      let s = on ? `🟢 켜짐 (${cfg.intervalMin}분마다 ${cfg.target}개로 채움)` : "⚪ 꺼짐";
      if (last) s += ` · 최근 ${_asFmtTime(last.ts)}: ${last.msg || ""}`;
      stEl.textContent = s;
    }
  });
}
function renderAutoStockLog() {
  const box = $("fav-as-log");
  if (!box) return;
  chrome.storage.local.get("auto_stock_log", d => {
    const log = d.auto_stock_log || [];
    if (!log.length) { box.textContent = "실행 기록이 없습니다."; return; }
    box.textContent = log.map(e => {
      const head = `[${_asFmtTime(e.ts)}] ${e.trigger === "manual" ? "수동" : "자동"} — ${e.msg || ""}`;
      const det  = (e.details && e.details.length) ? "\n   " + e.details.join("\n   ") : "";
      return head + det;
    }).join("\n");
  });
}
let checkedSet    = new Set();  // iid(인덱스) 집합
let autoRefreshing = false;
let companyMap    = {};   // {name: id}
let patternMap    = {};   // {name: id}
let myStoreId     = "";
let lastShiftIdx  = null; // 하위호환용
let _lastShiftKey = null; // shift anchor: tire_id+dot 키

// checkedSet은 "tire_id_dot" 문자열 키 기반 (인덱스 기반에서 전환)
// → renderTable rAF 디바운스 중 DOM/shownProducts 불일치와 완전히 분리
function _pKey(p)    { return p ? `${p.tire_id}_${p.dot || ""}` : null; }
function _idxKey(i)  { const p = shownProducts[i]; return _pKey(p); }
function _keyIdx(k)  { return shownProducts.findIndex(p => _pKey(p) === k); }
let _shiftHeld    = false;  // 키보드 이벤트로 직접 추적 (e.shiftKey 오감지 방지)
let _anchorState  = true;  // anchor 클릭 시점의 체크 상태

// ── 컬럼 정의
const COLS = [
  { key: "chk",          label: "✔",      w: 22,  sort: null },
  { key: "판매",         label: "⭐📁",   w: 46,  sort: "fav" },
  { key: "제조사",       label: "제조사", w: 50,  sort: "manufacturer" },
  { key: "제품명",       label: "제품명", w: 120, sort: "product", left: true },
  { key: "사이즈",       label: "사이즈", w: 72,  sort: "size" },
  { key: "세부정보",     label: "세부정보",w: 90, sort: "detail", left: true },
  { key: "DOT",          label: "DOT",    w: 38,  sort: "dot" },
  { key: "공장도가",     label: "공장도", w: 68,  sort: "factory_price" },
  { key: "시장최저가",   label: "시장최저",w: 68, sort: "market_lowest" },
  { key: "내판매가",     label: "내가격", w: 68,  sort: "my_price" },
  { key: "내DC율",       label: "내DC%",  w: 44,  sort: "dc_rate" },
  { key: "원가",         label: "원가",   w: 64,  sort: "cost" },
  { key: "택배",         label: "택배",   w: 50,  sort: "shipping" },
  { key: "마진",         label: "마진",   w: 64,  sort: "margin" },
  { key: "경쟁DC율",     label: "경쟁DC%", w: 44, sort: "comp_dc" },
  { key: "경쟁최저가",   label: "경쟁최저",w: 68, sort: "lowest_price" },
  { key: "경쟁판매점",   label: "판매점", w: 70,  sort: "lowest_seller" },
  { key: "내일출고차이", label: "내일차이", w: 60, sort: "tomorrow_gap" },
  { key: "내순위",       label: "내순위", w: 38,  sort: "my_rank" },
  { key: "2등가격",      label: "2등",    w: 68,  sort: "second_price" },
  { key: "차이",         label: "차이",   w: 54,  sort: "diff" },
  { key: "내재고",       label: "내재고",  w:44,  sort: "my_stock" },
  { key: "시장재고",     label: "시장재고",w:44,  sort: "market_stock" },
  { key: "상태",         label: "상태",   w: 62,  sort: "status_order" },
  { key: "액션",         label: "",       w: 110, sort: "action_order" },
  { key: "행사최저",     label: "행사최저", w: 62, sort: "event_low_gap" },
  { key: "출고",         label: "출고",   w: 52,  sort: "send_kind_order" },
  { key: "출고시간",     label: "출고시간", w: 62, sort: "send_time" },
  { key: "구매제한",     label: "구매제한", w: 62, sort: "evensell" },
];

// ── 사전 계산 상수 (성능 최적화)
const FILTERABLE    = COLS.filter(c => c.key !== "chk" && c.key !== "판매" && c.key !== "출고" && c.key !== "출고시간" && c.key !== "구매제한" && c.key !== "행사최저" && c.key !== "내일출고차이").map(c => c.key);
const _RE_SIZE_NORM = /[\s\/rR]/g;
const _RE_SPACE     = /\s/g;
const _RE_SPACES    = /\s+/g;

// Object.keys(o).length > 0 보다 빠른 비어있음 체크
function _hasKeys(o) { for (const _ in o) return true; return false; }

// dot 정규화: "2024/01"→"2024", "26"→"2026", "0"/"DOT"/""→""
const _RE_YEAR = /\b(20\d{2})\b/;
function _normDot(raw) {
  if (!raw || raw === "0" || raw === "DOT") return "";
  const m4 = String(raw).match(_RE_YEAR);
  if (m4) return m4[1];
  const m2 = String(raw).match(/^(2[0-9])$/);
  if (m2) return "20" + m2[1];
  return "";
}

// ── 유틸
const toInt = s => {
  if (typeof s === "number") return s | 0;
  const str = String(s || "");
  let n = 0, found = false;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c >= 48 && c <= 57) { n = n * 10 + (c - 48); found = true; }
    else if (c === 44 && found) continue; // 쉼표: 숫자 시작 후만 구분자
    else if (found) break;               // 숫자 시작 후 비숫자 → 종료
  }
  return n;
};
function toFloat(s) {
  const m = String(s).match(/[\d.]+/);
  return m ? parseFloat(m[0]) : 0;
}
// ── 원가율 / 핑수수료율 / 택배비 (마진 계산용) ─────────────────
// 원가 = 공장도가 × (1 − 원가율(%)). 상품별로 원가율을 직접 덮어쓸 수 있고,
// 없으면 전역 기본값(costRatePct)을 사용한다. 택배비도 동일한 방식(전역 기본값 + 상품별 덮어쓰기).
// 마진 = 내판매가 − 원가 − (내판매가 × 수수료율%) − 택배비
let costRatePct           = 85;    // 전역 기본 원가율(%) — 공장도가 대비 할인율
let feeRatePct            = 2.49;  // 핑수수료율(%)
let shippingCostDefault   = 0;     // 전역 기본 택배비(원)
let costRateOverrides     = {};    // { "tire_id__dot": 원가율(%) } — 상품별 오버라이드
let shippingCostOverrides = {};    // { "tire_id__dot": 택배비(원) } — 상품별 오버라이드

function _costKey(p) { return `${p.tire_id || ""}__${p.dot || ""}`; }

// 최저가봇 표에서 마진탭 매칭 정보를 가져옴 — {rate, costOverride, tabName} 또는 매칭 없으면 null
// (예외탭이 매칭되면 matchMarginTabs가 그것만 반환하므로 자동으로 최우선 적용됨)
// ── 성능 최적화: 마진탭/사이즈별택배비 매칭 결과 캐시 ──────────
// 렌더마다 matchMarginTabs/사이즈 검색을 반복하면 느려지므로, 제조사+상품명+세부정보+사이즈
// 조합별로 한 번만 계산해서 재사용. 설정이 바뀌면(_saveMarginTabsLocal/_saveShipSizeRulesLocal)
// 캐시를 비워서 다음 조회 때 새로 계산되게 함.
const _marginMatchCache   = new Map(); // key → matches 배열
const _shipSizeMatchCache = new Map(); // 정규화된 사이즈 → rule 또는 null

function _marginMatchCached(maker, product, detail, size, dot) {
  const key = `${maker||""}|${product||""}|${detail||""}|${size||""}|${dot||""}`;
  if (_marginMatchCache.has(key)) return _marginMatchCache.get(key);
  const result = matchMarginTabs(maker, product, detail, size, dot);
  _marginMatchCache.set(key, result);
  return result;
}
function _shipSizeRuleCached(size) {
  const key = _normSizeForShip(size);
  if (!key) return null;
  if (_shipSizeMatchCache.has(key)) return _shipSizeMatchCache.get(key);
  const rule = _shipSizeRules.find(r => _normSizeForShip(r.size) === key) || null;
  _shipSizeMatchCache.set(key, rule);
  return rule;
}

// 매칭된 규칙의 "실질 할인율" — 원가 직접입력이면 공장도가 대비 환산해서 비교 가능하게 함
function _effDiscountRate(m, factoryPrice) {
  if (m.costOverride !== null && m.costOverride !== undefined && factoryPrice) {
    return (1 - m.costOverride / factoryPrice) * 100;
  }
  return m.discountPct || 0;
}
function _marginTabCostInfo(p) {
  if (typeof matchMarginTabs !== "function" || !_marginTabs || !_marginTabs.length) return null;
  const matches = _marginMatchCached(p.manufacturer, p.product, p.detail, p.size, p.dot);
  if (!matches.length) return null;
  // 같은 상품이 여러 탭에 동시에 매칭되면, 할인율(실질)이 가장 높은 탭을 사용
  let best = matches[0];
  let bestRate = _effDiscountRate(best, p.factory_price);
  for (let i = 1; i < matches.length; i++) {
    const r = _effDiscountRate(matches[i], p.factory_price);
    if (r > bestRate) { best = matches[i]; bestRate = r; }
  }
  return { rate: best.discountPct, costOverride: best.costOverride ?? null, tabName: best.tabName };
}

// 이 상품의 원가 계산 근거를 결정 — 사용자 직접수정(오버라이드) > 마진탭 매칭 > 없음(null)
// 반환: {rate, costOverride, source:'override'|'margintab'} 또는 null (마진탭에도 없으면 원가 계산 자체를 하지 않음)
function effectiveCostInfo(p) {
  const ov = costRateOverrides[_costKey(p)];
  if (ov !== undefined && ov !== null && ov !== "") {
    return { rate: ov, costOverride: null, source: "override" };
  }
  const mt = _marginTabCostInfo(p);
  if (mt) return { ...mt, source: "margintab" };
  return null; // 마진탭에도 없으면 원가/마진을 계산하지 않음 (표시 안 함)
}
// 화면 표시/편집 시작값용 — 오버라이드 또는 마진탭 할인율(%). 원가직접입력 규칙이면 null(표시는 costOverride로 별도 처리)
function effectiveCostRate(p) {
  const info = effectiveCostInfo(p);
  if (!info) return null;
  return (info.costOverride !== null && info.costOverride !== undefined) ? null : info.rate;
}
// 이 상품의 택배비 계산 근거 — 사용자 직접수정(오버라이드) > 사이즈별 택배비 규칙 > 없음(null)
// 사이즈별 규칙이 묶음(bundle)이어도, 이 표는 특정 주문 수량과 무관한 일반 목록이므로
// 묶음이 아닌 기본 배송비(price)를 대표값으로 사용함
function effectiveShippingInfo(p) {
  const ov = shippingCostOverrides[_costKey(p)];
  if (ov !== undefined && ov !== null && ov !== "") {
    return { value: ov, source: "override" };
  }
  const rule = _shipSizeRuleCached(p.size);
  if (rule) return { value: rule.price, source: "sizeship" };
  return null; // 사이즈별 규칙에도 없으면 계산하지 않음 (표시 안 함)
}
function effectiveShippingCost(p) {
  const info = effectiveShippingInfo(p);
  return info ? info.value : null;
}
function calcCost(p) {
  if (!p.factory_price) return null;
  const info = effectiveCostInfo(p);
  if (!info) return null; // 사용자 오버라이드도 없고 마진탭에도 매칭 안 되면 원가 계산 안 함
  if (info.costOverride !== null && info.costOverride !== undefined) return info.costOverride;
  return Math.round(p.factory_price * (1 - info.rate / 100));
}
// 마진 = 내판매가 − 원가 − 수수료 − 택배비. 원가 계산 불가(마진탭 매칭 없음)면 마진도 null
function calcMargin(p) {
  if (!p.is_mine || !p.my_price) return null;
  const cost = calcCost(p);
  if (cost === null) return null;
  const fee  = Math.round(p.my_price * feeRatePct / 100);
  const ship = effectiveShippingCost(p) || 0;
  return p.my_price - cost - fee - ship;
}

let dotOverrides = {};    // { pid: "2024" } — 사용자가 직접 수정한 DOT(생산년도)
// 주문별 원가 직접입력 저장 { orderId: {discountPct, costOverride} } — 게러지(주문확인) T열(개별원가)에 최우선 반영됨
let orderCostOverrides = {};
chrome.storage.local.get(["order_cost_overrides"], r => {
  if (r.order_cost_overrides) orderCostOverrides = r.order_cost_overrides;
});
async function saveOrderCostOverride(orderId, ov) {
  orderCostOverrides[orderId] = ov;
  await new Promise(res => chrome.storage.local.set({ order_cost_overrides: orderCostOverrides }, res));
}
async function clearOrderCostOverride(orderId) {
  delete orderCostOverrides[orderId];
  await new Promise(res => chrome.storage.local.set({ order_cost_overrides: orderCostOverrides }, res));
}
function _dotOverrideKey(p) { return p && p.pid ? String(p.pid) : ""; }
async function saveDotOverride(p, dot) {
  const key = _dotOverrideKey(p);
  if (!key) return;
  if (dot === null || dot === "") delete dotOverrides[key];
  else dotOverrides[key] = dot;
  await new Promise(res => chrome.storage.local.set({ dot_overrides: dotOverrides }, res));

  // DOT가 바뀌면 tireCache에 캐시된 예전 DOT 정보가 영구히 stale해져서
  // matchMy가 실제 사이트의 새 DOT과 안 맞는 옛 DOT로 계속 (잘못) 매칭 시도하게 됨 → "미판매"로 오표시되는 원인
  // _buyVerified를 지워서 다음 검색 때 이 상품을 강제로 다시 확인하도록 함
  if (p.pid) {
    try {
      const tireCache = await loadTireCache();
      if (tireCache[p.pid]) {
        delete tireCache[p.pid]; // 아예 지워서 완전히 새로 조회하게 함
        await saveTireCache(tireCache);
      }
    } catch(e) { console.warn("[saveDotOverride] tireCache 무효화 실패:", e.message); }
  }
}

async function loadMarginSettings() {
  const r = await new Promise(res => chrome.storage.local.get(
    ["cost_rate_pct", "fee_rate_pct", "shipping_cost_default", "cost_rate_overrides", "shipping_cost_overrides", "dot_overrides"], res));
  if (typeof r.cost_rate_pct === "number") costRatePct = r.cost_rate_pct;
  if (typeof r.fee_rate_pct  === "number") feeRatePct  = r.fee_rate_pct;
  if (typeof r.shipping_cost_default === "number") shippingCostDefault = r.shipping_cost_default;
  costRateOverrides     = r.cost_rate_overrides || {};
  shippingCostOverrides = r.shipping_cost_overrides || {};
  dotOverrides          = r.dot_overrides || {};
}
async function saveGlobalMarginSettings(newCostRate, newFeeRate, newShippingDefault) {
  costRatePct = newCostRate;
  feeRatePct  = newFeeRate;
  if (newShippingDefault !== undefined) shippingCostDefault = newShippingDefault;
  await new Promise(res => chrome.storage.local.set(
    { cost_rate_pct: newCostRate, fee_rate_pct: newFeeRate, shipping_cost_default: shippingCostDefault }, res));
  _rowCache.clear(); // 원가/마진이 캐시된 행 HTML을 전부 무효화 (즉시 재계산 반영)
}
async function saveCostRateOverride(p, rate) {
  const key = _costKey(p);
  if (rate === null || rate === "" || rate === undefined) delete costRateOverrides[key];
  else costRateOverrides[key] = rate;
  await new Promise(res => chrome.storage.local.set({ cost_rate_overrides: costRateOverrides }, res));
}
async function saveShippingCostOverride(p, cost) {
  const key = _costKey(p);
  if (cost === null || cost === "" || cost === undefined) delete shippingCostOverrides[key];
  else shippingCostOverrides[key] = cost;
  await new Promise(res => chrome.storage.local.set({ shipping_cost_overrides: shippingCostOverrides }, res));
}

function calcDc(factory, price) {
  if (!factory || !price) return 0;
  return Math.round((factory - price) / factory * 1000) / 10;
}
function comma(n) {
  if (n === null || n === undefined || n === "") return "-";
  const num = Number(n);
  if (!isFinite(num)) return "-";
  const s = "" + Math.abs(Math.floor(num));
  let r = "", len = s.length;
  for (let i = 0; i < len; i++) {
    if (i && (len - i) % 3 === 0) r += ",";
    r += s[i];
  }
  return (num < 0 ? "-" : "") + r;
}
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ── DOM 헬퍼
const $  = id => document.getElementById(id);
const st = msg => { $("status-bar").textContent = msg; };
const loading = (show, msg = "처리 중...") => {
  $("loading").classList.toggle("show", show);
  $("loading-msg").textContent = msg;
};

// ── Fetch (background 경유)
// SW 30초 자동종료 대응: sendMessage 실패 시 SW를 깨워서 최대 3회 자동 재시도
function _bgFetchOnce(url, options) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error("SW_TIMEOUT"));
    }, 8000); // 1회 타임아웃 8초 (총 3회 = 최대 24초)
    chrome.runtime.sendMessage({ type: "FETCH", url, options }, res => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (chrome.runtime.lastError) return reject(new Error("SW_DEAD:" + chrome.runtime.lastError.message));
      if (!res) return reject(new Error("SW_DEAD:응답 없음"));
      resolve(res);
    });
  });
}

async function bgFetch(url, options = {}) {
  const MAX_RETRY = 3;
  let lastErr;
  for (let attempt = 0; attempt < MAX_RETRY; attempt++) {
    try {
      return await _bgFetchOnce(url, options);
    } catch (e) {
      lastErr = e;
      const msg = e.message || "";
      // SW 종료 계열 오류만 재시도 (네트워크 오류 등은 즉시 실패)
      if (!msg.startsWith("SW_TIMEOUT") && !msg.startsWith("SW_DEAD")) throw e;
      if (attempt < MAX_RETRY - 1) {
        // SW 깨우기: chrome.runtime.connect 로 keep-alive ping
        try {
          const port = chrome.runtime.connect({ name: "keepalive" });
          port.disconnect();
        } catch (_) {}
        // 잠깐 대기 후 재시도
        await new Promise(r => setTimeout(r, 500 + attempt * 500));
      }
    }
  }
  throw new Error("bgFetch 실패 (SW 재시작 3회 시도) — " + (lastErr?.message || ""));
}

// HTML 파서 — DOMParser 싱글톤 재사용 (매번 new는 불필요한 객체 생성)
const _dp = new DOMParser();
function parseHTML(text) {
  return _dp.parseFromString(text, "text/html");
}

// ── 로그인 체크
async function checkLogin() {
  try {
    const r = await bgFetch(`${BASE}/sell/index`);
    const doc = parseHTML(r.text);
    const el = doc.querySelector(".h-info p, .h-info div p, .h-info span, #h-info p");
    if (el) {
      const newId = el.textContent.trim();
      // 계정 바뀌었으면 캐시/상태 전체 초기화
      if (myStoreId && myStoreId !== newId) {
        await chrome.storage.local.remove("tireping_cache");
        _memCache = null; // 인메모리 캐시도 무효화
        // stats 버퍼: 계정 전환 시 초기화
        allProducts = [];
        shownProducts = [];
        filterState = {};
        checkedSet.clear();
        window._lowestCache = new Map();
        _rowCache.clear();
        tireIdxMap = {};
        _lastFilterKey = "";
        _lastHeaderKey = "";
        $("tbody").innerHTML = "";
        $("thead").innerHTML = "";
        $("thead")._evBound = false;
        st("⚠️ 계정 변경 감지 - 캐시 초기화됨");
      }
      myStoreId = newId;
      $("login-status").textContent = myStoreId;
      // 계정 확정 시 해당 계정 즐겨찾기 로드 (계정별 키)
      if (_favAcct !== myStoreId) {
        _favAcct = myStoreId;
        await loadFavorites();
        updateFavCount();
        refreshFavViewIfActive();
      }
      return true;
    }
    $("login-status").textContent = "로그인 필요";
    return false;
  } catch(e) {
    $("login-status").textContent = "오류";
    return false;
  }
}

// ── 제조사 목록 (24시간 캐시)
async function loadCompanies() {
  const CACHE_KEY = "companies_cache";
  const TTL = 24 * 60 * 60 * 1000; // 24시간
  let cached = null;
  try {
    const r = await new Promise(resolve => chrome.storage.local.get(CACHE_KEY, resolve));
    if (r[CACHE_KEY] && (Date.now() - r[CACHE_KEY]._ts) < TTL) {
      cached = r[CACHE_KEY].map;
    }
  } catch (_) {}

  if (cached) {
    companyMap = cached;
  } else {
    const r = await bgFetch(`${BASE}/buy/insert`);
    const doc = parseHTML(r.text);
    const sel = doc.querySelector("select[name='company']");
    companyMap = {};
    if (sel) {
      for (const opt of sel.querySelectorAll("option")) {
        const v = opt.value.trim();
        const n = opt.textContent.trim();
        if (n) companyMap[n] = v;
      }
    }
    // 캐시 저장
    chrome.storage.local.set({ [CACHE_KEY]: { map: companyMap, _ts: Date.now() } });
  }

  const mfrSel = $("sel-mfr");
  mfrSel.innerHTML = '<option value="">제조사</option>';
  Object.keys(companyMap).sort().forEach(n => {
    const o = document.createElement("option");
    o.value = companyMap[n]; o.textContent = n;
    mfrSel.appendChild(o);
  });
  // inp-mfr 자동완성 초기화
  initMfrAutocomplete();
}

// ── 제조사 텍스트 자동완성
function initMfrAutocomplete() {
  // inp-size: 숫자시작=사이즈, 한글/영문시작=제조사 자동완성
  // sel-mfr/sel-prod 는 자동완성 선택 시에만 변경 — 사이즈 타이핑 시 절대 건드리지 않음
  const inp = $("inp-size");
  if (!inp) return;

  let suggest = document.getElementById("mfr-suggest");
  if (!suggest) {
    suggest = document.createElement("div");
    suggest.id = "mfr-suggest";
    document.body.appendChild(suggest);
  }

  let activeIdx = -1;

  function isMfrQuery(q) {
    return q.length > 0 && !/^\d/.test(q);
  }

  function showSuggest(list) {
    if (!list.length) { hideSuggest(); return; }
    const rect = inp.getBoundingClientRect();
    suggest.style.left   = rect.left + "px";
    suggest.style.top    = (rect.bottom + 1) + "px";
    suggest.style.width  = Math.max(rect.width, 180) + "px";
    suggest.style.display = "block";
    activeIdx = -1;
    suggest.innerHTML = list.map((n, i) =>
      `<div class="mfr-item" data-name="${n}" data-idx="${i}">${n}</div>`
    ).join("");
  }

  function hideSuggest() {
    suggest.style.display = "none";
    activeIdx = -1;
  }

  function applyMfr(name) {
    inp.value = name;
    const id = companyMap[name] || "";
    $("sel-mfr").value = id;
    loadPatterns(id);
    hideSuggest();
  }

  inp.addEventListener("input", () => {
    const q = inp.value.trim();
    // 어떤 경우에도 sel-mfr/sel-prod는 건드리지 않음
    // 자동완성 표시 여부만 제어
    if (!isMfrQuery(q)) {
      hideSuggest();
      return;
    }
    const ql = q.toLowerCase();
    const matched = Object.keys(companyMap).sort()
      .filter(n => n.toLowerCase().includes(ql));
    showSuggest(matched);
  });

  inp.addEventListener("keydown", e => {
    const items = suggest.querySelectorAll(".mfr-item");
    if (suggest.style.display !== "none" && items.length) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        activeIdx = Math.min(activeIdx + 1, items.length - 1);
        items.forEach((el, i) => el.classList.toggle("active", i === activeIdx));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        activeIdx = Math.max(activeIdx - 1, 0);
        items.forEach((el, i) => el.classList.toggle("active", i === activeIdx));
        return;
      }
      if (e.key === "Enter") {
        if (activeIdx >= 0 && items[activeIdx]) {
          e.preventDefault(); e.stopPropagation();
          applyMfr(items[activeIdx].dataset.name);
          return;
        }
        if (items.length > 0) {
          e.preventDefault(); e.stopPropagation();
          applyMfr(items[0].dataset.name);
          doSearch(true);
          return;
        }
      }
      if (e.key === "Escape") { hideSuggest(); return; }
    }
  });

  suggest.addEventListener("mousedown", e => {
    const item = e.target.closest(".mfr-item");
    if (item) { e.preventDefault(); applyMfr(item.dataset.name); }
  });

  inp.addEventListener("blur", () => setTimeout(hideSuggest, 150));
}

async function loadPatterns(companyId) {
  patternMap = {};
  const prodSel = $("sel-prod");
  prodSel.innerHTML = '<option value="">제품명</option>';
  if (!companyId) return;
  try {
    const r = await bgFetch(`${BASE}/ajax/tire/pattern/${companyId}`);
    const data = JSON.parse(r.text);
    for (const p of data) {
      if (p.name && p.id) {
        patternMap[p.name.trim()] = String(p.id);
        const o = document.createElement("option");
        o.value = p.id; o.textContent = p.name;
        prodSel.appendChild(o);
      }
    }
  } catch(e) {}
}

// ── 캐시 (chrome.storage.local)
// 인메모리 캐시 레이어 — chrome.storage 비동기 읽기 횟수 최소화
let _memCache = null;
async function loadCache() {
  if (_memCache !== null) return _memCache;
  return new Promise(resolve => {
    chrome.storage.local.get("tireping_cache", r => {
      _memCache = r.tireping_cache || {};
      resolve(_memCache);
    });
  });
}

let _saveCacheTimer = null; // saveCache 디바운스 타이머
function saveCache(cache) {
  // _memCache는 즉시 동기화 — 다음 loadCache에서 storage 읽기 불필요
  // ※ __gc_ts는 tireping_cache 내부가 아닌 별도 storage 키(_cache_gc_ts)로 관리
  //   (cache 객체에 넣으면 GC TTL 체크에서 _ts 없는 항목으로 삭제됨)
  _memCache = cache;
  // 실제 storage write는 1.5초 디바운스 (연속 호출 시 마지막 1회만)
  if (_saveCacheTimer) clearTimeout(_saveCacheTimer);
  _saveCacheTimer = setTimeout(() => {
    _saveCacheTimer = null;
    chrome.storage.local.set({ tireping_cache: cache }, () => {
      if (chrome.runtime.lastError)
        console.warn("[캐시] 저장 실패:", chrome.runtime.lastError.message);
    });
  }, 1500);
  return Promise.resolve(); // 호출부 await 즉시 통과
}

async function updateCache(products) {
  const cache = await loadCache();
  let added = 0;
  const now = Date.now();
  for (const p of products) {
    if (p.tire_id) {
      const key = `${p.tire_id}_${p.dot || ""}`;
      const prev = cache[key];
      const isNew = !prev;
      // 공장도가·시장최저가 변동 감지 → _rowCache 무효화 (화면 즉시 갱신)
      if (prev && (prev.factory_price !== p.factory_price || prev.market_lowest !== p.market_lowest)) {
        if (p._cacheKey) { _rowCache.delete(p._cacheKey); p._cacheKey = ""; }
        else if (p.tire_id) {
          for (const k of _rowCache.keys()) {
            if (k.startsWith(p.tire_id + "|")) { _rowCache.delete(k); break; }
          }
        }
      }
      // 신규/기존 모두 최신 데이터로 갱신 (공장도가·시장최저가 변동 반영)
      cache[key] = {
        tire_id: p.tire_id, manufacturer: p.manufacturer,
        product: p.product, size: p.size, detail: p.detail,
        dot: p.dot, factory_price: p.factory_price,
        market_lowest: p.market_lowest, market_stock: p.market_stock || 0,
        _ts: now,
      };
      if (isNew) added++;
    }
  }
  // TTL 순회는 maybeCacheGC에서 6시간마다 처리

  // 3000개 초과 시 오래된 것부터 추가 제거 (storage 용량 관리)
  const entries = Object.entries(cache);
  if (entries.length > 3000) {
    entries.sort((a, b) => (a[1]._ts || 0) - (b[1]._ts || 0));
    const trimmed = Object.fromEntries(entries.slice(entries.length - 3000));
    await saveCache(trimmed);
    return added;
  }
  await saveCache(cache);
  return added;
}

function fromCache(cache, { search = "", mfr = "", prod = "", dot = "", prodFallback = "" } = {}) {
  // 조건값을 루프 밖에서 정규화 — 매 항목마다 toLowerCase/replace 재실행 방지
  const s      = search.replace(_RE_SIZE_NORM, "");
  const sLow   = s.toLowerCase();
  const mfrL   = mfr          ? mfr.toLowerCase()          : "";
  const prodL  = (prod && prod !== "0") ? prod.toLowerCase() : "";
  const pfL    = prodFallback  ? prodFallback.toLowerCase() : "";
  const nowMs  = Date.now();
  const TTL_CACHE_TRIM   = 172800000; // 2일 ms (하루 1시간 사용 환경)
  const vals   = Object.values(cache);
  const result = [];
  for (let ci = 0; ci < vals.length; ci++) {
    const c = vals[ci];
    if (c._ts && (nowMs - c._ts) > TTL_CACHE_TRIM) continue;
    if (!c.size || !c.product) continue; // 불완전한 캐시 항목 스킵
    if (s) {
      if (!c.size.replace(_RE_SIZE_NORM, "").includes(s) &&
          !c.product.toLowerCase().replace(_RE_SPACE, "").includes(sLow)) continue;
    }
    if (mfrL) {
      const cm = c.manufacturer?.toLowerCase() || "";
      if (!cm.includes(mfrL) && !mfrL.includes(cm)) continue;
    }
    if (prodL && !c.product.toLowerCase().includes(prodL))       continue;
    if (pfL   && !c.product.toLowerCase().includes(pfL))         continue;
    if (dot && dot !== "DOT" && c.dot !== dot)                   continue;
    result.push({
      tire_id: c.tire_id, manufacturer: c.manufacturer,
      product: c.product, size: c.size, detail: c.detail || "",
      dot: c.dot, factory_price: c.factory_price,
      market_lowest: c.market_lowest || 0, market_stock: c.market_stock || 0,
      pid: null, my_price: 0, my_stock: 0, dc_rate: 0,
      is_mine: false, lowest_price: 0, second_price: 0,
    });
  }
  return result;
}

// ── /buy/insert 파싱
// buy/insert 단일 페이지 파싱 (공통)
function _parseBuyInsertPage(r) {
  const doc = parseHTML(r.text);
  if (doc.querySelector("form[action*='login'], input[name='login_id'], #login-form")) {
    throw new Error("세션 만료 — 타이어핑 로그인이 필요합니다. 페이지를 새로고침하세요.");
  }
  const rows = doc.querySelectorAll("table.table-list tbody tr");
  const products = [];
  for (const row of rows) {
    const onclick = row.getAttribute("onclick") || "";
    const m = onclick.match(/\/buy\/insert\/view\/(\d+)\?dot=([^']+)/);
    if (!m) continue;
    const tire_id = m[1], tire_dot_raw = m[2];
    const tds = row.querySelectorAll("td");
    if (tds.length < 3) continue;
    const manufacturer = tds[0]?.textContent.trim() || "";
    let product = "", size = "", detail = "";
    for (let ti = 1; ti < tds.length; ti++) {
      const td = tds[ti];
      if (!product) { const tn = td.querySelector(".t-name"); if (tn) { product = tn.textContent.trim(); continue; } }
      const cl = td.classList;
      if (!size && cl.contains("text-center") && !cl.contains("hide-mobile")) { const t = td.textContent.trim(); if (t) { size = t.replace(_RE_SPACES, " "); continue; } }
      if (!detail && cl.contains("text-left") && cl.contains("hide-mobile")) { detail = td.textContent.trim().replace(_RE_SPACES, " "); }
      if (product && size && detail) break;
    }
    let row_dot = _normDot(tire_dot_raw);
    if (!row_dot && tds[5]) row_dot = _normDot(tds[5].textContent.trim());
    let fp_val = 0;
    for (const td of row.querySelectorAll("td.hide-mobile")) {
      const sp = td.querySelector("span.eng");
      if (sp) { const v = toInt(sp.textContent); if (v > 1000) { fp_val = v; break; } }
    }
    const low_el = row.querySelector("td.text-green b.price, td.text-green b.eng");
    const stk_el = row.querySelector("td.text-purple b.eng");
    products.push({
      tire_id, manufacturer, product, size,
      detail: detail || '', dot: row_dot,
      factory_price: fp_val,
      market_lowest: low_el ? toInt(low_el.textContent) : 0,
      market_stock:  stk_el ? toInt(stk_el.textContent) : 0,
      pid: null, my_price: 0, my_stock: 0, dc_rate: 0,
      is_mine: false, lowest_price: 0, second_price: 0,
    });
  }
  // 총 페이지 수: href="?page=N" 중 최댓값 추출
  const pageNums = [...r.text.matchAll(/[?&]page=(\d+)/g)].map(m => parseInt(m[1], 10));
  const maxPage = pageNums.length ? Math.max(...pageNums) : 1;
  return { products, maxPage };
}

async function fetchBuyInsert({ search = "", company = "", pattern = "",
  width = "단면폭", height = "편평비", inch = "인치",
  dot = "DOT", order = "" } = {}, statusCb) {

  // 한글 기본값("단면폭","편평비","인치","DOT")은 서버에 빈값으로 전송
  const _pVal = v => (v && /^[0-9]/.test(v)) ? v : "";
  const _dotVal = v => (v && v !== "DOT") ? v : "";

  const _makeParams = (page) => new URLSearchParams({
    search, company, pattern, code: "",
    width:  _pVal(width),
    height: _pVal(height),
    inch:   _pVal(inch),
    dot:    _dotVal(dot),
    order, page,
  });

  // ── 1페이지 먼저 → 총 페이지 수 파악
  if (statusCb) statusCb(`⏳ 구매목록 수집 중...`);
  const r1 = await bgFetch(`${BASE}/buy/insert?${_makeParams(1)}`);
  const { products: p1, maxPage } = _parseBuyInsertPage(r1);
  const all = [...p1];

  // ── buy/insert 페이징: sell/price와 동일하게 10페이지 단위로만 최대 페이지 노출
  // maxPage가 실제보다 작을 수 있으므로 rows=0 나올 때까지 추가 수집
  if (maxPage > 1) {
    if (statusCb) statusCb(`⏳ 구매목록 수집 중... (${maxPage}페이지~)`);
    const BATCH = 10;
    let page = 2;
    // 1차: maxPage까지 병렬 수집
    const pageNums = Array.from({ length: maxPage - 1 }, (_, i) => i + 2);
    const results = await Promise.all(
      pageNums.map(pg => bgFetch(`${BASE}/buy/insert?${_makeParams(pg)}`).then(_parseBuyInsertPage))
    );
    for (const { products } of results) all.push(...products);
    page = maxPage + 1;

    // 2차: maxPage 이후 추가 페이지 존재 여부 확인 (10페이지씩 병렬)
    const MAX_PAGE = 500;
    while (page <= MAX_PAGE) {
      const batchPages = Array.from({ length: BATCH }, (_, i) => page + i);
      if (statusCb) statusCb(`⏳ 구매목록 수집 중... (${page}p~, 누적 ${all.length}개)`);
      const batchResults = await Promise.all(
        batchPages.map(pg =>
          bgFetch(`${BASE}/buy/insert?${_makeParams(pg)}`).then(_parseBuyInsertPage).catch(() => ({ products: [], maxPage: 1 }))
        )
      );
      let done = false;
      for (const { products } of batchResults) {
        if (!products.length) { done = true; break; }
        all.push(...products);
        if (products.length < 20) { done = true; break; }
      }
      if (done) break;
      page += BATCH;
    }
  }

  return all;
}




// ── 내 판매상품 수집
// search: 사이즈 공백제거(2454518), company: 제조사ID, pattern: 품명ID, dot: DOT년도
// ── fetchMyProducts 파싱 헬퍼
// 속성 순서 무관하게 class명으로 input value 추출

function _mpInputVal(trHtml, cls) {
  const rx = /<input([^>]+)>/gi;
  let m;
  while ((m = rx.exec(trHtml)) !== null) {
    if (m[1].includes(cls)) {
      const vm = m[1].match(/value="([^"]*)"/);
      return vm ? vm[1] : "";
    }
  }
  return "";
}
// td class로 텍스트 추출
function _mpTdText(trHtml, cls) {
  const idx = trHtml.indexOf('class="' + cls);
  if (idx === -1) return "";
  const closeIdx = trHtml.indexOf(">", idx) + 1;
  const tdEnd    = trHtml.indexOf("</td>", closeIdx);
  if (tdEnd === -1) return "";
  return trHtml.slice(closeIdx, tdEnd).replace(/<[^>]+>/g, "").trim();
}
// name 속성으로 input value 추출
function _mpInputByName(html, name) {
  const rx = /<input([^>]+)>/gi;
  let m;
  while ((m = rx.exec(html)) !== null) {
    const a = m[1];
    if (a.includes('name="' + name + '"') || a.includes("name='" + name + "'")) {
      const vm = a.match(/value="([^"]*)"/);
      return vm ? vm[1] : null;
    }
  }
  return null;
}

// sell/price 단일 페이지 파싱
function _parseSellPricePage(html, _dbg) {
  if (html.includes('name="login_id"') || html.includes('action="/login"') || html.includes('id="login-form"')) {
    throw new Error("세션 만료 — 타이어핑 로그인이 필요합니다.");
  }
  const _tbM = html.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/i);
  if (!_tbM) {
    if (_dbg) _dbg("⚠️ tbody 없음 — empty 처리");
    return { rows: [], maxPage: 1, empty: true };
  }
  const _tbody = _tbM[1];
  if (_tbody.includes("등록된 상품이 없습니다")) {
    if (_dbg) _dbg("⚠️ '등록된 상품이 없습니다' 감지 — empty 처리");
    return { rows: [], maxPage: 1, empty: true };
  }
  const rows = [];
  let _ts = 0;
  while (true) {
    const _s = _tbody.indexOf("<tr", _ts);
    if (_s === -1) break;
    const _e = _tbody.indexOf("</tr>", _s);
    if (_e === -1) break;
    const trHtml = _tbody.slice(_s, _e + 5);
    _ts = _e + 5;
    const pidM = trHtml.match(/data-id="(\d+)"/);
    if (!pidM) continue;
    const dispatchM = trHtml.match(/(\d{1,2})시\s*(\d{1,2})분까지\s*입금완료시\s*(당일|익일)출고/);
    rows.push({
      pid: pidM[1],
      factory_price: toInt(_mpTdText(trHtml, "mfactoryprice") || _mpInputVal(trHtml, "mfactoryprice") || "0"),
      dc_rate:   toFloat(_mpInputVal(trHtml, "msdc")),
      my_price:  toInt(_mpInputVal(trHtml, "msprice")),
      my_stock:  toInt(_mpInputVal(trHtml, "mcount")),
      is_soldout: trHtml.includes("soldout_ico"),
      send_kind: dispatchM ? (dispatchM[3] === "익일" ? 1 : 0) : undefined,
      send_time: dispatchM ? `${dispatchM[1]}:${dispatchM[2].padStart(2,"0")}` : "",
    });
  }
  const pageNums = [...html.matchAll(/[?&]page=(\d+)/g)].map(m => parseInt(m[1], 10));
  const maxPage = pageNums.length ? Math.max(...pageNums) : 1;

  // 디버그: 페이징 영역 HTML 캡처
  if (_dbg) {
    const pagingM = html.match(/class=["']page-paging["'][^>]*>([\s\S]{0,400})/i);
    const pagingSnippet = pagingM ? pagingM[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200) : "(페이징 없음)";
    _dbg(`rows=${rows.length} | maxPage=${maxPage} | pageNums=[${pageNums.slice(0,10).join(",")}] | paging텍스트: "${pagingSnippet}"`);
  }

  return { rows, maxPage, empty: false };
}

// 현재 검색창의 사이즈 → 내 판매상품(/sell/price) 조회용 width/height/inch
// 단면폭·편평비·인치가 "모두" 확보될 때만 좁히고, 아니면 "0"(전체)로 둠.
// (제조사만/패턴코드/전체 검색처럼 사이즈가 불완전하면 내 상품이 누락돼
//  '미판매'로 오판될 수 있으므로, 그런 경우엔 기존처럼 전체를 조회한다 — 안전장치)
function _getSellSizeParams() {
  const wRaw = $("sel-width")?.value  || "";
  const hRaw = $("sel-height")?.value || "";
  const iRaw = $("sel-inch")?.value   || "";
  let w = /^\d+$/.test(wRaw) ? wRaw : "";
  let h = /^\d+$/.test(hRaw) ? hRaw : "";
  let i = /^\d+$/.test(iRaw) ? iRaw : "";
  // 드롭다운이 비어 있으면 텍스트 입력("245 45 18", "245/45/18")에서 추출
  if (!(w && h && i)) {
    const sizeText = $("inp-size")?.value.trim() || "";
    const nums = sizeText.match(/\d+/g) || [];
    if (nums.length === 3 &&
        /^\d{3}$/.test(nums[0]) && /^\d{2}$/.test(nums[1]) && /^\d{2}$/.test(nums[2])) {
      [w, h, i] = nums;
    }
  }
  const has = !!(w && h && i);
  return { width: has ? w : "0", height: has ? h : "0", inch: has ? i : "0", has };
}


async function fetchMyProducts(statusCb, { search="", company="0", pattern="0", dot="0", width="0", height="0", inch="0" } = {}) {
  const _makeUrl = (page) =>
    `${BASE}/sell/price?page=${page}&company=${company}&pattern=${pattern}&width=${width}&height=${height}&inch=${inch}&dot=${dot}&code=&search=${search}&order=&status=0`;

  // ── 디버그 로그 헬퍼 (콘솔 + st 상태바) ─────────────────────
  const _dbg = (msg) => {
    console.log(`[fetchMyProducts dot=${dot} company=${company}] ${msg}`);
    if (statusCb) statusCb(`🔍 ${msg}`);
  };

  // ── 타이어핑 페이징 구조 설명 ────────────────────────────────
  // page=N 요청 시 HTML 안에 page=N 이 10번 반복될 뿐 (현재 페이지 번호만 포함)
  // 실제 마지막 페이지 번호는 10페이지 단위로만 노출됨 (page=1→maxPage=11, page=11→maxPage=21 ...)
  // → maxPage 기반 병렬 수집 불가. rows=0이 나올 때까지 순차 수집해야 함.
  // ── 전략: 10페이지씩 병렬 묶음으로 수집하면서, 매칭(tire_id 조회)을 파이프라인으로 동시 실행 ─

  _dbg(`▶ 시작 — URL: ${_makeUrl(1)}`);
  const allRows = [];
  let page = 1;
  const BATCH = 10;      // 페이지 수집 병렬 묶음 크기 (타이어핑 10페이지 단위와 맞춤)
  let MATCH_BATCH = 70; // tire_id 매칭 병렬 묶음 크기 (워커 풀 — 검색 속도 개선차 40→70, 실패율 높으면 자동 축소)
  const MAX_PAGE = 500;  // 절대 상한 (무한루프 방지)

  // ── 캐시 미리 로드 (매칭과 수집 동시 진행을 위해 앞에서 로드) ─
  const tireCache = await loadTireCache();
  let cacheModified = false;

  // ── 매칭 큐: 수집된 newRows를 비동기로 소비 ──────────────────
  const matchQueue = [];
  let matchDone = 0;
  let matchTotal = 0;
  let _collectDone = false; // 수집 완료 신호

  const _needsMatch = (r) => {
    const c = tireCache[r.pid];
    if (!c) return true;
    if (typeof c === "string") return true;   // 구버전 문자열 캐시 → 재매칭
    if (!c.tire_id) return true;              // tire_id 없으면 재매칭
    if (!c._buyVerified) return true;         // 검증 안 된 항목만 재매칭
    // 검증됐으면 product(제품명)가 비어 있어도 재매칭 안 함
    // (이전 버전은 이름 추출 실패 상품을 매 검색마다 재매칭 → 캐시 무력화 + 속도 저하)
    return false;
  };

  // 부스터: 성공률이 좋으면 동시성을 슬금슬금 올리고, 실패율이 튀면 절반으로 낮췄다가 다시 올림
  // (최근 20건 기준 실패율 30% 넘으면 절반 축소 / 연속 15건 성공하면 +15 증가, 상한 300)
  const _matchRecentFails = [];
  let _matchActiveWorkers = 0;
  let _matchSuccessStreak = 0;
  let _matchNextWorkerId = 0;
  const _matchWorkerPromises = [];

  // 매칭 워커: 워커 풀 방식 — 하나 끝나면 즉시 다음 항목 처리 (배치 대기 없음)
  const _doMatchOne = async (item) => {
    let matched = false;
    try {
      const r    = await bgFetch(`${BASE}/sell/price/update/${item.pid}`);
      const html = r.text;
      const tireM   = { 1: _mpInputByName(html, "tire") };
      const dotM    = { 1: _mpInputByName(html, "dot") };
      const buyTireM  = html.match(/\/buy\/insert\/view\/(\d+)/);
      const buyTireId = buyTireM ? buyTireM[1] : null;
      const resolvedTireId = buyTireId || tireM?.[1]?.trim();
      if (resolvedTireId) {
        matched = true;
        let dot = _normDot(dotM?.[1] || "");
        let productName = _mpInputByName(html, "product") || _mpInputByName(html, "tire_product") || "";
        if (!productName) {
          // 실제 수정페이지는 제품명이 입력폼이 아니라 "<label>제품명</label><div>실제값</div>" 형태의 읽기전용 텍스트임
          const labelM = html.match(/제품명\s*<\/label>\s*<div[^>]*>([^<]+)<\/div>/i);
          if (labelM) productName = labelM[1].trim();
        }
        if (!productName) {
          const h4M = html.match(/<h[34][^>]*>([^<]{2,60})<\/h[34]>/i);
          if (h4M) productName = h4M[1].trim();
        }
        if (!dot) {
          const selBlock = html.match(/name=['"]dot['"][^>]*>([\s\S]*?)<\/select>/i);
          if (selBlock) {
            const optRx = /<option([^>]*)>([^<]*)<\/option>/gi;
            let om;
            while ((om = optRx.exec(selBlock[1])) !== null) {
              if (/\bselected\b/i.test(om[1])) {
                const vm = om[1].match(/value=['"]([^'"]*)['"]/i);
                if (vm) { dot = _normDot(vm[1]); break; }
              }
            }
          }
        }
        tireCache[item.pid] = {
          tire_id: resolvedTireId, dot, _ts: Date.now(),
          product: productName.trim(),
          _buyVerified: true,
        };
        cacheModified = true;
      }
    } catch(e) {}
    _matchRecentFails.push(!matched);
    if (_matchRecentFails.length > 20) _matchRecentFails.shift();
    if (!matched) {
      _matchSuccessStreak = 0;
      if (_matchRecentFails.length === 20) {
        const failRate = _matchRecentFails.filter(Boolean).length / 20;
        if (failRate > 0.3 && MATCH_BATCH > 20) {
          MATCH_BATCH = Math.max(20, Math.floor(MATCH_BATCH / 2));
          console.warn(`[매칭-부스터] 실패율 ${Math.round(failRate*100)}% 감지 — 동시성 ${MATCH_BATCH}로 축소`);
        }
      }
    } else {
      _matchSuccessStreak++;
      if (_matchSuccessStreak >= 15 && MATCH_BATCH < 300) {
        MATCH_BATCH = Math.min(300, MATCH_BATCH + 15);
        _matchSuccessStreak = 0;
        console.log(`[매칭-부스터] 안정적 — 동시성 ${MATCH_BATCH}로 상승`);
        _matchSpawnUpTo(MATCH_BATCH);
      }
    }
    matchDone++;
    if (statusCb && matchDone % 5 === 0)
      statusCb(`⏳ 수집 ${allRows.length}개 | 매칭 ${matchDone}/${matchTotal}...`);
  };

  const matchWorker = async () => {
    const myId = _matchNextWorkerId++;
    _matchActiveWorkers++;
    while (true) {
      if (myId >= MATCH_BATCH) break; // 내 순번이 현재 허용치보다 크면 스스로 종료(동시성 축소 반영)
      if (matchQueue.length === 0) {
        if (_collectDone) break;
        await new Promise(r => setTimeout(r, 50));
        continue;
      }
      const item = matchQueue.shift();
      if (item) await _doMatchOne(item);
    }
    _matchActiveWorkers--;
  };
  function _matchSpawnUpTo(target) {
    while (_matchNextWorkerId < target) {
      _matchWorkerPromises.push(matchWorker());
    }
  }

  // MATCH_BATCH개 워커를 동시에 띄워 풀 방식으로 처리 (동시성이 늘어나면 위 _matchSpawnUpTo가 추가로 띄움)
  _matchSpawnUpTo(MATCH_BATCH);
  const matchWorkerPromise = (async () => {
    await Promise.all(_matchWorkerPromises);
    while (_matchActiveWorkers > 0) await new Promise(r => setTimeout(r, 50));
  })();

  // ── 페이지 수집 루프 ─────────────────────────────────────────
  while (page <= MAX_PAGE) {
    const batchPages = Array.from({ length: BATCH }, (_, i) => page + i);
    _dbg(`▶ ${batchPages[0]}~${batchPages[batchPages.length-1]}페이지 병렬 수집`);
    if (statusCb) statusCb(`⏳ 수집 중... (${page}p~, 누적 ${allRows.length}개 | 매칭 ${matchDone}/${matchTotal})`);

    const results = await Promise.all(
      batchPages.map(pg => bgFetch(_makeUrl(pg)).then(r => {
        const parsed = _parseSellPricePage(r.text, (m) => _dbg(`[page=${pg}] ${m}`));
        return { pg, ...parsed };
      }).catch(err => {
        _dbg(`❌ [page=${pg}] 요청 오류: ${err.message}`);
        return { pg, rows: [], empty: true, error: true };
      }))
    );

    let done = false;
    for (const { pg, rows, empty: isEmpty, error } of results) {
      if (error) { _dbg(`⚠️ page=${pg} 오류 — 건너뜀`); continue; }
      if (isEmpty || rows.length === 0) { _dbg(`page=${pg} 비어있음 → 수집 종료`); done = true; break; }
      allRows.push(...rows);
      // 캐시 없는 항목만 매칭 큐에 추가
      const toMatch = rows.filter(_needsMatch);
      matchQueue.push(...toMatch);
      matchTotal += toMatch.length;
      _dbg(`page=${pg} rows=${rows.length} 누적=${allRows.length} 매칭큐+${toMatch.length}`);
      if (rows.length < 20) { _dbg(`page=${pg} 마지막 페이지`); done = true; break; }
    }
    if (done) break;
    page += BATCH;
  }

  if (page > MAX_PAGE) _dbg(`⚠️ MAX_PAGE(${MAX_PAGE}) 도달로 강제 종료`);
  _dbg(`▶ 페이지 수집 완료 — 총 allRows=${allRows.length} 매칭큐 잔여=${matchQueue.length}`);

  // 수집 완료 신호 → 매칭 워커가 큐 소진 후 종료
  _collectDone = true;
  if (matchTotal > 0) {
    if (statusCb) statusCb(`⏳ 매칭 마무리 중... (${matchDone}/${matchTotal})`);
    await matchWorkerPromise;
    _dbg(`▶ 매칭 완료 — ${matchDone}/${matchTotal}`);
  }

  if (cacheModified) await saveTireCache(tireCache);
  _dbg(`▶ 전체 완료 — allRows=${allRows.length}`);
  if (!allRows.length) return {};

  const my = {};
  for (const item of allRows) {
    const cached = tireCache[item.pid];
    if (!cached) continue;
    const tid = typeof cached === "string" ? cached : cached.tire_id;
    const dot = _normDot(typeof cached === "string" ? "" : (cached.dot || ""));
    const key = dot ? `${tid}_${dot}` : tid;
    // DOT 있는 키가 이미 있으면 DOT 없는 항목으로 덮어쓰지 않음
    if (my[key] && !dot && my[key]._dot) continue;
    // 중복 키 처리: 재고 있는 것 우선, 둘 다 재고 있으면 재고수량 높은 것 우선
    // (품절 항목이 재고 있는 항목을 덮어쓰는 버그 방지)
    const existing = my[key];
    if (!existing) {
      my[key] = { ...item, _tid: tid, _dot: dot };
    } else {
      const existHasStock = existing.my_stock > 0 && !existing.is_soldout;
      const itemHasStock  = item.my_stock > 0 && !item.is_soldout;
      if (!existHasStock && itemHasStock) {
        // 기존이 품절, 새 항목이 재고 있음 → 무조건 교체
        my[key] = { ...item, _tid: tid, _dot: dot };
      } else if (existHasStock && itemHasStock && item.my_stock > existing.my_stock) {
        // 둘 다 재고 있음 → 재고 많은 것 우선
        my[key] = { ...item, _tid: tid, _dot: dot };
      }
      // 기존이 재고 있고 새 항목이 품절이면 유지
    }
  }
  return my;
}

async function loadTireCache() {
  return new Promise(r => chrome.storage.local.get("tire_cache", d => r(d.tire_cache || {})));
}
async function saveTireCache(c) {
  // tire_cache 5000개 초과 시 LRU trim — _ts 기준으로 오래된 것 제거 (최신 pid 보존)
  const entries = Object.entries(c);
  let trimmed = c;
  if (entries.length > 5000) {
    // _ts 없는 구버전 항목은 0으로 처리 → 가장 먼저 제거
    entries.sort((a, b) => ((a[1]._ts) || 0) - ((b[1]._ts) || 0));
    trimmed = Object.fromEntries(entries.slice(entries.length - 5000));
  }
  return new Promise(r => chrome.storage.local.set({ tire_cache: trimmed }, () => {
    if (chrome.runtime.lastError) {
      console.warn("[타이어캐시] 저장 실패 (용량 초과?):", chrome.runtime.lastError.message);
    }
    r();
  }));
}

// ── 내 상품 매칭
function matchMy(products, myMap, tireCache) {
  const myKeys = Object.keys(myMap);
  console.log(`[matchMy] 시작 — myMap 총 ${myKeys.length}개 키:`, myKeys);
  // pid → _dot 역인덱스: p.dot='' 일 때 pid로 올바른 DOT 찾기
  const _pidDotMap = {};
  if (tireCache) {
    for (const pid in tireCache) {
      const c = tireCache[pid];
      if (c && typeof c === "object" && c.tire_id) {
        _pidDotMap[pid] = _normDot(c.dot || "");
      }
    }
  }

  // tire_id별 myMap 키 사전 구성
  const tidIndex = {};
  for (const k of myKeys) {
    const tid = myMap[k]._tid || k.split("_")[0];
    if (!tidIndex[tid]) tidIndex[tid] = [];
    tidIndex[tid].push(k);
  }

  // 2차 매칭 인덱스: "product정규화_dot" → myMap 키
  // buy/insert pattern 미설정 시 tire_id가 달라지는 문제 보완
  // tireCache[pid].product = sell/price/update 페이지에서 파싱한 실제 제품명
  const _normStr = s => (s || "").toLowerCase().replace(/[^a-z0-9가-힣]/gi, "");
  const productIndex = {};
  if (tireCache) {
    for (const pid in tireCache) {
      const c = tireCache[pid];
      if (!c || typeof c !== "object" || !c.tire_id || !c.product) continue;
      const pNorm = _normStr(c.product);
      const dNorm = _normDot(c.dot || "");
      if (!pNorm) continue;
      const dotKey   = dNorm ? `${c.tire_id}_${dNorm}` : null;
      const plainKey = c.tire_id;
      const mapKey   = (dotKey && myMap[dotKey]) ? dotKey : (myMap[plainKey] ? plainKey : null);
      if (!mapKey) continue;
      const idx1 = `${pNorm}_${dNorm}`;
      const idx2 = `${pNorm}_`;  // dot 없는 폴백
      if (!productIndex[idx1]) productIndex[idx1] = mapKey;
      if (!productIndex[idx2]) productIndex[idx2] = mapKey;
    }
  }

  for (const p of products) {
    let pDot = _normDot(p.dot);
    let info = null;

    // 1순위: tire_id_dot 완전 일치
    if (pDot) info = myMap[`${p.tire_id}_${pDot}`];

    // 2순위: tire_id 단독 키
    // - pDot 있음: DOT 있는 키 없을 때만 허용 (dot='' 오류 데이터 오매칭 방지)
    // - pDot 없음: DOT 없는 키만 있을 때 허용
    if (!info) {
      const candidates = tidIndex[p.tire_id] || [];
      const dotKeys   = candidates.filter(k =>  myMap[k]._dot);
      const noDotKeys = candidates.filter(k => !myMap[k]._dot);
      if (pDot) {
        // DOT 있는 상품: 같은 tire_id에 DOT 키가 없을 때만 단독키 허용
        // (B3 수정: dot='' 저장 오류라도 DOT 있는 키 없으면 매칭 허용)
        if (dotKeys.length === 0 && noDotKeys.length > 0) info = myMap[noDotKeys[0]];
      } else {
        // DOT 없는 상품(p.dot=''): 단독 DOT없는 키 있으면 매칭
        if (noDotKeys.length > 0) info = myMap[noDotKeys[0]];
      }
    }

    // 3순위: pDot='' + DOT 있는 후보 없을 때 → 첫 번째 매칭
    // (B1 수정: 단독판매 상품이 같은 tire_id에 DOT 상품과 공존해도 매칭)
    if (!info && !pDot) {
      const candidates = tidIndex[p.tire_id] || [];
      const dotKeys    = candidates.filter(k => myMap[k]._dot);
      const noDotKeys  = candidates.filter(k => !myMap[k]._dot);
      if (noDotKeys.length > 0) {
        // DOT 없는 내 상품이 있으면 매칭
        info = myMap[noDotKeys[0]];
      } else if (dotKeys.length === 1) {
        // DOT 있는 후보가 정확히 1개 → 매칭
        info = myMap[dotKeys[0]];
      }
      // DOT 있는 후보 여러 개 + p.dot='' → 어떤 DOT인지 알 수 없으므로 미매칭
    }

    // 2차 매칭: tire_id 불일치 시 product+size+dot으로 재시도
    // (buy/insert pattern 미설정 시 tire_id가 달라지는 경우 보완)
    if (!info && productIndex) {
      const pNorm = _normStr(p.product);
      const dNorm = pDot || "";
      const mapKey = productIndex[`${pNorm}_${dNorm}`]
                  || productIndex[`${pNorm}_`];
      if (mapKey) {
        info = myMap[mapKey];
        if (info) console.log(`[matchMy 2차매칭] tire_id=${p.tire_id} → product="${p.product}" size="${p.size}" dot="${pDot}" 매칭 성공`);
      }
    }

    // 최종 안전장치: p.dot과 info._dot 모두 있고 다르면 거부
    if (info && pDot && info._dot && pDot !== info._dot) {
      console.warn("[matchMy 불일치] tire_id=" + p.tire_id
        + " p.dot=" + p.dot + " matched._dot=" + info._dot
        + " price=" + info.my_price + " → 거부");
      info = null;
    }

    if (info) {
      // 다른 DOT 가격이 매칭되면 경고 로그
      if (p.dot && info._dot && p.dot !== info._dot) {
        console.warn(`[matchMy DOT 불일치] tire_id=${p.tire_id} p.dot=${p.dot} → matched._dot=${info._dot} my_price=${info.my_price}`);
      }
      p.pid          = info.pid;
      p.my_price     = info.my_price;
      p.my_stock     = info.my_stock;
      p.dc_rate      = info.dc_rate;
      // factory_price: sell/price(info)가 0이면 buy/insert(p) 값 보존
      // sell/price 페이지에서 mfactoryprice 미노출 상품은 0으로 오므로 buy/insert값 우선
      p.factory_price= (info.factory_price && info.factory_price > 0)
        ? info.factory_price
        : (p.factory_price || 0);
      p.is_mine      = true;
      p.is_soldout   = info.is_soldout || false;
      p.send_kind    = info.send_kind;   // 0=당일출고, 1=익일출고, undefined=알 수 없음
      p.send_time    = info.send_time || "";
      if (!p.dot && info._dot) p.dot = info._dot;
    } else {
      // 매칭 실패 진단 로그 — myMap에 이 tire_id 자체가 없는지, 있는데 DOT이 안 맞아서인지 구분
      const candidates = tidIndex[p.tire_id] || [];
      if (candidates.length) {
        console.warn(`[matchMy 매칭실패] tire_id=${p.tire_id} p.dot="${p.dot}"(정규화:"${pDot}") — myMap 후보 ${candidates.length}개 있으나 매칭 안 됨: `
          + candidates.map(k => `[key=${k} _dot="${myMap[k]._dot}" price=${myMap[k].my_price}]`).join(", "));
      }
      // productIndex 쪽도 후보가 있었는지 참고로 표시 (제품명 정규화 매칭 실패 원인 파악용)
      const pNormDbg = _normStr(p.product);
      if (productIndex[`${pNormDbg}_${pDot}`] || productIndex[`${pNormDbg}_`]) {
        console.warn(`[matchMy 매칭실패] tire_id=${p.tire_id} product="${p.product}" — productIndex엔 후보가 있었는데 최종 매칭 실패 (버그 의심)`);
      }
    }
  }
}

// ── 경쟁사 최저가 조회
// 저장 후 호출: 해당 tire_id 캐시 삭제 후 즉시 재조회
function clearLowestCache(tire_id, dot) {
  if (!window._lowestCache) return;
  window._lowestCache.delete(`${tire_id}_${dot || ""}`);
  window._lowestCache.delete(`${tire_id}_`);
}

// _lowestCache: Map 기반 LRU (삽입순 = 접근순 유지, 300개 초과시 오래된 150개 제거)
function _trimLowestCache() {
  const c = window._lowestCache;
  if (!c || c.size <= 300) return;
  let del = 0;
  for (const k of c.keys()) {
    c.delete(k);
    if (++del >= 150) break;
  }
}

// ── 적응형 워커풀 (부스터) ─────────────────────────────────────
// 성공률이 좋으면 동시성을 계속 올리고, 실패율이 튀면 확 낮췄다가 다시 슬금슬금 올리는 방식
// (TCP 혼잡제어와 같은 원리: 서서히 증가, 실패 감지 시 절반으로 감소 후 재상승)
// processFn(item)은 실패 여부(true=실패)를 반환해야 함
async function runAdaptivePool(queue, processFn, cfg) {
  let concurrency = cfg.start;
  let active = 0;
  let nextWorkerId = 0;
  const fails = [];
  let streak = 0;

  function onResult(failed) {
    fails.push(failed);
    if (fails.length > cfg.window) fails.shift();
    if (failed) {
      streak = 0;
      if (fails.length === cfg.window) {
        const rate = fails.filter(Boolean).length / cfg.window;
        if (rate > cfg.failThreshold && concurrency > cfg.min) {
          concurrency = Math.max(cfg.min, Math.floor(concurrency / 2));
          cfg.onAdjust?.(concurrency, "down", rate);
        }
      }
    } else {
      streak++;
      if (streak >= cfg.growEvery && concurrency < cfg.max) {
        concurrency = Math.min(cfg.max, concurrency + cfg.growStep);
        streak = 0;
        cfg.onAdjust?.(concurrency, "up");
        // 늘어난 만큼 워커를 추가로 띄워서 실제로 그 동시성을 활용함
        spawnUpTo(concurrency);
      }
    }
  }

  const workerPromises = [];
  async function runWorker() {
    const myId = nextWorkerId++;
    active++;
    while (queue.length > 0) {
      if (myId >= concurrency) break; // 내 순번이 현재 허용치보다 크면 스스로 종료(동시성 축소 반영)
      const item = queue.shift();
      if (!item) break;
      const failed = await processFn(item);
      onResult(failed);
    }
    active--;
  }
  function spawnUpTo(target) {
    while (nextWorkerId < target && queue.length > 0) {
      workerPromises.push(runWorker());
    }
  }

  spawnUpTo(concurrency);
  // 초기 워커들이 끝나도(동시성 확대로 나중에 띄운 워커가 남아있을 수 있으므로) active===0 될 때까지 대기
  await Promise.all(workerPromises);
  while (active > 0) await new Promise(r => setTimeout(r, 50));
  return { finalConcurrency: concurrency };
}

async function fetchOneLowest(p) {
  if (!p?.tire_id) return [0, 0, 0, "", 0, 0];
  const _dotNorm = p.dot || "";
  const cacheKey = `${p.tire_id}_${_dotNorm}`;
  if (!window._lowestCache || !(window._lowestCache instanceof Map)) {
    window._lowestCache = new Map();
  }
  const _lc = window._lowestCache.get(cacheKey);
  if (_lc) { window._lowestCache.delete(cacheKey); window._lowestCache.set(cacheKey, _lc); return _lc; }

  try {
    const r    = await bgFetch(`${BASE}/buy/insert/view/${p.tire_id}?dot=${p.dot}`);
    const html = r.text;

    // ── DOMParser 대신 텍스트 파싱
    // DOM 트리 생성 없음 → GC 압력 제거 → 장기 실행 느려짐 핵심 해결
    // 세션 만료 감지
    if (html.includes('id="login-') || html.includes('action="/login"')||
        html.includes('name="login_id"')) {
      console.warn("[fetchOneLowest] 세션만료");
      return [0, 0, 0, "", 0, 0];
    }

    // <tr> 블록을 텍스트 레벨에서 분리
    const prices      = [];
    const allPrices   = [];
    const orderedRows = [];
    let lowestSeller  = "";
    let myRowFound    = false;

    // tbody 내 tr 추출 — 정규식으로 행 단위 분리
    const tbodyM = html.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/i);
    if (!tbodyM) {
      const result = [0, 0, 0, "", 0, 0];
      window._lowestCache.delete(cacheKey); window._lowestCache.set(cacheKey, result);
      return result;
    }
    const tbody = tbodyM[1];

    // tr 블록 분리
    const trBlocks = [];
    let trStart = 0;
    while (true) {
      const s = tbody.indexOf("<tr", trStart);
      if (s === -1) break;
      const e = tbody.indexOf("</tr>", s);
      if (e === -1) break;
      trBlocks.push(tbody.slice(s, e + 5));
      trStart = e + 5;
    }

    for (const trHtml of trBlocks) {
      // 내 행 판별: bg-green / text-green / 내 판매상품
      const isMineRaw = trHtml.includes("bg-green") ||
                        trHtml.includes("text-green") ||
                        trHtml.includes("\uB0B4 \uD310\uB9E4\uC0C1\uD488") ||
                        trHtml.includes("내 판매상품");
      let isMine = isMineRaw && !myRowFound;
      if (isMine) myRowFound = true;

      // 가격 추출
      let v = 0;
      if (isMine) {
        // 내 행: <input class="form-control text-center px-0 msprice" value="236200"> (복합 클래스도 정상 인식)
        const mVal = _mpInputVal(trHtml, "msprice");
        if (mVal) v = toInt(mVal);
      }
      if (v <= 1000) {
        // 경쟁사: <b class="eng">158,480</b>
        const bP = trHtml.match(/<b[^>]*class="eng"[^>]*>([0-9,]+)<\/b>/);
        if (bP) v = toInt(bP[1]);
      }
      if (v <= 1000) continue;

      allPrices.push(v);
      orderedRows.push({ v, isMine, todayShip: isMine ? true : !trHtml.includes("익일출고") });

      if (!isMine) {
        // 판매점 코드: T123456 형태 또는 첫 번째 td 텍스트
        const firstTd = trHtml.match(/<td[^>]*>([\s\S]*?)<\/td>/);
        const tdRaw   = firstTd ? firstTd[1].replace(/<[^>]+>/g, "").trim() : "";
        const tCode   = tdRaw.match(/T\d{3,6}/)?.[0] || "";
        const shopName= tdRaw.replace(/\s+/g, "").slice(0, 20);
        // 출고여부 컬럼: "익일출고"라고 명확히 써있을 때만 제외. 표시가 없거나 그 외의 경우는 오늘출고로 취급
        const todayShip = !trHtml.includes("익일출고");
        prices.push({ v, seller: (tCode || shopName || "").trim(), todayShip });
      }
    }

    // 내행 미감지 경고 (디버그)
    if (p.my_price > 0 && p.my_stock > 0 && !myRowFound) {
      const hasLogin = html.includes("h-info") || html.includes("user-info");
      console.warn("[봇 내행미감지]", p.product, p.size,
        `내가격=${p.my_price}`, `재고=${p.my_stock}`,
        hasLogin ? "세션OK" : "⚠️세션만료의심");
    }

    const mlow = allPrices.length ? Math.min(...allPrices) : 0;
    if (!prices.length) {
      const result = [0, 0, mlow, "", myRowFound ? 1 : 0, 0];
      window._lowestCache.delete(cacheKey); window._lowestCache.set(cacheKey, result);
      return result;
    }

    // 내가 당일출고(send_kind===0)면, 오늘출고 경쟁사만 대상으로 최저가/순위를 계산함
    // (익일출고 경쟁사는 어차피 나보다 늦게 보내므로 가격으로 경쟁할 필요가 없음)
    // 오늘출고 경쟁사가 하나도 없으면 안전하게 전체 경쟁사 기준으로 폴백함
    const wantTodayOnly = p.send_kind === 0;
    const rawOverallLow = prices.length ? Math.min(...prices.map(x => x.v)) : 0; // 익일출고 포함 전체 1등가 (아이콘 표시 여부 판단용)
    const todayPrices = wantTodayOnly ? prices.filter(x => x.todayShip) : [];
    const useTodayOnly = wantTodayOnly && todayPrices.length > 0;
    const activeList = useTodayOnly ? todayPrices : prices;
    const activeOrderedRows = useTodayOnly ? orderedRows.filter(e => e.isMine || e.todayShip) : orderedRows;

    const sorted   = activeList.sort((a, b) => a.v - b.v);
    const uniqVals = [...new Set(sorted.map(x => x.v))];
    const allUniq  = [...new Set(allPrices)].sort((a, b) => a - b);
    const sec2     = uniqVals[1] ?? uniqVals[0];
    const allSec   = allUniq[1] ?? 0;

    // 전체(익일출고 포함) 기준 1등이 실제로 익일출고였을 때만 "오늘출고 기준으로 걸러냈다"는 의미가 있음
    // → 이 경우에만 ☀ 아이콘 표시 (전체 1등이 어차피 오늘출고였으면 필터링해도 결과가 같으므로 아이콘 불필요)
    const todayOnlyMattered = useTodayOnly && rawOverallLow > 0 && uniqVals[0] > rawOverallLow;

    // 1등 판매점 (원본 순서 기준)
    const _orderedSellers = [];
    for (const entry of activeOrderedRows) {
      if (!entry.isMine) {
        const matched = activeList.find(x => x.v === entry.v && !_orderedSellers.includes(x));
        if (matched) _orderedSellers.push(matched);
      }
    }
    lowestSeller = _orderedSellers[0]?.seller || sorted[0].seller || "";
    // (오늘출고기준) 문구는 셀 텍스트에 안 붙임 — 좁은 컬럼이라 잘려서 안 보이므로 title(툴팁)과 아이콘으로만 표시

    // 내일출고 최저가와의 차이도 함께 계산 (참고용 — 가격 계산에는 반영 안 하고 정보만 제공)
    let tomorrowLow = 0, tomorrowGap = 0, tomorrowSeller = "";
    if (useTodayOnly) {
      const tomorrowPrices = prices.filter(x => !x.todayShip);
      if (tomorrowPrices.length) {
        const tSorted = [...tomorrowPrices].sort((a, b) => a.v - b.v);
        tomorrowLow    = tSorted[0].v;
        tomorrowSeller = tSorted[0].seller;
        tomorrowGap    = tomorrowLow - uniqVals[0]; // 양수=내일출고가 더 비쌈(더 유리), 음수=내일출고가 더 쌈
      }
    }

    // 내 순위 계산 (오늘출고 기준을 쓰는 경우, 익일출고 경쟁사는 순위 계산에서 제외됨)
    let myRank = 0;
    if (p.my_price > 0 && p.my_stock > 0) {
      const myPrice = p.my_price;
      const cheaper = activeList.filter(x => x.v < myPrice).length;
      if (!myRowFound) {
        const sameAsMe = activeList.filter(x => x.v === myPrice).length;
        myRank = cheaper > 0 ? cheaper + 1 : (sameAsMe > 0 ? sameAsMe + 1 : 0);
      } else if (cheaper > 0) {
        myRank = cheaper + 1;
      } else {
        let rank = 0;
        for (const entry of activeOrderedRows) {
          if (entry.v > myPrice) break;
          rank++;
          if (entry.isMine) { myRank = rank; break; }
        }
        if (myRank === 0) {
          const sameAsMe = activeList.filter(x => x.v === myPrice).length;
          myRank = sameAsMe > 0 ? sameAsMe + 1 : 1;
        }
      }
    }

    const result = [uniqVals[0], sec2, mlow, lowestSeller, myRank, allSec,
      todayOnlyMattered ? 1 : 0, tomorrowLow, tomorrowGap, tomorrowSeller, myRowFound ? 1 : 0];
    window._lowestCache.delete(cacheKey); window._lowestCache.set(cacheKey, result);
    _trimLowestCache();
    return result;
  } catch(e) {
    console.error("[봇 fetchOneLowest 오류]", p?.tire_id, e);
    return [0, 0, 0, "", 0, 0, 0, 0, 0, ""];
  }
}

async function fetchLowestAll(products, statusCb) {
  const mine = products.filter(p => p.is_mine);
  if (!mine.length) return;
  let done = 0;
  let lastCb = 0;

  const conn = navigator.connection?.effectiveType || "4g";
  const startConcurrency = conn === "4g" ? 100 : 60;

  const queue = [...mine];

  await runAdaptivePool(queue, async (p) => {
    const [low, sec, mlow, seller, rank, allSec, todayOnly, tomorrowLow, tomorrowGap, tomorrowSeller] = await fetchOneLowest(p);
    const failed = !low && !sec && !mlow && !seller && !rank;
    p.lowest_price   = low;
    p.second_price   = sec || p.second_price;
    p.second_overall = allSec || 0;
    p.market_lowest  = mlow;
    p.lowest_seller  = seller || "";
    p.my_rank        = rank  || 0;
    p._todayOnlyMode = !!todayOnly;
    p._tomorrowLow   = tomorrowLow || 0;
    p._tomorrowGap   = tomorrowGap || 0;
    p._tomorrowSeller= tomorrowSeller || "";
    done++;
    const now = Date.now();
    if (statusCb && (now - lastCb > 150 || done === mine.length)) {
      lastCb = now;
      statusCb(`🔎 경쟁사 최저가 [${done}/${mine.length}]`);
    }
    return failed;
  }, {
    start: startConcurrency,
    min: 20,
    max: 300,          // 상한선 (계정 차단 위험 방지용 안전 상한)
    window: 20,        // 최근 20건 기준으로 실패율 판단
    failThreshold: 0.3,// 실패율 30% 넘으면 절반으로 축소
    growEvery: 15,      // 연속 15건 성공하면 동시성 한 단계 증가
    growStep: 15,
    onAdjust: (val, dir, rate) => {
      if (dir === "down") console.warn(`[검색-부스터] 실패율 ${Math.round(rate*100)}% 감지 — 동시성 ${val}로 축소`);
      else console.log(`[검색-부스터] 안정적 — 동시성 ${val}로 상승`);
    },
  });
}

// ── 가격 저장
async function savePrice(pid, price, stock) {
  if (!pid) throw new Error("savePrice: pid 없음");
  // 가격 0원 저장 방지 — 호출부 실수를 내부에서도 2중 차단
  if (!price || price <= 0) return { ok: false, msg: `savePrice: 가격 오류 (${price}원) — 저장 취소` };
  // POST body로만 전송 (쿼리스트링 중복 제거 — 서버가 body만 읽을 때 0원 저장 방지)
  const body = `pid=${encodeURIComponent(pid)}&sprice=${encodeURIComponent(price)}&dprice=&pcount=${encodeURIComponent(stock)}`;
  const r = await bgFetch(`${BASE}/ajax/price/setcount`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  try {
    const data = JSON.parse(r.text);
    if (data.code === "ok") return { ok: true };
    return { ok: false, msg: data.msg };
  } catch(e) {
    return { ok: false, msg: r.text };
  }
}

// ── 품절 해제
// 실제 저장 방식: /ajax/price/insert?width=0&height=0&inch=0&{폼필드}  (GET)
async function clearSoldout(pid, price, newStock) {
  // update 페이지 GET → 폼의 모든 hidden 값 수집
  const getR = await bgFetch(`${BASE}/sell/price/update/${pid}`);
  if (!getR.ok) return { ok: false, msg: "페이지 조회 실패" };

  const _csHtml = getR.text;
  const params = new URLSearchParams();

  // input 필드 전부 텍스트 파싱 (DOMParser 없이)
  for (const m of _csHtml.matchAll(/<input([^>]+)>/gi)) {
    const attr = m[1];
    const nameM = attr.match(/name=['"]([^'"]+)['"]/);
    const valM  = attr.match(/value=['"]([^'"]*)['"]/);
    const typeM = attr.match(/type=['"]([^'"]+)['"]/);
    if (!nameM) continue;
    const t = typeM?.[1]?.toLowerCase() || "text";
    if (t === "submit" || t === "button" || t === "reset") continue;
    params.set(nameM[1], valM?.[1] || "");
  }
  // select 필드
  for (const m of _csHtml.matchAll(/<select([^>]+)>[\s\S]*?<\/select>/gi)) {
    const attr = m[1];
    const nameM = attr.match(/name=['"]([^'"]+)['"]/);
    if (!nameM) continue;
    // selected 속성이 value 앞/뒤 어디에 있어도 잡히도록 두 패턴 모두 검사
    const selM = m[0].match(/<option[^>]+selected[^>]*value=['"]([^'"]*)['"]/i)
               || m[0].match(/<option[^>]+value=['"]([^'"]*)['"][^>]*selected/i)
               || m[0].match(/<option[^>]+value=['"]([^'"]*)['"]/i);
    params.set(nameM[1], selM?.[1] || "");
  }

  // 핵심 필드 명시적 세팅
  params.set("soldout", "0");           // 품절 → 판매중
  params.set("price",   String(price)); // 판매가
  params.set("dc",      "");            // DC율 (서버가 price로 계산)
  params.set("count",   String(newStock));

  // (text, select, radio 필드는 위 matchAll에서 이미 수집됨)

  // soldout=0 강제 세팅 (radio 수집 이후에 덮어쓰기)
  params.set("soldout", "0");

  // 기본값
  if (!params.has("minea"))      params.set("minea",      "1");
  if (!params.has("evensell"))   params.set("evensell",   "0");
  if (!params.has("directtype")) params.set("directtype", "0");
  if (!params.has("nocancel"))   params.set("nocancel",   "0");

  // 저장: /ajax/price/insert?width=0&height=0&inch=0&{params}  (GET)
  const qs  = `width=0&height=0&inch=0&${params.toString()}`;
  const res = await bgFetch(`${BASE}/ajax/price/insert?${qs}`);
  if (!res.ok) return { ok: false, msg: `저장 실패 (${res.status})` };

  try {
    const data = JSON.parse(res.text);
    if (data.code === "ok") return { ok: true };
    return { ok: false, msg: data.msg || "저장 실패" };
  } catch(e) {
    // JSON 파싱 실패 = redirect 응답 → 세션 만료 확인
    if (res.text && res.text.includes("login")) {
      return { ok: false, msg: "세션 만료 — 로그인 필요" };
    }
    return { ok: true }; // 일반 redirect는 성공으로 처리
  }
}

// ── 출고방식(당일/익일) 변경 ─────────────────────────────────
// 수정폼 전체를 보존하고 send_kind 값만 바꿔서 재전송 (가격/재고/메모 등 절대 건드리지 않음)
async function setSendKind(pid, kind) {
  if (!pid) return { ok: false, msg: "pid 없음" };
  const getR = await bgFetch(`${BASE}/sell/price/update/${pid}`);
  if (!getR.ok) return { ok: false, msg: "페이지 조회 실패" };
  const html = getR.text;
  if (/name=['"]login_id['"]|action=['"]\/login['"]|id=['"]login-form['"]/i.test(html))
    return { ok: false, msg: "세션 만료 — 로그인 필요" };
  const params = new URLSearchParams();
  for (const m of html.matchAll(/<input([^>]+)>/gi)) {
    const a = m[1];
    const nm = (a.match(/name=['"]([^'"]+)['"]/) || [])[1]; if (!nm) continue;
    const t  = ((a.match(/type=['"]([^'"]+)['"]/) || [])[1] || "text").toLowerCase();
    if (t === "submit" || t === "button" || t === "reset") continue;
    if ((t === "radio" || t === "checkbox") && !/checked/i.test(a)) continue;
    params.set(nm, (a.match(/value=['"]([^'"]*)['"]/) || [])[1] || "");
  }
  for (const m of html.matchAll(/<select([^>]+)>([\s\S]*?)<\/select>/gi)) {
    const nm = (m[1].match(/name=['"]([^'"]+)['"]/) || [])[1]; if (!nm) continue;
    const sel = (m[0].match(/<option[^>]+selected[^>]*value=['"]([^'"]*)['"]/i)
              || m[0].match(/<option[^>]+value=['"]([^'"]*)['"][^>]*selected/i)
              || m[0].match(/<option[^>]+value=['"]([^'"]*)['"]/i) || [])[1];
    params.set(nm, sel || "");
  }
  for (const m of html.matchAll(/<textarea([^>]*)>([\s\S]*?)<\/textarea>/gi)) {
    const nm = (m[1].match(/name=['"]([^'"]+)['"]/) || [])[1]; if (!nm) continue;
    params.set(nm, m[2]);
  }
  if (!params.has("id")) return { ok: false, msg: "폼 파싱 실패 (id 없음)" };
  if (!params.has("mode")) params.set("mode", "updateProcess");
  params.set("send_kind", String(kind)); // 출고방식만 덮어쓰기
  console.log(`[출고방식변경] pid=${pid} kind=${kind} url=${BASE}/ajax/price/insert?width=0&height=0&inch=0&${params.toString()}`);
  const res = await bgFetch(`${BASE}/ajax/price/insert?width=0&height=0&inch=0&${params.toString()}`);
  console.log(`[출고방식변경] 응답 status=${res.status} ok=${res.ok} body=${(res.text||"").slice(0,200)}`);
  if (!res.ok) return { ok: false, msg: `저장 실패 (${res.status})` };
  try {
    const d = JSON.parse(res.text);
    return d.code === "ok" ? { ok: true } : { ok: false, msg: d.msg || "저장 실패" };
  } catch(e) {
    return res.text?.includes("login") ? { ok: false, msg: "세션 만료" } : { ok: true };
  }
}

// ── 행사상품 최저가: DOT 해당연도~올해까지(이전연도 제외) 모두 합쳐서 최저가 조회
// 예) DOT 2024 → 2024,2025,2026 조회해서 합산 최저가 / DOT 2025 → 2025,2026만 조회 (2023 등 이전연도는 제외)
async function applyEventLowest(idx) {
  const p = shownProducts[idx];
  if (!p || !p.tire_id) return;
  if (!p.pid) { alert("pid 없음 — 가격을 저장할 수 없습니다"); return; }
  const yearStart = parseInt(p.dot, 10);
  if (!yearStart || yearStart < 2000) { alert("DOT(생산년도)가 없어 조회할 수 없습니다"); return; }
  const yearEnd = Math.max(yearStart, new Date().getFullYear());
  const years = [];
  for (let y = yearStart; y <= yearEnd; y++) years.push(y);

  st(`🎪 행사상품 최저가 조회 중... (DOT ${yearStart}~${yearEnd})`);
  try {
    let bestLow = 0, bestSec = 0, bestMlow = 0, bestSeller = "", bestYear = null;
    // 사전 계산된 값이 있으면 재사용 (버튼 표시 판단에 쓰인 값과 동일하게 적용)
    if (p._eventChecked && p._eventLow > 0) {
      bestLow = p._eventLow; bestYear = p._eventLowYear;
    }
    if (!bestLow) {
      const results = await Promise.all(
        years.map(y => fetchOneLowest({ tire_id: p.tire_id, dot: String(y) }))
      );
      for (let i = 0; i < results.length; i++) {
        const [low, sec, mlow, seller] = results[i];
        if (low > 0 && (bestLow === 0 || low < bestLow)) {
          bestLow = low; bestSec = sec; bestMlow = mlow; bestSeller = seller || ""; bestYear = years[i];
        }
      }
    }
    if (!bestLow) {
      st(`⚠️ DOT ${yearStart}~${yearEnd} 조회 결과 경쟁사 상품 없음`);
      return;
    }
    const target = bestLow - 10;
    if (target <= 0) {
      st(`⚠️ 합산 최저가(${comma(bestLow)}원)가 너무 낮아 -10원 적용 불가`);
      return;
    }
    // 참고용 경쟁가 정보 갱신 (버튼/상태 표시가 합산 결과를 반영하도록)
    p.lowest_price  = bestLow;
    if (bestSec)  p.second_price  = bestSec;
    if (bestMlow) p.market_lowest = Math.max(p.market_lowest || 0, bestMlow);
    p.lowest_seller = bestSeller ? `${bestSeller}(DOT${bestYear})` : `(DOT${bestYear})`;
    p.my_rank       = 0; // 연도 합산 상황에서는 개별 순위를 알 수 없어 초기화
    // 실제 판매가를 합산 최저가-10원으로 저장 (⬇최저가 버튼과 동일한 방식)
    await changePrice(p, idx, target);
    // 적용 후 합산 최저가를 다시 계산해 버튼 표시 여부 갱신
    p._eventChecked = undefined;
    if (p._cacheKey) { _rowCache.delete(p._cacheKey); p._cacheKey = ""; }
    refreshRowByTireId(p.tire_id, p.dot);
    _hydrateEventLowest();
    st(`✅ 행사상품 최저가 적용: DOT ${yearStart}~${yearEnd} 중 최저 ${comma(bestLow)}원 (DOT${bestYear}) → ${comma(target)}원으로 저장`);
  } catch(e) {
    st(`❌ 행사상품 최저가 적용 실패: ${e.message}`);
  }
}


// 수정폼 전체를 보존하고 send_hour/send_min 값만 바꿔서 재전송
async function setSendTime(pid, hour, min) {
  if (!pid) return { ok: false, msg: "pid 없음" };
  const getR = await bgFetch(`${BASE}/sell/price/update/${pid}`);
  if (!getR.ok) return { ok: false, msg: "페이지 조회 실패" };
  const html = getR.text;
  if (/name=['"]login_id['"]|action=['"]\/login['"]|id=['"]login-form['"]/i.test(html))
    return { ok: false, msg: "세션 만료 — 로그인 필요" };
  const params = new URLSearchParams();
  for (const m of html.matchAll(/<input([^>]+)>/gi)) {
    const a = m[1];
    const nm = (a.match(/name=['"]([^'"]+)['"]/) || [])[1]; if (!nm) continue;
    const t  = ((a.match(/type=['"]([^'"]+)['"]/) || [])[1] || "text").toLowerCase();
    if (t === "submit" || t === "button" || t === "reset") continue;
    if ((t === "radio" || t === "checkbox") && !/checked/i.test(a)) continue;
    params.set(nm, (a.match(/value=['"]([^'"]*)['"]/) || [])[1] || "");
  }
  for (const m of html.matchAll(/<select([^>]+)>([\s\S]*?)<\/select>/gi)) {
    const nm = (m[1].match(/name=['"]([^'"]+)['"]/) || [])[1]; if (!nm) continue;
    const sel = (m[0].match(/<option[^>]+selected[^>]*value=['"]([^'"]*)['"]/i)
              || m[0].match(/<option[^>]+value=['"]([^'"]*)['"][^>]*selected/i)
              || m[0].match(/<option[^>]+value=['"]([^'"]*)['"]/i) || [])[1];
    params.set(nm, sel || "");
  }
  for (const m of html.matchAll(/<textarea([^>]*)>([\s\S]*?)<\/textarea>/gi)) {
    const nm = (m[1].match(/name=['"]([^'"]+)['"]/) || [])[1]; if (!nm) continue;
    params.set(nm, m[2]);
  }
  if (!params.has("id")) return { ok: false, msg: "폼 파싱 실패 (id 없음)" };
  if (!params.has("mode")) params.set("mode", "updateProcess");
  params.set("send_hour", String(hour)); // 출고기준시간(시)만 덮어쓰기
  params.set("send_min",  String(min));  // 출고기준시간(분)만 덮어쓰기
  const res = await bgFetch(`${BASE}/ajax/price/insert?width=0&height=0&inch=0&${params.toString()}`);
  if (!res.ok) return { ok: false, msg: `저장 실패 (${res.status})` };
  try {
    const d = JSON.parse(res.text);
    return d.code === "ok" ? { ok: true } : { ok: false, msg: d.msg || "저장 실패" };
  } catch(e) {
    return res.text?.includes("login") ? { ok: false, msg: "세션 만료" } : { ok: true };
  }
}

async function runBulkSendTime(targets, hour, min, label) {
  loading(true, `0/${targets.length} 변경 중...`); lockBulkBtns();
  let failed = 0;
  try {
    for (let i = 0; i < targets.length; i += 5) {
      await Promise.all(targets.slice(i, i + 5).map(async ({ p }) => {
        const res = await setSendTime(p.pid, hour, min);
        if (res.ok) { p.send_hour = hour; p.send_min = min; if (p._cacheKey) { _rowCache.delete(p._cacheKey); p._cacheKey = ""; } refreshRow(p); }
        else { failed++; console.warn("[출고기준시간 변경 실패]", p.product, p.size, res.msg); }
      }));
      $("loading-msg").textContent = `저장 ${Math.min(i+5, targets.length)}/${targets.length}...`;
      if (i + 5 < targets.length) await new Promise(r => setTimeout(r, 200));
    }
    st(`✅ ${label} ${targets.length - failed}개 완료${failed ? ` (${failed}개 실패)` : ""}`);
  } catch(e) { st(`❌ ${label} 중 오류: ${e.message}`); }
  finally { loading(false); unlockBulkBtns(); checkedSet.clear(); rerenderChecks(); }
}

async function bulkSendTime() {
  const hour = $("sel-send-hour")?.value || "15";
  const min  = $("sel-send-min")?.value  || "00";
  const targets = [...checkedSet].map(k => { const i = _keyIdx(k); return { p: shownProducts[i], i }; })
    .filter(({ p }) => p?.is_mine && p.pid);
  if (!targets.length) { alert("변경할 상품을 선택하세요\n(내가 판매중인 상품만 출고기준시간을 변경할 수 있습니다)"); return; }
  if (!confirm(`선택한 ${targets.length}개 상품의 출고기준시간을 [${hour}시 ${min}분]으로 변경할까요?`)) return;
  await runBulkSendTime(targets, hour, min, "출고기준시간 변경");
}

// ── 구매제한(evensell) 변경 — 상품 1개만 개별 변경 ───────────
async function setEvensell(pid, val) {
  if (!pid) return { ok: false, msg: "pid 없음" };
  const getR = await bgFetch(`${BASE}/sell/price/update/${pid}`);
  if (!getR.ok) return { ok: false, msg: "페이지 조회 실패" };
  const html = getR.text;
  if (/name=['"]login_id['"]|action=['"]\/login['"]|id=['"]login-form['"]/i.test(html))
    return { ok: false, msg: "세션 만료 — 로그인 필요" };
  const params = new URLSearchParams();
  for (const m of html.matchAll(/<input([^>]+)>/gi)) {
    const a = m[1];
    const nm = (a.match(/name=['"]([^'"]+)['"]/) || [])[1]; if (!nm) continue;
    const t  = ((a.match(/type=['"]([^'"]+)['"]/) || [])[1] || "text").toLowerCase();
    if (t === "submit" || t === "button" || t === "reset") continue;
    if ((t === "radio" || t === "checkbox") && !/checked/i.test(a)) continue;
    params.set(nm, (a.match(/value=['"]([^'"]*)['"]/) || [])[1] || "");
  }
  for (const m of html.matchAll(/<select([^>]+)>([\s\S]*?)<\/select>/gi)) {
    const nm = (m[1].match(/name=['"]([^'"]+)['"]/) || [])[1]; if (!nm) continue;
    const sel = (m[0].match(/<option[^>]+selected[^>]*value=['"]([^'"]*)['"]/i)
              || m[0].match(/<option[^>]+value=['"]([^'"]*)['"][^>]*selected/i)
              || m[0].match(/<option[^>]+value=['"]([^'"]*)['"]/i) || [])[1];
    params.set(nm, sel || "");
  }
  for (const m of html.matchAll(/<textarea([^>]*)>([\s\S]*?)<\/textarea>/gi)) {
    const nm = (m[1].match(/name=['"]([^'"]+)['"]/) || [])[1]; if (!nm) continue;
    params.set(nm, m[2]);
  }
  if (!params.has("id")) return { ok: false, msg: "폼 파싱 실패 (id 없음)" };
  if (!params.has("mode")) params.set("mode", "updateProcess");
  params.set("evensell", String(val)); // 구매제한만 덮어쓰기
  const res = await bgFetch(`${BASE}/ajax/price/insert?width=0&height=0&inch=0&${params.toString()}`);
  if (!res.ok) return { ok: false, msg: `저장 실패 (${res.status})` };
  try {
    const d = JSON.parse(res.text);
    return d.code === "ok" ? { ok: true } : { ok: false, msg: d.msg || "저장 실패" };
  } catch(e) {
    return res.text?.includes("login") ? { ok: false, msg: "세션 만료" } : { ok: true };
  }
}

async function runBulkSendKind(targets, kind, label) {
  loading(true, `0/${targets.length} 변경 중...`); lockBulkBtns();
  let failed = 0;
  try {
    for (let i = 0; i < targets.length; i += 5) {
      await Promise.all(targets.slice(i, i + 5).map(async ({ p }) => {
        const res = await setSendKind(p.pid, kind);
        if (res.ok) { p.send_kind = kind; if (p._cacheKey) { _rowCache.delete(p._cacheKey); p._cacheKey = ""; } refreshRow(p); }
        else { failed++; console.warn("[출고방식 변경 실패]", p.product, p.size, res.msg); }
      }));
      $("loading-msg").textContent = `저장 ${Math.min(i+5, targets.length)}/${targets.length}...`;
      if (i + 5 < targets.length) await new Promise(r => setTimeout(r, 200));
    }
    st(`✅ ${label} ${targets.length - failed}개 완료${failed ? ` (${failed}개 실패)` : ""}`);
  } catch(e) { st(`❌ ${label} 중 오류: ${e.message}`); }
  finally { loading(false); unlockBulkBtns(); checkedSet.clear(); rerenderChecks(); }
}

// ── 선택한 상품을 거래처 탭으로 한꺼번에 배정 ─────────────────
async function bulkAssignBiz() {
  const targets = [...checkedSet].map(k => shownProducts[_keyIdx(k)]).filter(p => p && p.tire_id);
  if (!targets.length) { alert("배정할 상품을 선택하세요 (체크박스로 먼저 선택)"); return; }

  if (!bizData.tabs.length) {
    const name = prompt("아직 거래처 탭이 없습니다.\n새 거래처 탭 이름을 입력하세요:");
    if (!name?.trim()) return;
    await addBizTab(name.trim());
  }

  // 탭 선택 미니 팝업 (프롬프트 대신 번호 선택 방식)
  const list = bizData.tabs.map((t, i) => `${i + 1}. ${t.name}`).join("\n");
  const input = prompt(`선택한 ${targets.length}개 상품을 어느 거래처 탭으로 넘길까요?\n\n${list}\n\n번호를 입력하세요:`);
  const n = parseInt(input, 10);
  if (!n || n < 1 || n > bizData.tabs.length) return;
  const tab = bizData.tabs[n - 1];
  if (!confirm(`선택한 ${targets.length}개 상품을 [${tab.name}] 탭으로 배정할까요?`)) return;

  let assigned = 0;
  for (const p of targets) {
    const key = _bizKey(p);
    const already = bizData.assign[key]?.includes(tab.id);
    if (!already) { await toggleBizAssign(p, tab.id); assigned++; }
  }
  checkedSet.clear(); rerenderChecks();
  st(`✅ [${tab.name}]로 ${assigned}개 배정 완료 (이미 있던 것 제외)`);
}

async function bulkSendKind(kind) {
  const label = kind === 0 ? "당일출고" : "익일출고";
  const targets = [...checkedSet].map(k => { const i = _keyIdx(k); return { p: shownProducts[i], i }; })
    .filter(({ p }) => p?.is_mine && p.pid);
  if (!targets.length) { alert("변경할 상품을 선택하세요\n(내가 판매중인 상품만 출고방식을 변경할 수 있습니다)"); return; }
  const already = targets.filter(({ p }) => p.send_kind === kind).length;
  const msg = already > 0
    ? `선택한 ${targets.length}개 중 ${already}개는 이미 [${label}]입니다.\n전체 ${targets.length}개를 [${label}]로 변경할까요?`
    : `선택한 ${targets.length}개 상품을 [${label}]로 변경할까요?`;
  if (!confirm(msg)) return;
  await runBulkSendKind(targets, kind, label + " 변경");
}

// 행 뱃지 클릭 → 출고방식 변경 팝업
let _sendkindPopupIdx = null;
function showSendKindPopup(p, idx, anchorEl) {
  const popup = $("sendkind-popup");
  if (!popup) return;
  _sendkindPopupIdx = idx;
  const current = p.send_kind;
  const items = [];
  if (current !== 0) items.push({ kind: 0, label: "🚚 당일출고로 변경", cls: "badge-sameday" });
  if (current !== 1) items.push({ kind: 1, label: "🌙 익일출고로 변경", cls: "badge-nextday" });
  popup.innerHTML = items.map(it =>
    `<button class="sendkind-pop-btn ${it.cls}" data-kind="${it.kind}" style="display:block;width:100%;text-align:left;padding:6px 10px;border:none;background:transparent;cursor:pointer;border-radius:5px;font-size:11px;font-weight:bold;">${it.label}</button>`
  ).join("") || `<div style="color:#9ca3af;padding:4px 8px;font-size:10px;">출고방식을 알 수 없습니다</div>`;
  popup.querySelectorAll(".sendkind-pop-btn").forEach(btn => {
    btn.addEventListener("mouseenter", () => btn.style.background = "#f3f4f6");
    btn.addEventListener("mouseleave", () => btn.style.background = "transparent");
    btn.addEventListener("click", async () => {
      hideSendKindPopup();
      const kind = Number(btn.dataset.kind);
      if (!p.pid) { st("⚠️ pid 없음 — 저장 불가"); return; }
      st(`⏳ 출고방식 변경 중...`);
      const res = await setSendKind(p.pid, kind);
      if (res.ok) {
        p.send_kind = kind;
        if (p._cacheKey) { _rowCache.delete(p._cacheKey); p._cacheKey = ""; }
        refreshRow(p);
        st(`✅ ${kind === 0 ? "🚚 당일출고" : "🌙 익일출고"}로 변경 완료`);
      } else {
        st(`❌ 출고방식 변경 실패: ${res.msg}`);
      }
    });
  });
  const rect = anchorEl.getBoundingClientRect();
  popup.style.display = "block";
  popup.style.top  = Math.min(rect.bottom + 3, window.innerHeight - 100) + "px";
  popup.style.left = Math.max(4, rect.left - 60) + "px";
}
function hideSendKindPopup() {
  const popup = $("sendkind-popup");
  if (popup) { popup.style.display = "none"; popup.innerHTML = ""; }
  _sendkindPopupIdx = null;
}

// ── beforeunload: 디바운스 중 저장 즉시 flush
window.addEventListener("beforeunload", () => {
  if (_saveCacheTimer) {
    clearTimeout(_saveCacheTimer);
    _saveCacheTimer = null;
    if (_memCache) {
      // 동기 저장 (beforeunload에서만 허용)
      chrome.storage.local.set({ tireping_cache: _memCache }, () => {});
    }
  }
});

// ── 검색
// _refreshRunning 대기열: 검색 연타 시 poll이 중복 생성되지 않도록 단일 Promise로 공유
let _refreshWaitPromise = null;

async function doSearch(useCache) {
  const _myToken = ++_searchToken;
  const _safeLoadingOff = () => { if (_searchToken === _myToken) loading(false); };

  // refreshLowest 실행 중이면 loading 표시만 하고 완료 대기
  // 연타 시 대기 Promise를 공유 → poll이 1개만 생성됨
  if (_refreshRunning) {
    loading(true, "새로고침 완료 후 검색...");
    if (!_refreshWaitPromise) {
      _refreshWaitPromise = new Promise(resolve => {
        let waited = 0;
        const poll = setInterval(() => {
          waited += 200;
          if (!_refreshRunning || waited >= 30000) {
            clearInterval(poll);
            _refreshWaitPromise = null;
            resolve();
          }
        }, 200);
      });
    }
    await _refreshWaitPromise;
    // 이 토큰이 최신이 아니면(더 나중에 시작된 검색이 있으면) 중단
    if (_searchToken !== _myToken) return;
  }
  loading(true, "검색 중...");
  _favLastStarIdx = null; // 새 검색이므로 이전 범위선택 기준 초기화
  // 즐겨찾기/내판매현황 보기 중 검색하면 검색 보기로 복귀 (탭 표시도 최저가 봇으로)
  if (viewMode === "fav") {
    viewMode = "search";
    _savedSearch = null;
    document.querySelector('.tab-btn[data-tab="fav"]')?.classList.remove("active");
    document.querySelector('.tab-btn[data-tab="price"]')?.classList.add("active");
  }
  if (viewMode === "mine") {
    viewMode = "search";
    _mineAllProducts = null;
    const bar = $("mine-mfr-bar"); if (bar) bar.style.display = "none";
    document.querySelector('.tab-btn[data-tab="mine"]')?.classList.remove("active");
    document.querySelector('.tab-btn[data-tab="price"]')?.classList.add("active");
  }
  // filterState = {};  // 검색 시 필터 유지 (재검색해도 필터 설정 초기화 안 함)
  // 자동갱신 실행 중이 아닐 때만 최저가 캐시 초기화
  // (자동갱신 배치가 진행 중이면 이미 받아놓은 캐시 보존)
  if (!_refreshRunning) window._lowestCache = new Map();
  checkedSet.clear();
  lastShiftIdx = null; _lastShiftKey = null; _shiftHeld = false; // 새 검색 시 shift 상태 초기화
  unsavedRows.clear(); // 미저장 상태 초기화 (새 검색이므로)

  // 사이즈: 드롭다운 우선, 없으면 텍스트 입력
  const width   = $("sel-width")?.value  || "단면폭";
  const height  = $("sel-height")?.value || "편평비";
  const inch    = $("sel-inch")?.value   || "인치";
  const sizeText = $("inp-size").value.trim();

  // sizeText 처리:
  // - 숫자 시작(245 45 18) → 사이즈 search 파라미터
  // - 영문/한글 시작(ra45, TA21, 솔루스) → search 파라미터로 서버에 그대로 전달
  //   (타이어핑 서버가 패턴명/제품코드 등으로 검색해줌)
  // - 단, sel-mfr이 선택돼 있으면 제조사 ID는 company로 따로 전달
  let search = "";
  if (sizeText) {
    search = sizeText.replace(/\s/g, "");
  }

  // 제조사: sel-mfr 드롭다운 선택값만 사용
  // inp-size 텍스트를 제조사로 오판하지 않음 (ra45 같은 패턴코드 검색 보호)
  let company = $("sel-mfr").value || "";
  let mfrName = "";
  const _selMfrText = $("sel-mfr").options[$("sel-mfr").selectedIndex]?.text || "";
  if (company && _selMfrText && _selMfrText !== "제조사") {
    mfrName = _selMfrText;
  }
  const pattern = $("sel-prod").value;
  const dot     = $("sel-dot").value || "DOT";
  const order   = $("sel-order").value;
  const prodName= $("sel-prod").options[$("sel-prod").selectedIndex]?.text || "";

  try {
    let products = [];

    if (useCache) {
      const cache = await loadCache();
      products = fromCache(cache, {
        search,
        mfr: mfrName,
        prod: prodName === "제품명" ? "" : prodName,
        dot: dot === "DOT" ? "" : dot,
        prodFallback: !mfrName && sizeText && !/^\d/.test(sizeText) ? sizeText : "",
      });
      // 캐시 결과 표시 중 가격 변경 방지 — fresh 데이터 받기 전 벌크 버튼 비활성화
      // (구 공장도가 기준으로 가격 저장하는 버그 방지)
      if (products.length) {
        lockBulkBtns();
        st(`📦 캐시 ${products.length}개 로드 — 최신 데이터 확인 중... (가격 변경은 완료 후 가능)`);
      }
    }

    // ── 핵심 최적화: fetchBuyInsert + fetchMyProducts 병렬 실행
    // 두 API는 서로 독립적 → Promise.all로 동시 호출
    // 직렬 대비 약 30~40% 단축 (3초+2초 → 3초 병렬)
    const sellCompany = company || "0";
    const sellPattern = pattern || "0";
    const sellDot     = (dot && dot !== "DOT") ? dot : "0";

    st("⏳ 상품 목록 + 내 판매상품 동시 수집 중...");
    // 내 판매상품 조회를 검색한 사이즈로 좁힘 → 매칭(tire_id 조회) 대상 대폭 축소
    // (사이즈 불완전 시 _getSellSizeParams가 "0"을 반환해 기존처럼 전체 조회)
    const _sz = _getSellSizeParams();

    // 내 판매상품 수집:
    // - DOT 미선택(sellDot="0"): dot=0 전체 한 번만
    // - DOT 선택 + 다른 좁히는 조건(사이즈/제조사/제품명/검색어)도 있음:
    //   전체(dot=0)를 먼저 수집하면 tire_id가 캐시에 저장됨 →
    //   이어지는 정확DOT(dot=sellDot) 패스는 캐시 적중으로 매칭이 거의 무료.
    //   (기존엔 두 패스를 병렬-콜드로 돌려 같은 상품을 2번씩 매칭 → 2배 낭비)
    // - DOT만 선택하고 다른 조건이 전혀 없음: "전체 먼저 훑기"를 생략하고
    //   바로 정확 DOT로만 1번 조회 (안 그러면 DOT 하나만 걸어도 매번 전체 카탈로그를
    //   통째로 스캔하게 되어 결과 수와 무관하게 몇천 개씩 요청이 나감)
    const _collectMine = async () => {
      // 사이즈 검색이면 width/height/inch로 이미 좁혀지므로 search는 비워도 됨.
      // 사이즈가 아닌 텍스트(패턴명·제품코드 등) 검색이면, 그 검색어를 그대로 넘겨서
      // "내 판매상품" 조회 자체도 좁혀지게 함 (예전엔 항상 search:""라서 텍스트 검색 시 전체를 훑었음)
      const mineSearch = _sz.has ? "" : search;
      const base = { search: mineSearch, company: sellCompany, pattern: sellPattern,
                     width: _sz.width, height: _sz.height, inch: _sz.inch };
      if (sellDot === "0") {
        return await fetchMyProducts(st, { ...base, dot: "0" });
      }
      const hasOtherNarrow = _sz.has || !!mineSearch || sellCompany !== "0" || sellPattern !== "0";
      if (!hasOtherNarrow) {
        // DOT만 있고 다른 좁히는 조건이 없음 → 전체 선(先)스캔 생략, 정확 DOT만 1번 조회
        return await fetchMyProducts(st, { ...base, dot: sellDot });
      }
      const full  = await fetchMyProducts(st,   { ...base, dot: "0" });      // 전체(매칭+캐시저장)
      const exact = await fetchMyProducts(null,  { ...base, dot: sellDot }); // 정확DOT(캐시적중)
      // dot=0 전체를 깔고 dot=sellDot 정확한 값으로 덮어씀 (정확 DOT 우선)
      return { ...full, ...exact };
    };

    const [fresh, myMap] = await Promise.all([
      fetchBuyInsert({ search, company, pattern, width, height, inch, dot, order }, st),
      _collectMine(),
    ]);

    // 클라이언트 필터 (제조사/제품명 드롭다운 선택 시)
    const _filterProdText = prodName === "제품명" ? "" : prodName;
    const filteredFresh = (mfrName || _filterProdText) ? fresh.filter(p => {
      if (mfrName) {
        // 양방향 포함 체크: buy/insert가 "금호"로 반환해도 mfrName="금호타이어"와 매칭
        const pm = p.manufacturer.toLowerCase();
        const mm = mfrName.toLowerCase();
        if (!pm.includes(mm) && !mm.includes(pm)) return false;
      }
      if (_filterProdText && !p.product.toLowerCase().includes(_filterProdText.toLowerCase())) return false;
      return true;
    }) : fresh;

    // 캐시 저장은 다음 검색을 위한 것이라 이번 결과 표시와 무관 → 기다리지 않고 백그라운드로 진행
    // (matchMy/fetchLowestAll을 더 빨리 시작하기 위한 속도 개선)
    updateCache(filteredFresh).catch(e => console.warn("[updateCache] 실패:", e.message));

    if (useCache) {
      // fromCache(캐시)는 즉시 표시용 — tire_id가 buy/insert와 다를 수 있어 matchMy 대상으로는 부적합
      // filteredFresh(buy/insert 결과)를 기준으로 products 구성
      // 캐시에만 있고 fresh에 없는 항목(단종/품절)은 유지
      const freshKeys = new Set(filteredFresh.map(p => `${p.tire_id}_${p.dot || ""}`));
      const cacheOnly = products.filter(p => !freshKeys.has(`${p.tire_id}_${p.dot || ""}`));
      products = [...filteredFresh, ...cacheOnly];
    } else {
      products = filteredFresh;
    }

    if (!products.length) { st("⚠️ 검색 결과 없음"); _safeLoadingOff(); return; }



    // matchMy는 두 결과가 모두 필요 (Promise.all 완료 후)
    matchMy(products, myMap, await loadTireCache());

    const mineN = products.filter(p => p.is_mine).length;
    st(`✅ ${mineN}개 매칭 — 경쟁사 최저가 조회 중...`);
    await fetchLowestAll(products, st);

    // 파생값 사전 계산 (정렬/필터가 즉시 작동하도록)
    products.forEach(calcDerivedFields);
    syncFavSnapshots(products); // 즐겨찾기 상품 스냅샷 최신화 (가격/재고 반영)
    allProducts   = products;
    shownProducts = [...products];
    _tableVisibleLimit = TABLE_PAGE_SIZE; // 새 검색 시 500개부터 다시 표시
    _updatePriceMfrTabs(); // 제조사 빠른필터 바 갱신 (검색결과 기준)
    // 내 판매현황 탭이 열려있으면 새 검색결과로 자동 갱신
    if (viewMode === "mine") {
      // 검색 결과로 배정된 상품의 스냅샷(가격·재고) 최신화만 — mine 뷰는 스냅샷 기반 유지
      const mine = products.filter(p => p.is_mine);
      let snapUpdated = false;
      for (const p of mine) {
        const key = _bizKey(p);
        if (bizData.assign[key]?.length && p.tire_id) {
          bizData.products[key] = {
            tire_id: p.tire_id, dot: p.dot, pid: p.pid||null,
            manufacturer: p.manufacturer||"", product: p.product||"",
            size: p.size||"", detail: p.detail||"",
            my_price: p.my_price||0, my_stock: p.my_stock||0,
            factory_price: p.factory_price||0, dc_rate: p.dc_rate||0,
            is_soldout: !!p.is_soldout, is_mine: true,
          };
          snapUpdated = true;
        }
      }
      if (snapUpdated) _saveBizLocal();
      _renderMineView(); // 스냅샷 기반으로 갱신
      unlockBulkBtns();
      st(`✅ 완료! 전체 ${products.length}개 | 내 판매 ${mineN}개 (거래처 스냅샷 갱신됨)`);
      return;
    }
    // 기존 필터 유지: filterState 또는 결과내검색이 있으면 applyFilters, 없으면 renderTable
    _lastFilterKey = ""; // 캐시 무효화 (새 데이터이므로)
    applyFilters._ref = null; // checksum 캐시도 무효화
    if (_hasKeys(filterState) || quickFilter) {
      applyFilters(_safeLoadingOff);
    } else {
      renderTable(shownProducts, _safeLoadingOff);
    }
    unlockBulkBtns(); // fresh 데이터 수신 완료 → 가격 변경 버튼 활성화
    st(`✅ 완료! 전체 ${products.length}개 | 내 판매 ${mineN}개`);
  } catch(e) {
    st(`❌ 오류: ${e.message}`);
    console.error(e);
  } finally {
    // renderTable/applyFilters가 rAF 콜백에서 loading을 끄지만,
    // 예외 발생이나 조기 return 경로에서도 반드시 loading이 꺼지도록 보장
    _safeLoadingOff();
  }
}

// ── 테이블 렌더링
const _rowCache = new Map(); // tire_id+상태 → HTML 캐시

function calcRow(p, idx) {
  calcDerivedFields(p);
  // 사용자가 직접 수정한 DOT 오버라이드 적용 (내 상품만)
  if (p.is_mine && p.pid) {
    const _dov = dotOverrides[String(p.pid)];
    if (_dov !== undefined) p.dot = _dov;
  }
  // 행 캐시키: 가격/재고/상태/체크 변화 감지
  // checkedSet.has(idx) 제거 — 체크 상태는 rerenderChecks()가 DOM 직접 업데이트
  // (전체선택 N개 → N번 캐시 miss 방지)
  const cacheKey = `${p.tire_id}|${p.dot||''}|${p.my_price}|${p.lowest_price}|${p.second_price}|${p.second_overall||0}|${p.my_stock}|${p._status}|${p.my_rank || 0}|${isFav(p)?1:0}|biz:${getBizCount(p)}|sk:${p.send_kind??""}|st:${p.send_time??""}|ev:${p._evensell??""}|cr:${effectiveCostRate(p)}|sh:${effectiveShippingCost(p)}|vm:${viewMode}|el:${p._eventChecked === undefined ? "?" : (p._eventLow||0)}|tg:${p._tomorrowGap??""}`;
  // p._cacheKey에 직전 렌더 키 저장 → renderTable에서 DOM 비교 없이 스킵 가능
  if (_rowCache.has(cacheKey)) {
    // LRU 갱신: 접근된 항목을 Map 끝으로 이동 (삽입순서 기반)
    const html = _rowCache.get(cacheKey);
    _rowCache.delete(cacheKey);
    _rowCache.set(cacheKey, html);
    p._cacheKey = cacheKey;
    return html;
  }
  // 상태값 미리 계산 (템플릿 내 연산 최소화)
  const my  = p.my_price   || 0;
  const low = p.lowest_price || 0;
  const sec = p.second_price || 0;
  // secDisplay: "2등가격" 컬럼 표시용 — 나 포함 시장 전체 2위 가격
  // second_overall이 있으면 사용, 없으면 내가 최저가일 때 lowest_price(=시장 2위)로 폴백
  const secDisplay = p.second_overall || (p.is_mine && low > 0 && my > 0 && my <= low ? low : sec);
  const isMine   = p.is_mine;
  const isSoldout = p.my_stock === 0 || p.is_soldout;
  const isLow    = isMine && low > 0 && my <= low;
  const raiseBase = low > 0 ? low : sec;
  let tag = "notmine", status = p._status || "⬜ 미판매", statusOrder = p._statusOrder ?? 3;
  let diff = "-", lowBtn = "", raiseBtn = "", raise3Btn = "", uploadBtn = "";

  if (p.is_mine && (p.my_stock === 0 || p.is_soldout)) {
    // 품절: 재고 0이거나 타이어핑 품절 마크
    tag = "soldout"; status = "🔴 품절"; statusOrder = 0;
    uploadBtn = `<button class="btn-orange btn-set-stock" data-idx="${idx}">📦재고입력</button>`;
  } else if (p.is_mine && low > 0) {
    const isLow = my <= low;
    // 동률 후순위: 가격은 최저가이지만 순위가 밀림
    const isTiedBehind = isLow && (p.my_rank || 0) >= 2;
    if (isTiedBehind) {
      tag         = "mine-tied";
      status      = `⚠️ 동률${p.my_rank}등`;
      statusOrder = 15;
      diff        = `<span style="color:#d97706">동가${p.my_rank}등</span>`;
      // 동률 후순위 → ⬇최저가 버튼: 동률가 -10원으로 단독 1등 만들기
      lowBtn = low - 10 > 0
        ? `<button class="btn-red btn-low" data-idx="${idx}" title="동률가(${comma(low)}원)보다 10원 싸게 → 단독1등으로">⬇최저가</button>`
        : "";
    } else {
      tag         = isLow ? "mine-green" : "mine-red";
      status      = isLow ? "✅ 최저가" : "❌ 비최저가";
      statusOrder = isLow ? 2 : 1;
      if (!isLow) {
        // 비최저가: 경쟁최저와 차이 (음수)
        diff = `<span style="color:#dc2626">-${comma(my - low)}</span>`;
      } else if (low > 0) {
        // 최저가: 경쟁최저(2등)와의 차이 (양수, 초록)
        diff = `<span style="color:#16a34a">+${comma(low - my)}</span>`;
      } else {
        diff = "0";
      }
      lowBtn      = !isLow
        ? `<button class="btn-red btn-low" data-idx="${idx}">⬇최저가</button>` : "";
      // 최저가인데 2등과 차이가 클 때 → 2등-10원으로 올리기
      // ↑버튼: 최저가/비최저가 모두 표시 (경쟁최저-10원)
      // ↑버튼: 2등-10원 (경쟁최저 기준)
      const raiseBase = low > 0 ? low : sec;
      raiseBtn = raiseBase > 0 && raiseBase - my > 10
        ? `<button class="btn-green btn-raise" data-idx="${idx}" title="${isLow ? "2등" : "경쟁최저"}(${comma(raiseBase)}원)보다 10원 싸게">↑${comma(raiseBase-10)}</button>` : "";
      // ↑↑버튼: 3등-10원 (second_price 기준, 내가 최저가일 때만)
      raise3Btn = isLow && sec > 0 && sec > raiseBase && sec - my > 10
        ? `<button class="btn-sky btn-raise3" data-idx="${idx}" title="3등(${comma(sec)}원)보다 10원 싸게">↑↑${comma(sec-10)}</button>` : "";
    }
  } else if (p.is_mine) {
    tag = "mine-only"; status = "단독판매"; statusOrder = 3;
    uploadBtn = `<button class="btn-orange btn-set-stock" data-idx="${idx}">📦재고입력</button>`;
  } else {
    uploadBtn = `<button class="btn-purple btn-upload" data-idx="${idx}">📤등록</button>`;
  }

  p._status      = status;
  p._statusOrder = statusOrder;
  p._diff        = diff;

  const chk = ""; // CSS ::before/::after가 체크박스 표시

  const html = `<tr class="${tag}" data-idx="${idx}" data-tire-id="${p.tire_id || ''}" data-dot="${p.dot || ''}">
    <td class="chk-cell" data-idx="${idx}">${chk}</td>
    <td class="fav-cell" data-idx="${idx}" style="white-space:nowrap;overflow:visible;min-width:38px;padding:2px 4px;">
      <span class="fav-star${isFav(p) ? " on" : ""}" title="즐겨찾기 ${isFav(p) ? "해제" : "추가"} (Shift+클릭: 범위 한번에)" style="display:inline-block;cursor:pointer;font-size:13px;">${isFav(p) ? "★" : "☆"}</span><span class="biz-btn${getBizCount(p) ? " biz-assigned" : ""}" data-bizkey="${(p.tire_id||"")+"__"+(p.dot||"")}" title="거래처 탭 배정" style="display:inline-block;cursor:pointer;font-size:12px;margin-left:3px;">📁${getBizCount(p) ? `<sup style="font-size:8px;color:#15803d;font-weight:700;">${getBizCount(p)}</sup>` : ""}</span>
    </td>
    <td>${p.manufacturer}</td>
    <td style="text-align:center;white-space:nowrap;" title="${escHtml(p.product)}">${p.product}</td>
    <td>${p.size}</td>
    <td class="td-left" title="${escHtml(p.detail || '')}">${p.detail || "-"}</td>
    <td>${p.is_mine
        ? `<input type="text" class="inline-dot" data-idx="${idx}"
            value="${p.dot || ""}" placeholder="-"
            style="width:36px;text-align:center;border:none;background:transparent;
            font-size:11px;font-family:inherit;cursor:pointer;"
            readonly title="클릭하여 DOT 직접 수정">`
        : (p.dot || "-")}</td>
    <td>${p.factory_price ? comma(p.factory_price)+"원" : "-"}</td>
    <td>${p.market_lowest ? comma(p.market_lowest)+"원" : "-"}</td>
    <td class="${p.is_mine && p.my_stock > 0 ? "td-editable" : ""}"
        data-field="price" data-idx="${idx}">
      ${p.is_mine
        ? `<input type="text" class="inline-price" data-idx="${idx}"
            value="${my || ""}" data-factory="${p.factory_price}"
            style="width:68px;text-align:center;border:none;background:transparent;
            font-size:11px;font-family:inherit;cursor:pointer;"
            readonly>`
        : "-"}
    </td>
    <td class="${p.is_mine && p.my_stock > 0 ? "td-editable" : ""}"
        data-field="dc" data-idx="${idx}">
      ${p.is_mine
        ? `<input type="text" class="inline-dc" data-idx="${idx}"
            value="${p.dc_rate || calcDc(p.factory_price, my)}"
            data-factory="${p.factory_price}"
            style="width:42px;text-align:center;border:none;background:transparent;
            font-size:11px;font-family:inherit;cursor:pointer;"
            readonly>`
        : "-"}
    </td>
    ${(() => {
      // 원가/택배/마진: 행마다 한 번씩만 계산해서 재사용
      const info      = effectiveCostInfo(p); // null | {rate, costOverride, source, tabName}
      const costVal   = calcCost(p);          // null 가능 (마진탭 매칭도, 사용자 오버라이드도 없으면 null)
      const costRate  = (info && (info.costOverride === null || info.costOverride === undefined)) ? info.rate : null;
      const shipInfo  = effectiveShippingInfo(p); // null | {value, source}
      const shipVal   = shipInfo ? shipInfo.value : null;
      const shipForMargin = shipVal || 0;
      const marginVal = (p.is_mine && my && costVal !== null) ? (my - costVal - Math.round(my * feeRatePct / 100) - shipForMargin) : null;
      const marginColor = marginVal === null ? "color:#9ca3af;" : (marginVal >= 0 ? "color:#16a34a;" : "color:#dc2626;");
      const marginTitle = marginVal === null ? "" :
        `판매 ${comma(my)} − 원가 ${comma(costVal)} − 수수료(${feeRatePct}%) ${comma(Math.round(my * feeRatePct / 100))} − 택배 ${comma(shipForMargin)} = 마진 ${comma(marginVal)}`;
      const marginText = marginVal === null ? "-" : comma(marginVal) + "원";
      const srcTag = info ? (info.source === "override" ? " (직접 수정)" : ` (마진탭: ${escHtml(info.tabName || "")})`) : "";
      const costTitle = !p.factory_price ? "" :
        !info ? "마진탭에 일치하는 규칙이 없습니다 — 클릭해서 직접 원가율(%)을 입력할 수 있습니다"
        : (info.costOverride !== null && info.costOverride !== undefined)
          ? `원가 직접입력 ${comma(info.costOverride)}원${srcTag} · 클릭해서 원가율(%) 수정`
          : `공장도 ${comma(p.factory_price)}원 × (1 − 원가율 ${info.rate}%)${srcTag} · 클릭해서 원가율 수정`;
      const shipSrcTag = shipInfo ? (shipInfo.source === "override" ? " (직접 수정)" : " (사이즈별 택배비 설정)") : "";
      const shipTitle = !p.is_mine ? "" :
        !shipInfo ? "사이즈별 택배비에 일치하는 규칙이 없습니다 — 클릭해서 직접 택배비를 입력할 수 있습니다"
        : `택배비 ${comma(shipVal)}원${shipSrcTag} · 클릭해서 수정`;
      return `
    <td class="${p.factory_price ? "td-editable" : ""}" data-field="costrate" data-idx="${idx}" title="${costTitle}">
      ${p.factory_price
        ? `<input type="text" class="inline-costrate" data-idx="${idx}"
            value="${costVal !== null ? comma(costVal) : "-"}" data-rate="${costRate ?? ""}"
            style="width:60px;text-align:center;border:none;background:transparent;
            font-size:11px;font-family:inherit;cursor:pointer;${costVal===null?"color:#d1d5db;":""}"
            readonly>`
        : "-"}
    </td>
    <td class="${p.is_mine ? "td-editable" : ""}" data-field="shipping" data-idx="${idx}" title="${shipTitle}">
      ${p.is_mine
        ? `<input type="text" class="inline-shipping" data-idx="${idx}"
            value="${shipVal !== null ? comma(shipVal) : "-"}"
            style="width:46px;text-align:center;border:none;background:transparent;
            font-size:11px;font-family:inherit;cursor:pointer;${shipVal===null?"color:#d1d5db;":""}"
            readonly>`
        : "-"}
    </td>
    <td style="text-align:center;font-weight:600;${marginColor}" title="${marginTitle}">${marginText}</td>`;
    })()}
    <td style="font-size:11px;color:#6b7280;">
      ${p.factory_price && p.lowest_price
        ? calcDc(p.factory_price, p.lowest_price) + "%"
        : (p.factory_price && p.market_lowest
            ? calcDc(p.factory_price, p.market_lowest) + "%" : "-")}
    </td>
    <td>${low ? comma(low)+"원" : "-"}</td>
    <td style="font-size:10px;color:#6b7280;max-width:70px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"
        title="${escHtml(
          (p.lowest_seller || '') +
          (p._todayOnlyMode ? '\n(오늘출고 기준 최저가 — 익일출고 경쟁사는 제외하고 계산)' : '') +
          (p._tomorrowLow ? `\n내일출고 최저가: ${comma(p._tomorrowLow)}원 (${p._tomorrowSeller||'-'}) — 오늘출고 기준보다 ${p._tomorrowGap>=0?comma(p._tomorrowGap)+'원 더 비쌈':comma(Math.abs(p._tomorrowGap))+'원 더 쌈'}` : '')
        )}">${p._todayOnlyMode ? "☀" : ""}${p.lowest_seller || "-"}</td>
    <td style="font-size:10px;color:${p._tomorrowGap<0?'#dc2626':'#6b7280'};text-align:center;">${
      p._tomorrowLow ? `${p._tomorrowGap>=0?"+":""}${comma(p._tomorrowGap)}` : "-"
    }</td>
    <td style="font-size:11px;text-align:center;font-weight:bold;">${
      (() => {
        if (!p.is_mine || p.my_stock === 0 || p.is_soldout) return '<span style="color:#d1d5db;">-</span>';
        const r = p.my_rank || 0;
        if (r === 0) return '<span style="color:#d1d5db;">-</span>';
        if (r === 1) return '<span style="color:#16a34a;">1등</span>';
        if (r === 2) return '<span style="color:#2563eb;">2등</span>';
        if (r === 3) return '<span style="color:#d97706;">3등</span>';
        return `<span style="color:#dc2626;">${r}등</span>`;
      })()
    }</td>
    <td>${secDisplay ? comma(secDisplay)+"원" : "-"}</td>
    <td>${diff}</td>
    <td>${p.is_mine
      ? `<input type="number" class="inline-stock" data-idx="${idx}"
          value="${p.my_stock || 0}" min="0"
          style="width:44px;text-align:center;border:none;background:transparent;
          font-size:11px;font-family:inherit;cursor:pointer;"
          readonly>`
      : "-"}</td>
    <td style="font-size:11px;text-align:center;color:#374151;">${
      p.market_stock > 0 ? p.market_stock : "-"
    }</td>
    <td>${status}</td>
    <td class="btn-cell">
      ${lowBtn}${raiseBtn}${raise3Btn}${uploadBtn}
      ${p.is_mine ? `<button class="btn-gray btn-save-stock btn-sm" data-idx="${idx}" style="display:none">💾저장</button>` : ""}
    </td>
    <td style="text-align:center;padding:2px 3px;">${
      !(viewMode === "mine" && p.is_mine && p.tire_id && p.dot)
        ? '<span style="color:#e5e7eb;font-size:9px;">-</span>'
      : p._eventChecked === undefined
        ? '<span style="color:#9ca3af;font-size:9px;" title="연도합산 최저가 확인 중...">…</span>'
      : (p._eventLow > 0 && p.my_price > p._eventLow)
        ? `<button class="btn-orange btn-sm btn-event-low" data-idx="${idx}" title="DOT ${p.dot}~${p._eventLowYear} 합산 최저 ${comma(p._eventLow)}원 (DOT${p._eventLowYear}) — 내 가격 ${comma(p.my_price)}원보다 쌈. 클릭 시 ${comma(p._eventLow - 10)}원으로 조정">🎪행사최저</button>`
        : '<span style="color:#e5e7eb;font-size:9px;" title="연도합산 기준으로도 이미 최저가입니다">-</span>'
    }</td>
    <td style="text-align:center;padding:2px 3px;">${
      !p.is_mine ? '<span style="color:#e5e7eb;font-size:9px;">-</span>'
      : p.send_kind === 0 ? `<span class="badge-sendkind badge-sameday sendkind-btn" data-idx="${idx}" title="클릭: 출고방식 변경">🚚 당일</span>`
      : p.send_kind === 1 ? `<span class="badge-sendkind badge-nextday sendkind-btn" data-idx="${idx}" title="클릭: 출고방식 변경">🌙 익일</span>`
      : `<span class="badge-sendkind sendkind-btn" data-idx="${idx}" title="클릭: 출고방식 변경" style="background:#f3f4f6;color:#9ca3af;font-size:9px;padding:1px 4px;">?</span>`
    }</td>
    <td style="text-align:center;padding:2px 3px;">${p.is_mine
        ? `<input type="text" class="inline-sendtime" data-idx="${idx}"
            value="${p.send_time || ""}" placeholder="15:00"
            style="width:44px;text-align:center;border:none;background:transparent;
            font-size:11px;font-family:inherit;cursor:pointer;"
            readonly title="클릭하여 이 상품만 출고기준시간 수정 (예: 15:00)">`
        : '<span style="color:#e5e7eb;font-size:9px;">-</span>'}</td>
    <td style="text-align:center;padding:2px 3px;">${p.is_mine
        ? `<span class="evensell-btn" data-idx="${idx}" title="클릭: 이 상품만 구매제한 여부 변경" style="cursor:pointer;font-size:10px;padding:1px 4px;border-radius:3px;background:${p._evensell===1?"#fef3c7":"#dcfce7"};color:${p._evensell===1?"#92400e":"#166534"};">${p._evensell===1?"🔒 짝수만":"🔓 제한없음"}</span>`
        : '<span style="color:#e5e7eb;font-size:9px;">-</span>'}</td>
  </tr>`;
  // HTML 캐시에 저장 + p에 현재 키 기록
  p._cacheKey = cacheKey;
  _rowCache.set(cacheKey, html);
  return html;
}

// tire_id → shownProducts 인덱스 맵 (refreshRow 빠른 조회용)
let tireIdxMap = {};

// 헤더 캐시 (필터/정렬 상태 변화 없으면 재렌더 안 함)
let _lastHeaderKey = "";

// 화면에 표시되는 "차이" 텍스트는 내부 _diff_val과 부호가 반대임
// (_diff_val<0 → 화면엔 "+N", _diff_val>0 → 화면엔 "-N" 로 표시됨 — 아래 8100번대 로직 참고)
// 사용자가 원하는 "화면상 차이 -10원"인 상품을 우선 배치하려면 내부값은 +10이어야 함
function _prioritizeDiffMinus10(arr) {
  let hasAny = false;
  const tiedGroup = [];   // 동가(단독 최저가) + 동률2등 — "차이" 값이 0인 것들, 최우선 표시
  const priority  = [];   // 화면상 "-10원, -20원, -30원..." (비최저가)
  const plusGroup = [];   // 화면상 "+10원, +20원, +30원..." (내가 더 쌈)
  const rest      = [];   // 그 외 (단독판매/미판매/품절 등 해당없음)
  for (const p of arr) {
    calcDerivedFields(p);
    // _diff_val===0 인 경우 "✅ 최저가"(단독, statusOrder 2)와 "⚠️ 동률N등"(statusOrder 15)
    // 둘 다 포함됨 — 이전엔 이 둘이 우선순위 없이 rest에 묻혀 맨 뒤로 밀려났음
    if (p._diff_val === 0) { tiedGroup.push(p); hasAny = true; }
    else if (typeof p._diff_val === "number" && p._diff_val > 0) { priority.push(p); hasAny = true; }
    else if (typeof p._diff_val === "number" && p._diff_val < 0) { plusGroup.push(p); hasAny = true; }
    else rest.push(p);
  }
  // 동가 그룹 내부 순서: 동가(단독 최저가, statusOrder 2) → 동률2등(statusOrder 15)
  tiedGroup.sort((a, b) => (a._statusOrder ?? 0) - (b._statusOrder ?? 0));
  // -10원 → -20원 → -30원 ... 순으로 오름차순 정렬
  priority.sort((a, b) => a._diff_val - b._diff_val);
  // +10원 → +20원 → +30원 ... 순으로 오름차순 정렬 (절대값 기준)
  plusGroup.sort((a, b) => Math.abs(a._diff_val) - Math.abs(b._diff_val));
  return hasAny ? tiedGroup.concat(priority, plusGroup, rest) : arr;
}

// ── 표(최저가봇) 표시 개수 제한 + "더보기" ─────────────────────
const TABLE_PAGE_SIZE = 500;
let _tableVisibleLimit = TABLE_PAGE_SIZE;

function renderTable(products, _onAfterPaint) {
  // 차이 -10 우선 재배치는 "정렬 미선택(기본 보기)" 상태에서만 적용
  // — 사용자가 마진/제조사 등 다른 컬럼으로 명시적으로 정렬했을 때 그 순서를 덮어쓰는 문제 방지
  if (sortCol === null) {
    products = _prioritizeDiffMinus10(products);
  }
  shownProducts = products;
  // checkedSet은 tire_id+dot 키 기반 — 인덱스 범위 필터 불필요
  tireIdxMap = {};
  // tire_id+dot 복합키만 사용 (같은 tire_id 다른 DOT 덮어쓰기 방지)
  products.forEach((p, i) => {
    if (p.tire_id) {
      tireIdxMap[`${p.tire_id}_${p.dot || ""}`] = i;
    }
  });

  // 헤더: 정렬/필터 상태 바뀔 때만 재렌더
  const thead = $("thead");
  const headerKey = sortCol + "|" + sortRev + "|" + Object.keys(filterState).sort().map(k => k + ":" + [...filterState[k]].sort().join(";")).join(",");
  if (headerKey !== _lastHeaderKey) {
    _lastHeaderKey = headerKey;
  thead.innerHTML = `<tr>${COLS.map(c => {
    const canSort    = c.key !== "chk"; // 체크박스 제외 모두 정렬 가능
    const isChk      = c.key === "chk";
    const sortCls    = sortCol === c.key ? (sortRev ? "sort-desc" : "sort-asc") : "";
    const hasFilter  = FILTERABLE.includes(c.key);
    const isFiltered = filterState[c.key] ? " style='color:#60a5fa'" : "";
    const filterBtn  = hasFilter
      ? `<span class="th-filter-btn"${isFiltered} data-col="${c.key}">▾</span>`
      : "";
    const title = isChk ? ' title="클릭: 전체 선택/해제"' : "";
    return `<th style="width:${c.w}px;min-width:${c.w}px;cursor:${(canSort||isChk)?"pointer":"default"};white-space:nowrap;padding:3px 2px;"
      class="${sortCls}" data-col="${c.key}"${title}>${c.label}${filterBtn}</th>`;
  }).join("")}</tr>`;

  } // end headerKey check

  // 헤더 이벤트 (매번 새로 바인딩 방지 - 한 번만)
  if (!thead._evBound) {
    thead._evBound = true;
  // th 클릭 → 정렬, ▾ 버튼 클릭 → 필터
  thead.addEventListener("click", e => {
    const btn = e.target.closest(".th-filter-btn");
    if (btn) {
      e.stopPropagation();
      const col = btn.dataset.col;
      const th  = btn.closest("th");
      showFilterPopup(col, th);
      return;
    }
    const th = e.target.closest("th");
    if (!th) return;
    const col = th.dataset.col;
    if (col === "chk") {
      // 체크 헤더 클릭 → 전체 선택/해제 토글 (이미 다 선택돼 있으면 전체 해제)
      const allChecked = shownProducts.length > 0 && shownProducts.every(p => checkedSet.has(_pKey(p)));
      if (allChecked) uncheckAll(); else checkAll();
      return;
    }
    if (col && col !== "chk") doSort(col);
  });
  // 우클릭도 유지
  thead.addEventListener("contextmenu", e => {
    e.preventDefault();
    const th = e.target.closest("th");
    if (!th) return;
    const col = th.dataset.col;
    if (FILTERABLE.includes(col)) showFilterPopup(col, th);
  });
  } // end !thead._evBound

  // 바디 렌더
  const tbody     = $("tbody");
  const tableWrap = $("table-wrap");
  const scrollTop  = tableWrap ? tableWrap.scrollTop  : 0;
  const scrollLeft = tableWrap ? tableWrap.scrollLeft : 0;

  // rAF 디바운스: 연속 호출 시 마지막 1회만 실행
  // (필터 연속 클릭, applyFilters 중복 호출 시 불필요한 DOM 재생성 방지)
  if (renderTable._rafId) cancelAnimationFrame(renderTable._rafId);
  renderTable._rafId = requestAnimationFrame(() => {
    renderTable._rafId = null;
    const existing = tbody.children;
    // 실제 DOM에는 _tableVisibleLimit 개수만큼만 그림 ("더보기" 클릭 시 늘어남)
    // shownProducts(체크박스/벌크액션 대상)는 위에서 이미 전체 products로 세팅되어 있음
    const visible = products.slice(0, _tableVisibleLimit);

    if (existing.length === visible.length) {
      // 행 수 같으면 변경된 행만 교체 (cacheKey diff)
      const tmp = document.createElement("tbody");
      for (let i = 0; i < visible.length; i++) {
        const p = visible[i];
        const existingKey = existing[i]?.dataset?.cacheKey;
        if (existingKey && p._cacheKey && existingKey === p._cacheKey) continue;
        tmp.innerHTML = calcRow(p, i);
        const newTr = tmp.firstElementChild;
        if (newTr) {
          if (p._cacheKey) newTr.dataset.cacheKey = p._cacheKey;
          existing[i].replaceWith(newTr);
        }
      }
    } else {
      // 행 수 다르면 전체 교체
      const table = tbody.closest("table");
      if (table) table.style.visibility = "hidden";
      const tmp2 = document.createElement("tbody");
      tmp2.innerHTML = visible.map((p, i) => calcRow(p, i)).join("");
      const rows = tmp2.children;
      for (let i = rows.length - 1; i >= 0; i--) {
        const tr = rows[i];
        const p = visible[parseInt(tr.dataset.idx, 10)];
        if (p?._cacheKey) tr.dataset.cacheKey = p._cacheKey;
      }
      const frag = document.createDocumentFragment();
      while (tmp2.firstChild) frag.appendChild(tmp2.firstChild);
      tbody.innerHTML = "";
      tbody.appendChild(frag);
      if (table) table.style.visibility = "";
    }

    // "더보기" 바 — 아직 안 보여준 개수가 있으면 표시
    const moreBar  = $("table-more-bar");
    const moreText = $("table-more-text");
    if (moreBar) {
      const remaining = products.length - _tableVisibleLimit;
      if (remaining > 0) {
        moreBar.style.display = "block";
        if (moreText) moreText.textContent = `${comma(_tableVisibleLimit)} / ${comma(products.length)}개 표시 중 (${comma(remaining)}개 더 있음)`;
      } else {
        moreBar.style.display = "none";
      }
    }

    if (tableWrap) {
      tableWrap.scrollTop  = scrollTop;
      tableWrap.scrollLeft = scrollLeft;
    }

    // _rowCache LRU: 3000개 초과 시 오래된 절반 일괄 삭제
    // (1500 → 3000으로 상향: 대형 검색 결과에서 매 렌더마다 트리거 방지)
    if (_rowCache.size > 3000) {
      const keys = [..._rowCache.keys()];
      const trim = keys.length >> 1; // 절반 삭제
      for (let _ri = 0; _ri < trim; _ri++) _rowCache.delete(keys[_ri]);
    }

    rerenderChecks();
    updateSummary(products);
    updateFilterLabel();
    if (typeof _onAfterPaint === "function") _onAfterPaint();
  });
}

function refreshRow(idxOrP) {
  // p 객체 또는 숫자 인덱스 모두 수용
  let p, idx;
  if (typeof idxOrP === "object" && idxOrP !== null) {
    p = idxOrP;
    idx = shownProducts.indexOf(p);
    if (idx === -1) return;
  } else {
    idx = idxOrP;
    p = shownProducts[idx];
    if (!p) return;
  }
  // 캐시 무효화
  if (p._cacheKey) {
    _rowCache.delete(p._cacheKey);
    p._cacheKey = "";
  } else if (p.tire_id) {
    for (const k of _rowCache.keys()) {
      if (k.startsWith(p.tire_id + "|")) { _rowCache.delete(k); break; }
    }
  }
  const tbody_r = $("tbody");
  const dot_r   = p.dot || "";
  const tr = tbody_r?.querySelector(
    `tr[data-tire-id="${CSS.escape(p.tire_id || "")}"][data-dot="${CSS.escape(dot_r)}"]`
  );
  if (!tr) return;
  const tmp = document.createElement("tbody");
  tmp.innerHTML = calcRow(p, idx);
  const newTr = tmp.firstElementChild;
  if (newTr) {
    if (p._cacheKey) newTr.dataset.cacheKey = p._cacheKey;
    tr.replaceWith(newTr);
  }
}

// tire_id 로 해당 행 즉시 갱신 + 필터 재적용
function refreshRowByTireId(tireId, dot) {
  // dot 복합키로 p 객체를 찾아서 refreshRow에 직접 전달
  // → tireIdxMap race condition 회피 (인덱스가 중간에 바뀌어도 p 객체로 재탐색)
  let idx = tireIdxMap[`${tireId}_${dot !== undefined ? (dot || "") : ""}`];
  if (idx === undefined) return;
  const p = shownProducts[idx];
  if (!p) return;

  // 필터가 없으면 행만 갱신 (p 객체 전달 → refreshRow가 최신 idx 재탐색)
  if (!_hasKeys(filterState) && !quickFilter) {
    refreshRow(p);
    updateSummary(shownProducts);
    return;
  }

  // 필터가 있으면: 상품 파생값 재계산 후 필터 통과 여부 확인
  // p는 이미 위에서 선언됨
  calcDerivedFields(p);

  const passesFilter = _matchesQuick(p, quickFilter) && Object.entries(filterState).every(([col, allowed]) => {
    const s = new Set([...(allowed instanceof Set ? allowed : new Set(allowed))].map(v => String(v)));
    const rawVal = getFilterVal(p, col);
    const val = (rawVal === null || rawVal === undefined) ? "" : String(rawVal);
    if (col === "DOT") return [...s].some(fv => (p.dot ? String(p.dot) : "").includes(fv));
    if (col === "경쟁판매점") return [...s].some(fv => val.replace(/\s+/g,"") === fv.replace(/\s+/g,""));
    return s.has(val);
  });

  if (passesFilter) {
    // 필터 통과 → p 객체로 갱신 (race condition 방지)
    refreshRow(p);
  } else {
    // 필터에서 벗어남 → 행 제거 + shownProducts/tireIdxMap에서 삭제
    const dot = p.dot || "";
    const tr = $("tbody").querySelector(
      `tr[data-tire-id="${CSS.escape(p.tire_id || "")}"][data-dot="${CSS.escape(dot)}"][data-idx]`
    );
    if (tr) tr.remove();
    shownProducts.splice(idx, 1);
    // tireIdxMap 재구성 (인덱스 밀림 보정) — 복합키만 사용
    tireIdxMap = {};
    shownProducts.forEach((sp, i) => {
      if (sp.tire_id) {
        tireIdxMap[`${sp.tire_id}_${sp.dot || ""}`] = i;
      }
    });

    // checkedSet은 키 기반 — 제거된 행의 키만 삭제
    const removedKey = _pKey(p);
    if (removedKey) checkedSet.delete(removedKey);
    // tbody 의 data-idx 도 갱신
    $("tbody").querySelectorAll("tr[data-idx]").forEach(tr2 => {
      const oldIdx = parseInt(tr2.dataset.idx, 10);
      if (oldIdx > idx) tr2.dataset.idx = oldIdx - 1;
    });
  }

  // 필터 캐시 무효화 (다음 applyFilters 때 정확히 재계산)
  _lastFilterKey = "";
  updateSummary(shownProducts);
}

function updateSummary(products) {
  // 단일 루프로 5개 카운터 동시 집계 (filter() 5회 → 1회 순회)
  const total = products.length;
  let mine = 0, soldout = 0, red = 0, tied = 0, noComp = 0;
  for (const p of products) {
    if (!p.is_mine) continue;
    mine++;
    if (p.my_stock === 0 || p.is_soldout) { soldout++; continue; }
    if (p.lowest_price === 0) { noComp++; continue; }
    if (p.my_price > p.lowest_price) { red++; continue; }
    if ((p.my_rank || 0) >= 2) tied++;
  }
  const active  = mine - soldout;
  const tiedStr = tied > 0 ? ` | ⚠️동률후순위 ${tied}개` : "";
  $("summary-text").textContent =
    `총 ${total}개 | 🔵판매 ${active}개 | 🔴품절 ${soldout}개 | ⬜미판매 ${total-mine}개 | ❌비최저가 ${red}개${tiedStr} | ✅최저가 ${active-red-tied-noComp}개`;
}

function updateFilterLabel() {
  const keys = Object.keys(filterState);
  const filterBar = $("filter-status");

  // 기존 태그 배지 제거 후 재생성
  filterBar.innerHTML = "";

  const hasAny = keys.length || quickFilter;

  if (hasAny) {
    // 컬럼별 배지: 클릭하면 해당 필터 팝업 열기, ✕ 누르면 해당 필터만 해제
    keys.forEach(k => {
      const badge = document.createElement("span");
      badge.className = "filter-badge";
      badge.title = `${k} 필터 수정`;
      badge.innerHTML =
        `<span class="fb-label">${k}(${filterState[k].size})</span>` +
        `<span class="fb-x" data-col="${k}" title="${k} 필터 해제">✕</span>`;
      // 배지 본문 클릭 → 해당 컬럼 팝업
      badge.querySelector(".fb-label").addEventListener("click", e => {
        e.stopPropagation();
        const th = document.querySelector(`thead th[data-col="${k}"]`);
        if (th) showFilterPopup(k, th);
        else {
          const fakeEl = { getBoundingClientRect: () => ({ bottom: 60, left: 100, left: 100 }) };
          showFilterPopup(k, fakeEl);
        }
      });
      // ✕ 클릭 → 해당 컬럼 필터만 삭제
      badge.querySelector(".fb-x").addEventListener("click", e => {
        e.stopPropagation();
        delete filterState[k];
        _lastFilterKey = "";
        applyFilters();
        updateFilterLabel();
      });
      filterBar.appendChild(badge);
    });

    // 결과 내 검색 배지
    if (quickFilter) {
      const badge = document.createElement("span");
      badge.className = "filter-badge";
      badge.title = "결과 내 검색 해제";
      badge.innerHTML =
        `<span class="fb-label">🔍 "${quickFilter}"</span>` +
        `<span class="fb-x" title="검색 해제">✕</span>`;
      badge.querySelector(".fb-x").addEventListener("click", e => {
        e.stopPropagation();
        quickFilter = "";
        const qi = $("inp-quick-filter"); if (qi) qi.value = "";
        _lastFilterKey = "";
        applyFilters();
        updateFilterLabel();
      });
      filterBar.appendChild(badge);
    }

    $("btn-clear-filter").style.visibility = "visible";
    $("btn-clear-filter").style.display = "inline-block";
  } else {
    const empty = document.createElement("span");
    empty.className = "filter-empty";
    empty.textContent = "필터 없음";
    filterBar.appendChild(empty);
    $("btn-clear-filter").style.visibility = "hidden";
    $("btn-clear-filter").style.display = "none";
  }
}

// ── 필터
function getFilterVal(p, col) {
  switch(col) {
    case "판매":     return p.is_mine ? "🔵 판매중" : "⬜ 미판매";
    case "제조사":   return p.manufacturer || "";
    case "제품명":   return p.product || "";
    case "사이즈":   return p.size || "";
    case "세부정보": return p.detail || "";
    case "DOT":      return p.dot || "";
    case "상태":     return p._status || (p.is_mine
                       ? (p.lowest_price > 0
                           ? (p.my_price <= p.lowest_price
                               ? ((p.my_rank || 0) >= 2 ? `⚠️ 동률${p.my_rank}등` : "✅ 최저가")
                               : "❌ 비최저가")
                           : (p._noCompData ? "➖ 정보없음" : "단독판매"))
                       : "⬜ 미판매");
    case "내DC율": {
      const dc = p.is_mine && p.dc_rate
        ? p.dc_rate
        : (p.factory_price && p.market_lowest
            ? calcDc(p.factory_price, p.market_lowest) : 0);
      if (!dc) return "-";
      if (dc >= 60) return "60%이상";
      if (dc >= 50) return "50~59%";
      if (dc >= 40) return "40~49%";
      if (dc >= 30) return "30~39%";
      if (dc >= 20) return "20~29%";
      return "20%미만";
    }
    case "차이": {
      // 미판매 or 단독판매는 해당없음
      if (!p.is_mine || p.lowest_price === 0) return "해당없음";
      const diff = p.my_price - p.lowest_price;
      if (diff === 0) return "±0 (최저가)";
      if (diff <= 0)  return "최저가";  // 내가 더 쌈
      // 비최저가 구간
      if (diff <= 10)   return "▲10원이하";
      if (diff <= 50)   return "▲11~50원";
      if (diff <= 100)  return "▲51~100원";
      if (diff <= 300)  return "▲101~300원";
      if (diff <= 1000) return "▲301~1000원";
      return "▲1000원초과";
    }
    case "액션": {
      if (!p.is_mine) return "📤 등록";
      if (p.my_stock === 0 || p.is_soldout) return "📦 재고입력";
      const my  = p.my_price  || 0;
      const low = p.lowest_price || 0;
      const sec = p.second_price || 0;
      if (low === 0 && sec === 0) return "✅ 최저가";
      const isLow = low > 0 ? my <= low : true;
      // 동률후순위: 가격은 최저가지만 순위 밀림
      if (isLow && (p.my_rank || 0) >= 2) return "⚠️ 동률후순위";
      const raiseBase = low > 0 ? low : sec;
      if (isLow && raiseBase > 0 && raiseBase - my > 10) return "↑ 2등 -10원";
      if (isLow) return "✅ 최저가";
      return "⬇ 최저가적용";
    }
    case "마진": {
      const m = calcMargin(p);
      if (m === null) return "해당없음";
      if (m < 0)     return "0원 미만(손해)";
      if (m === 0)   return "0원";
      if (m <= 500)  return "1~500원";
      if (m <= 1000) return "501~1000원";
      if (m <= 2000) return "1001~2000원";
      if (m <= 5000) return "2001~5000원";
      return "5000원 초과";
    }
    case "경쟁판매점": return p.lowest_seller || "";
    case "내순위": {
      if (!p.is_mine || p.my_stock === 0 || p.is_soldout) return "-";
      const r = p.my_rank || 0;
      if (r === 0) return "-";
      if (r === 1) return "1등";
      return `${r}등`;
    }
    // ↓ 이하 숫자 컬럼들 — 이전엔 case가 없어 항상 ""을 반환했고, 그 결과 필터 후보값이 하나도
    // 안 모여서(vals.length===0) ▾ 클릭 시 "필터할 값이 없습니다" 알럿만 뜨던 컬럼들
    case "공장도가":   return _priceBucket(p.factory_price);
    case "시장최저가": return _priceBucket(p.market_lowest);
    case "내판매가":   return _priceBucket(p.is_mine ? p.my_price : 0);
    case "경쟁최저가": return _priceBucket(p.lowest_price);
    case "2등가격": {
      const my = p.my_price || 0, low = p.lowest_price || 0, sec = p.second_price || 0;
      const v = p.second_overall || (p.is_mine && low > 0 && my > 0 && my <= low ? low : sec);
      return _priceBucket(v);
    }
    case "원가": {
      const c = calcCost(p);
      return (c === null || c === undefined) ? "해당없음" : _priceBucket(c);
    }
    case "택배": {
      const s = effectiveShippingCost(p) || 0;
      if (!s) return "-";
      if (s < 5000)  return "5천원 미만";
      if (s < 10000) return "5천~1만원";
      if (s < 15000) return "1~1.5만원";
      if (s < 20000) return "1.5~2만원";
      return "2만원 이상";
    }
    case "경쟁DC율": {
      const dc = (p.factory_price && p.lowest_price) ? calcDc(p.factory_price, p.lowest_price) : 0;
      if (!dc) return "-";
      if (dc >= 60) return "60%이상";
      if (dc >= 50) return "50~59%";
      if (dc >= 40) return "40~49%";
      if (dc >= 30) return "30~39%";
      if (dc >= 20) return "20~29%";
      return "20%미만";
    }
    case "내재고": {
      if (!p.is_mine) return "-";
      const v = p.my_stock || 0;
      if (v === 0) return "0(품절)";
      if (v <= 3)  return "1~3개";
      if (v <= 8)  return "4~8개";
      if (v <= 20) return "9~20개";
      return "21개 이상";
    }
    case "시장재고": {
      const v = p.market_stock || 0;
      if (v === 0)   return "0";
      if (v <= 10)   return "1~10개";
      if (v <= 30)   return "11~30개";
      if (v <= 100)  return "31~100개";
      return "101개 이상";
    }
    default: return "";
  }
}
// 가격류 컬럼(공장도가/시장최저가/내판매가/경쟁최저가/2등가격/원가) 공용 구간 버킷
function _priceBucket(v) {
  v = v || 0;
  if (!v) return "-";
  if (v < 100000) return "10만원 미만";
  if (v < 200000) return "10~20만원";
  if (v < 300000) return "20~30만원";
  if (v < 400000) return "30~40만원";
  if (v < 500000) return "40~50만원";
  return "50만원 이상";
}

// 액션바 우클릭 시 필터할 컬럼 선택 팝업
function showColumnFilterPicker(x, y) {
  document.querySelector(".filter-picker")?.remove();
  const filterable = ["판매","제조사","제품명","사이즈","세부정보","DOT","상태","DC율","차이"];
  const picker = document.createElement("div");
  picker.className = "filter-popup filter-picker";
  picker.style.cssText = `position:fixed;left:${x}px;top:${y}px;z-index:9999;`;
  picker.innerHTML = `<div class="fp-title">📋 필터 적용할 컬럼 선택</div>
    ${filterable.map(col => {
      const active = filterState[col] ? " style='font-weight:bold;color:#2563eb'" : "";
      return `<label${active} data-col="${col}" style="cursor:pointer;padding:3px 6px;display:block;border-radius:3px;"
>${col}${filterState[col] ? " 🔽" : ""}</label>`;
    }).join("")}`;

  picker.querySelectorAll("label[data-col]").forEach(lbl => {
    lbl.addEventListener("click", e => {
      e.stopPropagation();
      const col = lbl.dataset.col;
      picker.remove();
      // 해당 컬럼 헤더 th 를 찾아서 filterPopup 표시
      const th = document.querySelector(`#thead th[data-col="${col}"]`);
      if (th) showFilterPopup(col, th);
      else {
        // th 가 없으면 화면 중앙에 팝업
        const fakeEl = { getBoundingClientRect: () => ({ bottom: y, left: x }) };
        showFilterPopup(col, fakeEl);
      }
    });
  });

  document.body.appendChild(picker);
  setTimeout(() => document.addEventListener("click", () => picker.remove(), { once: true }), 50);
}

function showFilterPopup(colKey, thEl) {
  // 기존 팝업 모두 제거
  document.querySelectorAll(".filter-popup").forEach(el => el.remove());

  // popup 먼저 생성 (outsideClick에서 참조하므로)
  const popup = document.createElement("div");
  popup.className = "filter-popup";
  const rect   = thEl.getBoundingClientRect?.() || thEl;
  const popTop = rect.bottom ?? rect.top ?? 100;
  const popLeft = rect.left  ?? 100;
  popup.style.cssText = `position:fixed;left:${popLeft}px;top:${popTop}px;z-index:9999;
    background:white;border:1px solid #d1d5db;border-radius:6px;
    box-shadow:0 4px 12px rgba(0,0,0,0.15);min-width:160px;max-height:280px;overflow-y:auto;font-size:11px;`;

  // closePopup: apply/clear/outside 모든 경로에서 호출 → 리스너 중복 제거 방지
  let _popupClosed = false;
  const closePopup = () => {
    if (_popupClosed) return;
    _popupClosed = true;
    popup.remove();
    document.removeEventListener("click", outsideClick);
  };
  const outsideClick = e => {
    if (!popup.contains(e.target) && !e.target.closest(".th-filter-btn")) closePopup();
  };

  // 액션 컬럼: 고정 옵션
  if (colKey === "액션") {
    const fixedOpts = ["📤 등록", "📦 재고입력", "✅ 최저가", "⚠️ 동률후순위", "↑ 2등 -10원", "⬇ 최저가적용"];
    const curSet = filterState[colKey] instanceof Set ? filterState[colKey] : new Set();
    const optHtml = fixedOpts.map(v => {
      const checked = curSet.has(v) ? "checked" : "";
      return `<label style="display:block;padding:3px 8px;cursor:pointer;font-size:11px;">
        <input type="checkbox" value="${v}" ${checked}> ${v}</label>`;
    }).join("");
    popup.innerHTML = `<div style="font-weight:bold;padding:6px 8px;border-bottom:1px solid #e5e7eb;font-size:11px;">액션 필터</div>
      <div style="padding:4px 0;">${optHtml}</div>
      <div style="padding:6px 8px;border-top:1px solid #e5e7eb;display:flex;gap:4px;">
        <button class="btn-blue btn-sm fp-apply" style="flex:1;">적용</button>
        <button class="btn-gray btn-sm fp-clear" style="flex:1;">초기화</button>
      </div>`;
    popup.querySelector(".fp-apply").onclick = () => {
      const checked = [...popup.querySelectorAll("input:checked")].map(i => i.value);
      if (checked.length) filterState[colKey] = new Set(checked);
      else delete filterState[colKey];
      closePopup();
      applyFilters();
      updateFilterLabel();
    };
    popup.querySelector(".fp-clear").onclick = () => {
      delete filterState[colKey];
      closePopup();
      applyFilters();
      updateFilterLabel();
    };
    document.body.appendChild(popup);
    const pr = popup.getBoundingClientRect();
    if (pr.right > window.innerWidth) popup.style.left = Math.max(0, window.innerWidth - pr.width - 8) + "px";
    if (pr.bottom > window.innerHeight) popup.style.top = Math.max(0, popTop - pr.height - 4) + "px";
    setTimeout(() => document.addEventListener("click", outsideClick), 80);
    return;
  }

  // 경쟁판매점: 최저가 조회 후에만 의미있는 값 존재
  if (colKey === "경쟁판매점") {
    const sellers = [...new Set(
      (allProducts.length ? allProducts : shownProducts)
        .map(p => p.lowest_seller || "")
        .filter(s => s !== "")
    )].sort();
    if (!sellers.length) {
      popup.innerHTML = `<div style="padding:10px 12px;font-size:11px;color:#6b7280;">
        🔍 최저가 조회 후 사용 가능합니다<br><small>(🔃 가격새로고침 클릭 후 시도)</small></div>`;
      document.body.appendChild(popup);
      setTimeout(() => document.addEventListener("click", outsideClick), 80);
      return;
    }
    const curSet = filterState[colKey] instanceof Set ? filterState[colKey] : new Set();
    const optHtml = sellers.map(v => {
      const checked = curSet.has(v) ? "checked" : "";
      return `<label style="display:block;padding:3px 8px;cursor:pointer;font-size:11px;">
        <input type="checkbox" value="${v}" ${checked}> ${v}</label>`;
    }).join("");
    popup.innerHTML = `<div class="fp-title" style="font-weight:bold;padding:6px 8px;border-bottom:1px solid #e5e7eb;">판매점 필터</div>
      <input type="text" class="fp-search" placeholder="🔍 검색으로 좁히기..." autocomplete="off">
      <div style="padding:2px 8px;border-bottom:1px solid #f0f0f0;display:flex;gap:6px;">
        <button class="fp-selall" style="font-size:10px;color:#2563eb;background:none;border:none;cursor:pointer;padding:2px 0;">전체선택</button>
        <button class="fp-selno"  style="font-size:10px;color:#6b7280;background:none;border:none;cursor:pointer;padding:2px 0;">전체해제</button>
      </div>
      <div class="fp-list" style="padding:4px 0;max-height:200px;overflow-y:auto;">${optHtml}</div>
      <div style="padding:6px 8px;border-top:1px solid #e5e7eb;display:flex;gap:4px;">
        <button class="btn-blue btn-sm fp-apply" style="flex:1;">적용</button>
        <button class="btn-gray btn-sm fp-clear" style="flex:1;">초기화</button>
      </div>`;
    // ── 검색창: 판매점 목록 실시간 필터 ──
    const _slItems  = [...popup.querySelectorAll(".fp-list label")];
    const _slSearch = popup.querySelector(".fp-search");
    const _slVis    = () => _slItems.filter(l => l.style.display !== "none");
    _slSearch.addEventListener("input", () => {
      const q = _slSearch.value.trim().toLowerCase();
      for (const lbl of _slItems) {
        const txt = (lbl.querySelector("input")?.value || "").toLowerCase();
        lbl.style.display = (!q || txt.includes(q)) ? "" : "none";
      }
    });
    _slSearch.addEventListener("keydown", e => { if (e.key === "Enter") popup.querySelector(".fp-apply")?.click(); });
    setTimeout(() => _slSearch.focus(), 0);
    popup.querySelector(".fp-selall").onclick = () => {
      _slVis().forEach(l => { const i = l.querySelector("input"); if (i) i.checked = true; });
    };
    popup.querySelector(".fp-selno").onclick = () => {
      _slVis().forEach(l => { const i = l.querySelector("input"); if (i) i.checked = false; });
    };
    popup.querySelector(".fp-apply").onclick = () => {
      const checked = [...popup.querySelectorAll("input:checked")].map(i => i.value);
      if (checked.length) filterState[colKey] = new Set(checked);
      else delete filterState[colKey];
      closePopup();
      applyFilters();
      updateFilterLabel();
    };
    popup.querySelector(".fp-clear").onclick = () => {
      delete filterState[colKey];
      closePopup();
      applyFilters();
      updateFilterLabel();
    };
    document.body.appendChild(popup);
    setTimeout(() => document.addEventListener("click", outsideClick), 80);
    return;
  }

  // 필터 값 수집: allProducts 없으면 shownProducts 사용
  // _status 등 파생값이 세팅돼 있어야 정확한 값 목록이 나옴
  // 구간형(버킷) 컬럼은 알파벳순 정렬이 아니라 논리적인 순서를 따로 정의함
  // (예: "1~500원"이 "1001~2000원"보다 알파벳상 뒤로 밀리는 문제 방지)
  const _priceBucketOrder = ["-", "10만원 미만", "10~20만원", "20~30만원", "30~40만원", "40~50만원", "50만원 이상"];
  const _FILTER_ORDER = {
    "마진":   ["해당없음", "0원 미만(손해)", "0원", "1~500원", "501~1000원", "1001~2000원", "2001~5000원", "5000원 초과"],
    "내DC율": ["-", "20%미만", "20~29%", "30~39%", "40~49%", "50~59%", "60%이상"],
    "차이":   ["±0 (최저가)", "최저가", "▲10원이하", "▲11~50원", "▲51~100원", "▲101~300원", "▲301~1000원", "▲1000원초과", "해당없음"],
    "내순위": ["-", "1등", "2등", "3등", "4등", "5등"],
    // ↓ 이번에 필터를 새로 살린 숫자 컬럼들 — 구간 순서대로 정렬되도록
    "공장도가":   _priceBucketOrder,
    "시장최저가": _priceBucketOrder,
    "내판매가":   _priceBucketOrder,
    "경쟁최저가": _priceBucketOrder,
    "2등가격":    _priceBucketOrder,
    "원가":       ["해당없음", ..._priceBucketOrder.slice(1)],
    "택배":       ["-", "5천원 미만", "5천~1만원", "1~1.5만원", "1.5~2만원", "2만원 이상"],
    "경쟁DC율":   ["-", "20%미만", "20~29%", "30~39%", "40~49%", "50~59%", "60%이상"],
    "내재고":     ["-", "0(품절)", "1~3개", "4~8개", "9~20개", "21개 이상"],
    "시장재고":   ["0", "1~10개", "11~30개", "31~100개", "101개 이상"],
  };
  const source = allProducts.length ? allProducts : shownProducts;
  source.forEach(p => calcDerivedFields(p));
  const _rawVals = [...new Set(source.map(p => String(getFilterVal(p, colKey) ?? "")))].filter(Boolean);
  const _order = _FILTER_ORDER[colKey];
  const vals = _order
    ? _rawVals.sort((a, b) => {
        const ia = _order.indexOf(a), ib = _order.indexOf(b);
        if (ia === -1 && ib === -1) return a.localeCompare(b, "ko");
        if (ia === -1) return 1;  // 정의 안 된 값은 뒤로
        if (ib === -1) return -1;
        return ia - ib;
      })
    : _rawVals.sort((a, b) => a.localeCompare(b, "ko"));
  if (!vals.length) { alert(`[${colKey}] 필터할 값이 없습니다`); return; }

  // 현재 필터 상태 — filterState[colKey]는 Set이므로 안전하게 변환
  const curSet = filterState[colKey] instanceof Set
    ? filterState[colKey]
    : new Set(vals);  // 필터 없으면 전체 선택 상태

  popup.className = "filter-popup";

  // 팝업 위치: position:fixed 기준 (viewport 상대) — scrollY/X 불필요
  let top = 0, left = 0;
  if (thEl && typeof thEl.getBoundingClientRect === "function") {
    const rect = thEl.getBoundingClientRect();
    top  = rect.bottom; // fixed: viewport 기준이므로 scroll 오프셋 없음
    left = rect.left;
  }
  popup.style.cssText = `position:fixed;top:${top}px;left:${left}px;z-index:9999;`;

  // 체크박스 목록 생성
  const itemsHtml = vals.map(v => {
    const checked = curSet.has(v) ? "checked" : "";
    return `<label class="fp-item"><input type="checkbox" value="${v}" ${checked}><span>${v}</span></label>`;
  }).join("");

  popup.innerHTML = `
    <div class="fp-title">🔽 ${colKey} 필터</div>
    <input type="text" class="fp-search" placeholder="🔍 검색으로 좁히기..." autocomplete="off">
    <div class="fp-items">${itemsHtml}</div>
    <div class="fp-btns">
      <button class="btn-gray fp-all">전체선택</button>
      <button class="btn-gray fp-none">전체해제</button>
      <button class="btn-blue fp-apply">✅ 적용</button>
      <button class="btn-gray fp-clear">초기화</button>
    </div>`;

  const allInputs = () => popup.querySelectorAll(".fp-items input[type=checkbox]");
  // ── 검색창: 입력값으로 옵션 목록 실시간 필터 (엑셀 필터 검색처럼) ──
  const _fpItems   = [...popup.querySelectorAll(".fp-item")];
  const _fpSearch  = popup.querySelector(".fp-search");
  const _visItems  = () => _fpItems.filter(l => l.style.display !== "none");
  const _applyFpSearch = () => {
    const q = _fpSearch.value.trim().toLowerCase();
    for (const lbl of _fpItems) {
      const txt = (lbl.querySelector("input")?.value || "").toLowerCase();
      lbl.style.display = (!q || txt.includes(q)) ? "" : "none";
    }
  };
  _fpSearch.addEventListener("input", _applyFpSearch);
  // Enter → 현재 검색결과만 보이는 상태에서 적용 편의
  _fpSearch.addEventListener("keydown", e => { if (e.key === "Enter") popup.querySelector(".fp-apply")?.click(); });

  // 전체선택: 검색으로 "보이는" 항목 선택 / 전체해제: 전부 해제
  // → "이 사이즈만 보기" 흐름: 전체해제 → 검색 → 전체선택 → 적용
  popup.querySelector(".fp-all").onclick  = () => _visItems().forEach(l => { const i = l.querySelector("input"); if (i) i.checked = true; });
  popup.querySelector(".fp-none").onclick = () => _fpItems.forEach(l => { const i = l.querySelector("input"); if (i) i.checked = false; });

  popup.querySelector(".fp-apply").onclick = () => {
    const selected = [...allInputs()].filter(i => i.checked).map(i => i.value);
    if (selected.length === vals.length || selected.length === 0) {
      delete filterState[colKey];
    } else {
      filterState[colKey] = new Set(selected);
    }
    closePopup();
    applyFilters();
    updateFilterLabel();
    if (colKey === "제조사") _updatePriceMfrTabs(); // 헤더 필터로 걸어도 빠른필터 바 활성상태 동기화
  };

  popup.querySelector(".fp-clear").onclick = () => {
    delete filterState[colKey];
    closePopup();
    applyFilters();
    updateFilterLabel();
    if (colKey === "제조사") _updatePriceMfrTabs();
  };

  document.body.appendChild(popup);
  // 검색창 자동 포커스 (엑셀처럼 바로 타이핑 가능)
  setTimeout(() => _fpSearch?.focus(), 0);

  // 화면 밖 보정 (requestAnimationFrame으로 실제 크기 측정 후 보정)
  requestAnimationFrame(() => {
    const pr = popup.getBoundingClientRect();
    if (pr.right > window.innerWidth)
      popup.style.left = Math.max(0, window.innerWidth - pr.width - 8) + "px";
    if (pr.bottom > window.innerHeight)
      popup.style.top = Math.max(0, popTop - pr.height - 4) + "px";
    if (pr.left < 0)
      popup.style.left = "4px";
  });

  // 팝업 외부 클릭 시 닫기
  setTimeout(() => document.addEventListener("click", outsideClick), 80);
}

let _lastFilterKey = "";
let _lastFilterResult = [];

function applyFilters(_afterRender) {
  // 필터/정렬 상태 키 — allProducts 상태도 포함해서 데이터 변경 시 자동 무효화
  let _fHash = sortCol + "|" + sortRev + "|" + allProducts.length + "|q:" + quickFilter;
  for (const k in filterState) { _fHash += "|" + k + ":" + [...filterState[k]].join(","); }

  // checksum: allProducts 참조 또는 합산이 바뀔 때만 재계산
  // 합산 자체도 체크섬으로 관리해 calcDerivedFields 순회 여부를 결정
  let needDerive = false;
  if (applyFilters._ref !== allProducts) {
    applyFilters._ref = allProducts;
    needDerive = true;
    let _cs = 0;
    for (let _i = 0; _i < allProducts.length; _i++) {
      const _p = allProducts[_i];
      _cs += (_p.my_price||0) + (_p.my_rank||0) + (_p.my_stock||0) + (_p.lowest_price||0);
    }
    applyFilters._cs = _cs;
  } else {
    // 동일 배열 참조 → 빠른 합산으로 변화 감지
    let _cs2 = 0;
    for (let _i = 0; _i < allProducts.length; _i++) {
      const _p = allProducts[_i];
      _cs2 += (_p.my_price||0) + (_p.my_rank||0) + (_p.my_stock||0) + (_p.lowest_price||0);
    }
    if (_cs2 !== applyFilters._cs) { applyFilters._cs = _cs2; needDerive = true; }
  }

  const fKey = _fHash + "|" + applyFilters._cs;
  if (fKey === _lastFilterKey) {
    // 완전 동일 → renderTable만 호출 (calcDerivedFields 순회 없음)
    renderTable(_lastFilterResult, _afterRender);
    return;
  }

  // 데이터가 바뀐 경우에만 파생값 재계산 (상태/액션 필터 매칭에 필요)
  if (needDerive) {
    for (let _i = 0; _i < allProducts.length; _i++) calcDerivedFields(allProducts[_i]);
  }
  let filtered = [...allProducts];

  // 기존 컬럼 필터
  if (_hasKeys(filterState)) {
    filtered = filtered.filter(p =>
      Object.entries(filterState).every(([col, allowed]) => {
        // Set 내 값을 모두 문자열로 정규화 (숫자/문자열 타입 불일치 방지)
        const s = new Set([...(allowed instanceof Set ? allowed : new Set(allowed))].map(v => String(v)));
        const rawVal = getFilterVal(p, col);
        const val = (rawVal === null || rawVal === undefined) ? "" : String(rawVal);

        // DOT: 포함 매칭 ("2층 이월 2024" → "2024" 필터에 걸림)
        if (col === "DOT") {
          // dot 없으면 빈 문자열로 처리 (임의로 "2026" 가정하지 않음)
          const dotStr = p.dot ? String(p.dot) : "";
          if (!dotStr) return false; // dot 정보 없으면 DOT 필터 대상 제외
          return [...s].some(filterVal => dotStr.includes(filterVal));
        }

        // 경쟁판매점: 공백 제거 후 완전 일치
        if (col === "경쟁판매점") {
          const normVal = val.replace(/\s+/g, "");
          return [...s].some(filterVal => normVal === filterVal.replace(/\s+/g, ""));
        }

        return s.has(val);
      })
    );
  }

  // 결과 내 검색 (전역 텍스트 필터) — 컬럼 필터와 AND로 결합
  if (quickFilter) {
    filtered = filtered.filter(p => _matchesQuick(p, quickFilter));
  }

  // 빈 결과도 fKey로 캐싱 — 반복 호출(자동갱신 등)마다 전체 순회 재실행 방지
  // (빈 결과 자체가 올바른 필터 결과이므로 캐시에 저장)
  _lastFilterKey    = fKey;
  _lastFilterResult = filtered;
  // 필터/정렬이 실제로 바뀐 경우에만 500개부터 다시 표시
  // (자동갱신 중 가격만 바뀌는 경우는 스크롤 위치 유지를 위해 리셋하지 않음)
  if (!_refreshRunning) _tableVisibleLimit = TABLE_PAGE_SIZE;
  renderTable(filtered, _afterRender);
  updateFilterLabel();
}

// ── 파생값 사전 계산 (정렬/필터 전에 항상 호출)
// p._statusOrder, p._diff_val 을 미리 세팅해두어야 정렬이 정확함
function recalc(p) { p._derivedKey = ""; calcDerivedFields(p); }
function calcDerivedFields(p) {
  // 입력값 변화 없으면 재계산 스킵
  const _ck = `${p.my_price}|${p.lowest_price}|${p.second_price}|${p.my_stock}|${p.is_mine}|${p.is_soldout}|${p.my_rank}`;
  if (p._derivedKey === _ck) return;
  p._derivedKey = _ck;
  const my  = p.my_price   || 0;
  const low = p.lowest_price || 0;
  const sec = p.second_price || 0;

  if (p.is_mine && (p.my_stock === 0 || p.is_soldout)) {
    p._statusOrder = 0;
    p._status      = "🔴 품절";
    p._diff_val    = null;
  } else if (p.is_mine && low > 0) {
    const isLow = my <= low;
    if (isLow && p.my_rank >= 2) {
      // 가격은 최저가(동률)인데 순위가 2등 이상으로 밀림
      p._statusOrder = 15;  // 비최저가(1)와 최저가(2) 사이
      p._status      = `⚠️ 동률${p.my_rank}등`;
      p._diff_val    = 0;
    } else {
      p._statusOrder   = isLow ? 2 : 1;
      p._status        = isLow ? "✅ 최저가" : "❌ 비최저가";
      p._diff_val      = my - low;
    }
  } else if (p.is_mine) {
    p._statusOrder   = 3;
    p._status        = p._noCompData ? "➖ 정보없음" : "단독판매";
    p._diff_val      = null;
  } else {
    p._statusOrder   = 4;
    p._status        = "⬜ 미판매";
    p._diff_val      = null;
  }
}

// ── 정렬
function getSortVal(p, sortKey) {
  switch(sortKey) {
    case "is_mine":      return p.is_mine ? 0 : 1;          // 판매중 먼저
    case "fav":          return isFav(p) ? 0 : 1;            // 즐겨찾기 먼저
    case "manufacturer": return p.manufacturer || "";
    case "product":      return p.product || "";
    case "size":         return p.size || "";
    case "dot":          return p.dot || "";
    case "factory_price":return p.factory_price || 0;
    case "market_lowest":return p.market_lowest || 0;
    case "market_stock": return p.market_stock || 0;
    case "my_price":     return p.my_price || 0;
    case "dc_rate":      return p.is_mine
                           ? (p.dc_rate || 0)
                           : (p.factory_price && p.market_lowest
                               ? calcDc(p.factory_price, p.market_lowest) : 0);
    case "cost":          return calcCost(p) ?? -1;
    case "shipping":      return effectiveShippingCost(p) || 0;
    case "margin":        return calcMargin(p) ?? -Infinity;
    case "lowest_price": return p.lowest_price || 0;
    case "second_price": return p.second_price || 0;
    case "diff":
      // 실제 정렬은 doSort의 커스텀 comparator가 담당
      return p._diff_val ?? 999999;
    case "my_stock":     return p.my_stock || 0;
    case "status_order": return p._statusOrder ?? 9;
    case "comp_dc":      return (p.factory_price && p.lowest_price) ? calcDc(p.factory_price, p.lowest_price) : 0;
    case "detail":       return p.detail || p.sub_info || "";
    case "lowest_seller":return p.lowest_seller || "";
    case "send_kind_order": return p.send_kind === 0 ? 0 : p.send_kind === 1 ? 1 : p.is_mine ? 2 : 3;
    case "send_time":     return p.send_time || "";
    case "my_rank":      return p.my_rank || 99;  // 순위 없으면 맨 뒤
    case "action_order": {
      if (!p.is_mine) return 4;
      if (p.my_stock === 0 || p.is_soldout) return 3;
      const _low = p.lowest_price || 0, _my = p.my_price || 0;
      const _isLow = _low > 0 ? _my <= _low : true;
      // 동률후순위: 비최저가(0)와 올리기(1) 사이로 배치
      if (_isLow && (p.my_rank || 0) >= 2) return 0.5;
      const _rb = _low > 0 ? _low : (p.second_price || 0);
      if (_isLow && _rb > 0 && _rb - _my > 10) return 1;
      if (_isLow) return 2;
      return 0;
    }
    // ↓ 예전엔 COLS에 sort:undefined 라 여기 case가 아예 없었고, 그 결과 아래로 떨어져
    // default:0을 반환 → 두 행 다 0이라 비교식이 항상 0이 되어 클릭해도 순서가 안 바뀌던 컬럼들
    case "tomorrow_gap": return p._tomorrowGap ?? 999999; // 내일출고 정보 없으면 맨 뒤
    case "evensell":     return p._evensell === 1 ? 0 : 1; // 짝수구매만 먼저
    case "event_low_gap":
      return (p._eventLow > 0 && (p.my_price || 0) > p._eventLow)
        ? ((p.my_price || 0) - p._eventLow) : -1; // 조정 필요없는 상품은 맨 뒤
    default:             return 0;
  }
}

function doSort(colKey) {
  if (colKey === "chk") return;
  const col = COLS.find(c => c.key === colKey);
  sortRev = sortCol === colKey ? !sortRev : false;
  sortCol = colKey;
  const sortKey = col?.sort || colKey;
  _tableVisibleLimit = TABLE_PAGE_SIZE; // 정렬 바뀌면 500개부터 다시 표시

  // checkedSet은 키 기반이므로 정렬 후 재매핑 불필요
  const sorted = [...shownProducts].sort((a, b) => {
    // 차이 컬럼 전용
    if (sortKey === "diff") {
      // _diff_val 기준으로 정렬 (화면 표시와 동일한 부호 체계)
      // 양수 = 비최저가(내가 더 비쌈), 음수 = 내가 더 쌈, 0 = 동가, null = 해당없음
      calcDerivedFields(a); calcDerivedFields(b);
      const da = a._diff_val ?? null;
      const db = b._diff_val ?? null;
      // null(미판매·단독·품절)은 항상 맨 아래
      if (da === null && db === null) return 0;
      if (da === null) return 1;
      if (db === null) return -1;
      // 오름차순: 비최저가 차이 큰 것 먼저(+큰것→위), 내림차순: 최저가 여유 큰 것 먼저
      return sortRev ? db - da : da - db;
    }

    // 마진 컬럼 전용 — 해당없음(내 상품 아님/원가 미확인 등)은 정렬 방향과 무관하게 항상 맨 아래
    if (sortKey === "margin") {
      const ma = calcMargin(a);
      const mb = calcMargin(b);
      if (ma === null && mb === null) return 0;
      if (ma === null) return 1;
      if (mb === null) return -1;
      return sortRev ? mb - ma : ma - mb;
    }

    // 일반 컬럼
    const av = getSortVal(a, sortKey);
    const bv = getSortVal(b, sortKey);
    if (typeof av === "string") {
      const cmp = av.localeCompare(bv, "ko");
      return sortRev ? -cmp : cmp;
    }
    return sortRev ? bv - av : av - bv;
  });

  renderTable(sorted);
}

// ── 체크박스
function toggleCheck(idx) {
  const key = _idxKey(idx);
  if (!key) return;
  if (checkedSet.has(key)) checkedSet.delete(key);
  else checkedSet.add(key);
  _anchorState  = checkedSet.has(key);
  _lastShiftKey = key;
  rerenderChecks();
}

function checkAll()     { shownProducts.forEach((p) => { const k=_pKey(p); if(k) checkedSet.add(k); }); rerenderChecks(); }
function uncheckAll()   { checkedSet.clear();                                    rerenderChecks(); }
function checkNotLow()  {
  checkedSet.clear();
  shownProducts.forEach((p) => {
    if (p.is_mine && p.lowest_price > 0 && p.my_stock > 0 &&
        (p.my_price > p.lowest_price || (p.my_price <= p.lowest_price && (p.my_rank || 0) >= 2))) {
      const k = _pKey(p); if (k) checkedSet.add(k);
    }
  });
  rerenderChecks();
}
function checkNotMine() {
  checkedSet.clear();
  shownProducts.forEach((p) => { if (!p.is_mine) { const k=_pKey(p); if(k) checkedSet.add(k); } });
  rerenderChecks();
}
function checkSoldout() {
  checkedSet.clear();
  shownProducts.forEach((p) => { if (p.is_mine && p.my_stock === 0) { const k=_pKey(p); if(k) checkedSet.add(k); } });
  rerenderChecks();
}
function rerenderChecks() {
  // tire_id+dot 키 기반 → DOM의 data-idx 불일치와 완전히 무관
  const tbody = $("tbody");
  if (!tbody) return;
  const rows = tbody.querySelectorAll("tr[data-tire-id]");
  for (const tr of rows) {
    const key = `${tr.dataset.tireId || ""}_${tr.dataset.dot || ""}`;
    const td  = tr.querySelector("td.chk-cell");
    if (td) td.classList.toggle("checked", checkedSet.has(key));
  }
}

// HTML 특수문자 이스케이프 (innerHTML에 사용자/외부 데이터 삽입 시 사용)
function escHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ── 가격 변경
// 재고 수량 + 가격 입력 팝업
function showStockInputPopup(p, idx) {
  document.querySelectorAll(".stock-input-popup").forEach(el => el.remove());

  const factory   = p.factory_price || 0;
  const curPrice  = p.my_price  || 0;
  const curDc     = p.dc_rate   || (factory && curPrice ? calcDc(factory, curPrice) : 0);
  const curStock  = p.my_stock  || 0;
  const lowPrice  = p.lowest_price || 0;

  // 권장 가격: 경쟁최저가 - 10원
  const suggestPrice = lowPrice > 0 ? lowPrice - 10 : curPrice;
  const suggestDc    = factory && suggestPrice
    ? (100 - suggestPrice * 100 / factory).toFixed(1) : curDc;

  const popup = document.createElement("div");
  popup.className = "stock-input-popup filter-popup";
  popup.style.cssText = `position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);
    z-index:9999;min-width:260px;padding:0;`;

  popup.innerHTML = `
    <div class="fp-title">📦 재고 입력 — ${escHtml(p.product)} ${escHtml(p.size)}</div>
    <div style="padding:10px 12px;">
      <div style="font-size:11px;color:#6b7280;margin-bottom:10px;">
        공장도가: <b>${comma(factory)}원</b>
        ${lowPrice > 0 ? ` | 경쟁최저: <b style="color:#dc2626">${comma(lowPrice)}원</b>` : ""}
      </div>

      <table style="width:100%;font-size:12px;border-collapse:collapse;">
        <tr>
          <td style="padding:4px 0;color:#374151;width:60px;">재고수량</td>
          <td>
            <input type="number" id="si-stock" value="${curStock}" min="0"
              style="width:70px;border:1px solid #d1d5db;border-radius:4px;
              padding:3px 6px;font-size:12px;font-family:inherit;">
            <span style="font-size:11px;color:#6b7280;margin-left:4px;">개</span>
          </td>
        </tr>
        <tr>
          <td style="padding:4px 0;color:#374151;">판매가</td>
          <td>
            <input type="number" id="si-price" value="${curPrice}" min="0" step="10"
              style="width:90px;border:1px solid #d1d5db;border-radius:4px;
              padding:3px 6px;font-size:12px;font-family:inherit;">
            <span style="font-size:11px;color:#6b7280;margin-left:4px;">원</span>
          </td>
        </tr>
        <tr>
          <td style="padding:4px 0;color:#374151;">DC율</td>
          <td>
            <input type="number" id="si-dc" value="${curDc}" min="0" max="100" step="0.1"
              style="width:70px;border:1px solid #d1d5db;border-radius:4px;
              padding:3px 6px;font-size:12px;font-family:inherit;">
            <span style="font-size:11px;color:#6b7280;margin-left:4px;">%</span>
          </td>
        </tr>
      </table>

      ${lowPrice > 0 ? `
      <div style="margin-top:8px;">
        <button id="si-btn-suggest" style="font-size:11px;background:#fef2f2;
          border:1px solid #fca5a5;color:#dc2626;border-radius:4px;
          padding:3px 10px;cursor:pointer;width:100%;">
          ⬇ 최저가 적용 (${comma(suggestPrice)}원 / DC ${suggestDc}%)
        </button>
      </div>` : ""}
    </div>

    <div class="fp-btns">
      <button class="btn-blue" id="si-ok">저장</button>
      <button class="btn-gray" id="si-cancel">취소</button>
    </div>`;

  document.body.appendChild(popup);

  const siStock = () => document.getElementById("si-stock");
  const siPrice = () => document.getElementById("si-price");
  const siDc    = () => document.getElementById("si-dc");

  // 가격 ↔ DC율 연동
  document.getElementById("si-price").oninput = () => {
    if (!factory) return;
    const price = parseInt(siPrice().value, 10) || 0;
    siDc().value = price ? (100 - price * 100 / factory).toFixed(1) : "";
  };
  document.getElementById("si-dc").oninput = () => {
    if (!factory) return;
    const dc = parseFloat(siDc().value) || 0;
    let v = factory * (100 - dc);
    v = Math.ceil(v / 100) / 100 * 100;
    siPrice().value = Math.floor(v);
  };

  // 최저가 적용 버튼
  document.getElementById("si-btn-suggest")?.addEventListener("click", () => {
    siPrice().value = suggestPrice;
    siDc().value    = suggestDc;
  });

  // 포커스
  setTimeout(() => { siStock()?.focus(); siStock()?.select(); }, 50);

  document.getElementById("si-cancel").onclick = () => popup.remove();
  document.getElementById("si-ok").onclick = async () => {
    const newStock = parseInt(siStock().value, 10);
    const newPrice = parseInt(siPrice().value, 10);
    if (isNaN(newStock) || newStock < 0) { alert("올바른 수량을 입력하세요"); return; }
    if (isNaN(newPrice) || newPrice <= 0) { alert("올바른 판매가를 입력하세요"); return; }
    popup.remove();
    // 가격도 변경된 경우 p.my_price 업데이트
    if (newPrice !== p.my_price) {
      p.my_price = newPrice;
      p.dc_rate  = parseFloat(siDc().value) || p.dc_rate;
    }
    await changeStock(p, idx, newStock);
  };

  // Enter 키
  popup.addEventListener("keydown", e => {
    if (e.key === "Enter") document.getElementById("si-ok").click();
    if (e.key === "Escape") popup.remove();
  });
}

// 재고만 변경 (가격 유지)
async function changeStock(p, idx, newStock) {
  st(`⏳ ${p.product} ${p.size} 재고 변경 중...`);

  // 판매가가 없으면 저장 불가 → 알림
  if (!p.my_price || p.my_price === 0) {
    alert(`판매가가 설정되지 않은 상품입니다.\n먼저 판매가를 입력해주세요.`);
    return;
  }

  const wasSoldout = p.my_stock === 0 || p.is_soldout;

  let res;
  if (wasSoldout && newStock > 0) {
    // 품절 상태 → 재고 입력: update 페이지 통해 품절 완전 해제
    st(`⏳ ${p.product} ${p.size} 품절 해제 중...`);
    res = await clearSoldout(p.pid, p.my_price, newStock);
  } else {
    res = await savePrice(p.pid, p.my_price, newStock);
  }

  if (res.ok) {
    p.my_stock   = newStock;
    p.is_soldout = false;

    if (wasSoldout && newStock > 0) {
      st(`🔎 ${p.product} ${p.size} 경쟁가 확인 중...`);
      clearLowestCache(p.tire_id, p.dot);
      const [low, sec, mlow, seller, rank] = await fetchOneLowest(p);
      p.lowest_price = low || p.lowest_price; p.second_price = sec || p.second_price; p.market_lowest = mlow;
      p.lowest_seller = seller || ""; p.my_rank = rank || 0;
    }

    calcDerivedFields(p);
    refreshRowByTireId(p.tire_id, p.dot);
    updateSummary(shownProducts);

    const statusMsg = newStock === 0 ? "🔴 품절" :
      (p.lowest_price > 0 && p.my_price <= p.lowest_price ? "✅ 최저가" :
      p.lowest_price > 0 ? "❌ 비최저가" : "단독판매");
    st(`✅ ${p.product} ${p.size} 재고 ${newStock}개 → ${statusMsg}`);
  } else {
    st(`❌ 재고/품절 변경 실패: ${res.msg}`);
  }
}

// 행에 저장 버튼 추가 (미저장 상태 표시)
const unsavedRows = new Set();
function markRowUnsaved(tr, idx) {
  if (!tr || unsavedRows.has(idx)) return;
  unsavedRows.add(idx);
  // 액션 셀에 저장 버튼 추가
  const actionTd = tr.querySelector(".btn-cell");
  if (actionTd && !actionTd.querySelector(".btn-save-price")) {
    const btn = document.createElement("button");
    btn.className = "btn-blue btn-save-price";
    btn.dataset.idx = idx;
    btn.style.cssText = "font-size:10px;padding:2px 6px;margin-left:2px;";
    btn.textContent = "💾저장";
    btn.onclick = () => saveCellPrice(idx);
    actionTd.appendChild(btn);
  }
}

async function saveCellPrice(idx) {
  const p = shownProducts[idx];
  if (!p?.pid) return;
  const newPrice = p._edit_price;
  if (!newPrice || newPrice === p.my_price) return;

  st(`⏳ ${p.product} ${p.size} 저장 중...`);
  const res = await savePrice(p.pid, newPrice, p.my_stock);
  if (res.ok) {
    p.my_price = newPrice;
    p.dc_rate  = calcDc(p.factory_price, newPrice);
    delete p._edit_price;
    unsavedRows.delete(idx);
    // 캐시 삭제 후 경쟁가 재조회
    // 내 가격 즉시 반영
    calcDerivedFields(p);
    refreshRowByTireId(p.tire_id, p.dot);
    st(`⏳ ${p.product} ${p.size} → ${comma(newPrice)}원 저장됨 (시장가 조회 중...)`);
    // 경쟁가 재조회 후 갱신
    clearLowestCache(p.tire_id, p.dot);
    const [low, sec, mlow, , rank] = await fetchOneLowest(p);
    p.lowest_price = low || p.lowest_price; p.second_price = sec || p.second_price; p.market_lowest = mlow; p.my_rank = rank || 0;
    recalc(p);
    refreshRowByTireId(p.tire_id, p.dot);
    st(`✅ ${p.product} ${p.size} → ${comma(newPrice)}원 저장 완료 (${p._status})`);
  } else {
    st(`❌ 저장 실패: ${res.msg}`);
  }
}

async function changePrice(p, idx, target) {
  st(`⏳ ${p.product} ${p.size} 변경 중...`);
  const res = await savePrice(p.pid, target, p.my_stock);
  if (res.ok) {
    // ① 내 가격 즉시 반영 → 화면 바로 페인팅
    p.my_price = target;
    p.dc_rate  = calcDc(p.factory_price, target);
    // lowest_price/second_price는 유지한 채 상태만 재계산
    p._derivedKey = ""; // 강제 재계산
    calcDerivedFields(p);
    refreshRowByTireId(p.tire_id, p.dot);
    st(`⏳ ${p.product} ${p.size} → ${comma(target)}원 (시장가 조회 중...)`);

    // ② 경쟁가 재조회 후 추가 갱신 (await로 직렬화, 캐시 무효화 보장)
    clearLowestCache(p.tire_id, p.dot);
    const [low, sec, mlow, seller, rank, allSec, todayOnly, tomorrowLow, tomorrowGap, tomorrowSeller] = await fetchOneLowest(p);
    p.lowest_price   = low || p.lowest_price;
    p.second_price   = sec || p.second_price;
    p.second_overall = allSec || p.second_overall || 0;
    p.market_lowest  = mlow;
    p.lowest_seller  = seller || p.lowest_seller || "";
    p.my_rank        = rank || 0;
    p._todayOnlyMode = !!todayOnly;
    p._tomorrowLow   = tomorrowLow || 0;
    p._tomorrowGap   = tomorrowGap || 0;
    p._tomorrowSeller= tomorrowSeller || "";
    recalc(p);
    refreshRowByTireId(p.tire_id, p.dot);
    st(`✅ ${p.product} ${p.size} → ${comma(target)}원 (${p._status})`);
  } else {
    st(`❌ 저장 실패: ${res.msg}`);
  }
}

// ── 벌크 공통 실행 엔진
// 1단계: savePrice 5개 병렬  2단계: fetchOneLowest 8개 병렬
// 기존 직렬+sleep(300) 대비 50개 기준 65초 → ~10초
const _SAVE_BATCH   = 5;
const _LOWEST_BATCH = 8;

async function runBulkChange(targets, calcTarget, actionName) {
  if (!targets.length) return;
  loading(true, `0/${targets.length} 변경 중...`);
  lockBulkBtns();
  let failed = 0;
  const saved = [];

  try {
    // 1단계: savePrice 병렬 (5개씩)
    for (let i = 0; i < targets.length; i += _SAVE_BATCH) {
      const batch = targets.slice(i, i + _SAVE_BATCH);
      await Promise.all(batch.map(async ({ p }) => {
        const target = calcTarget(p);
        if (!target || target <= 0) { failed++; return; }
        const res = await savePrice(p.pid, target, p.my_stock);
        if (res.ok) {
          p.my_price    = target;
          p.dc_rate     = calcDc(p.factory_price, target);
            recalc(p);
          refreshRowByTireId(p.tire_id, p.dot);
          clearLowestCache(p.tire_id, p.dot);
          saved.push(p);
          // tireping_cache에도 반영 (재검색 시 구가격 방지)
          if (_memCache) {
            const ck = `${p.tire_id}_${p.dot || ""}`;
            if (_memCache[ck]) _memCache[ck].my_price = target;
          }
        } else {
          failed++;
          console.warn("[벌크 실패] " + p.product + " " + p.size + " pid=" + p.pid + " msg=" + (res.msg||""));
        }
      }));
      $("loading-msg").textContent =
        `저장 ${Math.min(i + _SAVE_BATCH, targets.length)}/${targets.length}...`;
    }

    // 2단계: fetchOneLowest 병렬 (8개씩)
    let doneL = 0;
    for (let i = 0; i < saved.length; i += _LOWEST_BATCH) {
      const batch = saved.slice(i, i + _LOWEST_BATCH);
      await Promise.all(batch.map(async p => {
        const [low, sec, mlow,, rank, allSec] = await fetchOneLowest(p);
        p.lowest_price   = low || p.lowest_price;
        p.second_price   = sec || p.second_price;
        p.second_overall = allSec || 0;
        p.market_lowest  = mlow;
        p.my_rank        = rank || 0;
        recalc(p);
        refreshRowByTireId(p.tire_id, p.dot);
        doneL++;
      }));
      $("loading-msg").textContent =
        `최저가 확인 ${Math.min(i + _LOWEST_BATCH, saved.length)}/${saved.length}...`;
    }

    const okN = targets.length - failed;
    // 변경된 가격을 tireping_cache에 저장 (재검색 시 구가격 표시 방지)
    if (_memCache && saved.length > 0) saveCache(_memCache);
    st(`✅ ${actionName} ${okN}개 완료${failed ? ` (${failed}개 실패)` : ""}`);
  } catch(e) {
    st(`❌ ${actionName} 중 오류: ${e.message}`);
    console.error(e);
  } finally {
    loading(false);
    unlockBulkBtns();
    checkedSet.clear();
    rerenderChecks();
  }
}

// ── 벌크 액션 실행 중 버튼 잠금/해제
const BULK_BTNS = [
  "btn-bulk-low","btn-bulk-raise","btn-bulk-third","btn-bulk-fourth",
  "btn-refresh-now","btn-bulk-upload","btn-auto",
  "btn-bulk-sameday","btn-bulk-nextday","btn-bulk-biz","btn-bulk-sendtime","btn-bulk-margin","btn-bulk-dot","btn-bulk-dc",
  "btn-check-all","btn-uncheck-all"
];
function lockBulkBtns()   { BULK_BTNS.forEach(id => { const b=$(id); if(b) b.disabled=true;  }); }
function unlockBulkBtns() { BULK_BTNS.forEach(id => { const b=$(id); if(b) b.disabled=false; }); }
// ── 목표 마진에 맞는 판매가 역산 ─────────────────────────────
// margin = price - cost - fee(price*수수료율) - ship  →  price에 대해 근사 후 10원 단위로 보정
function calcPriceForTargetMargin(p, targetMargin) {
  const cost = calcCost(p);
  if (cost === null) return null; // 마진탭 매칭 없어 원가 계산 불가
  const ship = effectiveShippingCost(p) || 0;
  let price = Math.round((targetMargin + cost + ship) / (1 - feeRatePct / 100) / 10) * 10;
  if (price <= 0) return null;
  // 수수료 반올림 오차 보정: 실제 마진이 목표에 못 미치면 10원씩 올려서 재확인 (최대 20회)
  for (let i = 0; i < 20; i++) {
    const fee = Math.round(price * feeRatePct / 100);
    const margin = price - cost - fee - ship;
    if (margin >= targetMargin) break;
    price += 10;
  }
  return price;
}

async function bulkMargin() {
  console.log("[마진적용] 버튼 클릭됨, 체크된 항목:", checkedSet.size);
  const raw = $("inp-target-margin").value.trim();
  if (raw === "") { console.warn("[마진적용] 목표마진 미입력"); alert("목표 마진(원)을 입력하세요."); return; }
  const targetMargin = parseInt(raw, 10);
  if (isNaN(targetMargin)) { console.warn("[마진적용] 잘못된 마진값:", raw); alert("올바른 마진 금액을 입력하세요."); return; }

  const targets = [...checkedSet].map(k => { const i = _keyIdx(k); return { p: shownProducts[i], i }; })
    .filter(({ p }) => p?.is_mine && p.pid && p.my_stock > 0 && !p.is_soldout);
  if (!targets.length) { console.warn("[마진적용] 적용 가능한 항목 없음 (체크된 것 중 내 상품/재고 있는 것 없음)"); alert("적용 가능한 항목 없음\n(재고 있는 내 판매상품을 선택하세요)"); return; }

  // 원가 계산 불가(마진탭 매칭 없음) 상품은 미리 걸러서 안내
  const skipped = targets.filter(({ p }) => calcPriceForTargetMargin(p, targetMargin) === null);
  const usable  = targets.filter(({ p }) => calcPriceForTargetMargin(p, targetMargin) !== null);
  console.log(`[마진적용] 대상 ${targets.length}개 중 계산가능 ${usable.length}개, 제외 ${skipped.length}개`);
  if (!usable.length) { alert("원가를 계산할 수 없는 상품뿐입니다.\n(마진탭에 매칭되는 규칙이 없거나 공장도가 정보가 없습니다)"); return; }

  const skipMsg = skipped.length ? `\n※ ${skipped.length}개는 원가 계산 불가로 제외됨` : "";
  if (!confirm(`선택한 ${usable.length}개 상품의 마진을 ${comma(targetMargin)}원에 맞춰 가격을 변경할까요?${skipMsg}`)) return;

  await runBulkChange(usable, p => calcPriceForTargetMargin(p, targetMargin), `마진 ${comma(targetMargin)}원 적용`);
}

// ── 목표 내DC%에 맞는 판매가 역산 (인라인 DC 입력과 동일한 반올림 방식)
function calcPriceForTargetDC(p, dcPct) {
  if (!p.factory_price) return null;
  let v = p.factory_price * (100 - dcPct);
  v = Math.ceil(v / 100) / 100 * 100;
  const price = Math.floor(v);
  return price > 0 ? price : null;
}

async function bulkDC() {
  console.log("[DC%일괄적용] 버튼 클릭됨, 체크된 항목:", checkedSet.size);
  const raw = $("inp-bulk-dc").value.trim();
  if (raw === "") { alert("내DC%를 입력하세요."); return; }
  const dcPct = parseFloat(raw);
  if (isNaN(dcPct) || dcPct < 0 || dcPct >= 100) { alert("올바른 DC%를 입력하세요 (0~99)."); return; }

  const targets = [...checkedSet].map(k => { const i = _keyIdx(k); return { p: shownProducts[i], i }; })
    .filter(({ p }) => p?.is_mine && p.pid && p.my_stock > 0 && !p.is_soldout);
  if (!targets.length) { alert("적용 가능한 항목 없음\n(재고 있는 내 판매상품을 선택하세요)"); return; }

  const skipped = targets.filter(({ p }) => calcPriceForTargetDC(p, dcPct) === null);
  const usable  = targets.filter(({ p }) => calcPriceForTargetDC(p, dcPct) !== null);
  if (!usable.length) { alert("공장도가 정보가 없는 상품뿐입니다."); return; }

  const skipMsg = skipped.length ? `\n※ ${skipped.length}개는 공장도가 없어 제외됨` : "";
  if (!confirm(`선택한 ${usable.length}개 상품의 판매가를 내DC% ${dcPct}%에 맞춰 변경할까요?${skipMsg}`)) return;

  await runBulkChange(usable, p => calcPriceForTargetDC(p, dcPct), `내DC% ${dcPct}% 적용`);
}

// ── DOT 일괄적용 (선택한 내 상품들의 DOT을 한꺼번에 변경)
async function bulkDot() {
  console.log("[DOT일괄적용] 버튼 클릭됨, 체크된 항목:", checkedSet.size);
  const raw = $("inp-bulk-dot").value.trim();
  const dot = _normDot(raw);
  if (!dot) { alert("DOT은 4자리 연도로 입력하세요 (예: 2024)."); return; }

  const targets = [...checkedSet].map(k => { const i = _keyIdx(k); return { p: shownProducts[i], i }; })
    .filter(({ p }) => p?.is_mine && p.pid);
  if (!targets.length) { alert("적용 가능한 항목 없음\n(내 판매상품을 선택하세요)"); return; }

  if (!confirm(`선택한 ${targets.length}개 상품의 DOT을 [${dot}]로 변경할까요?`)) return;

  loading(true, `0/${targets.length} DOT 변경 중...`); lockBulkBtns();
  let success = 0;
  try {
    for (let i = 0; i < targets.length; i++) {
      const { p } = targets[i];
      $("loading-msg").textContent = `[${i+1}/${targets.length}] ${p.product} ${p.size}`;
      const oldDot = p.dot;
      await saveDotOverride(p, dot);
      p.dot = dot;
      if (p._cacheKey) { _rowCache.delete(p._cacheKey); p._cacheKey = ""; }
      refreshRowByTireId(p.tire_id, oldDot);
      success++;
    }
    st(`✅ DOT 일괄적용 완료 (${success}/${targets.length}개)`);
  } catch(e) {
    st(`❌ DOT 일괄적용 중 오류: ${e.message}`);
  } finally {
    loading(false); unlockBulkBtns(); checkedSet.clear(); rerenderChecks();
  }
}

// ── 일괄 가격 변경
async function bulkLow() {
  const targets = [...checkedSet].map(k => { const i=_keyIdx(k); return { p: shownProducts[i], i }; })
    .filter(({p}) => p?.is_mine && p.pid && p.my_stock > 0 && !p.is_soldout && p.lowest_price > 0 &&
      (p.my_price > p.lowest_price || (p.my_price <= p.lowest_price && (p.my_rank||0) >= 2)));
  if (!targets.length) { alert("최저가 적용 가능한 항목 없음\n(비최저가 또는 동률후순위 상품을 선택하세요)"); return; }
  if (!confirm(`${targets.length}개를 최저가-10원으로 변경할까요?`)) return;
  await runBulkChange(targets, p => p.lowest_price - 10, "최저가 적용");
}

async function bulkRaise() {
  const targets = [...checkedSet].map(k => { const i=_keyIdx(k); return { p: shownProducts[i], i }; })
    .filter(({p}) => {
      if (!p?.is_mine || !p.pid || p.my_stock === 0 || p.is_soldout) return false;
      const raiseBase = p.lowest_price > 0 ? p.lowest_price : p.second_price;
      return raiseBase > 0 && p.my_price <= p.lowest_price && raiseBase - p.my_price > 10;
    });
  if (!targets.length) { alert("올리기 가능한 항목 없음\n(최저가이고 경쟁사1등과 10원 이상 차이나는 재고있는 상품)"); return; }
  if (!confirm(`${targets.length}개를 경쟁사1등-10원으로 변경할까요?`)) return;
  await runBulkChange(targets,
    p => (p.lowest_price > 0 ? p.lowest_price : p.second_price) - 10, "2등 -10원");
}

async function bulkThirdMinus10() {
  const targets = [...checkedSet].map(k => { const i=_keyIdx(k); return { p: shownProducts[i], i }; })
    .filter(({p}) => p?.is_mine && p.pid && p.my_stock > 0 && !p.is_soldout
      && p.my_price <= p.lowest_price && p.second_price > 0 && p.second_price - p.my_price > 10);
  if (!targets.length) { alert("3등 -10원 적용 가능한 항목 없음\n(최저가이고 경쟁사2등과 10원 이상 차이나는 재고있는 상품)"); return; }
  if (!confirm(`${targets.length}개를 경쟁사2등-10원으로 변경할까요?`)) return;
  await runBulkChange(targets, p => p.second_price - 10, "3등 -10원");
}

async function bulkFourthMinus10() {
  // second_overall: fetchOneLowest에서 수집한 전체(내 포함) 2등 가격
  // second_price:   경쟁사 기준 2등 가격 (내 행 제외)
  // 4등 기준 = second_overall(전체 2위) 이 가장 근사값. 없으면 second_price 폴백
  const targets = [...checkedSet].map(k => { const i=_keyIdx(k); return { p: shownProducts[i], i }; })
    .filter(({p}) => {
      if (!p?.is_mine || !p.pid || p.my_stock === 0 || p.is_soldout) return false;
      if (p.my_price > p.lowest_price) return false; // 이미 최저가가 아님
      const base4 = p.second_overall > 0 ? p.second_overall : p.second_price;
      return base4 > 0 && base4 - p.my_price > 10;
    });
  if (!targets.length) { alert("4등 -10원 적용 가능한 항목 없음\n(최저가이고 전체2위 가격과 10원 이상 차이나는 재고있는 상품)"); return; }
  if (!confirm(`${targets.length}개를 전체2위가격-10원으로 변경할까요?`)) return;
  await runBulkChange(targets, p => {
    const base4 = p.second_overall > 0 ? p.second_overall : p.second_price;
    return base4 - 10;
  }, "4등 -10원");
}

// ── 가격 새로고침 (내 판매가/재고 + 경쟁최저가 + 2등가격 동시 갱신)
let _refreshRunning = false; // 중복 실행 방지

async function refreshLowest() {
  if (_refreshRunning) { st("⚠️ 이미 새로고침 중입니다..."); return; }
  if (!allProducts.length) {
    st(viewMode === "fav" ? "⚠️ 즐겨찾기가 없습니다" : "⚠️ 먼저 검색해주세요");
    return;
  }
  // 입력창 포커스 중이면 갱신 스킵 (입력값 날아가는 현상 방지)
  const focused = document.activeElement;
  if (focused && (focused.tagName === "INPUT" || focused.tagName === "TEXTAREA") && focused.closest("tbody")) {
    st("⚠️ 입력 중 - 완료 후 새로고침 됩니다");
    return;
  }

  // ── 즐겨찾기 보기: 내 상품 재조회 없이 즐겨찾기들의 경쟁사 최저가만 실시간 갱신
  if (viewMode === "fav") {
    _refreshRunning = true;
    $("btn-refresh-now").disabled = true;
    window._lowestCache = new Map();
    _rowCache.clear();
    try {
      const favs = Object.values(favData);
      st(`🔃 즐겨찾기 ${favs.length}개 경쟁가 새로고침...`);
      await fetchLowestAll(favs, st);
      favs.forEach(calcDerivedFields);
      syncFavSnapshots(favs);             // 갱신된 값 저장
      allProducts = Object.values(favData);
      _lastFilterKey = ""; applyFilters._ref = null;
      applyFilters();
      st(`✅ 즐겨찾기 ${favs.length}개 경쟁가 갱신 완료`);
    } catch(e) {
      console.warn("[즐겨찾기 새로고침]", e);
      st("⚠️ 즐겨찾기 새로고침 실패");
    } finally {
      _refreshRunning = false;
      $("btn-refresh-now").disabled = false;
    }
    return;
  }

  _refreshRunning = true;
  $("btn-refresh-now").disabled = true;
  lockBulkBtns(); // 자동갱신 중 벌크 버튼 비활성화
  window._lowestCache = new Map();
  _rowCache.clear();
  // _lastFilterKey 초기화 제거 — 자동갱신은 개별 행(refreshRowByTireId)만 갱신
  // applyFilters 전체 재실행 불필요 (가격 변동만 반영하면 됨)

  // ── race condition 방지: 시작 시 allProducts 스냅샷
  // doSearch 완료로 allProducts가 교체돼도 이 참조는 유지됨
  const _refreshSnap = allProducts;

  // ── 1단계: 내 판매상품 재조회 (가격/재고 변동 감지)
  // 현재 검색 필터 그대로 재사용해서 빠르게 수집
  st("🔃 내 판매상품 재조회 중...");
  try {
    const sizeText = $("inp-size")?.value.trim() || "";
    const search   = sizeText.replace(/\s/g, "");
    const company  = $("sel-mfr").value || "0";
    const pattern  = $("sel-prod").value || "0";
    const dot      = $("sel-dot").value;
    const rDot     = (dot && dot !== "DOT") ? dot : "0";
    // 내 판매상품 재조회도 검색한 사이즈로 좁힘 (자동갱신/가격새로고침 가속)
    const _rsz     = _getSellSizeParams();
    // DOT 선택 시: 전체(dot=0) 먼저 → 캐시 적중으로 정확DOT 패스 거의 무료
    const _rbase = { search: "", company, pattern,
                     width: _rsz.width, height: _rsz.height, inch: _rsz.inch };
    let myMap;
    if (rDot === "0") {
      myMap = await fetchMyProducts(null, { ..._rbase, dot: "0" });
    } else {
      const rMyMapAll = await fetchMyProducts(null, { ..._rbase, dot: "0" });
      const rMyMapDot = await fetchMyProducts(null, { ..._rbase, dot: rDot });
      myMap = { ...rMyMapAll, ...rMyMapDot };
    }

    // doSearch 완료로 allProducts 교체됐으면 1단계 결과 폐기
    if (allProducts !== _refreshSnap) {
      console.log("[refreshLowest] 검색 완료로 allProducts 교체됨 — 1단계 결과 폐기");
    } else {
      let myChanged = 0;
      for (const p of _refreshSnap) {
        // _normDot 적용으로 키 불일치 방지 (버그2 수정)
        const dotNorm = _normDot(p.dot);
        const key = dotNorm ? `${p.tire_id}_${dotNorm}` : p.tire_id;
        const info = myMap[key] || myMap[p.tire_id];
        if (p.is_mine && info) {
          if (info.my_price !== p.my_price || info.my_stock !== p.my_stock) {
            p.my_price = info.my_price;
            p.my_stock = info.my_stock;
            p.dc_rate  = info.dc_rate;
            myChanged++;
            refreshRowByTireId(p.tire_id, p.dot);
          }
        } else if (!p.is_mine && info) {
          // 새로 내 판매상품이 된 경우
          p.pid = info.pid; p.my_price = info.my_price;
          p.my_stock = info.my_stock; p.dc_rate = info.dc_rate;
          p.factory_price = info.factory_price || p.factory_price;
          p.is_mine    = true;
          p.is_soldout = info.is_soldout || false;
          myChanged++;
          refreshRowByTireId(p.tire_id, p.dot);
        }
      }
      if (myChanged > 0) st(`🔃 내 판매상품 ${myChanged}개 변동 감지`);
    }
  } catch(e) {
    console.warn("내 판매상품 재조회 실패:", e);
  }

  // ── 2단계: 경쟁사 최저가 재조회
  // allProducts가 교체됐으면 새 배열 기준으로 진행
  const mine = allProducts.filter(p => p.is_mine);
  if (!mine.length) {
    _refreshRunning = false;
    $("btn-refresh-now").disabled = false;
    unlockBulkBtns();
    st("⚠️ 내 판매 상품 없음");
    return;
  }

  try {
    let done = 0;
    // 배치 크기 12로 증가 (refreshLowest는 로딩 오버레이 없이 백그라운드 실행)
    for (let i = 0; i < mine.length; i += 12) {
      const batch = mine.slice(i, i + 12);
      const batchChanged = [];
    await Promise.all(batch.map(async p => {
        const [low, sec, mlow, seller, rank, allSec] = await fetchOneLowest(p);
        const changed = low !== p.lowest_price || sec !== p.second_price || allSec !== (p.second_overall||0) || mlow !== p.market_lowest || rank !== p.my_rank;
        p.lowest_price  = low;
        p.second_price  = sec || p.second_price;
        p.second_overall = allSec || 0;
        p.market_lowest = mlow;
        p.lowest_seller = seller || p.lowest_seller || "";
        p.my_rank       = rank || 0;
        calcDerivedFields(p);
        done++;
        st(`🔃 가격 새로고침 [${done}/${mine.length}] (최저가·2등가격 갱신 중...)`);
        if (changed) batchChanged.push(p); // DOM 조작은 배치 완료 후 순차적으로
      }));
    // 배치 완료 후 변경된 행만 순차 갱신 (병렬 DOM 조작 방지)
    batchChanged.forEach(p => refreshRowByTireId(p.tire_id, p.dot));
    // 경쟁사 가격 변동 통계 기록 (시간대별 분석용)
    }
    updateSummary(shownProducts);
    st(`✅ 가격 새로고침 완료 (${new Date().toLocaleTimeString()}) — ${mine.length}개 (최저가·2등가격·내가격 갱신)`);
  } catch(e) {
    st(`❌ 새로고침 중 오류: ${e.message}`);
    console.error(e);
  } finally {
    _refreshRunning = false;
    $("btn-refresh-now").disabled = false;
    unlockBulkBtns();

  }
}

// ── 자동갱신
let autoIntervalTimer = null;

// 자동갱신 상태 텍스트를 헤더 span + 탭 내 span 둘 다 갱신
function setAutoStatus(txt) {
  const el1 = $("auto-status");
  const el2 = $("auto-status-header");
  if (el1) el1.textContent = txt;
  if (el2) el2.textContent = txt;
}

async function toggleAuto() {
  if (autoRefreshing) {
    autoRefreshing = false;
    if (autoIntervalTimer) { clearInterval(autoIntervalTimer); autoIntervalTimer = null; }
    // 드롭다운 change 리스너 제거
    const _h = $("sel-interval")._autoChangeHandler;
    if (_h) { $("sel-interval").removeEventListener("change", _h); delete $("sel-interval")._autoChangeHandler; }
    $("btn-auto").textContent = "▶ 자동갱신";
    $("btn-auto").className   = "btn-sky";
    setAutoStatus("");
    st("자동갱신 중지");
  } else {
    if (autoIntervalTimer) { clearInterval(autoIntervalTimer); autoIntervalTimer = null; }
    if (!allProducts.length) { alert("먼저 검색해주세요"); return; }
    autoRefreshing = true;
    $("btn-auto").textContent = "⏹ 갱신중지";
    $("btn-auto").className   = "btn-red";
    const mins = parseInt($("sel-interval").value, 10) || 5;
    const getIntervalMs = () => (parseInt($("sel-interval").value, 10) || 5) * 60 * 1000;
    let nextFireAt = Date.now() + getIntervalMs();
    const tick = () => {
      const remaining = Math.max(0, nextFireAt - Date.now());
      // 사이드바가 숨겨진 상태(다른 탭 활성)에서는 DOM 업데이트 생략
      // → 불필요한 레이아웃 계산·페인트 비용 제거
      if (!document.hidden) {
        const m = Math.floor(remaining / 60000), s = Math.floor((remaining % 60000) / 1000);
        setAutoStatus(`⏱ ${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`);
      }
      if (remaining <= 0) {
        nextFireAt = Date.now() + getIntervalMs();
        if (!_refreshRunning) refreshLowest();
      }
    };
    const _onIntervalChange = () => { nextFireAt = Date.now() + getIntervalMs(); };
    $("sel-interval").addEventListener("change", _onIntervalChange);
    $("sel-interval")._autoChangeHandler = _onIntervalChange;
    autoIntervalTimer = setInterval(tick, 1000);
    st(`자동갱신 시작 (${mins}분 간격)`);
  }
}

// ── 상품 업로드 (등록)
function buildInsertJS(p, maxDc, stock) {
  let sellPrice = p.lowest_price > 0 ? p.lowest_price - 10
    : p.market_lowest > 0 ? p.market_lowest - 10 : 0;

  if (maxDc !== null && p.factory_price > 0 && sellPrice > 0) {
    const dcOfBase = (p.factory_price - sellPrice) / p.factory_price * 100;
    if (dcOfBase > maxDc) {
      sellPrice = Math.floor(p.factory_price * (1 - maxDc / 100) / 10) * 10;
    }
  }

  const mfr     = p.manufacturer.replace(/'/g, "\\'");
  const product = p.product.replace(/'/g, "\\'");
  const tire_id = p.tire_id;
  const dot     = p.dot;
  // 메모: #inp-memo 입력란이 있으면 그 값을, 없으면 기본값 사용
  const _memoEl = document.getElementById("inp-memo");
  const memo    = (_memoEl?.value?.trim()) || "이월 및 계절상품 취소불가";
  // 짝수출고 구매제한없음 토글 버튼 상태 (체크 해제시 짝수구매만 가능으로 등록)
  const evenNoLimit = $("btn-even-nolimit") ? $("btn-even-nolimit").dataset.on === "1" : true;
  const evensellVal = evenNoLimit ? "0" : "1";
  // 출고 기준시간 (툴바에서 지정한 시:분)
  const sendHour = $("sel-send-hour")?.value || "15";
  const sendMin  = $("sel-send-min")?.value  || "00";

  const js = `
(async function(){
  function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }
  // 조건이 참이 될 때까지 폴링 (사이트 자체의 비동기 처리가 끝나기를 기다림 — 경쟁상태 방지)
  async function waitUntil(fn, maxMs, stepMs){
    var deadline = Date.now() + maxMs;
    while(Date.now() < deadline){
      try{ if(fn()) return true; }catch(e){}
      await sleep(stepMs||100);
    }
    return false;
  }
  window.__tireping_done = false;
  window.__tireping_fail_reason = "";
  // 폼 채우기가 중간에 실패하면 이유를 남기고 즉시 중단 (content.js가 이 사유를 읽어
  // 사용자에게 보여주고, 빈/불완전한 폼으로 저장하기를 누르지 않도록 함)
  function fail(msg){ console.error('❌ '+msg); window.__tireping_fail_reason = msg; }

  // STEP1: 제조사 선택 (사이트 자체 onChange가 트리거되어 #pattern을 재구성함)
  var sc = $('#company')[0]&&$('#company')[0].selectize;
  if(!sc){ fail('제조사 선택박스를 찾지 못했습니다 (사이트 구조 변경 가능성)'); return; }
  var compVal=null;
  for(var k in sc.options){
    var optText=sc.options[k].text&&sc.options[k].text.trim();
    if(optText==='${mfr}'){compVal=String(sc.options[k].value);break;}
    if(!compVal&&optText&&(optText.indexOf('${mfr}')!==-1||'${mfr}'.indexOf(optText)!==-1)){compVal=String(sc.options[k].value);}
  }
  if(!compVal){ fail('제조사 못찾음: ${mfr}'); return; }
  sc.setValue(compVal);

  // STEP2: #pattern이 사이트에 의해 재생성되고 옵션이 채워질 때까지 대기
  //        (별도로 /ajax/tire/pattern/ 을 또 호출하지 않음 — 사이트 자체 요청과 경쟁해서
  //         나중에 사이트가 pattern selectize를 destroy&재생성하며 우리가 세팅한 값이
  //         사라지는 문제가 있었음. 이제 사이트가 다 채운 뒤에만 선택함.)
  var patternReady = await waitUntil(function(){
    var sc2x = $('#pattern')[0] && $('#pattern')[0].selectize;
    return sc2x && Object.keys(sc2x.options||{}).length > 0;
  }, 6000, 100);
  if(!patternReady){ fail('품명 목록 로딩 대기 타임아웃 (제조사: ${mfr})'); return; }

  var sc2 = $('#pattern')[0].selectize;
  var patVal=null;
  for(var k2 in sc2.options){
    var optText2 = sc2.options[k2].text && sc2.options[k2].text.trim();
    if(optText2==='${product}'){ patVal=String(sc2.options[k2].value); break; }
    if(!patVal && optText2 && optText2.indexOf('${product}')!==-1){ patVal=String(sc2.options[k2].value); }
  }
  if(!patVal){ fail('품명 못찾음: ${product}'); return; }
  sc2.setValue(patVal);

  // STEP3: pattern 선택 시 사이트가 자체적으로 _pattern을 로드하고 drawTire()로
  //        후보 목록을 그림 — 그 목록에 원하는 tire_id 항목(#divTr{id})이 나타날 때까지 대기 후 선택
  //        (여기서도 /ajax/tire/ajaxpage/ 를 별도로 또 부르지 않음 — 위와 같은 이유)
  var tireReady = await waitUntil(function(){
    return $('#divTr${tire_id}').length > 0;
  }, 6000, 100);
  var selId = null;
  if (tireReady) {
    selId = ${tire_id};
  } else {
    // 폴백: 검색 시점에 캐시된 tire_id가 오래돼(사이트 쪽 후보 구성이 그새 바뀌어) 정확히 일치하는
    // 후보를 못 찾는 경우 — 화면에 실제로 그려진 후보 카드들 중 목표 DOT(생산년도) 문자열이
    // 포함된 카드를 찾아 대신 선택. id 값 자체는 바뀌었어도 화면에 보이는 DOT 표시는 유효하다는 전제.
    await waitUntil(function(){ return document.querySelectorAll('[id^="divTr"]').length > 0; }, 6000, 100);
    var cands = [].slice.call(document.querySelectorAll('[id^="divTr"]'));
    var dotWanted = '${dot}';
    var byDot = dotWanted ? cands.filter(function(el){ return el.textContent.indexOf(dotWanted) !== -1; }) : [];
    var pick = byDot.length === 1 ? byDot[0] : (cands.length === 1 ? cands[0] : null);
    if (pick) {
      selId = parseInt(pick.id.replace('divTr',''), 10);
      console.warn('⚠️ tire_id 불일치(캐시값 ${tire_id}) — 화면 후보에서 대체 선택: '+selId);
    } else {
      fail('사이즈/DOT 후보 목록에서 tire_id를 찾지 못함: ${tire_id} (현재 후보 '+cands.length+'개, DOT일치 '+byDot.length+'개 — 캐시가 오래됐을 수 있습니다. 🔄 가격새로고침 후 다시 시도하세요)');
      return;
    }
  }
  selectTire(selId);
  // selectTire 내부의 /ajax/tire/price/ 요청(비동기)이 _price/_directprice를 채울 때까지 대기
  await waitUntil(function(){ return _tire === selId && _price > 0; }, 3000, 100);
  if(!_tire||_tire===0){ fail('상품 선택 후 가격 정보 로딩 실패 (사이트 응답 지연 가능성)'); return; }
  await sleep(150);

  // STEP4: 나머지 입력
  var priceEl=document.querySelector('input#price');
  if(priceEl){
    priceEl.value='${sellPrice}';
    if(typeof changePrice==='function') changePrice(1);
    else priceEl.dispatchEvent(new KeyboardEvent('keyup',{bubbles:true}));
  }
  // DOT: 값 직접대입 대신 매칭 옵션을 명시적으로 선택 + 실패 시 경고
  var dotEl=document.querySelector('select#dot');
  if(dotEl){
    var dy='${dot}';
    if(dy){
      var hit=false;
      for(var oi=0;oi<dotEl.options.length;oi++){
        if(dotEl.options[oi].value===dy){ dotEl.selectedIndex=oi; hit=true; break; }
      }
      hit ? dotEl.dispatchEvent(new Event('change',{bubbles:true}))
          : console.warn('❌ DOT 옵션 없음:', dy);
    } else {
      console.warn('⚠️ p.dot 비어있음 — 원본 상품에 DOT가 없음');
    }
  }
  // 짝수판매: 툴바의 "짝수출고 구매제한없음" 체크 상태를 그대로 반영
  var evenEl=document.querySelector('input[name="evensell"][value="${evensellVal}"]');
  if(evenEl&&!evenEl.checked){ evenEl.checked=true; evenEl.dispatchEvent(new Event('change',{bubbles:true})); }
  var cntEl=document.querySelector('input#count');
  if(cntEl){ cntEl.value='${stock}'; cntEl.dispatchEvent(new Event('input',{bubbles:true})); }
  var memoEl=document.querySelector('input#memo');
  if(memoEl) memoEl.value='${memo}';
  var hourEl=document.querySelector('select#send_hour');
  var minEl=document.querySelector('select#send_min');
  if(hourEl){ hourEl.value='${sendHour}'; hourEl.dispatchEvent(new Event('change',{bubbles:true})); }
  if(minEl){  minEl.value='${sendMin}';  minEl.dispatchEvent(new Event('change',{bubbles:true})); }
  var kindEl=document.querySelector('input[name="send_kind"][value="0"]');
  if(kindEl&&!kindEl.checked){ kindEl.checked=true; kindEl.dispatchEvent(new Event('change',{bubbles:true})); }

  window.__tireping_done = true;
})();
`.trim();
  return { js, sellPrice };
}

async function openInsertPage(p, autoSubmit) {
  const stockEl = $("inp-stock"); const stock = stockEl ? (parseInt(stockEl.value, 10) || 0) : 4;
  const maxDcRaw = $("inp-maxdc").value.trim();
  const maxDc = maxDcRaw ? parseFloat(maxDcRaw) : null;
  const { js, sellPrice } = buildInsertJS(p, maxDc, stock);
  st(`🌐 ${p.product} ${p.size} 판매가:${comma(sellPrice)}원 | ${autoSubmit ? "자동등록 중..." : "입력 후 저장하기 클릭"}`);
  return _runInjectedInsert(js, autoSubmit, `${p.product} ${p.size}`);
}

// 등록 페이지(/sell/price/insert)를 열고, 주어진 주입 스크립트(js)를 실행시킨 뒤 완료를 기다림
// (openInsertPage와 대량 신규등록 기능이 공용으로 사용)
async function _runInjectedInsert(js, autoSubmit, label) {
  const session = typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, c =>
        (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16));

  // 이전 pending 잔류 제거 후 새 pending 저장 (탭 강제 닫힘 등으로 잔류 방지)
  await new Promise(r => chrome.storage.local.remove(["tireping_pending","tireping_done"], r));
  await new Promise(r => chrome.storage.local.set({
    tireping_pending: { session, js, auto_submit: autoSubmit }
  }, () => { if (chrome.runtime.lastError) console.warn("[업로드] 저장 실패:", chrome.runtime.lastError.message); r(); }));

  // 등록 페이지 열기 — 콜백에서 tabId 즉시 확보 (onCreated는 URL이 아직 빈 문자열이라 URL 체크 불가)
  let _createdTabId = null;
  // active:false(백그라운드 탭)로 열었더니 오히려 완료 신호를 못 받는 경우가 있어 원복함
  chrome.tabs.create({ url: `${BASE}/sell/price/insert`, active: true }, tab => {
    _createdTabId = tab?.id ?? null;
    console.log(`[업로드][${session}] 탭 생성됨 tabId=${tab?.id}`, label);
  });

  // 완료 대기
  return new Promise(resolve => {
    let resolved = false;
    // tabs.create 콜백(_createdTabId)은 동기에 가깝게 실행됨
    // Promise 생성 시점엔 아직 null일 수 있으므로 getter로 항상 최신값 참조
    const getTabId = () => _createdTabId;

    const check = setInterval(() => {
      chrome.storage.local.get("tireping_done", r => {
        if (resolved) return;
        const done = r.tireping_done;
        if (done && done.session !== session) {
          console.warn(`[업로드][${session}] tireping_done 있으나 세션 불일치 (다른 항목 것?) done.session=${done.session}`);
        }
        if (done && done.session === session) {
          console.log(`[업로드][${session}] 완료신호 수신 ok=${done.ok} reason=${done.reason||""}`);
          resolved = true;
          clearInterval(check);
          clearInterval(urlCheck);
          chrome.storage.local.remove("tireping_done");
          if (done.ok && autoSubmit) { const tid = getTabId(); if (tid !== null) chrome.tabs.remove(tid, () => void chrome.runtime.lastError); }
          resolve({ ok: done.ok, reason: done.reason || "" });
        }
      });
    }, 500);

    // 저장(chrome.storage) 신호가 어떤 이유로 씹혀도 놓치지 않도록,
    // 탭의 실제 주소가 "등록 완료" 상태(=/sell/price 이하이지만 /insert는 아님)로 바뀌었는지도 별도로 확인
    const urlCheck = autoSubmit ? setInterval(() => {
      if (resolved) return;
      const tid = getTabId();
      if (tid === null) return;
      chrome.tabs.get(tid, tab => {
        if (chrome.runtime.lastError || resolved || !tab?.url) return;
        if (tab.url.includes("/sell/price") && !tab.url.includes("/insert")) {
          console.log(`[업로드][${session}] URL변경 감지로 완료 처리 url=${tab.url}`);
          resolved = true;
          clearInterval(check);
          clearInterval(urlCheck);
          chrome.storage.local.remove("tireping_done");
          chrome.tabs.remove(tid, () => void chrome.runtime.lastError); // 업로드 완료 확인됐으니 탭 닫기
          resolve({ ok: true, reason: "" });
        }
      });
    }, 1000) : null;

    if (autoSubmit) {
      // 타임아웃이 나도 탭을 강제로 닫지 않음 — 사용자가 직접 화면을 보고 확인할 수 있게 둠
      // (완료 신호가 오면 위쪽 check interval이 정상적으로 resolve 처리함)
      const onTabRemoved = (removedTabId) => {
        if (removedTabId === getTabId() && !resolved) {
          resolved = true;
          clearInterval(check);
          chrome.tabs.onRemoved.removeListener(onTabRemoved);
          resolve({ ok: false, reason: "탭이 닫혔습니다" });
        }
      };
      const waitForTabId = setInterval(() => {
        if (getTabId() !== null) {
          clearInterval(waitForTabId);
          chrome.tabs.onRemoved.addListener(onTabRemoved);
        }
      }, 100);
      // 안전장치: 10분 후에도 완료 신호 없으면 정리만 함 (탭은 계속 열어둠)
      setTimeout(() => {
        if (!resolved) {
          console.warn(`[업로드][${session}] 10분 타임아웃 — 완료신호도 URL변경도 감지 못함`, label);
          resolved = true;
          clearInterval(check);
          clearInterval(waitForTabId);
          chrome.tabs.onRemoved.removeListener(onTabRemoved);
          resolve({ ok: false, reason: "10분 내에 완료되지 않았습니다 (탭은 열려있습니다 — 직접 확인하세요)" });
        }
      }, 600000);
    } else {
      // auto_submit=false: 탭을 닫지 않지만, 탭이 닫히면 check interval을 정리해야 함
      // chrome.tabs.onRemoved로 tabId 감시 → 탭 닫힘 시 interval 정리
      const onTabRemoved = (removedTabId) => {
        if (removedTabId === getTabId() && !resolved) {
          resolved = true;
          clearInterval(check);
          chrome.tabs.onRemoved.removeListener(onTabRemoved);
          resolve({ ok: false, reason: "탭이 닫혔습니다" });
        }
      };
      // tabId 확정 후 리스너 등록 (onCreated 콜백에서 tabId 세팅되면 바로 감시)
      const waitForTabId = setInterval(() => {
        if (getTabId() !== null) {
          clearInterval(waitForTabId);
          chrome.tabs.onRemoved.addListener(onTabRemoved);
        }
      }, 100);
      // 안전장치: 10분 후에도 완료 신호 없으면 정리 (무한 폴링 방지)
      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          clearInterval(check);
          clearInterval(waitForTabId);
          chrome.tabs.onRemoved.removeListener(onTabRemoved);
          resolve({ ok: false, reason: "10분 내에 완료되지 않았습니다" });
        }
      }, 600000);
    }
  });
}

async function bulkUpload() {
  const allChecked = [...checkedSet].map(k => { const i=_keyIdx(k); return shownProducts[i]; }).filter(Boolean);
  const alreadyMine = allChecked.filter(p => p.is_mine);
  const targets = allChecked.filter(p => !p.is_mine);

  if (alreadyMine.length > 0) {
    const names = alreadyMine.slice(0, 3).map(p => `${p.product} ${p.size}`).join(", ");
    const more  = alreadyMine.length > 3 ? ` 외 ${alreadyMine.length - 3}개` : "";
    if (!confirm(`이미 등록된 상품 ${alreadyMine.length}개가 포함됩니다:\n${names}${more}\n\n미등록 상품 ${targets.length}개만 업로드할까요?`)) return;
  }
  if (!targets.length) { alert("체크된 미판매 상품이 없습니다"); return; }

  const stock = parseInt($("inp-stock").value, 10) || 4;
  const maxDcRaw = $("inp-maxdc").value.trim();
  const maxDc = maxDcRaw ? parseFloat(maxDcRaw) : null;
  const dcMsg = maxDc !== null ? `\n제한DC율: ${maxDc}%` : "";

  if (!confirm(`미판매 상품 ${targets.length}개를 자동 등록합니다.${dcMsg}\n계속할까요?`)) return;

  loading(true, `0/${targets.length} 업로드 중...`);
  let success = 0;
  const failures = []; // {product, size, reason}
  try {
    for (let k = 0; k < targets.length; k++) {
      const p = targets[k];
      $("loading-msg").textContent = `[${k+1}/${targets.length}] ${p.product} ${p.size}`;
      let result = await openInsertPage(p, true);  // auto_submit=true
      // 일시적 오류(탭 로딩 지연 등)로 실패한 경우 1회만 자동 재시도
      if (!result?.ok) {
        st(`⚠️ ${p.product} ${p.size} 1차 실패(${result?.reason||"알 수 없는 오류"}) — 재시도 중...`);
        await sleep(500);
        result = await openInsertPage(p, true);
      }
      if (result?.ok) success++;
      else failures.push({ product: p.product, size: p.size, reason: result?.reason || "알 수 없는 오류" });
      await sleep(300);
    }
    if (failures.length) {
      const detail = failures.slice(0, 5).map(f => `- ${f.product} ${f.size}: ${f.reason}`).join("\n");
      const more = failures.length > 5 ? `\n...외 ${failures.length - 5}건` : "";
      st(`⚠️ ${success}/${targets.length}개 성공, ${failures.length}개 실패`);
      alert(`일부 상품 등록에 실패했습니다 (${failures.length}건):\n\n${detail}${more}\n\n실패한 항목은 탭이 열린 채로 남아있을 수 있으니 직접 확인해 주세요.`);
    } else {
      st(`✅ ${success}/${targets.length}개 업로드 완료`);
    }
  } catch(e) {
    st(`❌ 업로드 중 오류: ${e.message}`);
    console.error(e);
  } finally {
    loading(false);
  }
}

// ── 이벤트 바인딩

// ── 자동 캐시 정리
// 사이드바 열릴 때 1회 + background alarm으로 매일 1회 실행
// 대상: tireping_cache(7일), tire_cache(30일)
async function runCacheGC() {
  const now = Date.now();
  const TTL_PRODUCT = 2  * 24 * 60 * 60 * 1000; // 2일 — 상품 캐시 (background와 동일)
  const TTL_TIRE    = 14 * 24 * 60 * 60 * 1000; // 14일 — pid↔tire_id 매핑
  let totalRemoved = 0;

  // 1. tireping_cache — 7일 초과 항목 제거
  try {
    const r = await new Promise(resolve => chrome.storage.local.get("tireping_cache", resolve));
    const cache = r.tireping_cache || {};
    let removed = 0;
    for (const key in cache) {
      const ts = (cache[key] && cache[key]._ts) || 0;
      if (!ts || (now - ts) > TTL_PRODUCT) { delete cache[key]; removed++; }
    }
    if (removed > 0) {
      _memCache = cache; // 인메모리 캐시도 동기화
      await new Promise(resolve => chrome.storage.local.set({ tireping_cache: cache }, resolve));
      totalRemoved += removed;
    }
  } catch(e) { console.warn("[캐시GC] tireping_cache 오류:", e.message); }

  // 2. tire_cache — 30일 초과 항목 제거 (_ts 없는 구버전도 제거)
  try {
    const r = await new Promise(resolve => chrome.storage.local.get("tire_cache", resolve));
    const cache = r.tire_cache || {};
    let removed = 0;
    for (const key in cache) {
      const ts = (cache[key] && typeof cache[key] === "object" ? cache[key]._ts : 0) || 0;
      if (!ts || (now - ts) > TTL_TIRE) { delete cache[key]; removed++; }
    }
    if (removed > 0) {
      await new Promise(resolve => chrome.storage.local.set({ tire_cache: cache }, resolve));
      totalRemoved += removed;
    }
  } catch(e) { console.warn("[캐시GC] tire_cache 오류:", e.message); }

  // 3. 마지막 GC 시각 저장 (background alarm 중복 방지용)
  await new Promise(resolve => chrome.storage.local.set(
    { _cache_gc_ts: now }, resolve
  )).catch(() => {});

  if (totalRemoved > 0) console.log(`[캐시GC] 총 ${totalRemoved}개 제거 완료`);
}

// 사이드바 열릴 때: 마지막 GC로부터 23시간 이상 지났으면 실행
async function maybeCacheGC() {
  try {
    const r = await new Promise(resolve => chrome.storage.local.get("_cache_gc_ts", resolve));
    const last = r._cache_gc_ts || 0;
    const elapsed = Date.now() - last;
    // background GC가 실행됐으면 _memCache가 stale 가능
    // _cache_gc_ts가 최근에 갱신됐으면 무효화 (다음 검색 시 storage에서 재로드)
    if (last > 0 && _memCache !== null) {
      // 인메모리 캐시 생성 시각: 캐시 항목 중 가장 최신 _ts 사용
      let maxTs = 0;
      for (const k in _memCache) { const t = _memCache[k]?._ts || 0; if (t > maxTs) maxTs = t; }
      if (last > maxTs) _memCache = null; // GC가 캐시보다 최신 → stale
    }
    if (elapsed > 6 * 60 * 60 * 1000) { // 6시간 이상 경과
      runCacheGC();
      // updateCache에서 제거한 TTL 순회를 여기서 처리 (검색 속도 향상)
      const _gc = await loadCache();
      const _gn = Date.now(); let _ge = 0;
      for (const k in _gc) {
        const it = _gc[k];
        if (it?._ts && (_gn - it._ts) > 172800000) { delete _gc[k]; _ge++; }
      }
      if (_ge > 0) await saveCache(_gc);
    }
  } catch(e) {}
}

// ── 원가율/수수료율 설정 패널 ────────────────────────────────
function showMarginSettings() {
  document.getElementById("margin-settings-popup")?.remove();

  const popup = document.createElement("div");
  popup.id = "margin-settings-popup";
  popup.style.cssText = `
    position:fixed; top:48px; right:8px; z-index:9999;
    background:white; border:1px solid #c7d2fe; border-radius:8px;
    box-shadow:0 6px 24px rgba(0,0,0,0.18); padding:0; min-width:260px;
    font-size:11px; color:#1f2937;
  `;

  popup.innerHTML = `
    <div style="background:#1a1a2e;color:white;padding:8px 12px;border-radius:7px 7px 0 0;
      font-weight:bold;font-size:12px;display:flex;align-items:center;justify-content:space-between;">
      ⚙️ 원가율 / 수수료 / 택배비 설정
      <span id="margin-settings-close" style="cursor:pointer;opacity:0.7;font-size:14px;">✕</span>
    </div>
    <div style="padding:12px;">
      <div style="margin-bottom:10px;">
        <label style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
          <span>기본 원가율 <span style="color:#9ca3af;">(공장도가 대비 %)</span></span>
          <input type="number" id="ms-cost-rate" min="0" max="100" step="0.1"
            value="${costRatePct}" style="width:64px;text-align:right;border:1px solid #d1d5db;border-radius:4px;padding:2px 5px;">
        </label>
        <div style="color:#9ca3af;font-size:10px;margin-top:2px;">
          원가 = 공장도가 × (1 − 원가율). 표에서 "원가" 칸을 직접 클릭하면 상품별로 따로 지정할 수 있습니다.
        </div>
      </div>
      <div style="margin-bottom:10px;">
        <label style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
          <span>핑수수료율 <span style="color:#9ca3af;">(%)</span></span>
          <input type="number" id="ms-fee-rate" min="0" max="100" step="0.01"
            value="${feeRatePct}" style="width:64px;text-align:right;border:1px solid #d1d5db;border-radius:4px;padding:2px 5px;">
        </label>
        <div style="color:#9ca3af;font-size:10px;margin-top:2px;">
          마진 계산 시 판매가에서 이 비율만큼 수수료로 차감합니다. (예: 2.49 → 2.49%)
        </div>
      </div>
      <div style="margin-bottom:10px;">
        <label style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
          <span>기본 택배비 <span style="color:#9ca3af;">(원)</span></span>
          <input type="number" id="ms-shipping" min="0" max="100000" step="500"
            value="${shippingCostDefault}" style="width:64px;text-align:right;border:1px solid #d1d5db;border-radius:4px;padding:2px 5px;">
        </label>
        <div style="color:#9ca3af;font-size:10px;margin-top:2px;">
          마진 계산 시 이 금액을 추가로 차감합니다. 표에서 "택배" 칸을 직접 클릭하면 상품별로 따로 지정할 수 있습니다.
        </div>
      </div>
      <div id="ms-override-count" style="color:#6b7280;font-size:10px;margin-bottom:8px;"></div>
      <div style="display:flex;gap:4px;">
        <button id="ms-save" style="flex:1;padding:5px;font-size:11px;background:#1a1a2e;
          color:white;border:none;border-radius:4px;cursor:pointer;">저장</button>
        <button id="ms-clear-overrides" style="flex:1;padding:5px;font-size:10px;background:#fef3c7;
          color:#92400e;border:1px solid #fcd34d;border-radius:4px;cursor:pointer;">상품별 값 초기화</button>
      </div>
      <div id="ms-result" style="font-size:10px;color:#16a34a;text-align:center;min-height:14px;margin-top:6px;"></div>
    </div>
  `;

  document.body.appendChild(popup);

  const result = popup.querySelector("#ms-result");
  const setResult = (msg, color="#16a34a") => { result.textContent = msg; result.style.color = color; };

  const ovCostCount = Object.keys(costRateOverrides).length;
  const ovShipCount = Object.keys(shippingCostOverrides).length;
  popup.querySelector("#ms-override-count").textContent =
    (ovCostCount || ovShipCount)
      ? `상품별 지정: 원가율 ${ovCostCount}개, 택배비 ${ovShipCount}개`
      : "상품별로 따로 지정한 값 없음 (전체 기본값 사용)";

  let _closed = false;
  const close = () => {
    if (_closed) return;
    _closed = true;
    popup.remove();
    document.removeEventListener("click", outsideClose);
  };
  popup.querySelector("#margin-settings-close").addEventListener("click", close);

  popup.querySelector("#ms-save").addEventListener("click", async () => {
    const newCost = parseFloat(popup.querySelector("#ms-cost-rate").value);
    const newFee  = parseFloat(popup.querySelector("#ms-fee-rate").value);
    const newShip = parseInt(popup.querySelector("#ms-shipping").value, 10);
    if (isNaN(newCost) || newCost < 0 || newCost > 100) { setResult("❌ 원가율은 0~100 사이 숫자여야 합니다", "#dc2626"); return; }
    if (isNaN(newFee)  || newFee  < 0 || newFee  > 100) { setResult("❌ 수수료율은 0~100 사이 숫자여야 합니다", "#dc2626"); return; }
    if (isNaN(newShip) || newShip < 0 || newShip > 100000) { setResult("❌ 택배비는 0~100,000 사이 숫자여야 합니다", "#dc2626"); return; }
    await saveGlobalMarginSettings(newCost, newFee, newShip);
    _lastFilterKey = ""; applyFilters._ref = null;
    applyFilters();
    setResult("✅ 저장 완료 — 표에 반영됨");
    setTimeout(close, 700);
  });

  popup.querySelector("#ms-clear-overrides").addEventListener("click", async () => {
    if (!ovCostCount && !ovShipCount) { setResult("초기화할 상품별 값이 없습니다", "#6b7280"); return; }
    if (!confirm(`상품별로 지정한 원가율 ${ovCostCount}개, 택배비 ${ovShipCount}개를 모두 초기화하고 기본값으로 되돌릴까요?`)) return;
    costRateOverrides = {};
    shippingCostOverrides = {};
    await new Promise(res => chrome.storage.local.set({ cost_rate_overrides: {}, shipping_cost_overrides: {} }, res));
    _rowCache.clear();
    _lastFilterKey = ""; applyFilters._ref = null;
    applyFilters();
    setResult("✅ 상품별 값 초기화 완료");
    setTimeout(close, 700);
  });

  const outsideClose = e => {
    if (!popup.contains(e.target) && e.target.id !== "btn-margin-settings") close();
  };
  setTimeout(() => document.addEventListener("click", outsideClose), 80);
}

// ── 캐시 관리 패널
async function getCacheStats() {
  // chrome.storage.local 전체 항목 조회 후 키별 통계 계산
  const all = await new Promise(r => chrome.storage.local.get(null, r));
  const totalBytes = await new Promise(r => chrome.storage.local.getBytesInUse(null, r));

  const productCache = all["tireping_cache"] || {};
  const productCount = Object.keys(productCache).length;
  // 만료 예정 (2일 기준)
  const now = Date.now();
  const TTL = 172800000;
  const expiredCount = Object.values(productCache).filter(c => c._ts && (now - c._ts) > TTL).length;
  const oldCount = Object.values(productCache).filter(c => {
    const age = now - (c._ts || 0);
    return age > 86400000 && age <= TTL; // 1~2일
  }).length;

  // 계정별 tire_cache 합산
  let tireCount = 0;
  for (const key in all) {
    if (key === "tire_cache" || key.startsWith("tire_cache__")) {
      tireCount += Object.keys(all[key] || {}).length;
    }
  }

  const productBytes = await new Promise(r =>
    chrome.storage.local.getBytesInUse("tireping_cache", r)).catch(() => 0);
  const tireCacheKeys = Object.keys(all).filter(k => k === "tire_cache" || k.startsWith("tire_cache__"));
  const tireBytes = tireCacheKeys.length
    ? await new Promise(r => chrome.storage.local.getBytesInUse(tireCacheKeys, r)).catch(() => 0)
    : 0;

  return {
    totalBytes, productCount, expiredCount, oldCount,
    tireCount, productBytes, tireBytes,
    limitBytes: 5 * 1024 * 1024, // 5MB
  };
}

function fmtBytes(b) {
  if (b < 1024) return b + "B";
  if (b < 1024*1024) return (b/1024).toFixed(1) + "KB";
  return (b/1024/1024).toFixed(2) + "MB";
}

async function showCacheMgr() {
  // 기존 팝업 제거
  document.getElementById("cache-mgr-popup")?.remove();

  const stats = await getCacheStats();
  const pct = Math.round(stats.totalBytes / stats.limitBytes * 100);
  const barColor = pct > 80 ? "#dc2626" : pct > 50 ? "#f59e0b" : "#16a34a";

  const popup = document.createElement("div");
  popup.id = "cache-mgr-popup";
  popup.style.cssText = `
    position:fixed; top:48px; right:8px; z-index:9999;
    background:white; border:1px solid #c7d2fe; border-radius:8px;
    box-shadow:0 6px 24px rgba(0,0,0,0.18); padding:0; min-width:240px;
    font-size:11px; color:#1f2937;
  `;

  popup.innerHTML = `
    <div style="background:#1a1a2e;color:white;padding:8px 12px;border-radius:7px 7px 0 0;
      font-weight:bold;font-size:12px;display:flex;align-items:center;justify-content:space-between;">
      🗑️ 캐시 관리
      <span id="cache-mgr-close" style="cursor:pointer;opacity:0.7;font-size:14px;">✕</span>
    </div>
    <div style="padding:10px 12px;">

      <!-- 전체 용량 바 -->
      <div style="margin-bottom:10px;">
        <div style="display:flex;justify-content:space-between;margin-bottom:3px;">
          <span style="font-weight:bold;">전체 스토리지 사용량</span>
          <span style="color:${barColor};font-weight:bold;">${fmtBytes(stats.totalBytes)} / 5MB (${pct}%)</span>
        </div>
        <div style="height:6px;background:#e5e7eb;border-radius:3px;overflow:hidden;">
          <div style="height:100%;width:${pct}%;background:${barColor};border-radius:3px;transition:width 0.3s;"></div>
        </div>
      </div>

      <!-- 상품 캐시 -->
      <div style="background:#f9fafb;border-radius:6px;padding:8px 10px;margin-bottom:8px;">
        <div style="font-weight:bold;margin-bottom:4px;color:#1e3a8a;">
          📦 상품 캐시 (tireping_cache)
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:2px;color:#374151;">
          <span>총 항목:</span><span style="text-align:right;font-weight:bold;">${stats.productCount.toLocaleString()}개</span>
          <span>만료됨(2일↑):</span><span style="text-align:right;color:#dc2626;font-weight:bold;">${stats.expiredCount.toLocaleString()}개</span>
          <span>오래됨(1~2일):</span><span style="text-align:right;color:#f59e0b;font-weight:bold;">${stats.oldCount.toLocaleString()}개</span>
          <span>용량:</span><span style="text-align:right;">${fmtBytes(stats.productBytes)}</span>
        </div>
        <div style="margin-top:6px;display:flex;gap:4px;">
          <button id="btn-gc-expired" style="flex:1;padding:3px 6px;font-size:10px;background:#fee2e2;
            color:#991b1b;border:1px solid #fca5a5;border-radius:4px;cursor:pointer;">
            🧹 만료 항목만 삭제
          </button>
          <button id="btn-gc-all-product" style="flex:1;padding:3px 6px;font-size:10px;background:#fef3c7;
            color:#92400e;border:1px solid #fcd34d;border-radius:4px;cursor:pointer;">
            🗑 상품캐시 전체 삭제
          </button>
        </div>
      </div>

      <!-- pid 매핑 캐시 -->
      <div style="background:#f9fafb;border-radius:6px;padding:8px 10px;margin-bottom:8px;">
        <div style="font-weight:bold;margin-bottom:4px;color:#1e3a8a;">
          🔗 pid 매핑 캐시 (tire_cache)
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:2px;color:#374151;">
          <span>총 항목:</span><span style="text-align:right;font-weight:bold;">${stats.tireCount.toLocaleString()}개</span>
          <span>용량:</span><span style="text-align:right;">${fmtBytes(stats.tireBytes)}</span>
        </div>
        <div style="margin-top:6px;">
          <button id="btn-gc-tire" style="width:100%;padding:3px 6px;font-size:10px;background:#e0e7ff;
            color:#1e3a8a;border:1px solid #a5b4fc;border-radius:4px;cursor:pointer;">
            🗑 pid 매핑 전체 삭제 (다음 검색 시 재생성됨)
          </button>
        </div>
      </div>

      <!-- 전체 삭제 -->
      <button id="btn-gc-all" style="width:100%;padding:4px;font-size:10px;background:#1a1a2e;
        color:white;border:none;border-radius:4px;cursor:pointer;margin-bottom:4px;">
        ⚠️ 캐시 전체 초기화
      </button>
      <div id="cache-mgr-result" style="font-size:10px;color:#6b7280;text-align:center;min-height:14px;"></div>
    </div>
  `;

  document.body.appendChild(popup);

  const result = popup.querySelector("#cache-mgr-result");

  function setResult(msg, color="#16a34a") {
    result.textContent = msg;
    result.style.color = color;
  }

  // closeCacheMgr: 닫기 버튼·외부클릭 모든 경로에서 outsideClose 정리
  let _cacheMgrClosed = false;
  const closeCacheMgr = () => {
    if (_cacheMgrClosed) return;
    _cacheMgrClosed = true;
    popup.remove();
    document.removeEventListener("click", outsideClose);
  };

  async function refresh() {
    closeCacheMgr();
    showCacheMgr();
  }

  // 닫기
  popup.querySelector("#cache-mgr-close").addEventListener("click", closeCacheMgr);

  // 만료 항목만 삭제
  popup.querySelector("#btn-gc-expired").addEventListener("click", async () => {
    setResult("삭제 중...", "#f59e0b");
    await runCacheGC(); // 기존 GC 함수 (TTL 기준)
    _memCache = null;
    setResult(`✅ 만료 항목 삭제 완료`);
    setTimeout(refresh, 800);
  });

  // 상품캐시 전체 삭제
  popup.querySelector("#btn-gc-all-product").addEventListener("click", async () => {
    if (!confirm("상품 캐시를 전체 삭제합니다. 다음 검색 시 서버에서 새로 불러옵니다.")) return;
    setResult("삭제 중...", "#f59e0b");
    await new Promise(r => chrome.storage.local.remove("tireping_cache", r));
    _memCache = null;
    setResult(`✅ 상품 캐시 전체 삭제 완료`);
    setTimeout(refresh, 800);
  });

  // pid 매핑 삭제
  popup.querySelector("#btn-gc-tire").addEventListener("click", async () => {
    if (!confirm("pid 매핑 캐시를 삭제합니다. 다음 검색 시 재생성됩니다(약간 느려질 수 있음).")) return;
    setResult("삭제 중...", "#f59e0b");
    const all = await new Promise(r => chrome.storage.local.get(null, r));
    const tireKeys = Object.keys(all).filter(k => k === "tire_cache" || k.startsWith("tire_cache__"));
    if (tireKeys.length) await new Promise(r => chrome.storage.local.remove(tireKeys, r));
    setResult(`✅ pid 매핑 삭제 완료 (${tireKeys.length}개 키)`);
    setTimeout(refresh, 800);
  });

  // 전체 초기화
  popup.querySelector("#btn-gc-all").addEventListener("click", async () => {
    if (!confirm("⚠️ 모든 캐시를 초기화합니다.\n(계정 정보는 유지됩니다)\n계속하시겠습니까?")) return;
    setResult("초기화 중...", "#f59e0b");
    const all = await new Promise(r => chrome.storage.local.get(null, r));
    // 계정 관련 키는 보존
    const keepKeys = ["account_list","last_store_id","_auto_refresh","_auto_interval"];
    const removeKeys = Object.keys(all).filter(k =>
      !keepKeys.includes(k) && !k.startsWith("_auto")
    );
    if (removeKeys.length) await new Promise(r => chrome.storage.local.remove(removeKeys, r));
    _memCache = null;
    allProducts = []; shownProducts = []; filterState = {};
    checkedSet.clear(); window._lowestCache = new Map(); _rowCache.clear();
    $("tbody").innerHTML = ""; $("thead").innerHTML = "";
    $("summary-text").textContent = "캐시 초기화 완료 — 검색해주세요";
    setResult(`✅ 전체 초기화 완료 (${removeKeys.length}개 키 삭제)`);
    setTimeout(refresh, 1200);
  });

  // 팝업 외부 클릭 시 닫기
  const outsideClose = e => {
    if (!popup.contains(e.target) && e.target.id !== "btn-cache-mgr") closeCacheMgr();
  };
  setTimeout(() => document.addEventListener("click", outsideClose), 80);
}

document.addEventListener("DOMContentLoaded", async () => {
  // ── 화면 잘림 보정: 사이드패널/PiP(별도창)에서 크기 변경 시
  // 크롬이 레이아웃을 다시 안 그려서 절반에서 멈추는 버그 대응.
  // 창 크기 변경·창이 다시 보일 때(visibilitychange) 강제로 리플로우를 한 번 일으킴.
  function _forceRepaint() {
    const b = document.body;
    const prev = b.style.display;
    b.style.display = "none";
    void b.offsetHeight; // 강제 리플로우 트리거
    b.style.display = prev || "";
  }
  let _repaintTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(_repaintTimer);
    _repaintTimer = setTimeout(_forceRepaint, 80);
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") setTimeout(_forceRepaint, 50);
  });
  // 처음 로드 직후에도 한 번 (패널이 열리는 애니메이션 중 크기 측정이 어긋나는 경우 대응)
  setTimeout(_forceRepaint, 200);

  // ── 가상스크롤 + 필터 배지 CSS 주입
  const _filterStyle = document.createElement("style");
  _filterStyle.textContent = `
    #filter-status { display:flex; flex-wrap:wrap; align-items:center; gap:3px; min-height:20px; }
    .filter-badge {
      display:inline-flex; align-items:center; gap:2px;
      background:#dbeafe; border:1px solid #93c5fd; border-radius:10px;
      padding:1px 5px; font-size:10px; color:#1d4ed8; cursor:default;
      white-space:nowrap;
    }
    .filter-badge-wh { background:#ede9fe; border-color:#a78bfa; color:#5b21b6; }
    .filter-badge .fb-label { cursor:pointer; }
    .filter-badge .fb-label:hover { text-decoration:underline; }
    .filter-badge .fb-x {
      cursor:pointer; font-size:9px; color:#6b7280;
      padding:0 1px; border-radius:50%; line-height:1;
    }
    .filter-badge .fb-x:hover { background:#fee2e2; color:#dc2626; }
    .filter-empty { font-size:10px; color:#9ca3af; }
    /* 즐겨찾기 별표 */
    .fav-cell { text-align:center; cursor:pointer; }
    .fav-star { cursor:pointer; font-size:15px; line-height:1; color:#d1d5db; user-select:none; transition:transform .08s; }
    .fav-star:hover { transform:scale(1.25); color:#fbbf24; }
    .fav-star.on { color:#f59e0b; text-shadow:0 0 1px #d97706; }
  `;
  document.head.appendChild(_filterStyle);
  // 즐겨찾기 로드 (계정별)
  await loadFavorites();
  updateFavCount();
  // 거래처 탭 데이터 로드 (sync — 같은 Chrome 계정이면 자동 공유)
  await loadBizData();
  // 출고지 드롭다운 목록/선택값 로드
  await loadShipFromData();
  await loadDirectShipData();
  await loadGSheetConfig();
  await loadMarginTabsConfig();
  await loadShipSizeRules();
  // 원가율/수수료율/택배비 설정 로드 (마진 계산용)
  await loadMarginSettings();

  // 팝업 외부 클릭 시 닫기
  document.addEventListener("click", e => {
    if (!e.target.closest(".biz-btn") && !e.target.closest("#biz-assign-popup")) {
      _hideBizAssignPopup();
    }
    if (!e.target.closest(".sendkind-btn") && !e.target.closest("#sendkind-popup")) {
      hideSendKindPopup();
    }
  });

  // ── 탭 전환
  // 최저가 봇 / 즐겨찾기는 같은 표를 공유 — 콘텐츠 div를 바꾸지 않고 데이터만 교체
  document.querySelectorAll(".tab-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const tab = btn.dataset.tab;
      document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      // #tab-price는 항상 표시 (price/fav 공용). 다른 탭이 생기면 그때 토글.
      if (tab === "fav")        { if (viewMode==="orders") leaveOrdersView(); enterFavView(); }
      else if (tab === "mine")  { if (viewMode==="orders") leaveOrdersView(); enterMineView(); }
      else if (tab === "orders") enterOrdersView();
      else if (tab === "price") {
        if (viewMode === "orders") leaveOrdersView();
        else if (viewMode === "fav") enterSearchView();
        else if (viewMode === "mine") leaveMineView();
      }
    });
  });

  // 사이드패널 우클릭 기본 메뉴 차단 (thead에서만 커스텀 메뉴 사용)
  document.addEventListener("contextmenu", e => {
    if (e.target.closest("thead")) e.preventDefault();
  });

  // ── 내 판매현황: 제조사 서브탭 클릭 (이벤트 위임)
  $("mine-mfr-bar")?.addEventListener("click", e => {
    const btn = e.target.closest(".mfr-tab-btn");
    if (!btn) return;
    _mineMfrFilter = btn.dataset.mfr || "";
    document.querySelectorAll(".mfr-tab-btn").forEach(b => b.classList.toggle("active", b === btn));
    _renderMineView();
  });

  // ── 최저가봇 검색결과: 제조사 빠른필터 클릭 (이벤트 위임)
  // "제조사" 컬럼 헤더의 ▾ 필터와 동일한 filterState["제조사"]를 사용 — 어느 쪽으로 걸어도 서로 반영됨
  $("price-mfr-bar")?.addEventListener("click", e => {
    const btn = e.target.closest(".mfr-tab-btn");
    if (!btn) return;
    const mfr = btn.dataset.mfr || "";
    if (mfr) filterState["제조사"] = new Set([mfr]);
    else delete filterState["제조사"];
    checkedSet.clear(); // 제조사 전환 시 이전 선택 체크는 해제 (다른 제조사가 잘못 선택된 채 가격변경되는 사고 방지)
    _updatePriceMfrTabs();
    applyFilters();
    updateFilterLabel();
  });

  // 시작 시 좀비 알람 제거 (크롬 재시작 후에도 chrome.alarms가 살아남는 현상)
  chrome.runtime.sendMessage({ type: "CLEAR_ALARM" }).catch(() => {});

  // 자동 캐시 GC — 마지막 실행으로부터 23시간 이상 경과 시 실행
  maybeCacheGC();

  // 캐시 관리 버튼
  $("btn-cache-mgr").addEventListener("click", showCacheMgr);
  $("btn-table-more")?.addEventListener("click", () => {
    _tableVisibleLimit += TABLE_PAGE_SIZE;
    renderTable(shownProducts);
  });

  // stats 탭 내 버튼

  // ── 계정 선택 UI
  // 저장된 계정 목록 로드
  (async () => {
    const r = await new Promise(resolve => chrome.storage.local.get("account_list", resolve));
    const list = r.account_list || [];
    const sel = $("sel-account");
    if (sel) {
      sel.innerHTML = list.map(a => `<option value="${a}">${a}</option>`).join("") || '<option value="">계정 없음</option>';
    }
  })();

  // ＋ 현재 로그인 계정 추가
  $("btn-account-add")?.addEventListener("click", async () => {
    if (!myStoreId) { alert("먼저 로그인하세요"); return; }
    const r = await new Promise(resolve => chrome.storage.local.get("account_list", resolve));
    const list = r.account_list || [];
    if (list.includes(myStoreId)) { alert("이미 추가된 계정입니다"); return; }
    list.push(myStoreId);
    await new Promise(resolve => chrome.storage.local.set({ account_list: list }, resolve));
    const sel = $("sel-account");
    if (sel) {
      const opt = document.createElement("option");
      opt.value = myStoreId; opt.textContent = myStoreId;
      sel.appendChild(opt);
      sel.value = myStoreId;
    }
    st(`✅ 계정 추가됨: ${myStoreId}`);
  });

  // ✕ 선택된 계정 삭제
  $("btn-account-del")?.addEventListener("click", async () => {
    const sel = $("sel-account");
    const target = sel?.value;
    if (!target) { alert("삭제할 계정을 선택하세요"); return; }
    if (!confirm(`계정 [${target}]을 목록에서 삭제할까요?`)) return;
    const r = await new Promise(resolve => chrome.storage.local.get("account_list", resolve));
    const list = (r.account_list || []).filter(a => a !== target);
    await new Promise(resolve => chrome.storage.local.set({ account_list: list }, resolve));
    sel.querySelector(`option[value="${target}"]`)?.remove();
    st(`✅ 계정 삭제됨: ${target}`);
  });

  // 초기화
  // 팝업창으로 열릴 때도 이전 myStoreId를 복원해야 계정 변경 감지가 동작함
  st("로그인 확인 중...");
  try {
    const _prev = await new Promise(r => chrome.storage.local.get("last_store_id", r));
    if (_prev.last_store_id) myStoreId = _prev.last_store_id;
  } catch(e) {}
  const loggedIn = await checkLogin();
  if (loggedIn) {
    // 로그인 성공 후 myStoreId를 storage에 저장 (팝업창 재시작 시 복원용)
    chrome.storage.local.set({ last_store_id: myStoreId }).catch(() => {});
    st("제조사 목록 로드 중...");
    await loadCompanies();
    const cache = await loadCache();
    st(`✅ 준비 완료 — 캐시 ${Object.keys(cache).length}개`);
  }

  // 제조사 변경 → 제품명 로드
  $("sel-mfr").addEventListener("change", () => {
    loadPatterns($("sel-mfr").value);
  });

  // 검색
  // Prefetch: 버튼에 마우스 올리면 미리 요청 시작 (300ms 디바운스 + 중복 방지)
  let _prefetchTimer = null;
  let _prefetchSearch = "";
  $("btn-search").addEventListener("mouseenter", () => {
    const sizeText = $("inp-size")?.value.trim() || "";
    if (!sizeText && !$("sel-mfr").value) return;
    const search = sizeText.replace(/\s/g, "");
    // 같은 검색어 연속 hover → 중복 요청 방지
    if (search === _prefetchSearch) return;
    clearTimeout(_prefetchTimer);
    _prefetchTimer = setTimeout(() => {
      _prefetchSearch = search;
      bgFetch(`${BASE}/buy/insert?search=${encodeURIComponent(search)}&page=1`).catch(() => {});
    }, 300);
  });
  $("btn-search").addEventListener("mouseleave", () => {
    clearTimeout(_prefetchTimer);
  });
  // SW 웜업: 검색 클릭 즉시 SW ping → 첫 bgFetch SW 재시작 지연(~1.5초) 제거
  function _warmupSW() {
    try { const _p = chrome.runtime.connect({ name: "keepalive" }); _p.disconnect(); } catch(_) {}
  }
  $("btn-search").addEventListener("click", () => { _warmupSW(); doSearch(true); });
  $("btn-fresh").addEventListener("click",  () => { _warmupSW(); doSearch(false); });
  $("btn-reset").addEventListener("click",  () => {
    $("inp-size").value = "";
    $("sel-mfr").value = "";
    $("sel-prod").innerHTML = '<option value="">제품명</option>';
    if ($("sel-width"))  $("sel-width").value  = "단면폭";
    if ($("sel-height")) $("sel-height").value = "편평비";
    if ($("sel-inch"))   $("sel-inch").value   = "인치";
    $("sel-dot").value  = ""; $("sel-order").value = "";
    allProducts = []; shownProducts = []; filterState = {}; checkedSet.clear();
    $("tbody").innerHTML = ""; $("thead").innerHTML = "";
    $("summary-text").textContent = "초기화 완료";
    updateFilterLabel();
    _updatePriceMfrTabs();
  });
  document.addEventListener("keydown", e => {
    if (e.key !== "Enter") return;
    // 팝업/모달/인풋 편집 중이면 검색 무시
    if (document.querySelector(".filter-popup, .stock-input-popup")) return;
    const focused = document.activeElement;
    // 검색 입력란(사이즈/제조사)에서 Enter → 검색 허용
    const isSearchInput = focused && focused.id === "inp-size";
    if (isSearchInput) {
      // 자동완성 드롭다운 열려있으면 자체 keydown 핸들러가 처리 → 여기선 스킵
      const suggest = document.getElementById("mfr-suggest");
      if (suggest && suggest.style.display !== "none") return;
      doSearch(true);
      return;
    }
    // 그 외 인풋/셀렉트/텍스트에어리어 포커스 중이면 검색 무시
    if (focused && (focused.tagName === "INPUT" || focused.tagName === "TEXTAREA" || focused.tagName === "SELECT")) return;
    doSearch(true);
  });

  // 액션 버튼
  $("btn-check-all").addEventListener("click",   checkAll);
  $("btn-uncheck-all").addEventListener("click", uncheckAll);

  // 액션바 탭 전환 (가격조정/DOT/출고/거래처/등록설정/기타/자동갱신)
  document.querySelectorAll(".ab-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      const target = tab.dataset.abtab;
      document.querySelectorAll(".ab-tab").forEach(t => t.classList.toggle("active", t === tab));
      document.querySelectorAll(".ab-panel").forEach(p => { p.style.display = (p.dataset.abpanel === target) ? "flex" : "none"; });
    });
  });

  $("btn-bulk-low").addEventListener("click",    bulkLow);
  $("btn-bulk-raise").addEventListener("click",  bulkRaise);
  $("btn-bulk-margin")?.addEventListener("click", bulkMargin);
  $("btn-bulk-dot")?.addEventListener("click", bulkDot);
  $("btn-bulk-dc")?.addEventListener("click", bulkDC);
  $("btn-bulk-third")?.addEventListener("click", bulkThirdMinus10);
  $("btn-bulk-fourth")?.addEventListener("click", bulkFourthMinus10);
  $("btn-refresh-now").addEventListener("click", refreshLowest);
  $("btn-bulk-upload").addEventListener("click", bulkUpload);
  $("btn-bulk-sameday")?.addEventListener("click", () => bulkSendKind(0));
  $("btn-bulk-nextday")?.addEventListener("click", () => bulkSendKind(1));
  $("btn-bulk-biz")?.addEventListener("click", bulkAssignBiz);
  $("btn-bulk-sendtime")?.addEventListener("click", bulkSendTime);
  $("btn-even-nolimit")?.addEventListener("click", e => {
    const btn = e.currentTarget;
    const on  = btn.dataset.on === "1";
    if (on) {
      btn.dataset.on = "0";
      btn.textContent = "🔒 짝수구매만";
      btn.title = "클릭하면 등록시 짝수출고 제한없음으로 되돌립니다";
    } else {
      btn.dataset.on = "1";
      btn.textContent = "🔓 짝수출고 제한없음";
      btn.title = "클릭하여 등록시 짝수구매 제한 여부를 토글합니다";
    }
  });
  $("btn-auto").addEventListener("click",        toggleAuto);

  $("btn-clear-filter").addEventListener("click", () => {
    filterState = {};
    quickFilter = "";
    const qi = $("inp-quick-filter"); if (qi) qi.value = "";
    _lastFilterKey = "";
    applyFilters();
    updateFilterLabel();
  });

  // 결과 내 검색 (전역 텍스트 필터) — 입력 시 150ms 디바운스 후 재필터
  let _qfTimer = null;
  $("inp-quick-filter")?.addEventListener("input", e => {
    const v = e.target.value.trim().toLowerCase();
    clearTimeout(_qfTimer);
    _qfTimer = setTimeout(() => {
      if (v === quickFilter) return;
      quickFilter = v;
      _lastFilterKey = "";       // 캐시 무효화 → 재필터
      applyFilters();
      updateFilterLabel();
    }, 150);
  });
  // Esc → 검색 즉시 해제
  $("inp-quick-filter")?.addEventListener("keydown", e => {
    if (e.key === "Escape") {
      e.target.value = "";
      clearTimeout(_qfTimer);
      if (quickFilter) { quickFilter = ""; _lastFilterKey = ""; applyFilters(); updateFilterLabel(); }
    }
  });

  // 자동갱신 알람 수신
  chrome.runtime.onMessage.addListener(msg => {
    if (msg.type === "ALARM_REFRESH" && autoRefreshing) refreshLowest();
    if (msg.type === "CACHE_GC") { runCacheGC(); return; }
    // 자동 재고 작업 완료 → 상태/로그/표 갱신
    if (msg.type === "AUTOSTOCK_DONE") {
      renderAutoStockStatus();
      if ($("fav-as-log")?.style.display !== "none") renderAutoStockLog();
      const e = msg.entry;
      // 백그라운드가 storage의 즐겨찾기 재고값을 갱신했으면 다시 불러와 표에 반영
      if (e && e.favUpdated) {
        loadFavorites().then(() => {
          updateFavCount();
          if (viewMode === "fav") refreshFavViewIfActive();
        });
      }
      if (e && e.raised > 0) st(`✅ 자동 재고: ${e.msg}`);
      return;
    }
  });

  // ── 자동 재고 채우기 컨트롤
  $("fav-as-toggle")?.addEventListener("click", () => {
    console.log("[자동재고] ⏹/▶ 토글 클릭");
    chrome.storage.local.get("auto_stock_cfg", d => {
      const on = !(d.auto_stock_cfg && d.auto_stock_cfg.enabled);
      const intervalMin = Number($("fav-as-interval").value) || 60;
      const target = Math.max(1, Number($("fav-as-target").value) || 1);
      if (on && !myStoreId) { alert("먼저 타이어핑에 로그인하세요"); return; }
      if (on && !confirm(`⚠️ 자동 재고 채우기를 켭니다 — 이제부터 실제로 재고를 변경합니다.\n\n· ${intervalMin}분마다\n· 판매중인 즐겨찾기 상품의 재고가 ${target}개 미만이면 ${target}개로 채웁니다(가격·사양은 안 건드림).\n· 품절(0개)은 자동 재등록하지 않고 기록만 남깁니다.\n· 크롬이 켜져 있어야 동작합니다(패널은 닫아도 됨).\n\n계속할까요?`)) return;
      chrome.runtime.sendMessage(
        { type: "SET_AUTOSTOCK", enabled: on, intervalMin, target, storeId: myStoreId },
        (resp) => {
          if (chrome.runtime.lastError) {
            console.warn("[자동재고] SET 응답 오류:", chrome.runtime.lastError.message);
            st("⚠️ 백그라운드 응답 없음 — 확장 새로고침 필요"); return;
          }
          console.log("[자동재고] SET 응답:", resp);
          renderAutoStockStatus();
          st(on ? `🟢 자동 재고 ${intervalMin}분 주기로 시작` : "⚪ 자동 재고 중지");
        }
      );
    });
  });
  $("fav-as-run")?.addEventListener("click", () => {
    const target = Math.max(1, Number($("fav-as-target").value) || 1);
    if (!myStoreId) { alert("먼저 타이어핑에 로그인하세요"); return; }
    if (!confirm(`판매중인 즐겨찾기 상품 중 재고가 ${target}개 미만인 것을 지금 바로 ${target}개로 채웁니다.\n(가격·사양은 그대로 두고 수량만 변경합니다)\n\n계속할까요?`)) return;
    // 즉시 실행은 현재 입력된 목표/계정으로 cfg를 먼저 저장(미저장 시 대비) 후 실행
    chrome.storage.local.get("auto_stock_cfg", d => {
      const cur = d.auto_stock_cfg || {};
      const cfg = { enabled: cur.enabled || false, intervalMin: Number($("fav-as-interval").value) || 60, target, storeId: myStoreId };
      chrome.storage.local.set({ auto_stock_cfg: cfg }, () => {
        st("⏳ 자동 재고 실행 중...");
        chrome.runtime.sendMessage({ type: "RUN_AUTOSTOCK_NOW" }, r => {
          if (chrome.runtime.lastError) {
            st("⚠️ 백그라운드 무응답 — chrome://extensions 에서 확장 새로고침 후 다시 시도");
            return;
          }
          renderAutoStockStatus();
          renderAutoStockLog();
          if (r && r.ok) st(`✅ 자동 재고 실행 완료: ${r.msg || ""}`);
          else st(`⚠️ 자동 재고 실행: ${r?.error || "실패"}`);
          // 백그라운드가 storage의 즐겨찾기 재고를 갱신했으므로 다시 불러와 표에 반영
          if (r && r.favUpdated) {
            loadFavorites().then(() => {
              updateFavCount();
              if (viewMode === "fav") refreshFavViewIfActive();
            });
          } else if (viewMode === "fav") {
            refreshFavViewIfActive();
          }
        });
      });
    });
  });
  // ── 판매내역 버튼 바인딩
  $("ord-refresh")?.addEventListener("click", () => { _ordRows=[]; _ordDotCache={}; _ordDetailCache={}; _loadOrders(1); });
  $("ord-reload")?.addEventListener("click",  () => { _ordDetailCache = {}; _loadOrders(_ordPage); });
  $("ord-status")?.addEventListener("change",  () => { _ordRows=[]; _ordDotCache={}; _loadOrders(1); });
  $("ord-accountstatus")?.addEventListener("change", () => { _ordRows=[]; _ordDotCache={}; _loadOrders(1); });
  $("ord-company")?.addEventListener("change", () => { _ordRows=[]; _ordDotCache={}; _loadOrders(1); });
  $("ord-pattern")?.addEventListener("change", () => { _ordRows=[]; _ordDotCache={}; _loadOrders(1); });
  $("ord-sesstype")?.addEventListener("change", () => { _ordRows=[]; _ordDotCache={}; _loadOrders(1); });
  ["ord-sessnum","ord-code","ord-startdate","ord-enddate"].forEach(id => {
    $(id)?.addEventListener("keydown", e => {
      if (e.key === "Enter") { _ordRows=[]; _ordDotCache={}; _loadOrders(1); }
    });
  });
  $("ord-search")?.addEventListener("input",   () => { clearTimeout(_ordST); _ordST=setTimeout(_applyOrderFilter,200); });
  $("ord-search")?.addEventListener("keydown", e => {
    if (e.key === "Enter") { _ordRows=[]; _ordDotCache={}; _loadOrders(1); }
  });
  $("ord-excel")?.addEventListener("click",    _exportOrdersExcel);
  $("garage-excel")?.addEventListener("click", _exportGarageExcel);
  $("garage-gsheet-settings")?.addEventListener("click", showGSheetSettings);
  $("ord-margintabs-settings")?.addEventListener("click", showMarginTabsSettings);
  $("garage-copy-all")?.addEventListener("click", _copyGarageAll);
  $("garage-status-filter")?.addEventListener("change", () => _renderGarageGrid());
  $("ord-detail-close")?.addEventListener("click", () => {
    const p=$("ord-detail-panel"); if(p) p.style.display="none";
    document.querySelectorAll("#orders-tbody tr").forEach(r=>r.style.outline="");
  });

  $("fav-as-logbtn")?.addEventListener("click", () => {
    const box = $("fav-as-log");
    if (!box) return;
    const show = box.style.display === "none";
    box.style.display = show ? "block" : "none";
    if (show) renderAutoStockLog();
  });

  // 즐겨찾기 백업(파일로 저장)
  $("fav-backup")?.addEventListener("click", () => {
    const n = Object.keys(favData).length;
    if (!n) { alert("백업할 즐겨찾기가 없습니다"); return; }
    const payload = { _type: "tireping_favorites", storeId: myStoreId || "", ts: Date.now(), favData };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const stamp = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `tireping_favorites_${myStoreId || "account"}_${stamp}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    st(`💾 즐겨찾기 ${n}개 백업 파일 저장됨`);
  });
  // 즐겨찾기 복원(파일에서 불러오기)
  $("fav-restore")?.addEventListener("click", () => $("fav-restore-file")?.click());
  $("fav-restore-file")?.addEventListener("change", e => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        const incoming = data && data.favData ? data.favData : data; // 두 형식 모두 허용
        if (!incoming || typeof incoming !== "object") throw new Error("형식 오류");
        const keys = Object.keys(incoming);
        if (!keys.length) { alert("파일에 즐겨찾기가 없습니다"); return; }
        const merge = confirm(`즐겨찾기 ${keys.length}개를 불러옵니다.\n\n확인 = 기존 것과 합치기\n취소 = 불러오기 중단`);
        if (!merge) return;
        for (const k of keys) favData[k] = incoming[k];
        saveFavorites();
        updateFavCount();
        if (viewMode === "fav") refreshFavViewIfActive();
        st(`📂 즐겨찾기 복원 완료 — 현재 ${Object.keys(favData).length}개`);
      } catch (err) {
        alert("복원 실패: 올바른 백업 파일이 아닙니다.\n(" + err.message + ")");
      } finally {
        e.target.value = ""; // 같은 파일 다시 선택 가능하도록
      }
    };
    reader.readAsText(file);
  });

  // ⧉ 팝업창으로 분리
  $("btn-popout")?.addEventListener("click", () => {
    // 현재 사이드패널 URL을 독립 팝업창으로 열기
    chrome.windows.create({
      url: chrome.runtime.getURL("sidebar.html"),
      type: "popup",
      width: 1600,
      height: 900,
      focused: true,
    });
  });

  // shift 키 상태 직접 추적 (e.shiftKey 오감지 방지)
  document.addEventListener("keydown", e => { if (e.key === "Shift") _shiftHeld = true; });
  document.addEventListener("keyup",   e => { if (e.key === "Shift") _shiftHeld = false; });
  window.addEventListener("blur", () => { _shiftHeld = false; }); // 포커스 잃으면 리셋
  // 입력 요소에 포커스 이동 시에도 리셋 (검색창 등 클릭 후 shift 고착 방지)
  document.addEventListener("focusin", e => {
    const tag = e.target?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") _shiftHeld = false;
  });

  // 테이블 이벤트 위임
  $("tbody").addEventListener("click", e => {
    const td = e.target.closest("td");
    const tr = e.target.closest("tr");
    if (!tr) return;
    // shownProducts에서만 찾음 (allProducts 우선 시 필터로 숨겨진 상품 반환 → indexOf=-1 버그)
    const tireId = tr.dataset.tireId || "";
    const dot    = tr.dataset.dot    || "";
    const p = shownProducts.find(x => String(x.tire_id) === tireId && (x.dot || "") === dot);
    if (!p) return;
    const idx = shownProducts.indexOf(p);
    if (idx === -1) return; // 안전장치

    // 📁 거래처 탭 배정 버튼
    // 출고방식 뱃지 클릭 → 변경 팝업
    const skBtnEl = e.target.closest(".sendkind-btn");
    if (skBtnEl) {
      e.preventDefault(); e.stopPropagation();
      const skIdx = Number(skBtnEl.dataset.idx);
      if (_sendkindPopupIdx === skIdx && $("sendkind-popup").style.display !== "none") {
        hideSendKindPopup();
      } else {
        hideSendKindPopup();
        showSendKindPopup(p, skIdx, skBtnEl);
      }
      return;
    }

    const bizBtnEl = e.target.closest(".biz-btn");
    if (bizBtnEl) {
      e.preventDefault(); e.stopPropagation();
      const bizKey = bizBtnEl.dataset.bizkey;
      if (bizKey && bizKey !== "__") {
        if ($("biz-assign-popup").style.display !== "none" && _hideBizAssignPopup._key === bizKey) {
          _hideBizAssignPopup();
        } else {
          _showBizAssignPopup(bizKey, bizBtnEl);
        }
      }
      return;
    }

    // 즐겨찾기 별표 토글 (Shift+클릭 = 마지막 클릭한 별표부터 범위 전체를 한꺼번에 토글)
    if (e.target.closest(".fav-star")) {
      e.preventDefault();
      if (e.shiftKey && _favLastStarIdx != null && shownProducts[_favLastStarIdx]) {
        const lo = Math.min(_favLastStarIdx, idx), hi = Math.max(_favLastStarIdx, idx);
        const turnOn = !isFav(p); // 방금 클릭한 행이 켜지는 방향이면 범위 전체를 켬, 꺼지는 방향이면 범위 전체를 끔
        let changed = 0;
        for (let i = lo; i <= hi; i++) {
          const row = shownProducts[i];
          if (!row || !row.tire_id) continue;
          if (isFav(row) !== turnOn) {
            toggleFav(row);
            changed++;
            // renderTable의 행별 diff가 옛 캐시키를 보고 "변경없음"으로 오판해
            // 별표가 안 바뀐 것처럼 보이는 버그 방지 — 캐시키를 비워 강제로 다시 그리게 함
            if (row._cacheKey) { _rowCache.delete(row._cacheKey); row._cacheKey = ""; }
          }
        }
        st(`⭐ 범위 ${hi - lo + 1}개 중 ${changed}개 ${turnOn ? "즐겨찾기 추가" : "즐겨찾기 해제"}`);
        if (viewMode === "fav") refreshFavViewIfActive();
        else { _lastFilterKey = ""; applyFilters._ref = null; applyFilters(); } // 범위 전체 재렌더
        _favLastStarIdx = idx;
        return;
      }
      toggleFav(p);
      _favLastStarIdx = idx;
      if (viewMode === "fav") refreshFavViewIfActive(); // 즐겨찾기 보기 → 해제 즉시 행 제거
      else refreshRow(p);                                // 검색 보기 → 별표만 갱신
      return;
    }

    // 체크박스
    if (td?.classList.contains("chk-cell")) {
      e.preventDefault();
      if (_shiftHeld && _lastShiftKey !== null) {
        // anchor를 tire_id+dot 키로 관리 → 정렬/필터 후에도 올바른 행 추적
        const anchorIdx = shownProducts.findIndex(
          x => `${x.tire_id}_${x.dot || ""}` === _lastShiftKey
        );
        if (anchorIdx !== -1) {
          const a = Math.min(idx, anchorIdx);
          const b = Math.max(idx, anchorIdx);
          for (let i = a; i <= b; i++) {
            const _k = _idxKey(i);
            if (_k) { _anchorState ? checkedSet.add(_k) : checkedSet.delete(_k); }
          }
        } else {
          // anchor가 현재 shownProducts에 없음(필터로 숨겨짐) → 단독 클릭으로 처리
          toggleCheck(idx);
        }
        rerenderChecks();
        // shift 클릭은 anchor를 이동하지 않음
      } else {
        toggleCheck(idx); // 단독 클릭 → anchor 갱신
      }
      updateSummary(shownProducts);
      return;
    }

    // 최저가↓
    if (e.target.classList.contains("btn-low")) {
      changePrice(p, idx, p.lowest_price - 10); return;
    }
    // 3등↑↑ (second_price - 10)
    if (e.target.classList.contains("btn-raise3")) {
      const p3 = shownProducts[idx];
      if (!p3 || !p3.pid) return;
      const newPrice3 = p3.second_price - 10;
      if (newPrice3 <= 0) return;
      changePrice(p3, idx, newPrice3); return;
    }
    // 2등↑ (경쟁사 1등 -10원 → 내가 최저가 유지하면서 마진 확보)
    if (e.target.classList.contains("btn-raise")) {
      const raiseBase = p.lowest_price > 0 ? p.lowest_price : p.second_price;
      changePrice(p, idx, raiseBase - 10); return;
    }
    // 📤등록
    if (e.target.classList.contains("btn-upload")) {
      openInsertPage(p, true); return;
    }
    // 📦재고입력 (품절/단독판매)
    if (e.target.classList.contains("btn-set-stock")) {
      showStockInputPopup(p, idx); return;
    }
  });

  // ── 가격/DC 인라인 편집
  $("tbody").addEventListener("input", e => {
    const el  = e.target;
    const idx = parseInt(el.dataset.idx, 10);
    if (isNaN(idx) || idx >= shownProducts.length) return;
    const p   = shownProducts[idx];
    const factory = p.factory_price || 0;

    if (el.classList.contains("cell-price-inp")) {
      // 가격 입력 → DC율 자동 계산
      const price = parseInt(el.value, 10) || 0;
      if (factory > 0) {
        const dc = Math.round((factory - price) / factory * 1000) / 10;
        const dcInp = el.closest("tr")?.querySelector(".cell-dc-inp");
        if (dcInp) dcInp.value = dc.toFixed(1);
      }
      // 임시 저장 (저장 전 변경값 보관)
      p._edit_price = price;
      el.style.color = "#dc2626";
      markRowUnsaved(el.closest("tr"), idx);

    } else if (el.classList.contains("cell-dc-inp")) {
      // DC율 입력 → 가격 자동 계산 (타이어핑 방식: ceil(factory*(100-dc)/100/100)*100)
      const dc = parseFloat(el.value) || 0;
      if (factory > 0) {
        const raw   = factory * (100 - dc);
        const price = Math.ceil(raw / 100 / 100) * 100;
        const prInp = el.closest("tr")?.querySelector(".cell-price-inp");
        if (prInp) { prInp.value = price; prInp.style.color = "#dc2626"; }
        p._edit_price = price;
      }
      el.style.color = "#dc2626";
      markRowUnsaved(el.closest("tr"), idx);
    }
  });

  // Enter 키 → 저장
  $("tbody").addEventListener("keydown", e => {
    if (e.key !== "Enter") return;
    const el  = e.target;
    if (!el.classList.contains("cell-price-inp") && !el.classList.contains("cell-dc-inp")) return;
    const idx = parseInt(el.dataset.idx, 10);
    if (isNaN(idx)) return;
    saveCellPrice(idx);
  });

  // ── 체크박스 드래그/텍스트선택 방지 — CSS user-select로 처리
  // mousedown preventDefault는 click 이벤트를 막을 수 있으므로 제거
  // 대신 chk-cell에 user-select:none CSS 적용 (calcRow에서 inline style)

  // ── 인라인 가격/DC 편집
  $("tbody").addEventListener("click", e => {
    const inp = e.target.closest("input.inline-price, input.inline-dc");
    if (!inp || !inp.hasAttribute("readonly")) return;
    // 재고 0(품절) 상품은 편집 불가
    const idx = parseInt(inp.dataset.idx, 10);
    const p   = shownProducts[idx];
    if (!p || p.my_stock === 0 || p.is_soldout) return;
    // readonly 해제 → 편집 모드
    inp.removeAttribute("readonly");
    inp.style.border = "1px solid #2563eb";
    inp.style.background = "#eff6ff";
    inp.style.borderRadius = "3px";
    inp.style.padding = "1px 3px";
    inp.select();
  });

  $("tbody").addEventListener("keydown", e => {
    // 재고 인풋 Enter → 저장 버튼 클릭
    const stockInp = e.target.closest("input.inline-stock");
    if (stockInp) {
      if (e.key === "Enter") {
        const tr = stockInp.closest("tr");
        tr?.querySelector(".btn-save-stock")?.click();
        return;
      }
      if (e.key === "Escape") {
        const idx = parseInt(stockInp.dataset.idx, 10);
        refreshRowByTireId(shownProducts[idx]?.tire_id, shownProducts[idx]?.dot);
        return;
      }
    }
    const inp = e.target.closest("input.inline-price, input.inline-dc");
    if (!inp) return;
    if (e.key === "Enter") { inp.blur(); return; }
    if (e.key === "Escape") {
      const idx = parseInt(inp.dataset.idx, 10);
      refreshRowByTireId(shownProducts[idx]?.tire_id, shownProducts[idx]?.dot);
    }
  });

  $("tbody").addEventListener("input", e => {
    const inp = e.target;
    const idx = parseInt(inp.dataset.idx, 10);
    if (isNaN(idx)) return;
    const p = shownProducts[idx];
    if (!p || !p.is_mine) return;
    const factory = p.factory_price || 0;

    if (inp.classList.contains("inline-price")) {
      // 가격 입력 → DC율 자동계산 (factory=0이면 DC 연동 스킵, 편집은 허용)
      const price = parseInt(inp.value.replace(/,/g, ""), 10) || 0;
      const dcEl  = inp.closest("tr")?.querySelector("input.inline-dc");
      if (dcEl && factory > 0) {
        dcEl.value = (100 - (price * 100 / factory)).toFixed(1);
      } else if (dcEl && factory === 0) {
        dcEl.value = "-"; // 공장도가 없으면 DC% 표시 불가 안내
      }
    } else if (inp.classList.contains("inline-dc")) {
      // DC율 입력 → 가격 자동계산 (factory=0이면 연동 불가)
      const dc      = parseFloat(inp.value) || 0;
      const priceEl = inp.closest("tr")?.querySelector("input.inline-price");
      if (priceEl && factory > 0) {
        let v = factory * (100 - dc);
        v = Math.ceil(v / 100) / 100 * 100;
        priceEl.value = Math.floor(v);
      }
    }
  });

  // ── 판매재고 인라인 편집
  $("tbody").addEventListener("click", e => {
    const inp = e.target.closest("input.inline-stock");
    if (!inp || !inp.hasAttribute("readonly")) return;
    inp.removeAttribute("readonly");
    inp.style.border = "1px solid #f59e0b";
    inp.style.background = "#fffbeb";
    inp.style.borderRadius = "3px";
    // 저장 버튼 표시
    const tr = inp.closest("tr");
    tr?.querySelector(".btn-save-stock")?.style.setProperty("display", "inline-block");
    inp.select();
  }, true);

  $("tbody").addEventListener("change", async e => {
    const inp = e.target.closest("input.inline-stock");
    if (!inp || inp.hasAttribute("readonly")) return;
    const idx = parseInt(inp.dataset.idx, 10);
    if (isNaN(idx)) return;
    const p = shownProducts[idx];
    if (!p?.is_mine) return;
    const newStock = parseInt(inp.value, 10);
    if (isNaN(newStock) || newStock < 0) { inp.value = p.my_stock; return; }
    // 값 변경 표시
    inp.style.color = "#d97706";
  });

  // 저장 버튼 클릭
  $("tbody").addEventListener("click", async e => {
    const btn = e.target.closest(".btn-save-stock");
    if (!btn) return;
    const tr = btn.closest("tr");
    const tireId = tr?.dataset.tireId || "";
    const dot    = tr?.dataset.dot    || "";
    const p = shownProducts.find(x => String(x.tire_id) === tireId && (x.dot || "") === dot);
    if (!p?.is_mine) return;
    const idx = shownProducts.indexOf(p);
    const inp = tr?.querySelector("input.inline-stock");
    if (!inp) return;
    const newStock = parseInt(inp.value, 10);
    if (isNaN(newStock) || newStock < 0) { alert("올바른 수량을 입력하세요"); return; }
    // readonly 복구
    inp.setAttribute("readonly", "");
    inp.style.border = "none";
    inp.style.background = "transparent";
    inp.style.color = "";
    btn.style.display = "none";
    await changeStock(p, idx, newStock);
  });

  $("tbody").addEventListener("blur", async e => {
    const inp = e.target.closest("input.inline-price, input.inline-dc");
    if (!inp) return;
    if (inp.hasAttribute("readonly")) return;
    const idx = parseInt(inp.dataset.idx, 10);
    if (isNaN(idx)) return;
    const p = shownProducts[idx];
    if (!p || !p.is_mine) return;

    // 값 읽기
    const tr      = inp.closest("tr");
    const priceEl = tr?.querySelector("input.inline-price");
    const dcEl    = tr?.querySelector("input.inline-dc");
    const newPrice = parseInt(priceEl?.value?.replace(/,/g, ""), 10) || p.my_price;
    const newDc    = parseFloat(dcEl?.value) || p.dc_rate;

    // 변경 없으면 스킵
    if (newPrice === p.my_price) {
      inp.setAttribute("readonly", "");
      inp.style.border = "none";
      inp.style.background = "transparent";
      inp.style.padding = "";
      return;
    }

    // 저장 확인
    if (!confirm(`${p.product} ${p.size}
판매가 ${comma(newPrice)}원 (DC ${newDc}%)로 변경할까요?`)) {
      refreshRowByTireId(p.tire_id, p.dot);
      return;
    }

    st(`⏳ ${p.product} ${p.size} 저장 중...`);
    const res = await savePrice(p.pid, newPrice, p.my_stock);
    if (res.ok) {
      p.my_price = newPrice;
      p.dc_rate  = newDc;
    // 내 가격 즉시 반영
    calcDerivedFields(p);
    refreshRowByTireId(p.tire_id, p.dot);
    st(`⏳ ${p.product} ${p.size} → ${comma(newPrice)}원 저장됨 (시장가 조회 중...)`);
    // 경쟁가 백그라운드 갱신
    clearLowestCache(p.tire_id, p.dot);
    const [low2, sec2, mlow2, , rank2] = await fetchOneLowest(p);
    p.lowest_price = low2 || p.lowest_price; p.second_price = sec2 || p.second_price; p.market_lowest = mlow2; p.my_rank = rank2||0;
    recalc(p);
    refreshRowByTireId(p.tire_id, p.dot);
    st(`✅ ${p.product} ${p.size} → ${comma(newPrice)}원 저장 완료 (${p._status})`);
    } else {
      st(`❌ 저장 실패: ${res.msg}`);
      refreshRowByTireId(p.tire_id, p.dot);
    }
  }, true);  // capture=true for blur

  // ── 인라인 원가율(%) 편집 — "원가" 컬럼 클릭 시 금액 대신 원가율(%)을 입력받아 저장
  $("tbody").addEventListener("click", e => {
    const inp = e.target.closest("input.inline-costrate");
    if (!inp || !inp.hasAttribute("readonly")) return;
    const idx = parseInt(inp.dataset.idx, 10);
    const p   = shownProducts[idx];
    if (!p || !p.factory_price) return;
    inp.removeAttribute("readonly");
    inp.value = inp.dataset.rate; // 표시값(원가 금액) → 편집값(원가율 %)으로 전환
    inp.style.border = "1px solid #2563eb";
    inp.style.background = "#eff6ff";
    inp.style.borderRadius = "3px";
    inp.style.padding = "1px 3px";
    inp.title = "원가율(%) 입력 후 Enter";
    inp.select();
  });

  $("tbody").addEventListener("keydown", e => {
    const inp = e.target.closest("input.inline-costrate");
    if (!inp) return;
    if (e.key === "Enter") { inp.blur(); return; }
    if (e.key === "Escape") {
      const idx = parseInt(inp.dataset.idx, 10);
      refreshRowByTireId(shownProducts[idx]?.tire_id, shownProducts[idx]?.dot);
    }
  });

  $("tbody").addEventListener("blur", async e => {
    const inp = e.target.closest("input.inline-costrate");
    if (!inp || inp.hasAttribute("readonly")) return;
    const idx = parseInt(inp.dataset.idx, 10);
    const p   = shownProducts[idx];
    inp.setAttribute("readonly", "");
    inp.style.border = "none";
    inp.style.background = "transparent";
    inp.style.padding = "";
    if (!p) return;

    const raw  = inp.value.trim();
    const rate = raw === "" ? null : parseFloat(raw);
    if (rate !== null && (isNaN(rate) || rate < 0 || rate > 100)) {
      alert("원가율은 0~100 사이 숫자(%)로 입력하세요");
      refreshRowByTireId(p.tire_id, p.dot);
      return;
    }
    const hadOverride = costRateOverrides[_costKey(p)] !== undefined;
    if (rate === effectiveCostRate(p) && (rate !== null || !hadOverride)) {
      refreshRowByTireId(p.tire_id, p.dot); // 변경 없음
      return;
    }
    await saveCostRateOverride(p, rate);
    refreshRowByTireId(p.tire_id, p.dot);
  }, true); // capture=true for blur

  // ── 인라인 택배비 편집 — "택배" 컬럼 클릭 시 금액(원) 직접 입력
  $("tbody").addEventListener("click", e => {
    const inp = e.target.closest("input.inline-shipping");
    if (!inp || !inp.hasAttribute("readonly")) return;
    const idx = parseInt(inp.dataset.idx, 10);
    const p   = shownProducts[idx];
    if (!p || !p.is_mine) return;
    inp.removeAttribute("readonly");
    inp.value = effectiveShippingCost(p) || "";
    inp.style.border = "1px solid #2563eb";
    inp.style.background = "#eff6ff";
    inp.style.borderRadius = "3px";
    inp.style.padding = "1px 3px";
    inp.title = "택배비(원) 입력 후 Enter";
    inp.select();
  });

  $("tbody").addEventListener("keydown", e => {
    const inp = e.target.closest("input.inline-shipping");
    if (!inp) return;
    if (e.key === "Enter") { inp.blur(); return; }
    if (e.key === "Escape") {
      const idx = parseInt(inp.dataset.idx, 10);
      refreshRowByTireId(shownProducts[idx]?.tire_id, shownProducts[idx]?.dot);
    }
  });

  $("tbody").addEventListener("blur", async e => {
    const inp = e.target.closest("input.inline-shipping");
    if (!inp || inp.hasAttribute("readonly")) return;
    const idx = parseInt(inp.dataset.idx, 10);
    const p   = shownProducts[idx];
    inp.setAttribute("readonly", "");
    inp.style.border = "none";
    inp.style.background = "transparent";
    inp.style.padding = "";
    if (!p) return;

    const raw  = inp.value.trim().replace(/,/g, "");
    const cost = raw === "" ? null : parseInt(raw, 10);
    if (cost !== null && (isNaN(cost) || cost < 0 || cost > 100000)) {
      alert("택배비는 0~100,000 사이 숫자(원)로 입력하세요");
      refreshRowByTireId(p.tire_id, p.dot);
      return;
    }
    const hadOverride = shippingCostOverrides[_costKey(p)] !== undefined;
    if (cost === effectiveShippingCost(p) && (cost !== null || !hadOverride)) {
      refreshRowByTireId(p.tire_id, p.dot); // 변경 없음
      return;
    }
    await saveShippingCostOverride(p, cost);
    refreshRowByTireId(p.tire_id, p.dot);
  }, true); // capture=true for blur

  // ── 인라인 DOT 편집 — "DOT" 컬럼 클릭 시 생산년도 직접 입력 (내 상품만)
  $("tbody").addEventListener("click", e => {
    const inp = e.target.closest("input.inline-dot");
    if (!inp || !inp.hasAttribute("readonly")) return;
    const idx = parseInt(inp.dataset.idx, 10);
    const p   = shownProducts[idx];
    if (!p || !p.is_mine) return;
    inp.removeAttribute("readonly");
    inp.style.border = "1px solid #2563eb";
    inp.style.background = "#eff6ff";
    inp.style.borderRadius = "3px";
    inp.style.padding = "1px 3px";
    inp.title = "DOT(생산년도, 4자리) 입력 후 Enter";
    inp.select();
  });

  $("tbody").addEventListener("keydown", e => {
    const inp = e.target.closest("input.inline-dot");
    if (!inp) return;
    if (e.key === "Enter") { inp.blur(); return; }
    if (e.key === "Escape") {
      const idx = parseInt(inp.dataset.idx, 10);
      refreshRowByTireId(shownProducts[idx]?.tire_id, shownProducts[idx]?.dot);
    }
  });

  $("tbody").addEventListener("blur", async e => {
    const inp = e.target.closest("input.inline-dot");
    if (!inp || inp.hasAttribute("readonly")) return;
    const idx = parseInt(inp.dataset.idx, 10);
    const p   = shownProducts[idx];
    inp.setAttribute("readonly", "");
    inp.style.border = "none";
    inp.style.background = "transparent";
    inp.style.padding = "";
    if (!p) return;

    const raw = inp.value.trim();
    const dot = raw === "" ? "" : _normDot(raw);
    if (raw !== "" && !dot) {
      alert("DOT는 4자리 연도(예: 2024)로 입력하세요");
      refreshRowByTireId(p.tire_id, p.dot);
      return;
    }
    if (dot === (p.dot || "")) {
      refreshRowByTireId(p.tire_id, p.dot); // 변경 없음
      return;
    }
    const oldDot = p.dot;
    await saveDotOverride(p, dot || null);
    p.dot = dot;
    refreshRowByTireId(p.tire_id, oldDot);
  }, true); // capture=true for blur

  // ── 인라인 출고기준시간 편집 — 상품 1개만 개별로 시:분 직접 입력 (내 상품만)
  $("tbody").addEventListener("click", e => {
    const inp = e.target.closest("input.inline-sendtime");
    if (!inp || !inp.hasAttribute("readonly")) return;
    const idx = parseInt(inp.dataset.idx, 10);
    const p   = shownProducts[idx];
    if (!p || !p.is_mine || !p.pid) return;
    inp.removeAttribute("readonly");
    inp.style.border = "1px solid #2563eb";
    inp.style.background = "#eff6ff";
    inp.style.borderRadius = "3px";
    inp.style.padding = "1px 3px";
    inp.title = "출고기준시간(예: 15:00) 입력 후 Enter";
    inp.select();
  });

  $("tbody").addEventListener("keydown", e => {
    const inp = e.target.closest("input.inline-sendtime");
    if (!inp) return;
    if (e.key === "Enter") { inp.blur(); return; }
    if (e.key === "Escape") {
      const idx = parseInt(inp.dataset.idx, 10);
      refreshRowByTireId(shownProducts[idx]?.tire_id, shownProducts[idx]?.dot);
    }
  });

  $("tbody").addEventListener("blur", async e => {
    const inp = e.target.closest("input.inline-sendtime");
    if (!inp || inp.hasAttribute("readonly")) return;
    const idx = parseInt(inp.dataset.idx, 10);
    const p   = shownProducts[idx];
    inp.setAttribute("readonly", "");
    inp.style.border = "none";
    inp.style.background = "transparent";
    inp.style.padding = "";
    if (!p) return;

    const raw = inp.value.trim();
    if (raw === (p.send_time || "")) { refreshRowByTireId(p.tire_id, p.dot); return; } // 변경 없음
    const m = raw.match(/^(\d{1,2}):(\d{2})$/);
    if (!m) {
      alert("출고기준시간은 HH:MM 형식으로 입력하세요 (예: 15:00)");
      refreshRowByTireId(p.tire_id, p.dot);
      return;
    }
    const hour = m[1].padStart(2, "0");
    const min  = m[2];
    if (Number(hour) < 0 || Number(hour) > 18 || !["00","10","20","30","40","50"].includes(min)) {
      alert("시간은 00~18시, 분은 00/10/20/30/40/50 중에서 입력하세요");
      refreshRowByTireId(p.tire_id, p.dot);
      return;
    }
    if (!p.pid) { st("⚠️ pid 없음 — 저장 불가"); refreshRowByTireId(p.tire_id, p.dot); return; }
    st(`⏳ 출고기준시간 변경 중...`);
    const res = await setSendTime(p.pid, hour, min);
    if (res.ok) {
      p.send_time = `${hour}:${min}`;
      if (p._cacheKey) { _rowCache.delete(p._cacheKey); p._cacheKey = ""; }
      refreshRow(p);
      st(`✅ 출고기준시간 ${hour}:${min}으로 변경 완료`);
    } else {
      st(`❌ 출고기준시간 변경 실패: ${res.msg}`);
      refreshRowByTireId(p.tire_id, p.dot);
    }
  }, true); // capture=true for blur

  // ── 행사상품 최저가 버튼 (내 판매현황 탭 전용)
  $("tbody").addEventListener("click", e => {
    const btn = e.target.closest(".btn-event-low");
    if (!btn) return;
    applyEventLowest(parseInt(btn.dataset.idx, 10));
  });

  // ── 구매제한(짝수출고) 토글 — 상품 1개만 개별 클릭으로 변경
  $("tbody").addEventListener("click", async e => {
    const badge = e.target.closest(".evensell-btn");
    if (!badge) return;
    const idx = parseInt(badge.dataset.idx, 10);
    const p   = shownProducts[idx];
    if (!p || !p.is_mine || !p.pid) return;
    const cur = p._evensell === 1 ? 1 : 0;
    const next = cur === 1 ? 0 : 1;
    const label = next === 1 ? "🔒 짝수구매만" : "🔓 제한없음";
    if (!confirm(`이 상품만 구매제한을 [${label}]으로 변경할까요?`)) return;
    st(`⏳ 구매제한 변경 중...`);
    const res = await setEvensell(p.pid, next);
    if (res.ok) {
      p._evensell = next;
      if (p._cacheKey) { _rowCache.delete(p._cacheKey); p._cacheKey = ""; }
      refreshRow(p);
      st(`✅ 구매제한 [${label}]으로 변경 완료`);
    } else {
      st(`❌ 구매제한 변경 실패: ${res.msg}`);
    }
  });

  // 더블클릭 → 미판매 등록 (auto_submit=true: 채우고 저장까지 자동)
  $("tbody").addEventListener("dblclick", e => {
    // 인라인 편집 input 위 더블클릭은 무시 (텍스트 선택 동작과 충돌)
    if (e.target.closest("input")) return;
    const tr = e.target.closest("tr");
    if (!tr) return;
    // shownProducts에서만 찾음 (필터로 숨겨진 상품 제외)
    const tireId = tr.dataset.tireId || "";
    const dot    = tr.dataset.dot    || "";
    const p = shownProducts.find(x => String(x.tire_id) === tireId && (x.dot || "") === dot);
    if (p && !p.is_mine) openInsertPage(p, true);
  });

  // 헤더 이벤트는 renderTable 안에서 직접 바인딩됨

  // 액션바 우클릭 → 컬럼 필터 선택 팝업

  // ── 엑셀 다운로드 (현재 화면 shownProducts → XLSX → 꾸민 형태)
  document.getElementById("btn-excel").addEventListener("click", () => {
    if (!shownProducts || !shownProducts.length) {
      alert("다운로드할 데이터가 없습니다.");
      return;
    }

    // ── 차이값 텍스트 계산 (calcDerivedFields의 _diff_val 기반)
    const _diffText = p => {
      if (!p.is_mine) return "";
      calcDerivedFields(p);
      if (p._diff_val === null || p._diff_val === undefined) return "";
      if (p._diff_val === 0) return "최저가(동가)";
      if (p._diff_val < 0)  return `+${Math.abs(p._diff_val)}`; // 내가 더 쌈 → 양수
      return `-${p._diff_val}`;                                   // 비최저가 → 음수
    };

    // ── 엑셀 XML 생성 (SpreadsheetML — 외부 라이브러리 없이 스타일 지원)
    const headers = [
      "제조사","제품명","사이즈","세부정보","DOT",
      "공장도가","시장최저가","내가격","내DC%","경쟁DC%",
      "경쟁최저가","경쟁판매점","내순위","2등가격","차이",
      "내재고","시장재고","상태","판매여부"
    ];

    const _esc  = s => String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
    const _num  = v => (v !== "" && v !== null && v !== undefined && !isNaN(Number(v))) ? `<Data ss:Type="Number">${Number(v)}</Data>` : `<Data ss:Type="String">${_esc(v)}</Data>`;
    const _str  = v => `<Data ss:Type="String">${_esc(v)}</Data>`;

    // 스타일 ID
    // 1=헤더, 2=일반, 3=숫자, 4=양수(초록), 5=음수(빨강), 6=최저가행, 7=품절행, 8=DC%
    const styles = `
  <Styles>
    <Style ss:ID="1">
      <Alignment ss:Horizontal="Center" ss:Vertical="Center" ss:WrapText="1"/>
      <Borders>
        <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#AAAAAA"/>
        <Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#CCCCCC"/>
      </Borders>
      <Font ss:Bold="1" ss:Size="10" ss:Color="#FFFFFF"/>
      <Interior ss:Color="#1E3A5F" ss:Pattern="Solid"/>
    </Style>
    <Style ss:ID="2">
      <Alignment ss:Vertical="Center"/>
      <Borders>
        <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E8E8E8"/>
        <Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E8E8E8"/>
      </Borders>
      <Font ss:Size="10"/>
    </Style>
    <Style ss:ID="3">
      <Alignment ss:Horizontal="Right" ss:Vertical="Center"/>
      <Borders>
        <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E8E8E8"/>
        <Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E8E8E8"/>
      </Borders>
      <Font ss:Size="10"/>
      <NumberFormat ss:Format="#,##0"/>
    </Style>
    <Style ss:ID="4">
      <Alignment ss:Horizontal="Right" ss:Vertical="Center"/>
      <Borders>
        <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E8E8E8"/>
        <Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E8E8E8"/>
      </Borders>
      <Font ss:Size="10" ss:Color="#16A34A" ss:Bold="1"/>
      <NumberFormat ss:Format="+#,##0;-#,##0;동가"/>
    </Style>
    <Style ss:ID="5">
      <Alignment ss:Horizontal="Right" ss:Vertical="Center"/>
      <Borders>
        <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E8E8E8"/>
        <Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E8E8E8"/>
      </Borders>
      <Font ss:Size="10" ss:Color="#DC2626" ss:Bold="1"/>
      <NumberFormat ss:Format="+#,##0;-#,##0;동가"/>
    </Style>
    <Style ss:ID="6">
      <Alignment ss:Vertical="Center"/>
      <Borders>
        <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E8E8E8"/>
        <Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E8E8E8"/>
      </Borders>
      <Font ss:Size="10"/>
      <Interior ss:Color="#F0FDF4" ss:Pattern="Solid"/>
    </Style>
    <Style ss:ID="7">
      <Alignment ss:Vertical="Center"/>
      <Borders>
        <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E8E8E8"/>
        <Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E8E8E8"/>
      </Borders>
      <Font ss:Size="10"/>
      <Interior ss:Color="#FEF2F2" ss:Pattern="Solid"/>
    </Style>
    <Style ss:ID="8">
      <Alignment ss:Horizontal="Right" ss:Vertical="Center"/>
      <Borders>
        <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E8E8E8"/>
        <Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E8E8E8"/>
      </Borders>
      <Font ss:Size="10"/>
      <NumberFormat ss:Format="0.0&quot;%&quot;"/>
    </Style>
  </Styles>`;

    // 컬럼 폭 (단위: pt)
    const colWidths = [55,130,65,80,35,65,65,65,40,40,65,50,35,65,55,40,40,55,35];

    const colDefs = colWidths.map(w => `<Column ss:Width="${w}"/>`).join("");

    // 헤더행
    const headerRow = `<Row ss:Height="22">${headers.map(h =>
      `<Cell ss:StyleID="1"><${_str(h)}></Cell>`
    ).join("")}</Row>`;

    // 데이터행
    const dataRows = shownProducts.map(p => {
      calcDerivedFields(p);
      const isMine   = p.is_mine;
      const isSoldout= isMine && (p.my_stock === 0 || p.is_soldout);
      const isLow    = isMine && p._statusOrder === 2;
      const baseStyle= isSoldout ? "7" : (isLow ? "6" : "2");
      const numStyle = isSoldout ? "7" : (isLow ? "6" : "3");
      const dcStyle  = isSoldout ? "7" : (isLow ? "6" : "8");

      const diffText = _diffText(p);
      let diffStyle  = baseStyle;
      if (diffText.startsWith("+")) diffStyle = "4";
      else if (diffText.startsWith("-")) diffStyle = "5";

      const dcRate = p.dc_rate  ? p.dc_rate.toFixed(1)  : "";
      // 경쟁DC: lowest_price 없으면 market_lowest로 폴백 (화면 표시와 동일)
      const _compBase = p.lowest_price || p.market_lowest || 0;
      const compDc = (p.factory_price && _compBase)
        ? ((1 - _compBase / p.factory_price) * 100).toFixed(1) : "";

      const C = (styleId, dataXml) => `<Cell ss:StyleID="${styleId}">${dataXml}</Cell>`;
      return `<Row ss:Height="18">`
        + C(baseStyle, _str(p.manufacturer))
        + C(baseStyle, _str(p.product))
        + C(baseStyle, _str(p.size))
        + C(baseStyle, _str(p.detail || ""))
        + C(baseStyle, _str(p.dot || ""))
        + C(numStyle,  _num(p.factory_price || ""))
        + C(numStyle,  _num(p.market_lowest || ""))
        + C(numStyle,  _num(p.my_price || ""))
        + C(dcStyle,   _num(dcRate))
        + C(dcStyle,   _num(compDc))
        + C(numStyle,  _num(p.lowest_price || ""))
        + C(baseStyle, _str(p.lowest_seller || ""))
        + C(baseStyle, _num(p.my_rank || ""))
        + C(numStyle,  _num(p.second_price || ""))
        + (() => {
          // 차이를 숫자로 저장 → 엑셀에서 숫자 정렬 가능
          // _diff_val: 양수=비최저가, 음수=내가더쌈, 0=동가, null=해당없음
          // 화면과 반대 부호로 저장 (비최저가=-값, 내가더쌈=+값) → 직관적 정렬
          if (p._diff_val === null || p._diff_val === undefined) return C(baseStyle, _str(""));
          if (p._diff_val === 0) return C(baseStyle, _str("동가"));
          const numVal = -p._diff_val; // 부호 반전: 비최저가→음수, 내가더쌈→양수
          return C(diffStyle, `<Data ss:Type="Number">${numVal}</Data>`);
        })()
        + C(baseStyle, _num(p.my_stock !== undefined ? p.my_stock : ""))
        + C(baseStyle, _num(p.market_stock || ""))
        + C(baseStyle, _str((p._status || "").replace(/[🔴✅❌⚠️⬜]/gu, "").trim()))
        + C(baseStyle, _str(isMine ? "Y" : "N"))
        + `</Row>`;
    }).join("");

    const now = new Date();
    const ts  = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,"0")}${String(now.getDate()).padStart(2,"0")}_${String(now.getHours()).padStart(2,"0")}${String(now.getMinutes()).padStart(2,"0")}`;

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:x="urn:schemas-microsoft-com:office:excel">
  <DocumentProperties xmlns="urn:schemas-microsoft-com:office:office">
    <Created>${now.toISOString()}</Created>
  </DocumentProperties>
  <ExcelWorkbook xmlns="urn:schemas-microsoft-com:office:excel">
    <WindowHeight>9000</WindowHeight><WindowWidth>18000</WindowWidth>
    <ActiveSheet>0</ActiveSheet>
  </ExcelWorkbook>
  ${styles}
  <Worksheet ss:Name="타이어핑_${ts}">
    <Table>${colDefs}${headerRow}${dataRows}</Table>
    <WorksheetOptions xmlns="urn:schemas-microsoft-com:office:excel">
      <FreezePanes/><FrozenNoSplit/>
      <SplitHorizontal>1</SplitHorizontal><TopRowBottomPane>1</TopRowBottomPane>
      <ActivePane>2</ActivePane>
    </WorksheetOptions>
  </Worksheet>
</Workbook>`;

    const blob = new Blob([xml], { type: "application/vnd.ms-excel;charset=utf-8;" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href     = url;
    a.download = `타이어핑_${ts}.xls`;
    a.click();
    URL.revokeObjectURL(url);
  });

  $("action-bar").addEventListener("contextmenu", e => {
    e.preventDefault();
    showColumnFilterPicker(e.clientX, e.clientY);
  });
});

// 예전 리사이즈 핸들 기능이 남겨둔 저장값 정리 (폭 강제로 인한 잘림 재발 방지)
chrome.storage.local.remove("sidebar_width");
