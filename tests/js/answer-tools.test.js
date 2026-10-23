// answer-tools 순수 함수: 근거 줄 파싱·제거, 질문 훅(한 번만), 읽어주기 텍스트
"use strict";
const { test, assert, load } = require("./_runner");
const { EVIDENCE_ASK, withEvidence, splitEvidence, parseEvidence, cleanQuote, speakable } = load("static/features/answer-tools.js");
const { buildPayload, makeSession } = load("static/app.js");

test("parseEvidence: 근거 줄 두 개 → 인용 두 개", () => {
  assert.deepEqual(parseEvidence('답...\n근거: "we propose a sparse mixture"\n근거: "x"'), ["we propose a sparse mixture", "x"]);
});

test("splitEvidence: 빈 줄 없이 붙은 근거 줄도 본문 문단은 남기고 근거 줄만 뺌 (marked breaks:true 문제)", () => {
  const r = splitEvidence('라우터가 토큰을 두 전문가로 보냅니다.\n근거: "routes each token to two experts"');
  assert.equal(r.body, "라우터가 토큰을 두 전문가로 보냅니다.");
  assert.deepEqual(r.quotes, ["routes each token to two experts"]);
  assert.equal(r.removed, 1);
});

test("splitEvidence: 근거가 없으면 원문 그대로 (removed 0)", () => {
  const t = "그냥 답입니다.\n\n- 항목\n";
  assert.deepEqual(splitEvidence(t), { body: t, quotes: [], removed: 0 });
  assert.deepEqual(splitEvidence(""), { body: "", quotes: [], removed: 0 });
});

test("splitEvidence: 굵게·목록·괄호·전각 콜론·둥근 따옴표·한 줄 두 인용 변형", () => {
  const cases = [
    ['답\n\n**근거:** "we propose a sparse mixture"', ["we propose a sparse mixture"]],
    ['답\n\n**근거**: “the KD loss is cheap.”', ["the KD loss is cheap"]],
    ['답\n- 근거: "A b c" / "d e f"', ["A b c", "d e f"]],
    ['답\n(근거: "routes each token to two experts")', ["routes each token to two experts"]],
    ['답\n근거： 「matches a dense baseline」', ["matches a dense baseline"]],
    ['답\n> 근거 1: "far fewer FLOPs per token"', ["far fewer FLOPs per token"]],
  ];
  for (const [text, quotes] of cases) {
    const r = splitEvidence(text);
    assert.deepEqual(r.quotes, quotes, text);
    assert.equal(r.body, "답", text);
  }
});

test("splitEvidence: '근거:' 머리줄 아래 목록 인용, 앞의 구분선 정리, 뒤 본문 문단은 유지", () => {
  const r = splitEvidence('첫 문단.\n\n---\n근거:\n- "we propose a sparse mixture"\n- "far fewer FLOPs"\n\n덧붙임 문단.');
  assert.deepEqual(r.quotes, ["we propose a sparse mixture", "far fewer FLOPs"]);
  assert.equal(r.body, "첫 문단.\n\n---\n\n덧붙임 문단.");
  const end = splitEvidence('첫 문단.\n\n---\n\n근거: "we propose a sparse mixture"\n');
  assert.equal(end.body, "첫 문단.");
  const twice = splitEvidence('첫 문단.\n근거:\n근거: "we propose a sparse mixture"');
  assert.deepEqual([twice.body, twice.quotes], ["첫 문단.", ["we propose a sparse mixture"]]);
});

test("splitEvidence: 코드 블록 안, 인용이 아닌 '근거:' 줄, '근거가'로 시작하는 문장은 그대로", () => {
  const code = '```\n근거: "not evidence here"\n```';
  assert.deepEqual(splitEvidence(code), { body: code, quotes: [], removed: 0 });
  const prose = "근거: 2절의 실험 결과\n근거가 되는 실험은 표 1입니다.";
  assert.deepEqual(splitEvidence(prose), { body: prose, quotes: [], removed: 0 });
  // 인용 목록이 따라오지 않는 '근거' 제목은 남김
  const heading = "### 근거\n\n저자들은 표 1의 실험을 듭니다.";
  assert.deepEqual(splitEvidence(heading), { body: heading, quotes: [], removed: 0 });
});

