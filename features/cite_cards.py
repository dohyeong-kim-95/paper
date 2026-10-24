"""cite-cards: 인용 카드 (참고문헌 즉시 표시 + arXiv·Semantic Scholar·Crossref 보강) + GitHub 링크 미리보기.

Claude 호출 없음: '여기서 왜 인용?'은 클라이언트가 /api/ask로 보냄 (논문 캐시 공유).
캐시: cache/<id>.cite-cards.json = {"_batch": ts, "<bib_id>": {"arxiv": meta|None, "s2": ..., "crossref": ...,
                                                               "_miss": {"<출처>": 확인 시각}}}
  - 찾은 메타는 계속 유효. None(찾아봤지만 없음)은 MISS_TTL 동안만 유효하고 지나면 다시 조회
  - 네트워크 실패·빈 응답인 출처는 키를 남기지 않음 (다음 탭에서 다시)
  - arXiv id가 있는 항목은 첫 탭에서 참고문헌의 (아직 모르는) arXiv id를 한 번(id_list)에 조회해 모두 저장
"""
import asyncio
import difflib
import re
import time
from urllib.parse import quote

import httpx
from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse

import app as core

router = APIRouter()

NAME = "cite-cards"
TIMEOUT = 5.0  # 외부 API 한 번의 제한 시간
ARXIV_WAIT = 12.0  # arXiv는 전역 3초 간격 대기열이 있어 전체 대기 상한을 따로
MATCH = 0.9  # 제목 검색 결과 채택 기준 (difflib 비율)
BATCH_MAX = 150
DOWN_TTL = 120  # S2·Crossref·GitHub가 실패(429·5xx·네트워크)하면 잠시 부르지 않음 (요청 제한 악화 방지)
GH_TTL = 86400  # GitHub 저장소 정보 디스크 캐시 수명 ('없음'(404)도 이 동안 캐시: 비인증 API는 IP당 시간 60회)
MISS_TTL = 7 * 86400  # '없음' 캐시 수명: arXiv의 일시적인 빈 응답 등이 영구히 남지 않게 지나면 다시 조회
S2_API = "https://api.semanticscholar.org/graph/v1/paper/"
S2_FIELDS = "title,venue,year,citationCount,tldr,externalIds,authors,abstract"
CROSSREF_API = "https://api.crossref.org/works/"
GITHUB_API = "https://api.github.com/repos/"
UA = {"User-Agent": "paper-reader/1.0 (arXiv mobile reader)"}
_down: dict[str, float] = {}  # 출처 -> 실패 시각


# ---------- 순수 도우미 ----------
def as_map(v) -> dict:
    return v if isinstance(v, dict) else {}


def norm_title(s: str) -> str:
    s = re.sub(r"\$[^$]*\$", " ", s or "")  # 수식($alttext$)은 검색어에서 뺌
    return re.sub(r"\s+", " ", re.sub(r"[^\w\s]|_", " ", s.lower())).strip()


def similar(a: str, b: str) -> float:
    a, b = norm_title(a), norm_title(b)
    return difflib.SequenceMatcher(None, a, b).ratio() if a and b else 0.0


def title_query(bib: dict) -> str:
    """제목 검색어 (문장부호 제거). 3단어 미만이면 '' → 검색하지 않음"""
    q = norm_title(bib.get("title_guess") or "")
    return q if len(q.split()) >= 3 else ""


def valid_arxiv_id(aid: str | None) -> bool:
    """새 형식 YYMM.NNNN(N): 월 01-12, 0704부터, 1501부터는 5자리. 형식이 틀린 id 하나가 id_list 일괄 조회 전체를
    오류로 만들지 않게 미리 거름"""
    m = re.fullmatch(r"(\d{2})(\d{2})\.(\d{4,5})", aid or "")
    if not m or not 1 <= int(m.group(2)) <= 12:
        return False
    yymm = int(m.group(1) + m.group(2))
    return yymm >= 704 and (len(m.group(3)) == 5) == (yymm >= 1501)


def known(entry: dict, src: str, now: float | None = None) -> bool:
    """이 출처의 결과가 캐시에 있고 유효한가: 찾은 메타는 계속, None(없음)은 MISS_TTL 동안만 (옛 캐시의 시각 없는 None은 만료)"""
    if src not in entry:
        return False
    if entry[src] is not None:
        return True
    t = as_map(entry.get("_miss")).get(src)
    return isinstance(t, (int, float)) and (now or time.time()) - t < MISS_TTL


def put(entry: dict, results: dict, now: float) -> dict:
    """출처별 결과를 항목에 병합한 새 dict. None은 확인 시각(_miss)을 남김. 이미 찾은 메타를 None으로 덮지 않음"""
    out = dict(as_map(entry))
    miss = dict(as_map(out.get("_miss")))
    for src, val in results.items():
        if val is None:
            if out.get(src) is not None:
                continue
            miss[src] = int(now)
        else:
            miss.pop(src, None)
        out[src] = val
    if miss:
        out["_miss"] = miss
    else:
        out.pop("_miss", None)
    return out


