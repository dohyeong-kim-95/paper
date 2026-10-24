"""figure-viewer: 클라이언트 전용 (서버 코드·Claude 호출 없음). 번들에 실리는지, 그리고 뷰어가 기대는 본문 구조
(맨 위 단계 figure 순서 = paper_index의 top 그림, 패널마다 img, 공유·'원본 열기'용 절대 주소, 캡션 번호표)를 확인.
화면 동작은 tests/browser/figure-viewer.browser.js, 계산은 tests/js/figure-viewer.test.js."""
from bs4 import BeautifulSoup

from tests.helpers import CoreTestCase, core


class FigureViewerTests(CoreTestCase):
    def test_bundle_includes_viewer(self):
        names = core.feature_assets()["names"]
        self.assertIn("figure-viewer.js", names)
        self.assertIn("figure-viewer.css", names)
        js = self.client.get("/features.js")
        self.assertEqual(js.status_code, 200)
        self.assertIn("/* ---- figure-viewer.js ---- */", js.text)
        css = self.client.get("/features.css").text
        # 뷰어 z 30, 고정 창 z 15 (질문 시트 20 아래): style.css의 변수로
        self.assertIn(".fv-viewer", css)
        self.assertIn("var(--z-viewer)", css)
        self.assertIn("var(--z-pin)", css)

    def test_paper_figure_structure(self):
        r = self.client.get(f"/paper/{self.paper_id}")
        self.assertEqual(r.status_code, 200)
        main = BeautifulSoup(r.text, "html.parser").find(id="paper")
        tops = [f for f in main.find_all("figure") if f.find_parent("figure") is None]
        self.assertEqual([f["id"] for f in tops], ["S2.F1", "S2.F2", "S2.F3", "S2.T1", "alg1"])
        # paper_index의 맨 위 그림과 같은 순서 (모아보기 격자 = 이 목록)
        index = core.build_index(BeautifulSoup(core.papers[self.paper_id]["html"], "html.parser"))
        self.assertEqual([f["id"] for f in index["figures"] if f["top"]], [f["id"] for f in tops])
        # 뷰어 항목: img마다 하나(패널 각각), img가 없으면(또는 표·표 칸 속 img면) 그림 통째로 하나 → 6개
        self.assertEqual([f["id"] for f in tops if f.find("img") and f.find(class_="ltx_tabular")], [])
        self.assertEqual(sum(max(1, len(f.find_all("img"))) for f in tops), 6)
        # 원본 이미지 주소는 절대 주소 (공유·'원본 열기'가 그대로 씀)
        srcs = [img["src"] for img in main.select("figure img")]
        self.assertEqual(len(srcs), 3)
        for src in srcs:
            self.assertTrue(src.startswith(f"https://arxiv.org/html/{self.paper_id}"), src)

        # 번호표: 그 figure 자신의 figcaption 속 .ltx_tag (하위 패널의 캡션과 섞이지 않게)
        def own_tag(fig):
            cap = next(c for c in fig.find_all("figcaption") if c.find_parent("figure") is fig)
            return " ".join(cap.find(class_="ltx_tag").get_text().split()).rstrip(":")
        self.assertEqual([own_tag(f) for f in tops], ["Figure 1", "Figure 2", "Figure 3", "Table 1", "Algorithm 1"])
        self.assertEqual(self.claude.calls, [])
