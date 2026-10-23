// PaperStore: localStorage 래퍼. 모든 키는 'pr:'로 시작, 값은 JSON.
// 사생활 모드·저장소 차단·용량 초과에도 throw 하지 않음 (set은 실패 시 false).
(function () {
  "use strict";
  const PREFIX = "pr:";
  const full = k => (String(k).startsWith(PREFIX) ? String(k) : PREFIX + k);
  const baseIdOf = id => String(id || "").replace(/v\d+$/, "");

  // 저장소를 못 쓰는 환경용 메모리 대체물
  function memoryStorage() {
    const m = new Map();
    return {
      getItem: k => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => void m.set(k, String(v)),
      removeItem: k => void m.delete(k),
      key: i => [...m.keys()][i] ?? null,
      get length() { return m.size; },
    };
  }

  // 가져오기 병합 기본 규칙: 배열은 id(없으면 값) 기준 합집합, 같은 id면 ts/opened/updated 큰 쪽.
  // 객체의 값이 모두 객체면 키별로 같은 규칙, 그 외(설정 등)는 로컬 값 유지.
  const stamp = v => (v && typeof v === "object" ? v.ts || v.opened || v.updated || 0 : 0);
  const isObj = v => v && typeof v === "object" && !Array.isArray(v);
  const keyOf = v => (isObj(v) ? String(v.id ?? v.term ?? JSON.stringify(v)) : JSON.stringify(v));
  function mergeDefault(local, incoming) {
    if (local === undefined || local === null) return incoming;
    if (incoming === undefined || incoming === null) return local;
    if (Array.isArray(local) && Array.isArray(incoming)) {
      const map = new Map();
      for (const item of [...local, ...incoming]) {
        const k = keyOf(item), prev = map.get(k);
        if (!prev || stamp(item) > stamp(prev)) map.set(k, item);
      }
      return [...map.values()];
    }
    if (isObj(local) && isObj(incoming) && Object.values({ ...local, ...incoming }).every(isObj)) {
      const out = { ...local };
      for (const [k, v] of Object.entries(incoming)) if (!out[k] || stamp(v) > stamp(out[k])) out[k] = v;
      return out;
    }
    return local;
  }

  function makeStore(storage, getBaseId = () => "", onFull = () => {}) {
    const mergers = [];
    const api = {
      PREFIX,
      key: full,
      get(key, fallback = null) {
        try {
          const raw = storage.getItem(full(key));
          return raw === null ? fallback : JSON.parse(raw);
        } catch { return fallback; }
      },
      set(key, value) {
        try { storage.setItem(full(key), JSON.stringify(value)); return true; }
        catch (e) { onFull(e, full(key)); return false; }
      },
      del(key) { try { storage.removeItem(full(key)); } catch { /* 무시 */ } },
      update(key, fn, fallback = null) {
        const v = fn(api.get(key, fallback));
        api.set(key, v);
        return v;
      },
      keys(prefix = "") {
        const p = full(prefix), out = [];
        try {
          for (let i = 0; i < storage.length; i++) {
            const k = storage.key(i);
            if (k && k.startsWith(p)) out.push(k);
          }
        } catch { /* 무시 */ }
        return out.sort();
      },
      // 논문별 키: pr:<ns>:<baseId> (baseId = 버전 vN 뗀 arXiv id)
      paperKey: (ns, baseId) => `${full(ns)}:${baseIdOf(baseId || getBaseId())}`,
      paper: (ns, fallback = null, baseId) => api.get(api.paperKey(ns, baseId), fallback),
      setPaper: (ns, value, baseId) => api.set(api.paperKey(ns, baseId), value),
      delPaper: (ns, baseId) => api.del(api.paperKey(ns, baseId)),
      // 내보내기/가져오기 (library 기능이 사용). 각 기능은 자기 키의 병합 규칙을 addMerger로 등록
      addMerger(prefix, fn) { mergers.push([full(prefix), fn]); },
      merge(key, local, incoming) {
        const k = full(key);
        const m = mergers.filter(([p]) => k.startsWith(p)).sort((a, b) => b[0].length - a[0].length)[0];
        return (m ? m[1] : mergeDefault)(local, incoming, k);
      },
      exportAll() {
        const out = {};
        for (const k of api.keys()) out[k] = api.get(k);
        return out;
      },
      importAll(data) {
        let n = 0;
        for (const [k, v] of Object.entries(data || {})) {
          if (!k.startsWith(PREFIX)) continue;
          if (api.set(k, api.merge(k, api.get(k, null), v))) n++;
        }
        return n;
      },
    };
    return api;
  }

  const api = { PREFIX, baseIdOf, mergeDefault, makeStore, memoryStorage };
  if (typeof module !== "undefined") module.exports = api;
  if (typeof document === "undefined") return;

  const usable = name => {
    try {
      const s = window[name];
      s.setItem("pr:__t", "1");
      s.removeItem("pr:__t");
      return s;
    } catch { return memoryStorage(); }
  };
  const getBaseId = () => baseIdOf(document.body && document.body.dataset.arxivId);
  let warned = false;
  const onFull = () => {
    // 용량 초과: ui.js가 '저장 공간 부족' 토스트를 띄움
    if (!warned) document.dispatchEvent(new CustomEvent("paper:store-full"));
    warned = true;
  };
  const store = makeStore(usable("localStorage"), getBaseId, onFull);
  store.baseIdOf = baseIdOf;
  store.session = makeStore(usable("sessionStorage"), getBaseId, onFull); // 탭 단위 (열린 대화 복원 등)
  // 사파리 ITP 등으로 지워지지 않게 영구 저장 요청 (지원 시, 조용히)
  try { navigator.storage && navigator.storage.persist && navigator.storage.persist().catch(() => {}); } catch { /* 무시 */ }
  window.PaperStore = store;
})();
