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

// CSS: 기능 CSS는 /features.css 한 파일로 이어 붙음 → 한 파일의 열린 { · 주석 · 문자열이 뒤 기능의 스타일을 모두 삼킴
function cssProblem(src) {
  let depth = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "*") {
      const j = src.indexOf("*/", i + 2);
      if (j < 0) return "닫히지 않은 주석 /*";
      i = j + 1;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      for (; j < src.length && src[j] !== c; j++) {
        if (src[j] === "\\") j++;
        else if (src[j] === "\n") return "닫히지 않은 문자열";
      }
      if (j >= src.length) return "닫히지 않은 문자열";
      i = j;
    } else if (c === "{") depth++;
    else if (c === "}" && --depth < 0) return "짝 없는 }";
  }
  return depth ? `닫히지 않은 { ${depth}개` : null;
}

test("cssProblem이 깨진 CSS를 알아봄", () => {
  assert.equal(cssProblem('.a { content: "}"; } /* { */ @media (x) { .b { c: d } }'), null);
  assert.equal(cssProblem(".a { color: red;"), "닫히지 않은 { 1개");
  assert.equal(cssProblem(".a { } }"), "짝 없는 }");
  assert.equal(cssProblem(".a { } /* 주석"), "닫히지 않은 주석 /*");
  assert.equal(cssProblem(".a { content: 'x; }"), "닫히지 않은 문자열");
});

const cssFiles = d => {
  const dir = path.join(ROOT, d);
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith(".css")).sort().map(f => path.join(d, f)) : [];
};
for (const f of [...cssFiles("static"), ...cssFiles("static/features")]) {
  test(`CSS 괄호·주석 짝: ${f}`, () => {
    assert.equal(cssProblem(fs.readFileSync(path.join(ROOT, f), "utf8")), null);
  });
}
