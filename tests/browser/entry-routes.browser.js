// entry-routes 브라우저 확인 (전체 번들): #q= 딥링크 이동·칠하기, 선택 '공유' 링크 왕복(앞 문맥 포함),
// ⋯ '공유', 하이라이트 공유(#s=) 왕복, 홈 ?err= 알림·북마클릿, /share 리다이렉트
//   node tests/browser/entry-routes.browser.js <port>
"use strict";
const assert = require("node:assert/strict");

let chromium;
try { ({ chromium } = require("playwright")); } catch { console.log("SKIP playwright 없음"); process.exit(0); }

const PORT = process.argv[2];
const BASE = `http://127.0.0.1:${PORT}`;
const PAPER = `${BASE}/paper/2401.00001`;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// 바깥 네트워크는 막고(그림은 같은 비율의 SVG), navigator.share는 기록만
async function newPage(browser, { init } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 412, height: 560 }, serviceWorkers: "block" });
  await ctx.route(u => !u.href.startsWith(BASE), r => {
    if (r.request().resourceType() !== "image") return r.fulfill({ status: 200, body: "", contentType: "text/plain" });
    const [w, h] = r.request().url().endsWith("x1.png") ? [598, 300] : [300, 200];
    return r.fulfill({ status: 200, body: `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"/>`, contentType: "image/svg+xml" });
  });
  await ctx.route(`${BASE}/api/prewarm/**`, r => r.fulfill({ status: 200, body: "{}", contentType: "application/json" }));
  await ctx.addInitScript(() => {
    window.__shared = [];
    Object.defineProperty(navigator, "share", { configurable: true, value: async d => { window.__shared.push(d); } });
  });
  if (init) await ctx.addInitScript(init);
  const page = await ctx.newPage();
  page.errors = [];
  page.on("pageerror", e => page.errors.push(String(e)));
  return page;
}
async function open(page, url = PAPER) {
  await page.goto(url);
  await page.waitForFunction(() => window.PaperApp && document.readyState === "complete");
}
const until = (page, fn, arg) => page.waitForFunction(fn, arg, { timeout: 5000 });
// 칠한 이름의 첫 Range: {text (정규화), top, start}
const painted = (page, name) => page.evaluate(n => {
  const hl = CSS.highlights.get(n);
  const r = hl && [...hl][0];
  if (!r) return null;
  return { text: PaperAnchor.normalize(r.toString()), top: r.getBoundingClientRect().top, start: PaperAnchor.offsetsOf(r).start, vh: innerHeight };
}, name);

test("#q= 딥링크: 그 문장으로 스크롤하고 er-quote로 칠함, 없는 문장은 알림", async browser => {
  const page = await newPage(browser);
  const q = "The training loss combines the task loss and a balancing term";
  await open(page, `${PAPER}#q=${encodeURIComponent(q)}`);
  await until(page, () => CSS.highlights.has("er-quote"));
  const p = await painted(page, "er-quote");
  assert.equal(p.text, q.toLowerCase());
  assert.ok(p.top >= 0 && p.top < p.vh, `화면 안이어야 함: ${p.top}`);
  assert.ok(await page.evaluate(() => window.scrollY > 0));
  assert.equal(await page.evaluate(() => PaperNav.depth), 0); // 첫 점프는 돌아가기 칩 없음
  const page2 = await newPage(browser);
  await open(page2, `${PAPER}#q=${encodeURIComponent("no such sentence anywhere")}`);
  await until(page2, () => /찾지 못했/.test(document.querySelector("#pr-toast span")?.textContent || ""));
  assert.deepEqual([...page.errors, ...page2.errors], []);
});

test("선택 '공유' → #q= 링크(본문에 두 번 나오면 &p= 앞 문맥) → 그 링크로 열면 같은 곳", async browser => {
  const page = await newPage(browser);
  await open(page);
  const quote = "matches a dense baseline";
  const r = await page.evaluate(q => {
    const idx = PaperAnchor.index(), nm = PaperAnchor.normMap(idx.text);
    const i = nm.norm.indexOf(q), j = nm.norm.indexOf(q, i + 1); // 두 번째 등장
    const start = nm.map[j], end = nm.map[j + q.length - 1] + 1;
    PaperApp.selectRange(PaperAnchor.rangeAt(start, end));
    return { start, twice: i >= 0 && j > i };
  }, quote);
  assert.ok(r.twice, "픽스처에 두 번 나오는 구절이어야 함");
  await page.click('#sel-bar button[data-id="entry-routes"]');
  await until(page, () => window.__shared.length === 1);
  const shared = await page.evaluate(() => window.__shared[0]);
  assert.equal(shared.text, `“${quote}”`);
  assert.equal(shared.title, await page.title());
  assert.ok(shared.url.startsWith(`${PAPER}#q=matches%20a%20dense%20baseline&p=`), shared.url);
  assert.ok(shared.url.includes(":~:text=matches%20a%20dense%20baseline"));

  const page2 = await newPage(browser);
  await open(page2, shared.url);
  await until(page2, () => CSS.highlights.has("er-quote"));
  const p = await painted(page2, "er-quote");
  assert.equal(p.text, quote);
  assert.equal(p.start, r.start, "앞 문맥으로 두 번째 등장을 찾아야 함");
  assert.deepEqual([...page.errors, ...page2.errors], []);
});

