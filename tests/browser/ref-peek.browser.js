// ref-peek 브라우저 확인 (헤드리스 Chromium + Playwright, 전체 기능 번들). tests/test_browser.py가 서버를 띄우고 실행:
//   node tests/browser/ref-peek.browser.js <port>
// playwright(NODE_PATH)나 Chromium이 없으면 "SKIP"을 찍고 종료 코드 0.
"use strict";
const assert = require("node:assert/strict");

let chromium;
try { ({ chromium } = require("playwright")); } catch { console.log("SKIP playwright 없음"); process.exit(0); }

const PORT = process.argv[2];
const BASE = `http://127.0.0.1:${PORT}`;
const PAPER = `${BASE}/paper/2401.00001`;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 바깥 네트워크는 막고(그림은 같은 비율의 SVG), /api/ask는 테스트가 정한 답으로
const IMG_SIZE = { "x1.png": [598, 300] };
async function newPage(browser, { ask } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 412, height: 800 }, serviceWorkers: "block" });
  await ctx.route(u => !u.href.startsWith(BASE), r => {
    if (r.request().resourceType() !== "image") return r.fulfill({ status: 200, body: "", contentType: "text/plain" });
    const [w, h] = IMG_SIZE[r.request().url().split("/").pop()] || [300, 200];
    return r.fulfill({ status: 200, body: `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"/>`, contentType: "image/svg+xml" });
  });
  const asks = [];
  await ctx.route(`${BASE}/api/ask`, async r => {
    const body = JSON.parse(r.request().postData() || "{}");
    asks.push(body);
    const out = ask ? await ask(body, asks.length) : "답변입니다.";
    try { await r.fulfill({ status: 200, body: out, contentType: "text/plain; charset=utf-8" }); } catch { /* 중단된 요청 */ }
  });
  // 다른 기능의 /api/* 호출(프리페치 등)은 빈 응답
  await ctx.route(u => u.href.startsWith(`${BASE}/api/`) && !u.pathname.startsWith("/api/ask") && !u.pathname.startsWith("/api/prewarm"),
    r => r.fulfill({ status: 503, body: "{}", contentType: "application/json" }));
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(String(e)));
  page.asks = asks;
  page.errors = errors;
  return page;
}
async function open(page) {
  await page.goto(PAPER);
  await page.waitForFunction(() => window.PaperApp && PaperApp.has("ref-peek") && document.readyState === "complete");
}
const until = (page, fn, arg) => page.waitForFunction(fn, arg, { timeout: 5000 });
const peeks = page => page.evaluate(() => [...document.querySelectorAll(".pr-peek")].map(p => ({
  title: p.querySelector(".pr-peek-head b").textContent,
  actions: [...p.querySelectorAll(".pr-peek-actions button")].map(b => b.textContent),
  text: p.querySelector(".pr-peek-body").textContent.replace(/\s+/g, " ").trim(),
})));
// 링크를 화면 y 근처로 스크롤해 두고 그 셀렉터 반환
async function showLink(page, sel, y = 300) {
  await page.evaluate(([sel, y]) => { const a = document.querySelector(sel); window.scrollBy(0, a.getBoundingClientRect().top - y); }, [sel, y]);
  await sleep(50);
  return sel;
}
const clickAction = (page, label) => page.evaluate(label => {
  const ps = document.querySelectorAll(".pr-peek");
  [...ps[ps.length - 1].querySelectorAll(".pr-peek-actions button")].find(b => b.textContent === label).click();
}, label);
const settle = async page => { let y = -1; for (let i = 0; i < 40; i++) { const n = await page.evaluate(() => scrollY); if (n === y) return n; y = n; await sleep(50); } return y; };

