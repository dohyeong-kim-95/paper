"""overview: 한눈에 보기 (3줄 요약 + 핵심 질문 + 스냅샷), 방법론 자세히, 논문 메타(arXiv), 제목 이름으로 PDF 저장"""
import re
import time
from urllib.parse import quote

import httpx
from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse, Response

import app as core

router = APIRouter()

OVERVIEW = "overview.v1"
METHOD = "overview.method.v1"
OVERVIEW_TOKENS = 2500
METHOD_TOKENS = 3000
META_TTL = 86400  # arXiv 메타(버전·날짜)는 하루 캐시
PDF_HOSTS = {"arxiv.org", "www.arxiv.org", "export.arxiv.org"}
PDF_MAX = 60_000_000

QUOTE_RULE = ("→ 줄: 바로 위 답의 근거가 되는 논문 본문(초록 포함)의 영어 원문을 6~15단어 글자 그대로 복사해 "
              "큰따옴표로 감쌀 것. 수식·인용 번호·각주가 없는 구간을 고르고, 바꾸어 쓰거나 줄이지 말 것.")


def figure_list(idx: dict) -> str:
    # 모델은 본문 텍스트만 보므로 그림 id를 목록으로 알려 줌 ([[fig:id]] 토큰용)
    figs = [f for f in idx["figures"] if f["top"] and f["kind"] in ("figure", "table")][:30]
    return "\n".join(f"- {f['id']}: {f['caption'][:100]}" for f in figs)


def overview_prompt(idx: dict) -> str:
    figs = figure_list(idx)
    code = idx["code_links"][:3]
    code_rule = (f"논문에 실린 저장소 링크 {', '.join(code)} 를 그대로" if code
                 else "본문에 코드 저장소 URL이 그대로 있을 때만 그 URL, 없으면 '없음' (추측 금지)")
    fig_slot = "\n(아래 그림 목록에 이 아이디어를 가장 잘 보여 주는 그림이 있으면 이 자리에 [[fig:그림id]] 한 줄, 없으면 생략)" if figs else ""
    fig_tail = f"\n\n그림 목록 (id: 캡션):\n{figs}" if figs else ""
    return f"""이 논문을 처음 여는 한국어 독자가 읽을지, 어디부터 읽을지 빨리 정하도록 '한눈에 보기'를 쓰세요.
아래 Markdown 형식을 그대로 따르고, 형식 밖의 말(인사·설명·코드 펜스)은 쓰지 마세요.

## 3줄 요약
- (무엇을 했나: 한 문장)
- (어떻게: 핵심 방법 한 문장)
- (그래서: 주요 결과 한 문장, 가능하면 수치)

## 핵심 질문
### 무엇을 풀려고 하나?
(2~3문장)
→ "(근거 원문)"
### 핵심 아이디어는?
(2~3문장)
→ "(근거 원문)"{fig_slot}
### 어떻게 검증했나?
(2~3문장)
→ "(근거 원문)"
### 결과는?
(2~3문장)
→ "(근거 원문)"
### 한계와 남은 문제는?
(2~3문장)
→ "(근거 원문)"

## 스냅샷
| 항목 | 내용 |
|---|---|
| 과제 | |
| 데이터셋 | |
| 평가지표 | |
| 비교 대상 | |
| 주요 수치 | |
| 코드 | |

규칙:
- 각 질문의 답은 쉬운 한국어 2~3문장. 전문용어는 처음 한 번만 영어를 괄호로 병기.
- 수치·데이터셋·비교 대상은 논문에 있는 것만. 논문에 없으면 지어내지 말고 '논문에 언급 없음'.
- {QUOTE_RULE} 질문마다 정확히 한 줄.
- 스냅샷 칸은 짧게(구·숫자). 주요 수치는 가장 중요한 결과 1~2개.
- 코드 칸: {code_rule}.{fig_tail}"""


def method_prompt(idx: dict) -> str:
    figs = figure_list(idx)
    fig_rule = ("\n- 방법을 보여 주는 그림이 아래 목록에 있으면 알맞은 절 끝에 [[fig:그림id]] 한 줄 (최대 2개, 없으면 생략)."
                f"\n\n그림 목록 (id: 캡션):\n{figs}") if figs else ""
    return f"""이 논문의 핵심 방법론을 한국어로 반 페이지 정도로 자세히 설명하세요.
아래 Markdown 형식을 그대로 따르고, 형식 밖의 말(인사·설명·코드 펜스)은 쓰지 마세요.

### 한 줄 요약
(방법을 한 문장으로)

### 단계별 설명
1. **(단계 이름)**: (무엇을 받아 무엇을 하는지 1~3문장)
2. ...
(3~6단계, 논문의 실제 절차 순서대로)
→ "(가장 중요한 단계의 근거 원문)"

### 핵심 수식
$$(논문의 가장 중요한 수식, LaTeX)$$
- (각 기호의 뜻과 이 수식이 하는 일, 한두 문장)

### 왜 동작하나
(직관 2~3문장)

규칙:
- 핵심 수식은 1~3개. 논문의 수식을 그대로 LaTeX로 옮겨 $$ … $$ 로 감쌀 것. 논문에 수식이 없으면 '논문에 핵심 수식 없음'.
- {QUOTE_RULE} 2줄까지.
- 논문에 없는 내용은 지어내지 말 것.{fig_rule}"""


