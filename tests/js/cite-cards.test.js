// cite-cards 순수 함수: 인용 문장, GitHub 링크, BibTeX 바구니, 질문 문맥
"use strict";
const { test, assert, load } = require("./_runner");
const cc = load("static/features/cite-cards.js");

const P = "Large models scale well (see Fig. 2). We follow Smith et al. [1, 2] and use routers, e.g. top-2 gating. "
  + "Knowledge distillation compresses the router. A. Author showed this.";

test("citingSentence: 인용이 든 문장 (et al. · e.g. · Fig. 에서 끊지 않음)", () => {
  const at = P.indexOf("[1, 2]");
  assert.equal(cc.citingSentence(P, at), "We follow Smith et al. [1, 2] and use routers, e.g. top-2 gating.");
  assert.equal(cc.citingSentence(P, 0), "Large models scale well (see Fig. 2).");
  assert.equal(cc.citingSentence(P, P.length), "A. Author showed this."); // 이니셜 'A.'에서도 안 끊음
});

test("citingSentence: 긴 문장은 인용 주변 max자, 공백 정리", () => {
  const long = "word ".repeat(200) + "[7] " + "tail ".repeat(200) + ".";
  const s = cc.citingSentence(long, long.indexOf("[7]"), 100);
  assert.ok(s.includes("[7]"));
  assert.ok(s.startsWith("…") && s.endsWith("…"));
  assert.ok(s.length <= 103);
  assert.equal(cc.citingSentence("a\n  b [3]  c", 5), "a b [3] c");
  assert.equal(cc.citingSentence("", 10), "");
});

test("ghRepo: 저장소 링크만", () => {
  assert.deepEqual(cc.ghRepo("https://github.com/example/sparse-moe"), { owner: "example", repo: "sparse-moe", full: "example/sparse-moe" });
  assert.equal(cc.ghRepo("https://www.github.com/a/b.git/tree/main").full, "a/b");
  assert.equal(cc.ghRepo("http://github.com/a/b.").full, "a/b");
  assert.equal(cc.ghRepo("https://github.com/orgs/foo"), null);
  assert.equal(cc.ghRepo("https://github.com/foo"), null);
  assert.equal(cc.ghRepo("https://gitlab.com/a/b"), null);
  assert.equal(cc.ghRepo("https://evil.com/github.com/a/b"), null);
  assert.equal(cc.ghRepo("javascript:alert(1)//github.com/a/b"), null);
  assert.equal(cc.ghRepo("https://github.com/a/.."), null);
});

test("ago / fmtNum / metaLine / authorLine", () => {
  const now = Date.parse("2026-10-23T00:00:00Z");
  assert.equal(cc.ago("2026-10-22T12:00:00Z", now), "오늘");
  assert.equal(cc.ago("2026-10-20T00:00:00Z", now), "3일 전");
  assert.equal(cc.ago("2026-06-01T00:00:00Z", now), "4개월 전");
  assert.equal(cc.ago("2023-01-01T00:00:00Z", now), "3년 전");
  assert.equal(cc.ago("", now), "");
  assert.equal(cc.fmtNum(12345), "12,345");
  assert.equal(cc.metaLine({ venue: "ICML", year: 2023, citations: 1200 }), "ICML · 2023 · 인용 1,200회");
  assert.equal(cc.metaLine({ year: 2021, citations: 0 }), "2021 · 인용 0회");
  assert.equal(cc.authorLine({ authors: ["A", "B"], n_authors: 7 }), "A, B 외");
  assert.equal(cc.authorLine({ authors: [] }), "");
});

const ARXIV_CARD = {
  bib_id: "bib.bib1", label: "[1]", bib_text: "A. Author and B. Author. Sparse mixtures of experts for everyone. arXiv:2301.00001, 2023.",
  arxiv_id: "2301.00001", doi: null, title_guess: "Sparse mixtures of experts for everyone.",
  enriched: { title: "Sparse Mixtures of Experts for Everyone", authors: ["A. Author", "B. Author"], n_authors: 2, year: 2023,
    summary: "We study sparse MoE.", arxiv_id: "2301.00001", doi: "10.1000/sparse.2023", venue: null, citations: 42, tldr: "" },
};

test("bibKey: 첫 저자 성 + 연도 + 제목 첫 단어", () => {
  assert.equal(cc.bibKey(ARXIV_CARD), "author2023sparse");
  assert.equal(cc.bibKey({ bib_text: "E. Scholar. Load balancing for learned routers. Journal, 2021.", title_guess: "Load balancing for learned routers." }), "scholar2021load");
  assert.equal(cc.bibKey({ bib_text: "Smith, J. and Doe, K. The art of routing. 2019.", title_guess: "The art of routing" }), "smith2019art");
  assert.equal(cc.bibKey({ bib_text: "John Müller and Jane Doe. On things, 2020.", title_guess: "On things" }), "muller2020things");
  assert.equal(cc.bibKey({ bib_text: "", enriched: null }), "ref");
  assert.equal(cc.firstSurname("A. Author and B. Author."), "Author");
});

