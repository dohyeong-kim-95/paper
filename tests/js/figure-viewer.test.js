// figure-viewer 순수 함수: 배율 제한, 초점 고정 확대, 이동 제한, 핀치, 넘기기, 두 번 탭, 고정 창 위치, 번호표
"use strict";
const { test, assert, load } = require("./_runner");
const fv = load("static/features/figure-viewer.js");

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);
// 화면 점 → 내용 좌표 (맞춤 크기 기준)
const contentPoint = (st, fx, fy) => ({ x: (fx - st.x) / st.scale, y: (fy - st.y) / st.scale });

test("clampScale: 1~6 사이 (clampScale(9) === 6)", () => {
  assert.equal(fv.clampScale(9), 6);
  assert.equal(fv.clampScale(0.3), 1);
  assert.equal(fv.clampScale(2.5), 2.5);
  assert.equal(fv.clampScale(NaN), 1);
  assert.equal(fv.MAX, 6);
});

test("zoomAround: 초점 아래 내용이 제자리 (확대·축소·여러 번)", () => {
  let st = { scale: 1, x: 10, y: 40 };
  for (const [s, fx, fy] of [[2.5, 120, 300], [4, 50, 80], [1.3, 300, 10], [6, 200, 200]]) {
    const before = contentPoint(st, fx, fy);
    st = fv.zoomAround(st, s, fx, fy);
    const after = contentPoint(st, fx, fy);
    close(after.x, before.x);
    close(after.y, before.y);
    assert.equal(st.scale, s);
  }
});

test("zoomAround: 최대 배율을 넘기면 6에서 멈추고 초점은 그대로", () => {
  const st0 = { scale: 5, x: -100, y: -50 };
  const st = fv.zoomAround(st0, 12, 200, 150);
  assert.equal(st.scale, 6);
  const a = contentPoint(st0, 200, 150), b = contentPoint(st, 200, 150);
  close(a.x, b.x);
  close(a.y, b.y);
});

test("clampPan: 작은 축은 가운데, 큰 축은 빈틈 없이", () => {
  const view = { w: 400, h: 600 }, size = { w: 400, h: 200 };
  // 맞춤: 가로는 꽉, 세로는 가운데
  assert.deepEqual(fv.clampPan({ scale: 1, x: 37, y: 0 }, view, size), { scale: 1, x: 0, y: 200 });
  // 2배: 가로 800 → x는 [-400, 0], 세로 400 (< 600) → 가운데 100
  assert.deepEqual(fv.clampPan({ scale: 2, x: 50, y: -999 }, view, size), { scale: 2, x: 0, y: 100 });
  assert.deepEqual(fv.clampPan({ scale: 2, x: -999, y: 0 }, view, size), { scale: 2, x: -400, y: 100 });
  // 4배: 세로 800 → y는 [-200, 0]
  assert.deepEqual(fv.clampPan({ scale: 4, x: -300, y: -150 }, view, size), { scale: 4, x: -300, y: -150 });
});

test("fitScale: 다 보이게 맞추고 작은 그림은 maxUp까지만", () => {
  close(fv.fitScale({ w: 1200, h: 600 }, { w: 416, h: 616 }), 400 / 1200);
  close(fv.fitScale({ w: 100, h: 100 }, { w: 416, h: 616 }), 4);
  close(fv.fitScale({ w: 100, h: 100 }, { w: 416, h: 616 }, 2), 2);
  close(fv.fitScale({ w: 300, h: 900 }, { w: 416, h: 616 }), 600 / 900);
});

test("pinch: 손가락이 그대로면 상태 그대로, 거리 2배면 가운데 기준 2배", () => {
  const st0 = { scale: 1, x: 0, y: 100 }, a = { x: 100, y: 300 }, b = { x: 200, y: 300 };
  const same = fv.pinch(st0, a, b, a, b);
  close(same.scale, 1);
  close(same.x, 0);
  close(same.y, 100);
  const z = fv.pinch(st0, a, b, { x: 50, y: 300 }, { x: 250, y: 300 });
  close(z.scale, 2);
  const m = contentPoint(st0, 150, 300), m2 = contentPoint(z, 150, 300);
  close(m.x, m2.x);
  close(m.y, m2.y);
  // 두 손가락을 함께 옮기면 내용도 따라감
  const p = fv.pinch(st0, a, b, { x: 130, y: 280 }, { x: 230, y: 280 });
  close(p.scale, 1);
  close(p.x, 30);
  close(p.y, 80);
  // 최대 배율 제한
  assert.equal(fv.pinch(st0, a, b, { x: -1000, y: 300 }, { x: 1300, y: 300 }).scale, 6);
});

