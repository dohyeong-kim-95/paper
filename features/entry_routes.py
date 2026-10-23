"""entry-routes: arXiv 주소 그대로 열기(/abs·/pdf·/html), 공유 타깃(/share), HTML 없는 논문의 초록 페이지,
하이라이트·메모 공유 링크 (POST /api/entry-routes/share → /paper/<id>#s=<공유 id>)"""
import json
import re
import secrets
import time
from urllib.parse import urlencode

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, Field

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
SHARE_MAX = 300_000  # 공유 하나의 최대 크기 (바이트)


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
    if isinstance(hit, dict) and time.time() - hit.get("ts", 0) < ABS_TTL:
        return hit

    async def fetch():
        try:
            entries = await core.arxiv_query(id_list=[aid], max_results=1, timeout=8)
        except (httpx.HTTPError, ValueError):
            return hit if isinstance(hit, dict) else None  # 망 실패면 오래된 캐시라도
        base = re.sub(r"v\d+$", "", aid)
        entry = next((e for e in entries if e["id"] == base), None)
        if not entry:
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
class ShareItem(BaseModel):
    quote: str = Field(min_length=1, max_length=1000)
    prefix: str = Field("", max_length=200)
    suffix: str = Field("", max_length=200)
    color: str = Field("", pattern=r"^[a-z]{0,16}$")
    note: str = Field("", max_length=4000)
    q: str = Field("", max_length=1000)  # 저장된 Q&A (읽기 전용으로만 보여 줌)
    a: str = Field("", max_length=8000)


class ShareBody(BaseModel):
    arxiv_id: str = Field(max_length=40)
    title: str = Field("", max_length=300)
    items: list[ShareItem] = Field(min_length=1, max_length=200)


def share_path(sid: str):
    return core.task_path(sid, "entry-routes.share")


@router.post("/api/entry-routes/share")
async def create_share(body: ShareBody):
    aid = core.parse_arxiv_id(body.arxiv_id)
    if not aid or aid != body.arxiv_id:
        raise HTTPException(400, "arXiv ID가 올바르지 않습니다.")
    rec = {"arxiv_id": aid, "title": body.title, "items": [i.model_dump() for i in body.items], "ts": int(time.time())}
    if len(json.dumps(rec, ensure_ascii=False).encode()) > SHARE_MAX:
        raise HTTPException(413, "공유할 내용이 너무 많습니다.")
    sid = secrets.token_urlsafe(9)
    while share_path(sid).exists():
        sid = secrets.token_urlsafe(9)
    core.write_json(share_path(sid), rec)
    return {"id": sid, "url": f"/paper/{aid}#s={sid}"}


@router.get("/api/entry-routes/share/{sid}")
async def read_share(sid: str):
    if not SHARE_ID_RE.fullmatch(sid):
        raise HTTPException(404, "공유를 찾을 수 없습니다.")
    rec = core.read_json(share_path(sid))
    if not isinstance(rec, dict):
        raise HTTPException(404, "공유를 찾을 수 없습니다.")
    return core.offline_json(rec)  # 바뀌지 않는 기록 → 오프라인에서도