async def stream_artifact(arxiv_id: str, name: str, build, max_tokens: int, retry: bool = False):
    # 디스크 적중이면 프롬프트(색인 파싱)가 필요 없음. 손상된 캐시는 cached_stream이 다시 생성하므로 그때는 만듦
    hit = core.read_json(core.task_path(arxiv_id, name))
    prompt = "" if isinstance(hit, str) else build(await core.paper_index(arxiv_id))
    return await core.cached_stream(arxiv_id, name, prompt, max_tokens, retry=retry)


@router.get("/api/overview/{arxiv_id}")
async def overview(arxiv_id: str, retry: bool = False):
    return await stream_artifact(arxiv_id, OVERVIEW, overview_prompt, OVERVIEW_TOKENS, retry)


@router.get("/api/overview/{arxiv_id}/method")
async def method(arxiv_id: str, retry: bool = False):
    return await stream_artifact(arxiv_id, METHOD, method_prompt, METHOD_TOKENS, retry)


@core.on_prewarm
async def prewarm_overview(arxiv_id: str):
    # 논문을 열면 서버에서 바로 생성 시작 (응답 본문은 안 읽어도 백그라운드 Task가 끝까지 돌고 저장)
    try:
        await stream_artifact(arxiv_id, OVERVIEW, overview_prompt, OVERVIEW_TOKENS)
    except HTTPException:
        pass  # 기억된 실패(502)·HTML 없음(404): 화면의 '다시'로


# ---------- 메타 (arXiv API: 버전·제출일·분야) ----------
def base_id(arxiv_id: str) -> str:
    aid = core.parse_arxiv_id(arxiv_id)
    if not aid:
        raise HTTPException(400, "arXiv ID가 아닙니다.")
    return re.sub(r"v\d+$", "", aid)


def pick_meta(e: dict) -> dict:
    keep = ("id", "version", "title", "published", "updated", "primary_category", "categories", "doi", "comment",
            "abs_url", "pdf_url")
    return {k: e.get(k) for k in keep}


@router.get("/api/overview/{arxiv_id}/meta")
async def meta(arxiv_id: str):
    bid = base_id(arxiv_id)
    path = core.task_path(bid, "overview.meta")
    hit = core.read_json(path)
    old = hit.get("meta") if isinstance(hit, dict) and isinstance(hit.get("meta"), dict) else None
    if old and time.time() - hit.get("ts", 0) < META_TTL:
        return core.offline_json(old)
    try:
        entry = next((e for e in await core.arxiv_query(id_list=[bid], max_results=1) if e["id"] == bid), None)
    except (httpx.HTTPError, ValueError):
        entry = None
    if entry is None:  # 네트워크·arXiv 실패: 옛 캐시라도, 없으면 id만 (저장 안 함)
        return core.offline_json(old) if old else JSONResponse({"id": bid})
    data = pick_meta(entry)
    core.write_json(path, {"ts": time.time(), "meta": data})
    return core.offline_json(data)


# ---------- 제목 이름으로 PDF 저장 (arxiv.org/pdf/<id>만 받아 그대로 넘김) ----------
def pdf_filename(title: str, arxiv_id: str) -> str:
    name = re.sub(r'[\\/:*?"<>|\x00-\x1f]+', " ", title or "")
    name = re.sub(r"\s+", " ", name).strip(" .")[:120].rstrip(" .")
    return f"{name or arxiv_id}.pdf"


def content_disposition(filename: str) -> str:
    ascii_name = re.sub(r'[^\x20-\x7e]|["\\]', "_", filename)
    return f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(filename)}"


@router.get("/api/overview/{arxiv_id}/pdf")
async def pdf(arxiv_id: str):
    aid = core.parse_arxiv_id(arxiv_id)
    if not aid:
        raise HTTPException(400, "arXiv ID가 아닙니다.")
    try:
        r = await core.http.get(f"https://arxiv.org/pdf/{aid}", timeout=60)
    except httpx.HTTPError as e:
        raise HTTPException(502, "PDF를 받지 못했습니다.") from e
    if (r.status_code != 200 or r.url.host not in PDF_HOSTS or not r.content.startswith(b"%PDF")
            or len(r.content) > PDF_MAX):
        raise HTTPException(502, "PDF를 받지 못했습니다.")
    # 제목은 이미 받아 둔 논문에서만 (PDF 저장 때문에 HTML을 새로 받지 않음)
    paper = core.papers.get(arxiv_id) or core.read_json(core.paper_path(arxiv_id)) or {}
    title = paper.get("title", "") if isinstance(paper, dict) else ""
    return Response(r.content, media_type="application/pdf",
                    headers={"Content-Disposition": content_disposition(pdf_filename(title, aid))})
