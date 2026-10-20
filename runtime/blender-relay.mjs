// runtime/blender-relay.mjs — Blender 桥 · 受管中继
// ─────────────────────────────────────────────────────────────────────────────
// 职责：作为 Hana 受管 Node runtime 独立运行，把「HTTP 控制面」翻译成
//       Blender addon（ahujasid/mcp-for-blender 或兼容实现）的 TCP 线协议。
//
// 线协议（addon 侧实现，见 addon.py）：
//   连接：TCP 127.0.0.1:9876
//   请求：一行 JSON  {"type": "<cmd>", "params": {...}}
//   应答：一行 JSON  {"status": "success"|"error", "result": {...}} 或 {"status":"error","message":"..."}
//   注意：应答不带长度前缀，也不带 request id —— 一个连接上一次只应有一个在途请求。
//
// 本进程只做：连接管理 + 请求串行化 + 超时 + 截图落盘。不做任何 bpy 逻辑。
// 配置从 argv[2] 指定的私有 JSON 读入（0600，App 主进程启动即删）。
// ─────────────────────────────────────────────────────────────────────────────

import net from "node:net";
import http from "node:http";
import { readFileSync, mkdirSync, writeFileSync, existsSync, readdirSync, statSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomBytes, timingSafeEqual } from "node:crypto";
// 免鉴权只读面的单一事实源（白名单 + 允许的方法 + 自检）。见该文件头注释。
import { PUBLIC_READ_PATHS, isPublicRead, checkPolicy, browserFingerprintBlock, safeRelativeName, firstRootContaining } from "./relay-policy.mjs";

// ── G3 · 写路由清单（必须与下方路由逐条对应）────────────────────────────
//
// 发布手册 §1.1 G3：写路由 POST-only，方法不对要回 **405** 而不是 404。
// 为何不是 404：404 说“这个路径不存在”，而它存在、只是不接受这个方法。
//   两件事对调用方是不同的信号——跟免鉴权面上“路径不对”与“没权限”
//   必须分开是同一个道理。
//
// ！这份清单是**镜像**，不是事实源。新增写路由时要同步加在这里，
//   否那个路由方法写错时会落到 404 上。_probe/relay-routes.test.mjs 会核。
const WRITE_PATHS = new Set([
  "/doctor", "/see", "/do", "/scene", "/object", "/object/edit", "/raw",
  "/render/pass", "/render/start", "/render/status",
  "/rt/view", "/rt/act", "/rt/preset", "/rt/perf", "/rt/opt", "/rt/plan", "/rt/txn",
  "/rt/loop", "/rt/headless", "/rt/who", "/rt/lease", "/rt/release", "/rt/worker", "/rt/job",
  "/rt/commands", "/rt/capabilities",
  "/deliver", "/service/status", "/service/start", "/service/stop", "/disconnect",
]);

const HERE = dirname(fileURLToPath(import.meta.url));

// ── 迁移自 dsh-blender-plugin（BSD-3-Clause，Copyright (c) 2026 sixtyseven67）──
// 为什么要把上游 engine 接进来（2026-10-13 实测依据，见 _probe/ADDON-PROTOCOL-实测.md）：
//   · addon 的响应**没有帧分隔符**（无换行，多条响应直接拼接），靠花括号配平才能切开
//   · addon 的命令在服务端**全局串行**（一个 command_queue）→ 多连接**零性能收益**
//   · 上游 engine 把「单连接 + 请求串行 + 超时 + Python 模块注入」做熟了
// 【架构决定】一进程、一连接、全能力：上游 engine 是**唯一**的 addon 客户端，
//   我们原有的渲染通道 / 资产源 / 服务管理都跑在同一进程的同一条连接上。
// 【为什么不用上游的 HTTP 层】若另起 server.mjs，它会再开一条 TCP —— 那就是两条连接。
//   直接 import engine.mjs，进程内共用。
let dshEngine = null;
let dshEngineErr = null;

async function getDshEngine() {
  if (dshEngine) return dshEngine;
  if (dshEngineErr) throw dshEngineErr;
  try {
    // 上游 config.mjs 在**模块加载时**就读环境变量，所以必须在 import 前设好。
    //
    // blenderExe 不能只依赖配置：中继可能拿不到那份配置（手动启动、或配置里就没这个字段）。
    // 那时 DSH_BLENDER_EXE 为 undefined，engine 里的 BLENDER_EXE 就是 null，
    // headless 会在 spawn 处报 “file argument must be of type string. Received null”——
    // 看着像参数错，实际是“找不到 blender.exe”。
    // resolveBlenderExe 本来就会扫常见位置，这里用它兜底。
    if (process.env.DSH_BLENDER_EXE === undefined || !process.env.DSH_BLENDER_EXE) {
      const fromCfg = cfg.blenderExe && String(cfg.blenderExe).trim();
      // 注意：这里不能引用 serviceProc——它声明在 L8xx，const 有暂时性死区，
      // 在模块顶部读它会直接抛 ReferenceError。
      let resolved = fromCfg || null;
      if (!resolved) {
        try { const r = resolveBlenderExe(); if (r.ok) resolved = r.exe; } catch { /* 探测失败就走下面的警告 */ }
      }
      if (resolved) {
        process.env.DSH_BLENDER_EXE = String(resolved);
        log(`blender.exe 已定位（${fromCfg ? "来自配置" : "自动探测"}）：${resolved}`);
      } else {
        // 中继只有 log，没有 warn——这里用 log 并把前缀写进去。
        log("警告：未找到 blender.exe——headless / worker 类动作会失败。请在设置里指定 Blender 路径。");
      }
    }
    const engineUrl = pathToFileURL(join(HERE, "..", "vendor", "dsh-rt", "runtime", "engine.mjs")).href;
    const mod = await import(engineUrl);
    dshEngine = mod.createEngine();
    log(`已接入 dsh-blender runtime（engine 已创建，单一 addon 连接）`);
    return dshEngine;
  } catch (e) {
    dshEngineErr = new Error(`加载 dsh runtime 失败：${e?.message || e}`);
    throw dshEngineErr;
  }
}

// ══ 写权限租约（对齐上游 server.mjs 语义）══════════════════════════════════
// 为什么补这一块：上游靠它防「多会话同时驱动一个 Blender」。我们当初跳过了它的 HTTP
// 路由层，租约一起丢了——两个 agent 同时改场景会互相踩，而这在任何公开发布的 App 上
// 都是会伤人的债（丢改动），不是省时间的债。
//
// 语义（与上游一致）：
//   · 不持有租约时不拦 —— 单 agent 完全无感
//   · 一旦有人显式拿到租约，别人的写操作被 409 挡住（附 holder 与剩余毫秒）
//   · TTL 过期自动失效（默认 10 min），每次写操作自动续期
//   · 只读 op 豁免：别人持有时也能「看看现状」
const LEASE_TTL_DEFAULT_MS = 10 * 60 * 1000;
const LEASE = { holder: null, token: null, acquiredAt: null, expiresAt: null, ttlMs: LEASE_TTL_DEFAULT_MS, renewals: 0 };

function leaseView() {
  const now = Date.now();
  const active = !!(LEASE.holder && LEASE.expiresAt && LEASE.expiresAt > now);
  return {
    active,
    holder: active ? LEASE.holder : null,
    expiresInMs: active ? LEASE.expiresAt - now : 0,
    ttlMs: LEASE.ttlMs,
    since: LEASE.acquiredAt,
    renewals: LEASE.renewals,
  };
}

function leaseAcquire(holder, ttlMs, force) {
  const now = Date.now();
  const h = String(holder || "anonymous");
  const v = leaseView();
  if (v.active && v.holder !== h && !force) {
    return { denied: true, holder: v.holder, expiresInMs: v.expiresInMs };
  }
  if (!v.active || v.holder !== h) {
    LEASE.token = "lk_" + randomBytes(5).toString("hex");
    LEASE.acquiredAt = now;
    LEASE.renewals = 0;
  } else {
    LEASE.renewals++;
  }
  LEASE.holder = h;
  if (ttlMs) LEASE.ttlMs = Math.max(5000, Math.min(86400000, Number(ttlMs) || LEASE.ttlMs));
  LEASE.expiresAt = now + LEASE.ttlMs;
  return { granted: true, lease: leaseView() };
}

// 只读 op：即便别人持有租约也放行（否则连「看看现状」都会被挡）。
//
// 这份名单与上游 server.mjs 的关系，得说准，否则它比没有注释更糟：
//
//   1) 与上游同名的路由（/rt/perf、/rt/loop、/rt/opt、/rt/plan、/rt/worker、
//      /rt/txn、/rt/preset、/rt/job）：名单内容与上游逐条一致。
//      前缀加了 /rt/ 是因为 relay 同时挂自研路由（/do、/render、/service），
//      需要一个命名空间把它们分开。
//
//   2) /rt/plan 里比上游多 6 个 qc_* （qc_compare / qc_compare_auto /
//      qc_self_check / qc_help / qc_render_catalog / qc_render_device_info）。
//      这 6 个**上游根本没有**——它们是 relay 拼出来发给 engine 的 op 名，
//      engine 按 qc_ 前缀分派。所以对的是「engine 的事实」，不是「上游的表」。
//      它们确实不改场景，列在这里是对的，但不该被读成「从上游抄来的」。
//
//   3) /object/edit 是 relay 独有的路由（上游没有这个端点），
//      它的只读项 trash_list 是本 App 自己的判断。
//
// ！维护规则：上游一改，第 1 类要手工同步；第 2/3 类不跟。
//   从前这里只写了「名单照搬上游」，于是一个多做、一个没抄、一个抄错，
//   三者看起来都一样——因为注释把三件事说成了一件事。
const READ_ONLY_OPS = {
  "/rt/perf": ["status", "help"],
  "/rt/loop": ["status", "board", "help"],
  "/rt/opt": ["opt_analyze", "analyze", "help"],
  "/rt/plan": ["status", "help", "ledger", "check_envelope", "check_interference", "check_interface",
    "plan_status", "plan_validate", "plan_diag", "plan_order", "plan_graph",
    "audit_mesh", "audit_scene", "audit_duplicates", "audit_help",
    "audit_connectivity", "audit_drift", "audit_measure", "audit_gate", "montage",
    "motion_status", "motion_help", "motion_joints", "deliver_help", "deliver_verify",
    "generator_list", "generator_get", "generator_diff", "generator_help",
    "qc_compare", "qc_compare_auto", "qc_self_check", "qc_help", "qc_render_catalog", "qc_render_device_info",
    "mate_check", "fit_help"],
  "/rt/worker": ["status"],
  "/rt/txn": ["list", "marks", "help", "edit_status"],
  "/rt/preset": ["list", "get", "help"],
  "/rt/job": ["status", "collect", "list"],
  "/object/edit": ["trash_list", "hidden_list"],
};

function isReadOnlyOp(path, op) {
  const list = READ_ONLY_OPS[path];
  return !!(list && list.indexOf(String(op)) >= 0);
}

// 请求带 holder/force 时的门禁；返回 null = 放行
function leaseGate(payload) {
  const h = String((payload && (payload.holder || payload.lease)) || "");
  const force = !!(payload && payload.force);
  const v = leaseView();
  if (v.active && v.holder !== h && !force) {
    return {
      ok: false, error: "leased", holder: v.holder, expiresInMs: v.expiresInMs,
      hint: `另一个会话正在驱动这个 Blender。要么等它（剩余 ${Math.round(v.expiresInMs / 1000)}s），要么加 force:true 抢占。`,
    };
  }
  // 放行时顺手续期：holder 匹配或无人持有时自动接管
  if (!h) return null; // 没报 holder 的调用：无租约时按旧行为放行
  const r = leaseAcquire(h, null, force);
  return r.denied ? { ok: false, error: "leased", holder: r.holder, expiresInMs: r.expiresInMs, hint: "租约已被占用" } : null;
}

