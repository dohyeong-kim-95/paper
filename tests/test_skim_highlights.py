"""skim-highlights: JSONL 스트림 검증·캐시·실패 처리 (가짜 Claude, 시드 논문)"""
import json
import time

from features import skim_highlights as skim
from tests.helpers import AsyncCoreTestCase, CoreTestCase, api_error, core

L = lambda **kw: json.dumps(kw) + "\n"  # noqa: E731 - 모델이 쓰는 JSONL 한 줄
GOAL = "We propose a sparse mixture of experts model that routes each token to two experts"
RESULT = "the sparse model improves accuracy by 2.3 points on MMLU"
LIMIT = "A limitation of our approach is the extra memory required to store all experts"


def lines(text: str) -> list[dict]:
    return [json.loads(x) for x in text.splitlines() if x.startswith("{")]


class SkimHighlightsTests(CoreTestCase):
    def setUp(self):
        super().setUp()
        skim._bad.clear()
        self.addCleanup(skim._bad.clear)
        self.url = f"/api/skim-highlights/{self.paper_id}"
        self.path = core.task_path(self.paper_id, skim.NAME)

    def test_streams_only_valid_items_in_order(self):
        self.claude.push({"chunks": [
            "```jsonl\n" + L(f="goal", q=GOAL, s=3) + '{"f": "bo',
            'gus", "q": "This sentence has a bogus facet", "s": 2}\n',
            L(f="result", q="  " + RESULT + "...", s=7),
            L(f="limitations", q=LIMIT, s=0),
            L(f="method", q="", s=2) + L(f="method", q="two words", s=2),
            L(f="goal", q=GOAL.upper(), s=1),  # 같은 인용 (대소문자만 다름)
            "```",
        ]})
        r = self.client.get(self.url)
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.headers["x-offline-cacheable"], "1")
        self.assertTrue(r.headers["content-type"].startswith("text/plain"))
        self.assertEqual(lines(r.text), [
            {"f": "goal", "q": GOAL, "s": 3},
            {"f": "result", "q": RESULT, "s": 3},  # 말줄임표 제거, s는 1~3으로
            {"f": "limit", "q": LIMIT, "s": 1},  # 별칭 limitations → limit
        ])
        self.assertNotIn("[오류]", r.text)
        self.assertEqual(self.claude.kinds, ["stream"])
        self.assertEqual(self.claude.last["max_tokens"], skim.MAX_TOKENS)
        self.assertTrue(self.path.exists())

    def test_fenced_json_object_keeps_only_valid_facets(self):
        body = {"items": [{"f": "goal", "q": GOAL, "s": 3}, {"f": "bogus", "q": RESULT, "s": 2}]}
        self.claude.push("```json\n" + json.dumps(body) + "\n```")
        self.assertEqual(lines(self.client.get(self.url).text), [{"f": "goal", "q": GOAL, "s": 3}])

    def test_pretty_printed_json_falls_back_to_whole_parse(self):
        body = {"items": [{"f": "result", "q": RESULT, "s": 2}]}
        self.claude.push(json.dumps(body, indent=2))
        self.assertEqual(lines(self.client.get(self.url).text), [{"f": "result", "q": RESULT, "s": 2}])

    def test_second_call_is_cached(self):
        self.claude.push(L(f="goal", q=GOAL, s=3) + L(f="limit", q=LIMIT, s=2))
        first = self.client.get(self.url).text
        second = self.client.get(self.url)
        self.assertEqual(second.status_code, 200)
        self.assertEqual(second.text, first)
        self.assertEqual(len(self.claude.calls), 1)

    def test_invalid_output_502_and_not_cached(self):
        self.claude.push("죄송하지만 JSON을 만들 수 없습니다.")
        r = self.client.get(self.url)
        self.assertEqual(r.status_code, 200)  # 스트림은 이미 시작됨 → 본문 끝 '[오류]' 한 줄로 실패
        self.assertRegex(r.text, skim.ERROR_TAIL)
        self.assertEqual(lines(r.text), [])
        self.assertFalse(self.path.exists())
        self.assertEqual(self.client.get(self.url).status_code, 502)  # 기억된 실패: 새 호출 없음
        self.assertEqual(len(self.claude.calls), 1)
        self.claude.push(L(f="goal", q=GOAL, s=3))
        r = self.client.get(self.url + "?retry=1")
        self.assertEqual(lines(r.text), [{"f": "goal", "q": GOAL, "s": 3}])
        self.assertEqual(len(self.claude.calls), 2)
        self.assertTrue(self.path.exists())

    def test_bad_memory_expires(self):
        skim._bad[self.paper_id] = time.time() - core.FAIL_TTL - 1
        self.claude.push(L(f="goal", q=GOAL, s=3))
        self.assertEqual(self.client.get(self.url).status_code, 200)

    def test_api_error_mid_stream_passes_tail_and_is_not_cached(self):
        self.claude.push({"chunks": [L(f="goal", q=GOAL, s=3), L(f="result", q=RESULT, s=2)],
                          "error": api_error("down"), "error_at": 1})
        r = self.client.get(self.url)
        self.assertEqual(lines(r.text), [{"f": "goal", "q": GOAL, "s": 3}])  # 도착한 만큼은 칠할 수 있게
        self.assertRegex(r.text, skim.ERROR_TAIL)
        self.assertFalse(self.path.exists())
        self.assertEqual(self.client.get(self.url).status_code, 502)
        self.assertEqual(len(self.claude.calls), 1)

    def test_max_tokens_truncation_is_failure(self):
        self.claude.push({"chunks": [L(f="goal", q=GOAL, s=3), '{"f": "res'], "stop_reason": "max_tokens"})
        r = self.client.get(self.url)
        self.assertEqual(lines(r.text), [{"f": "goal", "q": GOAL, "s": 3}])
        self.assertIn("max_tokens", r.text.splitlines()[-1])
        self.assertFalse(self.path.exists())

    def test_prompt_asks_jsonl_with_limit_facet(self):
        self.claude.push(L(f="goal", q=GOAL, s=3))
        self.client.get(self.url)
        (prompt,) = self.claude.user_texts()
        self.assertTrue(prompt.startswith(core.TASK_PREAMBLE))
        for word in ("JSON", "Markdown", '"limit"', '"goal"', '"novelty"', '"method"', '"result"', "15~30", "선행 연구"):
            self.assertIn(word, prompt)
        self.assert_shared_call()

    def test_caps_at_30_items(self):
        self.claude.push("".join(L(f="method", q=f"Sentence number {i} of the method", s=2) for i in range(40)))
        self.assertEqual(len(lines(self.client.get(self.url).text)), skim.MAX_ITEMS)

    def test_unknown_paper_404_without_claude(self):
        r = self.client.get("/api/skim-highlights/9999.99999")
        self.assertEqual(r.status_code, 404)
        self.assertEqual(self.claude.calls, [])


