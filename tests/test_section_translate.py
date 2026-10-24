"""section-translate: 단위 수집·자리표시·문장 나누기·번역 엔드포인트(캐시·건너뛰기·검증)"""
import json
import unittest
from unittest import mock

from bs4 import BeautifulSoup

from features import section_translate as st
from tests.helpers import CoreTestCase, core

URL = "/api/section-translate/{}"


def ko_json(*rows):
    return "```json\n" + json.dumps({"u": [{"id": i, "ko": ko} for i, ko in rows]}, ensure_ascii=False) + "\n```"


class UnitTests(CoreTestCase):
    def units(self):
        return st.collect_units(BeautifulSoup(self.paper["html"], "html.parser"))

    def test_units_are_innermost_blocks_without_duplicates(self):
        u = self.units()
        for uid in ("doc.title", "abs.title", "abs.0", "abs.1", "S1.title", "S2.SS1.title", "Thmtheorem1.title",
                    "S1.p1#0", "S1.p2#0", "S1.I1.i1.p1#0", "S2.p2#0", "S2.p2#1", "S2.F1.cap", "S2.F2.cap",
                    "S2.F2.sf1.cap", "S2.T1.cap", "footnote1.note"):
            self.assertIn(uid, u)
        # 바깥 문단(S1.p2)은 안쪽 목록 문단을 다시 담지 않음
        self.assertNotIn("S1.p2#1", u)
        self.assertNotIn("bib.title", u)  # 참고문헌은 번역 안 함
        self.assertEqual(u["S1.p2#0"][1].get_text(" ", strip=True), "Our contributions are as follows:")
        self.assertEqual({k for k, (kind, _) in u.items() if kind == "note"}, {"footnote1.note"})

    def test_placeholders_for_math_cite_note_ref(self):
        text, ph = st.unit_source(self.units()["S1.p1#0"][1])
        self.assertIn("⟦0⟧", text)
        self.assertNotIn("<math", text)
        self.assertNotIn("trained jointly", text)  # 각주 본문은 따로 단위
        self.assertEqual([p["k"] for p in ph], ["math", "math", "cite", "note", "ref"])
        self.assertEqual(ph[0], {"k": "math", "tex": "x^{2}"})
        self.assertEqual(ph[2]["text"], "[1, 2]")
        self.assertEqual(ph[3], {"k": "note", "id": "footnote1", "text": "1"})
        self.assertTrue(ph[4]["href"].startswith("https://github.com/"))

    def test_equation_table_inside_unit_is_one_block(self):
        soup = BeautifulSoup('<div class="ltx_para" id="P"><p class="ltx_p">See <a class="ltx_ref" href="#E1">1</a>'
                             '<table class="ltx_equation" id="E1"><tr><td><math alttext="a=b"></math></td>'
                             '<td><span class="ltx_tag">(1)</span></td></tr></table> done.</p></div>', "html.parser")
        text, ph = st.unit_source(st.collect_units(soup)["P#0"][1])
        self.assertEqual(text, "See ⟦0⟧⟦1⟧ done.")
        self.assertEqual(ph, [{"k": "ref", "href": "#E1", "text": "1"}, {"k": "eq", "id": "E1"}])

    def test_caption_and_title_keep_numbers(self):
        u = self.units()
        self.assertEqual(st.unit_source(u["S2.F1.cap"][1])[0][:4], "⟦0⟧A")
        text, ph = st.unit_source(u["S1.title"][1])
        self.assertEqual((text, ph), ("⟦0⟧Introduction", [{"k": "tag", "text": "1"}]))

    def test_should_skip(self):
        self.assertTrue(st.should_skip("이 문단은 한국어로 작성된 문단입니다.", "p"))
        self.assertTrue(st.should_skip("⟦0⟧ and ⟦1⟧", "p"))
        self.assertTrue(st.should_skip("⟦0⟧.", "title"))  # 'Theorem 1.'
        self.assertFalse(st.should_skip("⟦0⟧Introduction", "title"))
        self.assertFalse(st.should_skip("⟦0⟧Training loss", "cap"))
        self.assertFalse(st.should_skip("We minimize the loss.", "p"))

    def test_split_sentences(self):
        s = st.split_sentences
        self.assertEqual(s("The router computes scores as in Eq. (⟦0⟧). Figure ⟦1⟧ shows it."),
                         ["The router computes scores as in Eq. (⟦0⟧).", "Figure ⟦1⟧ shows it."])
        self.assertEqual(s("The KD loss is cheap.⟦3⟧ Our code is at ⟦4⟧."), ["The KD loss is cheap.⟦3⟧", "Our code is at ⟦4⟧."])
        self.assertEqual(s("Results improve by 2.3 points, e.g. On MMLU. As shown by Smith et al. In 2023."),
                         ["Results improve by 2.3 points, e.g. On MMLU.", "As shown by Smith et al. In 2023."])
        self.assertEqual(s("Written by A. Author. Then we go. ⟦0⟧ is small."), ["Written by A. Author.", "Then we go.", "⟦0⟧ is small."])
        self.assertEqual(s("one sentence only"), ["one sentence only"])

    def test_clean_ko_checks_placeholders(self):
        self.assertEqual(st.clean_ko(["⟦ 0 ⟧에 비례", "끝 ⟦1⟧."], 2), ["⟦0⟧에 비례", "끝 ⟦1⟧."])
        for bad in (["⟦0⟧ ⟦0⟧ ⟦1⟧"], ["⟦0⟧만"], ["⟦0⟧ ⟦1⟧ ⟦2⟧"], [""], [1], None):
            with self.assertRaises(ValueError):
                st.clean_ko(bad, 2)
        self.assertEqual(st.pairs(["a", "b"], ["가", "나"]), [["a", "가"], ["b", "나"]])
        self.assertEqual(st.pairs(["a", "b"], ["가나"]), [["a b", "가나"]])