def sources(bib: dict) -> list[str]:
    # arXiv id → arXiv 일괄 + S2, DOI → S2 + Crossref, 둘 다 없음 → arXiv 제목 검색 + S2 제목 매치
    if bib.get("arxiv_id"):
        return ["arxiv", "s2"]
    if bib.get("doi"):
        return ["s2", "crossref"]
    return ["arxiv", "s2"]


def slim_arxiv(e: dict) -> dict:
    return {
        "title": e["title"], "authors": e["authors"][:5], "n_authors": len(e["authors"]), "year": e["year"],
        "summary": e["summary"], "arxiv_id": e["id"], "doi": e.get("doi"), "venue": None,
    }


def slim_s2(d: dict) -> dict:
    ext = d.get("externalIds") or {}
    authors = [a.get("name", "") for a in d.get("authors") or [] if a.get("name")]
    venue = (d.get("venue") or "").strip()
    return {
        "title": d.get("title") or "", "authors": authors[:5], "n_authors": len(authors), "year": d.get("year"),
        "summary": d.get("abstract") or "", "arxiv_id": ext.get("ArXiv"), "doi": ext.get("DOI"),
        "venue": None if re.match(r"^arxiv", venue, re.I) else venue or None,  # 'arXiv.org'는 게재처가 아님
        "citations": d.get("citationCount"), "tldr": (d.get("tldr") or {}).get("text") or "",
    }


def slim_crossref(m: dict) -> dict:
    authors = [" ".join(x for x in (a.get("given"), a.get("family")) if x) or a.get("name", "") for a in m.get("author") or []]
    authors = [a for a in authors if a]
    parts = next((m[k]["date-parts"][0] for k in ("issued", "published-print", "published-online", "published")
                  if isinstance(m.get(k), dict) and m[k].get("date-parts") and m[k]["date-parts"][0]), [None])
    abstract = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", m.get("abstract") or "")).strip()  # JATS 태그 제거
    return {
        "title": " ".join(m.get("title") or []).strip(), "authors": authors[:5], "n_authors": len(authors),
        "year": parts[0], "summary": abstract, "arxiv_id": None, "doi": m.get("DOI"),
        "venue": " ".join((m.get("container-title") or [])[:1]).strip() or None,
        "citations": m.get("is-referenced-by-count"),
    }


# 필드별 출처 우선순위 (서지는 arXiv > Crossref > S2, 게재처·인용 수·TL;DR은 S2 먼저)
ORDER = {"venue": ("s2", "crossref"), "citations": ("s2", "crossref"), "tldr": ("s2",)}
FIELDS = ("title", "authors", "n_authors", "year", "summary", "arxiv_id", "doi", "venue", "citations", "tldr")


def merge(entry: dict) -> dict | None:
    """출처별 결과 → 카드 하나. 아무 출처도 못 찾았으면 None"""
    got = {k: v for k, v in (entry or {}).items() if k in ("arxiv", "crossref", "s2") and v}
    if not got:
        return None
    out = {}
    for f in FIELDS:
        order = ORDER.get(f, ("arxiv", "crossref", "s2"))
        out[f] = next((got[s][f] for s in order if s in got and got[s].get(f) not in (None, "", [])), None)
    out["sources"] = [s for s in ("arxiv", "s2", "crossref") if s in got]
    return out


def card(bib: dict, entry: dict) -> dict:
    now = time.time()
    missing = [s for s in sources(bib) if not known(as_map(entry), s, now)]
    return {
        "bib_id": bib["id"], "label": bib["label"], "bib_text": bib["text"], "arxiv_id": bib["arxiv_id"],
        "doi": bib["doi"], "title_guess": bib["title_guess"], "enriched": merge(entry), "partial": bool(missing),
    }


# ---------- 외부 조회 ----------
class SourceDown(Exception):
    """네트워크·요청 제한·서버 오류: 캐시하지 않음"""


def is_down(src: str) -> bool:
    return time.time() - _down.get(src, 0) < DOWN_TTL


async def get_json(url: str, params: dict | None = None, headers: dict | None = None):
    """404·400 → None (없음, 캐시함). 그 밖의 실패는 SourceDown"""
    try:
        r = await core.http.get(url, params=params, headers={**UA, **(headers or {})}, timeout=TIMEOUT)
        if r.status_code in (400, 404):
            return None
        r.raise_for_status()
        return r.json()
    except (httpx.HTTPError, ValueError) as e:
        raise SourceDown(f"{type(e).__name__}: {e}") from e


