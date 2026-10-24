"""entry-routes: arXiv 주소 그대로 열기(/abs·/pdf·/html), 공유 타깃(/share), HTML 없는 논문의 초록 페이지,
하이라이트·메모 공유 링크 (POST /api/entry-routes/share → /paper/<id>#s=<공유 id>)"""
import contextlib
import json
import re
import secrets
import time
from typing import Annotated
from urllib.parse import urlencode

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, BeforeValidator, Field

import app as core

router = APIRouter()

# 확실한 형태(arXiv 주소·'arXiv:' 표기·alphaXiv·HF Papers·ar5iv)를 먼저, 없으면 아무 새 형식 번호
STRONG_RE = re.compile(
    r"(?:arxiv\.org/(?:abs|pdf|html|format)/|arxiv\s*:\s*|alphaxiv\.org/(?:abs|overview|pdf)/|"
    r"huggingface\.co/papers/|ar5iv(?:\.labs\.arxiv)?\.org/(?:abs|html)/)(\d{4}\.\d{4,5}(?:v\d+)?)",
    re.I,
)
SHARE_ID_RE = re.compile(r"[A-Za-z0-9_-]{8,32}")
ABS_TTL = 86400  # 초록 메타데이터 디스크 캐시 1일 (그 사이 HTML이 생기면 훅 자체가 안 불림)
ABS_MISS_TTL = 6 * 3600  # arXiv에 없는 id도 6시간 기억: 없는 id 반복 요청이 전역 arXiv 스로틀(3초/건)을 잡아먹지 않게
SHARE_MAX = 300_000  # 공유 하나의 최대 크기 (바이트)
# 공유 만들기는 계정 없이 디스크에 쓰므로 (논문·Claude 결과 캐시와 같은 폴더) 전체 크기와 빈도를 묶어 둠
SHARE_DISK_MAX = 100_000_000  # 공유 파일 전체 상한 (바이트). 닿으면 SHARE_KEEP보다 오래된 공유부터 지우고, 그래도 넘으면 507
SHARE_KEEP = 90 * 86400  # 상한에 닿았을 때만 이보다 오래된 공유를 지움 (평소에는 링크가 계속 열림)
SHARE_RATE = (30, 600)  # 한 클라이언트(IP)당 600초에 30개까지 (넘으면 429)


def find_arxiv_id(*texts: str) -> str | None:
    """공유된 제목·글·URL에서 arXiv id 찾기 (앞의 인자 우선, 확실한 형태 우선)"""
    for t in texts:
        m = t and STRONG_RE.search(t)
        if m:
            return m.group(1)
    for t in texts:
        aid = t and core.parse_arxiv_id(t)
        if aid:
            return aid
    return None


def _to_paper(rest: str) -> RedirectResponse:
    aid = core.parse_arxiv_id(rest or "")
    if not aid:
        # 오류는 홈의 ?err= 칸에서 보여 줌 (docs/FEATURES.md §8 entry-routes)
        return RedirectResponse("/?" + urlencode({"err": "noid", "q": (rest or "")[:200]}), 307)
    return RedirectResponse(f"/paper/{aid}", 307)


# arxiv.org 주소의 호스트만 바꿔도 열림: /abs/2401.04088v2, /pdf/2401.04088.pdf, /html/2401.04088v1
@router.get("/abs/{rest:path}")
async def from_abs(rest: str):
    return _to_paper(rest)


@router.get("/pdf/{rest:path}")
async def from_pdf(rest: str):
    return _to_paper(rest)


@router.get("/html/{rest:path}")
async def from_html(rest: str):
    return _to_paper(rest)


# PWA 공유 타깃 (manifest share_target: GET /share?title=&text=&url=) · 북마클릿 (/share?url=)
@router.get("/share")
async def share_target(title: str = "", text: str = "", url: str = ""):
    aid = find_arxiv_id(url, text, title)
    if aid:
        return RedirectResponse(f"/paper/{aid}", 307)
    got = " ".join(x for x in (url, text, title) if x).strip()[:200]
    return RedirectResponse("/?" + urlencode({"err": "noid", **({"q": got} if got else {})}), 307)


