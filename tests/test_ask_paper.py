"""ask-paper: POST /api/ask-paper/followups (후속 질문 칩)"""
import unittest

from features.ask_paper import FOLLOWUP_PROMPT, clean_followups
from tests.helpers import CoreTestCase, api_error, core

URL = "/api/ask-paper/followups"
HISTORY = [
    {"role": "user", "content": "핵심 기여를 정리해줘"},
    {"role": "assistant", "content": "A1 답변"},
]


def block_text(content):
    return content if isinstance(content, str) else "".join(b["text"] for b in content)


class FollowupTests(CoreTestCase):
    def post(self, **body):
        return self.client.post(URL, json={"arxiv_id": self.paper_id, "history": HISTORY, **body})

    def test_fenced_json_first_three(self):
        self.claude.push('```json\n["a","b","c","d"]\n```')
        r = self.post()
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json(), ["a", "b", "c"])
        self.assertEqual(self.claude.kinds, ["create"])
        self.assertEqual(self.claude.last["max_tokens"], 200)
        self.assert_shared_call()

    def test_messages_are_build_messages_plus_instruction(self):
        body = core.Ask(arxiv_id=self.paper_id, selection="SEL", context="CTX", section="2 Method",
                        history=HISTORY + [{"role": "user", "content": "Q2"}, {"role": "assistant", "content": "A2"}])
        self.claude.push('["x"]')
        r = self.client.post(URL, json=body.model_dump())
        self.assertEqual(r.json(), ["x"])
        sent = self.claude.last["messages"]
        expected = core.build_messages(body)
        # 마지막 지시 턴을 뺀 앞부분 = build_messages (마지막 assistant만 같은 글자의 블록 + 캐시 지점)
        self.assertEqual(len(sent), len(expected) + 1)
        self.assertEqual(sent[:-2], expected[:-1])
        self.assertEqual(sent[-2]["role"], "assistant")
        self.assertEqual(sent[-2]["content"], [{"type": "text", "text": "A2", "cache_control": {"type": "ephemeral"}}])
        self.assertEqual(block_text(sent[-2]["content"]), expected[-1]["content"])
        self.assertEqual(sent[-1], {"role": "user", "content": FOLLOWUP_PROMPT})  # 프리앰블 없음
        self.assertTrue(sent[0]["content"].startswith("<highlight>\nSEL\n</highlight>"))
        # top-level cache_control 없음: 캐시 지점은 system + 마지막 답변 (최대 4개 안)
        self.assertNotIn("cache_control", self.claude.last)
        self.assert_shared_call()

    def test_next_ask_prefix_matches_followup_prefix(self):
        # 후속 질문 호출이 남긴 캐시 항목(마지막 답변까지)을 다음 /api/ask가 그대로 읽을 수 있음: 같은 글자
        self.claude.push('["다음 질문"]')
        self.post(selection="S", context="C")
        followup = self.claude.last["messages"][:-1]
        self.client.post("/api/ask", json={"arxiv_id": self.paper_id, "selection": "S", "context": "C",
                                           "history": HISTORY, "question": "다음 질문"})
        ask = self.claude.last["messages"]
        self.assertEqual([(m["role"], block_text(m["content"])) for m in ask[:-1]],
                         [(m["role"], block_text(m["content"])) for m in followup])
        self.assertEqual(ask[-1], {"role": "user", "content": "다음 질문"})

    def test_question_field_is_ignored(self):
        self.claude.push('["x"]')
        self.post(question="이건 무시")
        users = self.claude.user_texts()
        self.assertEqual(users, [HISTORY[0]["content"], FOLLOWUP_PROMPT])

    def test_non_json_output_is_empty_200(self):
        self.claude.push("1. 첫 질문\n2. 둘째 질문")
        r = self.post()
        self.assertEqual((r.status_code, r.json()), (200, []))

    def test_model_failures_are_empty_200(self):
        self.claude.push({"text": '["a", "b', "stop_reason": "max_tokens"}, {"error": api_error()})
        for _ in range(2):
            r = self.post()
            self.assertEqual((r.status_code, r.json()), (200, []))
        self.assertEqual(len(self.claude.calls), 2)

    def test_filters_and_wrapped_object(self):
        self.claude.push('{"questions": ["  왜   top-2인가? ", 3, "", "' + "가" * 41 + '", "왜 top-2인가?", "핵심 기여를 정리해줘", "비용은?", "c", "d"]}')
        r = self.post()
        self.assertEqual(r.json(), ["왜 top-2인가?", "비용은?", "c"])

    def test_bad_history_400_without_claude_call(self):
        for history in ([], [{"role": "user", "content": "Q"}],
                        [{"role": "assistant", "content": "A"}]):
            with self.subTest(history=history):
                r = self.client.post(URL, json={"arxiv_id": self.paper_id, "history": history})
                self.assertEqual(r.status_code, 400)
        self.assertEqual(self.claude.calls, [])

    def test_unknown_paper_404(self):
        r = self.client.post(URL, json={"arxiv_id": "2501.99999", "history": HISTORY})
        self.assertEqual(r.status_code, 404)
        self.assertEqual(self.claude.calls, [])


class CleanFollowupsTests(unittest.TestCase):
    def test_clean(self):
        self.assertEqual(clean_followups(["a", "b", "c", "d"]), ["a", "b", "c"])
        self.assertEqual(clean_followups("not a list"), [])
        self.assertEqual(clean_followups({"x": 1}), [])
        self.assertEqual(clean_followups(["Q", "q2"], asked=[" Q "]), ["q2"])
