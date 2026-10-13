// ── 계정별 storage 키 헬퍼 (sidebar.js의 myStoreId 공유) ────
function stockAcctKey(base) {
  const id = (typeof myStoreId !== "undefined" && myStoreId) ? myStoreId : "";
  return id ? `${base}__${id}` : base;
}

// 계정 전환 시 stock.js 상태 초기화 및 URL 재로드
window.onAccountSwitch = async function() {
  scriptUrl = "";
  stockData = [];
  stockFiltered = [];
  $("stock-tbody").innerHTML = "";
  $("stock-summary").textContent = "";
  $("stock-empty").style.display = "block";
  stSt("계정 전환됨 — 새로고침 해주세요");
  await loadScriptUrl();
};

// ═══════════════════════════════════════════════════════════════
// stock.js - 재고 관리 탭
// 구글 시트 ↔ 타이어핑 양방향 연동
// 컬럼: A브랜드 B패턴 C패턴코드 D사이즈 E피수 F DOT G공장도가
//       H수량 I변동재고 J장착수량 K당일직배송 L당일택배
//       M택배핑&호성 N직배송핑&호성 O11번가 P스토어팜
//       Q롯데온&쿠팡 R매일할인율 S원가 T tire_id U제품번호
// ═══════════════════════════════════════════════════════════════

let stockItems     = [];
let scriptUrl      = "";
let stockSyncTimer = null;

// ── 초기화 ───────────────────────────────────────────────────
const DEFAULT_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbwF3gRg_azet7k1DQmKxTM2R-q6ChrYVyJV6cy32hmzf2YPiKb9ArjmShpFxusx-8QcjA/exec";

async function initStock() {
  const key = stockAcctKey("stock_script_url");
  const r = await chromeStockGet([key]);
  scriptUrl = r[key] || DEFAULT_SCRIPT_URL;

  // 저장된 URL 없으면 기본값 자동 저장
  if (!r[key]) {
    await chromeStockSet({ [key]: scriptUrl });
  }

  $("stock-inp-url").value = scriptUrl;
  await testConnection();
  await loadStock();
  startSyncPoller();
  bindStockEvents();
}

function bindStockEvents() {
  $("stock-btn-save-url").addEventListener("click", async () => {
    scriptUrl = $("stock-inp-url").value.trim();
    if (!scriptUrl) { stSt("❌ URL 입력 필요"); return; }
    await chromeStockSet({ [stockAcctKey("stock_script_url")]: scriptUrl });
    await testConnection();
    await loadStock();
    // startSyncPoller은 initStock에서 이미 호출됨 — 중복 등록 방지를 위해 여기선 호출 안 함
    // (startSyncPoller 내부에서 clearInterval 후 새로 생성하므로 중복은 없지만
    //  URL 변경 시마다 loadStock이 두 번 호출되는 낭비 제거)
  });

  $("stock-btn-test")?.addEventListener("click", testConnection);
  $("stock-btn-refresh")?.addEventListener("click", loadStock);
  $("stock-btn-search")?.addEventListener("click", applyStockSearch);
  $("stock-inp-search")?.addEventListener("keydown", e => { if (e.key === "Enter") applyStockSearch(); });
  $("stock-sel-sheet")?.addEventListener("change", loadStock);  // 시트 변경 시 재로드
  $("stock-sel-status")?.addEventListener("change", filterStockTable);
  $("stock-btn-setting")?.addEventListener("click", () => {
    const p = $("stock-setting-panel");
    if (p) p.style.display = p.style.display === "none" ? "block" : "none";
  });
  $("stock-btn-sync-now")?.addEventListener("click", async () => {
    stSt("⏳ 동기화 중...");
    await syncFromSheet();
    stSt("✅ 동기화 완료");
  });
  document.getElementById("stock-log-toggle")?.addEventListener("click", () => {
    const l = $("stock-sync-log");
    if (l) l.style.display = l.style.display === "none" ? "block" : "none";
  });
  $("stock-btn-match")?.addEventListener("click", () => autoMatchTireId(false));
  $("stock-btn-rematch")?.addEventListener("click", () => autoMatchTireId(true));

  // 미판매 뱃지 클릭
  $("stock-tbody").addEventListener("click", e => {
    const btn = e.target.closest(".s-unlisted-btn");
    if (btn) registerFromStock(btn.dataset.tire, btn.dataset.brand);
  });

  // 인라인 셀 편집 (싱글클릭)
  $("stock-tbody").addEventListener("click", e => {
    const td = e.target.closest("td.s-editable");
    if (!td || td.querySelector("input")) return; // 이미 편집 중이면 스킵
    startEditCell(td);
  });

  // 수량 인라인 수정
  $("stock-tbody").addEventListener("change", async e => {
    if (!e.target.classList.contains("qty-inp")) return;
    const tr  = e.target.closest("tr");
    const qty = parseInt(e.target.value, 10);
    if (isNaN(qty) || qty < 0 || qty > 99999) return;
    await setQty(tr.dataset.sheet, parseInt(tr.dataset.row, 10), qty, e.target);
  });

  // tire_id 직접 입력
  $("stock-tbody").addEventListener("change", async e => {
    if (!e.target.classList.contains("tire-id-inp")) return;
    const tr      = e.target.closest("tr");
    const tire_id = e.target.value.trim();
    stSt("⏳ tire_id 저장 중...");
    const r = await sheetPost("bulk_set_tire_id", {
      items: [{ sheet: tr.dataset.sheet, row: parseInt(tr.dataset.row, 10), tire_id }]
    });
    if (r.ok) {
      e.target.style.background = "#f0fdf4";
      stSt(`✅ tire_id 저장`);
      const idx = parseInt(tr.dataset.idx, 10);
      if (stockItems[idx]) stockItems[idx].tire_id = tire_id;
    }
  });
}