// 统一走「只读豁免 → 否则过门禁」的判断
function gateFor(path, op, payload) {
  if (isReadOnlyOp(path, op)) return null;
  return leaseGate(payload);
}

const CFG_PATH = process.argv[2];
if (!CFG_PATH) {
  console.error("FATAL blender-relay: 缺少配置文件参数");
  process.exit(2);
}

let cfg;
try {
  cfg = JSON.parse(readFileSync(CFG_PATH, "utf8"));
} catch (e) {
  console.error(`FATAL blender-relay: 读取配置失败 ${e?.message || e}`);
  process.exit(2);
}

// ── G1 · 调用方密钥（发布审查五道闸之一）──────────────────────────────
//
// 口径（Hana App 发布手册 §1.1 G1）：密钥**经 argv 末位传入**，不落盘。
//   为何不是 env：宿主对 env 有白名单，递不进来。所以只有 argv 这一条。
//   为何不是配置文件：那等于把密钥放到磁盘上（而我们更早的版本就是那么做的）
//   —— 而分隔源码里自己就写了 “Windows 上 0600 权限位不保证生效”。
//
// 与 hanako-gallery / hanako-mail 同形：启动方每次生成、注入末位、请求头带上。
const CONTROL_KEY = String(process.argv[3] || "");
if (!CONTROL_KEY) {
  console.error("FATAL blender-relay: 缺少调用方密钥（argv[3]）");
  process.exit(2);
}

// CFG_PATH 里仍有明文 key 的旧版本残留？现在不写了，但读取侧仍兼容一份已删的文件。
// 读完立刻删：配置文件里虽已无密钥，但端口/readyMarker 也不该积在磁盘上。
try { rmSync(CFG_PATH, { force: true }); } catch { /* 忽略 */ }

const PORT = Number(cfg.port);
const READY_MARKER = String(cfg.readyMarker || "");
const CONTROL_KEY_LEGACY_UNUSED = String(cfg.controlKey || ""); // 旧配置里可能还有；不再使用
const ADDON_HOST = String(cfg.addonHost || "127.0.0.1");
const ADDON_PORT = Number(cfg.addonPort || 9876);
const WORK_DIR = String(cfg.workDir || "");
const DEFAULT_TIMEOUT_MS = Number(cfg.timeoutMs || 30_000);
const LOG_FILE = cfg.logFile ? String(cfg.logFile) : "";

if (!Number.isInteger(PORT) || PORT <= 0) {
  console.error("FATAL blender-relay: 配置 port 非法");
  process.exit(2);
}
if (!READY_MARKER) {
  console.error("FATAL blender-relay: 配置 readyMarker 缺失");
  process.exit(2);
}

// 免鉴权面自检：白名单与「允许的方法」必须同键。
// 错了就拒绝起服务——比起带着一个没人看得见的口子跑，宁可不起。
{
  const problems = checkPolicy();
  if (problems.length) {
    console.error(`FATAL blender-relay: 免鉴权面策略自检失败：${problems.join("；")}`);
    process.exit(2);
  }
}

// ── 日志 ─────────────────────────────────────────────────────────────────────
function log(...parts) {
  const line = `[blender-relay ${new Date().toISOString()}] ${parts.join(" ")}`;
  console.log(line);
}

// ── 工作目录（截图 / 脚本落盘）────────────────────────────────────────────────
function ensureWorkDir() {
  if (!WORK_DIR) return "";
  try {
    mkdirSync(WORK_DIR, { recursive: true });
    return WORK_DIR;
  } catch (e) {
    log(`工作目录不可用：${e?.message || e}`);
    return "";
  }
}
const WORK = ensureWorkDir();

const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 8MB，够 1600px PNG

function resolveShotPath(raw) {
  const name = raw && typeof raw === "string" && raw.trim() ? raw.trim() : `shot-${Date.now()}.png`;
  const safe = name.replace(/[\\/]+/g, "_").replace(/[^A-Za-z0-9._-]/g, "_");
  if (WORK) return join(WORK, safe);
  // 没有工作目录就落到临时目录
  return join(process.env.TEMP || process.env.TMP || ".", safe);
}

function readImageAsDataUrl(filepath) {
  try {
    const buf = readFileSync(filepath);
    if (!buf.length) return null;
    if (buf.length > MAX_IMAGE_BYTES) {
      return { tooBig: true, bytes: buf.length };
    }
    const lower = filepath.toLowerCase();
    const mime = lower.endsWith(".jpg") || lower.endsWith(".jpeg") ? "image/jpeg" : "image/png";
    // 返回纯 base64 + 分开的 mimeType：宿主工具结果的 image 项要的是这两个字段，
    // 不是拼好的 data URL（塞 data URL 会被宿主当非法形状拒掉）。
    return { base64: buf.toString("base64"), mimeType: mime, bytes: buf.length };
  } catch {
    return null;
  }
}

// ── Blender addon 连接（单连接 · 请求串行）────────────────────────────────────
//
// addon 的应答没有 request id，所以整条链路必须严格串行：
// 一次只有一个在途请求，拿到完整一行 JSON 后再发下一个。
let socket = null;
let socketReady = false;
let connecting = null;
let recvBuffer = "";
let pending = null; // { resolve, reject, timer, cmd }
let lastError = "";
const metrics = { calls: 0, errors: 0, timeouts: 0, lastLatencyMs: 0, connectedAt: 0 };

function teardownSocket(reason) {
  if (pending) {
    const p = pending;
    pending = null;
    clearTimeout(p.timer);
    p.reject(new Error(reason || "连接已断开"));
  }
  if (socket) {
    try { socket.removeAllListeners(); socket.destroy(); } catch { /* 忽略 */ }
  }
  socket = null;
  socketReady = false;
  recvBuffer = "";
  if (reason) lastError = reason;
}

function handleLine(line) {
  const text = line.trim();
  if (!text) return;
  if (!pending) {
    log(`收到无主应答（丢弃）：${text.slice(0, 200)}`);
    return;
  }
  const p = pending;
  pending = null;
  clearTimeout(p.timer);
  metrics.lastLatencyMs = Date.now() - p.startedAt;
  if (p.startedAt) metrics.calls += 1;

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    p.reject(new Error(`应答不是合法 JSON（addon 协议异常）：${text.slice(0, 300)}`));
    return;
  }
  p.resolve(parsed);
}

function onData(chunk) {
  recvBuffer += chunk.toString("utf8");
  // 一行一个 JSON；正常只有一个应答，谨慎起见循环切分。
  for (;;) {
    const nl = recvBuffer.indexOf("\n");
    if (nl < 0) break;
    const line = recvBuffer.slice(0, nl);
    recvBuffer = recvBuffer.slice(nl + 1);
    handleLine(line);
  }
  // 有些实现不补换行：缓冲看起来是完整 JSON 时就收下。
  const trimmed = recvBuffer.trim();
  if (trimmed.length > 1 && trimmed.startsWith("{")) {
    try {
      JSON.parse(trimmed);
      recvBuffer = "";
      handleLine(trimmed);
    } catch {
      // 还不完整，继续等
    }
  }
}

function connect(timeoutMs = 6000) {
  if (socket && socketReady) return Promise.resolve();
  if (connecting) return connecting;

  connecting = new Promise((resolvePromise, rejectPromise) => {
    const sock = new net.Socket();
    let settled = false;
    const done = (err) => {
      if (settled) return;
      settled = true;
      connecting = null;
      if (err) {
        try { sock.destroy(); } catch { /* 忽略 */ }
        rejectPromise(err);
      } else {
        resolvePromise();
      }
    };
    const timer = setTimeout(() => {
      done(new Error(`连接 ${ADDON_HOST}:${ADDON_PORT} 超时（${timeoutMs}ms）——Blender 或 addon 未就绪`));
    }, timeoutMs);
    timer.unref?.();

    sock.setNoDelay(true);
    sock.once("connect", () => {
      clearTimeout(timer);
      socket = sock;
      socketReady = true;
      metrics.connectedAt = Date.now();
      lastError = "";
      sock.on("data", onData);
      sock.on("error", (e) => {
        lastError = `socket 错误：${e?.message || e}`;
        teardownSocket(lastError);
      });
      sock.on("close", () => {
        if (socket === sock) teardownSocket("连接被对端关闭（Blender 可能已退出，或 addon 断开）");
      });
      log(`已连接 Blender addon ${ADDON_HOST}:${ADDON_PORT}`);
      done(null);
    });
    sock.once("error", (e) => {
      clearTimeout(timer);
      done(new Error(`无法连接 ${ADDON_HOST}:${ADDON_PORT} —— ${e?.message || e}`));
    });
    try {
      sock.connect(ADDON_PORT, ADDON_HOST);
    } catch (e) {
      clearTimeout(timer);
      done(new Error(`发起连接失败：${e?.message || e}`));
    }
  });

  return connecting;
}

// 【关键架构（v0.7.0）】send() 委托给上游 dsh engine 的 AddonClient ——
//   **全进程只保留一条 addon 连接**。若 relay 自己再开一条，就会有两条 TCP，
//   而 addon 的命令队列是全局串行的（多连接零收益），徒增交错与重连复杂度。
//
// 返回形状保持**原始** {status, result} —— 不走上游协议层的 post 改写，
// 因为 relay 现有代码（see / sceneInfo / doCode / renderPass / assets）都按原形取字段。
async function sendViaDshEngine(commandType, params = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const e = await getDshEngine();
  const raw = await e.addon.send(commandType, params || {}, timeoutMs);
  // AddonClient.send 巳经把 error 抛成异常；在这里归一成 {status,result} 兼容旧代码
  if (raw && typeof raw === "object" && ("status" in raw)) return raw;
  return { status: "success", result: raw };
}

async function send(commandType, params = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return sendViaDshEngine(commandType, params, timeoutMs);
}

// 旧实现（自开一条 TCP）保留为降级路径：当 dsh runtime 加载失败时仍能用。
async function sendLegacy(commandType, params = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  await connect();
  if (!socket || !socketReady) throw new Error(lastError || "与 Blender 的连接不可用");

  if (pending) {
    // 上一单还没回：等它结算（串行不并发）
    await new Promise((res) => setTimeout(res, 50));
    if (pending) throw new Error("上一个请求仍在进行（addon 单连接串行，请稍后重试）");
  }

  const startedAt = Date.now();
  const payload = JSON.stringify({ type: commandType, params }) + "\n";

  const answer = await new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      metrics.timeouts += 1;
      pending = null;
      rejectPromise(new Error(`命令 ${commandType} 超时（${timeoutMs}ms）`));
    }, timeoutMs);
    timer.unref?.();
    pending = { resolve: resolvePromise, reject: rejectPromise, timer, startedAt };
    try {
      socket.write(payload, "utf8", (err) => {
        if (err) {
          clearTimeout(timer);
          pending = null;
          rejectPromise(new Error(`写 socket 失败：${err?.message || err}`));
        }
      });
    } catch (e) {
      clearTimeout(timer);
      pending = null;
      rejectPromise(new Error(`写 socket 异常：${e?.message || e}`));
    }
  });

  const status = answer && answer.status;
  if (status === "error") {
    metrics.errors += 1;
    const msg = answer.message || (answer.result && answer.result.error) || "addon 返回 error";
    const err = new Error(String(msg));
    err.addon = answer;
    throw err;
  }
  return answer;
}

// ── 高层动作（供 HTTP 控制面调用）────────────────────────────────────────────

