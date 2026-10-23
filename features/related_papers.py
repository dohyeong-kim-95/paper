"""related-papers: 관련 논문 패널 + 선택 구절 '관련 연구' 검색.

- GET  /api/related-papers/{id}            참고한 논문(참고문헌의 arXiv id, 본문 인용 많은 순 ≤15, id_list 한 번) +
                                            비슷한 논문(제목 키워드로 arXiv 검색, 자기 자신 제외). 7일 캐시, Claude 호출 없음
- GET  /api/related-papers/{id}/citations  이 논문을 인용한 논문 (Semantic Scholar, 피인용 많은 순 ≤30). 7일 캐시.
                                            환경변수 S2_API_KEY가 있으면 전용 한도로 호출
- POST /api/related-papers/{id}/terms      선택 구절 → 영어 검색어 2~4개 (작은 complete_text, 실패하면 불용어 거르기)
- GET  /api/related-papers/{id}/search?t=  검색어로 arXiv 검색 (1시간 메모리 캐시)
네트워크 오류는 200 + 빈 목록 + error, 캐시하지 않음 (7일 지난 옛 결과가 있으면 그것을 stale로)."""
import asyncio
import os
import re
import time
from collections import Counter, OrderedDict

import httpx
from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

import app as core

router = APIRouter()

TTL = 7 * 86400  # 관련 논문·피인용 목록 디스크 캐시 수명
MAX_CITED, MAX_SIMILAR, MAX_CITING, MAX_TERMS = 15, 10, 30, 4
S2_CITATIONS = "https://api.semanticscholar.org/graph/v1/paper/arXiv:{}/citations"
NEW_ID = re.compile(r"^\d{4}\.\d{4,5}$")
ARXIV_DOWN = "arXiv에 연결하지 못했습니다."

# 검색어에서 뺄 말: 영어 기능어 + 논문 제목에 흔한 일반어 (제목·선택 구절 공용)
STOP = frozenset("""
a an the and or but nor for of on in into onto to from by with without within via over under about above below
between among across after before during through toward towards up down out off as at is are was were be been being
am do does did done have has had having can could should would may might must will shall not no yes this that these
those it its itself they them their there here we our ours us you your i me my he she his her him which who whom whose
what when where why how than then so such too very also only just more most less least much many few some any all
each every both either neither other another same own new novel using use used uses based study studies paper papers
approach approaches method methods case beyond revisiting rethinking simple whether propose proposed proposes show
shows shown present presents introduce introduces result results work works section figure table equation eq fig et
al however thus therefore while because since although still even well first second third one two three four able
make makes made give gives given get gets set let see follows following respectively whereas upon e.g i.e etc cf vs
""".split())


def base_id(s: str) -> str:
    return re.sub(r"v\d+$", "", str(s or ""))


def keywords(text: str, n: int = 6) -> list[str]:
    """제목·구절 → 검색 키워드 (불용어·수식 제외, 많이 나온 순 → 먼저 나온 순, 복수형 중복 제거)"""
    text = re.sub(r"\$[^$]*\$", " ", text or "")
    words = re.findall(r"[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*", text)
    count, first, shown = Counter(), {}, {}
    for i, w in enumerate(words):
        lw = w.lower()
        if lw in STOP or (len(lw) < 3 and not (len(w) >= 2 and w.isupper())):  # 2글자는 KD·RL 같은 약어만
            continue
        key = lw[:-1] if lw.endswith("s") and len(lw) > 3 else lw  # experts/expert 한 번만
        count[key] += 1
        first.setdefault(key, i)
        shown.setdefault(key, lw)
    order = sorted(count, key=lambda k: (-count[k], first[k]))
    return [shown[k] for k in order[:n]]


def clean_term(t) -> str:
    """검색어 하나: arXiv 질의 문법 문자 제거, 소문자, 1~4단어. 불용어만 남으면 빈 문자열"""
    t = re.sub(r"[^A-Za-z0-9\- ]+", " ", str(t or "")).lower()
    words = [w.strip("-") for w in t.split()][:4]
    words = [w for w in words if w]
    if not words or all(w in STOP for w in words):
        return ""
    return " ".join(words)[:48]