// ── 연결 확인 ─────────────────────────────────────────────────
async function testConnection() {
  stSt("🔗 연결 확인 중...");
  try {
    const r = await sheetGet("ping");
    if (r.ok) {
      stSt(`✅ 연결 성공 (${r.time})`);
      const el = $("stock-conn-status");
      if (el) { el.textContent = "🟢"; el.title = "연결됨"; }
      const nm = $("stock-sheet-name");
      if (nm) nm.textContent = "구글 시트 연결됨";
    } else throw new Error(r.msg);
  } catch(e) {
    stSt("❌ " + e.message);
    const el = $("stock-conn-status");
    if (el) el.textContent = "🔴";
  }
}

// ── 재고 로드 ─────────────────────────────────────────────────
// 전체 재고 데이터 캐시
let _allStockItems = [];

async function loadStock() {
  if (!scriptUrl) { stSt("❌ URL을 먼저 입력하세요"); return; }
  stSt("⏳ 시트 데이터 로드 중...");
  try {
    const r = await sheetGet("get_all");
    if (!r.ok) throw new Error(r.msg);
    _allStockItems = (r.items || []).map(item => {
      // DOT: "2026", "2025" 같은 4자리 연도만 유효, 없거나 다른 값이면 ""로 정제
      const rawDot = String(item.dot || "").trim();
      const validDot = (rawDot.match(/\b(20\d{2})\b/) || [])[1] || "";
      return { ...item, dot: validDot };
    });
    applyStockSearch();
    stSt(`✅ ${_allStockItems.length}개 로드 완료`);
  } catch(e) { stSt("❌ " + e.message); }
}

function applyStockSearch() {
  const keyword = ($("stock-inp-search")?.value.trim() || "").toLowerCase();
  if (!keyword) {
    stockItems = [..._allStockItems];
  } else {
    const isSize = /^\d/.test(keyword);
    stockItems = _allStockItems.filter(p => {
      if (isSize) {
        const sz = (p.size_raw || p.size || "").replace(/\s+/g,"").toLowerCase();
        return sz.includes(keyword.replace(/\s+/g,""));
      }
      return (p.brand||"").toLowerCase().includes(keyword)
          || (p.pattern||"").toLowerCase().includes(keyword)
          || (p.pcode||"").toLowerCase().includes(keyword);
    });
  }
  filterStockTable();
}

// ── 필터 ──────────────────────────────────────────────────────
function filterStockTable() {
  const status = $("stock-sel-status")?.value || "";
  let filtered = [...stockItems];
  if (status === "soldout")  filtered = filtered.filter(p => p.qty === 0);
  else if (status === "low") filtered = filtered.filter(p => p.qty > 0 && p.qty <= 3);
  else if (status === "ok")  filtered = filtered.filter(p => p.qty > 3);
  else if (status === "noid") filtered = filtered.filter(p => !p.tire_id);
  else if (status === "unlisted") filtered = filtered.filter(p => p.ping_status === "⚠️ 미판매");
  renderStockTable(filtered);
}

// ── 테이블 렌더링 ─────────────────────────────────────────────
function renderStockTable(items) {
  const tbody = $("stock-tbody");
  if (!items.length) {
    tbody.innerHTML = `<tr><td colspan="22" style="text-align:center;padding:20px;color:#9ca3af;">데이터 없음</td></tr>`;
    $("stock-empty")?.style && ($("stock-empty").style.display = "block");
    updateStockSummary([]);
    return;
  }
  if ($("stock-empty")) $("stock-empty").style.display = "none";

  tbody.innerHTML = items.map((p, i) => {
    const qtyColor = p.qty === 0 ? "#dc2626" : p.qty <= 3 ? "#d97706" : "#16a34a";
    const tidBg    = p.tire_id ? "#f0fdf4" : "#fef9c3";

    const badge = p.qty === 0
      ? '<span class="badge badge-red">품절</span>'
      : p.qty <= 3
        ? '<span class="badge badge-yellow">부족</span>'
        : '<span class="badge badge-green">정상</span>';

    const pingBadge = p.ping_status === "⚠️ 미판매"
      ? `<span class="badge badge-red s-unlisted-btn" style="cursor:pointer" title="타이어핑 미판매"
           data-tire="${(p.tire_id||'').replace(/"/g,'&quot;')}" data-brand="${(p.brand||'').replace(/"/g,'&quot;')}">⚠️미판매</span>`
      : p.ping_status === "판매중"
        ? '<span class="badge badge-green">판매중</span>'
        : '<span style="font-size:10px;color:#9ca3af;">-</span>';

    // 컬럼별 배경색 (시트 색상 재현)
    const C = {
      white:   "",
      yellow:  "background:#fff9c4;",   // D사이즈, R~S
      orange:  "background:#ffe0b2;",   // I변동재고
      purple:  "background:#e8d5f5;",   // J~K
      blue:    "background:#dbeafe;",   // L~N, T
      green:   "background:#d4edda;",   // O~Q
    };

    return `<tr data-sheet="${p.sheet}" data-row="${p.row}" data-idx="${i}">
      <td class="td-left">${p.brand    || "-"}</td>
      <td class="td-left">${p.pattern  || "-"}</td>
      <td style="font-size:10px;">${p.pcode   || "-"}</td>
      <td style="${C.yellow}">${p.size_raw || p.size || "-"}</td>
      <td style="font-size:10px;">${p.pr      || "-"}</td>
      <td>${p.dot      || "-"}</td>
      <td style="font-size:10px;">${p.factory ? p.factory.toLocaleString()+"원" : "-"}</td>
      <td class="s-editable qty-cell" data-key="qty" style="color:${qtyColor};font-weight:bold;">${p.qty}</td>
      <td class="s-editable" data-key="change" style="${C.orange}">${p.change    || "-"}</td>
      <td class="s-editable" data-key="mount"  style="${C.purple}">${p.mount     || "-"}</td>
      <td class="s-editable" data-key="direct" style="${C.purple}">${p.direct    || "-"}</td>
      <td class="s-editable" data-key="daily_del" style="${C.blue}">${p.daily_del || "-"}</td>
      <td class="s-editable" data-key="ping_del"  style="${C.blue}">${p.ping_del  || "-"}</td>
      <td class="s-editable" data-key="ping_dir"  style="${C.blue}">${p.ping_dir  || "-"}</td>
      <td class="s-editable" data-key="store11"   style="${C.green}">${p.store11   || "-"}</td>
      <td class="s-editable" data-key="storefarm" style="${C.green}">${p.storefarm || "-"}</td>
      <td class="s-editable" data-key="lotte"     style="${C.green}">${p.lotte     || "-"}</td>
      <td class="s-editable" data-key="dc_rate"   style="${C.yellow}">${p.dc_rate ? p.dc_rate+"%" : "-"}</td>
      <td class="s-editable" data-key="dc_price"  style="${C.yellow}">${p.dc_price ? p.dc_price.toLocaleString() : "-"}</td>
      <td>${badge}</td>
      <td>
        <input type="text" class="tire-id-inp"
          value="${p.tire_id || ""}" placeholder="tire_id"
          style="width:55px;border:1px solid #d1d5db;border-radius:3px;
          padding:2px 3px;font-size:10px;text-align:center;background:${tidBg};"
          data-sheet="${p.sheet}" data-row="${p.row}">
      </td>
      <td>${pingBadge}</td>
    </tr>`;
  }).join("");

  updateStockSummary(items);
}

