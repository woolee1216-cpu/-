// content.js - /sell/price/insert 페이지 자동입력

const STORAGE_KEY = "tireping_pending";

async function main() {
  // 현재 탭이 정확히 /sell/price/insert 페이지인지 확인 (다른 탭이 가로채는 현상 방지)
  if (!location.pathname.startsWith("/sell/price/insert")) {
    console.log("[타이어핑봇] 비대상 페이지 — 스킵:", location.pathname);
    return;
  }

  await sleep(800); // selectize 초기화 대기

  const store = await chromeGet(STORAGE_KEY);
  const cmd = store[STORAGE_KEY];
  if (!cmd || !cmd.js || !cmd.session) {
    console.log("[타이어핑봇] 커맨드 없음");
    return;
  }

  const { session, js, auto_submit } = cmd;
  console.log(`[타이어핑봇] 커맨드 수신 session=${session} auto_submit=${auto_submit}`);

  // pending 즉시 삭제 (중복 실행 방지)
  await chromeRemove(STORAGE_KEY);

  // alert + confirm 가로채기 (MAIN 컨텍스트)
  // alert 메시지를 실제로 저장해서(window.__bot_alert_msg) 검증 실패 시 원인을 알 수 있게 함
  // confirm은 true 반환해서 진행
  await bgExecJS(`
    window.__bot_alert_count = 0;
    window.__bot_alert_msg = "";
    window.alert   = function(m){ console.log('[봇] alert:', m); window.__bot_alert_count++; window.__bot_alert_msg = String(m); };
    window.confirm = function(m){ console.log('[봇] confirm:', m); return true; };
  `);

  // 폼 채우기 JS 실행 (완료 시 window.__tireping_done = true 를 buildInsertJS가 직접 설정)
  await bgExecJS(js);
  const filled = await waitForMain("window.__tireping_done === true", 6000, 200);
  console.log("[타이어핑봇] 폼 채우기:", filled ? "✅" : "⚠️ 타임아웃");

  let saveOk = false;
  let failReason = "";

  // 폼 채우기가 실패/타임아웃이면(제조사·품명·사이즈/DOT을 못 찾았거나 사이트 응답이 느림)
  // 저장하기를 절대 누르지 않음 — 빈 폼을 그대로 제출해서 "눌러도 등록이 안 되는" 상태로
  // 조용히 실패하던 문제의 원인. buildInsertJS가 window.__tireping_fail_reason에 남긴
  // 구체적 실패 사유를 그대로 가져와 사용자에게 보여줌.
  if (!filled) {
    const reasonR = await bgExecJS(`window.__tireping_fail_reason || ""`);
    const reason = reasonR?.result ?? reasonR?.[0]?.result ?? reasonR ?? "";
    failReason = reason
      ? `폼 채우기 실패: ${reason}`
      : "폼 채우기 실패 (사이트 응답이 느리거나 페이지 구조가 변경되었을 수 있습니다)";
    console.log("[타이어핑봇] 폼 채우기 실패 — 저장 시도하지 않고 종료:", failReason);
    await chromeSet({ tireping_done: { session, ok: false, reason: failReason } });
    return; // 탭은 그대로 유지 — 사용자가 화면에서 직접 원인을 확인할 수 있게 둠
  }

  if (auto_submit) {
    await sleep(100);
    // alert 카운트 초기화 (폼 채우기 단계의 잔여 alert와 저장 단계의 alert를 구분하기 위함)
    await bgExecJS(`window.__bot_alert_count = 0; window.__bot_alert_msg = "";`);

    // 저장하기 클릭
    const clicked = await bgExecJS(`
      (function(){
        var btn = document.querySelector('button[type="submit"]');
        if(btn){ btn.click(); return true; }
        var btns = document.querySelectorAll('button');
        for(var i=0;i<btns.length;i++){
          if(btns[i].textContent.includes('저장하기')){ btns[i].click(); return true; }
        }
        return false;
      })()
    `);
    const clickedOk = clicked === true || clicked?.result === true || clicked?.[0]?.result === true;
    console.log("[타이어핑봇] 저장 클릭:", clickedOk);

    if (!clickedOk) {
      failReason = "저장하기 버튼을 찾지 못했습니다 (페이지 구조 변경 가능성)";
    } else {
      // checkPriceForm 성공 시 보통 alert 후 location.href 이동함 → 리다이렉트를 실제 성공 신호로 사용
      const redirected = await waitForMain(
        `location.href.includes('/sell/price') && !location.href.includes('/insert')`,
        5000, 150
      );
      console.log("[타이어핑봇] 리다이렉트:", redirected ? "✅" : "⚠️");

      if (redirected) {
        saveOk = true;
      } else {
        // 리다이렉트 안 됐으면 실패 — alert 메시지(검증 오류 등)를 원인으로 캡처
        await sleep(300); // alert 호출이 막 발생했을 수 있으니 살짝 대기
        const alertInfo = await bgExecJS(`({ count: window.__bot_alert_count||0, msg: window.__bot_alert_msg||"" })`);
        const info = alertInfo?.result || alertInfo?.[0]?.result || alertInfo || {};
        failReason = info.msg ? `저장 실패: ${info.msg}` : "저장 후 페이지 이동이 감지되지 않았습니다 (필수값 누락 등 검증 실패 가능성)";
      }
    }
  } else {
    // 자동제출 아님(수동 확인 모드): 사용자가 직접 저장하므로 여기서는 성공으로 간주하지 않고 그대로 종료
    saveOk = true; // 폼만 채우고 사용자가 확인 후 직접 저장 — 실패 판정 대상 아님
  }

  // 완료 신호 — 실제 저장 성공 여부를 정직하게 전달 (실패해도 무조건 성공으로 보고하지 않음)
  await chromeSet({ tireping_done: { session, ok: saveOk, reason: failReason } });

  if (!auto_submit) {
    // 수동확인 모드: 폼만 채우고 사용자가 직접 확인 후 저장 — 탭을 절대 자동으로 닫지 않음
    console.log("[타이어핑봇] 수동확인 모드 — 탭 유지 (직접 확인 후 저장하세요)");
    return;
  }
  if (!saveOk) {
    // 저장 실패 — 탭을 자동으로 닫지 않음 (사용자가 화면에서 실제 오류를 직접 보고 수정할 수 있게 둠)
    console.log("[타이어핑봇] 저장 실패 — 탭 유지:", failReason);
    return;
  }

  console.log("[타이어핑봇] 완료 — 탭 닫기");
  chrome.runtime.sendMessage({ type: "CLOSE_TAB" });
}

// MAIN 컨텍스트에서 JS 실행 (background 경유)
function bgExecJS(js) {
  return new Promise(resolve => {
    chrome.runtime.sendMessage({ type: "EXEC_JS", js }, r => resolve(r));
  });
}

// MAIN 컨텍스트 조건 polling (background 경유)
async function waitForMain(condExpr, maxMs, intervalMs) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const result = await bgExecJS(`(function(){ try{ return !!(${condExpr}); }catch(e){ return false; } })()`);
    if (result === true || result?.[0]?.result === true || result?.result === true) return true;
    await sleep(intervalMs);
  }
  return false;
}

function chromeGet(key) {
  return new Promise(resolve => chrome.storage.local.get(key, resolve));
}
function chromeSet(obj) {
  return new Promise(resolve => chrome.storage.local.set(obj, resolve));
}
function chromeRemove(key) {
  return new Promise(resolve => chrome.storage.local.remove(key, resolve));
}
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

main();
