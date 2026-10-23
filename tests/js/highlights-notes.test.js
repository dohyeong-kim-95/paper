"use strict";
const { test, assert, load } = require("./_runner");
const hn = load("static/features/highlights-notes.js");
const { COLORS, normPrefs, typeOf, makeItem, addQa, sortByPosition, hitAt, overlaps, flattenQa, turnsOf,
  serialPresets, threadRecord, upsertThread, notesDigest, groupRuns, toMarkdown, MAX_THREADS } = hn;

const anchor = (quote, paraId = "S1.p1") => ({ quote, prefix: "pre ", suffix: " suf", paraId });

test("색 4개, 설정 기본값과 잘못된 값 정리", () => {
  assert.deepEqual(COLORS.map(c => c.id), ["yellow", "green", "blue", "pink"]);
  assert.deepEqual(normPrefs(null), { color: "yellow", highlighter: false, useNotes: false });
  assert.deepEqual(normPrefs({ color: "red", highlighter: 1, useNotes: "y" }), { color: "yellow", highlighter: true, useNotes: true });
  assert.equal(normPrefs({ color: "pink" }).color, "pink");
});

test("makeItem: 계약 모양 {id, type, color, anchor{quote,prefix,suffix,paraId}, note, qa, ts}, 종류는 내용으로", () => {
  const it = makeItem({ anchor: { ...anchor("x"), extra: 1 }, color: "blue" }, 1000);
  assert.deepEqual(Object.keys(it).sort(), ["anchor", "color", "id", "note", "qa", "ts", "type"]);
  assert.deepEqual(it.anchor, anchor("x"));
  assert.equal(it.type, "hl");
  assert.equal(it.ts, 1000);
  assert.equal(makeItem({ anchor: anchor("x"), note: "메모" }).type, "note");
  const qa = makeItem({ anchor: null, qa: [{ q: "Q", a: "A" }], thread: "t1" });
  assert.equal(qa.type, "qa");
  assert.equal(qa.anchor, null, "인용 없는 답변 저장은 논문 전체");
  assert.equal(qa.thread, "t1");
  assert.notEqual(makeItem({}).id, makeItem({}).id);
  assert.equal(makeItem({ color: "nope" }).color, "yellow");
});

test("addQa: 같은 답변은 한 번만, 종류·시각 갱신", () => {
  const it = makeItem({ anchor: anchor("x") }, 1);
  addQa(it, "Q1", "A1", 5);
  addQa(it, "Q1 again", "A1", 6);
  addQa(it, "Q2", "A2", 7);
  assert.deepEqual(it.qa, [{ q: "Q1", a: "A1" }, { q: "Q2", a: "A2" }]);
  assert.equal(it.type, "qa");
  assert.equal(it.ts, 7);
  assert.equal(typeOf({ note: "  ", qa: [] }), "hl");
});

test("sortByPosition: 본문 위치(앵커 순서) 순, 논문 전체는 맨 앞, 못 찾은 것은 맨 뒤", () => {
  const a = { id: "a", anchor: anchor("A"), ts: 3 }, b = { id: "b", anchor: anchor("B"), ts: 1 };
  const c = { id: "c", anchor: anchor("C"), ts: 2 }, paper = { id: "p", anchor: null, ts: 9 }, lost = { id: "l", anchor: anchor("L"), ts: 0 };
  const pos = { a: { start: 50, end: 60 }, b: { start: 10, end: 20 }, c: 30, l: null };
  assert.deepEqual(sortByPosition([a, lost, b, paper, c], pos).map(x => x.id), ["p", "b", "c", "a", "l"]);
  // Map도 받음, 같은 위치면 먼저 저장한 것
  const d = { id: "d", anchor: anchor("D"), ts: 1 }, e = { id: "e", anchor: anchor("E"), ts: 0 };
  assert.deepEqual(sortByPosition([d, e], new Map([["d", { start: 5 }], ["e", { start: 5 }]])).map(x => x.id), ["e", "d"]);
  assert.deepEqual(sortByPosition([], {}), []);
});

test("hitAt: 탭 위치를 포함하는 가장 짧은 구간, overlaps", () => {
  const entries = [{ id: "wide", start: 0, end: 100 }, { id: "narrow", start: 40, end: 50 }, { id: "none" }];
  assert.equal(hitAt(entries, 45), "narrow");
  assert.equal(hitAt(entries, 10), "wide");
  assert.equal(hitAt(entries, 100), null, "끝은 포함 안 함");
  assert.equal(overlaps({ start: 0, end: 10 }, { start: 9, end: 12 }), true);
  assert.equal(overlaps({ start: 0, end: 10 }, { start: 10, end: 12 }), false);
  assert.equal(overlaps(null, { start: 0, end: 1 }), false);
});