class SkimProgressTests(AsyncCoreTestCase):
    def setUp(self):
        super().setUp()
        skim._bad.clear()

    async def test_lines_arrive_before_generation_ends(self):
        # 줄이 오는 대로 내보냄 → 클라이언트가 문장마다 바로 칠함 (전체 생성을 기다리지 않음)
        self.claude.push({"chunks": [L(f="goal", q=GOAL, s=3), L(f="result", q=RESULT, s=2)], "delay": 0.05})
        resp = await skim.skim_highlights(self.paper_id)
        it = resp.body_iterator.__aiter__()
        first = await it.__anext__()
        self.assertEqual(json.loads(first), {"f": "goal", "q": GOAL, "s": 3})
        self.assertFalse(core.task_path(self.paper_id, skim.NAME).exists())  # 아직 생성 중
        rest = [c async for c in it]
        self.assertEqual(json.loads("".join(rest)), {"f": "result", "q": RESULT, "s": 2})
        self.assertTrue(core.task_path(self.paper_id, skim.NAME).exists())


class SkimParseTests(CoreTestCase):
    def test_clean_item(self):
        self.assertEqual(skim.clean_item({"facet": "Contribution", "quote": "a  new\nrouting rule", "s": "3"}),
                         {"f": "novelty", "q": "a new routing rule", "s": 3})
        self.assertEqual(skim.clean_item({"f": "goal", "q": "We study routing", "s": "x"})["s"], 2)
        self.assertIsNone(skim.clean_item({"f": "goal", "q": ["not", "a", "string"]}))
        self.assertIsNone(skim.clean_item("goal"))

    def test_parse_line_variants(self):
        one = '{"f": "goal", "q": "We study sparse routing", "s": 3}'
        self.assertEqual(len(skim.parse_line(f"[{one},")), 1)
        self.assertEqual(len(skim.parse_line(f"- {one}")), 1)
        self.assertEqual(len(skim.parse_line(f"{one}, {one.replace('goal', 'limit')}")), 2)
        self.assertEqual(skim.parse_line('{"f": "goal", "q": "broken'), [])
        self.assertEqual(skim.parse_line("[오류] boom"), [])