class EndpointTests(CoreTestCase):
    def post(self, ids, **kw):
        return self.client.post(URL.format(self.paper_id), json={"ids": ids, **kw})

    def s1p1_reply(self):
        return ko_json(("S1.p1#0", ["대규모 언어 모델은 잘 확장되지만 밀집 계산은 너비 ⟦1⟧인 모델에서 ⟦0⟧로 늘어납니다.",
                                    "각 토큰을 두 전문가로 보내는 희소 전문가 혼합(sparse mixture of experts) 모델을 제안합니다 ⟦2⟧.",
                                    "지식 증류(KD)가 라우터를 압축하며 KD 손실은 저렴합니다.⟦3⟧",
                                    "구현은 ⟦4⟧에 있습니다."]))

    def test_translate_returns_pairs_and_uses_shared_prefix(self):
        self.claude.push(self.s1p1_reply())
        r = self.post(["S1.p1#0"])
        self.assertEqual(r.status_code, 200)
        unit = r.json()["S1.p1#0"]
        self.assertEqual(len(unit["s"]), 4)
        self.assertEqual(unit["s"][0][0], "Large language models scale well, but dense computation grows as ⟦0⟧ for a model of width ⟦1⟧.")
        self.assertTrue(unit["s"][3][1].startswith("구현은"))
        self.assertEqual([p["k"] for p in unit["ph"]], ["math", "math", "cite", "note", "ref"])
        self.assertEqual(unit["fp"], st.fingerprint(core.el_text(st.collect_units(BeautifulSoup(self.paper["html"], "html.parser"))["S1.p1#0"][1])))
        prompt = self.claude.user_texts()[0]
        self.assertIn("⟦0⟧", prompt)
        self.assertNotIn("<math", prompt)
        self.assertNotIn("trained jointly", prompt)
        self.assertIn('"S1.p1#0"', prompt)
        self.assertTrue(prompt.startswith(core.TASK_PREAMBLE))
        self.assertEqual(self.claude.last["max_tokens"], st.MAX_TOKENS)
        self.assert_shared_call()

    def test_second_request_is_served_from_disk_cache(self):
        self.claude.push(self.s1p1_reply())
        first = self.post(["S1.p1#0"]).json()
        self.assertEqual(len(self.claude.calls), 1)
        self.assertTrue(core.task_path(self.paper_id, "section-translate").exists())
        core._soups.clear()  # 새로 파싱해도 (같은 본문) 캐시 적중
        self.assertEqual(self.post(["S1.p1#0"]).json(), first)
        self.assertEqual(len(self.claude.calls), 1)

    def test_korean_unit_is_skipped_without_claude(self):
        r = self.post(["S1.p3#0", "Thmtheorem1.title"])
        self.assertEqual(r.json(), {"S1.p3#0": {"skip": True}, "Thmtheorem1.title": {"skip": True}})
        self.assertEqual(self.claude.calls, [])

    def test_unknown_ids_ignored(self):
        self.assertEqual(self.post(["nope#0", "S9.title"]).json(), {})
        self.assertEqual(self.claude.calls, [])

    def test_malformed_json_502_and_nothing_cached(self):
        self.claude.push("번역할 수 없습니다")
        r = self.post(["S1.p2#0", "nope#0"])
        self.assertEqual(r.status_code, 502)
        self.assertFalse(core.task_path(self.paper_id, "section-translate").exists())

    def test_truncated_reply_is_502(self):
        self.claude.push({"text": '{"u": [{"id": "S1.p2#0", "ko": ["우리', "stop_reason": "max_tokens"})
        self.assertEqual(self.post(["S1.p2#0"]).status_code, 502)
        self.assertFalse(core.task_path(self.paper_id, "section-translate").exists())

    def test_bad_unit_is_not_cached_but_good_ones_are(self):
        # S2.p1#0 자리표시 ⟦3⟧ 누락 → 그 단위만 실패, S1.p2#0은 저장
        self.claude.push(ko_json(("S1.p2#0", ["기여는 다음과 같습니다:"]),
                                 ("S2.p1#0", ["라우터는 식 (⟦0⟧)처럼 점수를 계산합니다.", "그림 ⟦1⟧, 표 ⟦2⟧."]),
                                 ("S9.p9#0", ["모르는 단위"])))
        out = self.post(["S1.p2#0", "S2.p1#0"]).json()
        self.assertEqual(out["S1.p2#0"]["s"], [["Our contributions are as follows:", "기여는 다음과 같습니다:"]])
        self.assertIn("err", out["S2.p1#0"])
        cache = core.read_json(core.task_path(self.paper_id, "section-translate"), {})
        self.assertEqual(len(cache), 1)
        self.assertTrue(next(iter(cache)).startswith("S1.p2#0:"))
        # 다시 요청하면 실패한 단위만 Claude에
        self.claude.push(ko_json(("S2.p1#0", ["라우터는 식 (⟦0⟧)처럼 점수를 계산합니다.", "그림 ⟦1⟧, 표 ⟦2⟧, 절 ⟦3⟧."])))
        out = self.post(["S1.p2#0", "S2.p1#0"]).json()
        self.assertEqual(len(out["S2.p1#0"]["s"]), 2)
        self.assertNotIn('"S1.p2#0"', self.claude.user_texts()[0])

    def test_non_string_ids_are_dropped_without_losing_good_rows(self):
        # 목록·객체 id(해시 불가)는 그 줄만 버리고, 같은 응답의 올바른 줄은 저장 (500이 아님)
        self.claude.push(json.dumps({"u": [{"id": ["S1.p2#0"], "ko": ["x"]}, {"id": {"a": 1}, "ko": ["y"]}, {"id": 7, "ko": ["z"]},
                                           {"id": "S1.p2#0", "ko": ["기여는 다음과 같습니다:"]}]}, ensure_ascii=False))
        r = self.post(["S1.p2#0", "abs.0"])
        self.assertEqual(r.status_code, 200)
        out = r.json()
        self.assertEqual(out["S1.p2#0"]["s"], [["Our contributions are as follows:", "기여는 다음과 같습니다:"]])
        self.assertIn("err", out["abs.0"])
        cache = core.read_json(core.task_path(self.paper_id, "section-translate"), {})
        self.assertEqual([k.split(":")[0] for k in cache], ["S1.p2#0"])

    def test_sentence_count_mismatch_collapses_to_one_pair(self):
        self.claude.push(ko_json(("abs.0", ["두 문장을 한 문장으로 합친 번역입니다."])))
        s = self.post(["abs.0"]).json()["abs.0"]["s"]
        self.assertEqual(len(s), 1)
        self.assertTrue(s[0][0].startswith("We propose") and s[0][0].endswith("per token."))

    def test_titles_batch_and_force(self):
        self.claude.push(ko_json(("S1.title", ["⟦0⟧서론"]), ("S2.title", ["⟦0⟧방법"])))
        out = self.post(["S1.title", "S2.title"]).json()
        self.assertEqual(out["S1.title"]["s"], [["⟦0⟧Introduction", "⟦0⟧서론"]])
        self.assertIn('"t": "title"', self.claude.user_texts()[0])
        self.post(["S1.title"])
        self.assertEqual(len(self.claude.calls), 1)
        self.claude.push(ko_json(("S1.title", ["⟦0⟧들어가며"])))
        out = self.post(["S1.title"], force=True).json()
        self.assertEqual(out["S1.title"]["s"][0][1], "⟦0⟧들어가며")
        self.assertEqual(self.post(["S1.title"]).json()["S1.title"]["s"][0][1], "⟦0⟧들어가며")
        self.assertEqual(len(self.claude.calls), 2)

    def test_limits(self):
        self.assertEqual(self.post([f"x{i}" for i in range(st.MAX_IDS + 1)]).status_code, 422)
        with mock.patch.object(st, "MAX_CHARS", 50):
            self.assertEqual(self.post(["abs.0", "S1.p1#0"]).status_code, 413)
        self.assertEqual(self.claude.calls, [])

    def test_missing_paper_404(self):
        r = self.client.post(URL.format("2501.99999"), json={"ids": ["S1.p1#0"]})
        self.assertEqual(r.status_code, 404)


if __name__ == "__main__":
    unittest.main()