test("toBibtex: arXiv 프리프린트 / 학회 / 원문만", () => {
  const a = cc.toBibtex(ARXIV_CARD);
  assert.match(a, /^@article\{author2023sparse,\n/);
  assert.match(a, /title = \{Sparse Mixtures of Experts for Everyone\}/);
  assert.match(a, /author = \{A\. Author and B\. Author\}/);
  assert.match(a, /journal = \{arXiv preprint arXiv:2301\.00001\}/);
  assert.match(a, /eprint = \{2301\.00001\},\n  archivePrefix = \{arXiv\}/);
  assert.match(a, /url = \{https:\/\/arxiv\.org\/abs\/2301\.00001\}\n\}$/);
  const conf = cc.toBibtex({ ...ARXIV_CARD, enriched: { ...ARXIV_CARD.enriched, venue: "Proceedings of ACL & Friends", n_authors: 5, arxiv_id: null } });
  assert.match(conf, /^@inproceedings\{/);
  assert.match(conf, /booktitle = \{Proceedings of ACL \\& Friends\}/);
  assert.match(conf, /author = \{A\. Author and B\. Author and others\}/);
  assert.match(conf, /url = \{https:\/\/doi\.org\/10\.1000\/sparse\.2023\}/);
  const misc = cc.toBibtex({ bib_id: "bib.bib2", bib_text: "C. Writer. Attention {revisited} 100%. 2022.", enriched: null });
  assert.equal(misc, "@misc{writer2022,\n  note = {C. Writer. Attention revisited 100\\%. 2022.}\n}");
});

test("바구니: id 규칙, 같은 id는 교체, 내보내기에서 키 중복 해결, 제목 꺼내기", () => {
  assert.equal(cc.basketId(ARXIV_CARD, "2401.00001"), "arxiv:2301.00001");
  assert.equal(cc.basketId({ bib_id: "bib.bib3", doi: "10.1000/JML", enriched: null }, "2401.00001"), "doi:10.1000/jml");
  assert.equal(cc.basketId({ bib_id: "bib.bib2", enriched: null }, "2401.00001"), "ref:2401.00001:bib.bib2");
  const e1 = cc.basketEntry(ARXIV_CARD, "2401.00001", 1);
  assert.deepEqual(Object.keys(e1).sort(), ["bibtex", "id", "key", "ts"]); // 계약 모양 {id, key, bibtex, ts}
  let l = cc.basketAdd(null, e1);
  l = cc.basketAdd(l, { ...e1, ts: 2 });
  assert.equal(l.length, 1);
  assert.equal(l[0].ts, 2);
  l = cc.basketAdd(l, { id: "doi:x", key: "author2023sparse", bibtex: "@article{author2023sparse,\n  title = {Other}\n}", ts: 3 });
  const out = cc.bibExport(l);
  assert.match(out, /@article\{author2023sparse,/);
  assert.match(out, /@article\{author2023sparseb,/);
  assert.ok(out.endsWith("}\n"));
  assert.equal(cc.bibTitle(e1.bibtex), "Sparse Mixtures of Experts for Everyone");
  assert.equal(cc.bibTitle("@misc{x,\n  note = {Raw text}\n}"), "Raw text");
});

test("whyContext / citedContext: 원문 + 아는 서지·초록 (초록은 잘라서)", () => {
  const w = cc.whyContext(ARXIV_CARD);
  assert.match(w, /^인용 \[1\]: A\. Author/);
  assert.match(w, /제목: Sparse Mixtures/);
  assert.match(w, /저자: A\. Author, B\. Author/);
  assert.match(w, /게재: 2023/);
  assert.match(w, /초록: We study sparse MoE\./);
  assert.equal(cc.whyContext({ bib_text: "Only raw.", enriched: null }), "인용: Only raw.");
  const longAbs = { ...ARXIV_CARD, enriched: { ...ARXIV_CARD.enriched, summary: "x ".repeat(1000) } };
  const c = cc.citedContext([{ id: "bib.bib1", card: longAbs }, { id: "bib.bib2", card: { label: "[2]", bib_text: "C. Writer. Attention.", enriched: null } }], 600);
  assert.match(c, /^<cited-papers>\n\[1\]: A\. Author/);
  assert.match(c, /\n\n\[2\]: C\. Writer\. Attention\.\n<\/cited-papers>$/);
  const abs = c.match(/초록: (.*)/)[1];
  assert.ok(abs.length <= 601 && abs.endsWith("…"));
  assert.equal(cc.citedContext([]), "");
});
