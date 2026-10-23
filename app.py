import asyncio
import contextlib
import hashlib
import importlib
import json
import logging
import os
import re
import tempfile
import time
import xml.etree.ElementTree as ET
from collections import OrderedDict
from html import escape as html_escape  # noqa: F401 - 기능용 (core.render_page 본문 이스케이프)
from pathlib import Path
from typing import Literal

import anthropic
import httpx
from bs4 import BeautifulSoup, Comment, NavigableString
from bs4.element import PreformattedString  # CData·ProcessingInstruction·Declaration·Doctype·Comment의 부모
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel, Field

log = logging.getLogger("paper")

MODEL = "claude-haiku-5-5"
SYSTEM_PROMPT = (
    "You are a reading assistant helping a user read an academic paper on a phone. "
    "The full paper is given below. The user highlights a passage and asks about it. "
    "Answer in Korean, concisely (a few short paragraphs at most), in Markdown. "
    "Write math as plain LaTeX inline like $x^2$. Explain jargon simply when relevant."
)
# 긴 작업·JSON 작업은 이 문장을 user 메시지 앞에 붙임 (system은 그대로 → 논문 캐시 공유)
TASK_PREAMBLE = "이 요청에서는 위 시스템 지시의 간결성·Markdown 규칙 대신 아래 출력 형식만 정확히 따르세요. 생략·요약 금지."

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"

app = FastAPI()
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
templates = Jinja2Templates(directory=BASE_DIR / "templates")
client = anthropic.AsyncAnthropic()  # ANTHROPIC_API_KEY 환경변수 사용
http = httpx.AsyncClient(follow_redirects=True, timeout=30)

papers: dict[str, dict] = {}  # arxiv_id -> {"title", "html", "text"}
CACHE_DIR = Path("cache")  # 정리된 논문·작업 결과를 JSON으로 디스크에 저장 (항상 호출 시점에 읽음)
# arXiv HTML이 없으면 ar5iv(같은 LaTeXML 출력)로 대체
SOURCES = ["https://arxiv.org/html/{}", "https://ar5iv.labs.arxiv.org/html/{}"]
TEXT = "text/plain; charset=utf-8"
OFFLINE_HEADERS = {"X-Offline-Cacheable": "1"}  # 이 헤더가 붙은 GET /api/* 응답은 sw.js가 오프라인용으로 저장
MISSING = object()


def parse_arxiv_id(s: str) -> str | None:
    m = re.search(r"(\d{4}\.\d{4,5}(v\d+)?)", s)
    return m.group(1) if m else None


CLEAN_VERSION = 3  # clean_article 규칙이 바뀌면 올림 → 디스크 캐시의 옛 논문도 읽을 때 다시 정리
UNSAFE_TAGS = ("iframe", "frame", "frameset", "object", "embed", "applet", "form", "base", "meta", "link",
               "animate", "set", "animatemotion", "animatetransform", "portal")
URL_ATTRS = ("href", "src", "xlink:href", "action", "formaction", "poster", "background")


def _safe_url(value: str, tag: str, attr: str) -> bool:
    # 브라우저처럼 공백·제어문자를 지우고 scheme 검사 ("java\nscript:" 우회 방지)
    v = re.sub(r"[\x00-\x20\x7f]+", "", value or "").lower()
    if v.startswith(("#", "http://", "https://", "//")) or (attr == "href" and v.startswith("mailto:")):
        return True
    if tag == "img" and attr == "src" and v.startswith("data:image/"):
        return True
    return not re.match(r"^[a-z][a-z0-9+.-]*:", v)  # scheme 없는 상대 경로만


def sanitize_article(article) -> None:
    """논문 HTML은 | safe 로 그대로 넣으므로 스크립트가 될 수 있는 것은 모두 제거 (on* 속성, javascript: 등)"""
    # 요소가 아닌 마크업(CDATA·처리 지시·선언·doctype·주석)은 bs4가 원문 그대로 다시 씀. 브라우저는 HTML 본문의
    # '<![CDATA[' 등을 첫 '>'에서 끝나는 가짜 주석으로 읽으므로 파서가 글자로 본 '<img onerror>'가 살아남 → 모두 제거
    for node in article.find_all(string=lambda s: isinstance(s, PreformattedString)):
        node.extract()
    for el in article.find_all(UNSAFE_TAGS):
        el.decompose()
    for el in article.find_all(True):
        for attr in list(el.attrs):
            name = attr.lower()
            if name.startswith("on") or name == "srcdoc":
                del el[attr]
            elif name in URL_ATTRS and not _safe_url(str(el.get(attr)), el.name, name):
                del el[attr]


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
            with contextlib.suppress(Exception):
                a["href"] = str(httpx.URL(base_url).join(a["href"]))
    sanitize_article(article)

    html = str(article)

    # LLM용 텍스트: 수식은 LaTeX(alttext)로 치환
    text_soup = BeautifulSoup(html, "html.parser")
    for math in text_soup.find_all("math"):
        math.replace_with(f" ${math.get('alttext', '')}$ ")
    text = re.sub(r"\n\s*\n+", "\n\n", text_soup.get_text("\n"))
    return {"title": title, "html": html, "text": text, "v": CLEAN_VERSION}