def clean_terms(terms) -> list[str]:
    out = []
    for t in terms if isinstance(terms, list) else []:
        c = clean_term(t)
        if c and c not in out:
            out.append(c)
    return out[:MAX_TERMS]


def build_query(terms: list[str], op: str = "AND") -> str:
    """arXiv search_query: 각 검색어를 제목 또는 초록에서 (여러 단어·하이픈은 구절로)"""
    def field(t):
        q = f'"{t}"' if re.search(r"[\s-]", t) else t
        return f"(ti:{q} OR abs:{q})"
    return f" {op} ".join(field(t) for t in terms)


def item(e: dict) -> dict:
    # parse_atom 항목 → 화면에 필요한 것만
    authors = e.get("authors") or []
    return {
        "id": e["id"], "title": e.get("title") or "", "year": e.get("year"), "authors": authors[:3],
        "n_authors": len(authors), "summary": (e.get("summary") or "")[:2000], "abs_url": e.get("abs_url"),
        "category": e.get("primary_category"),
    }


def cite_counts(soup) -> Counter:
    """본문에서 각 참고문헌(#bib.*)을 몇 번 인용했는지 (참고문헌 목록 안 링크는 제외)"""
    c = Counter()
    for a in soup.find_all("a", href=True):
        href = a["href"]
        if href.startswith("#bib.") and a.find_parent(class_="ltx_bibliography") is None:
            c[href[1:]] += 1
    return c


async def search_arxiv(terms: list[str], exclude: set, n: int = MAX_SIMILAR) -> list[dict]:
    """AND 검색(관련도 순) → 3개 미만이면 OR로 넓혀 보충 (관련도 순이라 많이 맞는 것이 위)"""
    if not terms:
        return []
    hits = await core.arxiv_query(search=build_query(terms, "AND"), max_results=n + 1, sort_by="relevance")
    hits = [h for h in hits if base_id(h["id"]) not in exclude]
    if len(hits) < 3 and len(terms) > 1:
        more = await core.arxiv_query(search=build_query(terms, "OR"), max_results=n + 1, sort_by="relevance")
        seen = {h["id"] for h in hits}
        hits += [h for h in more if base_id(h["id"]) not in exclude and h["id"] not in seen]
    return [item(h) for h in hits[:n]]


async def cited_items(arxiv_id: str) -> list[dict]:
    """참고문헌의 arXiv 논문: 본문 인용 많은 순 ≤15, 메타데이터는 id_list 한 번"""
    idx = await core.paper_index(arxiv_id)
    counts = await asyncio.to_thread(cite_counts, await core.paper_soup(arxiv_id))
    me, refs, seen = base_id(arxiv_id), [], set()
    for order, b in enumerate(idx["bib"].values()):
        aid = base_id(b.get("arxiv_id") or "")
        if not aid or aid == me or aid in seen:
            continue
        seen.add(aid)
        refs.append({"aid": aid, "order": order, "bib": b, "cites": counts.get(b["id"], 0)})
    refs.sort(key=lambda r: (-r["cites"], r["order"]))
    refs = refs[:MAX_CITED]
    if not refs:
        return []
    meta = {e["id"]: e for e in await core.arxiv_query(id_list=[r["aid"] for r in refs], max_results=len(refs))}
    out = []
    for r in refs:
        e = meta.get(r["aid"])
        # arXiv가 모르는 id(철회 등)는 참고문헌 글로
        it = item(e) if e else {"id": r["aid"], "title": r["bib"].get("title_guess") or r["bib"]["text"][:200],
                                "year": None, "authors": [], "n_authors": 0, "summary": "",
                                "abs_url": f"https://arxiv.org/abs/{r['aid']}", "category": None}
        out.append({**it, "bib_id": r["bib"]["id"], "label": r["bib"].get("label") or "", "cites": r["cites"]})
    return out


def fresh(hit) -> bool:
    return isinstance(hit, dict) and isinstance(hit.get("ts"), (int, float)) and time.time() - hit["ts"] < TTL