test("수식 링크 탭 → peek (스크롤·해시 그대로, 복제에 id 없음), 이동 → '↩ 돌아가기'로 원래 위치", async browser => {
  const page = await newPage(browser);
  await open(page);
  const sel = await showLink(page, '#S2\\.p1 a[href="#S2.E1"]');
  const y0 = await page.evaluate(() => scrollY);
  assert.deepEqual(await page.evaluate(s => getComputedStyle(document.querySelector(s)).padding, sel), "6px 3px", "탭 영역 넓힘");
  await page.click(sel);
  await until(page, () => document.querySelector(".rp-peek"));
  const [p] = await peeks(page);
  assert.equal(p.title, "식 (1)");
  assert.deepEqual(p.actions, ["그 위치로 이동", "이 부분 질문"]);
  const r = await page.evaluate(() => {
    const ids = [...document.querySelectorAll("[id]")].map(e => e.id);
    return { y: scrollY, hash: location.hash, cloneIds: document.querySelectorAll(".rp-peek .pr-peek-body [id]").length,
      dup: ids.length - new Set(ids).size, table: !!document.querySelector(".rp-peek .pr-peek-body table.ltx_equation math") };
  });
  assert.deepEqual(r, { y: y0, hash: "", cloneIds: 0, dup: 0, table: true });
  await clickAction(page, "그 위치로 이동");
  await until(page, () => !document.querySelector(".pr-peek") && !document.getElementById("back-chip").hidden);
  const y1 = await settle(page);
  const top = await page.evaluate(() => document.getElementById("S2.E1").getBoundingClientRect().top);
  assert.ok(y1 !== y0 && top > 0 && top < 800, `점프 (y ${y0} → ${y1}, 대상 top ${top})`);
  await page.click("#back-chip");
  await until(page, y0 => Math.abs(scrollY - y0) <= 2 && document.getElementById("back-chip").hidden, y0);
  assert.deepEqual(page.errors, []);
});

test("제목은 대상 꼬리표에서: 정렬 수식 줄·하위 그림·표·섹션·정리·부록·알고리즘, 강조한 줄", async browser => {
  const page = await newPage(browser);
  await open(page);
  const out = await page.evaluate(() => {
    const rp = PaperApp.feature("ref-peek"), res = {};
    for (const id of ["S2.E3", "S2.Ex1", "S2.F2.sf1", "S2.T1", "S2.SS1", "Thmtheorem1", "A1", "alg1", "A1.E4"]) {
      const close = rp.open(id);
      const b = close.body;
      res[id] = { title: close.el.querySelector(".pr-peek-head b").textContent, mark: b.querySelector(".rp-mark")?.localName || null,
        ids: b.querySelectorAll("[id]").length };
      if (id === "S2.E3") res[id].row = [...b.querySelectorAll("tbody")].findIndex(t => t.classList.contains("rp-mark"));
      if (id === "S2.SS1") res[id].paras = b.querySelectorAll(".ltx_para").length;
      close();
    }
    return res;
  });
  assert.deepEqual(out, {
    "S2.E3": { title: "식 (3)", mark: "tbody", ids: 0, row: 1 },
    "S2.Ex1": { title: "수식", mark: null, ids: 0 },
    "S2.F2.sf1": { title: "Figure 2 (a)", mark: "figure", ids: 0 },
    "S2.T1": { title: "Table 1", mark: null, ids: 0 },
    "S2.SS1": { title: "2.1 Training objective", mark: null, ids: 0, paras: 1 },
    "Thmtheorem1": { title: "Theorem 1", mark: null, ids: 0 },
    "A1": { title: "Appendix A Additional results", mark: null, ids: 0 },
    "alg1": { title: "Algorithm 1", mark: null, ids: 0 },
    "A1.E4": { title: "식 (4)", mark: null, ids: 0 },
  });
  // 실제 탭: 하위 그림 링크 "2(a)"의 글자는 번호뿐이지만 제목은 꼬리표에서
  await page.click(await showLink(page, 'a[href="#S2.F2.sf1"]'));
  await until(page, () => document.querySelector(".rp-peek"));
  assert.equal((await peeks(page))[0].title, "Figure 2 (a)");
  assert.deepEqual(page.errors, []);
});

