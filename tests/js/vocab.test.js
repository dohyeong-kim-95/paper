"use strict";
const { test, assert, load } = require("./_runner");
const V = load("static/features/vocab.js");
const { DAY, review, dueCards, makeCard, upsertCard, sentenceAround, meaningFromAnswer, cleanTerm, termKey, deepLink, toTSV, daysUntil, dayEnd, intervalDays } = V;

const NOW = Date.UTC(2026, 9, 23, 3, 0, 0);

test("review: 'got'으로 step 1→2면 due = now + 3일, 'forgot'은 step 0 + 1일", () => {
  const card = { id: "kd", term: "KD", step: 1, due: NOW - DAY, ts: 1 };
  const got = review(card, "got", NOW);
  assert.equal(got.step, 2);
  assert.equal(got.due, NOW + 3 * DAY);
  assert.equal(got.ts, NOW);
  const forgot = review({ ...card, step: 4 }, "forgot", NOW);
  assert.equal(forgot.step, 0);
  assert.equal(forgot.due, NOW + 1 * DAY);
  assert.equal(card.step, 1, "원본은 그대로");
});

test("review: 간격 1·3·7·14·30일, 마지막 단계에서는 30일 유지", () => {
  let c = makeCard({ term: "router" }, NOW);
  const days = [];
  for (let i = 0; i < 7; i++) { c = review(c, "got", NOW); days.push((c.due - NOW) / DAY); }
  assert.deepEqual(days, [1, 3, 7, 14, 30, 30, 30]);
  assert.equal(c.step, 5);
  assert.equal(c.reviews, 7);
  assert.equal(intervalDays({ step: 2 }, "got"), 7);
  assert.equal(intervalDays({ step: 2 }, "forgot"), 1);
});

test("dueCards: now 이전만, 오래 밀린 것부터 (같으면 낮은 단계 → 먼저 넣은 것)", () => {
  const list = [
    { id: "a", term: "a", due: NOW - 2 * DAY, step: 2, added: 1 },
    { id: "b", term: "b", due: NOW + DAY, step: 0, added: 2 },
    { id: "c", term: "c", due: NOW - 5 * DAY, step: 1, added: 3 },
    { id: "d", term: "d", due: NOW - 2 * DAY, step: 0, added: 4 },
    { id: "e", term: "e", due: NOW, step: 0, added: 0 },
    { id: "f", term: "f", due: NOW - 2 * DAY, step: 0, added: 1 },
    null, { id: "x" },
  ];
  assert.deepEqual(dueCards(list, NOW).map(c => c.id), ["c", "f", "d", "a", "e"]);
  assert.deepEqual(dueCards(null, NOW), []);
});

test("dayEnd/daysUntil: 오늘 안이면 0, 내일이면 1", () => {
  const end = dayEnd(NOW);
  assert.ok(end >= NOW && end - NOW < DAY);
  assert.equal(daysUntil(NOW + 60e3, NOW), 0);
  assert.equal(daysUntil(end + 1, NOW), 1);
  assert.equal(daysUntil(end + 3 * DAY - 5, NOW), 3);
  assert.equal(daysUntil(NOW - DAY, NOW), 0);
});

test("cleanTerm/termKey: 구두점·감싼 괄호·따옴표 제거, 대소문자 무시", () => {
  assert.equal(cleanTerm("  experts. "), "experts");
  assert.equal(cleanTerm("(KD)"), "KD");
  assert.equal(cleanTerm("“router”,"), "router");
  assert.equal(cleanTerm("softmax(x)"), "softmax(x)");
  assert.equal(termKey("Mixture  of Experts"), "mixture of experts");
});

const CTX = "Large language models scale well, but dense computation grows as $x^{2}$ for a model of width $x$ . We propose a sparse mixture of experts model that routes each token to two experts [1, 2]. Knowledge distillation (KD) compresses the router, and the KD loss is cheap. See Fig. 2 for the KD setup, e.g. the teacher. Our code is online.";

test("sentenceAround: 선택한 용어가 든 문장만 (수식 뒤 마침표, 약어 Fig./e.g.는 경계 아님)", () => {
  assert.equal(sentenceAround(CTX, "mixture of experts"), "We propose a sparse mixture of experts model that routes each token to two experts [1, 2].");
  assert.equal(sentenceAround(CTX, "width"), "Large language models scale well, but dense computation grows as $x^{2}$ for a model of width $x$ .");
  assert.equal(sentenceAround(CTX, "teacher"), "See Fig. 2 for the KD setup, e.g. the teacher.");
  assert.equal(sentenceAround(CTX, "online"), "Our code is online.");
  assert.equal(sentenceAround(CTX, "transformer"), "");
  assert.equal(sentenceAround("", "x"), "");
});

test("sentenceAround: 마침표 뒤 각주 번호(cheap.1)는 경계, 소수(3.1)는 경계 아님", () => {
  const t = "The KD loss is cheap.1 Our implementation is online. See Section 3.1 We also ablate it.";
  assert.equal(sentenceAround(t, "KD loss"), "The KD loss is cheap.");
  assert.equal(sentenceAround(t, "implementation"), "Our implementation is online.");
  assert.equal(sentenceAround(t, "ablate"), "See Section 3.1 We also ablate it.");
});

