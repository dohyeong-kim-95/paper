// 모든 JS 파일: 문법 검사(node --check) + DOM 없이 require 해도 throw 하지 않는지 (IIFE 템플릿 지킴 확인)
"use strict";
const { test, assert, ROOT } = require("./_runner");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const list = dir => {
  const d = path.join(ROOT, dir);
  return fs.existsSync(d) ? fs.readdirSync(d).filter(f => f.endsWith(".js")).sort().map(f => path.join(dir, f)) : [];
};
const all = [...list("static"), ...list("static/features")];
const pageScripts = all.filter(f => !f.endsWith("sw.js")); // 서비스워커 파일은 require 대상 아님

for (const f of all) {
  test(`node --check ${f}`, () => {
    execFileSync(process.execPath, ["--check", path.join(ROOT, f)], { stdio: "pipe" });
  });
}

for (const f of pageScripts) {
  test(`require without DOM: ${f}`, () => {
    assert.doesNotThrow(() => require(path.join(ROOT, f)));
  });
}

// 기능 파일 규칙: 전역은 window.Paper* 만 쓰고 최상위 선언 없음 (번들에서 함수로 감싸지만 node 테스트용으로도 IIFE)
for (const f of list("static/features").filter(x => !x.endsWith(".sw.js"))) {
  test(`IIFE template: ${f}`, () => {
    const src = fs.readFileSync(path.join(ROOT, f), "utf8").replace(/^\s*(\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*/, "");
    assert.match(src, /^\s*\(function\s*\(\)\s*\{/, "파일 전체를 (function () { ... })(); 로 감싸야 합니다");
  });
}