# ---------- HTML 없는 논문: arXiv API 초록 페이지 ----------
async def abstract_meta(aid: str) -> dict | None:
    path = core.task_path(aid, "entry-routes.abs")
    hit = core.read_json(path)
    if isinstance(hit, dict):
        age = time.time() - hit.get("ts", 0)
        if hit.get("missing"):
            if age < ABS_MISS_TTL:
                return None
            hit = None
        elif age < ABS_TTL:
            return hit

    async def fetch():
        try:
            entries = await core.arxiv_query(id_list=[aid], max_results=1, timeout=8)
        except (httpx.HTTPError, ValueError):
            return hit if isinstance(hit, dict) else None  # 망 실패면 오래된 캐시라도
        base = re.sub(r"v\d+$", "", aid)
        entry = next((e for e in entries if e["id"] == base), None)
        if not entry:
            core.write_json(path, {"missing": True, "ts": int(time.time())})
            return None
        value = {**entry, "ts": int(time.time())}
        core.write_json(path, value)
        return value

    return await core.singleflight(("entry-routes.abs", aid), fetch)


def _authors(names: list[str], n: int = 8) -> str:
    names = [x for x in names if x]
    return ", ".join(names[:n]) + (f" 외 {len(names) - n}명" if len(names) > n else "")


def abstract_html(aid: str, meta: dict) -> str:
    e = core.html_escape
    abs_url, pdf_url = f"https://arxiv.org/abs/{aid}", f"https://arxiv.org/pdf/{aid}"
    info = " · ".join(x for x in (
        f"arXiv:{meta.get('id', aid)}{meta.get('version', '')}",
        (meta.get("published") or "")[:10],
        meta.get("primary_category") or "",
    ) if x)
    comment = f'<p class="er-abs-comment">{e(meta["comment"])}</p>' if meta.get("comment") else ""
    doi = f'<p class="er-abs-comment">DOI: {e(meta["doi"])}</p>' if meta.get("doi") else ""
    data = e(json.dumps({"id": meta.get("id", aid), "title": meta.get("title", ""), "authors": meta.get("authors", [])[:20]},
                        ensure_ascii=False))
    return f"""<article class="er-abs" data-er="{data}">
<p class="er-abs-note">이 논문은 아직 HTML 버전이 없어 초록만 보여 드려요. arXiv가 변환 중이거나 변환에 실패한 논문일 수 있어요.</p>
<h1 class="er-abs-title">{e(meta.get("title") or aid)}</h1>
<p class="er-abs-authors">{e(_authors(meta.get("authors") or []))}</p>
<p class="er-abs-meta">{e(info)}</p>
<div class="er-abs-actions">
<a class="er-btn er-primary" href="{e(pdf_url)}" target="_blank" rel="noopener">PDF 열기</a>
<a class="er-btn" href="{e(abs_url)}" target="_blank" rel="noopener">arXiv 페이지</a>
<a class="er-btn" href="/paper/{e(aid)}">다시 시도</a>
</div>
<h2>초록</h2>
<p class="er-abs-summary">{e(meta.get("summary") or "")}</p>
{comment}{doi}
<p><a href="/">← 홈으로</a></p>
</article>"""


@core.on_paper_missing
async def abstract_page(request: Request, arxiv_id: str):
    aid = core.parse_arxiv_id(arxiv_id or "")
    if not aid:
        return None  # 기본 404 페이지
    if aid != arxiv_id:  # /paper/2401.04088.pdf 같은 주소 → 번호만
        return RedirectResponse(f"/paper/{aid}", 307)
    meta = await abstract_meta(aid)
    if not meta:
        return None
    return core.render_page(request, meta.get("title") or aid, abstract_html(aid, meta), page="abstract", arxiv_id=aid)


# ---------- 하이라이트·메모 공유 (계정 없음: 무작위 id로 디스크에 저장, 읽기 전용) ----------
_LONE_SURROGATE = re.compile("[\ud800-\udfff]")


def _no_surrogates(v):
    # JSON의 짝 없는 '\ud83d' (JS가 이모지 중간에서 자른 글) → 빼고 받음: UTF-8로 쓸 수 없어 저장이 500으로 끝남.
    # 길이 검사 전에 (반쪽만 있던 인용은 빈 글 → 422)
    return _LONE_SURROGATE.sub("", v) if isinstance(v, str) else v