test("sentenceAround: prefix로 같은 용어의 바로 그 등장을 고름", () => {
  assert.equal(sentenceAround(CTX, "KD"), "Knowledge distillation (KD) compresses the router, and the KD loss is cheap.");
  assert.equal(sentenceAround(CTX, "KD", "is cheap. See Fig. 2 for the "), "See Fig. 2 for the KD setup, e.g. the teacher.");
  // 색인의 prefix는 공백이 여러 개일 수 있음
  assert.equal(sentenceAround(CTX, "KD", "See Fig.  2 for the\n"), "See Fig. 2 for the KD setup, e.g. the teacher.");
});

test("sentenceAround: 긴 문장은 용어 주변 300자만 …", () => {
  const long = `${"alpha ".repeat(80)}the gating network ${"beta ".repeat(80)}end.`;
  const s = sentenceAround(long, "gating network");
  assert.ok(s.length <= 302, s.length);
  assert.ok(s.startsWith("…") && s.endsWith("…"));
  assert.ok(s.includes("the gating network"));
});

test("meaningFromAnswer: 앞 2줄, 용어만 있는 머리줄·제목 기호·근거 줄 제외", () => {
  const ans = "### mixture of experts\n\n**희소 전문가 혼합**: 입력마다 일부 전문가만 쓰는 구조\n여러 하위 모델을 섞는 일반적인 기법\n뉘앙스: 효율\n\n근거: \"We propose a sparse mixture of experts\"";
  assert.equal(meaningFromAnswer(ans, "Mixture of Experts"), "**희소 전문가 혼합**: 입력마다 일부 전문가만 쓰는 구조\n여러 하위 모델을 섞는 일반적인 기법");
  assert.equal(meaningFromAnswer("한 줄 뜻\n\n근거: \"x y z\"\n\"more\"", "kd"), "한 줄 뜻");
  assert.equal(meaningFromAnswer("", "x"), "");
  assert.equal(meaningFromAnswer("부분 답\n\n[오류] 끊김", "x"), "부분 답");
});

test("meaningFromAnswer: 앞 2줄에 이 논문의 뜻(굵게)이 없으면 그 줄을 더함 (용어 자체의 굵게는 제외)", () => {
  const ans = "**router** (라우터)\n1. 네트워크 장비\n2. **토큰을 전문가에 배정하는 작은 네트워크** ← 이 논문\n설명: …";
  assert.equal(meaningFromAnswer(ans, "router"), "**router** (라우터)\n1. 네트워크 장비\n2. **토큰을 전문가에 배정하는 작은 네트워크** ← 이 논문");
  assert.ok(meaningFromAnswer("x".repeat(1000), "y").length <= 400);
});

test("makeCard/upsertCard: 같은 단어는 한 장, 단계 유지·빈 칸만 채움·새 뜻은 덮어씀", () => {
  const a = makeCard({ term: "Router.", sentence: "", paperId: "2401.00001", title: "T", prefix: "x".repeat(50) }, NOW);
  assert.deepEqual([a.id, a.term, a.step, a.due, a.meaning, a.prefix.length], ["router", "Router", 0, NOW, "", 32]);
  let r = upsertCard([], a);
  assert.equal(r.existed, false);
  const reviewed = review(r.card, "got", NOW);
  r = upsertCard([reviewed], makeCard({ term: "router", sentence: "The router routes.", paperId: "2402.1", meaning: "뜻" }, NOW + 5));
  assert.equal(r.existed, true);
  assert.equal(r.list.length, 1);
  assert.deepEqual([r.card.step, r.card.due, r.card.sentence, r.card.paperId, r.card.meaning, r.card.ts],
    [1, NOW + DAY, "The router routes.", "2402.1", "뜻", NOW + 5]);
  // 문장이 이미 있으면 처음 문장·논문 유지, 빈 뜻은 기존 뜻을 지우지 않음
  r = upsertCard(r.list, makeCard({ term: "ROUTER", sentence: "Other.", paperId: "9999.9" }, NOW + 9));
  assert.deepEqual([r.card.sentence, r.card.paperId, r.card.meaning], ["The router routes.", "2402.1", "뜻"]);
});

test("deepLink: entry-routes의 #q= 형식 (인용 + 앞 문맥)", () => {
  assert.equal(deepLink({ paperId: "2401.00001", term: "mixture of experts", prefix: "a sparse " }),
    "/paper/2401.00001#q=mixture%20of%20experts&p=a%20sparse%20");
  assert.equal(deepLink({ paperId: "2401.00001v2", term: "KD (x)" }), "/paper/2401.00001v2#q=KD%20%28x%29");
  assert.equal(deepLink({ term: "x" }), "");
});

test("toTSV: Anki 머리줄, 칸 안 탭·줄바꿈·HTML 처리, 굵게 → <b>", () => {
  const tsv = toTSV([{ term: "a<b", meaning: "**뜻**\n둘째\tx", sentence: "s", title: "T", paperId: "1" }, { id: "z" }]);
  assert.equal(tsv, "#separator:tab\n#html:true\na&lt;b\t<b>뜻</b><br>둘째 x\ts\tT\t1\n");
});
