"""
Blender addon 调用方认证 —— 单一可信源（stdlib only，无 bpy 依赖，可在无 Blender 下测试）。

为什么单独成文件：
  addon 主模块 import bpy / mathutils 等 Blender 专属依赖，无法在 Blender 之外 import，
  因此把「读令牌 + 常量时间比较」抽成纯 stdlib 模块，既能单测，也让协议两端（addon 与 relay）
  共享同一套解析规则。

威胁模型（见仓库 SECURITY.md 与 PR #123 审查意见）：
  9876 是 localhost 回环端口。任何能连上该端口的本机进程，原本都能以 Blender 用户权限
  调用 execute_code 执行任意 Python。本模块让 addon 入口在「执行前」识别已授权调用方：
  只有持有正确 auth 令牌的命令才会被排队执行；缺失 / 错误令牌一律拒绝。

令牌来源（优先级）：
  1. 环境变量 BLENDERMCP_ADDON_TOKEN      —— 宿主强注入（最优先）
  2. 环境变量 BLENDERMCP_ADDON_TOKEN_FILE —— 显式指定令牌文件路径
  3. 默认令牌文件 <tempdir>/blender-bridge.addon-token
     （tempdir 在 Windows 上为用户级 AppData\\Local\\Temp，ACL 仅限当前用户；
      令牌由宿主每次启动生成并写入，不随包发布，不落盘于可公开位置）
"""

import os
import hmac
import tempfile

DEFAULT_TOKEN_FILENAME = "blender-bridge.addon-token"


def _default_token_path():
    return os.path.join(tempfile.gettempdir(), DEFAULT_TOKEN_FILENAME)


def resolve_token():
    """返回当前应校验的令牌字符串；未配置返回 None。

    返回 None 的语义：addon 端据此进入「安全默认=拒绝全部命令」，
    relay 端据此「不注入 auth」（此时 addon 会因令牌缺失而拒绝，保持关闭状态）。
    """
    direct = os.environ.get("BLENDERMCP_ADDON_TOKEN")
    if direct:
        return direct

    path = os.environ.get("BLENDERMCP_ADDON_TOKEN_FILE")
    if not path:
        path = _default_token_path()

    try:
        with open(path, "r", encoding="utf-8") as f:
            value = f.read().strip()
        return value or None
    except OSError:
        return None


def auth_ok(supplied, token):
    """常量时间比较：supplied 是否为合法令牌。

    - token 为 None（未配置）：直接 False（安全默认=拒绝）。
    - supplied 非字符串 / 为 None：False。
    - 长度不一致也走 hmac.compare_digest（它要求等长，这里用「与空串比较」兜底，
      不泄露内容，只返回 False）。
    """
    if token is None:
        return False
    if not isinstance(supplied, str):
        supplied = ""
    try:
        return hmac.compare_digest(supplied, token)
    except TypeError:
        return False
