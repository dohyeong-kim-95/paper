"""브라우저 테스트: 진짜 서버(가짜 Claude·시드 논문)를 띄우고 tests/browser/*.browser.js 를 node + Playwright로 실행.
node, playwright 모듈(NODE_PATH), Chromium 중 하나라도 없으면 건너뜀. 기능도 tests/browser/<group>.browser.js 를 둘 수 있음
(인자: 서버 포트. /api/ask 등은 page.route로 가로채고, 바깥 네트워크는 막을 것).

foundation.browser.js 는 기능이 하나도 없는 서버(빈 static/features, 훅 없음)에서 돌림: 기능이 계약대로
훅·탭 처리기를 붙여도(질문 훅이 질문을 바꾸는 등) 공용 기반 테스트가 깨지지 않게. 나머지 파일은 전체 번들로."""
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import unittest
from contextlib import ExitStack
from pathlib import Path
from unittest import mock

import uvicorn

from tests.helpers import CoreTestCase, core

ROOT = Path(__file__).resolve().parent.parent
NODE = shutil.which("node")
FOUNDATION_ONLY = {"foundation.browser.js"}


@unittest.skipUnless(NODE, "node가 없음")
class BrowserTests(CoreTestCase):
    def start_server(self) -> int:
        sock = socket.socket()
        sock.bind(("127.0.0.1", 0))
        server = uvicorn.Server(uvicorn.Config(core.app, log_level="warning", lifespan="off"))
        thread = threading.Thread(target=server.run, kwargs={"sockets": [sock]}, daemon=True)
        thread.start()

        def stop():
            server.should_exit = True
            thread.join(10)
            sock.close()
        self.addCleanup(stop)
        for _ in range(500):
            if server.started:
                break
            time.sleep(0.01)
        self.assertTrue(server.started, "서버가 뜨지 않음")
        return sock.getsockname()[1]

    def without_features(self) -> ExitStack:
        # 같은 서버(같은 프로세스)에서 기능 번들·서버 훅만 비움. 기능 라우터는 남지만 페이지가 부르지 않음
        stack = ExitStack()
        empty = Path(tempfile.mkdtemp(prefix="no-features-"))
        stack.callback(shutil.rmtree, empty, True)
        stack.callback(core._bundles.clear)
        for name, value in (("FEATURES_STATIC", empty), ("PREWARM_HOOKS", []), ("PAPER_MISSING_HOOKS", [])):
            stack.enter_context(mock.patch.object(core, name, value))
        core._bundles.clear()
        assert core.feature_assets()["names"] == []
        return stack

    def test_browser_files(self):
        if subprocess.run([NODE, "-e", "require.resolve('playwright')"], capture_output=True).returncode:
            self.skipTest("playwright 모듈 없음")
        files = sorted((ROOT / "tests" / "browser").glob("*.browser.js"))
        self.assertTrue(files)
        port = self.start_server()
        for f in files:
            with self.subTest(f.name), (self.without_features() if f.name in FOUNDATION_ONLY else ExitStack()):
                r = subprocess.run([NODE, str(f), str(port)], cwd=ROOT, capture_output=True, text=True, timeout=300)
                if r.stdout.startswith("SKIP"):
                    self.skipTest(r.stdout.strip())
                self.assertEqual(r.returncode, 0, f"{f.name}\n{r.stdout[-6000:]}\n{r.stderr[-3000:]}")
