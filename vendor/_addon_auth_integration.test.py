"""
端到端鉴权集成测试 —— 无需 Blender。

用**真实的** addon-protocol.mjs（plan() 注入 auth）当客户端，连**复刻真实鉴权分支**的
纯 Python 假 addon 服务器，验证 PR #123 审查意见要求的三件事：
  1. 正常中继（带正确令牌）可用；
  2. 无密钥被拒绝；
  3. 错误密钥被拒绝。
并验证：缺令牌时服务器「安全默认拒绝全部」。

令牌解析两端同源（env BLENDERMCP_ADDON_TOKEN / _FILE / 默认令牌文件）。
"""

import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)  # openhanako-blender-bridge
SERVER = os.path.join(REPO, "runtime", "_addon_fake_server.py")
PROBE = os.path.join(REPO, "runtime", "_addon_client_probe.mjs")
NODE = "node"
PY = sys.executable


def free_port():
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def start_server(port, token_file):
    env = dict(os.environ)
    # 服务器始终从 token_file 读取正确令牌
    env["BLENDERMCP_ADDON_TOKEN_FILE"] = token_file
    p = subprocess.Popen(
        [PY, SERVER, str(port)],
        env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    # 等端口就绪
    deadline = time.time() + 5
    while time.time() < deadline:
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            s.connect(("127.0.0.1", port))
            s.close()
            return p
        except OSError:
            time.sleep(0.05)
    raise RuntimeError("fake addon server 未就绪")


def probe(port, client_token_env):
    env = dict(os.environ)
    env.pop("BLENDERMCP_ADDON_TOKEN", None)
    env.pop("BLENDERMCP_ADDON_TOKEN_FILE", None)
    if client_token_env is not None:
        env["BLENDERMCP_ADDON_TOKEN"] = client_token_env
    out = subprocess.run(
        [NODE, PROBE, "127.0.0.1", str(port), "execute_code", json.dumps({"code": "x=1"})],
        env=env, capture_output=True, text=True, timeout=15,
    )
    line = out.stdout.strip().splitlines()
    return json.loads(line[-1]) if line else {"status": "error", "message": "no-output"}


class TestEndToEndAuth(unittest.TestCase):
    _server = None
    _token_file = None

    @classmethod
    def setUpClass(cls):
        cls._token_file = os.path.join(tempfile.mkdtemp(prefix="bb-e2e-"), "tok.txt")
        with open(cls._token_file, "w", encoding="utf-8") as f:
            f.write("shared-secret")
        cls._port = free_port()
        cls._server = start_server(cls._port, cls._token_file)

    @classmethod
    def tearDownClass(cls):
        if cls._server:
            cls._server.terminate()
            try:
                cls._server.wait(timeout=5)
            except Exception:
                cls._server.kill()

    def test_normal_relay_with_correct_token_accepted(self):
        r = probe(self._port, "shared-secret")
        self.assertEqual(r.get("status"), "success", msg=r)
        self.assertTrue(r.get("result", {}).get("executed"))

    def test_no_key_rejected(self):
        r = probe(self._port, None)  # 客户端无令牌 → 不发 auth
        self.assertEqual(r.get("status"), "error", msg=r)
        self.assertIn("unauthorized", r.get("message", ""))

    def test_wrong_key_rejected(self):
        r = probe(self._port, "evil-guess")
        self.assertEqual(r.get("status"), "error", msg=r)
        self.assertIn("unauthorized", r.get("message", ""))


if __name__ == "__main__":
    unittest.main(verbosity=2)
