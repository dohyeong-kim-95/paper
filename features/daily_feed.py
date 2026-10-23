"""daily-feed: 홈 화면 '오늘의 새 논문' — 관심 분야(arXiv 카테고리)·팔로우 저자의 최신 논문 피드.

- GET /api/daily-feed?cat=cs.CL | ?author=이름   최신 제출 30편 (arxiv_query: 전역 3초 간격, 1시간 메모리 캐시)
- GET /api/daily-feed/ko?cat=… | ?author=…      카드용 한국어 제목·한 줄 요약 {id: {t, b}}
- GET /api/daily-feed/suggest?ids=a,b,…         서재 논문들의 주 카테고리 → 기본 분야 추천

한국어 요약은 논문 캐시가 필요 없음 (제목·초록만 씀). 그래도 규칙 1대로 system_blocks(paper)+REQUEST_OPTS를 그대로
쓰고 '논문' 자리에 피드 목록(제목·초록)을 넣음. 10편씩 나눠 병렬 호출(응답 대기 단축), 결과는 논문 id별로 디스크에
남겨(cache/daily-feed.ko.v1.json) 같은 논문은 다시 만들지 않음 → 분야당 하루 한 번꼴.
"""
import asyncio
import re
import time
from collections import Counter

import httpx
from fastapi import APIRouter, HTTPException

import app as core

router = APIRouter()

NAME = "daily-feed"
CAT_RE = re.compile(r"^[a-z\-]+(\.[A-Za-z\-]+)?$")
# 저자 이름: 글자로 시작, 글자·공백·. ' - 만 (따옴표·괄호·콜론 같은 arXiv 검색 연산자 차단)
AUTHOR_RE = re.compile(r"^[^\W\d_](?:[^\W\d_]|[ .'\-])*$")
ID_RE = re.compile(r"^\d{4}\.\d{4,5}$")
TTL = 3600  # 피드 메모리 캐시 수명
EMPTY_TTL = 600  # 빈 결과(없는 분야·arXiv 일시 오류)는 짧게
FEEDS_KEEP = 64
MAX_RESULTS = 30
SUMMARY_MAX = 400
KO_NAME = "ko.v1"  # 프롬프트를 바꾸면 v2
KO_CHUNK = 10
KO_KEEP = 1500  # 디스크 맵에 남길 최근 논문 수
_feeds: dict[str, tuple[float, list[dict]]] = {}  # 검색어 -> (받은 시각, arxiv_query 결과)
_ko_failed: dict[str, tuple[float, str]] = {}  # 검색어 -> (시각, 오류) : 실패한 생성은 FAIL_TTL 동안 다시 안 부름
_suggest: dict[tuple, list[str]] = {}

KO_PROMPT = (
    "위 <paper>는 논문 한 편이 아니라 arXiv 새 논문 목록입니다 (항목마다 [id] 제목, 다음 줄부터 초록).\n"
    "아래 id 각각에 대해 휴대폰 피드 카드에 넣을 한국어 제목과 한 줄 요약을 만드세요.\n"
    "- t: 자연스러운 한국어 제목. 모델·데이터셋·고유명사는 원문 그대로. 60자 이내\n"
    "- b: 무엇을 했고 무엇이 새로운지 한 문장, '~제안'·'~보임'처럼 짧은 명사형 종결. 80자 이내. 초록에 없는 내용 금지\n"
    'JSON만 출력: {"items":[{"id":"…","t":"…","b":"…"}]}\n'
    "id: "
)


def reset():
    """테스트용: 메모리 상태 비우기"""
    for d in (_feeds, _ko_failed, _suggest):
        d.clear()


# ---------- 순수 도우미 ----------
def clip(s: str, n: int) -> str:
    s = re.sub(r"\s+", " ", s or "").strip()
    return s if len(s) <= n else re.sub(r"\s+\S*$", "", s[:n]) + "…"


