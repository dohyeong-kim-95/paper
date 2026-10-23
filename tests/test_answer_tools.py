"""answer-tools: 👍/👎 기록(/api/feedback, 기반 라우트), 근거 요청이 붙은 질문의 캐시 앞부분 유지, 번들 포함"""
import json
import re
from pathlib import Path

from tests.helpers import CoreTestCase, core

ROOT = Path(__file__).resolve().parent.parent
JS = ROOT / "static" / "features" / "answer-tools.js"


def evidence_ask() -> str:
    # JS의 EVIDENCE_ASK 문자열 그대로 (질문 훅이 붙이는 것과 같은 바이트)
    m = re.search(r"const EVIDENCE_ASK = '((?:[^'\\]|\\.)*)';", JS.read_text(encoding="utf-8"))
    return m.group(1).replace("\\n", "\n")


class AnswerFeedbackTests(CoreTestCase):
    def vote(self, **body):
        return self.client.post("/api/feedback", json={"kind": "answer", "arxiv_id": self.paper_id, **body})

    def test_down_vote_appends_one_line(self):
        log = self.cache / "feedback.jsonl"
        self.assertEqual(self.vote(vote="up", target="t1:0").status_code, 200)
        before = len(log.read_text().splitlines())
        r = self.vote(vote="down", target="t1:1", label="easy", question="질문" * 400, answer_len=321)
        self.assertEqual((r.status_code, r.json()), (200, {"ok": True}))
        lines = log.read_text().splitlines()
        self.assertEqual(len(lines), before + 1)
        rec = json.loads(lines[-1])
        self.assertEqual((rec["kind"], rec["vote"], rec["target"], rec["label"], rec["answer_len"]),
                         ("answer", "down", "t1:1", "easy", 321))
        self.assertLessEqual(len(rec["question"]), 300)
        self.assertIsInstance(rec["ts"], int)

    def test_bad_vote_is_422_and_not_logged(self):
        self.assertEqual(self.vote(vote="meh").status_code, 422)
        self.assertFalse((self.cache / "feedback.jsonl").exists())
        self.assertEqual(self.claude.calls, [])


class EvidencePrefixTests(CoreTestCase):
    def test_follow_up_with_evidence_question_keeps_first_turn_bytes(self):
        ev = evidence_ask()
        self.assertTrue(ev.startswith("\n\n(") and '근거: "' in ev)
        body = dict(arxiv_id=self.paper_id, selection="We propose a sparse mixture", context="CTX", section="1 Introduction")
        q1 = "쉽게 설명해줘" + ev
        self.claude.push('답입니다.\n근거: "we propose a sparse mixture of experts"')
        r = self.client.post("/api/ask", json={**body, "question": q1})
        self.assertIn("근거:", r.text)
        first = self.claude.last["messages"][0]["content"]
        self.assertTrue(first.endswith(q1))
        self.assertEqual(first.count("근거: \""), 1)
        history = [{"role": "user", "content": q1}, {"role": "assistant", "content": r.text}]
        self.client.post("/api/ask", json={**body, "question": "더 자세히" + ev, "history": history})
        msgs = self.claude.last["messages"]
        self.assertEqual(msgs[0]["content"], first)  # 첫 user 턴 바이트 그대로 → 대화 앞부분 캐시 적중
        self.assertEqual(msgs[1]["content"], r.text)
        self.assertEqual(msgs[2]["content"], "더 자세히" + ev)
        self.assert_shared_call()


class BundleTests(CoreTestCase):
    def test_feature_files_are_bundled(self):
        js = self.client.get("/features.js").text
        self.assertIn("features/answer-tools.js", js)
        self.assertIn('registerFeature(\\"answer-tools\\"', js)
        css = self.client.get("/features.css").text
        self.assertIn(".at-ev-chip", css)
        page = self.client.get(f"/paper/{self.paper_id}").text
        self.assertIn(core.feature_assets()["js"], page)