# ---------- Claude 공용: 모든 호출은 system/REQUEST_OPTS가 같아야 논문 캐시를 공유함 ----------
# 규칙: system·REQUEST_OPTS는 절대 바꾸지 말 것. output_config.format(structured outputs)도 쓰지 말 것
# (형식 지시가 주입돼 캐시 앞부분이 달라짐). JSON이 필요하면 user 프롬프트에서 요청하고 parse_json_loose로 읽기.
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


def user_turn(prompt: str, preamble: bool = True) -> dict:
    return {"role": "user", "content": f"{TASK_PREAMBLE}\n\n{prompt}" if preamble else prompt}


def message_text(msg) -> str:
    return "".join(b.text for b in msg.content if getattr(b, "type", "") == "text")


async def claude_create(paper: dict, messages: list, max_tokens: int):
    # 일회성 작업용 단일 통로. top-level cache_control 없음 (system 표시가 유일한 캐시 지점)
    return await client.messages.create(
        **REQUEST_OPTS, max_tokens=max_tokens, system=system_blocks(paper), messages=messages
    )


async def complete_text(paper: dict, prompt: str | None = None, max_tokens: int = 1500,
                        *, messages: list | None = None, preamble: bool = True) -> str:
    """비스트리밍 호출. 실패·max_tokens 잘림은 HTTPException(502)"""
    msgs = messages if messages is not None else [user_turn(prompt or "", preamble)]
    try:
        msg = await claude_create(paper, msgs, max_tokens)
    except anthropic.APIError as e:
        raise HTTPException(502, f"Claude 호출 실패: {e}") from e
    if msg.stop_reason == "max_tokens":
        raise HTTPException(502, "응답이 너무 길어 잘렸습니다 (max_tokens).")
    return message_text(msg)


def stream_claude(paper: dict, messages: list, max_tokens: int = 4000) -> StreamingResponse:
    async def gen():
        try:
            async with client.messages.stream(
                **REQUEST_OPTS,
                max_tokens=max_tokens,
                system=system_blocks(paper),
                messages=messages,
                cache_control={"type": "ephemeral"},  # 늘어나는 대화 꼬리도 자동 캐시
            ) as stream:
                async for text in stream.text_stream:
                    yield text
                final = await stream.get_final_message()
            if final.stop_reason == "max_tokens":
                yield error_tail("응답이 너무 길어 잘렸습니다 (max_tokens).")
        except anthropic.APIError as e:
            yield error_tail(e)  # 한 줄로 (여러 줄 오류 본문이면 클라이언트 ERROR_TAIL이 못 알아봄)
        except Exception as e:  # noqa: BLE001 - 어떤 실패든 [오류] 꼬리로 끝내서 성공한 답으로 저장되지 않게
            log.exception("stream_claude failed")
            yield error_tail(type(e).__name__)

    return StreamingResponse(gen(), media_type=TEXT, headers={"Cache-Control": "no-store"})


def build_first_turn(selection: str, context: str, question: str, section: str = "") -> str:
    parts = []
    if selection:
        parts.append(f"<highlight>\n{selection}\n</highlight>")
    if context or section:
        inner = (f"<section>{section}</section>\n" if section else "") + context
        parts.append(f"<context>\n{inner.rstrip()}\n</context>")
    return "\n".join(parts) + "\n\n" + question if parts else question


def mark_cache(messages: list, index: int = -1) -> list:
    # 해당 턴 끝에 캐시 지점 (문자열 내용과 같은 바이트로 렌더링됨)
    m = messages[index]
    if isinstance(m["content"], str):
        m["content"] = [{"type": "text", "text": m["content"]}]
    m["content"][-1]["cache_control"] = {"type": "ephemeral"}
    return messages


# ---------- 디스크 캐시 / 파싱 ----------
def safe_id(s: str) -> str:
    # 파일명에 쓸 수 없는 문자 제거 (ID 예: 2401.04088v2)
    return re.sub(r"[^\w.-]", "_", s)[:120]


def paper_path(arxiv_id: str) -> Path:
    return CACHE_DIR / f"{safe_id(arxiv_id)}.json"


def task_path(arxiv_id: str, name: str) -> Path:
    return CACHE_DIR / f"{safe_id(arxiv_id)}.{safe_id(name)}.json"


def read_json(path: Path, default=None):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def write_json(path: Path, obj) -> None:
    # 원자적 쓰기: 임시 파일 → os.replace (중간에 죽어도 깨진 파일 없음)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=path.name, suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(obj, f, ensure_ascii=False)
        os.replace(tmp, path)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(tmp)
        raise


def update_json(path: Path, fn, default=None):
    # 읽기-수정-쓰기. await 없이 실행되므로 한 프로세스 안에서는 원자적
    value = fn(read_json(path, default))
    write_json(path, value)
    return value


def parse_json_loose(text: str):
    """``` 펜스·앞뒤 잡담을 걷어내고 JSON 파싱. 실패하면 ValueError"""
    candidates = [m.group(1) for m in re.finditer(r"```[a-zA-Z]*\s*([\s\S]*?)```", text)]
    starts = [i for i in (text.find("["), text.find("{")) if i >= 0]
    if starts:
        candidates.append(text[min(starts): max(text.rfind("]"), text.rfind("}")) + 1])
    for c in candidates:
        with contextlib.suppress(ValueError):
            return json.loads(c.strip())
    raise ValueError("JSON을 찾을 수 없습니다")


