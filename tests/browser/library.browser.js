// library 브라우저 확인 (헤드리스 Chromium + Playwright, 전체 기능 번들). tests/test_browser.py가 서버를 띄우고 실행:
//   node tests/browser/library.browser.js <port>
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");

let chromium;
try { ({ chromium } = require("playwright")); } catch { console.log("SKIP playwright 없음"); process.exit(0); }

const PORT = process.argv[2];
const BASE = `http://127.0.0.1:${PORT}`;
const PAPER = `${BASE}/paper/2401.00001`;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// 바깥 네트워크는 막고(빈 응답, 그림은 크기 맞춘 SVG), 공유 시트는 없는 것으로 (다운로드는 <a download>), 클립보드는 기록
async function newPage(browser, seed) {
  const ctx = await browser.newContext({ viewport: { width: 412, height: 800 }, serviceWorkers: "block", acceptDownloads: true });
  await ctx.route(u => !u.href.startsWith(BASE), r => (r.request().resourceType() === "image"
    ? r.fulfill({ status: 200, body: '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200"/>', contentType: "image/svg+xml" })
    : r.fulfill({ status: 200, body: "", contentType: "text/plain" })));
  await ctx.route(`${BASE}/api/ask`, r => r.fulfill({ status: 200, body: "답변입니다.", contentType: "text/plain; charset=utf-8" }));
  await ctx.addInitScript(seedData => {
    window.__copied = [];
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async t => { window.__copied.push(t); } } });
    Object.defineProperty(navigator, "canShare", { configurable: true, value: undefined });
    Object.defineProperty(navigator, "share", { configurable: true, value: undefined });
    // 처음 한 번만 심음 (새로고침 뒤에는 페이지가 쓴 값 유지)
    if (seedData && !sessionStorage.getItem("__seeded")) {
      sessionStorage.setItem("__seeded", "1");
      for (const [k, v] of Object.entries(seedData)) localStorage.setItem(k, JSON.stringify(v));
    }
  }, seed || null);
  const page = await ctx.newPage();
  // 이 기능에서 난 오류만 (전체 번들에서 다른 기능의 오류는 그 기능의 테스트가 잡음)
  page.errors = [];
  page.on("pageerror", e => { if (/library/.test(`${e.stack || ""} ${e}`)) page.errors.push(String(e)); });
  return page;
}
async function open(page, url) {
  await page.goto(url);
  await page.waitForFunction(() => window.PaperApp && document.readyState === "complete");
}
const until = (page, fn, arg, timeout = 8000) => page.waitForFunction(fn, arg, { timeout });
const lib = page => page.evaluate(() => JSON.parse(localStorage.getItem("pr:library") || "{}"));
async function menu(page, label) {
  await page.click("#bar-more");
  const item = page.locator(".pr-menu-item", { hasText: label }).first();
  await item.waitFor();
  await item.click();
}
const menuLabels = async page => {
  await page.click("#bar-more");
  const labels = await page.locator(".pr-menu-item").allTextContents();
  await page.keyboard.press("Escape");
  return labels;
};

