"""figure-explain: POST /api/figure-explain/ask (이미지 블록·SSRF 방지·이어지는 질문의 같은 바이트)"""
import base64

from features.figure_explain import decode_image
from tests.helpers import CoreTestCase, api_error, core, seed_paper

IMG = "https://arxiv.org/html/2401.00001v1/"
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00fakepngbody" * 4
JPG = b"\xff\xd8\xff\xe0" + b"\x00fakejpeg" * 4
URL = "/api/figure-explain/ask"


class FigureExplainTests(CoreTestCase):
    def ask(self, **kw):
        body = {"arxiv_id": self.paper_id, "figure_id": "S2.F1", "selection": "Figure 1: Architecture",
                "context": "[첨부: 원본 이미지 1장]", "section": "2 Method", "question": "이 그림이 보여주는 것", **kw}
        return self.client.post(URL, json=body)

    def first_content(self, call=None):
        return (call or self.claude.last)["messages"][0]["content"]

    def test_router_registered(self):
        self.assertIn("figure_explain", core.FEATURES)

    def test_png_image_block_before_text(self):
        self.http.route("x1.png", PNG, headers={"content-type": "image/png"})
        self.claude.push({"chunks": ["그림은 ", "구조를 보여줍니다."]})
        r = self.ask(image_urls=[IMG + "x1.png"])
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.text, "그림은 구조를 보여줍니다.")
        content = self.first_content()
        self.assertEqual(content[0], {"type": "image", "source": {
            "type": "base64", "media_type": "image/png", "data": base64.b64encode(PNG).decode()}})
        self.assertEqual(content[-1]["type"], "text")
        self.assertIn("<highlight>\nFigure 1: Architecture\n</highlight>", content[-1]["text"])
        self.assertIn("<section>2 Method</section>", content[-1]["text"])
        self.assertTrue(content[-1]["text"].endswith("이 그림이 보여주는 것"))
        self.assertEqual(len(content), 2)  # 이미지 + 텍스트 (빠진 이미지 메모 없음)
        self.assertEqual(self.claude.last["max_tokens"], 3000)
        self.assert_shared_call()

    def test_url_not_an_image_of_the_paper_is_400_without_fetching(self):
        bad = [
            "http://169.254.169.254/latest/meta-data",  # 내부 주소
            "https://github.com/example/sparse-moe",  # 논문 HTML에 있지만 <a href> (img 아님)
            IMG + "x2.png",  # 논문의 img지만 다른 그림(S2.F2)의 것
        ]
        for u in bad:
            with self.subTest(u):
                r = self.ask(image_urls=[IMG + "x1.png", u])
                self.assertEqual(r.status_code, 400)
        self.assertEqual(self.http.calls, [])
        self.assertEqual(self.claude.calls, [])

    def test_unknown_figure_too_many_images_or_empty_question_is_400(self):
        self.assertEqual(self.ask(figure_id="S9.F9").status_code, 400)
        self.assertEqual(self.ask(figure_id="S2.F2", image_urls=[IMG + "x2.png"] * 5).status_code, 400)
        png = "data:image/png;base64," + base64.b64encode(PNG).decode()
        self.assertEqual(self.ask(figure_id="S2.F3", image_data=[png] * 3).status_code, 400)
        self.assertEqual(self.ask(question="  ").status_code, 400)
        self.assertEqual(self.claude.calls, [])

    def test_svg_skipped_text_only_call_still_made(self):
        self.http.route("x3.svg", b"<svg/>", headers={"content-type": "image/svg+xml"})
        r = self.ask(figure_id="S2.F2.sf2", image_urls=[IMG + "x3.svg"])
        self.assertEqual(r.status_code, 200)
        content = self.first_content()
        self.assertFalse([b for b in content if b["type"] == "image"])
        self.assertIn("1장 중 0장만 첨부됨", content[0]["text"])
        self.assertTrue(content[-1]["text"].endswith("이 그림이 보여주는 것"))

    def test_subpanel_and_parent_figure_accept_panel_images(self):
        self.http.route("x2.png", PNG, headers={"content-type": "image/png"})
        self.http.route("x3.svg", b"<svg/>", headers={"content-type": "image/svg+xml"})
        self.assertEqual(self.ask(figure_id="S2.F2.sf1", image_urls=[IMG + "x2.png"]).status_code, 200)
        # 바깥 그림은 하위 패널 img를 모두 가짐. png는 붙고 svg는 빠졌다는 메모
        self.assertEqual(self.ask(figure_id="S2.F2", image_urls=[IMG + "x2.png", IMG + "x3.svg"]).status_code, 200)
        content = self.first_content()
        self.assertEqual([b["type"] for b in content], ["image", "text", "text"])
        self.assertIn("2장 중 1장만 첨부됨", content[1]["text"])
        self.assertEqual(sum(c.endswith("x2.png") for c in self.http.calls), 1)  # LRU: 두 요청에 한 번

    def test_followup_resends_identical_image_bytes_fetched_once(self):
        self.http.route("x1.png", PNG, headers={"content-type": "image/png"})
        self.claude.push("첫 답", "둘째 답")
        self.assertEqual(self.ask(image_urls=[IMG + "x1.png"]).text, "첫 답")
        history = [{"role": "user", "content": "이 그림이 보여주는 것"}, {"role": "assistant", "content": "첫 답"}]
        r = self.ask(image_urls=[IMG + "x1.png"], history=history, question="축은?")
        self.assertEqual(r.text, "둘째 답")
        first, second = self.claude.calls
        self.assertEqual(self.first_content(first), self.first_content(second))  # 같은 바이트 → 앞부분 캐시 적중
        self.assertEqual([m["role"] for m in second["messages"]], ["user", "assistant", "user"])
        self.assertEqual(second["messages"][-1]["content"], "축은?")
        self.assertEqual(len(self.http.calls), 1)
        for call in self.claude.calls:
            self.assert_shared_call(call)
            self.assertEqual(call["cache_control"], {"type": "ephemeral"})  # stream_claude: 대화 꼬리 캐시

    def test_table_without_images_is_plain_text_turn(self):
        r = self.ask(figure_id="S2.T1", image_urls=[], selection="Table 1: Results",
                     context="[표 내용]\nModel | MMLU | GSM8K\nDense | 61.2 | 40.1")
        self.assertEqual(r.status_code, 200)
        content = self.first_content()
        self.assertIsInstance(content, str)  # 이미지가 없으면 /api/ask와 같은 문자열 턴
        self.assertEqual(content, core.build_first_turn(
            "Table 1: Results", "[표 내용]\nModel | MMLU | GSM8K\nDense | 61.2 | 40.1", "이 그림이 보여주는 것", "2 Method"))
        self.assertEqual(self.http.calls, [])

    def test_rasterized_tikz_png_from_client(self):
        data = "data:image/png;base64," + base64.b64encode(PNG).decode()
        r = self.ask(figure_id="S2.F3", image_data=[data, "data:image/png;base64,bm90IGFuIGltYWdl"])
        self.assertEqual(r.status_code, 200)
        content = self.first_content()
        self.assertEqual(content[0]["source"], {"type": "base64", "media_type": "image/png", "data": base64.b64encode(PNG).decode()})
        self.assertIn("2장 중 1장만 첨부됨", content[1]["text"])  # 깨진 두 번째는 건너뜀
        self.assertEqual(self.http.calls, [])

    def test_fetch_failure_or_bad_type_skips_image(self):
        self.http.route("x1.png", b"oops", status=500, headers={"content-type": "text/html"})
        r = self.ask(image_urls=[IMG + "x1.png"])
        self.assertEqual(r.status_code, 200)
        self.assertIn("1장 중 0장만 첨부됨", self.first_content()[0]["text"])

    def test_api_error_ends_with_error_tail(self):
        self.claude.push({"chunks": ["부분"], "error": api_error("down"), "error_at": 1})
        r = self.ask()
        self.assertTrue(r.text.startswith("부분"))
        self.assertRegex(r.text, r"\n\n\[오류\][^\n]*$")