# ---------- 같은 작업은 한 번만 (동시 요청은 하나의 Task를 공유) ----------
_inflight: dict = {}
_background: set = set()


def _done(t: asyncio.Future):
    _background.discard(t)
    if not t.cancelled() and t.exception():
        log.warning("background task failed: %r", t.exception())


def spawn(coro) -> asyncio.Task:
    # 응답과 무관하게 끝까지 도는 작업 (참조를 잡아 GC 방지)
    t = asyncio.ensure_future(coro)
    _background.add(t)
    t.add_done_callback(_done)
    return t


async def singleflight(key, factory):
    """key가 같은 동시 호출은 factory()를 한 번만 실행. 한 호출자가 끊겨도(cancel) 작업은 계속됨"""
    task = _inflight.get(key)
    if task is None or task.get_loop() is not asyncio.get_running_loop():
        task = asyncio.ensure_future(factory())
        _inflight[key] = task

        def done(t, key=key):
            if _inflight.get(key) is t:
                del _inflight[key]
            if not t.cancelled():
                t.exception()  # 'never retrieved' 경고 방지
        task.add_done_callback(done)
    return await asyncio.shield(task)


# ---------- 논문 ----------
async def fetch_paper(arxiv_id: str) -> dict:
    for src in SOURCES:
        try:
            r = await http.get(src.format(arxiv_id))
        except httpx.HTTPError:
            continue
        if r.status_code == 200 and "ltx_document" in r.text:
            return clean_article(r.text, str(r.url))
    raise HTTPException(404, "이 논문은 HTML 버전이 없습니다 (arXiv, ar5iv 모두 실패).")


async def _load_paper(arxiv_id: str) -> dict:
    path = paper_path(arxiv_id)
    paper = read_json(path)
    if not isinstance(paper, dict) or "text" not in paper or "html" not in paper:  # 캐시 없음/손상 -> 새로 받기
        paper = await fetch_paper(arxiv_id)
        write_json(path, paper)
    elif paper.get("v") != CLEAN_VERSION:  # 옛 규칙으로 저장된 논문: 다시 정리 (URL은 이미 절대경로라 그대로)
        old = paper
        paper = {**clean_article(old["html"], f"https://arxiv.org/html/{arxiv_id}"), "title": old.get("title") or "Untitled"}
        write_json(path, paper)
    papers[arxiv_id] = paper
    return paper


async def get_paper(arxiv_id: str) -> dict:
    if arxiv_id in papers:
        return papers[arxiv_id]
    return await singleflight(("paper", arxiv_id), lambda: _load_paper(arxiv_id))


_soups: OrderedDict = OrderedDict()  # 최근 논문 몇 편만 파싱 결과 보관
SOUP_KEEP = 4


async def paper_soup(arxiv_id: str) -> BeautifulSoup:
    """paper['html']의 BeautifulSoup (메모). 공유 객체이므로 절대 수정 금지 — 고치려면 copy.copy(el)"""
    if arxiv_id in _soups:
        _soups.move_to_end(arxiv_id)
        return _soups[arxiv_id]
    paper = await get_paper(arxiv_id)
    soup = await singleflight(("soup", arxiv_id), lambda: asyncio.to_thread(BeautifulSoup, paper["html"], "html.parser"))
    _soups[arxiv_id] = soup
    while len(_soups) > SOUP_KEEP:
        _soups.popitem(last=False)
    return soup


def el_text(el, skip_notes: bool = True) -> str:
    """요소의 텍스트. 수식은 $alttext$, 각주 본문(.ltx_note_outer)은 기본으로 제외 (클라이언트 PaperAnchor.textOf와 같은 규칙)"""
    parts = []

    def walk(n):
        if isinstance(n, NavigableString):
            if not isinstance(n, Comment):
                parts.append(str(n))
            return
        if n.name == "math":
            parts.append(f" ${n.get('alttext', '')}$ ")
            return
        cls = n.get("class") or []
        if n.name in ("script", "style") or "pr-ui" in cls or (skip_notes and "ltx_note_outer" in cls):
            return
        for c in n.children:
            walk(c)

    walk(el)
    return re.sub(r"\s+", " ", "".join(parts)).strip()


ARXIV_ID_RE = re.compile(r"arXiv[:\s]*(\d{4}\.\d{4,5})(v\d+)?", re.I)
ARXIV_HREF_RE = re.compile(r"arxiv\.org/(?:abs|pdf|html)/(\d{4}\.\d{4,5})")
DOI_RE = re.compile(r"\b(10\.\d{4,9}/[^\s\"<>]+)")
SECTION_LEVELS = ("section", "subsection", "subsubsection", "appendix", "paragraph")