test("각주: 본문에 펼치지 않음, 표시를 탭하면 각주 peek (섹션 peek 안에서도)", async browser => {
  const page = await newPage(browser);
  await open(page);
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector("#S1\\.p1 .ltx_note_outer")).display), "none");
  await page.click(await showLink(page, "#S1\\.p1 .ltx_note > .ltx_note_mark"));
  await until(page, () => document.querySelector(".rp-peek"));
  const [p] = await peeks(page);
  assert.equal(p.title, "각주 1");
  assert.equal(p.text, "The router is trained jointly with the experts.");
  assert.deepEqual(p.actions, ["이 부분 질문"]);
  await page.keyboard.press("Escape");
  await until(page, () => !document.querySelector(".pr-peek"));
  // 섹션 1 peek의 복제 안 각주 표시 → 그 위에 각주 peek
  await page.evaluate(() => PaperApp.feature("ref-peek").open("S1"));
  await page.evaluate(() => document.querySelector(".rp-peek .ltx_note_mark").click());
  await until(page, () => document.querySelectorAll(".pr-peek").length === 2);
  assert.deepEqual((await peeks(page)).map(x => x.title), ["1 Introduction", "각주 1"]);
  assert.deepEqual(page.errors, []);
});

test("언급한 곳: 'N곳에서 언급' → 문장 목록 → 탭하면 그 문장으로 점프", async browser => {
  const page = await newPage(browser);
  await open(page);
  await page.click(await showLink(page, '#S2\\.p1 a[href="#S2.T1"]'));
  await until(page, () => document.querySelector(".rp-peek"));
  assert.deepEqual((await peeks(page))[0].actions, ["그 위치로 이동", "이 부분 질문", "2곳에서 언급"]);
  await clickAction(page, "2곳에서 언급");
  await until(page, () => document.querySelectorAll(".pr-peek").length === 2);
  const list = await page.evaluate(() => [...document.querySelectorAll(".rp-bl-item")].map(b => ({
    cur: b.classList.contains("rp-bl-cur"), small: b.querySelector("small")?.textContent, text: b.querySelector(".rp-bl-text").textContent.trim(),
    hit: b.querySelector(".rp-bl-hit")?.textContent,
  })));
  assert.equal((await peeks(page))[1].title, "Table 1 · 언급 2곳");
  assert.equal(list.length, 2);
  assert.deepEqual([list[0].cur, list[0].small, list[0].hit], [true, "2 Method · 지금 읽던 곳", "1"]);
  assert.match(list[0].text, /^Figure 1 shows the architecture, Table 1 lists the results/);
  assert.match(list[1].text, /^Table 1 shows that the sparse model improves accuracy by 2\.3 points on MMLU,/);
  await page.evaluate(() => document.querySelectorAll(".rp-bl-item")[1].click());
  await until(page, () => !document.querySelector(".pr-peek") && !document.getElementById("back-chip").hidden);
  await settle(page);
  const top = await page.evaluate(() => document.getElementById("S2.p3").getBoundingClientRect().top);
  assert.ok(top > 0 && top < 800, `S2.p3가 화면 안 (${top})`);
  // 다른 기능(equation-tools·figure-viewer)용 API: 그림은 하위 그림 링크까지, 섹션은 정확히 그 id만
  const api = await page.evaluate(() => {
    const rp = PaperApp.feature("ref-peek");
    return { t1: rp.mentionCount("S2.T1"), f2: rp.mentionCount("S2.F2"), s2: rp.mentionCount("S2"), ss1: rp.mentionCount("S2.SS1"),
      e1: rp.backlinks("S2.E1").map(b => typeof b.start), none: rp.showBacklinks("S2.Ex1") };
  });
  assert.deepEqual(api, { t1: 2, f2: 1, s2: 0, ss1: 1, e1: ["number"], none: null });
  // 참고문헌 링크는 ref-peek가 잡지 않음 (cite-cards 몫)
  await page.evaluate(() => PaperNav.back());
  await page.click(await showLink(page, '#S1\\.p1 a[href="#bib.bib1"]'));
  await sleep(150);
  assert.equal(await page.evaluate(() => document.querySelectorAll(".rp-peek").length), 0);
  assert.deepEqual(page.errors, []);
});