class ForeignHostTests(CoreTestCase):
    paper_id = "2401.00002"

    def setUp(self):
        super().setUp()
        self.paper = seed_paper(self.paper_id, "figure-explain_hosts.html")

    def test_foreign_host_image_in_figure_is_skipped_not_fetched(self):
        local = "https://arxiv.org/html/2401.00002/x1.png?w=1&h=2"  # 논문에서는 &amp; (getAttribute 값 그대로)
        self.http.route("x1.png", PNG, headers={"content-type": "image/png"})
        r = self.client.post(URL, json={"arxiv_id": self.paper_id, "figure_id": "F1", "question": "설명",
                                        "image_urls": ["https://example.com/evil.png", local]})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(self.http.calls, [local])  # example.com에는 요청하지 않음
        content = self.claude.last["messages"][0]["content"]
        self.assertEqual([b["type"] for b in content], ["image", "text", "text"])
        self.assertIn("2장 중 1장만 첨부됨", content[1]["text"])
        self.assert_shared_call()

    def test_metadata_link_in_paper_html_is_rejected(self):
        r = self.client.post(URL, json={"arxiv_id": self.paper_id, "figure_id": "F1", "question": "설명",
                                        "image_urls": ["http://169.254.169.254/latest/meta-data"]})
        self.assertEqual(r.status_code, 400)
        self.assertEqual(self.http.calls, [])


class DecodeImageTests(CoreTestCase):
    def test_decode_image(self):
        b64 = base64.b64encode(PNG).decode()
        self.assertEqual(decode_image(b64), ("image/png", b64))
        self.assertEqual(decode_image("data:image/png;base64," + b64), ("image/png", b64))
        self.assertEqual(decode_image(base64.b64encode(JPG).decode()), ("image/jpeg", base64.b64encode(JPG).decode()))
        self.assertIsNone(decode_image(base64.b64encode(b"GIF89a....").decode()))  # canvas 결과(png/jpeg)만
        self.assertIsNone(decode_image("not base64 !!"))
        self.assertIsNone(decode_image(""))
        self.assertIsNone(decode_image("A" * 3_000_000))  # 너무 큼