test("논문 화면: 기록·인용 표시(CiteSee)·즐겨찾기·상태·태그·BibTeX·add API", async browser => {
  const now = Date.now();
  const page = await newPage(browser, {
    "pr:library": {
      "2301.00001": { id: "2301.00001", title: "Cited paper", opened: now - 5000 },
      "2399.99999": { id: "2399.99999", title: "Other A", opened: now - 4000, cites: ["2302.00002", "2301.00001"] },
      "2398.99999": { id: "2398.99999", title: "Other B", opened: now - 3000, cites: ["2302.00002"] },
    },
  });
  await open(page, PAPER);
  const rec = (await lib(page))["2401.00001"];
  assert.equal(rec.title, "Sparse Mixtures for Everyone: A Test Paper");
  assert.deepEqual(rec.authors, ["Alice Kim", "Bob Lee", "Carol Park", "Dan Choi"]);
  assert.ok(rec.opened >= now - 1000);

  // 유휴 작업: 참고문헌의 arXiv id 저장 + 인용 링크 표시
  await until(page, () => (JSON.parse(localStorage.getItem("pr:library"))["2401.00001"] || {}).cites, null, 20000);
  assert.deepEqual((await lib(page))["2401.00001"].cites, ["2301.00001", "2302.00002"]);
  const cls = () => page.evaluate(() => Object.fromEntries(["bib1", "bib2", "bib4"].map(b =>
    [b, [...document.querySelector(`#paper a[href="#bib.${b}"]`).classList].filter(c => c.startsWith("lib-")).sort().join(" ")])));
  assert.deepEqual(await cls(), { bib1: "lib-cf1 lib-cite-seen", bib2: "", bib4: "lib-cf2" });
  assert.equal(await page.evaluate(() => PaperAnchor.index().text.includes("●")), false);

  // add API (§6.1): 상태는 뒤로 안 감, opened는 건드리지 않음, 서재에 들어오면 인용 표시가 바로 갱신
  const added = await page.evaluate(() => {
    const L = PaperApp.feature("library");
    L.add({ id: "2302.00002v1", title: "Efficient expert routing", status: "reading" });
    return [L.add({ id: "2302.00002", status: "to-read", tags: ["moe"] }), L.get("2302.00002v3"), L.add({})];
  });
  assert.equal(added[0].status, "reading");
  assert.deepEqual(added[0].tags, ["moe"]);
  assert.equal(added[0].opened, undefined);
  assert.equal(added[1].title, "Efficient expert routing");
  assert.equal(added[2], null);
  assert.deepEqual(await cls(), { bib1: "lib-cf1 lib-cite-seen", bib2: "", bib4: "lib-cf2 lib-cite-seen" });

  // ⋯ 메뉴: 표의 순서 (즐겨찾기 60 < 읽기 상태 150 < BibTeX 160)
  const labels = await menuLabels(page);
  const at = l => labels.findIndex(x => x.includes(l));
  assert.ok(at("☆ 즐겨찾기") >= 0 && at("☆ 즐겨찾기") < at("읽기 상태") && at("읽기 상태") < at("BibTeX 복사"), labels.join(" | "));

  await menu(page, "☆ 즐겨찾기");
  assert.equal((await lib(page))["2401.00001"].star, true);
  assert.ok((await menuLabels(page)).some(x => x.includes("★ 즐겨찾기")));

  await menu(page, "BibTeX 복사");
  const bib = await page.evaluate(() => window.__copied.at(-1));
  assert.match(bib, /^@misc\{kim2024,/);
  assert.match(bib, /eprint = \{2401\.00001\}/);
  assert.match(bib, /author = \{Alice Kim and Bob Lee and Carol Park and Dan Choi\}/);

  // 읽기 상태 peek: 완료로, 태그 추가(Enter), 태그 지우기
  await menu(page, "읽기 상태");
  const peek = page.locator(".pr-peek.lib-peek");
  await peek.locator("button", { hasText: "완료" }).click();
  await peek.locator(".lib-tag-input").fill("Routing, #moe");
  await peek.locator(".lib-tag-input").press("Enter");
  let r = (await lib(page))["2401.00001"];
  assert.equal(r.status, "done");
  assert.deepEqual(r.tags, ["Routing", "moe"]);
  assert.equal(await peek.locator(".lib-tag-input").evaluate(el => el === document.activeElement), true, "태그 입력칸 포커스 유지");
  await peek.locator("button", { hasText: "#Routing ✕" }).click();
  r = (await lib(page))["2401.00001"];
  assert.deepEqual(r.tags, ["moe"]);
  await page.keyboard.press("Escape");
  assert.ok((await menuLabels(page)).some(x => x.includes("읽기 상태 · 완료")));
  assert.deepEqual(page.errors, []);
});

test("홈: 이어 읽기(진행률)·즐겨찾기·전체 기록 필터·모든 노트·삭제 실행 취소", async browser => {
  const now = Date.now();
  const page = await newPage(browser, {
    "pr:library": {
      "2401.00001": { id: "2401.00001", title: "Sparse Mixtures", authors: ["Alice Kim", "Bob Lee"], opened: now - 60000, status: "reading", readMs: 12 * 60000, gist: "희소 전문가 혼합", tags: ["moe"] },
      "2302.00002": { id: "2302.00002", title: "Efficient routing", opened: now - 3600000, status: "done", star: true, tags: ["moe", "routing"] },
      "2301.00001": { id: "2301.00001", title: "To read later", updated: now - 7200000, status: "to-read" },
    },
    "pr:toc-progress:pos:2401.00001": { pct: 42, ts: now },
    "pr:highlights-notes:2401.00001": [
      { id: "n1", type: "note", anchor: { quote: "routes each token to two experts" }, note: "핵심 아이디어", ts: now - 1000 },
      { id: "q1", type: "qa", anchor: { quote: "KD loss is cheap" }, qa: [{ q: "KD가 뭐야?", a: "지식 **증류**" }], ts: now - 2000 },
    ],
    "pr:cite-cards:bib": [{ id: "b1", key: "x2023", bibtex: "@misc{x2023, title={X}}", ts: now }],
  });
  await open(page, `${BASE}/`);
  const sec = page.locator('[data-section="library"]');
  await sec.waitFor();
  assert.match(await sec.locator("h2").textContent(), /내 서재 3편 · 12분 읽음/);

  // 이어 읽기: 완료 제외, 연 적 없는 것 제외
  const recent = sec.locator(".lib-recent .lib-card");
  assert.equal(await recent.count(), 1);
  assert.match(await recent.first().textContent(), /Sparse Mixtures.*Alice Kim, Bob Lee.*희소 전문가 혼합.*읽는 중.*#moe.*42% · 12분/);
  assert.equal(await recent.first().locator(".lib-bar > span").getAttribute("style"), "width:42%");
  assert.equal(await recent.first().locator("a").getAttribute("href"), "/paper/2401.00001");

  // 즐겨찾기가 있으면 그 탭부터
  const tab = name => sec.locator(".lib-tab", { hasText: name });
  assert.equal(await tab("★ 즐겨찾기 1").getAttribute("aria-selected"), "true");
  const titles = () => sec.locator(".lib-list .lib-card-title").allTextContents();
  assert.deepEqual(await titles(), ["★ Efficient routing"]);

  await tab("전체 기록 3").click();
  assert.deepEqual(await titles(), ["Sparse Mixtures", "★ Efficient routing", "To read later"]);
  await sec.locator(".lib-chips .lib-chip", { hasText: "읽을 예정" }).click();
  assert.deepEqual(await titles(), ["To read later"]);
  await sec.locator(".lib-chips .lib-chip", { hasText: "전체" }).first().click();
  await sec.locator(".lib-chips .lib-chip", { hasText: "#routing" }).click();
  assert.deepEqual(await titles(), ["★ Efficient routing"]);
  await sec.locator(".lib-chips .lib-chip", { hasText: "#routing" }).click();
  await sec.locator(".lib-search").fill("sparse");
  await until(page, () => document.querySelectorAll('[data-section="library"] .lib-list .lib-card').length === 1);
  await sec.locator(".lib-search").fill("");

  // ⋯ → 기록에서 삭제 → 실행 취소
  await until(page, () => document.querySelectorAll('[data-section="library"] .lib-list .lib-card').length === 3);
  await sec.locator('.lib-list .lib-card[data-id="2301.00001"] .lib-more').click();
  await page.locator(".pr-peek.lib-peek button", { hasText: "기록에서 삭제" }).click();
  assert.equal((await lib(page))["2301.00001"], undefined);
  assert.equal(await sec.locator('.lib-list .lib-card[data-id="2301.00001"]').count(), 0);
  await page.locator("#pr-toast button", { hasText: "실행 취소" }).click();
  assert.equal((await lib(page))["2301.00001"].title, "To read later");
  assert.equal(await sec.locator('.lib-list .lib-card[data-id="2301.00001"]').count(), 1);

  // 모든 노트: 검색·종류, Q&A 답은 펼칠 때 그림, 링크는 #q= 딥링크
  await tab("모든 노트 2").click();
  const notes = sec.locator(".lib-list .lib-note");
  assert.equal(await notes.count(), 2);
  assert.match(await notes.first().textContent(), /routes each token to two experts.*핵심 아이디어.*Sparse Mixtures.*메모/);
  assert.equal(await notes.first().locator(".lib-note-foot a").getAttribute("href"), "/paper/2401.00001#q=routes%20each%20token%20to%20two%20experts");
  await sec.locator(".lib-chips .lib-chip", { hasText: "Q&A" }).click();
  assert.equal(await notes.count(), 1);
  assert.equal(await notes.first().locator(".lib-qa .lib-md").textContent(), "");
  await notes.first().locator("summary").click();
  await until(page, () => /지식/.test(document.querySelector('[data-section="library"] .lib-qa .lib-md').textContent));
  await sec.locator(".lib-chips .lib-chip", { hasText: "전체" }).first().click();
  await sec.locator(".lib-search").fill("증류");
  await until(page, () => document.querySelectorAll('[data-section="library"] .lib-note').length === 1);

  // 모아둔 참고문헌 .bib (cite-cards 바구니)
  assert.equal(await sec.locator(".lib-backup .lib-btn", { hasText: "모아둔 참고문헌 .bib 1" }).count(), 1);
  assert.deepEqual(page.errors, []);
});

test("백업: 내보내기 → 저장소 비우기 → 가져오기로 복원, 가져오기 실행 취소", async browser => {
  const now = Date.now();
  const page = await newPage(browser, {
    "pr:library": { "2401.00001": { id: "2401.00001", title: "Sparse Mixtures", opened: now - 1000, star: true, tags: ["moe"] } },
    "pr:toc-progress:pos:2401.00001": { pct: 30, ts: now },
    "pr:vocab": [{ id: "v1", term: "router", ts: now }],
  });
  await open(page, `${BASE}/`);
  const sec = page.locator('[data-section="library"]');
  await sec.locator(".lib-card").first().waitFor();
  const [dl] = await Promise.all([page.waitForEvent("download"), sec.locator(".lib-btn", { hasText: "내보내기" }).click()]);
  assert.match(dl.suggestedFilename(), /^paper-reader-backup-\d{4}-\d{2}-\d{2}\.json$/);
  const backup = JSON.parse(fs.readFileSync(await dl.path(), "utf8"));
  assert.equal(backup.app, "paper-reader");
  assert.equal(backup.data["pr:library"]["2401.00001"].title, "Sparse Mixtures");
  assert.deepEqual(backup.data["pr:vocab"], [{ id: "v1", term: "router", ts: now }]);
  await until(page, () => /마지막 방금/.test(document.querySelector(".lib-backup").textContent));

  // 다른 기기: 비어 있음 → 가져오기
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForFunction(() => window.PaperApp && document.readyState === "complete");
  assert.equal(await sec.locator(".lib-empty", { hasText: "아직 기록이 없습니다" }).isVisible(), true);
  await sec.locator(".lib-file").setInputFiles({ name: "backup.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(backup)) });
  await until(page, () => document.querySelectorAll('[data-section="library"] .lib-recent .lib-card').length === 1);
  assert.match(await page.locator("#pr-toast").textContent(), /항목을 가져왔습니다/);
  assert.match(await sec.locator(".lib-recent .lib-card").textContent(), /Sparse Mixtures.*#moe.*30%/);
  const restored = await page.evaluate(() => ({ lib: JSON.parse(localStorage.getItem("pr:library")), vocab: JSON.parse(localStorage.getItem("pr:vocab")) }));
  assert.equal(restored.lib["2401.00001"].star, true);
  assert.equal(restored.vocab.length, 1);

  // 같은 파일을 다시 가져와도 중복 없음, 로컬이 더 최근이면 로컬 값 유지
  await page.evaluate(() => {
    const l = JSON.parse(localStorage.getItem("pr:library"));
    l["2401.00001"] = { ...l["2401.00001"], title: "Local newer", opened: Date.now() };
    localStorage.setItem("pr:library", JSON.stringify(l));
  });
  await sec.locator(".lib-file").setInputFiles({ name: "backup.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(backup)) });
  await until(page, () => /Local newer/.test(document.querySelector('[data-section="library"] .lib-recent').textContent));
  assert.equal(Object.keys((await lib(page))).length, 1);

  // 실행 취소: 가져오기 전으로
  await page.locator("#pr-toast button", { hasText: "실행 취소" }).click();
  await until(page, () => /Local newer/.test(document.querySelector('[data-section="library"] .lib-recent').textContent));

  // 잘못된 파일
  await sec.locator(".lib-file").setInputFiles({ name: "x.json", mimeType: "application/json", buffer: Buffer.from("not json") });
  await until(page, () => /JSON 파일이 아닙니다/.test(document.getElementById("pr-toast")?.textContent || ""));
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
  console.log(`library.browser.js: ${tests.length - failed}/${tests.length} passed`);
  process.exitCode = failed ? 1 : 0;
})();