// 取景：截图落盘后读回，回 data URL + 路径
async function see(params = {}) {
  const maxSize = Number(params.maxSize || params.max_size || 900);
  const format = String(params.format || "png").replace(/^\./, "");
  const filename = params.file || params.filename || `see-${Date.now()}.${format}`;
  const filepath = resolveShotPath(filename);
  const res = await send(
    "get_viewport_screenshot",
    { max_size: maxSize, filepath, format },
    Number(params.timeoutMs || 30_000),
  );
  const image = readImageAsDataUrl(filepath);
  return {
    ok: true,
    file: filepath,
    addon: res?.result ?? null,
    image: image && image.base64 ? image.base64 : null,
    mimeType: image && image.mimeType ? image.mimeType : "image/png",
    imageTooBig: !!(image && image.tooBig),
    bytes: image && image.bytes ? image.bytes : 0,
  };
}

// 执行：任意 Blender Python
async function doCode(code, timeoutMs) {
  if (typeof code !== "string" || !code.trim()) throw new Error("code 不能为空");
  const res = await send("execute_code", { code }, Number(timeoutMs || 60_000));
  return { ok: true, result: res?.result ?? null };
}

// 场景信息
async function sceneInfo() {
  const res = await send("get_scene_info", {}, 20_000);
  return { ok: true, result: res?.result ?? null };
}

// 物体信息
async function objectInfo(name) {
  if (typeof name !== "string" || !name.trim()) throw new Error("name 不能为空");
  const res = await send("get_object_info", { name }, 20_000);
  return { ok: true, result: res?.result ?? null };
}

// ── 3D 模型增删（/object/edit）────────────────────────────────────────
//
// 为什么单独做一个端点，而不是让人用 /do 跑一段 bpy：
//   增删是最高频的建模动作，用 /do 意味着每次都要现场拼一段 Python——
//   拼错了就是静默地建错/删错，而且删是不可逆的。
//   固定动作固定实现，参数由 schema 约束，出错面小得多。
//
// 删一律进回收站（不真删）：删模型是破坏性操作，得留后路。
// 具体做法是把物体移出当前集合并改名收进一个隐藏集合，
// 而不是 bpy.data.objects.remove()。
const PRIMITIVE_KINDS = ["cube", "sphere", "cylinder", "cone", "torus", "plane", "monkey"];
const TRASH_COLLECTION = "_blender_bridge_trash";

function objectEditCode(op, p) {
  const L = [];
  const q = (v) => JSON.stringify(v);
  // 向量必须是 3 个分量。
  // ！这里踩过：早先写成 (a||[]).map(...)，空数组 map 出来还是空，
  //   生成的代码变成 location=() —— Blender 直接报
  //   “sequences of dimension 0 should contain 3 items, not 0”。
  //   默认值要在函数里兜住，不要在调用点各自打补丁。
  const vec = (a, dflt) => {
    const src = Array.isArray(a) && a.length ? a : dflt;
    const out = [0, 0, 0];
    for (let i = 0; i < 3; i++) {
      const n = Number(src[i]);
      out[i] = Number.isFinite(n) ? n : 0;
    }
    return `(${out.join(",")})`;
  };
  const V0 = [0, 0, 0];
  const V1 = [1, 1, 1];

  // 公共开头：取场景
  L.push("_sc = bpy.context.scene", "_out = {}");

  if (op === "add") {
    const kind = String(p.kind || "cube").toLowerCase();
    if (PRIMITIVE_KINDS.indexOf(kind) < 0) {
      throw new Error(`kind 不支持：${kind}（可用：${PRIMITIVE_KINDS.join(" / ")}）`);
    }
    L.push(`_loc = ${vec(p.location, V0)}`, `_rot = ${vec(p.rotation, V0)}`, `_scl = ${vec(p.scale, V1)}`);
    // bpy.ops 建基础体：用 size/radius 由 scale 统一接管，避免两套尺寸参数打架
    const opName = {
      cube: "primitive_cube_add", sphere: "primitive_uv_sphere_add", cylinder: "primitive_cylinder_add",
      cone: "primitive_cone_add", torus: "primitive_torus_add", plane: "primitive_plane_add",
      monkey: "primitive_monkey_add",
    }[kind];
    L.push(`_before = set(bpy.data.objects.keys())`);
    L.push(`bpy.ops.mesh.${opName}(location=_loc, rotation=_rot)`);
    L.push(`_new = [n for n in bpy.data.objects.keys() if n not in _before]`);
    L.push(`_ob = bpy.data.objects[_new[0]] if _new else bpy.context.active_object`);
    L.push(`_ob.scale = _scl`);
    if (p.name) L.push(`_ob.name = ${q(String(p.name))}`);
    if (p.material) L.push(`_m = bpy.data.materials.get(${q(String(p.material))})`, `if _m:`, `    _ob.data.materials.append(_m)`);
    L.push(`_out = {"name": _ob.name, "type": _ob.type, "location": list(_ob.location)}`);
  } else if (op === "remove") {
    const names = Array.isArray(p.names) ? p.names : (p.name ? [p.name] : []);
    if (!names.length) throw new Error("names 不能为空");
    L.push(`_names = ${q(names.map(String))}`);
    L.push(`_trash = bpy.data.collections.get(${q(TRASH_COLLECTION)})`);
    L.push(`if _trash is None:`, `    _trash = bpy.data.collections.new(${q(TRASH_COLLECTION)})`, `    _sc.collection.children.link(_trash)`);
    L.push(`_trash.hide_viewport = True`, `_trash.hide_render = True`);
    L.push(`_done = []`, `_miss = []`);
    L.push(`for _n in _names:`);
    L.push(`    _ob = bpy.data.objects.get(_n)`);
    L.push(`    if _ob is None:`);
    L.push(`        _miss.append(_n); continue`);
    L.push(`    for _c in list(_ob.users_collection):`);
    L.push(`        _c.objects.unlink(_ob)`);
    L.push(`    _trash.objects.link(_ob)`);
    L.push(`    _done.append(_n)`);
    L.push(`_out = {"removed": _done, "missing": _miss, "trash": ${q(TRASH_COLLECTION)}}`);
  } else if (op === "restore") {
    // 从回收站捞回来。删错了不至于没救。
    const names = Array.isArray(p.names) ? p.names : (p.name ? [p.name] : []);
    if (!names.length) throw new Error("names 不能为空");
    L.push(`_names = ${q(names.map(String))}`);
    L.push(`_trash = bpy.data.collections.get(${q(TRASH_COLLECTION)})`);
    L.push(`_root = _sc.collection`);
    L.push(`_done = []`, `_miss = []`);
    L.push(`for _n in _names:`);
    L.push(`    _ob = bpy.data.objects.get(_n)`);
    L.push(`    if _ob is None or _trash is None or _ob.name not in _trash.objects:`);
    L.push(`        _miss.append(_n); continue`);
    L.push(`    _trash.objects.unlink(_ob)`);
    L.push(`    _root.objects.link(_ob)`);
    L.push(`    _done.append(_n)`);
    L.push(`_out = {"restored": _done, "missing": _miss}`);
  } else if (op === "hide" || op === "show") {
    // 隐藏 / 显示。
    //
    // 为何要单独一个 op 而不是用 do 跑一段 bpy：
    //   隐藏/显示是装配体建模里最高频的操作（拍内部、做爆炸图、分部件看）。
    //   而“用 do 绕过”意味着没归档、没回执、没撤销点——
    //   而且每个人每次都要自己拼同一段 Python，拼错不会报错，只会静默地没生效。
    //
    // 为何不用 collection 做（像 remove 那样）：
    //   隐藏是**状态**，不是位置。把物体挪进隐藏 collection，
    //   等于用“换个地方”去模拟“看不见”——于是父级关系、修改器引用、
    //   驱动表达式都会被意外断掉。而 viewport/render 开关就是干这个的。
    //
    // 三对开关都要动：只改 hide_viewport 的话，
    //   视口里看不见了、渲染却还出来——那是最坑人的一种“好像生效了”。
    const names = Array.isArray(p.names) ? p.names : (p.name ? [p.name] : []);
    if (!names.length) throw new Error("names 不能为空");
    const on = op === "hide";
    L.push(`_names = ${q(names.map(String))}`);
    L.push(`_target = ${on ? "True" : "False"}`);
    L.push(`_done = []`, `_miss = []`);
    L.push(`for _n in _names:`);
    L.push(`    _ob = bpy.data.objects.get(_n)`);
    L.push(`    if _ob is None:`);
    L.push(`        _miss.append(_n); continue`);
    // hide_viewport 作用于物体（仅视口），hide_set 作用于视图图层（包括渲染预览）
    L.push(`    _ob.hide_viewport = _target`);
    L.push(`    _ob.hide_render = _target`);
    L.push(`    _done.append(_n)`);
    // 回执带“现在还剩几件可见”，否则只能靠人眼确认
    L.push(`_vis = [o.name for o in bpy.context.scene.objects if o.type == 'MESH' and not o.hide_viewport]`);
    L.push(`_hid = [o.name for o in bpy.context.scene.objects if o.type == 'MESH' and o.hide_viewport]`);
    L.push(`_out = {"op": ${q(op)}, "done": _done, "missing": _miss, "visible": len(_vis), "hidden": _hid}`);
  } else if (op === "hidden_list") {
    // 列出当前藏起来的。
    // 为何要它：隐藏是“看不见”的状态，而**看不见的东西最容易被忘掉**。
    // 没有这个，人会以为“模型怎么少了件”而不知道是自己昨天藏的。
    L.push(`_hid = [o.name for o in bpy.context.scene.objects if o.hide_viewport or o.hide_render]`);
    L.push(`_out = {"hidden": _hid, "count": len(_hid)}`);
  } else if (op === "rename") {
    if (!p.name) throw new Error("name 必填");
    if (!p.to) throw new Error("to 必填（新名字）");
    L.push(`_ob = bpy.data.objects.get(${q(String(p.name))})`);
    L.push(`if _ob is None: _out = {"ok": False, "error": "找不到物体"}`);
    L.push(`else:`, `    _old = _ob.name`, `    _ob.name = ${q(String(p.to))}`, `    _out = {"from": _old, "to": _ob.name}`);
  } else if (op === "duplicate") {
    if (!p.name) throw new Error("name 必填");
    L.push(`_src = bpy.data.objects.get(${q(String(p.name))})`);
    L.push(`if _src is None: _out = {"ok": False, "error": "找不到物体"}`);
    L.push(`else:`);
    L.push(`    _cp = _src.copy()`);
    L.push(`    if _src.data: _cp.data = _src.data.copy()`);
    L.push(`    _sc.collection.objects.link(_cp)`);
    if (p.to) L.push(`    _cp.name = ${q(String(p.to))}`);
    if (p.offset) L.push(`    _off = ${vec(p.offset, V0)}`, `    _cp.location = (_cp.location[0]+_off[0], _cp.location[1]+_off[1], _cp.location[2]+_off[2])`);
    L.push(`    _out = {"name": _cp.name, "from": _src.name}`);
  } else if (op === "trash_list") {
    L.push(`_trash = bpy.data.collections.get(${q(TRASH_COLLECTION)})`);
    L.push(`_out = {"objects": [o.name for o in _trash.objects] if _trash else []}`);
  } else if (op === "purge") {
    // 真删回收站里的东西。单独一步、要显式调用——不可逆的操作不该顺手做。
    L.push(`_trash = bpy.data.collections.get(${q(TRASH_COLLECTION)})`);
    L.push(`_n = 0`);
    L.push(`if _trash:`);
    L.push(`    for _ob in list(_trash.objects):`);
    L.push(`        bpy.data.objects.remove(_ob, do_unlink=True); _n += 1`);
    L.push(`    bpy.data.collections.remove(_trash)`);
    L.push(`_out = {"purged": _n}`);
  } else {
    throw new Error(`op 不支持：${op}（可用：add / remove / restore / rename / duplicate / trash_list / purge）`);
  }

  L.push("print(__import__('json').dumps(_out, ensure_ascii=False))");
  return L.join("\n");
}