def build_index(soup: BeautifulSoup) -> dict:
    """논문 구조 색인 (순수 함수). 섹션·참고문헌·그림·문단·외부 링크"""
    root = soup.find("article") or soup
    title_el = root.find(class_="ltx_title_document")
    sections = []
    for sec in root.find_all("section", id=True):
        cls = sec.get("class") or []
        level = next((lv for lv in SECTION_LEVELS if f"ltx_{lv}" in cls), None)
        h = sec.find(class_="ltx_title", recursive=False)
        if not level or not h:
            continue
        full = el_text(h)
        tag_el = h.find(class_="ltx_tag")
        tag = el_text(tag_el) if tag_el else ""
        title = full[len(tag):].strip() if tag and full.startswith(tag) else full
        sections.append({"id": sec["id"], "level": level, "tag": tag, "title": title, "full": full})

    bib = {}
    for li in root.find_all("li", class_="ltx_bibitem"):
        if not li.get("id"):
            continue
        blocks = [el_text(b) for b in li.find_all(class_="ltx_bibblock")]
        text = " ".join(blocks) if blocks else el_text(li)
        hrefs = [a["href"] for a in li.find_all("a", href=True)]
        m = ARXIV_ID_RE.search(text) or next(filter(None, (ARXIV_HREF_RE.search(h) for h in hrefs)), None)
        d = DOI_RE.search(" ".join([text, *hrefs]))
        label = li.find(class_="ltx_tag")
        bib[li["id"]] = {
            "id": li["id"],
            "label": el_text(label) if label else "",
            "text": text,
            "arxiv_id": m.group(1) if m else None,
            "doi": d.group(1).rstrip(".,;)") if d else None,
            "title_guess": blocks[1] if len(blocks) >= 2 else (max(blocks, key=len) if blocks else text),
            "hrefs": hrefs,
        }

    figures = []
    for fig in root.find_all("figure", id=True):
        cls = fig.get("class") or []
        kind = "table" if "ltx_table" in cls else "algorithm" if "ltx_float_algorithm" in cls else "figure"
        cap = fig.find("figcaption", recursive=False) or fig.find("figcaption")  # 하위 패널 캡션보다 자기 캡션 우선
        figures.append({
            "id": fig["id"],
            "kind": kind,
            "top": fig.find_parent("figure") is None,  # 하위 패널(sf1 등)은 False
            "caption": el_text(cap) if cap else "",
            "imgs": [i["src"] for i in fig.find_all("img", src=True)],
        })

    imgs = [i["src"] for i in root.find_all("img", src=True)]
    # 본문의 외부 링크 (참고문헌 안 링크는 제외)
    links = [{"href": a["href"], "text": el_text(a)} for a in root.find_all("a", href=True)
             if a["href"].startswith("http") and a.find_parent(class_="ltx_bibliography") is None]
    return {
        "title": el_text(title_el) if title_el else "",
        "sections": sections,
        "bib": bib,
        "figures": figures,
        "paras": [d["id"] for d in root.find_all("div", class_="ltx_para") if d.get("id")],
        "imgs": imgs,
        "img_set": frozenset(imgs),
        "links": links,
        "code_links": [l["href"] for l in links if re.match(r"https?://(www\.)?(github|gitlab)\.com/[\w.-]+/[\w.-]+", l["href"])],
    }


_indexes: dict[str, dict] = {}


async def paper_index(arxiv_id: str) -> dict:
    """build_index 메모. 반환값은 공유 객체이므로 수정 금지"""
    if arxiv_id not in _indexes:
        soup = await paper_soup(arxiv_id)
        _indexes[arxiv_id] = await singleflight(("index", arxiv_id), lambda: asyncio.to_thread(build_index, soup))
    return _indexes[arxiv_id]


# ---------- 캐시되는 작업 (논문당 한 번 생성, 디스크 저장) ----------
FAIL_TTL = 600  # 실패한 작업은 10분 동안 다시 부르지 않음 (잘림·형식 오류로 매번 과금되는 것 방지)
_failures: dict = {}  # (arxiv_id, name) -> (time, status, detail)


async def cached_task(arxiv_id: str, name: str, prompt: str, max_tokens: int = 4000,
                      as_json: bool = True, validate=None, retry: bool = False):
    """cache/<id>.<name>.json 이 있으면 바로 반환. 없으면 Claude 한 번 호출 (동시 호출은 공유).
    as_json이면 parse_json_loose, validate(value)로 후처리(ValueError → 실패). 실패는 캐시 안 하고 502.
    이름에 버전을 넣어 둘 것 (예: 'glossary.v1') — 프롬프트를 바꾸면 v2로 올리면 새로 생성됨"""
    path = task_path(arxiv_id, name)
    hit = read_json(path, MISSING)
    if hit is not MISSING:
        return hit
    key = (arxiv_id, name)
    failed = _failures.get(key)
    if failed and not retry and time.time() - failed[0] < FAIL_TTL:
        raise HTTPException(failed[1], failed[2])

    async def run():
        try:
            paper = await get_paper(arxiv_id)
            text = await complete_text(paper, prompt, max_tokens)
            if not text.strip():
                raise ValueError("빈 응답")
            value = parse_json_loose(text) if as_json else text.strip()
            if validate:
                value = validate(value)
        except HTTPException as e:
            _failures[key] = (time.time(), e.status_code, e.detail)
            raise
        except Exception as e:  # noqa: BLE001 - validate의 어떤 오류든 실패로 기억 (IndexError 등도 매번 과금 방지)
            _failures[key] = (time.time(), 502, f"응답 형식 오류: {type(e).__name__}: {e}")
            raise HTTPException(502, f"응답 형식 오류: {type(e).__name__}: {e}") from e
        _failures.pop(key, None)
        write_json(path, value)
        return value

    return await singleflight(("task", *key), run)