// ── 인라인 셀 편집 (더블클릭) - bindStockEvents에서 바인딩 ──

function startEditCell(td) {
  const key = td.dataset.key;
  if (!key) return;
  const tr  = td.closest("tr");
  const idx = parseInt(tr.dataset.idx, 10);
  const p   = stockItems[idx];
  if (!p) return;

  const oldVal = p[key] || 0;
  const inp = document.createElement("input");
  inp.type  = "text";
  inp.inputMode = "numeric";
  inp.value = oldVal === 0 ? "" : oldVal;
  inp.style.cssText = "width:100%;border:1px solid #2563eb;border-radius:3px;padding:1px 3px;font-size:11px;text-align:center;-moz-appearance:textfield;";
  // 숫자만 입력 허용
  inp.addEventListener("keypress", e => { if (!/[0-9.]/.test(e.key)) e.preventDefault(); });
  td.textContent = "";
  td.appendChild(inp);
  inp.focus(); inp.select();

  let _saving = false; // 이중 호출 방지
  const save = async () => {
    if (_saving) return;
    _saving = true;
    const newVal = parseInt(inp.value, 10) || 0;
    if (newVal === oldVal) { refreshStockCell(td, key, oldVal); return; }

    const r = await sheetPost("set_cell", {
      sheet: tr.dataset.sheet, row: parseInt(tr.dataset.row, 10),
      col: key, value: newVal
    });

    if (r.ok) {
      p[key] = newVal;
      // H열(qty) 수정 시 타이어핑도 업데이트
      if (key === "qty") {
        if (!p.tire_id) {
          // tire_id 미설정 → 타이어핑 미반영 경고
          addSyncLog(`⚠️ tire_id 미설정 — 타이어핑 미반영: ${p.brand || ""} ${p.size_raw || ""}`);
          stSt("⚠️ tire_id 없음 — 시트만 저장됨 (타이어핑 미반영)");
        } else {
          const pid = getPidByTireIdStock(p.tire_id);
          if (pid) {
            const syncRes = await updateTirepingStock(pid, newVal);
            if (syncRes.ok) {
              addSyncLog(`✅ ${p.brand} ${p.size_raw} 수량 ${newVal}개 → 타이어핑 반영`);
              stSt("✅ 저장 완료 (타이어핑 반영)");
            } else {
              addSyncLog(`❌ 타이어핑 반영 실패: ${syncRes.msg}`);
              stSt(`⚠️ 시트 저장됨, 타이어핑 반영 실패: ${syncRes.msg}`);
            }
            return; // stSt 이미 설정됨
          } else {
            addSyncLog(`⚠️ pid 미조회 (미판매 또는 검색 필요): tire_id=${p.tire_id}`);
            stSt("⚠️ 시트만 저장됨 — 최저가봇 탭에서 검색 후 동기화 가능");
          }
        }
      }
      stSt("✅ 저장 완료");
    } else {
      stSt("❌ " + (r.msg || "저장 실패"));
    }
    refreshStockCell(td, key, p[key]);
  };

  // blur와 Enter 이중 저장 방지:
  // _saving 플래그 외에 _blurEnabled 플래그로 blur 핸들러를 Enter 후 즉시 무력화
  // (removeEventListener 이후에도 이미 큐에 들어간 blur 이벤트가 실행될 수 있어 플래그로 2중 보호)
  let _blurEnabled = true;
  const blurHandler = () => { if (_blurEnabled) save(); };
  inp.addEventListener("blur", blurHandler);
  inp.addEventListener("keydown", e => {
    if (e.key === "Enter") {
      e.preventDefault();
      _blurEnabled = false;               // blur 즉시 무력화 (큐 이벤트 포함)
      inp.removeEventListener("blur", blurHandler);
      save();
      return;
    }
    if (e.key === "Escape") {
      _blurEnabled = false;
      inp.removeEventListener("blur", blurHandler);
      p[key] = oldVal;
      refreshStockCell(td, key, oldVal);
    }
  });
}