test("peek의 '이 부분 질문': 대상 내용(수식은 $alttext$)을 선택으로, 링크가 있던 문단을 문맥으로 새 대화", async browser => {
  const page = await newPage(browser);
  await open(page);
  await page.click(await showLink(page, '#S2\\.p1 a[href="#S2.E1"]'));
  await until(page, () => document.querySelector(".rp-peek"));
  await clickAction(page, "이 부분 질문");
  await until(page, () => PaperApp.isSheetOpen() && !document.querySelector(".pr-peek"));
  const s = await page.evaluate(() => ({ quote: PaperApp.session.quote, selection: PaperApp.session.selection, context: PaperApp.session.context, section: PaperApp.session.section }));
  assert.equal(s.quote, "식 (1)");
  assert.match(s.selection, /\$g\(x\)=\\mathrm\{softmax\}\(W_\{g\}x\)\$ \(1\)/);
  assert.match(s.context, /^The router computes gate scores as in Eq\./);
  assert.equal(s.section, "2 Method");
  assert.deepEqual(page.errors, []);
});

test("선택이 있어도 링크가 이김: 해시 이동 없이 peek, 문장 모드(20, allowWithSelection)보다 먼저 (§5.4)", async browser => {
  const page = await newPage(browser);
  await open(page);
  // smart-presets 문장 모드와 같은 모양의 처리기 (보통 글자 탭을 받음)
  await page.evaluate(() => {
    window.__sentence = 0;
    PaperApp.addTapHandler({ id: "test:sentence", priority: 20, allowWithSelection: true,
      test: e => !e.target.closest("a[href]") && !!e.target.closest(".ltx_p"), handle: () => { window.__sentence++; } });
  });
  const sel = await showLink(page, '#S2\\.p1 a[href="#S2.E1"]');
  const selectSome = () => page.evaluate(() => {
    const p = document.querySelector("#S2\\.p1 .ltx_p"), r = document.createRange();
    r.setStart(p.firstChild, 4); r.setEnd(p.firstChild, 10);
    getSelection().removeAllRanges(); getSelection().addRange(r);
  });
  await selectSome();
  const y0 = await page.evaluate(() => scrollY);
  await page.click(sel);
  await until(page, () => document.querySelector(".rp-peek"));
  assert.equal((await peeks(page))[0].title, "식 (1)");
  // (history에는 peek 레이어의 Back 항목만 생김: 해시 이동이 아님)
  const after = await page.evaluate(() => ({ y: scrollY, hash: location.hash, sentence: window.__sentence }));
  assert.deepEqual(after, { y: y0, hash: "", sentence: 0 });
  await page.keyboard.press("Escape");
  await until(page, () => !document.querySelector(".pr-peek"));
  // 각주 표시도 선택 중에 열림, 보통 글자 탭은 그대로 문장 모드가 받음
  await page.evaluate(() => document.querySelector("#S1\\.p1 .ltx_note > .ltx_note_mark").scrollIntoView({ block: "center" }));
  await selectSome();
  await page.click("#S1\\.p1 .ltx_note > .ltx_note_mark");
  await until(page, () => document.querySelector(".rp-peek"));
  assert.equal((await peeks(page))[0].title, "각주 1");
  await page.keyboard.press("Escape");
  await until(page, () => !document.querySelector(".pr-peek"));
  await page.evaluate(() => document.querySelector("#S2\\.p1 .ltx_p").scrollIntoView({ block: "center" }));
  await selectSome();
  const box = await page.evaluate(() => { const r = document.createRange(), t = document.querySelector("#S2\\.p1 .ltx_p").firstChild;
    r.setStart(t, 0); r.setEnd(t, 3); const b = r.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; });
  await page.mouse.click(box.x, box.y);
  await sleep(100);
  assert.equal(await page.evaluate(() => window.__sentence), 1, "보통 글자 탭은 문장 모드로");
  assert.equal(await page.evaluate(() => document.querySelectorAll(".rp-peek").length), 0);
  assert.deepEqual(page.errors, []);
});