test("swipeDir: 맞춤 크기에서만, 가로로 충분히 밀 때만", () => {
  assert.equal(fv.swipeDir(-100, 10, 1), 1);   // 왼쪽으로 → 다음
  assert.equal(fv.swipeDir(100, -5, 1), -1);   // 오른쪽으로 → 이전
  assert.equal(fv.swipeDir(-100, 10, 2), 0);   // 확대 중엔 이동
  assert.equal(fv.swipeDir(-40, 0, 1), 0);     // 너무 짧음
  assert.equal(fv.swipeDir(-100, 90, 1), 0);   // 대각선
});

test("isDoubleTap: 300ms·30px 안", () => {
  assert.equal(fv.isDoubleTap(null, { t: 100, x: 0, y: 0 }), false);
  assert.equal(fv.isDoubleTap({ t: 0, x: 10, y: 10 }, { t: 250, x: 20, y: 25 }), true);
  assert.equal(fv.isDoubleTap({ t: 0, x: 10, y: 10 }, { t: 350, x: 10, y: 10 }), false);
  assert.equal(fv.isDoubleTap({ t: 0, x: 10, y: 10 }, { t: 100, x: 80, y: 10 }), false);
});

test("stepIndex: 끝에서 멈춤 (돌아가지 않음)", () => {
  assert.equal(fv.stepIndex(0, -1, 5), 0);
  assert.equal(fv.stepIndex(4, 1, 5), 4);
  assert.equal(fv.stepIndex(2, 1, 5), 3);
});

test("clampPin: 화면 안, 헤더 아래", () => {
  const view = { w: 400, h: 800, top: 60 }, size = { w: 160, h: 120 };
  assert.deepEqual(fv.clampPin({ x: 500, y: 0 }, size, view), { x: 232, y: 68 });
  assert.deepEqual(fv.clampPin({ x: -50, y: 900 }, size, view), { x: 8, y: 672 });
  assert.deepEqual(fv.clampPin({ x: 100, y: 300 }, size, view), { x: 100, y: 300 });
  // 창보다 큰 고정 창은 왼쪽 위 기준
  assert.deepEqual(fv.clampPin({ x: 100, y: 300 }, { w: 500, h: 900 }, view), { x: 8, y: 68 });
});

test("figLabel: 캡션 번호표 정리", () => {
  assert.equal(fv.figLabel("Figure 1: "), "Figure 1");
  assert.equal(fv.figLabel("Table 2:"), "Table 2");
  assert.equal(fv.figLabel("(a) "), "(a)");
  assert.equal(fv.figLabel("Algorithm\n1 "), "Algorithm 1");
  assert.equal(fv.figLabel(undefined), "");
});

test("isFullTag: 제 번호가 있는 번호표와 하위 패널 표시 구분", () => {
  for (const t of ["Figure 7", "Table 7", "Table A.1", "Fig. 3", "그림 3", "Algorithm 1"]) assert.equal(fv.isFullTag(t), true, t);
  for (const t of ["(a)", "a", "(iii)", "(1)", "", undefined]) assert.equal(fv.isFullTag(t), false, String(t));
});

test("joinLabel: 바깥 번호 + 패널, 패널이 제 번호면 그것만, 바깥 번호가 없으면 종류 이름", () => {
  assert.equal(fv.joinLabel("Figure 2", "(a)", "그림"), "Figure 2 (a)");
  assert.equal(fv.joinLabel("Table 8", "(b)", "표"), "Table 8 (b)");
  assert.equal(fv.joinLabel("", "Table 7", "표"), "Table 7");      // captionof로 나란히 둔 표 (바깥 캡션 없음)
  assert.equal(fv.joinLabel("Figure 7", "Table 7", "표"), "Table 7");
  assert.equal(fv.joinLabel("", "(a)", "그림"), "그림 (a)");
  assert.equal(fv.joinLabel("Figure 1", "", "그림"), "Figure 1");
  assert.equal(fv.joinLabel("", "", "알고리즘"), "알고리즘");
});

test("pinTop: 헤더가 다시 나타나는 중(아직 위에 있음)에도 도착 위치(헤더 + 띠) 아래로", () => {
  // 보임: 헤더 53 + 띠 0 → 지금 화면에서 헤더가 아직 숨은 자리(0)여도 53
  assert.equal(fv.pinTop(0, 53, 0, false), 53);
  // 찾기 줄 44px가 생김 → 97
  assert.equal(fv.pinTop(53, 53, 44, false), 97);
  // 숨김: 띠만 (지금 보이는 끝이 더 아래면 그쪽: 숨는 중이거나 맨 위라 띠가 제자리에 있을 때)
  assert.equal(fv.pinTop(20, 53, 20, true), 20);
  assert.equal(fv.pinTop(73, 53, 20, true), 73);
  assert.equal(fv.pinTop(undefined, undefined, undefined, false), 0);
});