function refreshStockCell(td, key, val) {
  if (key === "qty") {
    td.style.color = val === 0 ? "#dc2626" : val <= 3 ? "#d97706" : "#16a34a";
    td.style.fontWeight = "bold";
  } else {
    td.style.color = "";
    td.style.fontWeight = "";
  }
  td.innerHTML = val || "-";
}

// ── 요약 ──────────────────────────────────────────────────────
function updateStockSummary(items) {
  const total   = items.length;
  const soldout = items.filter(p => p.qty === 0).length;
  const low     = items.filter(p => p.qty > 0 && p.qty <= 3).length;
  const noId    = items.filter(p => !p.tire_id).length;
  const el = $("stock-summary");
  if (el) el.textContent =
    `총 ${total}개 | 🔴품절 ${soldout}개 | 🟡부족 ${low}개 | 🟢정상 ${total-soldout-low}개 | ❓tire_id없음 ${noId}개`;
}

// ── 수량 저장 ─────────────────────────────────────────────────
async function setQty(sheet, row, qty, inputEl) {
  stSt(`⏳ 수량 저장 중...`);
  try {
    const r = await sheetPost("set_qty", { sheet, row, qty });
    if (r.ok) {
      stSt(`✅ ${qty}개 저장 완료`);
      const tr = inputEl?.closest("tr");
      if (tr) {
        const badge = tr.querySelector(".badge");
        const cell  = inputEl?.parentElement;
        if (qty === 0)     { if(badge){badge.className="badge badge-red";badge.textContent="품절";} if(cell)cell.className="qty-zero"; }
        else if (qty <= 3) { if(badge){badge.className="badge badge-yellow";badge.textContent="부족";} if(cell)cell.className="qty-low"; }
        else               { if(badge){badge.className="badge badge-green";badge.textContent="정상";} if(cell)cell.className="qty-ok"; }
      }
      updateStockSummary(stockItems);
    } else { stSt("❌ " + r.msg); }
  } catch(e) { stSt("❌ " + e.message); }
}

