"""section-study 테스트: 섹션 요약(gists)·섹션 퀴즈 엔드포인트 (가짜 Claude, 시드 논문)"""
import json

from tests.helpers import CoreTestCase, core

from features.section_study import clean_gists, clean_quiz

GISTS = {"S1": "희소 MoE를 제안한다.", "S2": "라우터와 손실을 설명한다.", "S2.SS1": "AdamW로 학습한다.",
         "A1": "전문가별 부하를 보고한다.", "S99": "없는 섹션"}


def item(q="왜 두 전문가인가?", choices=("계산량", "정확도", "메모리", "속도"), a=0, **kw):
    return {"q": q, "choices": list(choices), "a": a, "why": "해설", "quote": "routes each token to two experts", **kw}


class GistTests(CoreTestCase):
    def url(self, retry=False):
        return f"/api/section-study/{self.paper_id}/gists" + ("?retry=1" if retry else "")

    def test_prompt_lists_sections_and_unknown_keys_dropped(self):
        self.claude.push("```json\n" + json.dumps(GISTS, ensure_ascii=False) + "\n```")
        r = self.client.get(self.url())
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.headers.get("x-offline-cacheable"), "1")
        data = r.json()
        self.assertEqual(list(data), ["S1", "S2", "S2.SS1", "A1"])  # S99 제거, 목록 순서
        prompt = self.claude.user_texts()[0]
        self.assertTrue(prompt.startswith(core.TASK_PREAMBLE))
        for line in ("- S1: 1 Introduction", "- S2: 2 Method", "- S2.SS1: 2.1 Training objective",
                     "- A1: Appendix A Additional results"):
            self.assertIn(line, prompt)
        self.assertNotIn("bib", prompt)
        self.assertEqual(self.claude.last["max_tokens"], 8000)
        self.assertEqual(self.claude.kinds, ["create"])
        self.assertNotIn("cache_control", self.claude.last)  # 일회성 작업: 캐시 지점은 system 하나
        self.assert_shared_call()
        # 두 번째는 디스크 캐시: Claude 호출 없음
        r2 = self.client.get(self.url())
        self.assertEqual(r2.json(), data)
        self.assertEqual(len(self.claude.calls), 1)
        self.assertTrue(core.task_path(self.paper_id, "section-study.gists.v1").exists())

    def test_bad_output_is_502_not_cached_and_remembered(self):
        self.claude.push("요약을 못 했습니다", json.dumps({"S99": "x"}), json.dumps({"S1": "요약"}))
        self.assertEqual(self.client.get(self.url()).status_code, 502)
        self.assertEqual(self.client.get(self.url()).status_code, 502)  # 10분 동안 기억 → 호출 없음
        self.assertEqual(len(self.claude.calls), 1)
        self.assertEqual(self.client.get(self.url(retry=True)).status_code, 502)  # 모르는 키뿐 → 실패
        r = self.client.get(self.url(retry=True))
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json(), {"S1": "요약"})
        self.assertEqual(len(self.claude.calls), 3)

    def test_truncated_output_fails(self):
        self.claude.push({"text": '{"S1": "잘린', "stop_reason": "max_tokens"})
        self.assertEqual(self.client.get(self.url()).status_code, 502)
        self.assertFalse(core.task_path(self.paper_id, "section-study.gists.v1").exists())

    def test_paper_without_sections_makes_no_call(self):
        pid = "2401.99999"
        core.papers[pid] = core.clean_article('<article class="ltx_document"><p class="ltx_p">Just text.</p></article>',
                                              f"https://arxiv.org/html/{pid}")
        self.addCleanup(core.papers.pop, pid, None)
        r = self.client.get(f"/api/section-study/{pid}/gists")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json(), {})
        self.assertEqual(self.claude.calls, [])

    def test_clean_gists_shapes(self):
        ids = ["S1", "S2"]
        self.assertEqual(clean_gists({"gists": {"S2": " b ", "S1": "a"}}, ids), {"S1": "a", "S2": "b"})
        self.assertEqual(clean_gists([{"id": "S2", "gist": "b"}, {"id": "S9", "gist": "z"}], ids), {"S2": "b"})
        self.assertEqual(len(clean_gists({"S1": "가" * 5000}, ids)["S1"]), 600)
        for bad in ([], "text", {"S1": ""}, {"S1": 3}, {"S9": "x"}):
            with self.assertRaises(ValueError):
                clean_gists(bad, ids)