test("splitEvidence: 따옴표 없는 영어 근거, 말줄임 인용, 중복·개수 제한", () => {
  assert.deepEqual(parseEvidence("답\n근거: we propose a sparse mixture"), ["we propose a sparse mixture"]);
  assert.deepEqual(parseEvidence('답\n근거: "…each token to two experts ... far"'), ["each token to two experts"]);
  assert.deepEqual(parseEvidence('답\n근거: "A b c"\n근거: "a B c"\n근거: "d"\n근거: "e"\n근거: "f"'), ["A b c", "d", "e"]);
  assert.equal(cleanQuote(' "the KD loss is cheap." '), "the KD loss is cheap");
});

test("withEvidence: /api/ask·figure-explain만, 한 번만, 번역 프리셋·빈 질문은 그대로", () => {
  const p = { arxiv_id: "x", question: "쉽게 설명해줘" };
  const once = withEvidence(p, { endpoint: "/api/ask" });
  assert.equal(once.question, "쉽게 설명해줘" + EVIDENCE_ASK);
  assert.equal(p.question, "쉽게 설명해줘", "원래 payload는 안 바뀜");
  assert.equal(withEvidence(once, { endpoint: "/api/ask" }), once, "이미 있으면 다시 붙이지 않음");
  assert.equal(withEvidence(p, { endpoint: "/api/figure-explain/ask" }).question, once.question);
  assert.equal(withEvidence(p, { endpoint: "/api/other" }), p);
  assert.equal(withEvidence(p, { endpoint: "/api/ask", presetId: "translate" }), p);
  const empty = { question: "  " };
  assert.equal(withEvidence(empty, { endpoint: "/api/ask" }), empty);
});

test("buildPayload + withEvidence: 질문에 한 번만, 기록에 남은 바뀐 질문은 다음 턴에 그대로", () => {
  const s = makeSession({ selection: "S", context: "C" }, "2401.00001");
  const p1 = buildPayload(s, "Q1", [withEvidence], {});
  assert.equal(p1.question, "Q1" + EVIDENCE_ASK);
  assert.equal(p1.question.split("근거:").length, 2);
  s.history.push({ role: "user", content: p1.question }, { role: "assistant", content: 'A1\n근거: "x y z"' });
  const p2 = buildPayload(s, "Q2", [withEvidence], {});
  assert.equal(p2.history[0].content, p1.question);
  assert.equal(p2.question, "Q2" + EVIDENCE_ASK);
  // 같은 훅이 두 번 등록돼도(번들 중복 등) 한 번만
  assert.equal(buildPayload(s, "Q3", [withEvidence, withEvidence], {}).question, "Q3" + EVIDENCE_ASK);
});

test("speakable: Markdown 기호 제거, 수식은 '수식'", () => {
  assert.equal(speakable("**x** $a^2$ 입니다"), "x 수식 입니다");
});

test("speakable: 근거 줄·코드·링크·제목·목록·표·디스플레이 수식", () => {
  const md = [
    "## 핵심",
    "- 첫째: *희소* 전문가 [논문](https://arxiv.org/abs/1)",
    "1. `top-2` 라우팅",
    "$$\\sum_i x_i$$",
    "| a | b |", "|---|---|", "| 1 | 2 |",
    "```py\nprint(1)\n```",
    "가격은 $5 and $10 입니다.",
    "> 인용 \\(x\\) 끝",
    '근거: "we propose a sparse mixture"',
  ].join("\n");
  assert.equal(speakable(md), [
    "핵심", "첫째: 희소 전문가 논문", "top-2 라우팅", "수식", "a b", "1 2", "코드 생략", "가격은 $5 and $10 입니다.", "인용 수식 끝",
  ].join("\n"));
  assert.equal(speakable('근거: "only evidence"'), "");
});