class _Live:
    # 생성 중인 스트림: 여러 응답이 같은 버퍼를 따라 읽음
    def __init__(self, loop):
        self.loop = loop
        self.chunks: list[str] = []
        self.done = False
        self.changed = asyncio.Event()

    def push(self, s: str):
        self.chunks.append(s)
        self._wake()

    def finish(self):
        self.done = True
        self._wake()

    def _wake(self):
        ev, self.changed = self.changed, asyncio.Event()
        ev.set()


_live: dict = {}


def error_tail(msg) -> str:
    # 클라이언트(app.js ERROR_TAIL, sw.js)가 알아보는 실패 꼬리: 마지막 한 줄
    return "\n\n[오류] " + re.sub(r"\s+", " ", str(msg)).strip()


async def _produce(paper: dict, path: Path, prompt: str, max_tokens: int, live: _Live, key: tuple):
    error = "중단됨"
    try:
        async with client.messages.stream(
            **REQUEST_OPTS, max_tokens=max_tokens, system=system_blocks(paper), messages=[user_turn(prompt)]
        ) as stream:
            async for text in stream.text_stream:
                live.push(text)
            final = await stream.get_final_message()
        if final.stop_reason == "max_tokens":
            error = "응답이 너무 길어 잘렸습니다 (max_tokens)."
        elif not "".join(live.chunks).strip():
            error = "빈 응답"
        else:
            error = None
    except anthropic.APIError as e:
        error = str(e)
    except Exception as e:  # noqa: BLE001 - 어떤 실패든 캐시하지 않고 알림
        log.exception("cached_stream failed")
        error = type(e).__name__
    finally:
        try:
            if error is None:
                write_json(path, "".join(live.chunks))
                _failures.pop(key, None)
            else:
                # 실패는 저장하지 않고 FAIL_TTL 동안 기억 (매 GET마다 다시 생성·과금 방지). 본문 끝에 [오류] 꼬리
                _failures[key] = (time.time(), 502, f"생성 실패: {error}")
                live.push(error_tail(error))
        finally:
            live.finish()  # 저장이 실패해도 따라 읽는 응답들은 끝나야 함


async def cached_stream(arxiv_id: str, name: str, prompt: str, max_tokens: int = 4000,
                        headers: dict | None = None, retry: bool = False) -> StreamingResponse:
    """텍스트 작업을 스트리밍. 캐시 적중이면 전체를 한 덩어리로. 생성은 백그라운드 Task라
    사용자가 떠나도 끝까지 돌고 깨끗이 끝났을 때만 저장. 동시 GET은 같은 버퍼를 공유.
    실패(API 오류·max_tokens 잘림·빈 응답)는 본문 끝 '[오류] …' 꼬리로 알리고 저장하지 않으며, FAIL_TTL 동안은
    새로 생성하지 않고 502 (retry=True면 다시 시도) — cached_task와 같은 규칙"""
    paper = await get_paper(arxiv_id)
    path = task_path(arxiv_id, name)
    hdrs = {**OFFLINE_HEADERS, "Cache-Control": "no-cache", **(headers or {})}
    hit = read_json(path, MISSING)
    if isinstance(hit, str):
        return StreamingResponse(iter([hit]), media_type=TEXT, headers=hdrs)
    key = (arxiv_id, name)
    loop = asyncio.get_running_loop()
    live = _live.get(key)
    if live is None or live.loop is not loop:
        failed = _failures.get(key)
        if failed and not retry and time.time() - failed[0] < FAIL_TTL:
            raise HTTPException(failed[1], failed[2])
        live = _live[key] = _Live(loop)
        t = spawn(_produce(paper, path, prompt, max_tokens, live, key))
        t.add_done_callback(lambda _t, live=live: _live.get(key) is live and _live.pop(key))

    async def tail():
        i = 0
        while True:
            ev = live.changed
            while i < len(live.chunks):
                yield live.chunks[i]
                i += 1
            if live.done:
                return
            await ev.wait()

    return StreamingResponse(tail(), media_type=TEXT, headers=hdrs)


def offline_json(data, status_code: int = 200) -> JSONResponse:
    # sw.js가 오프라인용으로 저장해도 되는 GET 응답
    return JSONResponse(data, status_code=status_code, headers=OFFLINE_HEADERS)


# ---------- arXiv API (export.arxiv.org: 3초에 1회 권장) ----------
ARXIV_API = "https://export.arxiv.org/api/query"
ARXIV_INTERVAL = 3.0
_arxiv_next = 0.0
ATOM = "{http://www.w3.org/2005/Atom}"
ARXIV_NS = "{http://arxiv.org/schemas/atom}"


async def _arxiv_throttle():
    # 자리 예약은 await 없이 → 동시 호출도 순서대로 간격 유지
    global _arxiv_next
    now = time.monotonic()
    wait = max(0.0, _arxiv_next - now)
    _arxiv_next = max(now, _arxiv_next) + ARXIV_INTERVAL
    if wait:
        await asyncio.sleep(wait)


def _clean(s: str | None) -> str:
    return re.sub(r"\s+", " ", s or "").strip()


