"""
_addon_auth 单测 —— 无需 Blender（纯 stdlib）。

直接覆盖 PR #123 审查意见要求验证的三件事：
  1. 正常中继（带正确令牌）可用；
  2. 无密钥被拒绝；
  3. 错误密钥被拒绝。
并覆盖令牌解析的优先级与「未配置令牌=安全默认拒绝」。
"""

import os
import sys
import tempfile
import unittest

# 让测试能 import 同目录的 _addon_auth（与 addon 主模块注入 vendor 目录的方式一致）。
HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import _addon_auth as aa


def _clear_env():
    for k in ("BLENDERMCP_ADDON_TOKEN", "BLENDERMCP_ADDON_TOKEN_FILE"):
        os.environ.pop(k, None)


class TestResolveToken(unittest.TestCase):
    def setUp(self):
        _clear_env()
        self._tmp = tempfile.mkdtemp(prefix="bb-auth-test-")
        self._tf = os.path.join(self._tmp, "tok.txt")

    def tearDown(self):
        _clear_env()
        try:
            os.remove(self._tf)
        except OSError:
            pass

    def test_no_env_no_file_returns_none(self):
        self.assertIsNone(aa.resolve_token())

    def test_direct_env_wins(self):
        os.environ["BLENDERMCP_ADDON_TOKEN"] = "abc123"
        self.assertEqual(aa.resolve_token(), "abc123")

    def test_file_env(self):
        with open(self._tf, "w", encoding="utf-8") as f:
            f.write("  filetok\n")
        os.environ["BLENDERMCP_ADDON_TOKEN_FILE"] = self._tf
        self.assertEqual(aa.resolve_token(), "filetok")  # 去空白

    def test_default_file(self):
        # 默认路径 = <tempdir>/blender-bridge.addon-token
        default = os.path.join(tempfile.gettempdir(), aa.DEFAULT_TOKEN_FILENAME)
        with open(default, "w", encoding="utf-8") as f:
            f.write("defaulttok")
        try:
            self.assertEqual(aa.resolve_token(), "defaulttok")
        finally:
            try:
                os.remove(default)
            except OSError:
                pass


class TestAuthOk(unittest.TestCase):
    def test_none_token_rejects(self):
        # 安全默认：未配置令牌时一律拒绝（即使调用方碰巧发了什么）
        self.assertFalse(aa.auth_ok("anything", None))
        self.assertFalse(aa.auth_ok(None, None))

    def test_correct_token_accepts(self):
        self.assertTrue(aa.auth_ok("secret", "secret"))

    def test_wrong_token_rejects(self):
        self.assertFalse(aa.auth_ok("wrong", "secret"))

    def test_missing_supplied_rejects(self):
        self.assertFalse(aa.auth_ok(None, "secret"))
        self.assertFalse(aa.auth_ok("", "secret"))

    def test_constant_time_compare_does_not_crash_on_non_string(self):
        # 非字符串 supplied 不应抛错，应判 False
        self.assertFalse(aa.auth_ok(123, "secret"))
        self.assertFalse(aa.auth_ok(b"secret", "secret"))


class TestAddonEntryDecision(unittest.TestCase):
    """复刻 addon _handle_client 的鉴权分支决策：auth_ok(command.auth, resolve_token())。"""

    def setUp(self):
        _clear_env()

    def tearDown(self):
        _clear_env()

    def _decide(self, command):
        return aa.auth_ok(command.get("auth"), aa.resolve_token())

    def test_normal_relay_with_token_accepted(self):
        os.environ["BLENDERMCP_ADDON_TOKEN"] = "relay-shared-secret"
        cmd = {"type": "execute_code", "params": {"code": "x=1"}, "auth": "relay-shared-secret"}
        self.assertTrue(self._decide(cmd))  # 正常中继可用

    def test_no_key_rejected(self):
        os.environ["BLENDERMCP_ADDON_TOKEN"] = "relay-shared-secret"
        cmd = {"type": "execute_code", "params": {"code": "x=1"}}  # 无 auth
        self.assertFalse(self._decide(cmd))  # 无密钥被拒绝

    def test_wrong_key_rejected(self):
        os.environ["BLENDERMCP_ADDON_TOKEN"] = "relay-shared-secret"
        cmd = {"type": "execute_code", "params": {"code": "x=1"}, "auth": "evil"}
        self.assertFalse(self._decide(cmd))  # 错误密钥被拒绝

    def test_ping_also_requires_auth(self):
        os.environ["BLENDERMCP_ADDON_TOKEN"] = "relay-shared-secret"
        # 存活/握手命令同样过门禁
        self.assertFalse(self._decide({"type": "ping"}))             # 无 auth
        self.assertTrue(self._decide({"type": "ping", "auth": "relay-shared-secret"}))

    def test_no_token_configured_rejects_all(self):
        # 未配置令牌：安全默认，任何命令（含无 auth）都被拒
        self.assertFalse(self._decide({"type": "execute_code", "auth": "whatever"}))
        self.assertFalse(self._decide({"type": "ping"}))


if __name__ == "__main__":
    unittest.main(verbosity=2)