// 从 addon 的返回里剥出结构化结果。
//
// addon 的 execute_code 返回 {executed:true, result:"<stdout>"}，
// 真正的输出在 result 里。而早先把 raw 当字符串找 output/stdout/text ——
// 全部落空、解析出 null，外面看到的是“没有可移除的物体”（而不是报错）。
//
// 提成纯函数是为了能被测试直接调用——测产品代码，不是测副本。
function unwrapAddonResult(res) {
  // ！注意：不能直接 res?.result —— 如果 res 本身就是字符串，
  //   字符串没有 .result，会得到 undefined 而丢掉真正的输出。
  let raw = (res && typeof res === "object" && !Array.isArray(res))
    ? (res.result ?? res.output ?? res.stdout ?? res.text ?? res)
    : res;
  raw = raw ?? null;
  // 一层层剥到字符串（或到底）
  for (let depth = 0; depth < 3; depth++) {
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const inner = raw.result ?? raw.output ?? raw.stdout ?? raw.text ?? null;
      if (inner === null) break;
      raw = inner;
    } else break;
  }
  if (typeof raw === "string") {
    // stdout 里可能有别的打印，取最后一个 JSON 对象
    const m = raw.match(/\{[\s\S]*\}\s*$/);
    if (m) { try { return JSON.parse(m[0]); } catch { return null; } }
    return null;
  }
  if (raw && typeof raw === "object") return raw;
  return null;
}

async function objectEdit(body) {
  const op = String(body.op || "");
  if (!op) throw new Error("op 必填（add / remove / restore / hide / show / hidden_list / rename / duplicate / trash_list / purge）");
  const code = objectEditCode(op, body);
  const res = await send("execute_code", { code }, Number(body.timeoutMs || 60_000));
  const parsed = unwrapAddonResult(res);

  if (parsed && parsed.ok === false) {
    return { ok: false, error: parsed.error || "操作未完成", op, result: parsed };
  }
  // 解析不出来不算失败，但要能看出来：把原文一并带回去。
  // 静默返回 null 才是最难查的那种错。
  if (!parsed) {
    return {
      ok: false,
      op,
      error: `没能从 addon 返回里解析出结果（op=${op}）`,
      rawTail: JSON.stringify(res?.result ?? null).slice(0, 300),
    };
  }
  return { ok: true, op, result: parsed };
}

// 通道健康（三级诊断：TCP → addon → bpy 往返）
async function doctor() {
  const out = {
    ok: false,
    addonHost: ADDON_HOST,
    addonPort: ADDON_PORT,
    workDir: WORK,
    tcp: "unknown",
    addon: "unknown",
    bpy: "unknown",
    latencyMs: null,
    lastError: lastError || null,
  };
  const t0 = Date.now();
  // 【单连接】不再自己 connect()：send() 已走上游 engine 的唯一连接。
  //   先前这里调 connect() 会多开一条 TCP（日志里那行「已连接 Blender addon」就是它）。
  //   TCP 可达性改由 send("ping") 的结果反推。
  try {
    const pong = await send("ping", {}, 8000);
    out.tcp = "ok";
    out.addon = pong?.status === "success" ? "ok" : "unexpected";
    out.latencyMs = Date.now() - t0;
  } catch (e) {
    const m = String(e?.message || e);
    // 区分「连不上」与「连上了但 addon 报错」
    if (/ECONNREFUSED|ENOTFOUND|socket hang up|无法连接/i.test(m)) {
      out.tcp = "fail";
    } else {
      out.tcp = "ok";
      out.addon = "fail";
    }
    out.lastError = m;
    return out;
  }
  try {
    const info = await send("get_addon_info", {}, 12_000);
    out.bpy = info?.status === "success" ? "ok" : "unexpected";
    out.addonInfo = info?.result ?? null;
  } catch (e) {
    // ping 通但 get_addon_info 不通：可能是精简版 addon，不算致命
    out.bpy = "unavailable";
    out.bpyNote = String(e?.message || e);
  }
  out.ok = out.tcp === "ok" && out.addon === "ok" && out.bpy !== "fail";
  out.latencyMs = Date.now() - t0;
  return out;
}

// ── 渲染（P3）───────────────────────────────────────────────────────────────
// 实测（Blender 5.2.2，2026-10-13，非推断）：
//   EEVEE 极快：400x260 = 0.5s，960x540 = 0.26s，1920x1080 = 0.69s。
//   ❗ 不能靠 bpy.ops.render.render('INVOKE_DEFAULT') + render_complete handler：
//     后台模态渲染的完成回调在主线程才触发，实测标记文件永远不写（handler 累积也移除不掉）。
// ✔ 正解：Blender 侧**同步** render(write_still=True)（文件写完才返回，完成检测 100% 可靠），
//   relay 侧用 fire-and-forget 立即返回 jobId，由 /render/status 轮询。
//   代价：渲染期间 Blender 主线程被占（其它命令排队）——这对渲染任务是可接受的，
//   而且 EEVEE 时长极短。
const renderJobs = new Map(); // jobId -> { state, file, startedAt, finishedAt, info, error }
const RENDER_JOB_TTL_MS = 30 * 60 * 1000;

function pruneRenderJobs() {
  const now = Date.now();
  for (const [id, j] of renderJobs) {
    const ref = j.finishedAt || j.startedAt;
    if (now - ref > RENDER_JOB_TTL_MS) renderJobs.delete(id);
  }
}

async function renderStart(params = {}) {
  pruneRenderJobs();
  const engine = String(params.engine || "BLENDER_EEVEE");
  const width = Number(params.width) || 0;
  const height = Number(params.height) || 0;
  const frame = Math.max(1, Math.floor(Number(params.frame) || 1));
  const fmt = String(params.format || "PNG").toUpperCase();
  const rawName = params.file && String(params.file).trim() ? String(params.file).trim() : `render-${Date.now()}`;
  const safe = rawName.replace(/[\\/]+/g, "_").replace(/[^A-Za-z0-9._-]/g, "_");
  const stem = safe.replace(/\.[A-Za-z0-9]+$/, "");
  const outFile = resolveShotPath(`${stem}.${fmt.toLowerCase()}`);
  const jobId = "rnd-" + randomBytes(8).toString("hex");

  // 同步渲染脚本：write_still=True 会等文件真正写完才返回
  const code = [
    "import bpy, os, time",
    `_out = r"${outFile}"`,
    "_sc = bpy.context.scene",
    "if _sc.camera is None:",
    "    raise RuntimeError('场景无相机，无法渲染')",
    `_sc.render.engine = '${engine}'`,
    `_sc.render.filepath = _out`,
    `_sc.render.image_settings.file_format = '${fmt}'`,
    `_sc.frame_set(${frame})`,
    width ? `_sc.render.resolution_x = ${Math.max(16, Math.min(4096, width))}` : "pass",
    height ? `_sc.render.resolution_y = ${Math.max(16, Math.min(4096, height))}` : "pass",
    "_t0 = time.time()",
    "bpy.ops.render.render(write_still=True)",
    "_el = time.time() - _t0",
  ].join("\n");

  const job = {
    state: "running",
    file: outFile,
    startedAt: Date.now(),
    finishedAt: null,
    info: null,
    error: null,
  };
  renderJobs.set(jobId, job);
  log(`渲染已发起 jobId=${jobId} engine=${engine} ${width || "?"}x${height || "?"} → ${outFile}`);

  // fire-and-forget：不 await，立即把 jobId 交给调用方
  void (async () => {
    const t0 = Date.now();
    try {
      await send("execute_code", { code }, 600_000);
      // 【设计决定・实测依据】不靠 stdout 回传信息：
      //   addon 的 execute_code result = stdout，而真实渲染会往 stdout 打大量
      //   "Fra:1 ..." 采样进度行，标记 JSON 会被冲掉/截断（实测解析不到）。
      //   write_still=True 是同步的——命令返回即文件已写完，所以直接 stat 文件就够，
      //   耗时由中继自己计。这比解析 stdout 可靠得多。
      let sz = 0;
      let exists = false;
      try { sz = statSync(outFile).size; exists = sz > 0; } catch { exists = false; }
      job.info = {
        file: outFile,
        bytes: sz,
        engine,
        res: width && height ? [width, height] : null,
        frame,
        elapsedSec: Math.round(((Date.now() - t0) / 1000) * 100) / 100,
        exists,
      };
      job.state = exists ? "completed" : "failed";
      if (!exists) job.error = "渲染命令已返回，但输出文件不存在或为空";
      job.finishedAt = Date.now();
      log(`渲染完成 jobId=${jobId}（${job.info.elapsedSec}s，${sz} bytes）`);
    } catch (e) {
      job.state = "failed";
      job.error = String((e && e.message) || e);
      job.finishedAt = Date.now();
      log(`渲染失败 jobId=${jobId}：${job.error}`);
    }
  })();

  return {
    ok: true,
    jobId,
    state: "running",
    file: outFile,
    engine,
    res: width && height ? [width, height] : null,
  };
}

function renderStatus(jobId) {
  const job = renderJobs.get(jobId);
  if (!job) return { ok: false, error: `未知渲染 jobId: ${jobId}` };
  if (job.state === "failed") {
    return { ok: false, jobId, state: "failed", error: job.error };
  }
  if (job.state === "running") {
    return { ok: true, jobId, state: "running", file: job.file, elapsedMs: Date.now() - job.startedAt };
  }
  const image = readImageAsDataUrl(job.file);
  return {
    ok: true,
    jobId,
    state: "completed",
    file: job.file,
    info: job.info,
    elapsedMs: job.finishedAt - job.startedAt,
    bytes: image && image.bytes ? image.bytes : 0,
    image: image && image.base64 ? image.base64 : null,
    mimeType: image && image.mimeType ? image.mimeType : "image/png",
    imageTooBig: !!(image && image.tooBig),
  };
}

// ── 渲染通道（P4）：depth / normal / color → PNG（喂 ComfyUI ControlNet）────────
// 这一块试错了 5 轮，结论都是实测（Blender 5.2.2，2026-10-13）：
//   ✗ CompositorNodeOutputFile：**只能出 multilayer EXR**（item.format 设 PNG 也无效），
//         而这种 EXR 用 images.load() 读回来 size=(0,0)，像素取不到。
//   ✗ CompositorNodeComposite：**5.x 已移除**（92 个 Compositor 节点里没这个类型）。
//   ✗ scene.node_tree：5.x 已移除，合成器入口改为 scene.compositing_node_group（是个节点组）。
//   ✗ bpy.data.images['Render Result']：size 恒为 (0,0)，拿不到像素。
//   ✔ **正解：Viewer 节点**——RLayers.[pass] →（归一化）→ CompositorNodeViewer，
//         渲完后 bpy.data.images['Viewer Node'] 有**真实尺寸与像素**，
//         用 img.save_render(path) 直接写出 PNG（实测 320x200 → 11044 bytes，std=0.115 有真梯度）。
//   ❗ 代价：一个 pass 要渲一次（每个 pass 重建合成器树）。EEVEE 快，可接受。
//
// 【mask 通道】——三轮试探后的结论（Blender 5.2.2，2026-10-13）：
//   ✗ Object Index（IndexOB）在 5.x 的 RLayers 输出里**不存在**（即便 use_pass_object_index=True）。
//   △ Cryptomatte：打开 use_pass_cryptomatte_* 后 RLayers 确实吐出 CryptoObject00/01/02、
//         CryptoAsset、CryptoMaterial（这倒是个惊喜，5.x 有），但它是**编码的多通道数据**
//         （实测 std=0.47 但值域诡异、需要专用解码器），ComfyUI 直接读不懂。
//   ✔ **正解：Alpha 剪影**——film_transparent=True + 临时隐藏非目标物体 → RLayers.Alpha
//         出的是干净的二值剪影（实测 320x200：min=0.000 max=1.000，物体覆盖 16.7% 像素，
//         看图确认是黑底白块的清晰轮廓）。ComfyUI 直接可读，做 inpaint/局部重绘最好用。
//   ❗ mask 需要 object 参数（要谁的掩模）；不传则用场景第一个可见 MESH。
//   ❗ 隐藏/透明底是**临时改动**，渲完必须原样恢复（实测已恢复验证）。
const PASS_SPEC = {
  depth: { output: "Depth", normalize: true },
  normal: { output: "Normal", normalize: false },
  color: { output: "Image", normalize: false },
  alpha: { output: "Alpha", normalize: false },
  mist: { output: "Mist", normalize: true },
  position: { output: "Position", normalize: true },
};
// mask 走单独分支（需要隐藏物体 + 透明底），不进 PASS_SPEC 的通用路径