test("flattenQa / turnsOf: 저장한 Q&A ↔ 대화 기록", () => {
  const hist = flattenQa([{ q: "Q1", a: "A1" }, { q: "Q2", a: "A2" }]);
  assert.deepEqual(hist, [
    { role: "user", content: "Q1" }, { role: "assistant", content: "A1" },
    { role: "user", content: "Q2" }, { role: "assistant", content: "A2" },
  ]);
  assert.deepEqual(turnsOf({ history: hist, shown: ["보인 질문"] }), [{ q: "보인 질문", a: "A1" }, { q: "Q2", a: "A2" }]);
});

const session = over => ({
  id: "s2", threadId: "t1", quote: "the quote", selection: "SEL", context: "CTX\n<reader>R</reader>", section: "2 Method",
  endpoint: "/api/figure-explain/ask", extra: { figure_id: "S2.F1", image_urls: ["x1.png"] }, title: "그림 설명",
  history: [{ role: "user", content: "Q1 <style>짧게</style>" }, { role: "assistant", content: "A1" }],
  shown: ["Q1"], meta: [{ label: "쉽게 설명", presetId: "easy", via: null }], selInfo: { text: "big" }, ...over,
});

test("threadRecord: 고정 필드 전부 복사 (이어 가면 첫 턴이 같은 바이트), 앵커·이름·시각", () => {
  const s = session();
  const rec = threadRecord(s, null, { ...anchor("the quote"), junk: 1 }, 42);
  assert.equal(rec.id, "t1");
  for (const k of ["quote", "selection", "context", "section", "endpoint", "extra", "history", "shown", "meta", "title"]) {
    assert.deepEqual(rec[k], s[k], k);
  }
  assert.notEqual(rec.history, s.history, "복사본");
  assert.equal(rec.selInfo, undefined);
  assert.deepEqual(rec.anchor, anchor("the quote"));
  assert.equal(rec.label, "쉽게 설명");
  assert.equal(rec.ts, 42);
  // 갱신: 앵커·이름은 처음 것 유지, 기록은 새것
  const s2 = session({ history: [...s.history, { role: "user", content: "Q2" }, { role: "assistant", content: "A2" }], meta: [{ label: null }] });
  const rec2 = threadRecord(s2, rec, null, 50);
  assert.deepEqual(rec2.anchor, rec.anchor);
  assert.equal(rec2.label, "쉽게 설명");
  assert.equal(rec2.history.length, 4);
  // 프리셋 이름이 없으면 보인 질문, 너무 길면 자름
  const r3 = threadRecord(session({ meta: [], shown: ["x".repeat(200)] }), null, null, 1);
  assert.equal(r3.label.length, 80);
  assert.equal(r3.anchor, null);
  assert.equal(threadRecord(session({ endpoint: "" }), null, null).endpoint, "/api/ask");
  // 처음 연 기능의 origin(불투명 값)과 저장 가능한 프리셋도 (이어 가면 그 기능의 대화로)
  const r4 = threadRecord(session({ origin: { feature: "equation-tools", id: "S2.E1" }, presets: ["핵심은?", { id: "x", label: "X", q: "QX" }] }), null, null, 1);
  assert.deepEqual(r4.origin, { feature: "equation-tools", id: "S2.E1" });
  assert.deepEqual(r4.presets, ["핵심은?", { id: "x", label: "X", q: "QX" }]);
  assert.equal(rec.presets, null);
});

test("serialPresets: 문자열·문자열 q만, 함수 q·run 프리셋은 뺌", () => {
  assert.equal(serialPresets(null), null);
  assert.equal(serialPresets([]), null);
  assert.equal(serialPresets([{ id: "f", label: "F", q: () => "x" }, { id: "r", label: "R", run() {} }]), null);
  assert.deepEqual(serialPresets(["a", { id: 3, label: "L" }, { label: "", q: "Q" }]),
    ["a", { id: "3", label: "L", q: null }, { id: null, label: "Q", q: "Q" }]);
  assert.deepEqual(JSON.parse(JSON.stringify(serialPresets(["a", { id: "b", q: "B" }]))), ["a", { id: "b", label: "B", q: "B" }]);
});

test("groupRuns: 연속한 같은 섹션끼리 묶음 (문서 순서 유지)", () => {
  const sec = { a: "1 Intro", b: "1 Intro", c: "2 Method", d: "1 Intro" };
  assert.deepEqual(groupRuns(["p", "a", "b", "c", "d"], x => sec[x]),
    [{ section: "", items: ["p"] }, { section: "1 Intro", items: ["a", "b"] }, { section: "2 Method", items: ["c"] }, { section: "1 Intro", items: ["d"] }]);
  assert.deepEqual(groupRuns([], x => x), []);
  assert.deepEqual(groupRuns(["a"]), [{ section: "", items: ["a"] }]);
});

