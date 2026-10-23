"""ref-peek: 클라이언트 전용 기능 (서버 라우트·Claude 호출 없음). 페이지·번들에 들어가는지, 정리된 논문 HTML이
참조 링크의 대상 id·각주 구조를 그대로 두는지 확인"""
import re

from bs4 import BeautifulSoup

from tests.helpers import CoreTestCase


class RefPeekTests(CoreTestCase):
    def test_paper_page_loads_ref_peek_assets(self):
        r = self.client.get(f"/paper/{self.paper_id}")
        self.assertEqual(r.status_code, 200)
        names = r.text.split('data-features="')[1].split('"')[0].split()
        self.assertIn("ref-peek.js", names)
        self.assertIn("ref-peek.css", names)
        js = self.client.get("/features.js").text
        self.assertIn("sourceURL=features/ref-peek.js", js)
        self.assertIn('registerFeature(\\"ref-peek\\"', js)
        css = self.client.get("/features.css").text
        self.assertIn("/* ---- ref-peek.css ---- */", css)
        self.assertRegex(css, r"#paper \.ltx_note_outer\s*\{\s*display:\s*none")
        self.assertEqual(self.claude.calls, [], "Claude 호출 없음 (토큰 0)")

    def test_cleaned_html_keeps_reference_targets(self):
        soup = BeautifulSoup(self.paper["html"], "html.parser")
        ids = {el["id"] for el in soup.find_all(id=True)}
        refs = [a["href"][1:] for a in soup.select('a[href^="#"]')]
        self.assertTrue({"S2.E1", "S2.F1", "S2.T1", "S2.SS1", "S2.F2.sf1", "alg1", "Thmtheorem1", "A1", "A1.E4"} <= set(refs))
        for ref in refs:
            self.assertIn(ref, ids, f"#{ref}의 대상이 정리 후에도 있어야 함")
        # 정렬 수식: 줄(tbody)의 id, 각주: 표시 + 본문
        self.assertEqual(soup.find(id="S2.E3").name, "tbody")
        self.assertIn("ltx_equationgroup", soup.find(id="S2.E3").find_parent("table")["class"])
        note = soup.select_one(".ltx_note.ltx_role_footnote")
        self.assertIsNotNone(note.select_one(":scope > .ltx_note_mark"))
        self.assertIn("trained jointly", note.select_one(".ltx_note_outer .ltx_note_content").get_text())
        # 제목은 링크 글자가 아니라 대상 꼬리표에서 (Fig.~\ref 의 링크 글자는 번호뿐)
        self.assertEqual(soup.select_one('a[href="#S2.F1"]').get_text(strip=True), "1")
        self.assertTrue(re.match(r"Figure 1", soup.find(id="S2.F1").select_one(".ltx_tag_figure").get_text()))
