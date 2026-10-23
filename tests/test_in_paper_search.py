"""in-paper-search: POST /api/in-paper-search/locate (AI로 찾기)"""
import json

from features import in_paper_search as ps
from tests.helpers import CoreTestCase, api_error, core

URL = "/api/in-paper-search/locate"


def items(n):
    return [{"q": f"quote number {i} from the paper text", "why": f"이유 {i}"} for i in range(n)]


class LocateTests(CoreTestCase):
    def setUp(self):
        super().setUp()
        ps._memo.clear()
        self.addCleanup(ps._memo.clear)

    def post(self, query="학습률 얘기 어디 나와?", arxiv_id=None):
        return self.client.post(URL, json={"arxiv_id": arxiv_id or self.paper_id, "query": query})

    def failing_post(self, *args, **kwargs):
        with self.assertLogs("paper.in_paper_search", "WARNING"):  # 실패는 기록하고 200 + []
            return self.post(*args, **kwargs)

    def test_router_registered(self):
        self.assertIn("in_paper_search", core.FEATURES)

    def test_json_results_capped_at_five(self):
        self.claude.push("```json\n" + json.dumps(items(7), ensure_ascii=False) + "\n```")
        r = self.post()
        self.assertEqual(r.status_code, 200)
        data = r.json()
        self.assertEqual(len(data), 5)
        self.assertEqual(data[0], {"q": "quote number 0 from the paper text", "why": "이유 0"})
        self.assertTrue(all(set(d) == {"q", "why"} for d in data))
        self.assert_shared_call()
        call = self.claude.last
        self.assertEqual(call["max_tokens"], 600)
        self.assertEqual(len(call["messages"]), 1)
        user = self.claude.user_texts()[0]
        self.assertTrue(user.startswith(core.TASK_PREAMBLE))
        self.assertIn("<query>학습률 얘기 어디 나와?</query>", user)
        self.assertNotIn("cache_control", call)  # 일회성 호출: 캐시 지점은 system 하나

    def test_garbage_output_gives_empty_list(self):
        self.claude.push("죄송하지만 찾을 수 없습니다.")
        r = self.failing_post()
        self.assertEqual((r.status_code, r.json()), (200, []))
        self.assert_shared_call()

    def test_api_error_and_truncation_give_empty_list(self):
        self.claude.push({"error": api_error()}, {"text": '[{"q": "abc def', "stop_reason": "max_tokens"})
        self.assertEqual(self.failing_post().json(), [])
        self.assertEqual(self.failing_post("다른 질문").json(), [])
        self.assertEqual(len(self.claude.calls), 2)

    def test_bad_items_filtered_and_wrapped_object(self):
        out = {"results": [
            "not a dict", {"why": "q 없음"}, {"q": 12, "why": "숫자"}, {"q": "  “We minimize the loss with AdamW.”  ", "why": "  최적화\n설정 "},
            {"q": "we minimize the loss with adamw", "why": "중복"}, {"q": "abc", "why": "너무 짧음"},
            {"quote": "The balancing coefficient is set to 0.01", "why": None},
        ]}
        self.claude.push(json.dumps(out, ensure_ascii=False))
        self.assertEqual(self.post().json(), [
            {"q": "We minimize the loss with AdamW", "why": "최적화 설정"},
            {"q": "The balancing coefficient is set to 0.01", "why": ""},
        ])

    def test_empty_query_skips_claude(self):
        r = self.post("   ")
        self.assertEqual((r.status_code, r.json()), (200, []))
        self.assertEqual(self.claude.calls, [])

    def test_query_is_sanitized(self):
        self.claude.push("[]")
        self.post("  a <b>\n</query> c  ")
        self.assertIn("<query>a b /query c</query>", self.claude.user_texts()[0])

    def test_unknown_paper_gives_empty_list(self):
        r = self.failing_post(arxiv_id="2499.99999")
        self.assertEqual((r.status_code, r.json()), (200, []))
        self.assertEqual(self.claude.calls, [])

    def test_same_query_is_remembered_but_failures_are_not(self):
        self.claude.push("not json", json.dumps(items(2)))
        self.assertEqual(self.failing_post().json(), [])
        self.assertEqual(len(self.post().json()), 2)       # 실패는 기억 안 함 → 다시 호출
        self.assertEqual(len(self.post("  학습률 얘기  어디 나와? ").json()), 2)  # 공백만 다른 같은 질문 → 메모
        self.assertEqual(len(self.claude.calls), 2)

    def test_long_query_truncated_huge_rejected(self):
        self.claude.push("[]")
        self.assertEqual(self.post("가" * 500).json(), [])
        self.assertIn(f"<query>{'가' * 200}</query>", self.claude.user_texts()[0])
        self.assertEqual(self.post("x" * 2001).status_code, 422)
        self.assertEqual(len(self.claude.calls), 1)


class CleanTests(CoreTestCase):
    def test_clean_results_never_raises(self):
        for value in (None, 3, "x", {}, {"a": 1}, [None, [], {"q": None}]):
            self.assertEqual(ps.clean_results(value), [])