async def arxiv_call(**kw) -> list[dict]:
    async def go():
        # 전역 arXiv 대기열(3초 간격)이 이미 깊으면 줄 서지 않음: 대기 중에 취소되면 예약한 자리만 남아
        # 요청 없이 다른 기능(related-papers·daily-feed …)의 호출을 3초씩 밀어냄. 확인과 자리 예약 사이에 await 없음
        depth = getattr(core, "_arxiv_next", 0.0) - time.monotonic()
        if depth > ARXIV_WAIT - TIMEOUT:
            raise SourceDown(f"arXiv queue {depth:.1f}s deep")
        return await core.arxiv_query(timeout=TIMEOUT, **kw)
    try:
        # 대기 ≤ ARXIV_WAIT - TIMEOUT이므로 이 상한은 실제 요청 중에만 걸림
        return await asyncio.wait_for(go(), ARXIV_WAIT)
    except (httpx.HTTPError, ValueError, asyncio.TimeoutError) as e:
        raise SourceDown(f"{type(e).__name__}: {e}") from e


async def arxiv_batch(arxiv_id: str, idx: dict, want: str) -> dict | None:
    """참고문헌에서 아직 모르는 arXiv id 전부를 한 번에 조회해 캐시 (동시 탭은 하나를 공유). 반환: want의 메타"""
    if not valid_arxiv_id(want):
        return None  # arXiv는 형식 오류만 돌려줌 → 없음
    path = core.task_path(arxiv_id, NAME)

    async def run():
        cur, now = as_map(core.read_json(path, {})), time.time()
        todo = [b["arxiv_id"] for bid, b in idx["bib"].items()
                if valid_arxiv_id(b["arxiv_id"]) and not known(as_map(cur.get(bid)), "arxiv", now)]
        ids = list(dict.fromkeys([want, *todo]))[:BATCH_MAX]
        entries = await arxiv_call(id_list=ids, max_results=len(ids))
        if not entries:  # arXiv가 가끔 주는 빈 페이지·오류 항목뿐인 피드 → '없음'으로 저장하지 않고 다음 탭에서 다시
            raise SourceDown("empty arXiv response")
        found = {e["id"]: slim_arxiv(e) for e in entries}
        now = time.time()

        def upd(c):
            c = as_map(c)
            for bid, b in idx["bib"].items():
                if b["arxiv_id"] in ids:  # 항목이 있는 응답에서 빠진 id만 '없음' (MISS_TTL 뒤 다시)
                    c[bid] = put(as_map(c.get(bid)), {"arxiv": found.get(b["arxiv_id"])}, now)
            c["_batch"] = int(now)
            return c
        core.update_json(path, upd, {})
        return ids, found

    ids, found = await core.singleflight((NAME, "batch", arxiv_id), run)
    if want not in ids:  # 동시에 돈 다른 탭의 일괄 조회(상한)에 빠짐 → 저장하지 않고 다음 탭에서 다시
        raise SourceDown("not in batch")
    return found.get(want)


async def arxiv_title(bib: dict) -> dict | None:
    q = title_query(bib)
    if not q:
        return None
    hits = await arxiv_call(search=f'ti:"{q}"', max_results=3)
    best = max(hits, key=lambda e: similar(e["title"], q), default=None)
    return slim_arxiv(best) if best and similar(best["title"], q) >= MATCH else None


async def s2_lookup(bib: dict) -> dict | None:
    params = {"fields": S2_FIELDS}
    if bib.get("arxiv_id"):
        d = await get_json(S2_API + "arXiv:" + bib["arxiv_id"], params)
    elif bib.get("doi"):
        d = await get_json(S2_API + "DOI:" + quote(bib["doi"], safe="/"), params)
    else:
        q = title_query(bib)
        if not q:
            return None
        res = await get_json(S2_API + "search/match", {**params, "query": q})
        d = ((res or {}).get("data") or [None])[0]
        if d and similar(d.get("title", ""), q) < MATCH:  # S2 매치는 느슨함 → 제목이 거의 같을 때만
            d = None
    return slim_s2(d) if isinstance(d, dict) else None


async def crossref_lookup(bib: dict) -> dict | None:
    d = await get_json(CROSSREF_API + quote(bib["doi"], safe="/"))
    m = (d or {}).get("message")
    return slim_crossref(m) if isinstance(m, dict) else None