// ── tire_id 자동 매칭 ─────────────────────────────────────────
async function autoMatchTireId(forceAll = false) {
  if (!stockItems.length) { stSt("❌ 시트 데이터를 먼저 로드하세요"); return; }

  window._forceRematch = forceAll;
  stSt(forceAll ? "⏳ 전체 재매칭 중..." : "⏳ 타이어핑에서 상품 목록 수집 중...");
  $("stock-btn-match").disabled = true;
  $("stock-btn-rematch").disabled = true;

  try {
    // ── 1단계: U컬럼 제품번호 또는 피렐리의 패턴코드로 직접 검색 매칭 ───
    const codeTargets = stockItems.filter(item => {
      if (item.tire_id && !forceAll) return false;
      // U열 product_code 있으면 우선
      if (item.product_code && item.product_code.trim()) return true;
      // 피렐리는 패턴코드가 제품번호 → 직접 검색
      if ((item.brand || "").includes("피렐리") && (item.pcode || "").trim()) return true;
      return false;
    });

    if (codeTargets.length) {
      stSt(`⏳ 제품번호로 ${codeTargets.length}개 직접 매칭 중...`);
      const toUpdateByCode = [];
      let codeMatched = 0;

      for (let i = 0; i < codeTargets.length; i += 8) {
        const batch = codeTargets.slice(i, i + 8);
        await Promise.all(batch.map(async item => {
          const code    = (item.product_code && item.product_code.trim())
                        ? item.product_code.trim()
                        : (item.pcode || "").trim();
          const dotRaw  = String(item.dot || "").trim();
          const itemDot = (dotRaw.match(/\b(20\d{2})\b/) || [])[1] || "";
          try {
            const res = await bgFetchStock(
              `https://www.tireping.com/buy/insert?code=${encodeURIComponent(code)}&search=&company=&pattern=&width=0&height=0&inch=0&dot=DOT&order=&page=1`
            );
            if (!res.ok) return;
            const doc  = new DOMParser().parseFromString(res.text, "text/html");
            const rows = doc.querySelectorAll("table.table-list tbody tr");

            let bestRow = null;
            for (const row of rows) {
              const onclick = row.getAttribute("onclick") || "";
              const m = onclick.match(/\/buy\/insert\/view\/(\d+)\?dot=([^'&]+)/);
              if (!m) continue;
              if (!bestRow) bestRow = { tire_id: m[1], dot: m[2] };
              if (itemDot && m[2] === itemDot) {
                bestRow = { tire_id: m[1], dot: m[2] };
                break;
              }
            }

            if (bestRow) {
              item.tire_id = bestRow.tire_id;
              toUpdateByCode.push({ sheet: item.sheet, row: item.row, tire_id: bestRow.tire_id });
              codeMatched++;
              console.log(`[제품번호매칭] ${code} → tire_id=${bestRow.tire_id} dot=${bestRow.dot}`);
            } else {
              console.warn(`[제품번호매칭실패] ${code} — 검색결과 없음`);
            }
          } catch(e) {
            console.warn("[제품번호매칭오류]", code, e.message);
          }
        }));
        stSt(`⏳ 제품번호 매칭 [${Math.min(i+8, codeTargets.length)}/${codeTargets.length}]`);
      }

      if (toUpdateByCode.length) {
        stSt(`⏳ 제품번호 매칭 ${toUpdateByCode.length}개 저장 중...`);
        await sheetPost("bulk_set_tire_id", { items: toUpdateByCode });
        addSyncLog(`🔗 제품번호 매칭 ${codeMatched}개 완료`);
      }
      stSt(`✅ 제품번호 매칭 ${codeMatched}개 | 나머지는 기존방식으로 계속...`);
    }

    // ── 2단계: 기존 pingProducts 방식 ────────────────────────────
    const pingProducts = await fetchAllFactoryProducts();
    if (!pingProducts.length) {
      stSt("❌ 타이어핑 상품 수집 실패");
      $("stock-btn-match").disabled = false;
      return;
    }
    stSt(`⏳ ${pingProducts.length}개 상품으로 매칭 중...`);

    const toUpdate = [];
    let matched = 0, skipped = 0;

    stockItems.forEach(item => {
      // forceAll=false(신규매칭): 이미 tire_id 있으면 스킵
      // forceAll=true(전체재매칭): 기존 tire_id 무시하고 재매칭
      if (item.tire_id && !forceAll) { skipped++; return; }

      const sNums    = (item.size_raw || item.size || "").replace(/[^0-9]/g, "");
      const sFactory = parseInt(String(item.factory || "0").replace(/[^0-9]/g, ""), 10) || 0;
      const sBrand   = (item.brand || "").toLowerCase();
      const sPcode   = (item.pcode || "").toLowerCase().trim();

      // 디버그: 처음 3개 미매칭만
      // 패턴코드 정규화: 접미사 제거
      // TA21C → TA21 (C=중국, H=한국, K=한국 등 원산지 접미사)
      // HP71EV → HP71 (EV 같은 옵션 접미사)
      const pcodeNorm = sPcode
        .replace(/[ck]$/i, "")   // 끝 C/K (중국/한국 접미사)
        .replace(/ev$/i, "")     // EV 접미사
        .trim();

      // 원산지 힌트 (C=중국, K=한국, 없으면 무관)
      const originHint = /c$/i.test(sPcode) ? "중국"
                       : /k$/i.test(sPcode) ? "한국" : "";

      const found = pingProducts.find(p => {
        // 1. 브랜드
        const pBrand = (p.brand || "").toLowerCase();
        if (!pBrand.includes(sBrand) && !sBrand.includes(pBrand)) return false;

        // 2. 사이즈
        const pNums = (p.size || "").replace(/[^0-9]/g, "");
        if (sNums !== pNums) return false;

        // 3. 공장도가 — 둘 다 있어야 하고 정확히 일치해야 함
        if (!sFactory || !p.factory || sFactory !== p.factory) return false;

        // 4. 패턴코드 매칭 — 피렐리는 패턴코드가 제품번호라 제품명에 없으므로 스킵
        const isPirelli = sBrand.includes("피렐리");
        if (sPcode && !isPirelli) {
          const pProduct   = (p.product || "").toLowerCase().replace(/\s/g, "");
          const codeToFind = (pcodeNorm || sPcode).replace(/\s/g, "");
          if (!pProduct.includes(codeToFind)) return false;
        }

        // 5. 원산지 힌트 (C=중국이면 detail에 중국 포함 여부)
        if (originHint && p.detail) {
          if (!p.detail.includes(originHint)) return false;
        }

        return true;
      });

      // 원산지 힌트로 매칭 실패 시 힌트 없이 재시도
      // 단, DOT 조건은 유지 (다른 DOT 상품과의 오매칭 방지)
      const itemDotForMatch = (String(item.dot || "").match(/\b(20\d{2})\b/) || [])[1] || "";
      const finalFound = found || (originHint ? pingProducts.find(p => {
        const pBrand = (p.brand || "").toLowerCase();
        if (!pBrand.includes(sBrand) && !sBrand.includes(pBrand)) return false;
        const pNums = (p.size || "").replace(/[^0-9]/g, "");
        if (sNums !== pNums) return false;
        if (!sFactory || !p.factory || sFactory !== p.factory) return false;
        const isPirelli = sBrand.includes("피렐리");
        if (sPcode && !isPirelli) {
          const pProduct   = (p.product || "").toLowerCase().replace(/\s/g, "");
          const codeToFind = (pcodeNorm || sPcode).replace(/\s/g, "");
          if (!pProduct.includes(codeToFind)) return false;
        }
        // DOT 조건 유지: 시트 DOT 있으면 일치하는 것만 허용
        if (itemDotForMatch && p.dot && p.dot !== itemDotForMatch) return false;
        return true;
      }) : null);

      if (!finalFound && toUpdate.length < 5 && sPcode) {
        const sameSize = pingProducts.filter(p =>
          (p.size||"").replace(/[^0-9]/g,"") === sNums
        );
        console.log(`[매칭실패] ${sBrand} ${sPcode}(norm:${pcodeNorm}) ${sNums} factory=${sFactory} origin=${originHint}`,
          "같은사이즈:", sameSize.slice(0,3).map(p => `${p.brand} ${p.product} ${p.factory}원 detail=${p.detail}`));
      }

      if (finalFound) {
        toUpdate.push({ sheet: item.sheet, row: item.row, tire_id: finalFound.tire_id });
        item.tire_id = finalFound.tire_id;
        matched++;
      }
    });

    if (!toUpdate.length) {
      stSt(`⚠️ 매칭 없음 (이미완료 ${skipped}개, 미매칭 ${stockItems.length - skipped}개)`);
      $("stock-btn-match").disabled = false;
      return;
    }

    stSt(`⏳ ${toUpdate.length}개 tire_id 시트에 저장 중...`);
    const r = await sheetPost("bulk_set_tire_id", { items: toUpdate });
    addSyncLog(`🔗 tire_id ${r.updated}개 자동 매칭 완료`);
    // 시트 저장 후 _allStockItems 즉시 갱신 (새로고침 없이 화면에 tire_id 표시)
    await loadStock();
    stSt(`✅ ${r.updated}개 매칭 완료 | 미매칭 ${stockItems.length - skipped - matched}개`);
  } catch(e) {
    stSt("❌ 매칭 실패: " + e.message);
    console.error(e);
  }
  window._forceRematch = false;
  $("stock-btn-match").disabled = false;
  $("stock-btn-rematch").disabled = false;
}

// ── factory/price 전체 수집 ───────────────────────────────────
async function fetchAllFactoryProducts() {
  const BASE_URL      = "https://www.tireping.com";
  // 브랜드 목록을 하드코딩 대신 타이어핑 제조사 목록에서 동적으로 가져옴
  // 가져오기 실패 시 기본값으로 폴백
  let TARGET_BRANDS = ["금호", "한국", "넥센", "피렐리", "한라", "요코하마", "토요", "미쉐린", "브리지스톤", "굿이어", "콘티넨탈"];
  try {
    const brandRes = await bgFetchStock(`${BASE_URL}/buy/insert`);
    if (brandRes.ok) {
      const doc = new DOMParser().parseFromString(brandRes.text, "text/html");
      const opts = [...doc.querySelectorAll("select[name='company'] option")];
      const fetched = opts.map(o => o.textContent.trim()).filter(Boolean);
      if (fetched.length > 0) TARGET_BRANDS = fetched;
    }
  } catch(e) { console.warn("[fetchAll] 브랜드 목록 조회 실패, 기본값 사용"); }
  const products      = [];
  const seen          = new Set();
  let page = 1;

  while (page <= 300) {
    const res = await bgFetchStock(
      `${BASE_URL}/factory/price?page=${page}&pattern=0&company=&width=0&height=0&inch=0&search=&order=sale&stock=`
    );
    if (!res.ok) break;

    const doc   = new DOMParser().parseFromString(res.text, "text/html");
    const items = doc.querySelectorAll(".fw-list > li");
    if (!items.length) break;

    items.forEach(li => {
      const brand = li.querySelector(".fwl-logo .txt")?.textContent.trim() || "";
      if (!TARGET_BRANDS.includes(brand)) return;

      const product = li.querySelector(".tireinfo p.name")?.textContent.trim() || "";
      const sizeEl  = li.querySelector(".tireinfo p.size");
      let size = "", detail = "";
      if (sizeEl) {
        const clone   = sizeEl.cloneNode(true);
        const spanEl  = clone.querySelector("span");
        if (spanEl) {
          detail = spanEl.textContent.trim().replace(/\s+/g, " ");
          spanEl.remove();
        }
        size = clone.textContent.trim();
      }
      const factory = parseInt(
        (li.querySelector(".tireinfo p.price b")?.textContent || "0").replace(/,/g, "")
      ) || 0;

      li.querySelectorAll(".fwlb-sale ul li[code][dot]").forEach(dotLi => {
        const tire_id = dotLi.getAttribute("code") || "";
        const dot     = dotLi.getAttribute("dot")  || "";
        if (!tire_id) return;
        const key = `${tire_id}_${dot}`;
        if (seen.has(key)) return;
        seen.add(key);
        products.push({ brand, product, size, detail, factory, tire_id, dot });
      });
    });

    stSt(`⏳ ${page}페이지 완료 (${products.length}개)`);
    console.log(`[fetchAll] page=${page} items=${items.length} total=${products.length}`);

    const paging = doc.querySelector(".page-paging");
    if (!paging) break;

    const allLinks = [...paging.querySelectorAll("a[href*='page=']")];
    const maxPage  = allLinks.reduce((max, a) => {
      const m = a.href.match(/page=(\d+)/);
      return m ? Math.max(max, parseInt(m[1], 10)) : max;
    }, 0);

    const hasDoubleRight = !!paging.querySelector("a i.fa-angle-double-right");
    const hasNext = maxPage > page || hasDoubleRight;

    console.log(`[fetchAll] page=${page} maxLinked=${maxPage} dblRight=${hasDoubleRight} hasNext=${hasNext}`);
    if (!hasNext) break;
    page++;
    // sleep 200ms: SW 활성 상태 유지 (100ms는 30초 비활동 종료 위험)
    await new Promise(r => setTimeout(r, 200));
  }
  return products;
}

// ── 미판매 상품 확인 ──────────────────────────────────────────
async function checkUnlistedItems() {
  const targets = stockItems.filter(p => p.tire_id && p.qty > 0);
  if (!targets.length) return;

  // allProducts(최저가봇)가 로드된 경우 바로 비교
  if (typeof allProducts !== "undefined" && allProducts.length) {
    const mineIds = new Set(
      allProducts.filter(p => p.is_mine).map(p => String(p.tire_id))
    );
    targets.forEach(p => {
      p.ping_status = mineIds.has(String(p.tire_id)) ? "판매중" : "⚠️ 미판매";
    });
    filterStockTable();
    const unlisted = targets.filter(p => p.ping_status === "⚠️ 미판매");
    if (unlisted.length) addSyncLog(`⚠️ 재고있는데 미판매 ${unlisted.length}개`);
    return;
  }

  // sell/price 직접 크롤링
  stSt("⏳ 타이어핑 판매 상태 확인 중...");
  try {
    const myMap = await fetchMyProductsForStock();
    targets.forEach(p => {
      p.ping_status = myMap.has(String(p.tire_id)) ? "판매중" : "⚠️ 미판매";
    });
    filterStockTable();
    const unlisted = targets.filter(p => p.ping_status === "⚠️ 미판매");
    stSt(`✅ 확인 완료 — ⚠️ 미판매 ${unlisted.length}개`);
    if (unlisted.length) addSyncLog(`⚠️ 미판매 ${unlisted.length}개: ${unlisted.slice(0,3).map(p=>p.pcode||p.tire_id).join(", ")}`);
  } catch(e) { stSt("❌ " + e.message); }
}

async function fetchMyProductsForStock() {
  const BASE_URL = "https://www.tireping.com";
  const myIds    = new Map();
  const allPids  = [];
  let page = 1;

  while (true) {
    const res = await bgFetchStock(
      `${BASE_URL}/sell/price?page=${page}&company=0&pattern=0&width=0&height=0&inch=0&dot=0&search=&order=&status=0`
    );
    if (!res.ok) break;
    const doc  = new DOMParser().parseFromString(res.text, "text/html");
    const rows = doc.querySelectorAll("table.table-list tbody tr");
    if (!rows.length || rows[0].textContent.includes("등록된 상품이 없습니다")) break;

    for (const row of rows) {
      const pid = row.querySelector("button[data-id]")?.getAttribute("data-id")?.trim();
      if (pid) allPids.push(pid);
    }

    const paging  = doc.querySelector(".page-paging");
    const hasNext = paging && (
      !!paging.querySelector(`a[href*="page=${page+1}"]`) ||
      !!paging.querySelector("a i.fa-angle-double-right")
    );
    if (!hasNext) break;
    page++;
    await new Promise(r => setTimeout(r, 150));
  }

  stSt(`⏳ 판매상품 ${allPids.length}개 tire_id 확인 중...`);
  for (let i = 0; i < allPids.length; i += 8) {
    const batch = allPids.slice(i, i + 8);
    await Promise.all(batch.map(async pid => {
      try {
        const r   = await bgFetchStock(`${BASE_URL}/sell/price/update/${pid}`);
        const doc = new DOMParser().parseFromString(r.text, "text/html");
        const inp = doc.querySelector("input[name='tire']");
        if (inp?.value) myIds.set(inp.value.trim(), pid);
      } catch(e) {}
    }));
    stSt(`⏳ tire_id 확인 ${Math.min(i+8, allPids.length)}/${allPids.length}`);
  }
  return myIds;
}

// ── 미판매 클릭 → 최저가봇 탭으로 이동 ──────────────────────
function registerFromStock(tireId, brand) {
  if (!tireId) return;
  const tabBtn = document.querySelector('[data-tab="main"]');
  if (tabBtn) tabBtn.click();
  setTimeout(() => {
    if (typeof allProducts === "undefined") {
      if (typeof st === "function") st(`⚠️ tire_id ${tireId} 를 최저가봇에서 검색해주세요`);
      return;
    }
    const found = allProducts.find(p => String(p.tire_id) === String(tireId));
    if (found && typeof shownProducts !== "undefined") {
      const idx = shownProducts.findIndex(p => String(p.tire_id) === String(tireId));
      if (idx >= 0) {
        const row = document.querySelector(`tr[data-idx="${idx}"]`);
        if (row) { row.scrollIntoView({ behavior:"smooth", block:"center" }); row.style.background="#fef3c7"; setTimeout(()=>row.style.background="",2000); }
        if (typeof st === "function") st(`🔍 ${found.product} ${found.size} — 📤등록 버튼 클릭`);
      }
    } else {
      if (typeof st === "function") st(`⚠️ tire_id ${tireId} 검색 필요`);
    }
  }, 300);
}

// ── 시트 변경 → 타이어핑 동기화 ─────────────────────────────
let _isSyncing = false;
function startSyncPoller() {
  if (stockSyncTimer) clearInterval(stockSyncTimer);
  stockSyncTimer = setInterval(async () => {
    if (_isSyncing) return; // 이전 동기화 진행 중이면 스킵
    await syncFromSheet();
  }, 2 * 60 * 1000);
}

async function syncFromSheet() {
  if (!scriptUrl) return;
  if (_isSyncing) { stSt("⏳ 이미 동기화 중..."); return; }
  _isSyncing = true;
  try {
    const r = await sheetGet("get_pending");
    if (!r.ok || !r.items?.length) return;

    // 최저가봇에서 검색을 안 한 상태면 allProducts가 비어있어 pid 조회 불가
    if (typeof allProducts === "undefined" || !allProducts.length) {
      addSyncLog("⚠️ 동기화 보류: 최저가봇 탭에서 먼저 검색해주세요 (pid 조회 불가)");
      stSt("⚠️ 최저가봇 검색 후 동기화 가능");
      return;
    }

    let syncOk = 0, syncFail = 0;
    for (const item of r.items) {
      const pid = getPidByTireIdStock(item.tire_id);
      if (!pid) { addSyncLog(`⚠️ pid 없음 (미판매?): ${item.tire_id}`); syncFail++; continue; }
      const res = await updateTirepingStock(pid, item.qty);
      if (res.ok) { addSyncLog(`✅ ${item.tire_id} → ${item.qty}개 반영`); syncOk++; }
      else         { addSyncLog(`❌ ${item.tire_id}: ${res.msg}`); syncFail++; }
    }
    addSyncLog(`동기화 완료: 성공 ${syncOk}개 / 실패 ${syncFail}개`);
    await loadStock();
  } catch(e) { console.error("syncFromSheet:", e); addSyncLog(`❌ 오류: ${e.message}`); }
  finally { _isSyncing = false; }
}

// tire_id → pid (allProducts에서 조회)
function getPidByTireIdStock(tireId) {
  if (typeof allProducts === "undefined" || !allProducts.length) return null;
  return allProducts.find(p => String(p.tire_id) === String(tireId))?.pid || null;
}

async function updateTirepingStock(pid, qty) {
  // 현재 판매가를 /sell/price/update/{pid} 에서 직접 조회 (1페이지 스캔 오류 방지)
  // sell/price 목록 1페이지는 상품이 여러 페이지에 걸치면 해당 pid가 없을 수 있음
  let currentPrice = "";
  try {
    const infoRes = await bgFetchStock(`https://www.tireping.com/sell/price/update/${pid}`);
    if (infoRes.ok) {
      const html = infoRes.text;
      // input[name='price'] 또는 input.msprice 에서 값 추출 (DOMParser 없이 정규식)
      // 각 패턴별로 가격 숫자가 항상 특정 캡처그룹에 있도록 named group 사용
      // 패턴1: name='price' value='12345' → group price
      // 패턴2: class='msprice' value='12345' → group price
      // 패턴3: value='12345' name='price' → group price (m[1]이 숫자)
      const m1 = html.match(/name=['"](price|sprice)['"'][^>]*value=['"]([\d,]+)['"]/i);
      const m2 = !m1 && html.match(/class=['"](msprice)['"'][^>]*value=['"]([\d,]+)['"]/i);
      const m3 = !m1 && !m2 && html.match(/value=['"]([\d,]+)['"'][^>]*name=['"](price|sprice)['"]/i);
      const rawPrice = m1?.[2] || m2?.[2] || m3?.[1] || ""; // 항상 숫자 그룹만 추출
      if (/^\d[\d,]*$/.test(rawPrice.trim())) currentPrice = rawPrice.trim();
    }
  } catch(e) { /* 조회 실패시 공란으로 진행 */ }

  // sidebar.js의 savePrice와 동일하게 POST body로 전송 (쿼리스트링 X)
  if (!currentPrice) {
    // 가격 조회 실패 시 경고 로그 후 진행 (sprice 공란 → 서버가 기존 가격 유지할 수 있음)
    // 단, 서버가 sprice=공란을 0원으로 처리하는 경우 재고만 안전하게 저장됨
    console.warn("[updateTirepingStock] 현재 판매가 조회 실패, pid=" + pid + " — sprice 공란으로 진행");
  }
  return new Promise(resolve => {
    const body = `pid=${encodeURIComponent(pid)}&sprice=${encodeURIComponent(currentPrice)}&dprice=&pcount=${encodeURIComponent(qty)}`;
    chrome.runtime.sendMessage({
      type: "FETCH",
      url:  "https://www.tireping.com/ajax/price/setcount",
      options: {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      }
    }, res => {
      if (chrome.runtime.lastError) return resolve({ ok:false, msg: chrome.runtime.lastError.message });
      try {
        const d = JSON.parse(res.text);
        resolve({ ok: d.code === "ok", msg: d.msg });
      } catch(e) { resolve({ ok:false, msg: res.text?.slice(0,50) }); }
    });
  });
}

// ── 동기화 로그 ───────────────────────────────────────────────
const syncLogs = [];
function addSyncLog(msg) {
  const time = new Date().toLocaleTimeString("ko-KR");
  syncLogs.unshift(`[${time}] ${msg}`);
  if (syncLogs.length > 30) syncLogs.pop();
  const el = $("stock-sync-log");
  if (el) el.innerHTML = syncLogs.map(l =>
    `<div style="font-size:10px;padding:1px 0;border-bottom:1px solid #f3f4f6;">${l}</div>`
  ).join("");
}

// ── API 호출 ──────────────────────────────────────────────────
async function sheetGet(action) {
  if (!scriptUrl) throw new Error("URL 미설정");
  const query = action.includes("action=") ? action : `action=${action}`;
  const res = await bgFetchStock(`${scriptUrl}?${query}`);
  const text = (res.text || "").trim();

  // HTML 응답 감지 (리다이렉트/로그인 페이지)
  if (text.startsWith("<") || text.includes("<!DOCTYPE")) {
    throw new Error("인증 오류 - Apps Script 배포 설정 확인 필요");
  }
  // "완료" 텍스트 감지
  if (text === "완료" || text === "Done") {
    throw new Error("Apps Script가 완료 페이지 반환 - 새 배포 필요");
  }

  try { return JSON.parse(text); }
  catch(e) { throw new Error("파싱 실패: " + text.slice(0, 100)); }
}

async function sheetPost(action, data = {}) {
  if (!scriptUrl) throw new Error("URL 미설정");
  const res = await bgFetchStock(scriptUrl, {
    method:  "POST",
    body:    JSON.stringify({ action, ...data }),
    headers: { "Content-Type": "application/json" },
  });
  try { return JSON.parse(res.text); }
  catch(e) { throw new Error("파싱 실패: " + (res.text||"").slice(0,100)); }
}

// SW 1회 시도 (내부용)
function _bgFetchStockOnce(url, options) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error("SW_TIMEOUT"));
    }, 8000); // 1회 8초 (총 3회 = 최대 24초)
    chrome.runtime.sendMessage(
      { type: "FETCH", url, options: { ...options, redirect: "follow", credentials: "include" } },
      res => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (chrome.runtime.lastError) return reject(new Error("SW_DEAD:" + chrome.runtime.lastError.message));
        if (!res) return reject(new Error("SW_DEAD:응답 없음"));
        resolve(res);
      }
    );
  });
}

// SW 종료 시 자동 재시도 (sidebar.js의 bgFetch와 동일 방식)
async function bgFetchStock(url, options = {}) {
  const MAX_RETRY = 3;
  let lastErr;
  for (let attempt = 0; attempt < MAX_RETRY; attempt++) {
    try {
      return await _bgFetchStockOnce(url, options);
    } catch(e) {
      lastErr = e;
      const msg = e.message || "";
      if (!msg.startsWith("SW_TIMEOUT") && !msg.startsWith("SW_DEAD")) throw e;
      if (attempt < MAX_RETRY - 1) {
        try { const p = chrome.runtime.connect({ name: "keepalive" }); p.disconnect(); } catch(_) {}
        await new Promise(r => setTimeout(r, 500 + attempt * 500));
      }
    }
  }
  throw new Error("bgFetchStock 실패 (SW 재시작 3회 시도) — " + (lastErr?.message || ""));
}

function stSt(msg) {
  const el = $("stock-status");
  if (el) el.textContent = msg;
}

// sidebar.js의 $()와 동일하게 사용
// chromeGet/Set은 sidebar.js에 없으므로 stock.js에서 직접 정의
function chromeStockGet(keys) { return new Promise(r => chrome.storage.local.get(keys, r)); }
function chromeStockSet(obj)  { return new Promise(r => chrome.storage.local.set(obj, r)); }