def parse_atom(xml_text: str) -> list[dict]:
    """arXiv Atom 피드 → [{id, version, title, summary, authors, published, updated, year, ...}]. 오류 항목은 건너뜀"""
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError as e:
        raise ValueError(f"Atom 파싱 실패: {e}") from e
    out = []
    for e in root.findall(f"{ATOM}entry"):
        m = re.search(r"arxiv\.org/abs/(.+?)(v\d+)?$", _clean(e.findtext(f"{ATOM}id")))
        if not m:
            continue
        aid = m.group(1)
        published = _clean(e.findtext(f"{ATOM}published"))
        primary = e.find(f"{ARXIV_NS}primary_category")
        pdf = next((ln.get("href") for ln in e.findall(f"{ATOM}link") if ln.get("title") == "pdf"), None)
        out.append({
            "id": aid,
            "version": m.group(2) or "",
            "title": _clean(e.findtext(f"{ATOM}title")),
            "summary": _clean(e.findtext(f"{ATOM}summary")),
            "authors": [_clean(a.findtext(f"{ATOM}name")) for a in e.findall(f"{ATOM}author")],
            "published": published,
            "updated": _clean(e.findtext(f"{ATOM}updated")),
            "year": int(published[:4]) if published[:4].isdigit() else None,
            "primary_category": primary.get("term") if primary is not None else None,
            "categories": [c.get("term") for c in e.findall(f"{ATOM}category")],
            "doi": _clean(e.findtext(f"{ARXIV_NS}doi")) or None,
            "comment": _clean(e.findtext(f"{ARXIV_NS}comment")) or None,
            "abs_url": f"https://arxiv.org/abs/{aid}",
            "pdf_url": pdf or f"https://arxiv.org/pdf/{aid}",
        })
    return out


async def arxiv_query(id_list: list[str] | None = None, search: str | None = None, max_results: int = 10,
                      start: int = 0, sort_by: str | None = None, sort_order: str = "descending",
                      timeout: float = 10.0) -> list[dict]:
    """arXiv API 조회 (전역 3초 간격). 네트워크 오류는 httpx.HTTPError, 형식 오류는 ValueError"""
    params = {"start": str(start), "max_results": str(max(max_results, len(id_list or [])))}
    if id_list:
        params["id_list"] = ",".join(id_list)
    if search:
        params["search_query"] = search
    if sort_by:
        params.update(sortBy=sort_by, sortOrder=sort_order)
    await _arxiv_throttle()
    r = await http.get(ARXIV_API, params=params, timeout=timeout)
    r.raise_for_status()
    return parse_atom(r.text)


# ---------- 논문 그림 가져오기 (SSRF 방지: 논문에 실린 arXiv 호스트 이미지만) ----------
IMAGE_HOSTS = {"arxiv.org", "www.arxiv.org", "ar5iv.labs.arxiv.org", "ar5iv.org"}
IMAGE_TYPES = {"image/png", "image/jpeg", "image/gif", "image/webp"}
IMAGE_MAX = 3_700_000  # base64로 4/3 늘어도 API 5MB 한도 안
_images: OrderedDict = OrderedDict()  # url -> (media_type, bytes), 최근 50개


async def fetch_image(arxiv_id: str, url: str) -> tuple[str, bytes] | None:
    """논문 HTML에 있는 img src만 허용. 지원 안 되는 형식·너무 큼·실패는 None. 허용 안 되는 URL은 400"""
    idx = await paper_index(arxiv_id)
    if url not in idx["img_set"] or httpx.URL(url).host not in IMAGE_HOSTS:
        raise HTTPException(400, "논문에 없는 이미지 주소입니다.")
    if url in _images:
        _images.move_to_end(url)
        return _images[url]
    try:
        r = await http.get(url, follow_redirects=False, timeout=10)
    except httpx.HTTPError:
        return None
    media = r.headers.get("content-type", "").split(";")[0].strip()
    if r.status_code != 200 or media not in IMAGE_TYPES or len(r.content) > IMAGE_MAX:
        return None
    _images[url] = (media, r.content)
    while len(_images) > 50:
        _images.popitem(last=False)
    return _images[url]


# ---------- 기능 에셋: static/features/*.js|css 를 한 파일로 묶어 서빙 ----------
FEATURES_STATIC = STATIC_DIR / "features"
_bundles: dict = {}
# 페이지 번들 끝: 기능 등록(답변 슬롯 등)이 끝났음을 알림 → app.js가 저장된 대화를 복원 (CDN·DOMContentLoaded를 기다리지 않음)
FEATURES_READY = ";window.PaperApp && PaperApp.featuresReady && PaperApp.featuresReady();\n"


def _js_string(src: str) -> str:
    # JS 문자열 리터럴 (한글은 그대로, 옛 엔진이 문자열 안에서 못 받는 U+2028/2029만 이스케이프)
    return json.dumps(src, ensure_ascii=False).replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")


def feature_files(kind: str) -> list[Path]:
    """kind: 'js'(페이지용) | 'css' | 'sw'(서비스워커 확장 *.sw.js)"""
    if not FEATURES_STATIC.is_dir():
        return []
    pattern = "*.sw.js" if kind == "sw" else f"*.{kind}"
    files = (p for p in FEATURES_STATIC.glob(pattern) if p.is_file() and not p.name.startswith((".", "_")))
    if kind == "js":
        files = (p for p in files if not p.name.endswith(".sw.js"))
    return sorted(files)


