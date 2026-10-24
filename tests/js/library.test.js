"use strict";
const { test, assert, load } = require("./_runner");
const L = load("static/features/library.js");

test("toBibtex: 첫 저자 성 + 연도 키, 버전 뗀 eprint", () => {
  const b = L.toBibtex({ title: "Mixtral of Experts", authors: ["A. Kim", "B. Lee"], id: "2401.04088v2", year: 2024 });
  assert.match(b, /^@misc\{kim2024,\n/);
  assert.match(b, /\n {2}eprint = \{2401\.04088\},/);
  assert.match(b, /author = \{A\. Kim and B\. Lee\}/);
  assert.match(b, /title = \{\{Mixtral of Experts\}\}/);
  assert.match(b, /archivePrefix = \{arXiv\}/);
  assert.match(b, /url = \{https:\/\/arxiv\.org\/abs\/2401\.04088\}/);
  assert.match(b, /\n\}$/);
});

test("toBibtex: 연도는 id에서, 특수문자 이스케이프(수식 안은 그대로), 저자 없으면 arxiv 키", () => {
  const b = L.toBibtex({ title: "Q&A at 100% with $x_{1}$ {and} y_z", authors: ["José Müller Jr."], id: "2312.00001" });
  assert.match(b, /^@misc\{muller2023,/);
  assert.match(b, /year = \{2023\}/);
  assert.match(b, /title = \{\{Q\\&A at 100\\% with \$x_\{1\}\$ and y\\_z\}\}/);
  assert.match(L.toBibtex({ id: "2401.00001" }), /^@misc\{arxiv2024,/);
  assert.equal(L.bibKey({ authors: ["Kim, Alice"], id: "2401.00001" }), "kim2024");
});

test("yearOf: 새 형식·옛 형식·잘못된 id", () => {
  assert.equal(L.yearOf("2401.04088v2"), 2024);
  assert.equal(L.yearOf("0704.0001"), 2007);
  assert.equal(L.yearOf("hep-th/9901001"), 1999);
  assert.equal(L.yearOf("math/0211159"), 2002);
  assert.equal(L.yearOf("2413.00001"), null);
  assert.equal(L.yearOf("nope"), null);
});

test("mergeImport: 같은 id면 더 최근 opened가 남고 다른 id는 합쳐짐", () => {
  const existing = {
    "2401.00001": { id: "2401.00001", title: "Old title", opened: 100, star: true, readMs: 5000 },
    "2402.00002": { id: "2402.00002", title: "Local only", opened: 50 },
  };
  const imported = {
    "2401.00001": { id: "2401.00001", title: "New title", opened: 200, readMs: 1000, gist: "요약" },
    "2403.00003": { id: "2403.00003", title: "Imported only", opened: 10 },
    junk: "not a record",
  };
  const m = L.mergeImport(existing, imported);
  assert.deepEqual(Object.keys(m).sort(), ["2401.00001", "2402.00002", "2403.00003"]);
  assert.equal(m["2401.00001"].opened, 200);
  assert.equal(m["2401.00001"].title, "New title");
  assert.equal(m["2401.00001"].readMs, 5000, "읽은 시간은 큰 값");
  assert.equal(m["2401.00001"].star, true, "새 쪽에 없는 필드는 옛 값 유지");
  assert.equal(m["2401.00001"].gist, "요약");
  // 반대로 로컬이 더 최근이면 로컬 값
  const m2 = L.mergeImport(imported, existing);
  assert.equal(m2["2401.00001"].opened, 200);
  assert.equal(m2["2401.00001"].title, "New title");
  // 버전 붙은 id는 기본 id로
  const m3 = L.mergeImport({}, { x: { id: "2404.00004v3", opened: 1 } });
  assert.deepEqual(Object.keys(m3), ["2404.00004"]);
});

test("mergeImport: 모양이 틀린 필드는 버림, 모르는 필드는 유지", () => {
  const m = L.mergeImport({}, {
    a: { id: "2405.00005", title: 7, authors: "A. Kim", tags: ["x", 3, "X"], cites: "2301.00001", status: "later", star: "yes", opened: "12", readMs: -5, extra: 1 },
  });
  assert.deepEqual(m, { "2405.00005": { id: "2405.00005", tags: ["x"], opened: 12, extra: 1 } });
  assert.deepEqual(L.filterRecords(m, { q: "x", tag: "x" }).length, 1, "정리된 기록은 거르기에서 안 깨짐");
});

test("mergeRecord: 나중에 바뀐(updated) 쪽의 상태·태그가 이김", () => {
  const a = { id: "1", opened: 100, status: "done", tags: ["x"], updated: 100 };
  const b = { id: "1", opened: 50, status: "reading", tags: [], updated: 300 };
  const m = L.mergeRecord(a, b);
  assert.equal(m.status, "reading");
  assert.deepEqual(m.tags, []);
  assert.equal(m.opened, 100);
});

test("applyAdd: 준 필드만, 상태는 뒤로 안 감, star는 boolean일 때만, 태그 합집합, opened 유지", () => {
  let r = L.applyAdd(null, { id: "2401.04088v2", title: "T", authors: ["A. Kim"], status: "to-read" }, 10);
  assert.deepEqual(r, { id: "2401.04088", title: "T", authors: ["A. Kim"], status: "to-read", statusAt: 10, updated: 10 });
  r = { ...r, opened: 5, star: true };
  r = L.applyAdd(r, { id: "2401.04088", status: "reading", star: "yes", tags: ["MoE"] }, 20);
  assert.equal(r.status, "reading");
  assert.equal(r.star, true, "boolean이 아니면 그대로");
  assert.equal(r.opened, 5);
  r = L.applyAdd(r, { id: "2401.04088", status: "to-read", star: false, tags: ["moe", "#routing"] }, 30);
  assert.equal(r.status, "reading", "뒤로 안 감");
  assert.equal(r.star, false);
  assert.deepEqual(r.tags, ["MoE", "routing"]);
  const same = L.applyAdd(r, { id: "2401.04088", status: "to-read" }, 99);
  assert.equal(same.updated, 30, "바뀐 것이 없으면 updated도 그대로");
  const g = L.applyAdd(r, { id: "2401.04088", gist: "- **희소** 전문가 혼합으로 비용을 줄임\n- 둘째" }, 40);
  assert.equal(g.gist, "희소 전문가 혼합으로 비용을 줄임");
});

test("setFields: 사용자는 상태를 되돌리거나 지울 수 있음, 태그 교체", () => {
  const r = L.setFields({ id: "1", status: "done", tags: ["a", "b"] }, { status: "to-read", tags: ["b"] }, 7);
  assert.deepEqual(r, { id: "1", status: "to-read", statusAt: 7, tags: ["b"], updated: 7 });
  assert.equal(L.setFields(r, { status: null }).status, undefined);
  assert.equal(L.setFields(r, { status: "bogus" }).status, undefined);
});

test("touchOpen / addReadTime: 열면 opened, 1분 넘게 읽으면 읽는 중", () => {
  const r = L.touchOpen({ id: "1", status: "to-read", readMs: 50000 }, { id: "1v2", title: " A  title ", authors: ["Alice Kim1", "Bob Lee*"] }, 123);
  assert.deepEqual(r, { id: "1", status: "to-read", readMs: 50000, opened: 123, title: "A title", authors: ["Alice Kim", "Bob Lee"] });
  const t = L.addReadTime(r, 15000, 200);
  assert.equal(t.readMs, 65000);
  assert.equal(t.status, "reading");
  assert.equal(L.addReadTime({ status: "done" }, 999999).status, "done");
});

test("addReadTime: 1분을 넘기는 순간에만 '읽는 중', 사용자가 고른 '읽을 예정'·해제는 덮어쓰지 않음", () => {
  // 이미 1분 넘게 읽은 논문에서 사용자가 '읽을 예정'을 고르거나 상태를 지움 → 다음 기록(30초마다·화면 떠날 때)에도 그대로
  const picked = L.setFields({ id: "1", readMs: 600000, status: "reading" }, { status: "to-read" }, 50);
  assert.equal(L.addReadTime(picked, 2000, 60).status, "to-read");
  const cleared = L.setFields(picked, { status: null }, 70);
  assert.equal(L.addReadTime(cleared, 2000, 80).status, undefined);
  assert.equal(L.addReadTime(cleared, 2000, 80).readMs, 602000);
  // 이번에 연 뒤 1분을 넘기면 (기록 전체는 이미 넘었어도) 한 번 '읽는 중'
  const again = L.addReadTime(cleared, 15000, 90, { session: 50000 });
  assert.equal(again.status, "reading");
  assert.equal(again.statusAt, 90);
  assert.equal(L.addReadTime(cleared, 15000, 90, { session: 65000 }).status, undefined, "이번에도 이미 넘었으면 그대로");
  // 이 화면에서 사용자가 상태를 골랐으면 넘는 순간에도 그대로
  assert.equal(L.addReadTime({ id: "1", readMs: 50000, status: "to-read" }, 15000, 90, { promote: false }).status, "to-read");
  assert.equal(L.addReadTime({ id: "1", readMs: 50000 }, 15000, 90, { session: 0 }).status, "reading");
});

test("mergeRecord: 지운 상태도 가져오기에서 그대로, 상태는 나중에 정한 쪽", () => {
  const cleared = L.setFields({ id: "1", status: "done", opened: 10 }, { status: null }, 50);
  const old = { id: "1", status: "done", opened: 10, updated: 10 };
  assert.equal(L.mergeRecord(old, cleared).status, undefined);
  assert.equal(L.mergeRecord(cleared, old).status, undefined);
  assert.equal(L.mergeImport({ "1": old }, { "1": cleared })["1"].status, undefined, "가져오기 정리를 거쳐도");
  // 다른 기기에서 상태를 정한 적 없이 즐겨찾기만 바꾼 최근 기록은 상태를 지우지 않음
  const done = L.setFields({ id: "1", opened: 10 }, { status: "done" }, 20);
  const starred = L.setFields({ id: "1", opened: 30 }, { star: true }, 40);
  const m = L.mergeRecord(done, starred);
  assert.equal(m.status, "done");
  assert.equal(m.star, true);
  // 상태는 나중에 정한 쪽: 최근에 연 기록이라도 상태는 예전에 정했으면 다른 쪽 상태
  const later = L.setFields({ id: "1", opened: 5 }, { status: "reading" }, 100);
  const openedLater = L.touchOpen(L.setFields({ id: "1" }, { status: "to-read" }, 60), { id: "1" }, 200);
  assert.equal(L.mergeRecord(later, openedLater).status, "reading");
  assert.equal(L.mergeRecord(later, openedLater).opened, 200);
});

test("toBibtexAll: 겹치는 키에 a, b … 붙임", () => {
  const recs = [
    { id: "2401.00001", authors: ["Alice Kim"], title: "A" },
    { id: "2402.00002", authors: ["Bob Kim"], title: "B" },
    { id: "2403.00003", authors: ["Carol Kim"], title: "C" },
    { id: "2301.00004", authors: ["Dan Kim"], title: "D" },
    { id: "2404.00005", authors: ["Eve Lee"], title: "E" },
  ];
  const keys = [...L.toBibtexAll(recs).matchAll(/@misc\{([^,]+),/g)].map(m => m[1]);
  assert.deepEqual(keys, ["kim2024", "kim2024a", "kim2024b", "kim2023", "lee2024"]);
  const many = Array.from({ length: 30 }, (_, i) => ({ id: `2401.${String(i).padStart(5, "0")}`, authors: ["A Kim"] }));
  const k2 = [...L.toBibtexAll(many).matchAll(/@misc\{([^,]+),/g)].map(m => m[1]);
  assert.equal(new Set(k2).size, 30);
  assert.equal(k2[26], "kim2024z");
  assert.equal(k2[27], "kim2024aa");
  assert.equal(L.toBibtexAll([]), "");
});

test("cleanAuthors: 한 칸의 여러 저자, 각주 기호, 이메일 제거", () => {
  assert.deepEqual(L.cleanAuthors(["Alice Kim, Bob Lee and Carol Park", "Dan Choi†", "x@y.com", "Alexander Anderson", "Alice Kim"]),
    ["Alice Kim", "Bob Lee", "Carol Park", "Dan Choi", "Alexander Anderson"]);
  assert.deepEqual(L.cleanAuthors(["Hugo Touvron, \u2003Louis Martin, \u2003Kevin Stone, "]), ["Hugo Touvron", "Louis Martin", "Kevin Stone"],
    "\\quad(넓은 공백)·건너뛴 각주 표시 자리로 나뉨");
  assert.deepEqual(L.cleanAuthors(["Ana de la Cruz\u00a0Smith"]), ["Ana de la Cruz Smith"], "줄바꿈 없는 공백은 이름 안");
  assert.equal(L.authorsLine(["A", "B", "C", "D", "E"]), "A, B, C 외 2명");
  assert.equal(L.authorsLine([]), "");
});

test("pickNameLines: 저자 칸의 둘째 줄부터는 이름 줄만, 소속·이메일 줄에서 멈춤", () => {
  // LLaMA식: 이름 여러 줄 → 빈 줄 → 소속
  assert.deepEqual(L.pickNameLines([
    "Hugo Touvron, , Thibaut Lavril, Gautier Izacard, Xavier Martinet ",
    "Marie-Anne Lachaux, Timothee Lacroix, Baptiste Rozière, Naman Goyal",
    "Edouard Grave, , Guillaume Lample, ",
    "",
    "Meta AI",
  ]), [
    "Hugo Touvron, , Thibaut Lavril, Gautier Izacard, Xavier Martinet ",
    "Marie-Anne Lachaux, Timothee Lacroix, Baptiste Rozière, Naman Goyal",
    "Edouard Grave, , Guillaume Lample, ",
  ]);
  // 흔한 모양: 이름 → 소속 → 이메일
  assert.deepEqual(L.pickNameLines(["Alice Kim, , Bob Lee, ", ", Seoul National University", "alice@snu.ac.kr"]), ["Alice Kim, , Bob Lee, "]);
  assert.deepEqual(L.pickNameLines(["Alice Kim", "Google DeepMind"]), ["Alice Kim"]);
  assert.deepEqual(L.pickNameLines(["Alice Kim", "Bob Lee"]), ["Alice Kim"], "둘째 줄 이름 하나는 소속과 구별 못 해 뺌");
  assert.deepEqual(L.pickNameLines(["Alice Kim, Bob Lee", "Hugging Face, Mistral AI"]), ["Alice Kim, Bob Lee"]);
  assert.deepEqual(L.pickNameLines(["Alice Kim", "Carol van der Berg, Dan O'Neil"]), ["Alice Kim", "Carol van der Berg, Dan O'Neil"]);
  assert.deepEqual(L.pickNameLines(["", " , ", "Alice Kim"]), ["Alice Kim"], "앞의 빈 줄은 건너뜀");
  assert.deepEqual(L.cleanAuthors(L.pickNameLines(["Alice Kim, , Bob Lee", "Carol Park, Dan Choi", "MIT CSAIL"])), ["Alice Kim", "Bob Lee", "Carol Park", "Dan Choi"]);
});

test("arxivIdOf: 본문 글자·CoRR·링크, 오탐 없음", () => {
  assert.equal(L.arxivIdOf("A. Author. Sparse. arXiv preprint arXiv:2301.00001, 2023."), "2301.00001");
  assert.equal(L.arxivIdOf("CoRR, abs/2205.01068v2, 2022"), "2205.01068");
  assert.equal(L.arxivIdOf("doi:10.48550/arXiv.2310.12345"), "2310.12345");
  assert.equal(L.arxivIdOf("F. Hacker. Efficient. https://arxiv.org/abs/2302.00002, 2023."), "2302.00002");
  assert.equal(L.arxivIdOf("Some paper. [link]", ["https://arxiv.org/pdf/2402.11111v1"]), "2402.11111");
  assert.equal(L.arxivIdOf("In ACL, pages 1234.5678, 2022. doi 10.1000/1234.56789"), null);
  assert.equal(L.arxivIdOf("Journal 2021. https://doi.org/10.1000/jml.2021.123", ["https://doi.org/10.1000/jml.2021.123"]), null);
});

test("citeCounts / tintClass: 내 서재의 다른 논문이 인용한 횟수", () => {
  const lib = {
    a: { id: "a", cites: ["x", "y", "x"] },
    b: { id: "b", cites: ["x"] },
    c: { id: "c", cites: ["x", "z"] },
    self: { id: "self", cites: ["x", "y"] },
  };
  assert.deepEqual(L.citeCounts(lib, "self"), { x: 3, y: 1, z: 1 });
  assert.deepEqual([0, 1, 2, 3, 7].map(L.tintClass), ["", "lib-cf1", "lib-cf2", "lib-cf3", "lib-cf3"]);
});

test("filterRecords / recentRecords / allTags", () => {
  const lib = {
    "1": { id: "1", title: "Sparse Mixtures", authors: ["Alice Kim"], opened: 30, status: "reading", tags: ["MoE"], star: true },
    "2": { id: "2", title: "Attention", opened: 50, status: "done", tags: ["moe", "nlp"] },
    "3": { id: "3", title: "Routing", updated: 40, status: "to-read" },
    "4": { id: "4", title: "Vision", opened: 10 },
  };
  assert.deepEqual(L.filterRecords(lib).map(r => r.id), ["2", "3", "1", "4"]);
  assert.deepEqual(L.filterRecords(lib, { star: true }).map(r => r.id), ["1"]);
  assert.deepEqual(L.filterRecords(lib, { status: "done" }).map(r => r.id), ["2"]);
  assert.deepEqual(L.filterRecords(lib, { tag: "MOE" }).map(r => r.id), ["2", "1"]);
  assert.deepEqual(L.filterRecords(lib, { q: "kim sparse" }).map(r => r.id), ["1"]);
  assert.deepEqual(L.recentRecords(lib, 5).map(r => r.id), ["1", "4"], "완료·안 연 것 제외, 최근 연 순");
  assert.deepEqual(L.allTags(Object.values(lib)), [["MoE", 2], ["nlp", 1]]);
});

test("collectNotes / searchNotes / notesToMarkdown: 논문별 노트·질문 기록을 한 목록으로", () => {
  const lib = { "2401.00001": { id: "2401.00001", title: "Sparse", tags: ["moe"] } };
  const entries = [
    ["pr:highlights-notes:2401.00001", [
      { id: "h1", type: "hl", color: "yellow", anchor: { quote: "routes each token" }, ts: 10 },
      { id: "n1", type: "note", anchor: { quote: "dense baseline" }, note: "**중요** 비교 대상", ts: 30 },
      { id: "q1", type: "qa", anchor: { quote: "KD loss" }, qa: [{ q: "KD가 뭐야?", a: "지식 증류" }], ts: 20 },
    ]],
    ["pr:highlights-notes:threads:2402.00002", [
      { id: "t1", quote: "top-two", history: [{ role: "user", content: "<style>…</style> 쉽게" }, { role: "assistant", content: "두 개 고름" }], shown: ["쉽게 설명"], ts: 40 },
      { id: "t2", quote: "empty", history: [], ts: 50 },
    ]],
    ["pr:highlights-notes:prefs", { color: "yellow" }],
    ["pr:highlights-notes:prefs:x", []],
  ];
  const items = L.collectNotes(entries, lib);
  assert.deepEqual(items.map(n => n.id), ["2402.00002:t1", "2401.00001:n1", "2401.00001:q1", "2401.00001:h1"]);
  assert.deepEqual(items[0].qa, [{ q: "쉽게 설명", a: "두 개 고름" }]);
  assert.equal(items[0].type, "thread");
  assert.equal(items[0].title, "2402.00002", "서재에 없으면 id");
  assert.equal(items[1].title, "Sparse");
  assert.deepEqual(items.map(L.noteKind), ["qa", "note", "qa", "hl"]);
  assert.deepEqual(L.searchNotes(items, { kind: "hl" }).map(n => n.id), ["2401.00001:h1"]);
  assert.deepEqual(L.searchNotes(items, { q: "증류" }).map(n => n.id), ["2401.00001:q1"]);
  assert.deepEqual(L.searchNotes(items, { tag: "MoE" }).length, 3);
  const md = L.notesToMarkdown(items.filter(n => n.paperId === "2401.00001"));
  assert.match(md, /^# 모든 노트\n\n## Sparse \(arXiv:2401\.00001\)\n\nhttps:\/\/arxiv\.org\/abs\/2401\.00001\n/);
  assert.match(md, /> dense baseline\n\n\*\*중요\*\* 비교 대상/);
  assert.match(md, /\*\*Q\.\*\* KD가 뭐야\?\n\n지식 증류/);
});

test("parseImport / makeBackup: 감싼 형태·키 맵 둘 다, 잘못된 파일은 한국어 오류", () => {
  const data = { "pr:library": { a: { id: "a" } }, "pr:vocab": [], "pr:app:thread:1": {}, other: 1 };
  const b = L.makeBackup(data, Date.UTC(2026, 0, 2));
  assert.equal(b.app, "paper-reader");
  assert.equal(b.exported, "2026-01-02T00:00:00.000Z");
  assert.deepEqual(Object.keys(L.parseImport(JSON.stringify(b))), ["pr:library", "pr:vocab"]);
  assert.deepEqual(Object.keys(L.parseImport(JSON.stringify(data))), ["pr:library", "pr:vocab"]);
  assert.throws(() => L.parseImport("{nope"), /JSON 파일이 아닙니다/);
  assert.throws(() => L.parseImport("[1,2]"), /형식/);
  assert.throws(() => L.parseImport('{"x": 1}'), /가져올 항목이 없습니다/);
});

test("formatDuration / relTime / 링크", () => {
  assert.equal(L.formatDuration(30000), "1분 미만");
  assert.equal(L.formatDuration(12 * 60000 + 5000), "12분");
  assert.equal(L.formatDuration(65 * 60000), "1시간 5분");
  assert.equal(L.formatDuration(120 * 60000), "2시간");
  const now = Date.UTC(2026, 9, 23, 12);
  assert.equal(L.relTime(now - 10000, now), "방금");
  assert.equal(L.relTime(now - 5 * 60000, now), "5분 전");
  assert.equal(L.relTime(now - 3 * 3600000, now), "3시간 전");
  assert.equal(L.relTime(now - 2 * 86400000, now), "2일 전");
  const old = new Date(2024, 0, 5, 12).getTime();
  assert.equal(L.relTime(old, now), "2024.1.5");
  assert.equal(L.relTime(0, now), "");
  assert.equal(L.paperHref("2401.00001"), "/paper/2401.00001");
  assert.equal(L.quoteHref("2401.00001", "a b&c"), "/paper/2401.00001#q=a%20b%26c");
  assert.equal(L.quoteHref("2401.00001", ""), "/paper/2401.00001");
  assert.equal(L.quoteHref("1", "x".repeat(200)).length, "/paper/1#q=".length + 120);
});