def check_cat(cat: str) -> str:
    if len(cat or "") > 40 or not CAT_RE.fullmatch(cat or ""):
        raise HTTPException(400, "잘못된 분야 이름입니다 (예: cs.CL).")
    return cat


def check_author(name: str) -> str:
    name = re.sub(r"\s+", " ", name or "").strip()
    if not 2 <= len(name) <= 60 or not AUTHOR_RE.fullmatch(name):
        raise HTTPException(400, "잘못된 저자 이름입니다.")
    return name


def feed_query(cat: str | None, author: str | None) -> str:
    """HTTP 전에 검증 → arXiv search_query"""
    if cat:
        return f"cat:{check_cat(cat)}"
    if author:
        return f'au:"{check_author(author)}"'
    raise HTTPException(400, "cat 또는 author가 필요합니다.")


def slim(e: dict) -> dict:
    return {
        "id": e["id"], "title": e["title"], "authors": e["authors"][:3], "n_authors": len(e["authors"]),
        "summary": clip(e["summary"], SUMMARY_MAX), "published": e["published"], "updated": e["updated"],
        "cat": e.get("primary_category"), "comment": e.get("comment"),
    }


def digest(entries: list[dict]) -> str:
    # '논문' 자리에 들어갈 목록 (제목·초록만)
    return "\n\n".join(f"[{e['id']}] {e['title']}\n{clip(e['summary'], 1200)}" for e in entries)


def clean_ko(value, ids: set) -> dict:
    """{"items":[{id,t,b}]} → {id: {t, b}} (모르는 id·빈 값은 버림). 하나도 없으면 ValueError"""
    items = value.get("items") if isinstance(value, dict) else value
    if not isinstance(items, list):
        raise ValueError("items 목록이 없습니다")
    out = {}
    for it in items:
        if not isinstance(it, dict):
            continue
        i = re.sub(r"v\d+$", "", str(it.get("id") or "").strip())
        t, b = str(it.get("t") or "").strip(), str(it.get("b") or "").strip()
        if i in ids and t and b:
            out[i] = {"t": t[:120], "b": b[:200]}
    if not out:
        raise ValueError("유효한 항목이 없습니다")
    return out


def rank_cats(entries: list[dict], n: int = 3) -> list[str]:
    """주 카테고리 빈도순 (같으면 교차 등록 빈도, 이름순)"""
    primary, cross = Counter(), Counter()
    for e in entries:
        p = e.get("primary_category")
        if p:
            primary[p] += 1
        for c in e.get("categories") or []:
            if c != p:
                cross[c] += 1
    cats = [c for c in primary if CAT_RE.fullmatch(c)]
    cats.sort(key=lambda c: (-primary[c], -cross[c], c))
    return cats[:n]


# ---------- arXiv ----------
async def load_feed(query: str) -> list[dict]:
    """최신 제출 목록. 1시간 메모리 캐시, 동시 요청은 한 번만 조회. 조회 실패면 지난 목록이라도 (없으면 502)"""
    hit = _feeds.get(query)
    if hit and time.time() - hit[0] < (TTL if hit[1] else EMPTY_TTL):
        return hit[1]

    async def fetch():
        entries = await core.arxiv_query(search=query, max_results=MAX_RESULTS, sort_by="submittedDate")
        _feeds.pop(query, None)
        _feeds[query] = (time.time(), entries)
        while len(_feeds) > FEEDS_KEEP:
            _feeds.pop(next(iter(_feeds)))
        return entries

    try:
        return await core.singleflight((NAME, query), fetch)
    except (httpx.HTTPError, ValueError) as e:
        if hit:
            return hit[1]
        raise HTTPException(502, f"arXiv 조회 실패: {type(e).__name__}") from e


@router.get("/api/daily-feed")
async def daily_feed(cat: str | None = None, author: str | None = None):
    entries = await load_feed(feed_query(cat, author))
    return core.offline_json([slim(e) for e in entries])