def feature_bundle(kind: str) -> tuple:
    """(key, body, etag, names). 파일 mtime·크기가 바뀔 때만 다시 묶음"""
    files = feature_files(kind)
    key = tuple((p.name, p.stat().st_mtime_ns, p.stat().st_size) for p in files)
    hit = _bundles.get(kind)
    if hit and hit[0] == key:
        return hit
    parts = []
    for p in files:
        src = p.read_text(encoding="utf-8")
        if kind in ("js", "sw"):
            # 파일마다 따로 파싱·실행 (new Function): 한 파일의 문법 오류(옛 iOS Safari가 모르는 문법 포함)나
            # 런타임 오류가 다른 기능을 죽이지 않음. 오류는 파일 이름과 함께 기록, sourceURL로 개발자 도구에 원래 파일 이름
            code = _js_string(f"{src}\n//# sourceURL=features/{p.name}")
            parts.append(f"/* ---- {p.name} ---- */\ntry{{(new Function({code}))()}}catch(e){{console.error({json.dumps('[feature] ' + p.name)}, e)}}")
        else:
            parts.append(f"/* ---- {p.name} ---- */\n{src}")
    if kind == "js":
        parts.append(FEATURES_READY)
    body = "\n".join(parts) + "\n"
    etag = hashlib.sha1(body.encode()).hexdigest()[:12]
    hit = _bundles[kind] = (key, body, etag, [p.name for p in files])
    return hit


def feature_assets() -> dict:
    js, css = feature_bundle("js"), feature_bundle("css")
    return {"js": f"/features.js?v={js[2]}", "css": f"/features.css?v={css[2]}", "names": js[3] + css[3]}


def asset(path: str) -> str:
    # /static URL에 버전(mtime)을 붙여 배포 후 옛 파일과 섞이지 않게
    try:
        v = format(int((STATIC_DIR / path).stat().st_mtime), "x")
    except OSError:
        v = "0"
    return f"/static/{path}?v={v}"


templates.env.globals.update(feature_assets=feature_assets, asset=asset)


def _bundle_response(kind: str, media: str, request: Request) -> Response:
    _, body, etag, _ = feature_bundle(kind)
    headers = {"ETag": f'"{etag}"', "Cache-Control": "no-cache"}
    if request.query_params.get("v") == etag:
        headers["Cache-Control"] = "public, max-age=31536000, immutable"
    if request.headers.get("if-none-match") == f'"{etag}"':
        return Response(status_code=304, headers=headers)
    return Response(body, media_type=media, headers=headers)


@app.get("/features.js")
async def features_js(request: Request):
    return _bundle_response("js", "text/javascript; charset=utf-8", request)


@app.get("/features.css")
async def features_css(request: Request):
    return _bundle_response("css", "text/css; charset=utf-8", request)


@app.get("/features.sw.js")
async def features_sw(request: Request):
    # sw.js가 importScripts로 읽는 서비스워커 확장 (static/features/*.sw.js)
    return _bundle_response("sw", "text/javascript; charset=utf-8", request)


# ---------- 페이지 ----------
@app.get("/")
async def home(request: Request):
    return templates.TemplateResponse(request, "index.html")


@app.get("/sw.js")
async def service_worker():
    # 서비스워커는 루트 경로에서 서빙해야 전체 페이지를 제어할 수 있음
    return FileResponse(STATIC_DIR / "sw.js", media_type="text/javascript", headers={"Cache-Control": "no-cache"})


@app.get("/open")
async def open_paper(q: str):
    arxiv_id = parse_arxiv_id(q)
    if not arxiv_id:
        raise HTTPException(400, "arXiv ID를 찾을 수 없습니다.")
    return RedirectResponse(f"/paper/{arxiv_id}")


PAPER_MISSING_HOOKS: list = []  # async fn(request, arxiv_id) -> Response | None: HTML이 없는 논문의 대체 페이지


def on_paper_missing(fn):
    """기능이 등록 (entry-routes): @core.on_paper_missing async def f(request, arxiv_id) -> Response | None.
    /paper/{id}가 404일 때 등록 순서대로 불러 처음 나온 Response를 돌려줌. arxiv_id는 사용자 입력이므로 직접 검증할 것"""
    PAPER_MISSING_HOOKS.append(fn)
    return fn


def render_page(request: Request, title: str, body_html: str, *, page: str = "abstract",
                arxiv_id: str | None = None, status_code: int = 200) -> Response:
    """base.html 위의 단순 페이지 (공용 스크립트·기능 번들·읽기 설정 포함). entry-routes의 초록 페이지 등.
    body_html은 그대로(| safe) 들어가므로 외부·사용자 문자열은 html.escape 할 것. page는 body[data-page]"""
    if not re.fullmatch(r"[a-z][a-z0-9-]{0,31}", page):
        raise ValueError(f"bad page name: {page!r}")
    return templates.TemplateResponse(
        request, "page.html",
        {"title": title, "body_html": body_html, "page": page, "arxiv_id": arxiv_id}, status_code=status_code,
    )


