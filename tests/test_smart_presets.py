"""smart-presets는 클라이언트 전용: 번들에 실리는지, 바뀐 질문(<style>)·<reader> 문맥이 /api/ask에서 캐시 앞부분을 지키는지"""
from tests.helpers import CoreTestCase, core

STYLE = "\n\n<style>길이: 짧게(5문장 이내) · 독자: 대학원생</style>"
READER = "<reader>관심 분야: 컴퓨터 비전 (관련 있으면 이 분야의 예·비유로 설명)</reader>"


class SmartPresetsTests(CoreTestCase):
    def test_bundle_has_feature(self):
        names = core.feature_assets()["names"]
        self.assertIn("smart-presets.js", names)
        self.assertIn("smart-presets.css", names)
        js = self.client.get(core.feature_assets()["js"]).text
        self.assertIn("/* ---- smart-presets.js ---- */", js)  # 파일마다 new Function으로 감싸 실림
        css = self.client.get(core.feature_assets()["css"]).text
        self.assertIn(".sp-style", css)

    def test_followups_keep_first_turn_bytes(self):
        """세션 훅이 context 끝에 붙인 <reader>는 첫 user 턴의 <context> 안에만, 기록에 저장된 바뀐 질문은 그대로 → 앞 턴 바이트 동일"""
        self.claude.push({"chunks": ["뜻: ", "**전문가**"]}, {"chunks": ["더 쉽게: …"]})
        base = {"arxiv_id": self.paper_id, "selection": "experts", "context": f"We propose a sparse mixture.\n{READER}",
                "section": "1 Introduction"}
        q1 = "선택한 표현의 한국어 뜻을 사전처럼 알려줘" + STYLE
        r1 = self.client.post("/api/ask", json={**base, "question": q1})
        self.assertEqual(r1.status_code, 200)
        first = self.claude.calls[0]["messages"]
        self.assertEqual(len(first), 1)
        self.assertIn(f"<context>\n<section>1 Introduction</section>\nWe propose a sparse mixture.\n{READER}\n</context>", first[0]["content"])
        self.assertTrue(first[0]["content"].endswith(q1))

        q2 = "더 쉽게" + STYLE.replace("짧게(5문장 이내)", "자세히(단계·예시 포함)")
        history = [{"role": "user", "content": q1}, {"role": "assistant", "content": r1.text}]
        r2 = self.client.post("/api/ask", json={**base, "question": q2, "history": history})
        self.assertEqual(r2.status_code, 200)
        second = self.claude.calls[1]["messages"]
        self.assertEqual(second[0]["content"], first[0]["content"], "첫 user 턴이 바이트까지 같아야 캐시 적중")
        self.assertEqual(second[1]["content"], "뜻: **전문가**")
        self.assertEqual(second[2]["content"], q2)
        self.assertNotIn("<reader>", second[2]["content"])
        for call in self.claude.calls:
            self.assert_shared_call(call)
            self.assertNotIn("<style>", str(call["system"]))
