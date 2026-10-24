"""offline-save: '오프라인 저장'용 같은 출처 그림 프록시.

다른 출처(arxiv.org) 그림을 서비스워커가 no-cors로 받으면 불투명 응답이 되고, 크롬은 그 하나를 약 7MB로 계산한다
(그림 30개 논문 하나가 수백 MB → 용량 초과·출처 전체 삭제 위험). 같은 출처로 받으면 실제 크기로 저장된다.
core.fetch_image가 검증(이 논문의 img src, arXiv 호스트만, 리다이렉트 없음, png/jpeg/gif/webp, 3.7MB 이하)을 맡고,
못 받는 그림(SVG·큰 그림·실패)은 404 → offline-save.sw.js가 기본 precache(불투명 저장)로 넘김.
X-Offline-Cacheable은 붙이지 않음: SW가 API 캐시에 한 벌 더 저장하지 않게 (SAVED에만).
"""
from fastapi import APIRouter, HTTPException
from fastapi.responses import Response

import app as core

router = APIRouter()


@router.get("/api/offline-save/img/{arxiv_id}")
async def image(arxiv_id: str, u: str):
    got = await core.fetch_image(arxiv_id, u)  # 논문에 없는 주소·다른 호스트는 400
    if got is None:
        raise HTTPException(404, "그림을 가져올 수 없습니다.")
    media, data = got
    return Response(data, media_type=media, headers={"Cache-Control": "private, max-age=86400", "X-Content-Type-Options": "nosniff"})