@app.get("/paper/{arxiv_id}")
async def read_paper(request: Request, arxiv_id: str):
    try:
        paper = await get_paper(arxiv_id)
    except HTTPException as e:
        if e.status_code != 404:
            raise
        for fn in PAPER_MISSING_HOOKS:
            try:
                r = await fn(request, arxiv_id)
            except Exception:  # noqa: BLE001 - 대체 페이지가 깨져도 기본 오류 페이지는 나옴
                log.exception("paper_missing hook %r failed", fn)
                continue
            if r is not None:
                return r
        return templates.TemplateResponse(
            request, "error.html", {"message": e.detail, "arxiv_id": arxiv_id}, status_code=404
        )
    return templates.TemplateResponse(
        request, "paper.html", {"paper": paper, "arxiv_id": arxiv_id}
    )


# ---------- 프리웜 ----------
PREWARM_HOOKS: list = []  # async fn(arxiv_id): 논문 캐시가 데워진 뒤 서버에서 미리 돌릴 작업
WARM_TTL = 240  # 캐시 수명(5분) 안이면 다시 데우지 않음
_warm_at: dict[str, float] = {}


def on_prewarm(fn):
    """기능이 등록: @core.on_prewarm async def f(arxiv_id): await core.cached_task(...)"""
    PREWARM_HOOKS.append(fn)
    return fn


async def prewarm(paper: dict) -> bool:
    # 논문 본문을 미리 캐시해서 첫 질문도 빠르게
    try:
        await client.messages.create(
            **REQUEST_OPTS,
            max_tokens=0,
            system=system_blocks(paper),
            messages=[{"role": "user", "content": "warmup"}],
        )
        return True
    except anthropic.APIError as e:
        log.warning("prewarm failed: %s", e)
        return False


@app.post("/api/prewarm/{arxiv_id}")
async def api_prewarm(arxiv_id: str):
    paper = await get_paper(arxiv_id)
    if time.time() - _warm_at.get(arxiv_id, 0) > WARM_TTL:
        if await singleflight(("warm", arxiv_id), lambda: prewarm(paper)):
            _warm_at[arxiv_id] = time.time()
    for fn in PREWARM_HOOKS:
        spawn(fn(arxiv_id))
    return {"ok": True}


# ---------- 질문 ----------
class Turn(BaseModel):
    role: Literal["user", "assistant"]
    content: str


class Ask(BaseModel):
    arxiv_id: str
    selection: str = ""
    context: str = ""  # 선택 주변 문단 (수식은 $alttext$)
    section: str = ""  # 선택이 속한 섹션 제목
    question: str = ""
    history: list[Turn] = []  # 같은 시트에서 이어지는 이전 대화


def build_messages(body: Ask) -> list[dict]:
    """history + 새 질문. 하이라이트·문맥은 첫 user 턴에만 (매 요청 같은 바이트 → 대화 앞부분 캐시 적중)"""
    messages = [t.model_dump() for t in body.history]
    if body.question:
        messages.append({"role": "user", "content": body.question})
    if not messages or messages[0]["role"] != "user":
        raise HTTPException(400, "대화는 user 턴으로 시작해야 합니다.")
    first = messages[0]
    first["content"] = build_first_turn(body.selection, body.context, first["content"], body.section)
    return messages


@app.post("/api/ask")
async def ask(body: Ask):
    if not body.question.strip():
        raise HTTPException(400, "질문이 비어 있습니다.")
    paper = await get_paper(body.arxiv_id)
    return stream_claude(paper, build_messages(body))


# ---------- 피드백 (👍/👎, 생성물 품질 추적용 append-only 로그) ----------
class Feedback(BaseModel):
    kind: str = Field("answer", pattern=r"^[a-z][a-z0-9_-]{0,31}$")  # answer|overview|glossary|skim|gist|translate|...
    vote: Literal["up", "down"]
    arxiv_id: str = Field("", max_length=40)
    target: str = Field("", max_length=200)  # 대상 id (섹션 id, 용어 등)
    label: str = Field("", max_length=100)  # 프리셋 이름 등
    question: str = Field("", max_length=4000)
    answer_len: int = 0
    note: str = Field("", max_length=500)


@app.post("/api/feedback")
async def feedback(body: Feedback):
    rec = {"ts": int(time.time()), **body.model_dump()}
    rec["question"] = rec["question"][:300]
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    with open(CACHE_DIR / "feedback.jsonl", "a", encoding="utf-8") as f:
        f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    return {"ok": True}


# ---------- 기능 라우터: features/*.py 각각의 `router`를 등록 (반드시 파일 맨 끝) ----------
# features/__init__.py가 `import app`을 하므로 기능 모듈을 먼저 import해도 app이 끝까지 로드된 뒤 등록됨.
# 반환값: router를 실제로 등록한 모듈 이름들. router가 없는 모듈은 경고 (도우미 모듈은 _이름.py로)
def load_feature_routers(target: FastAPI, path: Path = BASE_DIR / "features", package: str = "features") -> list[str]:
    loaded = []
    for f in sorted(path.glob("[!_]*.py")):
        try:
            mod = importlib.import_module(f"{package}.{f.stem}")
            router = getattr(mod, "router", None)
            if router is None:
                log.warning("feature %s has no `router` (half-imported module? helper modules must be named _x.py)", f.name)
                continue
            target.include_router(router)
            loaded.append(f.stem)
        except Exception:  # noqa: BLE001 - 기능 하나가 깨져도 앱은 뜸
            log.exception("feature %s failed to load", f.name)
    return loaded


FEATURES = load_feature_routers(app)
