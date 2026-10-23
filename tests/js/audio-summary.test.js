// audio-summary 순수 함수: 문장 나누기, 수식 읽기, 말하기 정리, 답변 Markdown 벗기기, 속도, 첫 보이는 단위
"use strict";
const { test, assert, load } = require("./_runner");
const A = load("static/features/audio-summary.js");

test("splitSentences('가. 나? 다!') → 3", () => {
  assert.deepEqual(A.splitSentences("가. 나? 다!"), ["가.", "나?", "다!"]);
});

test("영어 약어·소수점·인용 번호 괄호에서는 나누지 않음", () => {
  assert.deepEqual(A.splitSentences("The router computes gate scores as in Eq. (1). Figure 1 shows the architecture."),
    ["The router computes gate scores as in Eq. (1).", "Figure 1 shows the architecture."]);
  assert.equal(A.splitSentences("Smith et al. propose a router. It works.").length, 2);
  assert.equal(A.splitSentences("We use regularizers (e.g. dropout) here. Accuracy is 2.3 points higher.").length, 2);
  assert.equal(A.splitSentences("See Fig. 3 and Sec. 2 for details. Done.").length, 2);
  assert.equal(A.splitSentences("It stops, etc. and then continues.").length, 1, "소문자로 이어지면 같은 문장");
  assert.deepEqual(A.splitSentences('He said "stop." Then he left.'), ['He said "stop."', "Then he left."]);
});

test("줄바꿈도 문장 경계, 빈 줄·앞뒤 공백은 버림", () => {
  assert.deepEqual(A.splitSentences("  첫 줄\n\n둘째 줄입니다.  "), ["첫 줄", "둘째 줄입니다."]);
  assert.deepEqual(A.splitSentences(""), []);
  assert.deepEqual(A.splitSentences(null), []);
});

test("sentenceSpans: 구간이 원문 위치를 가리킴, 긴 문장은 max 이하로 쉼표·공백에서 나눔", () => {
  const text = "  Alpha beta.  Gamma delta? ";
  const spans = A.sentenceSpans(text);
  assert.deepEqual(spans.map(s => text.slice(s.start, s.end)), ["Alpha beta.", "Gamma delta?"]);
  const long = Array.from({ length: 30 }, (_, i) => `clause number ${i}`).join(", ") + ".";
  const parts = A.sentenceSpans(long, 120);
  assert.ok(parts.length > 3);
  for (const p of parts) assert.ok(p.end - p.start <= 120, `${p.end - p.start}`);
  assert.equal(parts.map(p => long.slice(p.start, p.end)).join(" ").replace(/\s+/g, " "), long);
  const noSpace = "가".repeat(500);
  assert.ok(A.sentenceSpans(noSpace, 200).every(p => p.end - p.start <= 200));
});

test("수식 문자(MATH) 안의 점은 문장 경계가 아님", () => {
  assert.equal(A.splitSentences(`grows as ${A.MATH} for width ${A.MATH}. We propose.`).length, 2);
});

test("mathSpeech: 간단한 식은 말로, 복잡하면 '수식'/'formula'", () => {
  assert.equal(A.mathSpeech("x^{2}", "en-US"), "x squared");
  assert.equal(A.mathSpeech("x^{2}", "ko-KR"), "x의 제곱");
  assert.equal(A.mathSpeech("\\alpha", "ko-KR"), "알파");
  assert.equal(A.mathSpeech("\\varepsilon", "en"), "epsilon");
  assert.equal(A.mathSpeech("3\\times 10^{-4}", "en"), "3 times 10 to the minus 4");
  assert.equal(A.mathSpeech("3\\times 10^{-4}", "ko"), "3 곱하기 10의 마이너스 4제곱");
  assert.equal(A.mathSpeech("f_{i}=1/N", "en"), "f i equals 1 over N");
  assert.equal(A.mathSpeech("\\displaystyle\\mathcal{L}", "en"), "L");
  assert.equal(A.mathSpeech("\\displaystyle=\\mathcal{L}_{\\text{task}}+\\alpha\\mathcal{L}_{\\text{bal}}", "en"),
    "equals L task plus alpha L bal");
  assert.equal(A.mathSpeech("5", "en"), "5");
  assert.equal(A.mathSpeech("\\sum_{i=1}^{N}f_{i}P_{i}", "ko"), "수식");
  assert.equal(A.mathSpeech("f_{i}=\\frac{1}{T}", "en"), "formula");
  assert.equal(A.mathSpeech("x^{\\top}Wy", "en"), "formula", "모르는 명령이 남으면 수식");
  assert.equal(A.mathSpeech("", "ko"), "수식");
});

test("speechText: 번역 자리표시자·URL·번호 인용 제거", () => {
  assert.equal(A.speechText("Code is at https://github.com/a/b. Done [1, 2]."), "Code is at link. Done.");
  assert.equal(A.speechText("결과 ⟦3⟧ 입니다 https://x.y/z", "ko-KR"), "결과 입니다 링크");
  assert.equal(A.speechText("two experts [1–3] ."), "two experts.");
});

test("stripMarkdown: 답변을 읽을 글로", () => {
  const md = "## 요약\n\n- **핵심**: 손실은 $x^{2}$ 입니다.\n1. [링크](https://a.b) 참고\n\n```py\nprint(1)\n```\n`코드` 끝";
  const out = A.stripMarkdown(md);
  assert.equal(out, "요약\n핵심: 손실은 x의 제곱 입니다.\n링크 참고\n코드 끝");
});

test("nextRate: 0.8 → 1.0 → 1.2 → 1.5 → 0.8, rateLabel", () => {
  assert.deepEqual([0.8, 1, 1.2, 1.5].map(A.nextRate), [1, 1.2, 1.5, 0.8]);
  assert.equal(A.nextRate(1.1), 1.2);
  assert.equal(A.rateLabel(1), "1.0×");
  assert.equal(A.rateLabel(1.5), "1.5×");
});

test("firstBelow: 헤더 아래로 걸친 첫 단위, 숨긴(높이 0) 단위는 건너뜀", () => {
  const rects = [{ height: 20, bottom: 10 }, { height: 0, bottom: 0 }, { height: 0, bottom: 300 }, { height: 30, bottom: 90 }, { height: 30, bottom: 200 }];
  assert.equal(A.firstBelow(rects, 60), 3);
  assert.equal(A.firstBelow(rects, 500), -1);
});
