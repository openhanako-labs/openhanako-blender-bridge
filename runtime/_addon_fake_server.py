"""
假 addon 服务器（纯 Python，无 bpy）—— 仅用于端到端鉴权测试。

复刻 blender-mcp-addon.py 中 _handle_client 的鉴权分支决策：
  每条命令须带正确 auth（_addon_auth.auth_ok）；缺失/错误一律回 unauthorized，不执行。
令牌来源与真实 addon 一致（env BLENDERMCP_ADDON_TOKEN_FILE / 默认令牌文件）。

用法：python _addon_fake_server.py <port>
"""
import json
import os
import socket
import sys
import threading

HERE = os.path.dirname(os.path.abspath(__file__))
VENDOR = os.path.join(HERE, "..", "vendor")
if VENDOR not in sys.path:
    sys.path.insert(0, VENDOR)
import _addon_auth as aa


def handle(conn):
    try:
        conn.settimeout(2.0)
        buf = b""
        # 一次连接处理一条命令（与探针一对一发送对应）
        while b"\n" not in buf:
            chunk = conn.recv(8192)
            if not chunk:
                break
            buf += chunk
        line = buf.split(b"\n", 1)[0].decode("utf-8").strip()
        if not line:
            return
        command = json.loads(line)
        token = aa.resolve_token()
        if not aa.auth_ok(command.get("auth"), token):
            why = "token-not-provisioned" if token is None else "missing/wrong-auth"
            resp = {"status": "error", "message": "unauthorized: " + why}
        else:
            resp = {"status": "success", "result": {"echo": command.get("type"), "executed": True}}
        conn.sendall((json.dumps(resp) + "\n").encode("utf-8"))
    except Exception as e:
        try:
            conn.sendall((json.dumps({"status": "error", "message": str(e)}) + "\n").encode("utf-8"))
        except Exception:
            pass
    finally:
        try:
            conn.close()
        except Exception:
            pass


def main():
    port = int(sys.argv[1])
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(("127.0.0.1", port))
    srv.listen(8)
    srv.settimeout(0.5)
    while True:
        try:
            c, _ = srv.accept()
        except socket.timeout:
            continue
        threading.Thread(target=handle, args=(c,), daemon=True).start()


if __name__ == "__main__":
    main()
