// background.js - 타이어핑 봇 service worker

// ── 사이드패널 열기 ──────────────────────────────────────────
// 아이콘 클릭 → 사이드패널 열기
chrome.action.onClicked.addListener(tab => {
  chrome.sidePanel.open({ windowId: tab.windowId });
});

// ── 메시지 핸들러 ────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  // fetch 대리 실행 (sidebar → background → tireping)
  if (msg.type === "FETCH") {
    const opts = msg.options || {};
    const fetchOpts = {
      method:      opts.method   || "GET",
      headers:     opts.headers  || {},
      body:        opts.body     || undefined,
      credentials: opts.credentials || "include",
      redirect:    opts.redirect || "follow",
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    fetchOpts.signal = controller.signal;

    fetch(msg.url, fetchOpts)
      .then(async r => {
        clearTimeout(timer);
        try {
          const text = await r.text();
          sendResponse({ ok: r.ok, status: r.status, text });
        } catch(e) {
          sendResponse({ ok: false, error: String(e), status: 0, text: "" });
        }
      })
      .catch(e => {
        clearTimeout(timer);
        sendResponse({ ok: false, error: String(e), status: 0, text: "" });
      });
    return true;
  }

  // 페이지에 JS 실행 (MAIN 컨텍스트, CSP 우회)
  if (msg.type === "EXEC_JS" && sender.tab) {
    chrome.scripting.executeScript({
      target: { tabId: sender.tab.id },
      world: "MAIN",
      func: (code) => { try { return eval(code); } catch(e) { return false; } },
      args: [msg.js],
    }).then(r => sendResponse(r?.[0]?.result ?? true))
      .catch(e => sendResponse({ ok: false, error: String(e) }));
    return true;
  }

  // 저장하기 버튼 클릭
  if (msg.type === "CLICK_SAVE" && sender.tab) {
    chrome.scripting.executeScript({
      target: { tabId: sender.tab.id },
      world: "MAIN",
      func: () => {
        const btn = document.querySelector('button[type="submit"]');
        if (btn) { btn.click(); return true; }
        for (const b of document.querySelectorAll("button")) {
          if (b.textContent.includes("저장하기")) { b.click(); return true; }
        }
        return false;
      },
    }).then(r => sendResponse({ ok: r?.[0]?.result ?? false }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  // 탭 닫기
  if (msg.type === "CLOSE_TAB" && sender.tab) {
    setTimeout(() => chrome.tabs.remove(sender.tab.id), 300);
    sendResponse({ ok: true });
    return true;
  }

  // 완료 플래그 set/get
  if (msg.type === "SET_FLAG" && sender.tab) {
    chrome.scripting.executeScript({
      target: { tabId: sender.tab.id },
      world: "MAIN",
      func: (v) => { window.__tireping_done = v; },
      args: [msg.value],
    }).then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (msg.type === "GET_FLAG" && sender.tab) {
    chrome.scripting.executeScript({
      target: { tabId: sender.tab.id },
      world: "MAIN",
      func: () => window.__tireping_done === true,
    }).then(r => sendResponse({ value: r?.[0]?.result ?? false }))
      .catch(() => sendResponse({ value: false }));
    return true;
  }

  // 자동갱신 알람 설정
  if (msg.type === "SET_ALARM") {
    chrome.alarms.clear("autoRefresh", () => {
      if (msg.minutes > 0) {
        chrome.alarms.create("autoRefresh", { periodInMinutes: msg.minutes });
      }
      sendResponse({ ok: true });
    });
    return true;
  }
  if (msg.type === "CLEAR_ALARM") {
    chrome.alarms.clear("autoRefresh");
    sendResponse({ ok: true });
    return true;
  }

  // 즐겨찾기 자동 재고: 설정 저장 + 알람 생성/해제
  if (msg.type === "SET_AUTOSTOCK") {
    const cfg = {
      enabled:     !!msg.enabled,
      intervalMin: Math.max(1, Number(msg.intervalMin) || 60),
      target:      Math.max(1, Number(msg.target) || 1),
      storeId:     msg.storeId || "",
    };
    chrome.storage.local.set({ auto_stock_cfg: cfg }, () => {
      chrome.alarms.clear("autoStock", () => {
        if (cfg.enabled) {
          chrome.alarms.create("autoStock", { periodInMinutes: cfg.intervalMin });
          console.log(`[자동재고] 알람 설정: ${cfg.intervalMin}분, 목표 ${cfg.target}개`);
        } else {
          console.log("[자동재고] 중지");
        }
        sendResponse({ ok: true, cfg });
      });
    });
    return true;
  }
  // 즐겨찾기 자동 재고: 지금 즉시 1회 실행 (수동)
  if (msg.type === "RUN_AUTOSTOCK_NOW") {
    _runAutoStockJob("manual").then(r => sendResponse(r))
      .catch(e => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
});

// 알람 → sidebar 에 갱신 요청
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === "autoRefresh") {
    chrome.runtime.sendMessage({ type: "ALARM_REFRESH" }).catch(() => {});
  }
  // 매일 자정 캐시 GC — background에서 직접 실행 (sidebar 열림 여부 무관)
  if (alarm.name === "dailyCacheGC") {
    _runCacheGCInBackground();
  }
  // 즐겨찾기 자동 재고 조정 — 패널 닫혀 있어도 실행 (크롬이 켜져 있는 동안)
  if (alarm.name === "autoStock") {
    _runAutoStockJob("alarm");
  }
});

// 매일 자정 캐시 GC alarm 등록 (이미 있으면 스킵)
// 6시간마다 GC 실행 (하루 1시간 미만 사용 환경 — 더 자주 정리)
chrome.alarms.get("dailyCacheGC", existing => {
  if (!existing) {
    chrome.alarms.create("dailyCacheGC", {
      delayInMinutes: 1, // 설치/재시작 후 1분 뒤 첫 실행
      periodInMinutes: 6 * 60, // 6시간마다 반복
    });
  }
});

// 브라우저 재시작 후 autoRefresh 알람 복원
chrome.storage.local.get(["_auto_refresh","_auto_interval"], r => {
  if (r._auto_refresh) {
    const mins = r._auto_interval || 5;
    chrome.alarms.get("autoRefresh", existing => {
      if (!existing) {
        chrome.alarms.create("autoRefresh", { periodInMinutes: mins });
        console.log(`[자동갱신] 재시작 후 알람 복원: ${mins}분`);
      }
    });
  }
});

// 브라우저 재시작 후 즐겨찾기 자동 재고 알람 복원
chrome.storage.local.get("auto_stock_cfg", r => {
  const cfg = r.auto_stock_cfg;
  if (cfg && cfg.enabled && cfg.intervalMin > 0) {
    chrome.alarms.get("autoStock", existing => {
      if (!existing) {
        chrome.alarms.create("autoStock", { periodInMinutes: cfg.intervalMin });
        console.log(`[자동재고] 재시작 후 알람 복원: ${cfg.intervalMin}분`);
      }
    });
  }
});

function _nextMidnight() {
  const d = new Date();
  d.setHours(24, 0, 0, 0);
  return d.getTime();
}

// background에서 직접 실행하는 캐시 GC
// sidebar가 닫혀있어도 실행됨 (chrome.storage는 background에서 접근 가능)
function _runCacheGCInBackground() {
  const now = Date.now();
  const TTL_PRODUCT = 2 * 24 * 60 * 60 * 1000; // 2일 (하루 1시간 사용 환경)
  const TTL_TIRE    = 14 * 24 * 60 * 60 * 1000; // 14일

  // tireping_cache GC
  chrome.storage.local.get(null, all => {
    const updates = {};
    let totalRemoved = 0;

    // tireping_cache
    const cache = all["tireping_cache"] || {};
    let removed = 0;
    for (const key in cache) {
      const ts = cache[key]._ts || 0;
      if (!ts || (now - ts) > TTL_PRODUCT) { delete cache[key]; removed++; }
    }
    if (removed > 0) { updates["tireping_cache"] = cache; totalRemoved += removed; }

    // 계정별 tire_cache GC (tire_cache, tire_cache__xxx 형태 모두)
    for (const storageKey in all) {
      if (storageKey !== "tire_cache" && !storageKey.startsWith("tire_cache__")) continue;
      const tc = all[storageKey] || {};
      let tcRemoved = 0;
      for (const key in tc) {
        const ts = (tc[key] && typeof tc[key] === "object" ? tc[key]._ts : 0) || 0;
        if (!ts || (now - ts) > TTL_TIRE) { delete tc[key]; tcRemoved++; }
      }
      if (tcRemoved > 0) { updates[storageKey] = tc; totalRemoved += tcRemoved; }
    }

    if (Object.keys(updates).length > 0) {
      updates["_cache_gc_ts"] = now;
      chrome.storage.local.set(updates, () => {
        console.log(`[캐시GC-BG] 총 ${totalRemoved}개 제거`);
      });
    } else {
      chrome.storage.local.set({ "_cache_gc_ts": now });
    }
  });
}

// ══════════════════════════════════════════════════════════════
//  즐겨찾기 자동 재고 조정 (background — 패널 닫혀도 실행)
//  동작: 즐겨찾기 중 "내가 판매중"인 상품의 현재 재고가 목표 미만이면 목표로 채움
//  - 재고 1 ~ (목표-1) 인 상품만 끌어올림 (목표 이상은 건드리지 않음 = 내리지 않음)
//  - 품절(0개) 상품은 자동 재등록하지 않고 로그만 남김 (의도치 않은 재판매 방지)
// ══════════════════════════════════════════════════════════════
const _AS_BASE = "https://www.tireping.com";
let _autoStockRunning = false;

function _asFetch(url, opts) {
  const o = opts || {};
  const fetchOpts = {
    method: o.method || "GET",
    headers: o.headers || {},
    body: o.body || undefined,
    credentials: "include",
    redirect: "follow",
  };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  fetchOpts.signal = ctrl.signal;
  return fetch(url, fetchOpts)
    .then(async r => { clearTimeout(t); return { ok: r.ok, status: r.status, text: await r.text() }; })
    .catch(e => { clearTimeout(t); return { ok: false, status: 0, text: "", error: String(e) }; });
}

function _asToInt(v) { const n = parseInt(String(v).replace(/[^0-9.-]/g, ""), 10); return isNaN(n) ? 0 : n; }

// pid 로 상품 수정페이지를 직접 열어 현재 재고/가격 읽기 (목록/DOT/페이지네이션 무관)
async function _asReadProduct(pid) {
  const r = await _asFetch(`${_AS_BASE}/sell/price/update/${pid}`);
  if (!r.ok) return { ok: false, status: r.status };
  const html = r.text || "";
  // 폼 필드 수집 (input + select)
  const fields = {};
  for (const m of html.matchAll(/<input([^>]+)>/gi)) {
    const a = m[1];
    const nm = (a.match(/name="([^"]*)"/) || [])[1];
    if (!nm) continue;
    const type = ((a.match(/type="([^"]*)"/) || [])[1] || "text").toLowerCase();
    const val = (a.match(/value="([^"]*)"/) || [])[1] || "";
    if ((type === "radio" || type === "checkbox") && !/checked/i.test(a)) continue; // 선택된 것만
    fields[nm] = val;
  }
  for (const m of html.matchAll(/<select([^>]+)>([\s\S]*?)<\/select>/gi)) {
    const nm = (m[1].match(/name="([^"]*)"/) || [])[1];
    if (!nm) continue;
    const sel = (m[2].match(/<option[^>]+selected[^>]*value="([^"]*)"/i)
              || m[2].match(/<option[^>]+value="([^"]*)"[^>]*selected/i) || [])[1];
    if (sel !== undefined) fields[nm] = sel;
  }
  // 폼 필드가 거의 없으면 로그인/오류 페이지로 판단
  const keys = Object.keys(fields);
  if (keys.length < 2) {
    if (/login|로그인/i.test(html.slice(0, 800))) return { ok: false, login: true, dump: "(로그인 페이지)" };
    return { ok: false, status: r.status || 0, dump: `(폼없음, 길이 ${html.length})` };
  }
  // 재고/가격 후보 필드 (덤프로 확인: 재고=count, 일반가=price, 직배송가=directprice)
  const stockRaw = fields.count ?? fields.pcount ?? fields.mcount ?? fields.stock ?? "";
  const price  = _asToInt(fields.price ?? fields.sprice ?? "");
  const dprice = _asToInt(fields.directprice ?? fields.dprice ?? "");
  const soldout  = fields.soldout === "1" || fields.soldout === "Y" || /soldout_ico/i.test(html);
  const dump = keys.map(k => `${k}=${fields[k]}`).join(" | ").slice(0, 600);
  return {
    ok: true,
    stock: _asToInt(stockRaw),
    price,
    dprice,
    soldout,
    dump,
    html,
  };
}

// ── 안전한 재고 변경: 상품 수정폼을 통째로 보존하고 count(수량)만 바꿔서 저장
//    (setcount 부분전송은 엉뚱한/새 등록건을 만드는 문제가 있어 폐기)
//    엔드포인트는 clearSoldout과 동일한 검증된 /ajax/price/insert (mode=updateProcess 포함)
function _asBuildFormParams(html) {
  const params = new URLSearchParams();
  for (const m of html.matchAll(/<input([^>]+)>/gi)) {
    const a = m[1];
    const nm = (a.match(/name=['"]([^'"]+)['"]/) || [])[1];
    if (!nm) continue;
    const type = ((a.match(/type=['"]([^'"]+)['"]/) || [])[1] || "text").toLowerCase();
    if (type === "submit" || type === "button" || type === "reset") continue;
    if ((type === "radio" || type === "checkbox") && !/checked/i.test(a)) continue;
    const val = (a.match(/value=['"]([^'"]*)['"]/) || [])[1] || "";
    params.set(nm, val);
  }
  for (const m of html.matchAll(/<select([^>]+)>([\s\S]*?)<\/select>/gi)) {
    const nm = (m[1].match(/name=['"]([^'"]+)['"]/) || [])[1];
    if (!nm) continue;
    const sel = (m[0].match(/<option[^>]+selected[^>]*value=['"]([^'"]*)['"]/i)
              || m[0].match(/<option[^>]+value=['"]([^'"]*)['"][^>]*selected/i)
              || m[0].match(/<option[^>]+value=['"]([^'"]*)['"]/i) || [])[1];
    params.set(nm, sel || "");
  }
  for (const m of html.matchAll(/<textarea([^>]*)>([\s\S]*?)<\/textarea>/gi)) {
    const nm = (m[1].match(/name=['"]([^'"]+)['"]/) || [])[1];
    if (!nm) continue;
    params.set(nm, m[2]);
  }
  return params;
}

async function _asFormSaveCount(html, target) {
  const params = _asBuildFormParams(html);
  if (!params.has("count")) return { ok: false, msg: "count 필드 없음 — 저장 취소" };
  if (!params.has("mode")) params.set("mode", "updateProcess");
  params.set("count", String(target)); // 수량만 변경, 나머지는 페이지 값 그대로
  const res = await _asFetch(`${_AS_BASE}/ajax/price/insert?width=0&height=0&inch=0&${params.toString()}`);
  if (!res.ok) return { ok: false, msg: `저장 실패(${res.status})` };
  try { const d = JSON.parse(res.text); return d.code === "ok" ? { ok: true } : { ok: false, msg: d.msg || "거부" }; }
  catch (e) { return { ok: false, msg: (res.text || "").includes("login") ? "로그인 만료" : "응답 오류" }; }
}

async function _asLog(entry) {
  const cur = await new Promise(res => chrome.storage.local.get("auto_stock_log", d => res(d.auto_stock_log || [])));
  cur.unshift(entry);
  const trimmed = cur.slice(0, 50);
  await new Promise(res => chrome.storage.local.set({ auto_stock_log: trimmed, auto_stock_last: entry }, res));
  // 패널이 열려 있으면 갱신 알림 (닫혀 있으면 무시됨)
  chrome.runtime.sendMessage({ type: "AUTOSTOCK_DONE", entry }).catch(() => {});
}

async function _runAutoStockJob(trigger) {
  if (_autoStockRunning) return { ok: false, error: "이미 실행 중" };
  _autoStockRunning = true;
  const started = Date.now();
  try {
    const cfg = await new Promise(res => chrome.storage.local.get("auto_stock_cfg", d => res(d.auto_stock_cfg)));
    if (!cfg || (!cfg.enabled && trigger === "alarm")) {
      return { ok: false, error: "비활성 상태" };
    }
    const target = Math.max(1, Number(cfg.target) || 1);
    const favKey = cfg.storeId ? `favorites__${cfg.storeId}` : "favorites";
    const favData = await new Promise(res => chrome.storage.local.get(favKey, d => res(d[favKey] || {})));
    const favs = Object.values(favData).filter(f => f && f.is_mine && f.pid);
    if (!favs.length) {
      const msg = "대상 없음 — 판매중인 즐겨찾기가 없습니다";
      await _asLog({ ts: started, trigger, raised: 0, kept: 0, soldout: 0, failed: 0, msg });
      return { ok: true, raised: 0, msg };
    }

    let raised = 0, kept = 0, notfound = 0, soldout = 0, failed = 0, login = 0;
    const details = [];
    let favDirty = false;
    for (const f of favs) {
      const tag = `${f.manufacturer||""} ${f.size||""} ${f.dot||""}`.trim();
      const prod = await _asReadProduct(f.pid);
      if (prod.login) { login++; details.push(`로그인 만료: ${tag}`); continue; }
      if (!prod.ok)   { notfound++; details.push(`조회 실패: ${tag}`); continue; }
      // 읽은 시점의 실제 재고를 즐겨찾기 스냅샷에 즉시 반영 (표에서 바로 확인 가능하도록)
      const key = `${f.tire_id || ""}__${f.dot || ""}`;
      if (favData[key] && favData[key].my_stock !== prod.stock) {
        favData[key].my_stock = prod.stock;
        favDirty = true;
      }
      if (prod.soldout || prod.stock <= 0) { soldout++; details.push(`품절(자동 재등록 안 함): ${tag}`); continue; }
      if (prod.stock >= target) { kept++; continue; } // 이미 목표 이상 → 조용히 건너뜀
      // 폼 전체 보존 + 수량(count)만 변경 (가격·directprice·사양·국가 등 절대 안 건드림)
      const res = await _asFormSaveCount(prod.html, target);
      if (res.ok) {
        raised++; details.push(`채움: ${tag} ${prod.stock}→${target}`);
        if (favData[key]) { favData[key].my_stock = target; favDirty = true; } // 채운 결과도 즉시 반영
      } else { failed++; details.push(`실패(${res.msg || "?"}): ${tag}`); }
      await new Promise(r => setTimeout(r, 400)); // 서버 부담 완화용 짧은 지연
    }
    if (favDirty) await new Promise(res => chrome.storage.local.set({ [favKey]: favData }, res));

    const entry = {
      ts: started, trigger, raised, kept, notfound, soldout, failed, target,
      took: Date.now() - started,
      msg: `채움 ${raised} · 유지 ${kept} · 품절 ${soldout} · 실패 ${failed}` + (login ? ` · 로그인만료 ${login}` : "") + (notfound ? ` · 조회실패 ${notfound}` : "") + ` (대상 ${favs.length})`,
      details: details.slice(0, 30),
      favUpdated: favDirty, // 즐겨찾기 표가 닫혀있던 패널에서도 새로 열렸을 때 최신값을 보여줌
    };
    await _asLog(entry);
    return { ok: true, ...entry };
  } catch (e) {
    await _asLog({ ts: started, trigger, raised: 0, kept: 0, notfound: 0, soldout: 0, failed: 0, msg: "오류: " + String(e) });
    return { ok: false, error: String(e) };
  } finally {
    _autoStockRunning = false;
  }
}
