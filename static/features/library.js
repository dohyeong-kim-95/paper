// library: 내 서재 — 최근 읽은 논문·즐겨찾기·읽기 상태·태그·이어 읽기·읽은 시간·BibTeX·인용 표시(CiteSee)·모든 노트·백업
(function () {
  "use strict";

  // ---------- 순수 함수 (node 테스트 대상) ----------
  const KEY = "library";
  const STATUS = { "to-read": "읽을 예정", reading: "읽는 중", done: "완료" };
  const RANK = { "to-read": 1, reading: 2, done: 3 };
  const KIND = { hl: "하이라이트", note: "메모", qa: "Q&A" };
  const MAX = { title: 300, authors: 30, tags: 12, tag: 30, gist: 300, cites: 150 };
  const TINTS = ["lib-cf1", "lib-cf2", "lib-cf3"];
  const isObj = v => !!v && typeof v === "object" && !Array.isArray(v);
  const baseIdOf = id => String(id ?? "").trim().replace(/v\d+$/, "");
  const clip = (s, n) => {
    s = String(s ?? "").replace(/\s+/g, " ").trim();
    return s.length > n ? s.slice(0, n - 1) + "…" : s;
  };
  // 마지막 활동 시각 (정렬·가져오기 병합 기준)
  const activity = r => Math.max(Number(r && r.opened) || 0, Number(r && r.updated) || 0);
  // undefined·null·빈 문자열 필드 제거 (저장 크기·병합 단순화)
  const tidy = r => {
    for (const k of Object.keys(r)) if (r[k] === undefined || r[k] === null || r[k] === "") delete r[k];
    return r;
  };

  // arXiv id → 연도 (2401.04088 → 2024, hep-th/9901001 → 1999)
  function yearOf(id) {
    const s = baseIdOf(id);
    const m = s.match(/^(\d{2})(\d{2})\.\d{4,5}$/) || s.match(/\/(\d{2})(\d{2})\d{3}$/);
    if (!m || +m[2] < 1 || +m[2] > 12) return null;
    return (+m[1] >= 91 ? 1900 : 2000) + +m[1];
  }

  // 저자 이름 정리: 각주 기호·숫자 제거, 한 칸에 'A, B and C'처럼 여러 명이면 나눔, 중복 제거.
  // 구분: , ; & and, \quad(U+2003 등 넓은 공백). 화면에서는 건너뛴 각주 표시(sup·math·\thanks)도 ', '로 들어옴
  const NAME_SEP = /\s*(?:[,;&\u2001-\u2003\u3000]|\band\b)\s*/;
  const splitNames = s => String(s ?? "").split(NAME_SEP)
    .map(n => n.replace(/[*†‡§¶‖#∗⋆✉]|\d+/g, "").replace(/\s+/g, " ").trim()).filter(Boolean);
  function cleanAuthors(raw) {
    const out = [];
    for (const r of raw || []) {
      for (const n of splitNames(r)) {
        if (n.length < 2 || n.length > 60 || /@|https?:/.test(n) || out.includes(n)) continue;
        out.push(n);
      }
    }
    return out.slice(0, MAX.authors);
  }
  // 사람 이름처럼 보이는지 (저자 칸의 둘째 줄부터 판단용): 2~5단어, 대문자로 시작하거나 de·van 같은 조사,
  // 기관 낱말(University, Lab, Meta …)·약어(AI, MIT)가 없음
  const ORG = /(?:^|[^\p{L}])(?:univ|institu|laborator|labs?(?!\p{L})|research|academ|cent(?:er|re)(?!\p{L})|college|school|department|dept|inc(?!\p{L})|corp|ltd|llc|gmbh|company|hospital|foundation|[ée]cole|google|deepmind|meta(?!\p{L})|facebook|microsoft|openai|anthropic|amazon|apple|nvidia|ibm(?!\p{L})|alibaba|tencent|baidu|bytedance|huawei|samsung|hugging)/iu;
  const PARTICLE = /^(?:de|del|della|der|den|di|da|das|do|dos|du|van|von|la|le|bin|al|el|y|zu|ter|ten)$/i;
  function looksLikeName(n) {
    const words = String(n).split(" ");
    return words.length >= 2 && words.length <= 5 && !ORG.test(n)
      && words.every(w => PARTICLE.test(w) || (/^\p{Lu}/u.test(w) && !/^\p{Lu}{2,}$/u.test(w)));
  }
  // 저자 칸 하나의 줄들(<br>로 나뉨)에서 이름 줄만: 첫 줄은 그대로, 다음 줄은 사람 이름이 둘 이상이고 모두 이름처럼
  // 보일 때만 (LLaMA식 'A, B \\ C, D \\ Meta AI'). 빈 줄은 건너뛰고, 소속·이메일 줄에서 멈춤
  function pickNameLines(lines) {
    const out = [];
    for (const line of lines || []) {
      const names = splitNames(line);
      if (!names.length) continue;
      if (out.length && !(names.length >= 2 && names.every(looksLikeName))) break;
      out.push(String(line));
    }
    return out;
  }
  const authorsLine = a => (Array.isArray(a) && a.length ? a.slice(0, 3).join(", ") + (a.length > 3 ? ` 외 ${a.length - 3}명` : "") : "");

  // BibTeX 키: 첫 저자 성(소문자 ASCII) + 연도 → kim2024
  function lastName(name) {
    const s = String(name || "").trim();
    if (s.includes(",")) return s.split(",")[0].trim();
    const parts = s.split(/\s+/).filter(p => !/^(jr|sr|ii|iii|iv)\.?$/i.test(p));
    return parts[parts.length - 1] || "";
  }
  const ascii = s => String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const bibKey = rec => (ascii(lastName((rec.authors || [])[0])) || "arxiv") + (rec.year || yearOf(rec.id) || "");
  // 수식($…$) 밖의 LaTeX 특수문자만 이스케이프, 중괄호는 짝이 깨질 수 있어 뺌
  const bibText = s => String(s ?? "").replace(/\s+/g, " ").trim().split(/(\$[^$]*\$)/)
    .map((p, i) => (i % 2 ? p : p.replace(/[{}]/g, "").replace(/([&%#_])/g, "\\$1"))).join("");
  function toBibtex(rec, key) {
    const id = baseIdOf(rec.id), year = rec.year || yearOf(id);
    const fields = [
      ["title", rec.title ? `{${bibText(rec.title)}}` : ""],
      ["author", bibText((rec.authors || []).join(" and "))],
      ["year", year ? String(year) : ""],
      ["eprint", id],
      ["archivePrefix", "arXiv"],
      ["url", id ? `https://arxiv.org/abs/${id}` : ""],
    ].filter(([, v]) => v);
    return `@misc{${key || bibKey({ ...rec, year })},\n${fields.map(([k, v]) => `  ${k} = {${v}},`).join("\n")}\n}`;
  }
  // 여러 편을 한 .bib로: 키가 겹치면(같은 해의 Kim 두 편) kim2024, kim2024a, kim2024b … (BibTeX는 같은 키를 버림)
  const keySuffix = i => (i >= 26 ? keySuffix(Math.floor(i / 26) - 1) : "") + String.fromCharCode(97 + (i % 26));
  function toBibtexAll(recs) {
    const used = new Set();
    return (recs || []).map(rec => {
      const base = bibKey(rec);
      let key = base;
      for (let i = 0; used.has(key); i++) key = base + keySuffix(i);
      used.add(key);
      return toBibtex(rec, key);
    }).join("\n\n");
  }

  // 태그: 앞의 #·공백 정리, 대소문자 무시 중복 제거
  const normTag = t => String(t ?? "").replace(/^#+/, "").replace(/\s+/g, " ").trim().slice(0, MAX.tag);
  function unionTags(...lists) {
    const out = [];
    for (const t of lists.flat().map(normTag)) if (t && !out.some(x => x.toLowerCase() === t.toLowerCase())) out.push(t);
    return out.slice(0, MAX.tags);
  }
  // overview의 3줄 요약 첫 줄: 글머리표·굵게 표시 제거
  const gistLine = s => clip(String(s ?? "").split("\n")
    .map(x => x.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "").replace(/\*\*/g, "").trim()).find(Boolean) || "", MAX.gist);

  // library.add 규칙 (docs/FEATURES.md §6.1): 준 필드만 바꿈, 상태는 뒤로 안 감, star는 boolean일 때만,
  // tags는 합집합, opened는 그대로 (다른 기능이 추가한 것은 연 것이 아님)
  function applyAdd(rec, f, now = Date.now()) {
    const prev = isObj(rec) ? rec : null;
    const r = { ...(prev || {}), id: baseIdOf(f.id || (prev && prev.id)) };
    if (f.title) r.title = clip(f.title, MAX.title);
    if (Array.isArray(f.authors) && f.authors.length) r.authors = cleanAuthors(f.authors);
    if (RANK[f.status] > (RANK[r.status] || 0)) { r.status = f.status; r.statusAt = now; }
    if (typeof f.star === "boolean") r.star = f.star;
    if (Array.isArray(f.tags)) r.tags = unionTags(r.tags || [], f.tags);
    if (typeof f.gist === "string" && gistLine(f.gist)) r.gist = gistLine(f.gist);
    if (JSON.stringify(r) !== JSON.stringify(prev)) r.updated = now;
    return tidy(r);
  }

  // 사용자가 직접 바꾸는 값 (상태 되돌리기·해제, 태그 삭제 가능). statusAt = 상태를 마지막으로 정한 때
  // (해제도 포함: 가져오기 병합에서 지운 상태가 옛 기록의 상태로 되살아나지 않게)
  function setFields(rec, patch, now = Date.now()) {
    const r = { ...(isObj(rec) ? rec : {}), ...patch, updated: now };
    if (r.status && !RANK[r.status]) r.status = null;
    if ("status" in patch) r.statusAt = now;
    if ("tags" in patch) r.tags = unionTags(patch.tags || []);
    return tidy(r);
  }

  // 논문을 열 때: 제목·저자 갱신, opened = 지금
  function touchOpen(rec, meta, now = Date.now()) {
    const r = { ...(isObj(rec) ? rec : {}), id: baseIdOf(meta.id), opened: now };
    if (meta.title) r.title = clip(meta.title, MAX.title);
    const authors = cleanAuthors(meta.authors || []);
    if (authors.length) r.authors = authors;
    return tidy(r);
  }

  // 읽은 시간 더하기. 미정·'읽을 예정'은 1분을 넘기는 그 순간에만 '읽는 중'으로: 기록 전체의 readMs, 또는
  // 이번에 연 뒤 읽은 시간(session, 이번 ms를 더하기 전)이 1분을 넘을 때. 이미 넘은 뒤 사용자가 고른 상태
  // ('읽을 예정'·해제)는 다음 기록 때 덮어쓰지 않음. promote: false = 이 화면에서 사용자가 상태를 골랐음
  const READING_MS = 60000;
  function addReadTime(rec, ms, now = Date.now(), { session = null, promote = true } = {}) {
    const r = { ...(isObj(rec) ? rec : {}) };
    const add = Math.max(0, Number(ms) || 0), total = Number(r.readMs) || 0;
    const crosses = from => from < READING_MS && from + add >= READING_MS;
    r.readMs = total + add;
    if (promote && (!r.status || r.status === "to-read") && (crosses(total) || (session != null && crosses(Number(session) || 0)))) {
      r.status = "reading";
      r.updated = r.statusAt = now;
    }
    return r;
  }

  // 같은 논문의 두 기록 합치기 (가져오기): 최근에 바뀐 쪽(opened/updated)이 이기고, opened·readMs는 큰 값,
  // 빈 필드(제목·저자·요약·인용·태그)는 다른 쪽으로 채움. 상태는 더 나중에 정한 쪽(statusAt)을 따름
  // (그쪽에서 지운 상태면 지운 채로). 둘 다 statusAt이 같으면(없으면) 최근 쪽 → 없으면 다른 쪽
  function mergeRecord(a, b) {
    if (!isObj(a)) return isObj(b) ? { ...b } : a;
    if (!isObj(b)) return { ...a };
    const [older, newer] = activity(b) > activity(a) ? [a, b] : [b, a];
    const r = { ...older, ...newer };
    for (const k of ["title", "authors", "gist", "cites", "tags"]) if (r[k] == null || r[k] === "") r[k] = older[k];
    const sa = x => Number(x.statusAt) || 0;
    if (sa(a) !== sa(b)) {
      const w = sa(a) > sa(b) ? a : b;
      r.status = w.status;
      r.statusAt = sa(w);
    }
    r.opened = Math.max(+a.opened || 0, +b.opened || 0) || null;
    r.readMs = Math.max(+a.readMs || 0, +b.readMs || 0) || null;
    return tidy(r);
  }
  // 가져온 기록 정리: 모양이 틀린 필드는 버림 (화면·병합이 깨지지 않게), 모르는 필드는 그대로
  function cleanRecord(v, id) {
    const strs = x => (Array.isArray(x) ? x.filter(s => typeof s === "string") : undefined);
    const num = x => (Number.isFinite(+x) && +x > 0 ? +x : undefined);
    return tidy({
      ...v, id,
      title: typeof v.title === "string" ? clip(v.title, MAX.title) : undefined,
      authors: strs(v.authors), cites: strs(v.cites), tags: strs(v.tags) && unionTags(strs(v.tags)),
      gist: typeof v.gist === "string" ? v.gist : undefined, status: RANK[v.status] ? v.status : undefined,
      star: typeof v.star === "boolean" ? v.star : undefined,
      opened: num(v.opened), updated: num(v.updated), readMs: num(v.readMs), statusAt: num(v.statusAt),
    });
  }
  // pr:library 가져오기 병합: 논문별로 mergeRecord (같은 id면 더 최근 opened가 남음)
  function mergeImport(local, incoming) {
    const out = {};
    for (const src of [local, incoming]) {
      if (!isObj(src)) continue;
      for (const [k, v] of Object.entries(src)) {
        if (!isObj(v)) continue;
        const id = baseIdOf(typeof v.id === "string" && v.id ? v.id : k);
        if (!id) continue;
        const rec = cleanRecord(v, id);
        out[id] = out[id] ? mergeRecord(out[id], rec) : rec;
      }
    }
    return out;
  }

  // 참고문헌 항목의 글자·링크에서 arXiv id (서버 build_index와 같은 규칙 + CoRR 'abs/' 형식)
  const ID_IN_TEXT = /arxiv[:\s.]*(\d{4}\.\d{4,5})(?!\d)/i;
  const ID_IN_HREF = /(?:arxiv\.org\/(?:abs|pdf|html)\/|\babs\/)(\d{4}\.\d{4,5})(?!\d)/i;
  function arxivIdOf(text, hrefs = []) {
    const t = String(text || "");
    const m = t.match(ID_IN_TEXT) || t.match(ID_IN_HREF) || hrefs.map(x => String(x || "").match(ID_IN_HREF)).find(Boolean);
    return m ? m[1] : null;
  }
  // 내 서재의 다른 논문들이 각 arXiv id를 몇 편에서 인용했는지 (CiteSee 진하기)
  function citeCounts(lib, selfId) {
    const counts = {};
    for (const r of Object.values(isObj(lib) ? lib : {})) {
      if (!isObj(r) || r.id === selfId || !Array.isArray(r.cites)) continue;
      for (const c of new Set(r.cites)) counts[c] = (counts[c] || 0) + 1;
    }
    return counts;
  }
  const tintClass = n => (n >= 3 ? TINTS[2] : n === 2 ? TINTS[1] : n === 1 ? TINTS[0] : "");

  // 목록 거르기·정렬 (최근 활동 순)
  function filterRecords(lib, { q = "", status = "", tag = "", star = false } = {}) {
    const words = String(q).toLowerCase().split(/\s+/).filter(Boolean);
    const tg = String(tag).toLowerCase();
    return Object.values(isObj(lib) ? lib : {}).filter(r => isObj(r) && r.id
      && (!star || r.star) && (!status || r.status === status)
      && (!tg || (r.tags || []).some(t => String(t).toLowerCase() === tg))
      && words.every(w => [r.title, r.id, r.gist, ...(r.authors || []), ...(r.tags || [])].join(" ").toLowerCase().includes(w)))
      .sort((a, b) => activity(b) - activity(a));
  }
  // 이어 읽기: 연 적 있고 완료가 아닌 것, 최근에 연 순
  const recentRecords = (lib, n = 5) => Object.values(isObj(lib) ? lib : {})
    .filter(r => isObj(r) && r.id && r.opened && r.status !== "done")
    .sort((a, b) => b.opened - a.opened).slice(0, n);
  // 태그별 개수, 많은 순 → [[tag, n]]
  function allTags(records) {
    const m = new Map();
    for (const r of records || []) for (const t of Array.isArray(r && r.tags) ? r.tags : []) {
      const k = [...m.keys()].find(x => x.toLowerCase() === String(t).toLowerCase()) || t;
      m.set(k, (m.get(k) || 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }

  // 모든 노트: highlights-notes의 pr:highlights-notes:<id> (하이라이트·메모·Q&A)와 threads:<id> (질문 기록)를 한 목록으로
  function normQa(qa) {
    const list = Array.isArray(qa) ? qa : qa ? [qa] : [];
    return list.map(x => (typeof x === "string" ? { q: "", a: x }
      : isObj(x) ? { q: String(x.q ?? x.question ?? x.shown ?? ""), a: String(x.a ?? x.answer ?? x.text ?? "") } : null))
      .filter(x => x && (x.q || x.a));
  }
  function collectNotes(entries, lib = {}) {
    const items = [];
    for (const [key, value] of entries || []) {
      if (!Array.isArray(value)) continue;
      const rest = String(key).replace(/^pr:/, "").replace(/^highlights-notes:/, "");
      const thread = rest.startsWith("threads:");
      const paperId = thread ? rest.slice(8) : rest;
      if (!paperId || paperId === "prefs" || paperId.includes(":")) continue;
      const rec = isObj(lib[paperId]) ? lib[paperId] : {};
      for (const it of value) {
        if (!isObj(it)) continue;
        const base = { id: `${paperId}:${it.id ?? items.length}`, paperId, title: rec.title || paperId, tags: rec.tags || [], ts: Number(it.ts) || 0 };
        const quote = String((isObj(it.anchor) && it.anchor.quote) || it.quote || "");
        if (thread) {
          const hist = Array.isArray(it.history) ? it.history : [], shown = Array.isArray(it.shown) ? it.shown : [];
          const qa = [];
          for (let i = 0; i + 1 < hist.length; i += 2) {
            qa.push({ q: String(shown[i / 2] || (hist[i] && hist[i].content) || ""), a: String((hist[i + 1] && hist[i + 1].content) || "") });
          }
          if (qa.length) items.push({ ...base, type: "thread", color: "", quote, note: "", qa });
        } else {
          items.push({ ...base, type: KIND[it.type] ? it.type : "hl", color: String(it.color || ""), quote, note: String(it.note || ""), qa: normQa(it.qa) });
        }
      }
    }
    return items.sort((a, b) => b.ts - a.ts);
  }
  const noteKind = n => (n.qa && n.qa.length ? "qa" : n.note ? "note" : "hl");
  function searchNotes(items, { q = "", tag = "", kind = "" } = {}) {
    const words = String(q).toLowerCase().split(/\s+/).filter(Boolean);
    const tg = String(tag).toLowerCase();
    return (items || []).filter(n => (!kind || noteKind(n) === kind)
      && (!tg || (n.tags || []).some(t => String(t).toLowerCase() === tg))
      && words.every(w => [n.title, n.quote, n.note, ...n.qa.map(x => `${x.q} ${x.a}`)].join(" ").toLowerCase().includes(w)));
  }
  function notesToMarkdown(items, title = "모든 노트") {
    const out = [`# ${title}`, ""];
    const byPaper = new Map();
    for (const n of items || []) {
      if (!byPaper.has(n.paperId)) byPaper.set(n.paperId, []);
      byPaper.get(n.paperId).push(n);
    }
    for (const [id, list] of byPaper) {
      out.push(`## ${list[0].title} (arXiv:${id})`, "", `https://arxiv.org/abs/${id}`, "");
      for (const n of list) {
        if (n.quote) out.push(...n.quote.split("\n").map(l => `> ${l}`), "");
        if (n.note) out.push(n.note, "");
        for (const x of n.qa) {
          if (x.q) out.push(`**Q.** ${x.q}`, "");
          if (x.a) out.push(x.a, "");
        }
        out.push("---", "");
      }
    }
    return out.join("\n").trim() + "\n";
  }

  // 표시용 시간
  function formatDuration(ms) {
    const m = Math.floor((Number(ms) || 0) / 60000);
    if (m < 1) return "1분 미만";
    if (m < 60) return `${m}분`;
    const hrs = Math.floor(m / 60), r = m % 60;
    return r ? `${hrs}시간 ${r}분` : `${hrs}시간`;
  }
  function relTime(ts, now = Date.now()) {
    if (!ts) return "";
    const d = now - Number(ts);
    if (d < 60000) return "방금";
    if (d < 3600000) return `${Math.floor(d / 60000)}분 전`;
    if (d < 86400000) return `${Math.floor(d / 3600000)}시간 전`;
    if (d < 7 * 86400000) return `${Math.floor(d / 86400000)}일 전`;
    const t = new Date(Number(ts));
    return `${t.getFullYear()}.${t.getMonth() + 1}.${t.getDate()}`;
  }

  // 백업 파일: {app, v, exported, data: {pr:...}}. 가져오기는 감싼 형태와 키 맵 그대로 둘 다 받음
  const makeBackup = (data, now = Date.now()) => ({ app: "paper-reader", v: 1, exported: new Date(now).toISOString(), data });
  function parseImport(text) {
    let obj;
    try { obj = JSON.parse(text); } catch { throw new Error("JSON 파일이 아닙니다"); }
    const data = isObj(obj) && isObj(obj.data) ? obj.data : obj;
    if (!isObj(data)) throw new Error("백업 파일 형식이 아닙니다");
    const out = {};
    for (const [k, v] of Object.entries(data)) if (k.startsWith("pr:") && !/^pr:(app:thread|ui):/.test(k)) out[k] = v;
    if (!Object.keys(out).length) throw new Error("가져올 항목이 없습니다");
    return out;
  }

  const paperHref = id => "/paper/" + String(id).split("/").map(encodeURIComponent).join("/");
  // entry-routes 딥링크 (#q=<인용 ≤120자>): 그 문장으로 이동
  const quoteHref = (id, quote) => paperHref(id) + (quote ? "#q=" + encodeURIComponent(String(quote).slice(0, 120)) : "");

  const api = {
    STATUS, yearOf, cleanAuthors, pickNameLines, authorsLine, bibKey, toBibtex, toBibtexAll, unionTags, gistLine, applyAdd, setFields, touchOpen,
    addReadTime, mergeRecord, mergeImport, arxivIdOf, citeCounts, tintClass, filterRecords, recentRecords, allTags,
    collectNotes, noteKind, searchNotes, notesToMarkdown, formatDuration, relTime, makeBackup, parseImport, paperHref, quoteHref,
  };
  if (typeof module !== "undefined") module.exports = api;
  if (typeof document === "undefined") return;
  const page = document.body.dataset.page;
  if (!["paper", "home", "abstract"].includes(page)) return; // 논문·홈 (API는 초록 페이지에서도)

  const S = window.PaperStore, UI = window.PaperUI, App = window.PaperApp, h = UI.h;
  const listeners = new Set();
  const userStatus = new Set(); // 이 화면에서 사용자가 상태를 고른 논문 (읽은 시간으로 '읽는 중' 자동 변경 안 함)
  const readLib = () => { const v = S.get(KEY, {}); return isObj(v) ? v : {}; };
  const get = id => readLib()[baseIdOf(id)] || null;
  // 한 논문 기록 읽고-고치고-쓰기 (fn이 null을 돌려주면 삭제). 바뀌면 화면 갱신
  function write(id, fn) {
    id = baseIdOf(id);
    if (!id) return null;
    let rec = null;
    S.update(KEY, all => {
      all = isObj(all) ? all : {};
      rec = fn(isObj(all[id]) ? all[id] : null);
      if (rec) all[id] = { ...rec, id };
      else delete all[id];
      return all;
    }, {});
    for (const fn2 of listeners) { try { fn2(id, rec); } catch (e) { console.error("[library]", e); } }
    return rec ? { ...rec, id } : null;
  }
  const add = (fields = {}) => (fields && fields.id ? write(fields.id, r => applyAdd(r, { ...fields, id: baseIdOf(fields.id) })) : null);
  function remove(id) {
    const old = get(id);
    if (!old) return;
    write(id, () => null);
    UI.toast("기록에서 삭제했습니다", { actionLabel: "실행 취소", onAction: () => write(id, () => old) });
  }

  S.addMerger(KEY, (local, incoming, key) => (key === S.key(KEY) ? mergeImport(local, incoming) : local ?? incoming));
  App.registerFeature("library", { ...api, add, get });

  // peek을 닫은 뒤 이동: 닫을 때 ui.js가 history.back()으로 표지 항목({prLayer})을 걷어내므로 그 popstate 뒤에 이동.
  // 열린 채로 이동하면 표지 항목이 남아, 논문에서 뒤로 오면 표지(열린 peek, 또는 새로 읽어 같은 홈 한 번 더)에 도착
  function openAfterClose(close, url) {
    let done = false;
    const onSentinel = () => !!(history.state && history.state.prLayer);
    const go = force => {
      if (done || (!force && onSentinel())) return;
      done = true;
      clearTimeout(timer);
      window.removeEventListener("popstate", onPop);
      location.href = url;
    };
    const onPop = () => setTimeout(() => go(false), 0);
    window.addEventListener("popstate", onPop);
    const timer = setTimeout(() => go(true), 600); // popstate가 오지 않으면 (다른 레이어가 아직 열림 등) 그냥 이동
    close();
    go(false); // 표지 항목이 없었으면 바로
  }

  // ---------- 상태·즐겨찾기·태그 편집 peek (논문 화면 '읽기 상태', 홈 카드 ⋯) ----------
  function openEditor(id, { home = false } = {}) {
    const rec0 = get(id) || { id };
    const body = h("div", { class: "lib-edit" });
    const actions = [{ label: "BibTeX 복사", onClick: () => UI.copy(toBibtex(get(id) || rec0), "BibTeX를 복사했습니다") }];
    if (home) {
      actions.unshift({ label: "열기", primary: true, onClick: ({ close }) => openAfterClose(close, paperHref(id)) });
      actions.push({ label: "기록에서 삭제", onClick: ({ close }) => { close(); remove(id); } });
    }
    UI.peek({ title: rec0.title || id, body, actions, className: "lib-peek" });
    const save = (patch, refocus) => {
      if ("status" in patch) userStatus.add(baseIdOf(id));
      write(id, r => setFields(r || { id }, patch));
      render();
      if (refocus) body.querySelector(".lib-tag-input")?.focus();
    };
    function render() {
      const r = get(id) || { id }, tags = r.tags || [];
      const chip = (label, on, onclick, extra = {}) =>
        h("button", { type: "button", class: "lib-chip", "aria-pressed": on == null ? null : String(!!on), text: label, onclick, ...extra });
      const input = h("input", { class: "lib-tag-input", placeholder: "태그 추가", "aria-label": "태그 추가", maxlength: MAX.tag, enterkeyhint: "done", autocomplete: "off" });
      const addTag = () => {
        const v = input.value.split(/[,，]/).map(normTag).filter(Boolean);
        if (v.length) save({ tags: unionTags(tags, v) }, true);
      };
      const lower = tags.map(t => t.toLowerCase());
      const suggest = allTags(Object.values(readLib())).map(([t]) => t).filter(t => !lower.includes(t.toLowerCase())).slice(0, 8);
      const pos = S.paper("toc-progress:pos", null, id);
      const meta = [r.readMs ? `읽은 시간 ${formatDuration(r.readMs)}` : "", pos && +pos.pct > 0 ? `진행 ${Math.round(+pos.pct)}%` : "",
        r.opened ? `마지막으로 연 때 ${relTime(r.opened)}` : ""].filter(Boolean).join(" · ");
      body.replaceChildren(
        h("div", { class: "lib-edit-row", role: "group", "aria-label": "읽기 상태" }, h("span", { class: "lib-edit-label", text: "상태" }),
          ...Object.entries(STATUS).map(([k, label]) => chip(label, r.status === k, () => save({ status: r.status === k ? null : k })))),
        h("div", { class: "lib-edit-row" }, h("span", { class: "lib-edit-label", text: "즐겨찾기" }),
          chip(r.star ? "★ 즐겨찾기" : "☆ 즐겨찾기", r.star, () => save({ star: !r.star }))),
        h("div", { class: "lib-edit-row" }, h("span", { class: "lib-edit-label", text: "태그" }),
          ...tags.map(t => chip(`#${t} ✕`, null, () => save({ tags: tags.filter(x => x !== t) }), { "aria-label": `태그 ${t} 지우기` })),
          h("form", { class: "lib-tag-form", onsubmit: e => { e.preventDefault(); addTag(); } }, input, chip("추가", null, null, { type: "submit" }))),
        suggest.length ? h("div", { class: "lib-edit-row" }, h("span", { class: "lib-edit-label", text: "추천" }),
          ...suggest.map(t => chip(`+ ${t}`, null, () => save({ tags: unionTags(tags, [t]) })))) : null,
        meta ? h("div", { class: "lib-edit-meta", text: meta }) : null,
      );
    }
    render();
  }

  if (page === "paper" && App.baseId) initPaper(App.baseId);
  if (page === "home") {
    const sec = UI.homeSection({ id: "library", title: "내 서재" });
    if (sec) initHome(sec);
  }

  // ---------- 논문 화면: 기록·헤더 메뉴·인용 표시·읽은 시간 ----------
  // 저자 이름 칸의 줄들 (<br>마다 새 줄). 각주 표시(sup·math·\thanks)·소속·이메일은 빼고 그 자리를 ', '로
  // ('Alice¹ Bob²'처럼 표시로만 나뉜 이름도 따로). 어느 줄까지 이름인지는 pickNameLines가 고름
  function nameLines(el) {
    const lines = [""];
    const walk = node => {
      for (const n of node.childNodes) {
        if (n.nodeType === 3) lines[lines.length - 1] += n.data;
        else if (n.nodeType === 1) {
          if (n.localName === "br") lines.push("");
          else if (n.matches("sup, math, .ltx_note, .ltx_contact, .ltx_role_affiliation, .ltx_role_email, .ltx_role_address")) lines[lines.length - 1] += ", ";
          else walk(n);
        }
      }
    };
    walk(el);
    return lines;
  }

  function initPaper(id) {
    const paperEl = document.getElementById("paper");
    if (!paperEl) return;
    const titleEl = paperEl.querySelector(".ltx_title_document");
    const title = titleEl ? PaperAnchor.textOf(titleEl) : document.title;
    const authors = [...paperEl.querySelectorAll(".ltx_authors .ltx_personname")].flatMap(el => pickNameLines(nameLines(el)));
    write(id, r => touchOpen(r, { id, title, authors }));

    const starBtn = UI.addBarButton({ id: "library", label: "☆ 즐겨찾기", onClick: toggleStar });
    const statusBtn = UI.addBarButton({ id: "library:status", label: "읽기 상태", onClick: () => openEditor(id) });
    UI.addBarButton({ id: "library:bibtex", label: "BibTeX 복사", onClick: () => UI.copy(toBibtex(get(id) || { id, title }), "BibTeX를 복사했습니다") });
    function sync() {
      const r = get(id) || {};
      starBtn.setLabel(r.star ? "★ 즐겨찾기" : "☆ 즐겨찾기");
      starBtn.setActive(!!r.star);
      statusBtn.setLabel(STATUS[r.status] ? `읽기 상태 · ${STATUS[r.status]}` : "읽기 상태");
    }
    function toggleStar() {
      const r = write(id, x => setFields(x, { star: !(x && x.star) }));
      if (r && r.star) UI.toast("즐겨찾기에 추가했습니다");
      else UI.toast("즐겨찾기에서 뺐습니다", { actionLabel: "실행 취소", onAction: () => write(id, x => setFields(x, { star: true })) });
    }
    sync();

    // 인용 표시 (CiteSee): ● 내 서재에 있는 논문, 배경 진하기 = 내가 읽은 다른 논문 몇 편이 인용했는지.
    // 이 논문이 인용한 arXiv id는 cites에 저장 (다른 논문을 열 때 진하기 계산에 씀). 본문은 a.ltx_ref 클래스만 바꿈
    let bibMap = null;
    function tint() {
      const all = readLib(), counts = citeCounts(all, id);
      let marked = 0;
      for (const a of paperEl.querySelectorAll('a.ltx_ref[href^="#bib."]')) {
        let bid = a.getAttribute("href").slice(1);
        try { bid = decodeURIComponent(bid); } catch { /* 그대로 */ }
        const ax = bibMap[bid];
        const seen = !!(ax && ax !== id && all[ax]);
        const cls = ax ? tintClass(counts[ax] || 0) : "";
        a.classList.toggle("lib-cite-seen", seen);
        for (const c of TINTS) a.classList.toggle(c, c === cls);
        if (seen || cls) marked++;
      }
      if (marked && !S.get("library:hint")) {
        S.set("library:hint", true);
        UI.toast("인용 표시: ● 내 서재에 있는 논문 · 배경색 = 내가 읽은 논문들도 인용", { ms: 6000 });
      }
    }
    App.idle(() => {
      bibMap = {};
      for (const li of paperEl.querySelectorAll(".ltx_bibliography li.ltx_bibitem[id]")) {
        const blocks = [...li.querySelectorAll(".ltx_bibblock")].map(b => b.textContent);
        const ax = arxivIdOf(blocks.length ? blocks.join(" ") : li.textContent, [...li.querySelectorAll("a[href]")].map(a => a.getAttribute("href")));
        if (ax) bibMap[li.id] = ax;
      }
      const cites = [...new Set(Object.values(bibMap))].filter(x => x !== id).slice(0, MAX.cites);
      const r = get(id);
      if (JSON.stringify((r && r.cites) || []) !== JSON.stringify(cites)) write(id, x => tidy({ ...(x || {}), cites: cites.length ? cites : null }));
      tint();
    });
    listeners.add(changed => { if (changed === id) sync(); if (bibMap) tint(); });
    window.addEventListener("storage", e => { if (e.key === S.key(KEY)) { sync(); if (bibMap) tint(); } });
    App.on("translations", () => bibMap && tint()); // 번역문에 복제된 인용 링크도

    // 읽은 시간 (KOReader식): 화면이 보이고 2분 안에 스크롤·탭·키 입력이 있었던 시간만
    const TICK = 15000, IDLE = 120000;
    let lastAct = Date.now(), lastTick = Date.now(), pending = 0, hiddenAt = 0, sessionMs = 0;
    const act = () => { lastAct = Date.now(); };
    for (const ev of ["scroll", "pointerdown", "keydown", "wheel"]) window.addEventListener(ev, act, { passive: true, capture: true });
    function tick() {
      const now = Date.now();
      if (document.visibilityState === "visible" && now - lastAct < IDLE) pending += Math.max(0, Math.min(now - lastTick, TICK * 2));
      lastTick = now;
    }
    // offer: 주기 기록일 때만 '완료로 표시'를 권함 (숨김·pagehide 때의 마지막 기록은 아무도 못 보는 토스트)
    function flush(offer = false) {
      tick();
      if (pending < 1000) return;
      const ms = pending, session = sessionMs;
      pending = 0;
      sessionMs += ms;
      const r = write(id, x => addReadTime(x, ms, Date.now(), { session, promote: !userStatus.has(id) }));
      if (offer) maybeDone(r);
    }
    setInterval(() => { tick(); if (pending >= 30000) flush(true); }, TICK);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") { flush(); hiddenAt = Date.now(); return; }
      lastTick = lastAct = Date.now();
      if (hiddenAt && Date.now() - hiddenAt > 10 * 60000) write(id, r => ({ ...(r || {}), opened: Date.now() })); // 오래 뒤 다시 봄 = 다시 연 것
    });
    window.addEventListener("pagehide", () => flush());

    // 거의 끝까지 읽었으면 (toc-progress 진행률 90%+, 5분 이상) '완료로 표시'를 한 번 권함
    function maybeDone(r) {
      if (!r || r.status === "done" || (r.readMs || 0) < 5 * 60000 || document.visibilityState !== "visible") return;
      const pos = S.paper("toc-progress:pos", null, id);
      const asked = `library:asked-done:${id}`;
      if (!pos || !(+pos.pct >= 90) || S.session.get(asked)) return;
      S.session.set(asked, true);
      UI.toast("거의 다 읽었어요", { actionLabel: "완료로 표시", onAction: () => { write(id, x => setFields(x, { status: "done" })); UI.toast("완료로 표시했습니다"); } });
    }
  }

  // ---------- 홈: 이어 읽기 · ★ 즐겨찾기 · 전체 기록 · 모든 노트 · 백업 ----------
  function initHome(sec) {
    const st = { tab: S.session.get("library:tab", ""), q: "", status: "", tag: "", kind: "", limit: 30 };
    const sum = h("span", { class: "lib-sum" });
    sec.querySelector("h2")?.append(sum);
    const recentEl = h("div", { class: "lib-recent" });
    const emptyEl = h("p", { class: "lib-empty", text: "아직 기록이 없습니다. 논문을 열면 여기에 쌓이고, 다른 기기의 백업은 '가져오기'로 옮길 수 있습니다." });
    const tabsEl = h("div", { class: "lib-tabs", role: "tablist", "aria-label": "내 서재 보기" });
    const panelEl = h("div", { class: "lib-panel", role: "tabpanel" });
    const backupEl = h("div", { class: "lib-backup" });
    const file = h("input", { type: "file", accept: "application/json,.json", class: "lib-file", tabindex: "-1", "aria-hidden": "true" });
    const root = h("div", { class: "lib-home" }, recentEl, emptyEl, tabsEl, panelEl, backupEl, file);
    sec.append(root);
    file.addEventListener("change", () => importFile());
    let builtFor = null, search = null, chipsEl = null, listEl = null, rows = [], openQa = new Set(), lastSig = "";
    const md = (el, text) => (window.renderAnswerNow ? window.renderAnswerNow(el, text) : (el.textContent = text));
    const readNotes = lib => collectNotes(S.keys("highlights-notes:").map(k => [k, S.get(k)]), lib);

    // 다시 그리면 탭·칩·버튼이 새 요소가 됨: 포커스가 그 안에 있었으면 같은 data-fk를 가진 새 요소로 옮김 (키보드·화면 낭독기)
    function keepFocus(fn) {
      const a = document.activeElement;
      const fk = a && root.contains(a) && a.dataset ? a.dataset.fk : null;
      fn();
      if (fk && !root.contains(a)) root.querySelector(`[data-fk="${CSS.escape(fk)}"]`)?.focus({ preventScroll: true });
    }
    // 홈이 보여 주는 값들 (기록·노트·진행률·백업 시각·참고문헌 바구니). 같으면 다시 그리지 않음
    const sig = () => JSON.stringify([readLib(), S.get("library:backup", 0), S.get("cite-cards:bib", null),
      S.keys("highlights-notes:").map(k => [k, S.get(k)]),
      S.keys("toc-progress:pos:").map(k => [k, Math.round(+(S.get(k) || {}).pct || 0)])]);
    function render() {
      lastSig = sig();
      keepFocus(renderNow);
    }
    const refresh = () => keepFocus(() => refreshNow());

    function renderNow() {
      const lib = readLib(), notes = readNotes(lib);
      const recs = Object.values(lib).filter(r => isObj(r) && r.id);
      const starred = recs.filter(r => r.star).length;
      const total = recs.reduce((s, r) => s + (Number(r.readMs) || 0), 0);
      sum.textContent = recs.length ? ` ${recs.length}편${total >= 60000 ? ` · ${formatDuration(total)} 읽음` : ""}` : "";
      if (!st.tab) st.tab = starred ? "star" : "all";
      const recent = recentRecords(lib, 5);
      recentEl.replaceChildren(...(recent.length ? [h("h3", { class: "lib-h", text: "이어 읽기" }), ...recent.map(r => card(r, "recent"))] : []));
      recentEl.hidden = !recent.length;
      const empty = !recs.length && !notes.length;
      emptyEl.hidden = !empty;
      tabsEl.hidden = panelEl.hidden = empty;
      const tabs = [["star", `★ 즐겨찾기 ${starred}`], ["all", `전체 기록 ${recs.length}`], ["notes", `모든 노트 ${notes.length}`]];
      tabsEl.replaceChildren(...tabs.map(([k, label]) => h("button", {
        type: "button", role: "tab", class: "lib-tab", "aria-selected": String(st.tab === k), text: label, dataset: { fk: `tab:${k}` },
        onclick: () => { Object.assign(st, { tab: k, q: "", status: "", tag: "", kind: "", limit: 30 }); S.session.set("library:tab", k); render(); },
      })));
      if (builtFor !== st.tab) buildPanel();
      refreshNow(lib, notes);
      renderBackup();
    }

    function card(r, scope = "list") {
      const pos = S.paper("toc-progress:pos", null, r.id);
      const pct = pos && Number.isFinite(+pos.pct) ? Math.max(0, Math.min(100, Math.round(+pos.pct))) : 0;
      const meta = [authorsLine(r.authors), relTime(activity(r))].filter(Boolean).join(" · ");
      const stats = [pct ? `${pct}%` : "", r.readMs >= 60000 ? formatDuration(r.readMs) : ""].filter(Boolean).join(" · ");
      const link = h("a", { class: "lib-card-link", href: paperHref(r.id) },
        h("span", { class: "lib-card-title", text: (r.star ? "★ " : "") + (r.title || r.id) }),
        meta ? h("span", { class: "lib-card-meta", text: meta }) : null,
        r.gist ? h("span", { class: "lib-card-gist", text: r.gist }) : null,
        h("span", { class: "lib-card-foot" },
          STATUS[r.status] ? h("span", { class: `lib-status lib-s-${r.status}`, text: STATUS[r.status] }) : null,
          ...(r.tags || []).slice(0, 4).map(t => h("span", { class: "lib-tagchip", text: `#${t}` })),
          stats ? h("span", { class: "lib-stats", text: stats }) : null),
        pct ? h("span", { class: "lib-bar", "aria-hidden": "true" }, h("span", { style: `width:${pct}%` })) : null);
      const more = h("button", { type: "button", class: "lib-more", "aria-label": `${clip(r.title || r.id, 40)} 상태·태그`, text: "⋯", dataset: { fk: `${scope}:${r.id}` }, onclick: () => openEditor(r.id, { home: true }) });
      return h("div", { class: "lib-card", dataset: { id: r.id } }, link, more);
    }

    function noteCard(n) {
      const color = /^[a-z]+$/.test(n.color) ? n.color : "";
      const el = h("article", { class: `lib-note${color ? ` lib-c-${color}` : ""}` });
      if (n.quote) el.append(h("blockquote", { class: "lib-note-quote", text: clip(n.quote, 400) }));
      if (n.note) { const d = h("div", { class: "lib-note-text lib-md" }); md(d, n.note); el.append(d); }
      n.qa.slice(0, 8).forEach((x, i) => {
        const ans = h("div", { class: "lib-md" });
        const det = h("details", { class: "lib-qa", dataset: { k: `${n.id}:${i}` } }, h("summary", { text: `Q. ${clip(x.q || "질문", 200)}` }), ans);
        const fill = () => { if (!ans.dataset.done) { ans.dataset.done = "1"; md(ans, x.a); } }; // 펼칠 때 그림
        det.addEventListener("toggle", () => { if (det.open) fill(); });
        if (openQa.has(det.dataset.k)) { det.open = true; fill(); } // 다시 그려도 펼친 답은 펼친 채로
        el.append(det);
      });
      el.append(h("div", { class: "lib-note-foot" },
        h("a", { href: quoteHref(n.paperId, n.quote), text: clip(n.title, 90) }),
        h("span", { text: [n.type === "thread" ? "질문 기록" : KIND[noteKind(n)], relTime(n.ts)].filter(Boolean).join(" · ") })));
      return el;
    }

    function buildPanel() {
      builtFor = st.tab;
      const notes = st.tab === "notes";
      search = h("input", { type: "search", class: "lib-search", placeholder: notes ? "노트·질문 검색" : "제목·저자·태그 검색", "aria-label": "검색", enterkeyhint: "search", autocomplete: "off" });
      let timer;
      search.addEventListener("input", () => {
        clearTimeout(timer);
        timer = setTimeout(() => { st.q = search.value; st.limit = 30; refresh(); }, 150);
      });
      chipsEl = h("div", { class: "lib-chips" });
      listEl = h("div", { class: "lib-list" });
      const exportBtn = notes
        ? h("button", { type: "button", class: "lib-btn", text: "Markdown", title: "보이는 노트를 Markdown 파일로", onclick: () => rows.length && UI.download("notes.md", notesToMarkdown(rows), "text/markdown") })
        : h("button", { type: "button", class: "lib-btn", text: ".bib", title: "보이는 논문의 BibTeX 파일", onclick: () => rows.length && UI.download("library.bib", toBibtexAll(rows) + "\n", "text/plain") });
      panelEl.replaceChildren(h("div", { class: "lib-tools" }, search, exportBtn), chipsEl, listEl);
    }

    function refreshNow(lib = readLib(), notes = null) {
      const chip = (label, on, fn, fk) => h("button", { type: "button", class: "lib-chip", "aria-pressed": String(on), text: label, onclick: fn, dataset: { fk } });
      const tagChips = list => allTags(list).slice(0, 12).map(([t, n]) =>
        chip(`#${t} ${n}`, st.tag === t, () => { st.tag = st.tag === t ? "" : t; st.limit = 30; refresh(); }, `tag:${t}`));
      let items;
      if (st.tab === "notes") {
        const all = notes || readNotes(lib);
        rows = searchNotes(all, { q: st.q, tag: st.tag, kind: st.kind });
        chipsEl.replaceChildren(...[["", "전체"], ...Object.entries(KIND)].map(([k, label]) =>
          chip(label, st.kind === k, () => { st.kind = k; st.limit = 30; refresh(); }, `kind:${k}`)), ...tagChips(all));
        openQa = new Set([...listEl.querySelectorAll("details[open][data-k]")].map(d => d.dataset.k));
        items = rows.slice(0, st.limit).map(noteCard);
        if (!rows.length) items = [h("p", { class: "lib-empty", text: all.length ? "조건에 맞는 노트가 없습니다" : "논문에서 하이라이트·메모·질문을 남기면 여기에 모입니다" })];
      } else {
        const star = st.tab === "star";
        const base = filterRecords(lib, { star });
        rows = filterRecords(lib, { q: st.q, status: st.status, tag: st.tag, star });
        chipsEl.replaceChildren(...(star ? [] : [["", "전체"], ...Object.entries(STATUS)].map(([k, label]) =>
          chip(label, st.status === k, () => { st.status = k; st.limit = 30; refresh(); }, `status:${k}`))), ...tagChips(base));
        items = rows.slice(0, st.limit).map(card);
        if (!rows.length) items = [h("p", { class: "lib-empty", text: base.length ? "조건에 맞는 논문이 없습니다" : star ? "논문 화면의 ⋯ 메뉴에서 '☆ 즐겨찾기'로 추가하세요" : "논문을 열면 여기에 기록됩니다" })];
      }
      chipsEl.hidden = !chipsEl.childElementCount;
      if (rows.length > st.limit) {
        items.push(h("button", { type: "button", class: "lib-btn lib-more-rows", text: `더 보기 (${rows.length - st.limit})`, dataset: { fk: "more-rows" }, onclick: () => { st.limit += 30; refresh(); } }));
      }
      listEl.replaceChildren(...items);
    }

    function renderBackup() {
      const last = S.get("library:backup", 0);
      const basket = S.get("cite-cards:bib", []);
      const bibs = Array.isArray(basket) ? basket.map(b => b && b.bibtex).filter(Boolean) : [];
      backupEl.replaceChildren(
        h("span", { class: "lib-backup-label", text: last ? `백업 · 마지막 ${relTime(last)}` : "백업 (모든 기록·노트·설정)" }),
        h("button", { type: "button", class: "lib-btn", text: "내보내기", onclick: exportAll }),
        h("button", { type: "button", class: "lib-btn", text: "가져오기", onclick: () => file.click() }),
        bibs.length ? h("button", { type: "button", class: "lib-btn", text: `모아둔 참고문헌 .bib ${bibs.length}`, onclick: () => UI.download("references.bib", bibs.join("\n\n") + "\n", "text/plain") }) : null,
      );
    }

    async function exportAll() {
      const data = S.exportAll();
      const ok = await UI.download(`paper-reader-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(makeBackup(data)), "application/json");
      if (!ok) return;
      S.set("library:backup", Date.now());
      renderBackup();
      UI.toast(`${Object.keys(data).length}개 항목을 내보냈습니다`);
    }

    // 가져오기: 키마다 PaperStore.merge로 합침. 실행 취소 = 이 가져오기 전 상태로 되돌림 (앞 가져오기의 토스트는 닫음)
    let importToast = null;
    async function importFile() {
      const f = file.files && file.files[0];
      if (!f) return;
      let data;
      try { data = parseImport(await f.text()); } catch (e) { UI.toast(e.message || "가져오지 못했습니다"); return; } finally { file.value = ""; }
      const before = S.exportAll();
      const n = S.importAll(data);
      render();
      if (importToast) importToast.close();
      importToast = UI.toast(`${n}개 항목을 가져왔습니다`, {
        actionLabel: "실행 취소",
        onAction: () => {
          for (const k of S.keys()) if (!(k in before)) S.del(k);
          for (const [k, v] of Object.entries(before)) S.set(k, v);
          render();
        },
      });
    }

    render();
    listeners.add(() => render());
    // 다른 탭에서 바뀜, 논문에서 뒤로 왔을 때(bfcache), 앱으로 돌아왔을 때 → 보여 주는 값이 바뀌었을 때만 다시 그림
    // (숨김 중에는 미뤘다가 다시 보일 때). 펼친 Q&A·포커스는 다시 그려도 유지
    const maybeRender = () => { if (document.visibilityState !== "hidden" && sig() !== lastSig) render(); };
    window.addEventListener("storage", e => { if (!e.key || e.key.startsWith("pr:")) maybeRender(); });
    window.addEventListener("pageshow", e => { if (e.persisted) maybeRender(); });
    document.addEventListener("visibilitychange", maybeRender);
  }
})();
