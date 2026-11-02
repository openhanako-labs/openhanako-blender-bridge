// addon-protocol.mjs 注入测试（ESM，无需 Blender）。
// 覆盖：resolveAddonToken 解析优先级 + plan() 注入 auth 的线协议契约。
import assert from "node:assert";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { PROTOCOLS, resolveAddonToken } from "../vendor/dsh-rt/runtime/addon-protocol.mjs";

function clearEnv() {
  delete process.env.BLENDERMCP_ADDON_TOKEN;
  delete process.env.BLENDERMCP_ADDON_TOKEN_FILE;
}

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log("  ok -", name);
}

const flat = PROTOCOLS.flat;

// 1) 未配置令牌：resolveAddonToken 返回 ''，plan() 不注入 auth
clearEnv();
check("resolveAddonToken() 未配置返回空串", () => {
  assert.strictEqual(resolveAddonToken(), "");
});
check("plan() 未配置令牌时不带 auth", () => {
  const wire = flat.plan("ping", {}).wire;
  assert.strictEqual(wire.auth, undefined);
  assert.deepStrictEqual(Object.keys(wire).sort(), ["params", "type"]);
});

// 2) 直接 env 优先
clearEnv();
process.env.BLENDERMCP_ADDON_TOKEN = "env-secret";
check("resolveAddonToken() 直接 env 生效", () => {
  assert.strictEqual(resolveAddonToken(), "env-secret");
});
check("plan() 注入 auth=env-secret", () => {
  const wire = flat.plan("execute_code", { code: "x=1" }).wire;
  assert.strictEqual(wire.auth, "env-secret");
  assert.strictEqual(wire.type, "execute_code");
  assert.strictEqual(wire.params.code, "x=1");
});

// 3) 文件 env
clearEnv();
const tf = path.join(os.tmpdir(), "bb-proto-test-tok.txt");
fs.writeFileSync(tf, "  file-secret\n", "utf8");
process.env.BLENDERMCP_ADDON_TOKEN_FILE = tf;
check("resolveAddonToken() 文件 env 去空白", () => {
  assert.strictEqual(resolveAddonToken(), "file-secret");
});
check("plan() 经文件 env 注入 auth", () => {
  assert.strictEqual(flat.plan("ping", {}).wire.auth, "file-secret");
});
fs.rmSync(tf, { force: true });
clearEnv();

// 4) encode 产出合法 JSON（auth 随之编码）
clearEnv();
process.env.BLENDERMCP_ADDON_TOKEN = "x";
check("encode() 产出含 auth 的合法 JSON", () => {
  const json = flat.encode(flat.plan("get_addon_info", {}).wire);
  const obj = JSON.parse(json);
  assert.strictEqual(obj.auth, "x");
  assert.strictEqual(obj.type, "get_addon_info");
});
clearEnv();

console.log(`\naddon-protocol 测试通过：${passed} 项`);
