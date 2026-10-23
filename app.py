import json
import re
from pathlib import Path
from typing import Literal

import anthropic
import httpx
from bs4 import BeautifulSoup
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, RedirectResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel

MODEL = "claude-haiku-5-5"
SYSTEM_PROMPT = (
    "You are a reading assistant helping a user read an academic paper on a phone. "
    "The full paper is given below. The user highlights a passage and asks about it. "
    "Answer in Korean, concisely (a few short paragraphs at most), in plain text. "
    "Write math as plain LaTeX inline like $x^2$. Explain jargon simply when relevant."
)

app = FastAPI()
app.mount("/static", StaticFiles(directory="static"), name="static")
templates = Jinja2Templates(directory="templates")
client = anthropic.AsyncAnthropic()  # ANTHROPIC_API_KEY 환경변수 사용
http = httpx.AsyncClient(follow_redirects=True, timeout=30)

papers: dict[str, dict] = {}  # arxiv_id -> {"title", "html", "text"}
CACHE_DIR = Path("cache")  # 정리된 논문을 JSON으로 디스크에 저장
# arXiv HTML이 없으면 ar5iv(같은 LaTeXML 출력)로 대체
SOURCES = ["https://arxiv.org/html/{}", "https://ar5iv.labs.arxiv.org/html/{}"]


def parse_arxiv_id(s: str) -> str | None:
    m = re.search(r"(\d{4}\.\d{4,5}(v\d+)?)", s)
    return m.group(1) if m else None


def clean_article(raw: str, base_url: str) -> dict:
    soup = BeautifulSoup(raw, "html.parser")
    article = soup.find("article") or soup.body
    title_el = article.find(class_="ltx_title_document") or soup.title
    title = title_el.get_text(" ", strip=True) if title_el else "Untitled"
    # arXiv HTML의 이미지는 /html/<id>v<n>/ 기준 상대경로
    base_tag = soup.find("base", href=True)
    base_url = str(httpx.URL(base_url).join(base_tag["href"])) if base_tag else base_url.rstrip("/") + "/"

    for el in article.select("script, style, .ltx_page_footer, .ar5iv-footer, .ltx_role_footnote button"):
        el.decompose()
    # 이미지/링크를 절대경로로
    for img in article.find_all("img"):
        if img.get("src"):
            img["src"] = str(httpx.URL(base_url).join(img["src"]))
            img["loading"] = "lazy"
    for a in article.find_all("a", href=True):
        if not a["href"].startswith("#"):
            a["href"] = str(httpx.URL(base_url).join(a["href"]))

    html = str(article)

    # LLM용 텍스트: 수식은 LaTeX(alttext)로 치환
    text_soup = BeautifulSoup(html, "html.parser")
    for math in text_soup.find_all("math"):
        math.replace_with(f" ${math.get('alttext', '')}$ ")
    text = re.sub(r"\n\s*\n+", "\n\n", text_soup.get_text("\n"))
    return {"title": title, "html": html, "text": text}


def system_blocks(paper: dict) -> list[dict]:
    return [
        {"type": "text", "text": SYSTEM_PROMPT},
        {
            "type": "text",
            "text": f"<paper>\n{paper['text']}\n</paper>",
            "cache_control": {"type": "ephemeral"},
        },
    ]


REQUEST_OPTS = dict(
    model=MODEL,
    thinking={"type": "disabled"},  # 반응성 우선
    output_config={"effort": "low"},
)


async def prewarm(paper: dict):
    # 논문 본문을 미리 캐시해서 첫 질문도 빠르게
    try:
        await client.messages.create(
            **REQUEST_OPTS,
            max_tokens=0,
            system=system_blocks(paper),
            messages=[{"role": "user", "content": "warmup"}],
        )
    except anthropic.APIError as e:
        print("prewarm failed:", e)


async def fetch_paper(arxiv_id: str) -> dict:
    for src in SOURCES:
        try:
            r = await http.get(src.format(arxiv_id))
        except httpx.HTTPError:
            continue
        if r.status_code == 200 and "ltx_document" in r.text:
            return clean_article(r.text, str(r.url))
    raise HTTPException(404, "이 논문은 HTML 버전이 없습니다 (arXiv, ar5iv 모두 실패).")


async def get_paper(arxiv_id: str) -> dict:
    if arxiv_id in papers:
        return papers[arxiv_id]
    # 파일명에 쓸 수 없는 문자 제거 (ID 예: 2401.04088v2)
    path = CACHE_DIR / (re.sub(r"[^\w.-]", "_", arxiv_id) + ".json")
    try:
        paper = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):  # 캐시 없음/손상 -> 새로 받기
        paper = await fetch_paper(arxiv_id)
        CACHE_DIR.mkdir(exist_ok=True)
        path.write_text(json.dumps(paper, ensure_ascii=False), encoding="utf-8")
    papers[arxiv_id] = paper
    return paper


@app.get("/")
async def home(request: Request):
    return templates.TemplateResponse(request, "index.html")


@app.get("/sw.js")
async def service_worker():
    # 서비스워커는 루트 경로에서 서빙해야 전체 페이지를 제어할 수 있음
    return FileResponse("static/sw.js", media_type="text/javascript")


@app.get("/open")
async def open_paper(q: str):
    arxiv_id = parse_arxiv_id(q)
    if not arxiv_id:
        raise HTTPException(400, "arXiv ID를 찾을 수 없습니다.")
    return RedirectResponse(f"/paper/{arxiv_id}")


@app.get("/paper/{arxiv_id}")
async def read_paper(request: Request, arxiv_id: str):
    paper = await get_paper(arxiv_id)
    return templates.TemplateResponse(
        request, "paper.html", {"paper": paper, "arxiv_id": arxiv_id}
    )


@app.post("/api/prewarm/{arxiv_id}")
async def api_prewarm(arxiv_id: str):
    await prewarm(await get_paper(arxiv_id))
    return {"ok": True}


class Turn(BaseModel):
    role: Literal["user", "assistant"]
    content: str


class Ask(BaseModel):
    arxiv_id: str
    selection: str = ""
    question: str
    history: list[Turn] = []  # 같은 시트에서 이어지는 이전 대화


@app.post("/api/ask")
async def ask(body: Ask):
    paper = await get_paper(body.arxiv_id)
    messages = [t.model_dump() for t in body.history]
    messages.append({"role": "user", "content": body.question})
    # 하이라이트는 첫 user 턴에만 (매 요청 같은 바이트 → 대화 앞부분 캐시 적중)
    if body.selection:
        first = messages[0]
        first["content"] = f"<highlight>\n{body.selection}\n</highlight>\n\n{first['content']}"

    async def gen():
        try:
            async with client.messages.stream(
                **REQUEST_OPTS,
                max_tokens=4000,
                system=system_blocks(paper),
                messages=messages,
                cache_control={"type": "ephemeral"},  # 늘어나는 대화 꼬리도 자동 캐시
            ) as stream:
                async for text in stream.text_stream:
                    yield text
        except anthropic.APIError as e:
            yield f"\n\n[오류] {e}"

    return StreamingResponse(gen(), media_type="text/plain; charset=utf-8")