# ---------- 한국어 제목·한 줄 요약 ----------
def ko_path():
    return core.task_path(NAME, KO_NAME)


def ko_map() -> dict:
    m = core.read_json(ko_path(), {})
    return m if isinstance(m, dict) else {}


async def translate_chunk(chunk: list[dict]) -> dict:
    paper = {"title": "arXiv 새 논문 목록", "text": digest(chunk)}
    ids = [e["id"] for e in chunk]
    try:
        text = await core.complete_text(paper, KO_PROMPT + ", ".join(ids), 250 * len(ids) + 300)
        return clean_ko(core.parse_json_loose(text), set(ids))
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001 - 형식 오류도 실패 (캐시 안 함)
        raise HTTPException(502, f"응답 형식 오류: {type(e).__name__}: {e}") from e


async def translate(query: str, entries: list[dict]) -> dict:
    chunks = [entries[i:i + KO_CHUNK] for i in range(0, len(entries), KO_CHUNK)]
    results = await asyncio.gather(*(translate_chunk(c) for c in chunks), return_exceptions=True)
    got, errors = {}, []
    for r in results:
        if isinstance(r, dict):
            got.update(r)
        else:
            errors.append(r)
    if got:
        now = int(time.time())

        def put(m):
            m = m if isinstance(m, dict) else {}
            m.update({k: {**v, "ts": now} for k, v in got.items()})
            if len(m) > KO_KEEP:  # 오래된 것부터 버림
                m = dict(sorted(m.items(), key=lambda kv: kv[1].get("ts", 0) if isinstance(kv[1], dict) else 0)[-KO_KEEP:])
            return m
        core.update_json(ko_path(), put, {})
    if errors:  # 일부라도 실패하면 기억 (그 묶음을 매 요청마다 다시 과금하지 않게)
        e = errors[0]
        _ko_failed[query] = (time.time(), str(getattr(e, "detail", "") or type(e).__name__))
        if not got:
            raise e if isinstance(e, HTTPException) else HTTPException(502, f"한국어 요약 실패: {type(e).__name__}")
    else:
        _ko_failed.pop(query, None)
    return got


@router.get("/api/daily-feed/ko")
async def daily_feed_ko(cat: str | None = None, author: str | None = None, retry: bool = False):
    query = feed_query(cat, author)
    entries = await load_feed(query)
    have = ko_map()
    missing = [e for e in entries if e["id"] not in have]
    failed = _ko_failed.get(query)
    error = HTTPException(502, failed[1]) if failed and not retry and time.time() - failed[0] < core.FAIL_TTL else None
    if missing and not error:
        try:
            await core.singleflight((NAME, "ko", query), lambda: translate(query, missing))
        except HTTPException as e:
            error = e
        have = ko_map()
    out = {e["id"]: {"t": have[e["id"]]["t"], "b": have[e["id"]]["b"]} for e in entries
           if isinstance(have.get(e["id"]), dict) and "t" in have[e["id"]] and "b" in have[e["id"]]}
    if entries and not out and error:
        raise error  # 하나도 없으면 502 (일부라도 있으면 그것만 200)
    return core.offline_json(out)


# ---------- 서재 기반 기본 분야 ----------
@router.get("/api/daily-feed/suggest")
async def daily_feed_suggest(ids: str = ""):
    clean = []
    for x in ids.split(","):
        i = re.sub(r"v\d+$", "", x.strip())
        if ID_RE.fullmatch(i) and i not in clean:
            clean.append(i)
    clean = clean[:20]
    if not clean:
        return {"cats": []}
    key = tuple(sorted(clean))
    if key not in _suggest:
        try:
            entries = await core.arxiv_query(id_list=clean, max_results=len(clean))
        except (httpx.HTTPError, ValueError):
            return {"cats": []}  # 실패는 기억하지 않음 (다음 방문에 다시)
        _suggest[key] = rank_cats([e for e in entries if e["id"] in clean])
    return {"cats": _suggest[key]}
