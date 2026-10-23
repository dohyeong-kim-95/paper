"""audio-summary: 귀로 듣는 한국어 오디오 대본 (요약·비평). 소리 내어 읽기는 브라우저 speechSynthesis (PaperApp.tts)"""
import re
from typing import Literal

from fastapi import APIRouter

import app as core

router = APIRouter()

MAX_TOKENS = 2000  # 한국어 약 900자 + 여유 (잘리면 실패로 기억되므로 넉넉히)
MIN_CHARS = 200  # 이보다 짧으면 형식 오류로 보고 저장하지 않음

# 형식 지시는 user 메시지에만 (system·REQUEST_OPTS는 공용 → 논문 캐시 공유)
RULES = (
    "이 논문을 화면 없이 귀로만 듣는 한국어 사용자(출퇴근길)를 위한 오디오 대본을 쓰세요.\n"
    "- 길이: 공백 포함 약 900자 (800~1000자, 소리 내어 읽으면 약 3분).\n"
    "- 자연스러운 구어체 존댓말. 문장은 짧게 (40자 안팎), 문장마다 마침표나 물음표로 끝내기.\n"
    "- 일반 문단 텍스트만: 제목, 목록 기호, 번호 매기기, 굵게, 표, 링크, 코드, 이모지 같은 Markdown이나 기호는 쓰지 마세요.\n"
    "- 수식과 기호는 LaTeX나 $ 없이 말로 풀어 읽기 (예: 'x의 제곱', '알파', 'N분의 1', '10의 마이너스 4제곱').\n"
    "- 약어는 처음 나올 때 한 번 풀어서 말하기. 모델·데이터셋 이름은 원래 이름 그대로.\n"
    "- 수치는 논문에 있는 것만 단위와 함께. 논문에 없는 내용은 지어내지 마세요.\n"
    "- 인사말, '이 대본은' 같은 설명, 제목 없이 대본 본문만 출력하세요.\n"
)
PROMPTS = {
    "brief": RULES + (
        "\n구성 (개요): 이 논문이 푸는 문제와 왜 중요한지 → 핵심 아이디어와 방법 (직관적인 비유 하나) → "
        "가장 중요한 결과 한두 개 (수치 포함) → 한계 → 한 문장으로 정리."
    ),
    "critique": RULES + (
        "\n관점: 꼼꼼한 학회 리뷰어. 구성 (비평): 논문의 주장 한 문장 → 강점 두세 가지 (근거와 함께) → "
        "약점·의문점 두세 가지 (실험 설계, 비교 대상, 가정, 일반화, 재현성 중 해당하는 것을 구체적으로) → "
        "저자에게 묻고 싶은 질문이나 필요한 추가 실험 → 종합 평가 한 문장. "
        "논문이 스스로 인정한 한계와 리뷰어로서의 추측을 구분해서 말하세요."
    ),
}

_NOT_TITLE = re.compile(r"[.!?。…]|[다요죠까]$")  # 문장 부호가 있거나 문장처럼 끝나면 제목 아님


def clean_script(text: str) -> str:
    """읽기용 대본 정리: Markdown·LaTeX 흔적 제거, 제목 같은 첫 줄 제거. 너무 짧으면 ValueError (저장 안 함)"""
    t = re.sub(r"```[a-zA-Z]*\n?|```", "", text)
    t = re.sub(r"!?\[([^\]]*)\]\([^)]*\)", r"\1", t)  # [글](주소) → 글
    t = re.sub(r"(?m)^\s{0,3}(#{1,6}|>|[-*+•]|\d+[.)])\s+", "", t)  # 제목·인용·목록 기호
    t = re.sub(r"\\([a-zA-Z]+)", r"\1", t)
    t = re.sub(r"[*_`$#|{}]+", "", t)
    lines = [re.sub(r"[ \t]+", " ", ln).strip() for ln in t.splitlines()]
    lines = [ln for ln in lines if ln]
    # '오디오 요약' 같은 제목 줄 (짧고 문장 끝이 아님)
    while len(lines) > 1 and len(lines[0]) < 40 and not _NOT_TITLE.search(lines[0]):
        lines.pop(0)
    out = "\n".join(lines).strip()
    if len(out) < MIN_CHARS:
        raise ValueError(f"대본이 너무 짧습니다 ({len(out)}자)")
    return out


@router.get("/api/audio-summary/{arxiv_id}")
async def audio_summary(arxiv_id: str, style: Literal["brief", "critique"] = "brief", retry: bool = False):
    # style이 brief|critique가 아니면 FastAPI가 422 (Claude 호출 전)
    text = await core.cached_task(arxiv_id, f"audio-summary.{style}.v1", PROMPTS[style], MAX_TOKENS,
                                  as_json=False, validate=clean_script, retry=retry)
    return core.offline_json({"style": style, "text": text})
