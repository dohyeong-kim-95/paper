"""audio-summary: 오디오 대본 API (요약·비평), 캐시·실패 기억·공용 접두부, 대본 정리"""
import unittest

from tests.helpers import CoreTestCase, core
from features.audio_summary import MAX_TOKENS, PROMPTS, clean_script

SCRIPT = ("이 논문은 희소 전문가 혼합 모델을 제안합니다. 토큰마다 두 전문가만 골라 계산을 줄입니다. "
          "결과는 밀집 모델과 비슷하면서 연산량은 훨씬 적습니다. ") * 4


class AudioSummaryApiTests(CoreTestCase):
    def get(self, style=None, **params):
        if style is not None:
            params["style"] = style
        return self.client.get(f"/api/audio-summary/{self.paper_id}", params=params)

    def test_brief_returns_text_then_cache_hit(self):
        self.claude.push("## 오디오 요약\n\n" + SCRIPT)
        r = self.get("brief")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.headers.get("x-offline-cacheable"), "1")
        body = r.json()
        self.assertEqual(body["style"], "brief")
        self.assertEqual(body["text"], SCRIPT.strip())  # 제목 줄·Markdown 제거
        self.assertEqual(self.claude.kinds, ["create"])
        self.assertEqual(self.claude.last["max_tokens"], MAX_TOKENS)
        self.assert_shared_call()
        self.assertTrue(core.task_path(self.paper_id, "audio-summary.brief.v1").exists())
        r2 = self.get("brief")
        self.assertEqual(r2.json(), body)
        self.assertEqual(len(self.claude.calls), 1, "두 번째 요청은 Claude 호출 0번")

    def test_default_style_is_brief(self):
        self.claude.push(SCRIPT)
        self.assertEqual(self.get().json()["style"], "brief")
        self.assertIn("개요", self.claude.user_texts()[0])

    def test_invalid_style_422_without_claude(self):
        for bad in ("long", "", "BRIEF"):
            with self.subTest(bad):
                self.assertEqual(self.get(bad).status_code, 422)
        self.assertEqual(self.claude.calls, [])

    def test_critique_prompt_differs_prefix_shared(self):
        self.claude.push(SCRIPT, SCRIPT)
        self.assertEqual(self.get("brief").status_code, 200)
        self.assertEqual(self.get("critique").status_code, 200)
        brief, critique = self.claude.calls
        b, c = self.claude.user_texts(brief)[0], self.claude.user_texts(critique)[0]
        self.assertNotEqual(b, c)
        self.assertIn("리뷰어", c)
        self.assertNotIn("리뷰어", b)
        for text in (b, c):
            self.assertTrue(text.startswith(core.TASK_PREAMBLE), "형식 지시는 user 메시지 (TASK_PREAMBLE 포함)")
            self.assertIn("900자", text)
        self.assertEqual(brief["system"], critique["system"])  # 같은 논문 캐시 접두부
        for kw in (brief, critique):
            self.assert_shared_call(kw)
            self.assertNotIn("cache_control", kw)  # 일회성 작업: system 표시 하나만
        self.assertTrue(core.task_path(self.paper_id, "audio-summary.critique.v1").exists())
        self.assertEqual(set(PROMPTS), {"brief", "critique"})

    def test_bad_output_not_cached_and_remembered_until_retry(self):
        self.claude.push("짧음")
        r = self.get("brief")
        self.assertEqual(r.status_code, 502)
        self.assertFalse(core.task_path(self.paper_id, "audio-summary.brief.v1").exists())
        self.assertEqual(self.get("brief").status_code, 502)
        self.assertEqual(len(self.claude.calls), 1, "실패는 10분 동안 다시 부르지 않음")
        self.claude.push(SCRIPT)
        r = self.get("brief", retry=1)
        self.assertEqual(r.status_code, 200)
        self.assertEqual(len(self.claude.calls), 2)

    def test_truncated_is_failure(self):
        self.claude.push({"text": SCRIPT, "stop_reason": "max_tokens"})
        self.assertEqual(self.get("critique").status_code, 502)
        self.assertFalse(core.task_path(self.paper_id, "audio-summary.critique.v1").exists())


class CleanScriptTests(unittest.TestCase):
    def test_strips_markdown_and_latex(self):
        raw = ("# 제목\n**오디오 요약**\n\n- 첫째, 모델은 $x^2$ 대신 \\alpha 를 씁니다. \\frac{1}{N}\n"
               "1. 둘째 [링크](https://x.y) 입니다.\n> 인용 `코드`\n\n" + SCRIPT)
        out = clean_script(raw)
        for bad in ("#", "**", "- ", "1. ", "$", "\\", "`", "](", ">", "{"):
            self.assertNotIn(bad, out)
        self.assertTrue(out.startswith("첫째, 모델은 x^2 대신 alpha 를 씁니다. frac1N"))
        self.assertIn("둘째 링크 입니다.", out)

    def test_keeps_first_sentence_line(self):
        out = clean_script("좋은 아침이에요\n" + SCRIPT)
        self.assertTrue(out.startswith("좋은 아침이에요"))

    def test_too_short_raises(self):
        with self.assertRaises(ValueError):
            clean_script("## 제목\n짧은 대본입니다.")