async def enrich(arxiv_id: str, idx: dict, bib_id: str) -> dict:
    """빠진 출처만 병렬 조회 → 성공한 것만 캐시에 병합. 반환: 이 항목의 출처별 결과"""
    bib = idx["bib"][bib_id]
    path = core.task_path(arxiv_id, NAME)
    entry = dict(as_map(as_map(core.read_json(path, {})).get(bib_id)))
    now = time.time()
    jobs = {}
    for src in sources(bib):
        if known(entry, src, now) or (src != "arxiv" and is_down(src)):
            continue
        if src == "arxiv":
            jobs[src] = arxiv_batch(arxiv_id, idx, bib["arxiv_id"]) if bib["arxiv_id"] else arxiv_title(bib)
        else:
            jobs[src] = s2_lookup(bib) if src == "s2" else crossref_lookup(bib)
    results = await asyncio.gather(*jobs.values(), return_exceptions=True)
    new = {}
    for src, res in zip(jobs, results):
        if isinstance(res, BaseException):
            if not isinstance(res, SourceDown):
                core.log.warning("cite-cards %s failed: %r", src, res)
            if src != "arxiv":  # arXiv는 기본 출처라 다음 탭에서 다시 시도 (온라인 복귀 등)
                _down[src] = time.time()
            continue
        new[src] = res
    if new:
        now = time.time()
        core.update_json(path, lambda c: {**as_map(c), bib_id: put(as_map(as_map(c).get(bib_id)), new, now)}, {})
        entry = put(entry, new, now)
    return entry


# ---------- 라우트 ----------
REPO_RE = re.compile(r"^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))/([A-Za-z0-9._-]{1,100})$")


@router.get("/api/cite-cards/github")
async def github_repo(repo: str):
    """GitHub 저장소 미리보기 (api.github.com/repos/<owner>/<repo>만 — 임의 URL 조회 없음). 하루 캐시"""
    m = REPO_RE.match(re.sub(r"(\.git|\.+)$", "", repo.strip()))
    if not m or m.group(2) in (".", ".."):
        raise HTTPException(400, "저장소 이름 형식이 아닙니다 (owner/repo).")
    owner, name = m.groups()
    path = core.task_path("github", f"{NAME}.{owner}.{name}".lower())  # owner에는 '.'이 없으므로 겹치지 않음
    hit = core.read_json(path)  # {"ts", "data": 저장소 정보 | None(없음)}
    ok = isinstance(hit, dict) and "data" in hit and (hit["data"] is None or isinstance(hit["data"], dict))
    hit = hit if ok else None
    if hit and isinstance(hit.get("ts"), (int, float)) and time.time() - hit["ts"] < GH_TTL:
        return repo_response(hit["data"])

    async def fetch():
        d = await get_json(GITHUB_API + f"{owner}/{name}", headers={"Accept": "application/vnd.github+json"})
        if not isinstance(d, dict):  # 없음(비공개·삭제·저장소 아닌 경로)도 캐시 → 같은 링크를 탭할 때마다 GitHub를 부르지 않음
            core.write_json(path, {"ts": int(time.time()), "data": None})
            return None
        home = d.get("homepage") or ""
        data = {
            "full_name": d.get("full_name") or f"{owner}/{name}", "description": d.get("description") or "",
            "stars": d.get("stargazers_count"), "forks": d.get("forks_count"), "language": d.get("language"),
            "pushed_at": d.get("pushed_at"), "topics": (d.get("topics") or [])[:6], "archived": bool(d.get("archived")),
            "license": (d.get("license") or {}).get("spdx_id"),
            "homepage": home if re.match(r"^https?://", home) else None,
        }
        core.write_json(path, {"ts": int(time.time()), "data": data})
        return data

    data = core.MISSING
    if not is_down("github"):
        try:
            data = await core.singleflight((NAME, "github", owner.lower(), name.lower()), fetch)
        except SourceDown:
            _down["github"] = time.time()
    if data is core.MISSING:
        if hit:  # 오래된 캐시라도 있으면 그것을
            return repo_response(hit["data"])
        raise HTTPException(503, "GitHub 정보를 지금 불러올 수 없습니다 (요청 제한 또는 오프라인).")
    return repo_response(data)


def repo_response(data: dict | None):
    if data is None:
        raise HTTPException(404, "저장소를 찾을 수 없습니다.")
    return core.offline_json(data)


@router.get("/api/cite-cards/{arxiv_id}/{bib_id}")
async def cite_card(arxiv_id: str, bib_id: str):
    idx = await core.paper_index(arxiv_id)  # 논문이 없으면 404
    bib = idx["bib"].get(bib_id)
    if not bib:
        raise HTTPException(404, "참고문헌 항목을 찾을 수 없습니다.")
    entry = as_map(as_map(core.read_json(core.task_path(arxiv_id, NAME), {})).get(bib_id))
    if not all(known(entry, s) for s in sources(bib)):
        entry = await core.singleflight((NAME, arxiv_id, bib_id), lambda: enrich(arxiv_id, idx, bib_id))
    data = card(bib, entry)
    # 일부 출처가 실패한 응답은 오프라인 저장 대상이 아님 (나중의 완전한 응답을 덮지 않게)
    return JSONResponse(data) if data["partial"] else core.offline_json(data)