test("upsertThread: 같은 id는 교체, 시간순, 최대 개수", () => {
  let list = [];
  for (let i = 0; i < MAX_THREADS + 5; i++) list = upsertThread(list, { id: `t${i}`, ts: i });
  assert.equal(list.length, MAX_THREADS);
  assert.equal(list[0].id, "t5");
  list = upsertThread(list, { id: "t10", ts: 999, history: [1] });
  assert.equal(list.length, MAX_THREADS);
  assert.equal(list[list.length - 1].id, "t10");
  assert.equal(list.filter(t => t.id === "t10").length, 1);
});

test("notesDigest: 하이라이트·메모를 문서 순서로, 1500자 제한, 답변만 저장한 것은 제외", () => {
  const items = [
    { id: "b", anchor: anchor("second passage"), note: "", qa: [] },
    { id: "a", anchor: anchor("first  passage"), note: "내 생각\n두 줄", qa: [] },
    { id: "q", anchor: anchor("answer only"), note: "", qa: [{ q: "Q", a: "A" }] },
    { id: "p", anchor: null, note: "논문 전체 메모", qa: [] },
  ];
  const pos = { a: { start: 1 }, b: { start: 9 }, q: { start: 5 } };
  assert.equal(notesDigest(items, pos), '- (논문 전체) — 메모: 논문 전체 메모\n- "first passage" — 메모: 내 생각 두 줄\n- "second passage"');
  const many = Array.from({ length: 100 }, (_, i) => ({ id: `i${i}`, anchor: anchor(`passage number ${i} `.repeat(3)), note: "", qa: [] }));
  const d = notesDigest(many, {});
  assert.ok(d.length <= 1500 && d.length > 1000, String(d.length));
  assert.ok(notesDigest([{ id: "x", anchor: anchor("y".repeat(3000)), note: "", qa: [] }], {}).length <= 1500);
  assert.equal(notesDigest([], {}), "");
});

test("toMarkdown: 제목·arXiv 링크, 인용은 '> ', 메모, Q&A, 문서 순서, 질문 기록", () => {
  const items = [
    { id: "late", anchor: anchor("Later sentence with $x^2$."), note: "", qa: [{ q: "왜?", a: "답변 **굵게**" }], ts: 1 },
    { id: "early", anchor: anchor("Early line one\nline two"), note: "  내 메모  ", qa: [], ts: 2 },
    { id: "paper", anchor: null, note: "", qa: [{ q: "전체 질문", a: "전체 답" }], ts: 3 },
  ];
  const threads = [
    { id: "t1", label: "쉽게 설명", quote: "Q quote", history: [{ role: "user", content: "Q1+style" }, { role: "assistant", content: "A1" }], shown: ["Q1"], ts: 1 },
    { id: "t0", label: "빈 대화", quote: "", history: [], shown: [], ts: 0 },
  ];
  const md = toMarkdown({ title: "Mixtral Paper", id: "2401.00001" }, items,
    { pos: { late: { start: 90 }, early: { start: 10 } }, threads, tpos: { t1: { start: 5 } }, date: "2026-10-23" });
  assert.ok(md.startsWith("# Mixtral Paper\n\narXiv: https://arxiv.org/abs/2401.00001\n내보낸 날짜: 2026-10-23\n"), md);
  assert.ok(md.includes("> Early line one\n> line two\n\n내 메모\n"));
  assert.ok(md.includes("> Later sentence with $x^2$.\n\n**Q.** 왜?\n\n답변 **굵게**"));
  const order = ["*(논문 전체)*", "> Early line one", "> Later sentence"].map(s => md.indexOf(s));
  assert.ok(order.every((v, i) => v >= 0 && (i === 0 || v > order[i - 1])), `문서 순서 ${order}`);
  assert.ok(md.includes("## 질문 기록\n\n### 쉽게 설명\n\n> Q quote\n\n**Q.** Q1\n\nA1"), "보인 질문으로 (훅이 붙인 지시문 빼고)");
  assert.ok(!md.includes("빈 대화"));
  assert.ok(!/\n{3,}/.test(md));
  assert.ok(md.endsWith("\n"));
  // 노트가 없어도 제목·링크는
  assert.equal(toMarkdown({ id: "2401.00001" }, []), "# 2401.00001\n\narXiv: https://arxiv.org/abs/2401.00001\n");
  // 섹션 제목: 바뀌는 곳마다 '### ', 논문 전체 항목에는 없음
  const md2 = toMarkdown({ title: "T", id: "1" }, items, { pos: { late: { start: 90 }, early: { start: 10 } }, sections: { early: "1 Introduction", late: "2  Method" } });
  assert.ok(md2.includes("## 하이라이트·메모\n\n*(논문 전체)*"), md2);
  assert.ok(md2.includes("---\n\n### 1 Introduction\n\n> Early line one"), md2);
  assert.ok(md2.includes("---\n\n### 2 Method\n\n> Later sentence"), md2);
});
