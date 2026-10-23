"""tests/js/*.test.js 를 node로 실행 (node가 없으면 건너뜀) → python -m unittest 하나로 전부 확인"""
import shutil
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
NODE = shutil.which("node")


@unittest.skipUnless(NODE, "node가 없음")
class NodeTests(unittest.TestCase):
    def test_js_files(self):
        files = sorted((ROOT / "tests" / "js").glob("*.test.js"))
        self.assertTrue(files)
        for f in files:
            with self.subTest(f.name):
                r = subprocess.run([NODE, str(f)], cwd=ROOT, capture_output=True, text=True, timeout=120)
                self.assertEqual(r.returncode, 0, f"{f.name}\n{r.stdout[-3000:]}\n{r.stderr[-3000:]}")
