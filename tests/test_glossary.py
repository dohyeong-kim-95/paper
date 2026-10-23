"""glossary: GET /api/glossary/{id} — 파싱·정리(validate)·목록 30개 제한·캐시(재호출 0회)·실패 기억·공유 프롬프트"""
import json

from features import glossary as g
from tests.helpers import CoreTestCase, core


def reply(terms=(), symbols=()):
    return "```json\n" + json.dumps({"terms": list(terms), "symbols": list(symbols)}, ensure_ascii=False) + "\n```"


KD = {"t": "Knowledge distillation", "a": ["KD"], "ko": "지식 증류", "d": "큰 모델의 지식을 작은 모델로 옮기는 학습",
      "q": "Knowledge distillation (KD) compresses the router"}
ALPHA = {"tex": "\\alpha", "d": "균형 손실 계수", "q": "is a small coefficient"}


class GlossaryEndpointTests(CoreTestCase):
    def get(self, **params):
        return self.client.get(f"/api/glossary/{self.paper_id}", params=params)

    def test_parses_terms_and_symbols(self):
        self.claude.push(reply([KD], [ALPHA]))
        r = self.get()
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.headers.get("x-offline-cacheable"), "1")
        data = r.json()
        self.assertEqual(data["terms"], [{"t": "Knowledge distillation", "a": ["KD"], "ko": "지식 증류", "d": KD["d"], "q": KD["q"],
                                          "defs": [{"d": KD["d"], "q": KD["q"]}]}])
        self.assertEqual(data["symbols"], [{"tex": "\\alpha", "d": ALPHA["d"], "q": ALPHA["q"], "defs": [{"d": ALPHA["d"], "q": ALPHA["q"]}]}])

    def test_one_shared_call_with_prompt_in_user_turn(self):
        self.claude.push(reply([KD]))
        self.get()
        self.assertEqual(len(self.claude.calls), 1)
        self.assertEqual(self.claude.kinds, ["create"])
        call = self.claude.last
        self.assertEqual(call["max_tokens"], 8000)
        self.assertNotIn("cache_control", call)  # 일회성 작업: system 캐시 지점 하나만
        (user,) = self.claude.user_texts()
        self.assertTrue(user.startswith(core.TASK_PREAMBLE))
        self.assertIn('"terms"', user)
        self.assertIn('"symbols"', user)
        self.assert_shared_call()

    def test_cached_second_call_makes_no_claude_call(self):
        self.claude.push(reply([KD], [ALPHA]))
        first = self.get().json()
        self.assertTrue(core.task_path(self.paper_id, "glossary.v1").exists())
        second = self.get()
        self.assertEqual(second.json(), first)
        self.assertEqual(len(self.claude.calls), 1)

    def test_lists_capped_at_30(self):
        terms = [{"t": f"term{i}", "ko": f"용어{i}", "d": f"정의 {i}", "q": ""} for i in range(40)]
        symbols = [{"tex": f"x_{{{i}}}", "d": f"기호 {i}", "q": ""} for i in range(40)]
        self.claude.push(reply(terms, symbols))
        data = self.get().json()
        self.assertEqual(len(data["terms"]), 30)
        self.assertEqual(len(data["symbols"]), 30)
        self.assertEqual(data["terms"][0]["t"], "term0")

    def test_position_sensitive_definitions_are_grouped(self):
        # 같은 기호가 섹션마다 다른 뜻으로 다시 정의 → 한 항목의 defs 여러 개 (순서 유지), 공백·\displaystyle·{i} 차이는 같은 기호
        self.claude.push(reply(
            [KD, {**KD, "t": "knowledge distillation", "d": "두 번째 정의", "q": "the KD loss is cheap"}],
            [{"tex": "f_{i}", "d": "전문가 i의 토큰 비율", "q": "q1"},
             {"tex": "\\displaystyle f_i", "d": "전문가 i의 부하", "q": "q2"},
             {"tex": "f_{i}", "d": "전문가 i의 토큰 비율", "q": "q1"}],
        ))
        data = self.get().json()
        self.assertEqual(len(data["terms"]), 1)
        self.assertEqual([d["q"] for d in data["terms"][0]["defs"]], [KD["q"], "the KD loss is cheap"])
        self.assertEqual(len(data["symbols"]), 1)
        sym = data["symbols"][0]
        self.assertEqual(sym["tex"], "f_{i}")
        self.assertEqual([d["d"] for d in sym["defs"]], ["전문가 i의 토큰 비율", "전문가 i의 부하"])  # 중복 정의는 한 번
        self.assertEqual((sym["d"], sym["q"]), ("전문가 i의 토큰 비율", "q1"))

    def test_bad_items_are_dropped_and_fields_cleaned(self):
        self.claude.push(reply(
            [{"t": "  Mixture   of experts ", "a": "MoE", "ko": "전문가 혼합", "d": " 여러  전문가 중 일부만 쓰는 구조 "},
             {"t": "", "ko": "빈 용어", "d": "x"}, {"t": "no def", "ko": "정의 없음"}, "문자열", None,
             {"t": "router", "a": ["router", "Router", 3, "gate", "g2", "g3"], "ko": "라우터", "d": "토큰을 전문가에 보냄", "q": 5}],
            [{"tex": "$W_{g}$", "d": "게이트 가중치"}, {"tex": "", "d": "빈 기호"}, {"tex": "N"}],
        ))
        data = self.get().json()
        moe, router = data["terms"]
        self.assertEqual((moe["t"], moe["a"], moe["d"], moe["q"]), ("Mixture of experts", ["MoE"], "여러 전문가 중 일부만 쓰는 구조", ""))
        self.assertEqual(router["a"], ["gate", "g2", "g3"])  # 자기 자신·숫자 제외, 최대 3개
        self.assertEqual(router["q"], "")
        self.assertEqual([s["tex"] for s in data["symbols"]], ["W_{g}"])

    def test_brief_flat_shape_and_defs_shape_both_accepted(self):
        self.claude.push(reply([], [{"tex": "\\alpha", "defs": [{"d": "계수", "q": "a"}, {"d": "학습률", "q": "b"}]}]))
        sym = self.get().json()["symbols"][0]
        self.assertEqual([d["d"] for d in sym["defs"]], ["계수", "학습률"])

    def test_invalid_json_is_502_not_cached_and_remembered(self):
        self.claude.push("용어를 정리하면 다음과 같습니다 (JSON 아님)")
        r = self.get()
        self.assertEqual(r.status_code, 502)
        self.assertFalse(core.task_path(self.paper_id, "glossary.v1").exists())
        self.assertEqual(self.get().status_code, 502)  # 10분 동안 다시 부르지 않음
        self.assertEqual(len(self.claude.calls), 1)
        self.claude.push(reply([KD]))
        r = self.get(retry=1)  # 상태 칩의 '다시'
        self.assertEqual(r.status_code, 200)
        self.assertEqual(len(self.claude.calls), 2)

    def test_empty_lists_fail(self):
        self.claude.push(reply([], []))
        self.assertEqual(self.get().status_code, 502)
        self.assertFalse(core.task_path(self.paper_id, "glossary.v1").exists())

    def test_truncated_reply_fails(self):
        self.claude.push({"text": reply([KD])[:40], "stop_reason": "max_tokens"})
        self.assertEqual(self.get().status_code, 502)
        self.assertFalse(core.task_path(self.paper_id, "glossary.v1").exists())

    def test_unknown_paper_404_without_claude_call(self):
        r = self.client.get("/api/glossary/2499.99999")
        self.assertEqual(r.status_code, 404)
        self.assertEqual(self.claude.calls, [])

    def test_router_registered(self):
        self.assertIn("glossary", core.FEATURES)


class CleanTests(CoreTestCase):
    def test_not_an_object(self):
        for bad in ([], "x", None, 3):
            with self.assertRaises(ValueError):
                g.clean(bad)

    def test_tex_key(self):
        self.assertEqual(g._tex_key("\\displaystyle f_{i}"), g._tex_key("f_i"))
        self.assertEqual(g._tex_key("x^{2}"), g._tex_key("x ^ 2"))
        self.assertNotEqual(g._tex_key("\\mathcal{L}"), g._tex_key("L"))

    def test_defs_capped(self):
        out = g.clean({"symbols": [{"tex": "x", "d": f"뜻 {i}", "q": str(i)} for i in range(10)]})
        self.assertEqual(len(out["symbols"][0]["defs"]), g.MAX_DEFS)