Text = Annotated[str, BeforeValidator(_no_surrogates)]


class ShareItem(BaseModel):
    quote: Text = Field(min_length=1, max_length=1000)
    prefix: Text = Field("", max_length=200)
    suffix: Text = Field("", max_length=200)
    color: str = Field("", pattern=r"^[a-z]{0,16}$")
    note: Text = Field("", max_length=4000)
    q: Text = Field("", max_length=1000)  # 저장된 Q&A (받는 쪽은 글자 그대로만 보여 줌)
    a: Text = Field("", max_length=8000)


class ShareBody(BaseModel):
    arxiv_id: str = Field(max_length=40)
    title: Text = Field("", max_length=300)
    items: list[ShareItem] = Field(min_length=1, max_length=200)


def share_path(sid: str):
    return core.task_path(sid, "entry-routes.share")


# 공유 파일 전체 크기: 폴더를 한 번 훑어 기억해 두고 쓸 때마다 더함 (5분마다·폴더가 바뀌면 다시 훑음)
_disk = {"dir": None, "bytes": 0, "ts": 0.0}
_hits: dict[str, list[float]] = {}


def _share_files():
    return core.CACHE_DIR.glob("*.entry-routes.share.json")


def share_disk_bytes(now: float) -> int:
    if _disk["dir"] != core.CACHE_DIR or now - _disk["ts"] > 300:
        total = 0
        for p in _share_files():
            with contextlib.suppress(OSError):
                total += p.stat().st_size
        _disk.update(dir=core.CACHE_DIR, bytes=total, ts=now)
    return _disk["bytes"]


def prune_shares(now: float) -> None:
    for p in _share_files():
        with contextlib.suppress(OSError):
            if now - p.stat().st_mtime > SHARE_KEEP:
                p.unlink()
    _disk["dir"] = None  # 다음 확인 때 다시 훑음


def rate_ok(client: str, now: float) -> bool:
    limit, window = SHARE_RATE
    if len(_hits) > 10_000:
        _hits.clear()
    recent = [t for t in _hits.get(client, []) if now - t < window]
    if len(recent) >= limit:
        _hits[client] = recent
        return False
    _hits[client] = [*recent, now]
    return True


@router.post("/api/entry-routes/share")
async def create_share(body: ShareBody, request: Request):
    aid = core.parse_arxiv_id(body.arxiv_id)
    if not aid or aid != body.arxiv_id:
        raise HTTPException(400, "arXiv ID가 올바르지 않습니다.")
    now = time.time()
    rec = {"arxiv_id": aid, "title": body.title, "items": [i.model_dump() for i in body.items], "ts": int(now)}
    size = len(json.dumps(rec, ensure_ascii=False).encode())
    if size > SHARE_MAX:
        raise HTTPException(413, "공유할 내용이 너무 많습니다.")
    if not rate_ok(request.client.host if request.client else "", now):
        raise HTTPException(429, "공유 링크를 너무 자주 만들었습니다. 잠시 뒤에 다시 해 주세요.")
    if share_disk_bytes(now) + size > SHARE_DISK_MAX:
        prune_shares(now)
        if share_disk_bytes(now) + size > SHARE_DISK_MAX:
            raise HTTPException(507, "공유 저장 공간이 가득 찼습니다.")
    sid = secrets.token_urlsafe(9)
    while share_path(sid).exists():
        sid = secrets.token_urlsafe(9)
    core.write_json(share_path(sid), rec)
    _disk["bytes"] += size
    return {"id": sid, "url": f"/paper/{aid}#s={sid}"}


@router.get("/api/entry-routes/share/{sid}")
async def read_share(sid: str):
    if not SHARE_ID_RE.fullmatch(sid):
        raise HTTPException(404, "공유를 찾을 수 없습니다.")
    rec = core.read_json(share_path(sid))
    if not isinstance(rec, dict):
        raise HTTPException(404, "공유를 찾을 수 없습니다.")
    return core.offline_json(rec)  # 바뀌지 않는 기록 → 오프라인에서도