async function renderPass(params = {}) {
  const requested = Array.isArray(params.passes) && params.passes.length ? params.passes.map(String) : ["depth"];
  const valid = requested.filter((p) => p === "mask" || Object.prototype.hasOwnProperty.call(PASS_SPEC, p));
  if (!valid.length) {
    throw new Error(`passes 需含 depth/normal/color/alpha/mist/position/mask 之一，收到：${requested.join(",")}`);
  }
  const width = Number(params.width) || 0;
  const height = Number(params.height) || 0;
  const frame = Math.max(1, Math.floor(Number(params.frame) || 1));
  const stemRaw = params.file && String(params.file).trim() ? String(params.file).trim() : `pass-${Date.now()}`;
  const stem = stemRaw.replace(/[\\/]+/g, "_").replace(/[^A-Za-z0-9._-]/g, "_").replace(/\.[A-Za-z0-9]+$/, "");
  const outDir = WORK ? join(WORK, stem) : resolveShotPath(stem);

  // 逐个 pass 渲染：每个都重建合成器树 → Viewer → save_render
  const blocks = [];
  for (const p of valid) {
    const target = join(outDir, `channel_${p}.png`);
    if (p === "mask") {
      // mask 走单独逻辑：隐藏非目标 → film_transparent → Alpha 就是剪影
      blocks.push([
        `# ── pass: mask（Alpha 剪影） ──`,
        "for _nm in [i.name for i in bpy.data.images if i.name.startswith('Viewer Node')]:",
        "    bpy.data.images.remove(bpy.data.images[_nm])",
        `_tgt_name = ${params.object ? JSON.stringify(String(params.object)) : "None"}`,
        "if _tgt_name and _tgt_name in bpy.data.objects:",
        "    _target = bpy.data.objects[_tgt_name]",
        "elif _tgt_name:",
        "    raise RuntimeError('找不到物体: ' + _tgt_name)",
        "else:",
        "    _target = next((o for o in _sc.objects if o.type == 'MESH' and not o.hide_render), None)",
        "if _target is None:",
        "    raise RuntimeError('场景中没有可用作 mask 的网格物体')",
        "_saved = {}",
        "for _o in bpy.data.objects:",
        "    if _o.type == 'MESH':",
        "        _saved[_o.name] = _o.hide_render",
        "        _o.hide_render = (_o.name != _target.name)",
        "_saved_ft = _sc.render.film_transparent",
        "_sc.render.film_transparent = True",
        "try:",
        "    _tree.nodes.clear()",
        "    _rl = _tree.nodes.new('CompositorNodeRLayers')",
        "    _vw = _tree.nodes.new('CompositorNodeViewer')",
        "    _tree.links.new(_rl.outputs['Alpha'], _vw.inputs[0])",
        `    _sc.render.filepath = r"${target}"`,
        "    _sc.render.image_settings.file_format = 'PNG'",
        "    bpy.ops.render.render(write_still=True)",
        "    _vi = bpy.data.images.get('Viewer Node')",
        "    _ok = False",
        "    if _vi is not None and _vi.size[0] > 0:",
        `        _vi.save_render(r"${target}")`,
        `        _ok = os.path.exists(r"${target}") and os.path.getsize(r"${target}") > 0`,
        "finally:",
        "    _sc.render.film_transparent = _saved_ft",
        "    for _n, _v in _saved.items():",
        "        if _n in bpy.data.objects:",
        "            bpy.data.objects[_n].hide_render = _v",
        `_results.append({'pass': 'mask', 'target': _target.name, 'file': r"${target}", 'ok': _ok, 'size': list(_vi.size) if _vi is not None else None})`,
        "print('PASS_DONE', 'mask', _ok)",
      ].join("\n"));
      continue;
    }
    const spec = PASS_SPEC[p];
    blocks.push([
      `# ── pass: ${p} ──`,
      "# 【关键】渲前清掉 Viewer Node 缓存：它是按名字复用的 image，不清就会存出上一张",
      "for _nm in [i.name for i in bpy.data.images if i.name.startswith('Viewer Node')]:",
      "    bpy.data.images.remove(bpy.data.images[_nm])",
      "_tree.nodes.clear()",
      "_rl = _tree.nodes.new('CompositorNodeRLayers')",
      "_vw = _tree.nodes.new('CompositorNodeViewer')",
      `_src = _rl.outputs['${spec.output}']`,
      spec.normalize
        ? "_nrm = _tree.nodes.new('CompositorNodeNormalize'); _tree.links.new(_src, _nrm.inputs[0]); _tree.links.new(_nrm.outputs[0], _vw.inputs[0])"
        : "_tree.links.new(_src, _vw.inputs[0])",
      `_sc.render.filepath = r"${target}"`,
      "_sc.render.image_settings.file_format = 'PNG'",
      "bpy.ops.render.render(write_still=True)",
      "_vi = bpy.data.images.get('Viewer Node')",
      "_ok = False",
      "if _vi is not None and _vi.size[0] > 0:",
      `    _vi.save_render(r"${target}")`,
      `    _ok = os.path.exists(r"${target}") and os.path.getsize(r"${target}") > 0`,
      `_results.append({'pass': '${p}', 'file': r"${target}", 'ok': _ok, 'size': list(_vi.size) if _vi is not None else None})`,
      "print('PASS_DONE', '${p}', _ok)",
    ].join("\n"));
  }

  const codeStr = [
    "import bpy, os, json",
    `_d = r"${outDir}"`,
    "os.makedirs(_d, exist_ok=True)",
    "_sc = bpy.context.scene",
    "_vl = _sc.view_layers[0]",
    "if _sc.camera is None:",
    "    raise RuntimeError('场景无相机，无法渲染')",
    `_sc.render.engine = '${String(params.engine || "BLENDER_EEVEE")}'`,
    width ? `_sc.render.resolution_x = ${Math.max(16, Math.min(4096, width))}` : "pass",
    height ? `_sc.render.resolution_y = ${Math.max(16, Math.min(4096, height))}` : "pass",
    `_sc.frame_set(${frame})`,
    "_vl.use_pass_z = True",
    "_vl.use_pass_normal = True",
    "_vl.use_pass_mist = True",
    "_vl.use_pass_position = True",
    "if hasattr(_vl, 'use_pass_cryptomatte_object'):",
    "    _vl.use_pass_cryptomatte_object = True",
    "_sc.use_nodes = True",
    "if _sc.compositing_node_group is None:",
    "    _sc.compositing_node_group = bpy.data.node_groups.new('HanaComp', 'CompositorNodeTree')",
    "_tree = _sc.compositing_node_group",
    "_results = []",
    "import time as _t; _t0 = _t.time()",
    ...blocks.flatMap((b) => b.split("\n")),
    "_el = _t.time() - _t0",
    "_summary = {'dir': _d, 'results': _results, 'elapsedSec': round(_el, 2), 'res': [_sc.render.resolution_x, _sc.render.resolution_y], 'files': sorted(os.listdir(_d))}",
    "print('__PASS_SUMMARY__' + json.dumps(_summary))",
  ].join("\n");

  const res = await send("execute_code", { code: codeStr }, 600_000);
  const stdout = String((res && res.result) || "");
  const m = stdout.match(/__PASS_SUMMARY__(\{[^\n]*\})/);
  let info = null;
  if (m) { try { info = JSON.parse(m[1]); } catch { info = null; } }
  // 【不依赖 stdout 是经验】：渲染会打大量进度行把标记冲掉。真相以磁盘为准。
  if (!info) {
    let files = [];
    try { files = readdirSync(outDir); } catch { files = []; }
    info = {
      dir: outDir,
      files,
      results: files.filter((f) => /\.png$/i.test(f)).map((f) => ({ pass: f.replace(/^channel_|\.png$/gi, ""), file: join(outDir, f), ok: true })),
      fromDiskScan: true,
    };
  }

  // 主图：优先 color，否则第一张
  let primary = null;
  const pngs = (info.files || []).filter((f) => /\.png$/i.test(f));
  const pick = pngs.find((f) => /channel_color/i.test(f)) || pngs[0];
  if (pick) primary = join(info.dir || outDir, pick);
  const image = primary ? readImageAsDataUrl(primary) : null;

  return {
    ok: pngs.length > 0,
    dir: info.dir || outDir,
    info,
    primary,
    bytes: image && image.bytes ? image.bytes : 0,
    image: image && image.base64 ? image.base64 : null,
    mimeType: image && image.mimeType ? image.mimeType : "image/png",
    imageTooBig: !!(image && image.tooBig),
    raw: pngs.length ? null : stdout.slice(0, 600),
  };
}

// ── Blender 服务进程管理（启动 / 停止）──────────────────────────────────────
// 为什么要绕「计划任务」这一圈（照 comfyui-hana 已验证的范式，非推断）：
//   中继跑在宿主的受限令牌 + job object 里。中继直接 spawn 的子进程即使 detached +
//   unref，也会在中继退出时被 job 连带回收——宿主一重启 / App 一重载，正在跑的
//   Blender 就没了。改由 Task Scheduler 以当前用户身份拉起：天然脱离沙箱与 job。
// 与 ComfyUI 的差异：Blender 是单个 exe，无需 venv/python/main.py 解析。
const BLENDER_TASK_NAME = "HanaBlender-Backend";
const LAUNCHER_NAME = "blender-launcher.cmd";
const LAUNCHER_VBS_NAME = "blender-launcher.vbs";
const WSCRIPT_EXE = "C:\\Windows\\System32\\wscript.exe";
const PID_CACHE_MS = 5_000;

const serviceProc = {
  startedAt: null,
  blenderExe: null,
  launcher: null,
  logFile: null,
  lastError: null,
  lastStop: null,
};
let pidCache = { at: 0, pids: [] };

// 从配置读取 Blender exe（App 探测后写入；也可运行期由 /service 带参覆盖）
if (cfg.blenderExe && typeof cfg.blenderExe === "string") serviceProc.blenderExe = cfg.blenderExe;

function serviceStatePath() {
  const dir = WORK || process.cwd();
  return join(dir, "blender-service-state.json");
}

function loadServiceState() {
  try {
    const raw = JSON.parse(readFileSync(serviceStatePath(), "utf8"));
    for (const k of ["startedAt", "blenderExe", "launcher", "logFile"]) {
      if (raw && typeof raw[k] === "string" && raw[k]) serviceProc[k] = raw[k];
    }
  } catch { /* 首次运行没有状态文件，正常 */ }
}

function saveServiceState() {
  try {
    mkdirSync(dirname(serviceStatePath()), { recursive: true });
    writeFileSync(serviceStatePath(), JSON.stringify({ ...serviceProc, savedAt: new Date().toISOString() }, null, 2), "utf8");
  } catch (e) {
    log(`service-state 写入失败：${e?.message || e}`);
  }
}

function runExe(exe, args, timeoutMs = 20_000) {
  try {
    const r = spawnSync(exe, args, { encoding: "utf8", timeout: timeoutMs, windowsHide: true });
    return {
      code: r.status === null || r.status === undefined ? -1 : r.status,
      stdout: String(r.stdout || "").trim(),
      stderr: String(r.stderr || "").trim(),
      error: r.error ? String(r.error.message) : null,
    };
  } catch (e) {
    return { code: -1, stdout: "", stderr: "", error: String(e?.message || e) };
  }
}

