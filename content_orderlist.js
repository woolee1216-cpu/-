// content_orderlist.js — /sell/orderlist 목록 페이지에 "재고 위치"(거래처 탭) 컬럼 주입
// 사이드패널의 거래처 탭 분류(bizData_v2)를 실제 타이어핑 목록 화면에도 보여줍니다.

(function () {
  // 목록 페이지에서만 동작 (상세 페이지 /view/ 는 제외)
  if (!/^\/sell\/orderlist\/?$/.test(location.pathname)) return;

  const BIZ_LOCAL_KEY = "bizData_v2";
  let bizData = null;
  let productIndex = null; // "품명|사이즈" → [탭이름,...]  (dot도 있으면 우선 매칭에 사용)

  function norm(s) { return (s || "").replace(/\s+/g, "").trim(); }

  // bizData.products(스냅샷) + assign을 이용해 "품명|사이즈" → 탭이름 배열 인덱스 생성
  function buildProductIndex(data) {
    const idx = {};
    const tabName = id => data.tabs.find(t => t.id === id)?.name || "";
    for (const key in data.assign) {
      const tabIds = data.assign[key] || [];
      if (!tabIds.length) continue;
      const snap = data.products?.[key];
      if (!snap || !snap.product) continue;
      const k = norm(snap.product) + "|" + norm(snap.size) + "|" + (snap.dot || "");
      const kNoD = norm(snap.product) + "|" + norm(snap.size); // DOT 모를 때 폴백
      const names = tabIds.map(tabName).filter(Boolean);
      if (!names.length) continue;
      (idx[k] ||= new Set());
      names.forEach(n => idx[k].add(n));
      (idx[kNoD] ||= new Set());
      names.forEach(n => idx[kNoD].add(n));
    }
    return idx;
  }

  function lookupBizNames(product, size, dot) {
    if (!productIndex) return [];
    const kFull = norm(product) + "|" + norm(size) + "|" + (dot || "");
    const kNoD  = norm(product) + "|" + norm(size);
    const set = productIndex[kFull] || productIndex[kNoD];
    return set ? [...set] : [];
  }

  async function loadBizData() {
    return new Promise(resolve => {
      chrome.storage.local.get(BIZ_LOCAL_KEY, d => {
        bizData = d[BIZ_LOCAL_KEY] || { tabs: [], assign: {}, products: {} };
        productIndex = buildProductIndex(bizData);
        resolve();
      });
    });
  }

  // 주문 상세 페이지에서 품명·사이즈·DOT 파싱 (사이드패널과 동일 로직, 간략화)
  const detailCache = {};
  async function fetchProductInfo(orderId) {
    if (detailCache[orderId]) return detailCache[orderId];
    try {
      const res = await fetch(`/sell/orderlist/view/${orderId}`, { credentials: "include" });
      const html = await res.text();
      const nameM = html.match(/<p[^>]*class="[^"]*t-name[^"]*"[^>]*>([\s\S]*?)<\/p>/i);
      const sizeM = html.match(/<p[^>]*class="[^"]*t-size[^"]*"[^>]*>([\s\S]*?)<\/p>/i);
      const dotM  = html.match(/생산년도[\s\S]{0,120}?<td[^>]*>([\s\S]*?)<\/td>/i);
      const product = nameM ? nameM[1].replace(/<[^>]+>/g,"").trim() : "";
      const size    = sizeM ? sizeM[1].replace(/<[^>]+>/g,"").trim() : "";
      const dotTxt  = dotM ? dotM[1].replace(/<[^>]+>/g,"").trim() : "";
      const dot = parseInt(dotTxt, 10) || null;
      return (detailCache[orderId] = { product, size, dot });
    } catch (e) {
      return (detailCache[orderId] = { product: "", size: "", dot: null });
    }
  }

  function findHeaderCellIndex(table, labelIncludes) {
    const ths = [...table.querySelectorAll("thead th")];
    return ths.findIndex(th => th.textContent.replace(/\s+/g,"").includes(labelIncludes));
  }

  async function injectColumn() {
    // 제조사코드(또는 업체코드) 헤더가 있는 테이블 탐색
    const tables = [...document.querySelectorAll("table")];
    let table = null, colIdx = -1;
    for (const t of tables) {
      const i = findHeaderCellIndex(t, "제조사코드");
      if (i !== -1) { table = t; colIdx = i; break; }
    }
    if (!table) {
      // 폴백: 업체코드로도 시도
      for (const t of tables) {
        const i = findHeaderCellIndex(t, "업체코드");
        if (i !== -1) { table = t; colIdx = i; break; }
      }
    }
    if (!table || colIdx === -1) return; // 구조 다르면 조용히 종료

    // 이미 주입했으면 중복 방지
    if (table.dataset.bizLocInjected === "1") return;
    table.dataset.bizLocInjected = "1";

    // 헤더에 "재고 위치" 삽입
    const headRow = table.querySelector("thead tr");
    const headCells = headRow.children;
    const th = document.createElement("th");
    th.textContent = "재고 위치";
    th.style.cssText = "background:#eef2ff;color:#3730a3;font-weight:600;white-space:nowrap;";
    headRow.insertBefore(th, headCells[colIdx]);

    // 본문 행 각각에 셀 삽입 + 비동기로 값 채우기
    const bodyRows = [...table.querySelectorAll("tbody tr")];
    for (const tr of bodyRows) {
      const cells = tr.children;
      if (cells.length <= colIdx) continue;
      const td = document.createElement("td");
      td.textContent = "…";
      td.style.cssText = "text-align:center;color:#6366f1;font-size:11px;white-space:nowrap;";
      tr.insertBefore(td, cells[colIdx]);

      const linkM = tr.innerHTML.match(/\/orderlist\/view\/(\d+)/);
      const orderId = linkM ? linkM[1] : null;
      if (!orderId) { td.textContent = "-"; continue; }

      fetchProductInfo(orderId).then(info => {
        if (!info.product) { td.textContent = "-"; return; }
        const names = lookupBizNames(info.product, info.size, info.dot);
        if (names.length) {
          td.textContent = names.join(", ");
          td.style.color = "#4338ca";
          td.style.fontWeight = "600";
          td.title = `${info.product} ${info.size}`;
        } else {
          td.textContent = "-";
          td.style.color = "#d1d5db";
        }
      });
    }
  }

  async function main() {
    await loadBizData();
    // 페이지가 늦게 렌더되는 경우 대비 + 페이지네이션으로 내용이 바뀌는 경우 대응
    injectColumn();
    // 목록이 AJAX로 갱신되는 SPA 형태일 수 있어 MutationObserver로 재주입 감시
    const observer = new MutationObserver(() => {
      const tables = document.querySelectorAll("table:not([data-biz-loc-injected])");
      if (tables.length) injectColumn();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // storage 변경 시(다른 곳에서 거래처 배정 바뀔 때) 인덱스 갱신
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[BIZ_LOCAL_KEY]) {
      bizData = changes[BIZ_LOCAL_KEY].newValue || bizData;
      productIndex = buildProductIndex(bizData);
    }
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", main);
  } else {
    main();
  }
})();
