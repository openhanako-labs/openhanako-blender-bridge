// 端到端探针客户端：使用真实的 addon-protocol.mjs 的 plan() 构造 wire（含 auth 注入），
// 连到假 addon 服务器，打印其回包。令牌解析与真实 relay/engine 同源。
// 用法：node _addon_client_probe.mjs <host> <port> <type> <paramsJson>
import net from "node:net";
import { PROTOCOLS, resolveAddonToken } from "../vendor/dsh-rt/runtime/addon-protocol.mjs";

const [, , host, port, type, paramsJson] = process.argv;
const params = paramsJson ? JSON.parse(paramsJson) : {};
const wire = PROTOCOLS.flat.plan(type, params).wire;

const s = net.connect(Number(port), host);
let buf = "";
s.on("connect", () => {
  s.write(JSON.stringify(wire) + "\n");
});
s.on("data", (d) => {
  buf += d.toString("utf8");
  if (buf.includes("\n")) {
    const line = buf.split("\n", 1)[0].trim();
    // 打印 JSON 回包，便于测试断言；收到回包即退出（不再等定时器）。
    console.log(line);
    process.exit(0);
  }
});
s.on("error", (e) => {
  console.log(JSON.stringify({ status: "error", message: String(e && e.message || e) }));
  process.exit(0);
});
setTimeout(() => {
  console.log(JSON.stringify({ status: "error", message: "probe timeout" }));
  process.exit(0);
}, 4000);