def respond(data: dict) -> JSONResponse:
    # 오류가 섞인 응답은 오프라인 저장 안 함 (sw.js가 좋은 결과를 빈 결과로 덮지 않게)
    return JSONResponse(data) if data.get("error") else core.offline_json(data)


async def _build_related(arxiv_id: str) -> dict:
    path = core.task_path(arxiv_id, "related-papers")
    hit = core.read_json(path)
    if fresh(hit):  # 같이 기다리던 다른 요청이 방금 저장
        return hit
    idx = await core.paper_index(arxiv_id)  # 없는 논문은 404 그대로
    title = idx.get("title") or (await core.get_paper(arxiv_id)).get("title", "")
    terms = keywords(title, 6)
    cited, similar = await asyncio.gather(
        cited_items(arxiv_id), search_arxiv(terms, {base_id(arxiv_id)}), return_exceptions=True)
    errors = [x for x in (cited, similar) if isinstance(x, BaseException)]
    for x in errors:
        if not isinstance(x, (httpx.HTTPError, ValueError)):
            raise x
    data = {"ts": time.time(), "title": title, "terms": terms,
            "cited": [] if isinstance(cited, BaseException) else cited,
            "similar": [] if isinstance(similar, BaseException) else similar}
    if errors:
        core.log.warning("related-papers %s: %r", arxiv_id, errors[0])
        if isinstance(hit, dict) and hit.get("ts"):  # 7일 지난 옛 결과라도 빈 목록보다 나음
            return {**hit, "stale": True}
        return {**data, "error": ARXIV_DOWN}
    core.write_json(path, data)
    return data


@router.get("/api/related-papers/{arxiv_id}")
async def related(arxiv_id: str):
    hit = core.read_json(core.task_path(arxiv_id, "related-papers"))
    if fresh(hit):
        return core.offline_json(hit)
    return respond(await core.singleflight(("related-papers", arxiv_id), lambda: _build_related(arxiv_id)))


# ---------- 이 논문을 인용한 논문 (Semantic Scholar) ----------
def parse_citations(data) -> list[dict]:
    """S2 /citations 응답 → [{id(새 형식 arXiv id | None), title, year, citations, abs_url, s2_url, doi}], 피인용 많은 순"""
    if not isinstance(data, dict) or not isinstance(data.get("data", []), list):
        raise ValueError("S2 응답 형식이 아닙니다")
    out = []
    for row in data.get("data") or []:
        p = (row or {}).get("citingPaper") if isinstance(row, dict) else None
        if not isinstance(p, dict):
            continue
        title = re.sub(r"\s+", " ", p.get("title") or "").strip()
        if not title:
            continue
        ext = p.get("externalIds") or {}
        ax = str(ext.get("ArXiv") or "") or None
        out.append({
            "id": ax if ax and NEW_ID.match(ax) else None,  # 이 앱에서 열 수 있는 것만
            "title": title, "year": p.get("year"), "citations": int(p.get("citationCount") or 0),
            "abs_url": f"https://arxiv.org/abs/{ax}" if ax else None,
            "s2_url": f"https://www.semanticscholar.org/paper/{p['paperId']}" if p.get("paperId") else None,
            "doi": ext.get("DOI"),
        })
    out.sort(key=lambda x: (-x["citations"], -(x["year"] or 0)))
    return out


async def _build_citations(arxiv_id: str, aid: str) -> dict:
    path = core.task_path(arxiv_id, "related-papers.citations")
    hit = core.read_json(path)
    if fresh(hit):
        return hit
    key = os.environ.get("S2_API_KEY")  # 있으면 전용 한도 (없으면 공용 한도라 429가 잦음)
    try:
        r = await core.http.get(
            S2_CITATIONS.format(aid), params={"fields": "title,year,externalIds,citationCount", "limit": "1000"},
            headers={"x-api-key": key} if key else None, timeout=15)
        if r.status_code != 200:
            code = {404: "not_found", 429: "rate_limited"}.get(r.status_code, "network")
            return {"citing": [], "total": 0, "error": code}
        data = r.json()
        rows = parse_citations(data)
    except (httpx.HTTPError, ValueError) as e:
        core.log.warning("related-papers citations %s: %r", arxiv_id, e)
        return {"citing": [], "total": 0, "error": "network"}
    out = {"ts": time.time(), "citing": rows[:MAX_CITING], "total": len(rows), "more": bool(data.get("next"))}
    core.write_json(path, out)
    return out


