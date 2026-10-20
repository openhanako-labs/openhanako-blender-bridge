/**
 * 中继「免鉴权只读面」的唯一事实源。
 *
 * ── 为什么单独成文件 ─────────────────────────────────────────────────────
 *
 * 这张表决定「外部不持 key 能碰到什么」。它原来长在 blender-relay.mjs 里，
 * 而 relay 是个「一 import 就起服务、还要读 argv 配置文件」的模块——测不了。
 * 于是这张表**从来没有被任何测试照到过**。
 *
 * 代价在 2026-10-20 兑现了：`/preview` 进了白名单，但方法规则只放 POST，
 * 而预览是 GET —— 路径在白名单里，请求照样回 403。
 * 当天 35 项测试**全绿**。灯照的是别的地方。
 *
 * 抽出来之后它是纯函数：可测、可 diff、可被文档逐行对照。
 *
 * ── 两条不变量（改这张表时必须同时满足）──────────────────────────────────
 *
 *   1. `PUBLIC_READ_PATHS` 与 `PUBLIC_READ_METHODS` 的键**必须一致**。
 *      加了路径忘了写方法 → 默认按 POST 放行，等于开了一个口子（见下）。
 *   2. 免鉴权门**只开给读**。写路径（/do、/render、/service/* 等）
 *      永远不得出现在这里。
 *
 * 不变量由 _probe/relay-policy.test.mjs 锁死。
 */

/** 免鉴权的路径。顺序即 /health 回执里的展示顺序。 */
export const PUBLIC_READ_PATHS = Object.freeze([
  "/health",          // 进程与连接状态
  "/doctor",          // 三级探测（ping → addon → bpy），不改任何东西
  "/preview",         // 实时预览：截图（GET，给拿不到 key 的调用方）
  "/scene",           // 读场景结构
  "/object",          // 读单个物体
  "/rt/commands",     // 列 addon 命令面
  "/rt/capabilities", // 列能力与指标
  "/rt/who",          // 看谁持锁（多会话共存时先看它）
]);

/**
 * 每条路径允许的方法。`null` = 不限制方法。
 *
 * 为什么不统一成一个方法：/health 要能被浏览器直接打开、也要能被 POST 探活；
 * 其余一律 POST（带 body 的只读查询），只有 /preview 是 GET（无 body，纯取图）。
 */
export const PUBLIC_READ_METHODS = Object.freeze({
  "/health": null,
  "/doctor": "POST",
  "/preview": "GET",
  "/scene": "POST",
  "/object": "POST",
  "/rt/commands": "POST",
  "/rt/capabilities": "POST",
  "/rt/who": "POST",
});

const PATH_SET = new Set(PUBLIC_READ_PATHS);
const METHOD_SET = new Set(Object.keys(PUBLIC_READ_METHODS));

/** 路径在免鉴权面内，且方法对得上。 */
export function isPublicRead(path, method) {
  if (!PATH_SET.has(path)) return false;
  const want = PUBLIC_READ_METHODS[path];
  if (want == null) return true;               // 不限制方法
  return String(method || "").toUpperCase() === want;
}

/**
 * G2 · Host / 浏览器指纹（发布审查五道闸之二）。
 *
 * 口径（Hana App 发布手册 §1.1）：
 *   · Host 只认 `127.0.0.1:<PORT>` / `localhost:<PORT>`
 *   · 带 `Origin` → 拦
 *   · 带 `Sec-Fetch-Site` 且**值不是 `none`** → 拦
 *
 * ！不要“见 Sec-Fetch-* 就拦” —— 实测 Node v24+ 的 undici fetch 会主动带
 *   `sec-fetch-mode: cors`（注意是 **Mode**），一刀切会把宿主桥自己误杀。
 *   这里看的是 **Site** 的**值**，不是这个头的存不存在。
 *   直接地址栏打开时浏览器发 `Sec-Fetch-Site: none`，所以“自己去看一眼”不受影响。
 *
 * 为何“只监听回环”不够：回环 ≠ 鉴权。浏览器里的任何页面都能打
 *   `http://127.0.0.1:<port>/`。跨站读不到响应（不发 CORS 头，浏览器会挡），
 *   但**请求发得出去**。这一闸堵的就是“发得出去”。
 *
 * 为何拦下时要把实际值回传而不只回一个 true：那是实测钩子——
 *   口径写得再对，也可能在某个客户端上不成立，日志里留得下才能查。
 *
 * @param {object} headers 请求头（小写键）
 * @param {{host:string, port:number|string}} addr 本服务实际监听地址
 * @returns {string|null} null = 放行；字符串 = 拦下的原因（写日志用）
 */
export function browserFingerprintBlock(headers, addr) {
  const h = headers || {};
  const port = addr && addr.port != null ? String(addr.port) : "";
  const host = String(h.host || "");

  const okHost = host === `127.0.0.1:${port}` || host === `localhost:${port}`;
  if (!okHost) return `host=${host || "（缺）"}`;

  const origin = h.origin;
  if (origin !== undefined) return `origin=${origin}`;

  const site = h["sec-fetch-site"];
  if (site !== undefined && String(site).trim().toLowerCase() !== "none") {
    return `sec-fetch-site=${site}`;
  }

  return null;
}

/**
 * G3 辅助：写路由必须 POST-only，且**彻底忽略 query string**。
 * 只给声明用——具体路由的 method 判断在各路由处。
 *
 * （发布手册 §1.1 G3：写路由要显式成集合，逐条过。）
 */
export function isWriteMethodViolation(expected, method) {
  return String(method || "").toUpperCase() !== String(expected || "POST").toUpperCase();
}

/**
 * 自检：两条不变量是否成立。
 * relay 启动时调一次（错了就当场喊），测试里也调一次。
 * @returns {string[]} 问题清单，空数组 = 健康
 */
export function checkPolicy() {
  const problems = [];
  for (const p of PUBLIC_READ_PATHS) {
    if (!METHOD_SET.has(p)) problems.push(`白名单有 ${p}，但没定义允许的方法`);
  }
  for (const p of METHOD_SET) {
    if (!PATH_SET.has(p)) problems.push(`定义了 ${p} 的方法，但它不在白名单里`);
  }
  return problems;
}