test("⋯ '공유'(하이라이트 없음): 논문 링크만 바로 공유", async browser => {
  const page = await newPage(browser);
  await open(page);
  await page.click("#bar-more");
  await page.locator(".pr-menu-item", { hasText: "공유" }).click();
  await until(page, () => window.__shared.length === 1);
  assert.deepEqual(await page.evaluate(() => window.__shared[0]), { title: await page.title(), url: PAPER });
  assert.deepEqual(page.errors, []);
});

test("하이라이트 공유: 고르기 → 링크 만들기 → #s= 링크를 열면 읽기 전용으로 칠하고 목록", async browser => {
  const init = () => localStorage.setItem("pr:highlights-notes:2401.00001", JSON.stringify([
    { id: "h1", type: "hl", color: "yellow", anchor: { quote: "We introduce a top-two routing rule", prefix: "", suffix: "" }, ts: 1 },
    { id: "n1", type: "note", anchor: { quote: "load balancing loss" }, note: "핵심 메모", ts: 2 },
    { id: "q1", type: "qa", anchor: { quote: "Code and checkpoints" }, qa: { q: "어디에?", a: "**깃허브**" }, ts: 3 },
  ]));
  const page = await newPage(browser, { init });
  await open(page);
  await page.click("#bar-more");
  await page.locator(".pr-menu-item", { hasText: "공유" }).click();
  await until(page, () => document.querySelectorAll(".er-check input").length === 3);
  await page.locator(".er-check input").nth(2).uncheck(); // Q&A는 빼고
  await page.locator("button", { hasText: "공유 링크 만들기" }).click();
  await page.locator("button", { hasText: "링크 보내기" }).click();
  await until(page, () => window.__shared.length === 1);
  const shared = await page.evaluate(() => window.__shared[0]);
  assert.match(shared.url, new RegExp(`^${PAPER.replace(/\./g, "\\.")}#s=[A-Za-z0-9_-]{8,32}$`));
  assert.equal(shared.text, "내 하이라이트 2개");
  assert.equal(await page.inputValue(".er-link"), shared.url);

  const friend = await newPage(browser); // 다른 사람: 자기 하이라이트 없음
  await open(friend, shared.url);
  await until(friend, () => document.querySelector(".er-bar") && CSS.highlights.has("er-shared"));
  assert.match(await friend.textContent(".er-bar-label"), /공유받은 하이라이트 2개/);
  assert.equal(await friend.evaluate(() => CSS.highlights.get("er-shared").size), 2);
  await friend.click(".er-bar button:has-text('목록')");
  await until(friend, () => document.querySelectorAll(".er-item").length === 2);
  assert.match(await friend.textContent(".er-list"), /핵심 메모/);
  const canSave = await friend.evaluate(() => !!PaperApp.feature("highlights-notes")?.add);
  assert.equal(await friend.locator(".er-item-save").count(), canSave ? 2 : 0);
  await friend.locator(".er-item-quote").nth(1).click(); // 목록에서 누르면 peek 닫고 그 문장으로
  await until(friend, () => !document.querySelector(".er-list") && PaperNav.depth === 1);
  await friend.click(".er-bar-x");
  assert.equal(await friend.evaluate(() => CSS.highlights.has("er-shared") || !!document.querySelector(".er-bar")), false);
  assert.deepEqual([...page.errors, ...friend.errors], []);
});

test("홈: ?err= 알림을 보여 주고 주소에서 지움, 북마클릿 안내", async browser => {
  const page = await newPage(browser);
  await open(page, `${BASE}/?err=noid&q=hello%20<b>x</b>`);
  const sec = page.locator('[data-section="entry-routes"]');
  assert.match(await sec.textContent(), /arXiv 논문 번호를 찾지 못했어요/);
  assert.match(await sec.textContent(), /hello <b>x<\/b>/); // 글자로 (태그 아님)
  assert.equal(await sec.locator("b").count(), 0);
  assert.equal(await page.evaluate(() => location.search), "");
  const code = await page.textContent('[data-section="entry-routes:help"] .er-code code');
  assert.ok(code.startsWith(`javascript:void(location.href='${BASE}/share?url='`), code);
  // 알림 칸이 도움말보다 위
  assert.ok(await page.evaluate(() => {
    const s = [...document.querySelectorAll("#home-sections > section")].map(x => x.dataset.section);
    return s.indexOf("entry-routes") < s.indexOf("entry-routes:help");
  }));
  assert.deepEqual(page.errors, []);
});

test("/share·/abs 로 들어오면 논문으로", async browser => {
  const page = await newPage(browser);
  await open(page, `${BASE}/share?text=${encodeURIComponent("look https://arxiv.org/abs/2401.00001")}`);
  assert.equal(page.url(), PAPER);
  await open(page, `${BASE}/abs/2401.00001`);
  assert.equal(page.url(), PAPER);
  assert.equal(await page.evaluate(() => document.body.dataset.page), "paper");
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
  console.log(`entry-routes.browser.js: ${tests.length - failed}/${tests.length} passed`);
  process.exitCode = failed ? 1 : 0;
})();