// 9876 上正在监听的进程（撤下动作的靶子；按端口找，不依赖进程名，兼容手动启动的 Blender）
function listeningPids() {
  if (Date.now() - pidCache.at < PID_CACHE_MS) return pidCache.pids;
  const r = runExe("netstat.exe", ["-ano", "-p", "TCP"], 15_000);
  const pids = new Set();
  for (const line of String(r.stdout || "").split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5 || parts[0].toUpperCase() !== "TCP") continue;
    if (!parts[1].endsWith(`:${ADDON_PORT}`)) continue;
    if (String(parts[3]).toUpperCase() !== "LISTENING") continue;
    const pid = Number(parts[4]);
    if (Number.isInteger(pid) && pid > 0) pids.add(pid);
  }
  pidCache = { at: Date.now(), pids: [...pids] };
  return pidCache.pids;
}

// 解析 Blender 可执行文件：显式路径 → 配置 → 常见位置指纹
function resolveBlenderExe(overridePath) {
  const tried = [];
  const cands = [];
  if (overridePath) cands.push(String(overridePath));
  if (serviceProc.blenderExe) cands.push(serviceProc.blenderExe);
  // 常见位置（便携解压的目录名带版本号，所以用一层扫描）
  // 可用环境变量 BLENDER_HOME 指定非标准安装位置。
  const roots = [
    process.env.BLENDER_HOME,
    process.env.ProgramFiles && join(process.env.ProgramFiles, "Blender Foundation"),
    join(process.env.LOCALAPPDATA || "", "Programs"),
    "C:\\Program Files\\Blender Foundation",
  ];
  for (const root of roots) {
    if (!root || !existsSync(root)) continue;
    try {
      const stack = [root];
      let guard = 0;
      while (stack.length && guard < 400) {
        guard += 1;
        const dir = stack.pop();
        let entries = [];
        try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
        for (const e of entries) {
          const full = join(dir, e.name);
          if (e.isDirectory()) {
            if (e.name === "_setup" || e.name.startsWith(".")) continue;
            stack.push(full);
          } else if (e.name.toLowerCase() === "blender.exe") {
            cands.push(full);
          }
        }
      }
    } catch { /* 扫描失败继续 */ }
  }
  for (const c of cands) {
    if (!c) continue;
    if (existsSync(c)) return { ok: true, exe: c, tried };
    tried.push(c);
  }
  return { ok: false, tried, roots };
}

function serviceStatusPayload() {
  const pids = listeningPids();
  const exe = resolveBlenderExe();
  return {
    reachable: socketReady,
    listening: pids.length > 0,
    pids,
    addon: `${ADDON_HOST}:${ADDON_PORT}`,
    blenderExe: serviceProc.blenderExe || (exe.ok ? exe.exe : null),
    blenderFound: exe.ok,
    launcher: serviceProc.launcher,
    logFile: serviceProc.logFile,
    startedAt: serviceProc.startedAt,
    lastError: serviceProc.lastError,
    lastStop: serviceProc.lastStop,
  };
}

async function startBlenderService(overridePath) {
  // 已在跑（addon 可应答或端口有监听）→ 不重复拉起
  if (socketReady) {
    return { ok: true, already: true, reachable: true, addon: `${ADDON_HOST}:${ADDON_PORT}` };
  }
  if (listeningPids().length > 0) {
    // 有人占着端口但 addon 不应答：交给调用方重连
    return { ok: true, already: true, reachable: false, note: `端口 ${ADDON_PORT} 已被监听，但 addon 未应答（可能 addon 未启用或正在启动）` };
  }

  const t = resolveBlenderExe(overridePath);
  if (!t.ok) {
    serviceProc.lastError = "未找到 blender.exe（配置一个显式路径再试）";
    saveServiceState();
    return { ok: false, error: serviceProc.lastError, tried: t.tried, roots: t.roots };
  }

  const dir = WORK || process.cwd();
  const launcher = join(dir, LAUNCHER_NAME);
  const launcherVbs = join(dir, LAUNCHER_VBS_NAME);
  const logFile = join(dir, "blender-service.log");

  // 启动器：cd 到 exe 所在目录再起（便携版靠当前目录找数据）；日志重定向
  const exeDir = dirname(t.exe);
  const script = [
    "@echo off",
    "chcp 65001 >nul",
    `cd /d "${exeDir}"`,
    `"${t.exe}" >> "${logFile}" 2>&1`,
    "",
  ].join("\r\n");
  // 隐藏窗口：任务若直接指向 .cmd，Windows 会开一个可见控制台。用 wscript Run(...,0,False)。
  const useVbs = existsSync(WSCRIPT_EXE);
  const vbsScript = [
    "' Hana-Blender service launcher (auto-generated by the app; do not edit)",
    "' Purpose: run blender-launcher.cmd with a hidden window (no console popup from the scheduled task)",
    "Dim sh, q",
    "Set sh = CreateObject(\"WScript.Shell\")",
    "q = Chr(34)",
    `sh.Run "cmd /c " & q & "${launcher}" & q, 0, False`,
    "",
  ].join("\r\n");
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(launcher, script, "utf8");
    if (useVbs) writeFileSync(launcherVbs, vbsScript, "utf8");
  } catch (e) {
    serviceProc.lastError = `启动器写入失败：${e?.message || e}`;
    saveServiceState();
    return { ok: false, error: serviceProc.lastError };
  }

  const taskCommand = useVbs ? `${WSCRIPT_EXE} //B //NoLogo "${launcherVbs}"` : `"${launcher}"`;
  runExe("schtasks.exe", ["/delete", "/tn", BLENDER_TASK_NAME, "/f"], 15_000); // 任务不存在会非零退出，忽略
  // 路径带空格靠内部引号（ComfyUI 那边实测：不加引号 → Last Result -2147024703）
  // 不加 /it：任务本身能跑（之前日志有内容），问题在电源策略，不在令牌。
  const cr = runExe("schtasks.exe", ["/create", "/tn", BLENDER_TASK_NAME, "/tr", taskCommand,
    "/sc", "once", "/st", "00:00", "/f"], 20_000);
  if (cr.code !== 0) {
    serviceProc.lastError = `计划任务创建失败：${cr.stderr || cr.error || `exit ${cr.code}`}`;
    saveServiceState();
    return { ok: false, error: serviceProc.lastError, launcher };
  }

  // ── 任务建完立刻修正电源策略 ─────────────────────────────────────────
  // schtasks 建的任务默认 DisallowStartIfOnBatteries=True。
  // 笔记本只要在用电池，任务就永远停在 Queued——每项单看都正常
  //（任务存在、已触发、LastResult=0），合起来是“从不执行”。
  // 这个坑真踩过：界面一直卡在 TCP，查半天才发现是电源策略。
  // 用 PowerShell 改（schtasks 没有对应开关），改不动也不阻断启动。
  try {
    const ps = runExe("powershell.exe", ["-NoProfile", "-Command",
      `$s=(Get-ScheduledTask -TaskName '${BLENDER_TASK_NAME}').Settings;` +
      `$s.DisallowStartIfOnBatteries=$false;$s.StopIfGoingOnBatteries=$false;` +
      `$s.ExecutionTimeLimit='PT0S';` +
      `Set-ScheduledTask -TaskName '${BLENDER_TASK_NAME}' -Settings $s | Out-Null`], 30_000);
    if (ps.code !== 0) log(`电源策略修正失败（不阻断）：${ps.stderr || ps.code}`);
    else log("已修正任务电源策略（允许电池供电下启动）");
  } catch (e) { log(`电源策略修正异常（不阻断）：${e?.message || e}`); }

  const rr = runExe("schtasks.exe", ["/run", "/tn", BLENDER_TASK_NAME], 20_000);
  if (rr.code !== 0) {
    serviceProc.lastError = `计划任务启动失败：${rr.stderr || rr.error || `exit ${rr.code}`}`;
    saveServiceState();
    return { ok: false, error: serviceProc.lastError, launcher };
  }

  serviceProc.startedAt = new Date().toISOString();
  serviceProc.blenderExe = t.exe;
  serviceProc.launcher = useVbs ? launcherVbs : launcher;
  serviceProc.logFile = logFile;
  serviceProc.lastError = null;
  saveServiceState();
  pidCache = { at: 0, pids: [] };
  log(`请求启动 Blender：${t.exe}（日志 ${logFile}，启动器 ${serviceProc.launcher}）`);

  // 兜底诊断：60s 后仍不可达就把成因指向可查的两处
  setTimeout(() => {
    if (socketReady) return;
    connect(3000).catch(() => {
      serviceProc.lastError = `Blender 启动 60 秒后 addon 仍不可达：查 ${logFile} 与计划任务 ${BLENDER_TASK_NAME} 的 Last Result；并确认 addon 已启用（自启动默认开）`;
      saveServiceState();
      log(serviceProc.lastError);
    });
  }, 60_000).unref?.();

  return {
    ok: true,
    accepted: true,
    blenderExe: t.exe,
    launcher: serviceProc.launcher,
    launcherCmd: launcher,
    hidden: useVbs,
    logFile,
    addon: `${ADDON_HOST}:${ADDON_PORT}`,
  };
}

async function stopBlenderService() {
  pidCache = { at: 0, pids: [] }; // 强制重查：不小心依赖「可达」判断
  const pids = listeningPids();
  const stopped = [];
  const failed = [];
  for (const pid of pids) {
    const r = runExe("taskkill.exe", ["/PID", String(pid), "/T", "/F"], 20_000);
    if (r.code === 0) stopped.push(pid);
    else failed.push({ pid, error: r.stderr || r.error || `exit ${r.code}` });
  }
  runExe("schtasks.exe", ["/delete", "/tn", BLENDER_TASK_NAME, "/f"], 15_000); // 顺手清启动器任务
  teardownSocket("服务已停止");
  await new Promise((r) => setTimeout(r, 800));
  pidCache = { at: 0, pids: [] };
  const alive = listeningPids();
  serviceProc.lastStop = { at: new Date().toISOString(), pids, stopped, alive };
  serviceProc.lastError = failed.length ? `部分进程未能终止：${JSON.stringify(failed)}` : null;
  saveServiceState();
  log(`停止 Blender 服务：pids=${JSON.stringify(pids)} stopped=${JSON.stringify(stopped)} 仍监听=${JSON.stringify(alive)}`);
  return { ok: alive.length === 0, pids, stopped, failed, alive, already: pids.length === 0 };
}

loadServiceState();

// 契约层/规划器/各子模块的统一调用（除 montage 的绕行分支外）
async function relayPlan(op, args) {
  const e = await getDshEngine();
  return e.plan(String(op || "status"), args || {});
}

// ── HTTP 控制面 ──────────────────────────────────────────────────────────────
function jsonReply(res, code, body) {
  const text = JSON.stringify(body);
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
  });
  res.end(text);
}

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolvePromise, rejectPromise) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        rejectPromise(new Error("请求体过大"));
        try { req.destroy(); } catch { /* 忽略 */ }
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolvePromise({});
      let val;
      try {
        val = JSON.parse(raw);
      } catch {
        return rejectPromise(new Error("请求体不是合法 JSON"));
      }
      // ── G4：body 必须是非数组 JSON 对象 ──────────────────────────
      // 为何还要这一条（上一条已经卡了 Content-Type）：
      //   上一道堵的是“发不出 application/json”的那类跨站请求；
      //   这一道堵的是“发得出、且长得像 JSON”却本质是数组/标量的输入
      //   ——数组与标量在下游代码里会走到完全不同的分支，那是输入校验的形状。
      if (val === null || typeof val !== "object" || Array.isArray(val)) {
        const e = new Error("请求体必须是 JSON 对象（非数组）");
        e.httpCode = 400;
        return rejectPromise(e);
      }
      resolvePromise(val);
    });
    req.on("error", (e) => rejectPromise(e));
  });
}

