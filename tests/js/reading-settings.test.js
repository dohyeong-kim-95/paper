// reading-settings 순수 함수: 설정 정리(clampSettings), 색 대비 보정(readableColor), 헤더 자동 숨김 판단(nextBar)
"use strict";
const { test, assert, load, ROOT } = require("./_runner");
const fs = require("node:fs");
const path = require("node:path");
const { DEFAULTS, RANGE, clampSettings, parseColor, contrast, readableColor, nextBar } = load("static/features/reading-settings.js");

test("clampSettings({size:40}): 22로 자르고 나머지는 기본값", () => {
  const s = clampSettings({ size: 40 });
  assert.equal(s.size, 22);
  assert.deepEqual({ ...s, size: DEFAULTS.size }, { ...DEFAULTS });
});

test("clampSettings: 빈 값·이상한 값은 기본값, 범위·눈금 맞춤, 모르는 키는 버림", () => {
  assert.deepEqual(clampSettings(null), { ...DEFAULTS });
  assert.deepEqual(clampSettings("x"), { ...DEFAULTS });
  const s = clampSettings({ size: "13", lh: 1.73, margin: -5, theme: "neon", font: "comic", justify: 1, wake: "yes", focus: "true", junk: 1 });
  assert.equal(s.size, 14);
  assert.equal(s.lh, 1.75);
  assert.equal(s.margin, 4);
  assert.equal(s.theme, "system");
  assert.equal(s.font, "sans");
  assert.deepEqual([s.justify, s.wake, s.focus, s.autohide], [true, false, true, false]);
  assert.equal("junk" in s, false);
  assert.deepEqual(clampSettings({ size: "abc", lh: NaN, margin: Infinity }), { ...DEFAULTS });
  assert.deepEqual(clampSettings({ margin: 999 }).margin, RANGE.margin[1]);
  assert.deepEqual(clampSettings({ theme: "sepia", font: "serif", lh: "2.4", size: 18.4 }), { ...DEFAULTS, theme: "sepia", font: "serif", lh: 2, size: 18 });
});

test("기본값은 style.css 기본값과 같고, base.html이 첫 페인트 전에 읽는 키를 모두 가짐", () => {
  const css = fs.readFileSync(path.join(ROOT, "static/style.css"), "utf8");
  assert.ok(css.includes(`var(--fs, ${DEFAULTS.size}px)`));
  assert.ok(css.includes(`var(--lh, ${DEFAULTS.lh})`));
  assert.ok(css.includes(`var(--margin, ${DEFAULTS.margin}px)`));
  const base = fs.readFileSync(path.join(ROOT, "templates/base.html"), "utf8");
  assert.ok(base.includes('localStorage.getItem("pr:reading-settings")'));
  for (const k of [...base.matchAll(/rs\.(\w+)/g)].map(m => m[1])) assert.ok(k in DEFAULTS, k);
  for (const k of ["size", "lh", "theme", "font", "justify", "margin", "wake", "autohide", "ruby"]) assert.ok(k in DEFAULTS, k);
});

test("parseColor: hex·rgb()·이름, 투명·이상한 값은 null", () => {
  assert.deepEqual(parseColor("#f00"), [255, 0, 0]);
  assert.deepEqual(parseColor(" #0000FF "), [0, 0, 255]);
  assert.deepEqual(parseColor("#00800080"), [0, 128, 0]);
  assert.deepEqual(parseColor("rgb(0, 128, 255)"), [0, 128, 255]);
  assert.deepEqual(parseColor("rgba(10, 20, 30, 0.5)"), [10, 20, 30]);
  assert.deepEqual(parseColor("rgb(10 20 30 / 1)"), [10, 20, 30]);
  assert.deepEqual(parseColor("Navy"), [0, 0, 128]);
  assert.equal(parseColor("rgba(0, 0, 0, 0)"), null);
  assert.equal(parseColor("var(--x)"), null);
  assert.equal(parseColor(""), null);
  assert.equal(parseColor("#12345"), null);
});

test("contrast: 검정/흰색 21, 같은 색 1", () => {
  assert.equal(Math.round(contrast([0, 0, 0], [255, 255, 255])), 21);
  assert.equal(contrast([9, 9, 9], [9, 9, 9]), 1);
});

test("readableColor: 다크 바탕의 진한 남색은 밝게, 충분하면 null, 세피아의 노랑은 어둡게", () => {
  const dark = parseColor("#121212"), sepia = parseColor("#f4ecd8");
  const navy = readableColor([0, 0, 128], dark);
  assert.match(navy, /^#[0-9a-f]{6}$/);
  assert.ok(contrast(parseColor(navy), dark) >= 4.5);
  const p = parseColor(navy);
  assert.ok(p[2] > p[0] && p[2] > p[1], "색상(파랑)은 유지");
  assert.equal(readableColor([0, 0, 0], [255, 255, 255]), null);
  assert.equal(readableColor([230, 230, 230], dark), null);
  const yellow = readableColor([255, 255, 0], sepia);
  assert.ok(contrast(parseColor(yellow), sepia) >= 4.5);
  assert.equal(readableColor(null, dark), null);
  // 색 상자(밝은 노란 바탕) 안의 밝은 글자는 어둡게
  const onBox = readableColor(parseColor("#e6e6e6"), [255, 255, 0]);
  assert.ok(contrast(parseColor(onBox), [255, 255, 0]) >= 4.5);
});

test("nextBar: 같은 방향으로 slop 넘게 내리면 숨김, 올리면 보임, 맨 위 근처는 항상 보임", () => {
  let st = { y: 0, acc: 0, hidden: false };
  st = nextBar(st, 100); // 맨 위 근처 지나 100px 아래로
  assert.equal(st.hidden, true);
  st = nextBar(st, 90); // 조금 올림 (slop 안)
  assert.equal(st.hidden, true);
  st = nextBar(st, 60); // 맨 위 근처
  assert.equal(st.hidden, false);
  st = nextBar({ y: 500, acc: 0, hidden: false }, 510);
  assert.equal(st.hidden, false, "작은 움직임은 무시");
  st = nextBar(st, 530);
  assert.equal(st.hidden, true, "같은 방향 누적이 slop 넘음");
  st = nextBar(st, 520); // 위로 10
  st = nextBar(st, 535); // 아래로 15
  st = nextBar(st, 515); // 위로 20: 앞의 위로 10은 방향이 바뀌며 버려짐
  assert.equal(st.hidden, true, "방향이 바뀌면 누적을 새로");
  st = nextBar(st, 495);
  assert.equal(st.hidden, false);
  assert.deepEqual(nextBar(st, 495), { y: 495, acc: 0, hidden: false });
});
