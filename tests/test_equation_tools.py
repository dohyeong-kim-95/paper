"""equation-tools: 서버 코드 없음 (클라이언트 전용). 번들에 실리는지, 정리된 논문 HTML이 JS가 읽는 수식 구조
(alttext·행·내용 칸·번호)를 지키는지, 픽스처 수식 → LaTeX 변환(joinRows)이 기대값과 같은지 확인"""
import json
import re
import shutil
import subprocess
import unittest

from bs4 import BeautifulSoup

from tests.helpers import CoreTestCase, core

NODE = shutil.which("node")
# JS의 PAD 규칙과 같게: 여백·번호 칸은 내용 칸이 아님
PAD = re.compile(r"\bltx_eqn_(eqno|\w*pad(left|right))\b")
ALIGNED = ("\\begin{aligned}\\mathcal{L} & =\\mathcal{L}_{\\text{task}}+\\alpha\\mathcal{L}_{\\text{bal}} \\\\ "
           "\\mathcal{L}_{\\text{bal}} & =N\\sum_{i=1}^{N}f_{i}P_{i}\\end{aligned}")


def rows_of(table) -> list[list[str]]:
    rows = []
    for tr in table.find_all("tr"):
        if tr.find_parent("table") is not table or not {"ltx_equation", "ltx_eqn_row"} & set(tr.get("class", [])):
            continue
        cells = [td for td in tr.find_all("td", recursive=False) if not PAD.search(" ".join(td.get("class", [])))]
        rows.append([" ".join(m.get("alttext", "") for m in td.find_all("math")) for td in cells])
    return rows


class EquationToolsTests(CoreTestCase):
    def test_bundle_includes_files(self):
        js, css = self.client.get("/features.js"), self.client.get("/features.css")
        self.assertEqual((js.status_code, css.status_code), (200, 200))
        self.assertIn("/* ---- equation-tools.js ---- */", js.text)
        self.assertIn("//# sourceURL=features/equation-tools.js", js.text)
        self.assertIn(".eq-row", css.text)
        self.assertIn("equation-tools.js", core.feature_assets()["names"])

    def test_paper_keeps_equation_structure(self):
        r = self.client.get(f"/paper/{self.paper_id}")
        self.assertEqual(r.status_code, 200)
        soup = BeautifulSoup(r.text, "html.parser")
        single, group, unnumbered = soup.find(id="S2.E1"), soup.find(id="S2.EGx1"), soup.find(id="S2.Ex1")
        self.assertIn("ltx_equation", single["class"])
        self.assertIn("ltx_equationgroup", group["class"])
        self.assertEqual([len(r) for r in rows_of(group)], [2, 2])  # align: 칸마다 math가 따로
        self.assertEqual([t.get_text(strip=True) for t in group.select(".ltx_tag_equation")], ["(2)", "(3)"])
        self.assertEqual(single.select_one(".ltx_tag_equation").get_text(strip=True), "(1)")
        self.assertIsNone(unnumbered.select_one(".ltx_tag_equation"))
        self.assertEqual(self.claude.calls, [])  # 수식 도구는 서버 Claude 호출이 없음

    @unittest.skipUnless(NODE, "node가 없음")
    def test_fixture_rows_to_latex(self):
        soup = BeautifulSoup(self.paper["html"], "html.parser")
        rows = {i: rows_of(soup.find(id=i)) for i in ("S2.E1", "S2.EGx1", "S2.Ex1")}
        script = ("const m = require('./static/features/equation-tools.js');"
                  "const rows = JSON.parse(process.argv[1]);"
                  "process.stdout.write(JSON.stringify(Object.fromEntries(Object.entries(rows).map(([k, v]) => [k, m.joinRows(v)]))));")
        out = subprocess.run([NODE, "-e", script, json.dumps(rows)], cwd=core.BASE_DIR, capture_output=True, text=True, timeout=30)
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertEqual(json.loads(out.stdout), {
            "S2.E1": "g(x)=\\mathrm{softmax}(W_{g}x)",
            "S2.EGx1": ALIGNED,
            "S2.Ex1": "h=\\sum_{i\\in\\mathcal{T}}g_{i}(x)E_{i}(x)",
        })