@router.get("/api/related-papers/{arxiv_id}/citations")
async def citations(arxiv_id: str):
    aid = core.parse_arxiv_id(arxiv_id)
    if not aid or aid != arxiv_id:
        raise HTTPException(400, "arXiv ID 형식이 아닙니다.")
    hit = core.read_json(core.task_path(arxiv_id, "related-papers.citations"))
    if fresh(hit):
        return core.offline_json(hit)
    return respond(await core.singleflight(("related-papers.citations", arxiv_id),
                                          lambda: _build_citations(arxiv_id, base_id(aid))))


# ---------- 선택 구절 → 관련 연구 ----------
TERMS_PROMPT = """독자가 이 논문에서 고른 구절과 관련된 다른 연구를 arXiv에서 찾으려 합니다.
구절의 핵심 연구 주제를 나타내는 영어 검색어를 2~4개 고르세요.
- 각 검색어는 1~3단어의 영어 명사구 (예: "knowledge distillation", "mixture of experts")
- 약어는 이 논문에서 쓰인 원래 이름으로 풀어 쓰기
- 이 논문만의 고유 이름(모델·데이터셋 이름)보다 일반적인 연구 주제어, 중요한 것부터
JSON만 출력: {"terms": ["...", "..."]}

<passage>
@@TEXT@@
</passage>"""

_terms: OrderedDict = OrderedDict()  # (id, 구절) -> 검색어 (최근 100개)
_search: OrderedDict = OrderedDict()  # (base id, 검색어들) -> (시각, 결과) (최근 100개, 1시간)
SEARCH_TTL = 3600


def _remember(cache: OrderedDict, key, value, keep: int = 100):
    cache[key] = value
    cache.move_to_end(key)
    while len(cache) > keep:
        cache.popitem(last=False)


class TermsBody(BaseModel):
    q: str = Field(..., max_length=6000)


@router.post("/api/related-papers/{arxiv_id}/terms")
async def terms(arxiv_id: str, body: TermsBody):
    text = re.sub(r"\s+", " ", body.q).strip()[:1500]
    if len(text) < 3:
        raise HTTPException(400, "선택한 글이 너무 짧습니다.")
    key = (arxiv_id, text)
    if key in _terms:
        _terms.move_to_end(key)
        return {"terms": _terms[key], "ai": True}
    paper = await core.get_paper(arxiv_id)
    try:
        raw = await core.complete_text(paper, TERMS_PROMPT.replace("@@TEXT@@", text), max_tokens=150)
        value = core.parse_json_loose(raw)
        found = clean_terms(value.get("terms") if isinstance(value, dict) else value)
        if not found:
            raise ValueError("검색어 없음")
    except (HTTPException, ValueError) as e:
        # Claude 실패·형식 오류: 구절의 단어에서 불용어를 거른 것으로 (검색은 계속)
        core.log.warning("related-papers terms fallback: %r", e)
        return {"terms": clean_terms(keywords(text, MAX_TERMS)), "ai": False}
    _remember(_terms, key, found)
    return {"terms": found, "ai": True}


@router.get("/api/related-papers/{arxiv_id}/search")
async def search(arxiv_id: str, t: list[str] = Query(default=[])):
    found = clean_terms(t)
    if not found:
        raise HTTPException(400, "검색어가 없습니다.")
    me = base_id(arxiv_id)
    key = (me, tuple(found))
    hit = _search.get(key)
    if hit and time.time() - hit[0] < SEARCH_TTL:
        return hit[1]
    try:
        hits = await search_arxiv(found, {me})
    except (httpx.HTTPError, ValueError) as e:
        core.log.warning("related-papers search %s: %r", found, e)
        return {"terms": found, "hits": [], "error": ARXIV_DOWN}
    out = {"terms": found, "hits": hits}
    _remember(_search, key, (time.time(), out))
    return out