function authorized(req) {
  // G1：常量时间比较。
  //
  // 为何不能用 `===`：字符串比较是短路的，比较到第一个不同字符就返回，
  //   耗时随“猜中几个字符”变化——理论上可被本地进程逐字节试出来。
  //   密钥只有 64 个字符，代价不低，所以不在这种地方省。
  const got = String(req.headers["x-hanako-service-key"] || "");
  if (!got) return false;
  const a = Buffer.from(got, "utf8");
  const b = Buffer.from(CONTROL_KEY, "utf8");
  if (a.length !== b.length) return false;   // timingSafeEqual 要求等长，长度差本身不泄露内容
  try { return timingSafeEqual(a, b); } catch { return false; }
}

// ── 免鉴权的只读面 ────────────────────────────────────────────────────────
//
// 为何需要它：controlKey 每次启动随机生成，只经一个启动用的临时配置文件交给中继，
//   中继读完即删（见上面 CFG_PATH 处理）。于是外部工具（调试脚本、CI、修问题的终端）
//   **没有任何稳定方式接入**——实测：想直连查一个场景状态，只能从命令行里找到配置
//   路径，而文件已不存在。安全是对的，但不该把“读一下现状”也一起关死。
//
// 为何用白名单而不是“按 op 判读写”：
//   按 op 判需要先读 body，而 body 只能读一次——鉴权层读过了路由就读不到。
//   更根本的是：**白名单漏了只是少一个入口，黑名单漏了是开一个口子。**
//
// 为何这些路径能无条件信任：
//   它们都不接受“要做什么”这个参数，只接受“读哪个”。
//   对比：/rt/plan 也支持只读 op，但它同时支持会改场景的 op——
//   路径本身分不出读写，所以不放进免鉴权面。
// 白名单与「允许的方法」都在 runtime/relay-policy.mjs——单一事实源。
// 为什么它单独成文件：relay 是个一 import 就起服务的模块，测不了；
//   这张表因此长期没被任何测试照到，/preview 的 403 就是这么穿过去的。
// **改免鉴权面，改那个文件，别在这儿加分支。**

// ── G2 · Host / 浏览器指纹 ────────────────────────────────────────────────
//
// 实现在 runtime/relay-policy.mjs —— 与本文件同一个目录。
// 为何抽出去：relay 是个一 import 就起服务、还要读 argv 的模块，测不了；
//   而这一闸正是审查方第一条看的。抽出去就能对负向矩阵逐项断言。
// **改口径改那个文件，别在这儿加分支。**