test("각주 표시는 키보드로도: tabindex·role=button·이름, Enter → peek, 닫으면 표시로 초점 복귀", async browser => {
  const page = await newPage(browser);
  await open(page);
  const mark = "#S1\\.p1 .ltx_note > .ltx_note_mark";
  const attrs = await page.evaluate(m => {
    const el = document.querySelector(m);
    return { tab: el.tabIndex, role: el.getAttribute("role"), label: el.getAttribute("aria-label"),
      inner: document.querySelector("#S1\\.p1 .ltx_note_content .ltx_note_mark").hasAttribute("tabindex") };
  }, mark);
  assert.deepEqual(attrs, { tab: 0, role: "button", label: "각주 1", inner: false });
  await page.focus(mark);
  await page.keyboard.press("Enter");
  await until(page, () => document.querySelector(".rp-peek"));
  const [p] = await peeks(page);
  assert.equal(p.title, "각주 1");
  assert.equal(p.text, "The router is trained jointly with the experts.");
  await page.keyboard.press("Escape");
  await until(page, () => !document.querySelector(".pr-peek"));
  await until(page, m => document.activeElement === document.querySelector(m), mark);
  // 섹션 peek의 복제 안 표시도 Space로
  await page.evaluate(() => PaperApp.feature("ref-peek").open("S1"));
  await page.focus(".rp-peek .rp-body .ltx_note_mark[role=button]");
  await page.keyboard.press(" ");
  await until(page, () => document.querySelectorAll(".pr-peek").length === 2);
  assert.deepEqual((await peeks(page)).map(x => x.title), ["1 Introduction", "각주 1"]);
  assert.deepEqual(page.errors, []);
});

test("꼬리표 없는 그림·표·알고리즘: 탭한 링크의 title, 없으면 종류 + 링크 글자", async browser => {
  const page = await newPage(browser);
  await open(page);
  // 번호 없는 figure*·캡션 없는 float 흉내: 캡션의 .ltx_tag를 뺌
  await page.evaluate(() => ["S2.F1", "S2.T1", "alg1"].forEach(id => document.getElementById(id).querySelectorAll(".ltx_tag").forEach(t => t.remove())));
  const titleAfterTap = async sel => {
    await page.click(await showLink(page, sel));
    await until(page, () => document.querySelector(".rp-peek"));
    const [p] = await peeks(page);
    await page.keyboard.press("Escape");
    await until(page, () => !document.querySelector(".pr-peek"));
    return p.title;
  };
  assert.equal(await titleAfterTap('#S2\\.p1 a[href="#S2.F1"]'), "Figure 1", "링크 title 'Figure 1 ‣ …'");
  assert.equal(await titleAfterTap('a[href="#S2.T1"]:not([title])'), "표 1", "title 없고 글자는 번호뿐");
  assert.equal(await titleAfterTap('a[href="#alg1"]'), "Algorithm 1", "글자가 이미 이름");
  assert.deepEqual(page.errors, []);
});

(async () => {
  let browser;
  try { browser = await chromium.launch(); } catch (e) { console.log("SKIP Chromium 실행 불가:", String(e).split("\n")[0]); process.exit(0); }
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn(browser);
      console.log(`  ok   ${t.name}`);
    } catch (e) {
      failed++;
      console.log(`  FAIL ${t.name}\n${e && e.stack ? e.stack : e}`);
    }
  }
  await browser.close();
  console.log(`ref-peek.browser.js: ${tests.length - failed}/${tests.length} passed`);
  process.exitCode = failed ? 1 : 0;
})();