class QuizTests(CoreTestCase):
    def url(self, sid="S2", retry=False):
        return f"/api/section-study/{self.paper_id}/quiz/{sid}" + ("?retry=1" if retry else "")

    def test_valid_quiz_and_bad_items_dropped(self):
        items = [
            item(q="Q1"), item(q="Q2", a=2),
            item(q="BAD 3 choices", choices=("a", "b", "c")),
            item(q="BAD a=7", a=7),
            item(q="BAD bool a", a=True),
            item(q="BAD dup", choices=("a", "a", "b", "c")),
            item(q="Q3", a="3"),
            item(q="Q4 넘침"),
        ]
        self.claude.push(json.dumps(items, ensure_ascii=False))
        r = self.client.get(self.url())
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.headers.get("x-offline-cacheable"), "1")
        data = r.json()
        self.assertEqual([x["q"] for x in data], ["Q1", "Q2", "Q3"])
        src = {"Q1": item(), "Q2": item(a=2), "Q3": item(a=3)}
        for x in data:
            self.assertEqual(len(x["choices"]), 4)
            self.assertIn(x["a"], range(4))
            # 섞어도 정답 글자는 그대로
            orig = src[x["q"]]
            self.assertEqual(x["choices"][x["a"]], orig["choices"][int(orig["a"])])
            self.assertEqual(sorted(x["choices"]), sorted(orig["choices"]))
            self.assertEqual(x["why"], "해설")
            self.assertEqual(x["quote"], "routes each token to two experts")
        prompt = self.claude.user_texts()[0]
        self.assertIn('"2 Method"', prompt)
        self.assertIn("id S2", prompt)
        self.assertEqual(self.claude.last["max_tokens"], 2000)
        self.assert_shared_call()
        # 캐시: 두 번째는 호출 없음, 이름은 section-study.quiz.<id>.v1
        self.assertEqual(self.client.get(self.url()).json(), data)
        self.assertEqual(len(self.claude.calls), 1)
        self.assertTrue(core.task_path(self.paper_id, "section-study.quiz.S2.v1").exists())

    def test_unknown_section_404_without_claude(self):
        for sid in ("S99", "bib", "S2.SS1x"):
            self.assertEqual(self.client.get(self.url(sid)).status_code, 404)
        self.assertEqual(self.claude.calls, [])

    def test_subsection_and_appendix_ok(self):
        self.claude.push(json.dumps([item()]), json.dumps({"quiz": [item()]}))
        self.assertEqual(self.client.get(self.url("S2.SS1")).status_code, 200)
        self.assertEqual(len(self.client.get(self.url("A1")).json()), 1)
        self.assertTrue(core.task_path(self.paper_id, "section-study.quiz.S2.SS1.v1").exists())

    def test_all_bad_items_is_502(self):
        self.claude.push(json.dumps([item(a=9), {"q": "x"}]), "not json")
        self.assertEqual(self.client.get(self.url()).status_code, 502)
        self.assertEqual(self.client.get(self.url(retry=True)).status_code, 502)
        self.assertEqual(len(self.claude.calls), 2)
        self.assertFalse(core.task_path(self.paper_id, "section-study.quiz.S2.v1").exists())

    def test_shuffle_is_deterministic(self):
        raw = [item(q=f"Q{i}", a=i % 4) for i in range(3)]
        a, b = clean_quiz(json.loads(json.dumps(raw)), "S1"), clean_quiz(json.loads(json.dumps(raw)), "S1")
        self.assertEqual(a, b)  # 같은 입력 → 같은 순서 (다시 생성해도 안정)
        for x, r in zip(a, raw):
            self.assertEqual(x["choices"][x["a"]], r["choices"][r["a"]])
