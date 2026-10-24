"""daily-feed: 홈 화면 '오늘의 새 논문' — 관심 분야(arXiv 카테고리)·팔로우 저자의 최신 논문 피드.

- GET /api/daily-feed?cat=cs.CL | ?author=이름   최신 제출 30편 (arxiv_query: 전역 3초 간격, 1시간 메모리 캐시)
- GET /api/daily-feed/suggest?ids=a,b,…         서재 논문들의 주 카테고리 → 기본 분야 추천 (arXiv 실패는 502)

Claude를 부르지 않음: 한국어 제목·요약은 계약 §8.1에서 제외 (논문 없는 호출은 규칙 1 위반). arXiv 초록을 그대로 보여 줌.
"""
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
_feeds: dict[str, tuple[float, list[dict]]] = {}  # 검색어 -> (받은 시각, arxiv_query 결과)
_suggest: dict[tuple, list[str]] = {}


def reset():
    """테스트용: 메모리 상태 비우기"""
    for d in (_feeds, _suggest):
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
        except (httpx.HTTPError, ValueError) as e:
            # 빈 추천(200)과 구분: 실패는 기억하지 않고 502 → 클라이언트는 기본값을 저장하지 않고 다음 방문에 다시 물음
            raise HTTPException(502, f"arXiv 조회 실패: {type(e).__name__}") from e
        _suggest[key] = rank_cats([e for e in entries if e["id"] in clean])
    return {"cats": _suggest[key]}
