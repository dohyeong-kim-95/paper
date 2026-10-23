// 아주 작은 테스트 러너 (의존성 없음, 그냥 node로 실행)
// 사용: const { test, assert, load } = require("./_runner");  test("이름", () => { assert.equal(1, 1); });
// 실행: node tests/js/<name>.test.js   (실패하면 종료 코드 1)
"use strict";
const assert = require("node:assert/strict");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..", "..");
const tests = [];
let scheduled = false;

function test(name, fn) {
  tests.push({ name, fn });
  if (!scheduled) { scheduled = true; setImmediate(run); }
}

async function run() {
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`  ok   ${t.name}`);
    } catch (e) {
      failed++;
      console.log(`  FAIL ${t.name}\n${e && e.stack ? e.stack : e}`);
    }
  }
  const file = path.basename(require.main ? require.main.filename : "?");
  console.log(`${file}: ${tests.length - failed}/${tests.length} passed`);
  if (failed) process.exitCode = 1;
}

// 저장소 루트 기준으로 static 파일 불러오기: load("static/anchor.js")
const load = rel => require(path.join(ROOT, rel));

module.exports = { test, assert, load, ROOT };