const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, `http://${ADDON_HOST}:${PORT}`);
  } catch {
    return jsonReply(res, 400, { ok: false, error: "bad url" });
  }
  const path = url.pathname;

  // ── G2：所有路由之前 ────────────────────────────────────────────────
  // ！必须在 path === "/health" 之前——否则那一支会先 return 跑掉，
  //   而 /health 正是免鉴权面里最常被外部碰到的一条。
  const blockedBy = browserFingerprintBlock(req.headers, { host: ADDON_HOST, port: PORT });
  if (blockedBy) {
    log(`G2 拒绝：${req.method} ${path} — ${blockedBy}`);
    return jsonReply(res, 403, { ok: false, error: "forbidden" });
  }

  // ── G4：写路由的请求格式 ────────────────────────────────────────────
  // 为何卡 Content-Type：跨站的 no-cors 简单请求只能发 text/plain 这类
  //   「安全」类型，发不出 application/json。卡住它，就堵死了一整类
  //   “网页偷偷驱动本机服务”。
  // ！缺失也拒——「没说是什么类型」不等于「就是 json」。
  if (req.method === "POST") {
    const ctype = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
    if (ctype !== "application/json") {
      log(`G4 拒绝：${req.method} ${path} — content-type=${ctype || "（缺）"}`);
      return jsonReply(res, 415, {
        ok: false,
        error: "unsupported media type",
        hint: "写路由要求 content-type: application/json",
      });
    }
  }

  if (path === "/health") {
    return jsonReply(res, 200, {
      ok: true,
      service: "blender-relay",
      connected: socketReady,
      addon: `${ADDON_HOST}:${ADDON_PORT}`,
      workDir: WORK,
      metrics,
      lastError: lastError || null,
      // 公告“哪些路径不需要 key”。
      // 为何要明写在回执里：否则外部工具得靠猜——而猜错的代价是 403，
      //   它分不清“路径不对”和“没权限”。这两个是不同的事。
      publicRead: [...PUBLIC_READ_PATHS],
      authNote: "其余路径需要 X-Hanako-Service-Key 头；key 每次启动重新生成、经 argv 末位传给中继，**不落盘**（发布手册 §1.1 G1 口径，与 hanako-gallery / mail 同形）。",
    });
  }
  if (!isPublicRead(path, req.method) && !authorized(req)) {
    return jsonReply(res, 403, {
      ok: false,
      error: "unauthorized",
      hint: `这条路径需要 X-Hanako-Service-Key。免鉴权的只读路径：${[...PUBLIC_READ_PATHS].join(" / ")}`,
    });
  }

  try {
    if (path === "/doctor" && req.method === "POST") {
      return jsonReply(res, 200, await doctor());
    }
    if (path === "/see" && req.method === "POST") {
      return jsonReply(res, 200, await see(await readBody(req)));
    }
    // /preview：实时预览（免鉴权）。
    //
    // 为何单开一条而不是复用 /see：
    //   /see 接受 maxSize / file 等参数，而预览只需要一个快照。
    //   单开一条让调用方（卡片）不用猜参数。
    //
    // 为何放进免鉴权面：
    //   预览是纯读操作（截图），不放它就得把 key 给卡片，
    //   而 key 只活在宿主内存——卡片根本拿不到。
    if (path === "/preview" && req.method === "GET") {
      return jsonReply(res, 200, await see({ maxSize: 900, format: "png" }));
    }
    if (path === "/do" && req.method === "POST") {
      const body = await readBody(req);
      return jsonReply(res, 200, await doCode(body.code, body.timeoutMs));
    }
    if (path === "/scene" && req.method === "POST") {
      return jsonReply(res, 200, await sceneInfo());
    }
    if (path === "/object" && req.method === "POST") {
      const body = await readBody(req);
      return jsonReply(res, 200, await objectInfo(body.name));
    }
    // 3D 模型增删。写路由：过租约门禁（trash_list 是只读，已在名单里）。
    if (path === "/object/edit" && req.method === "POST") {
      const body = await readBody(req);
      const gate = gateFor("/object/edit", String(body.op || ""), body);
      if (gate) return jsonReply(res, 409, gate);
      return jsonReply(res, 200, await objectEdit(body));
    }
    if (path === "/raw" && req.method === "POST") {
      const body = await readBody(req);
      if (!body.type) return jsonReply(res, 400, { ok: false, error: "type 必填" });
      const r = await send(body.type, body.params || {}, Number(body.timeoutMs || DEFAULT_TIMEOUT_MS));
      return jsonReply(res, 200, { ok: true, result: r?.result ?? null, raw: r });
    }
    if (path === "/render/pass" && req.method === "POST") {
      return jsonReply(res, 200, await renderPass(await readBody(req)));
    }
    // ── dsh 迁移端点（v0.7.0）：接上游 engine ──────────────────────────
    if (path === "/rt/view" && req.method === "POST") {
      const body = await readBody(req);
      const e = await getDshEngine();
      const out = await e.view(body);
      // 【契约】engine.view 返回 {png, meta}：png 是 Buffer，meta 里有 path/width/height/mode
      const meta = (out && out.meta) ? out.meta : (out || {});
      if (body && body.asJson) return jsonReply(res, 200, { ok: true, meta });
      const png = out && out.png ? out.png : null;
      if (!png) return jsonReply(res, 200, { ok: false, error: "view 未产出图像", meta });
      res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" });
      res.end(png);
      return;
    }
    if (path === "/rt/act" && req.method === "POST") {
      const body = await readBody(req);
      // 写路由：过租约门禁（别人持有时 409）。上游把 /act 列为写路由。
      const gate = leaseGate(body);
      if (gate) return jsonReply(res, 409, gate);
      const e = await getDshEngine();
      const out = await e.act(String(body.code || ""), Number(body.timeoutMs || 120_000), body.file || null);
      return jsonReply(res, 200, { ok: true, result: out });
    }
    if (path === "/rt/preset" && req.method === "POST") {
      const body = await readBody(req);
      const e = await getDshEngine();
      // 【契约】/preset 是独立端点（跟 perf 一样）：op=save/list/get/delete/apply/export/import/help
      const op = String(body.op || "list");
      const gate = gateFor("/rt/preset", op, body);
      if (gate) return jsonReply(res, 409, gate);
      const r = await e.preset(op, body.args || {});
      return jsonReply(res, 200, { ok: true, result: r });
    }
    if (path === "/rt/perf" && req.method === "POST") {
      const body = await readBody(req);
      const op = String(body.op || "status");
      const gate = gateFor("/rt/perf", op, body);
      if (gate) return jsonReply(res, 409, gate);
      const e = await getDshEngine();
      // 【契约】perfCall 把 op 当 K.dsh_perf_api 的**函数名**直接调。
      //   实测 key 为：status / help / analyze / apply / revert（**不带前缀**）
      //              + opt_analyze / opt_join（对象精简那套带前缀）
      // 【坑】perf 的 status/help 是**零参函数**：传任何参数都会 TypeError。
      //   perfCall 内部：payload 为 undefined 时不拼参数。所以这里必须传 undefined 而不是 {}。
      const hasArgs = body.args != null && typeof body.args === "object" && Object.keys(body.args).length > 0;
      const r = await e.perf(op, hasArgs ? body.args : undefined);
      return jsonReply(res, 200, { ok: true, result: r });
    }
    if (path === "/rt/opt" && req.method === "POST") {
      const body = await readBody(req);
      const op = String(body.op || "opt_analyze");
      const gate = gateFor("/rt/opt", op, body);
      if (gate) return jsonReply(res, 409, gate);
      const e = await getDshEngine();
      const r = await e.opt(op, body.args || {});
      return jsonReply(res, 200, { ok: true, result: r });
    }
    if (path === "/rt/plan" && req.method === "POST") {
      const body = await readBody(req);
      const op = String(body.op || "status");
      const args = body.args || {};
      const gate = gateFor("/rt/plan", op, body);
      if (gate) return jsonReply(res, 409, gate);
      // 【绕行上游 bug】montage 分支在上游 engine 里用字符串拼接回包：
      //   'print("LOOP " + K.dsh_montage_api["montage"](...))'
      //   而 montage() 返回的是 **dict** → TypeError: can only concatenate str (not "dict") to str
      //   实测（2026-10-13）：直调 python 完全正常（45747 bytes 拼图），只是上游路由层写错了。
      //   这里走 /rt/act 直调，不改上游源码（保留将来同步的可能）。
      if (op.indexOf("montage") === 0) {
        const e = await getDshEngine();
        const code = [
          "import json as _json, sys as _sys",
          "_K = _sys.modules.get('dsh_rt_kernel')",
          "_A = _K.dsh_montage_api",
          "print('MONTAGE_OUT ' + _json.dumps(_A['montage'](**_json.loads(" + JSON.stringify(JSON.stringify(args)) + "))))",
        ].join("\n");
        const raw = await e.act(code, 300_000);
        const txt = String(raw?.stdout || "");
        const m = txt.match(/MONTAGE_OUT ([\s\S]*)/);
        if (!m) {
          return jsonReply(res, 200, { ok: false, error: "montage 无回包: " + txt.slice(0, 300), raw });
        }
        return jsonReply(res, 200, { ok: true, result: JSON.parse(m[1]) });
      }
      const r = await relayPlan(op, args);
      return jsonReply(res, 200, { ok: true, result: r });
    }
    if (path === "/rt/txn" && req.method === "POST") {
      const body = await readBody(req);
      const op = String(body.op || "list");
      const gate = gateFor("/rt/txn", op, body);
      if (gate) return jsonReply(res, 409, gate);
      const e = await getDshEngine();
      const r = await e.txn(op, body.args || {});
      return jsonReply(res, 200, { ok: true, result: r });
    }
    if (path === "/rt/loop" && req.method === "POST") {
      const body = await readBody(req);
      const op = String(body.op || "status");
      const gate = gateFor("/rt/loop", op, body);
      if (gate) return jsonReply(res, 409, gate);
      const e = await getDshEngine();
      let out;
      if (op === "start") out = await e.loopStart(body.spec || {});
      else if (op === "stop") out = await e.loopStop();
      else if (op === "board") out = await e.loopBoard(Number(body.limit || 10), body.groups !== false);
      else if (op === "export") out = await e.loopExport({ path: body.path, top: body.top, includeVariants: body.includeVariants });
      else if (op === "bench") out = await e.loopBench(Number(body.iterations || 2000));
      else if (op === "help") out = await e.loopHelp();
      else out = await e.loopStatus(Number(body.history || 8), Number(body.board || 0));
      return jsonReply(res, 200, { ok: true, result: out });
    }
    if (path === "/rt/headless" && req.method === "POST") {
      const body = await readBody(req);
      const gate = leaseGate(body);
      if (gate) return jsonReply(res, 409, gate);
      const e = await getDshEngine();
      const r = await e.headless(body || {});
      return jsonReply(res, 200, { ok: true, result: r });
    }
    // ── 租约：多会话写锁（对齐上游 /who /lease /release）──────────────
    if (path === "/rt/who" && req.method === "POST") {
      // 看当前持有者与剩余时间：多会话共存时先看它
      let metrics = null;
      try { metrics = (await getDshEngine()).metrics(); } catch { /* 连不上也照报租约 */ }
      return jsonReply(res, 200, { ok: true, lease: leaseView(), metrics });
    }
    if (path === "/rt/lease" && req.method === "POST") {
      const body = await readBody(req);
      const holder = String(body.holder || "anonymous");
      // renewOnly = 心跳：只在本来就持有租约时才续期，空闲时不抢占（防多会话互相锁死）
      if (body.renewOnly) {
        const v = leaseView();
        if (v.active && v.holder === holder) {
          const rr = leaseAcquire(holder, body.ttlMs, false);
          return jsonReply(res, 200, { ok: true, lease: rr.lease, renewed: true });
        }
        return jsonReply(res, 200, { ok: true, lease: v, renewed: false });
      }
      const r = leaseAcquire(holder, body.ttlMs, !!body.force);
      if (r.denied) {
        return jsonReply(res, 409, {
          ok: false, error: "leased", holder: r.holder, expiresInMs: r.expiresInMs,
          hint: `另一个会话持有写权限租约；force:true 可抢占，或等 ${Math.round(r.expiresInMs / 1000)}s 后重试`,
        });
      }
      return jsonReply(res, 200, { ok: true, lease: r.lease, renewed: false });
    }
    if (path === "/rt/release" && req.method === "POST") {
      const body = await readBody(req);
      const want = String(body.holder || "");
      let released = null;
      if (LEASE.holder && (!want || LEASE.holder === want)) {
        released = LEASE.holder;
        LEASE.holder = null; LEASE.token = null; LEASE.expiresAt = null; LEASE.acquiredAt = null;
      }
      return jsonReply(res, 200, { ok: true, released, lease: leaseView() });
    }
    // ── 热会话（worker）：无头 Blender 常驻进程──────────────────────
    // 为什么值钱：上游实测 EEVEE 首帧冷启 ~16s，热会话之后每帧 ~1.35s。
    // 之前 worker.py 搬进来了却从没被调过——零件在，传动轴没接。
    if (path === "/rt/worker" && req.method === "POST") {
      const body = await readBody(req);
      const op = String(body.op || "status");
      const gate = gateFor("/rt/worker", op, body);
      if (gate) return jsonReply(res, 409, gate);
      try {
        const e = await getDshEngine();
        if (op === "start") return jsonReply(res, 200, { ok: true, op, result: await e.worker.start(body) });
        if (op === "stop") return jsonReply(res, 200, { ok: true, op, result: await e.worker.stop() });
        if (op === "restart") {
          await e.worker.stop();
          return jsonReply(res, 200, { ok: true, op, result: await e.worker.start(body) });
        }
        if (op === "exec") {
          const purge = body.purgePrefix
            ? String(body.purgePrefix).split(",").map((x) => x.trim()).filter(Boolean)
            : null;
          const r = await e.worker.exec(String(body.code || ""), Number(body.timeoutMs) || 120_000, purge);
          return jsonReply(res, 200, {
            ok: !!(r && r.ok), op, result: r,
            error: (r && r.error) ? String(r.error) : null,
            traceback: (r && r.traceback) ? String(r.traceback) : null,
          });
        }
        return jsonReply(res, 200, { ok: true, op: "status", result: await e.worker.status() });
      } catch (e2) {
        return jsonReply(res, 200, { ok: false, op, error: String(e2?.message || e2) });
      }
    }
    // ── 作业层（job）：长活后台化（渲染一整晚）──────────────────────
    if (path === "/rt/job" && req.method === "POST") {
      const body = await readBody(req);
      const op = String(body.op || "list");
      const gate = gateFor("/rt/job", op, body);
      if (gate) return jsonReply(res, 409, gate);
      try {
        const e = await getDshEngine();
        if (op === "start") return jsonReply(res, 200, { ok: true, op, job: e.job.start(body) });
        if (op === "kill") return jsonReply(res, 200, { ok: true, op, job: e.job.kill(body.id) });
        if (op === "collect") return jsonReply(res, 200, { ok: true, op, job: e.job.collect(body.id, Number(body.tail) || 4000) });
        if (op === "status") return jsonReply(res, 200, { ok: true, op, job: e.job.status(body.id) });
        return jsonReply(res, 200, { ok: true, op: "list", jobs: e.job.list() });
      } catch (e2) {
        return jsonReply(res, 200, { ok: false, op, error: String(e2?.message || e2) });
      }
    }
    if (path === "/rt/commands" && req.method === "POST") {
      const e = await getDshEngine();
      const c = await e.commands();
      return jsonReply(res, 200, { ok: true, result: c });
    }
    if (path === "/rt/capabilities" && req.method === "POST") {
      let info = { ok: false };
      try {
        const e = await getDshEngine();
        info = { ok: true, metrics: e.metrics(), protocol: await e.protocol() };
      } catch (err) {
        info = { ok: false, error: String(err?.message || err) };
      }
      return jsonReply(res, 200, info);
    }
    if (path === "/deliver" && req.method === "POST") {
      // 把产物拷到指定目录（如 ComfyUI input）——目录必须已存在
      const body = await readBody(req);
      const src = String(body.src || "");
      const destDir = String(body.destDir || "");
      if (!src || !destDir) return jsonReply(res, 200, { ok: false, error: "src 与 destDir 必填" });

      // ── G5 · 参数绑定（发布审查五道闸之五）──────────────────────────
      //
      // ① src 必须落在允许的根内。
      //    它总是 work / runs / 数据目录下的东西，不需要是任意位置。
      const roots = [WORK, dirname(WORK), LOG_FILE ? dirname(LOG_FILE) : ""].filter(Boolean);
      if (!firstRootContaining(roots, src)) {
        log(`G5 拒绝：/deliver 的 src 在根外 — ${src}`);
        return jsonReply(res, 400, {
          ok: false, error: "src 在允许的根之外",
          hint: `只接受：${roots.join(" / ")}`,
        });
      }

      // ② names 必须是**裸文件名**。
      //    ！这是真正的洞：`join(destDir, n)` 不挡 `..`，
      //     而 destDir 是**用户配置的出口**（ComfyUI input 之类）——
      //     按设计不能把它锁在某个根内；能锁的是**名字**。
      //     要子目录就分两次调用，代价为零。
      try {
        if (!existsSync(destDir)) return jsonReply(res, 200, { ok: false, error: `目标目录不存在：${destDir}` });
        const { copyFileSync, readdirSync: rd } = await import("node:fs");
        const rawNames = Array.isArray(body.files) && body.files.length ? body.files : rd(src);
        const names = [];
        const rejected = [];
        for (const n of rawNames) {
          if (safeRelativeName(n)) names.push(String(n)); else rejected.push(String(n));
        }
        if (rejected.length) {
          log(`G5 拒绝：/deliver 的 files 含非裸文件名 — ${rejected.join(", ")}`);
          return jsonReply(res, 400, {
            ok: false,
            error: "files 里含非裸文件名（不接受路径分隔符、. 或 ..）",
            rejected,
          });
        }
        const copied = [];
        for (const n of names) {
          const s = join(src, n);
          if (!existsSync(s)) continue;
          const d = join(destDir, n);
          copyFileSync(s, d);
          copied.push({ name: n, dest: d, bytes: statSync(d).size });
        }
        return jsonReply(res, 200, { ok: copied.length > 0, copied, destDir });
      } catch (e) {
        return jsonReply(res, 200, { ok: false, error: String(e?.message || e) });
      }
    }
    if (path === "/render/start" && req.method === "POST") {
      return jsonReply(res, 200, await renderStart(await readBody(req)));
    }
    if (path === "/render/status" && req.method === "POST") {
      const body = await readBody(req);
      return jsonReply(res, 200, renderStatus(String((body && body.jobId) || "")));
    }
    if (path === "/service/status" && req.method === "POST") {
      return jsonReply(res, 200, { ok: true, ...serviceStatusPayload() });
    }
    if (path === "/service/start" && req.method === "POST") {
      const body = await readBody(req);
      return jsonReply(res, 200, await startBlenderService(body && body.path));
    }
    if (path === "/service/stop" && req.method === "POST") {
      return jsonReply(res, 200, await stopBlenderService());
    }
    if (path === "/disconnect" && req.method === "POST") {
      teardownSocket("");
      lastError = "";
      return jsonReply(res, 200, { ok: true });
    }
    // ── G3：路径认得、方法不对 → 405（而不是 404）─────────────────────
    if (WRITE_PATHS.has(path)) {
      return jsonReply(res, 405, { ok: false, error: "method not allowed", hint: "该路径只接受 POST" });
    }
    if (path === "/preview") {
      return jsonReply(res, 405, { ok: false, error: "method not allowed", hint: "该路径只接受 GET" });
    }
    return jsonReply(res, 404, { ok: false, error: "not found" });
  } catch (e) {
    metrics.errors += 1;
    // G4：readBody 抛的格式错带 httpCode（400），按它回；
    //   其余保持原约定（200 + ok:false）——改它会动到调用方的判断，不在这一闸的范围。
    const code = Number(e?.httpCode) || 200;
    return jsonReply(res, code, { ok: false, error: String(e?.message || e), code: e?.code || null });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  // readyMarker 必须是 stdout 上完整的一行：宿主靠它判定服务就绪
  console.log(READY_MARKER);
  log(`控制面已监听 127.0.0.1:${PORT} | addon=${ADDON_HOST}:${ADDON_PORT} | workDir=${WORK || "(临时)"}`);
});

// 常驻探活：保持连接状态可观测；失败不退出，等下一次调用重连
const keepAlive = setInterval(() => {
  if (!socketReady) {
    connect(4000).catch(() => { /* 静默重试 */ });
  }
}, 15_000);
keepAlive.unref?.();

function shutdown(signal) {
  log(`收到 ${signal}，正在退出`);
  teardownSocket("");
  try { server.close(); } catch { /* 忽略 */ }
  process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("uncaughtException", (e) => {
  log(`未捕获异常：${e?.stack || e}`);
});
process.on("unhandledRejection", (e) => {
  log(`未处理的 promise 拒绝：${e?.stack || e}`);
});
