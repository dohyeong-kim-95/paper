"""figure-explain: 그림·표·알고리즘의 'AI 설명' — 원본 이미지(비전) + 캡션 + 인용 문단으로 질문 (스트리밍)

POST /api/figure-explain/ask  body = core.Ask + figure_id, image_urls(≤4), image_data(TikZ를 클라이언트가 그린 PNG, ≤2)
- image_urls: 이 그림(figure_id, 하위 패널 포함)의 <img src>만 허용 (가져오기 전에 전부 검사 → 아니면 400, HTTP 호출 없음).
  가져오기는 core.fetch_image (arXiv 호스트만·리다이렉트 안 따름·png/jpeg/gif/webp·≤3.7MB·LRU 50 → 이어지는 질문도 같은 바이트)
- 이미지 블록은 첫 user 턴의 텍스트 앞에. system·REQUEST_OPTS는 그대로라 논문 캐시 공유
"""
import asyncio
import base64
import binascii

from fastapi import APIRouter, HTTPException
from pydantic import Field

import app as core

router = APIRouter()

MAX_IMAGES = 4  # URL + 그린 이미지 합 (패널이 더 많으면 클라이언트가 큰 것부터 고름)
MAX_DATA = 2  # 클라이언트가 그린 TikZ 이미지 수
DATA_MAX = 1_500_000  # 그린 이미지 바이트 상한 (클라이언트는 ~220KB로 줄여 보냄)
MAGIC = {b"\x89PNG\r\n\x1a\n": "image/png", b"\xff\xd8\xff": "image/jpeg"}  # canvas.toDataURL 결과만
MAX_TOKENS = 3000


class FigureAsk(core.Ask):
    figure_id: str = Field(..., min_length=1, max_length=200)
    image_urls: list[str] = []
    image_data: list[str] = []  # "data:image/png;base64,..." (svg.ltx_picture를 canvas로 그림: 서버가 가져오지 않으니 SSRF 없음)


def decode_image(data: str) -> tuple[str, str] | None:
    """base64 또는 data: URL → (media_type, 정규화한 base64). PNG/JPEG가 아니거나 너무 크거나 깨졌으면 None"""
    if data.startswith("data:"):
        data = data.partition(",")[2]
    if len(data) > DATA_MAX * 4 // 3 + 8:
        return None
    try:
        raw = base64.b64decode(data, validate=True)
    except (binascii.Error, ValueError):
        return None
    media = next((m for sig, m in MAGIC.items() if raw.startswith(sig)), None)
    if not media or len(raw) > DATA_MAX:
        return None
    return media, base64.b64encode(raw).decode()


def image_block(media: str, b64: str) -> dict:
    return {"type": "image", "source": {"type": "base64", "media_type": media, "data": b64}}


async def _fetch(arxiv_id: str, url: str):
    # 이 그림의 img지만 arXiv 호스트가 아니면 fetch_image가 400 → 건너뜀 (질문은 텍스트로 계속)
    try:
        return await core.fetch_image(arxiv_id, url)
    except HTTPException:
        return None


@router.post("/api/figure-explain/ask")
async def figure_ask(body: FigureAsk):
    if not body.question.strip():
        raise HTTPException(400, "질문이 비어 있습니다.")
    if len(body.image_urls) + len(body.image_data) > MAX_IMAGES or len(body.image_data) > MAX_DATA:
        raise HTTPException(400, "이미지가 너무 많습니다.")
    paper = await core.get_paper(body.arxiv_id)
    idx = await core.paper_index(body.arxiv_id)
    fig = next((f for f in idx["figures"] if f["id"] == body.figure_id), None)
    if fig is None:
        raise HTTPException(400, "논문에 없는 그림입니다.")
    # SSRF 방지: 본문 링크(<a href>)가 아니라 이 그림의 img src만. 하나라도 아니면 아무것도 가져오지 않고 400
    allowed = set(fig["imgs"])
    if any(u not in allowed for u in body.image_urls):
        raise HTTPException(400, "논문에 없는 이미지 주소입니다.")
    messages = core.build_messages(body)

    fetched = await asyncio.gather(*(_fetch(body.arxiv_id, u) for u in body.image_urls))
    blocks = [image_block(m, base64.b64encode(b).decode()) for m, b in filter(None, fetched)]
    blocks += [image_block(*d) for d in map(decode_image, body.image_data) if d]
    sent = len(body.image_urls) + len(body.image_data)
    if sent:
        # 이미지는 첫 user 턴의 텍스트 앞에 (이어지는 질문도 같은 바이트 → 대화 앞부분 캐시 적중)
        note = [] if len(blocks) == sent else [{
            "type": "text", "text": f"(그림 이미지 {sent}장 중 {len(blocks)}장만 첨부됨: 나머지는 캡션·본문으로 판단할 것)",
        }]
        first = messages[0]
        first["content"] = [*blocks, *note, {"type": "text", "text": first["content"]}]
    return core.stream_claude(paper, messages, max_tokens=MAX_TOKENS)
