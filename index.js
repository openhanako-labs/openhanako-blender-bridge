// index.js — Blender 助手 · Hana v2 App 入口
// ─────────────────────────────────────────────────────────────────────────────
// 做什么：把本机 Blender 接进 Hana。模型可以直接看视口、跑 bpy 代码、
//         读场景结构、按角度出图 —— 不需要点鼠标、不需要截图进提示词。
//
// 架构（与 comfyui-hana 同款「受管中继」范式）：
//   1. App 主进程（AppHost，无 raw socket 权限）
//        └─ 只负责：拉起受管 Node runtime、注册工具、暴露管理路由
//   2. 受管 runtime（runtime/blender-relay.mjs，local-machine profile）
//        └─ 真正连 Blender：TCP 127.0.0.1:9876 的 addon 线协议
//   3. Blender 侧 addon（ahujasid/mcp-for-blender 或兼容实现）
//
// 为什么绕这一层：AppHost 默认拒绝 raw addon / 子进程 / 网络。relay 是受管
// runtime，宿主逐次授予权限，App 主进程永远拿不到 socket 句柄。
// ─────────────────────────────────────────────────────────────────────────────

import { defineApp } from "./sdk/app-contract/server-client.js";
import { randomBytes, randomInt } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createRunStore, TAG_BASELINE, TAG_DELIVERED, DEFAULT_KEEP } from "./lib/archive.mjs";
// 接口契约的唯一事实来源。见 schema.js 头部：为什么它必须在这个闭包之外。
import * as SCHEMA from "./schema.js";

const APP_ID = "blender-bridge";

// ！版本号只应该有一个来源：manifest.json。
//
//   曾经这里手写 const APP_VERSION = "1.33.0"，而 manifest 已经到 1.36.2——
//   于是日志、/health、中继配置里写的全是错的版本号，而且没人会发现，
//   因为“版本号跟实际内容对不上”不会报错，只会让以后排查时少一个可靠锚点。
//
//   现在从 manifest 读。读不到就退到一个明确写错的占位值，
//   而不是默默沿用旧值——宁可难看，不可骗人。
let APP_VERSION = "0.0.0-manifest-unreadable";
try {
  // Node 20.11+ 有 import.meta.dirname；本项目是 Node 24，直接用它比手拼路径可靠。
  const here = import.meta.dirname || ".";
  const _mf = JSON.parse(readFileSync(join(here, "manifest.json"), "utf8"));
  if (_mf && _mf.version) APP_VERSION = String(_mf.version);
} catch { /* 保留占位值，让异常显眼 */ }

const RELAY_ENTRY = "runtime/blender-relay.mjs";

const DEFAULT_ADDON_HOST = "127.0.0.1";
const DEFAULT_ADDON_PORT = 9876;
const READY_MAX_MS = 120_000;
const READY_POLL_MS = 300;
const RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000, 120_000];

const USER_TEXT = Object.freeze({
  "port-busy": "中继端口被占用（已自动换端口重试，仍失败请检查本机回环端口占用与安全软件拦截）。",
  "not-authorized": "宿主未授权本 App 启动受管 runtime（app/runtime.local-machine 能力未授予或已撤销）。检查 App 能力与授权状态。",
  timeout: "中继在 120s 内未完成就绪（查看 runtime 日志与状态）。",
  internal: "中继进程异常退出（见 runtime 日志）。",
  unknown: "中继启动失败（见 runtime 日志与状态）。",
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 读本地图并转成内联 image 内容（小图直接回 base64；过大则不内联，让调用方看路径）
const INLINE_IMAGE_MAX_BYTES = 8 * 1024 * 1024; // 8MB，与中继侧上限一致
function readImageAsDataUrl(filepath) {
  try {
    if (!filepath || !existsSync(filepath)) return null;
    const buf = readFileSync(filepath);
    if (!buf.length) return null;
    if (buf.length > INLINE_IMAGE_MAX_BYTES) return { bytes: buf.length, base64: null, tooBig: true, mimeType: "image/png" };
    // PNG/JPG 魔数判断（不信任扩展名）
    let mime = "image/png";
    if (buf[0] === 0xff && buf[1] === 0xd8) mime = "image/jpeg";
    else if (buf[0] !== 0x89 || buf.toString("latin1", 1, 4) !== "PNG") return null;
    return { bytes: buf.length, base64: buf.toString("base64"), mimeType: mime };
  } catch {
    return null;
  }
}

export const name = APP_ID;

export default defineApp(async (sdk) => {
  const fire = (p) => { try { if (p && typeof p.catch === "function") p.catch(() => {}); } catch { /* 忽略 */ } };
  const log = (m) => fire(sdk.logger?.info?.(`[${APP_ID}] ${m}`));
  const warn = (m) => fire(sdk.logger?.warn?.(`[${APP_ID}] ${m}`));
  const error = (m) => fire(sdk.logger?.error?.(`[${APP_ID}] ${m}`));
  const msgOf = (e) => (e && e.message ? String(e.message) : String(e));

  const dataDir = sdk.dataDir;
  if (typeof dataDir !== "string" || !dataDir) {
    throw new Error("blender-bridge apply: ctx.dataDir 缺失（宿主未提供 App 数据目录）");
  }
  log(`apply entered | dataDir=${dataDir} | version=${APP_VERSION}`);

  // ── 运行时状态 ─────────────────────────────────────────────────────────────
  const state = {
    phase: "idle", // idle | starting | ready | error | stopped
    runtimeId: null,
    servicePort: null,
    controlKey: null,
    lastInfo: null,
    lastError: null,
    attempt: 0,
    config: {
      addonHost: DEFAULT_ADDON_HOST,
      addonPort: DEFAULT_ADDON_PORT,
      workDir: join(dataDir, "work"),
      deliverTarget: "",
      blenderPath: "",
      // 派活指向：给谁、用哪个模型。空 = 不干预，用那个助手本来的模型。
      // provider 与 model 成对，两个一起才构成一个可寻地址。
      dispatchAgentId: "",
      dispatchModel: "",
      dispatchProvider: "",
    },
    health: null,
    lastDoctor: null,
    bootTimer: null,
    healthTimer: null,
    starting: null,
  };

  try { mkdirSync(state.config.workDir, { recursive: true }); } catch { /* 忽略 */ }

  // ── 配置落盘 ───────────────────────────────────────────────────────────────
  // 原来是内存态，重启就回默认值——用户改过的端口会悄无声息地被忘掉。
  // 放在 app-data 下，与产出分开。
  const CONFIG_PATH = join(dataDir, "config.json");
  function loadConfig() {
    try {
      const j = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
      if (j && typeof j === "object") {
        if (typeof j.addonHost === "string" && j.addonHost) state.config.addonHost = j.addonHost;
        if (Number.isInteger(j.addonPort) && j.addonPort > 0 && j.addonPort < 65536) state.config.addonPort = j.addonPort;
        if (typeof j.workDir === "string" && j.workDir) state.config.workDir = j.workDir;
        // 投递目标默认空——没配就不投，不猜用户的目录
        if (typeof j.deliverTarget === "string") state.config.deliverTarget = j.deliverTarget;
        if (typeof j.blenderPath === "string") state.config.blenderPath = j.blenderPath;
        // 派活时想指定谁来干 / 用哪个模型。空 = 不干预，落到当前会话。
        if (typeof j.dispatchAgentId === "string") state.config.dispatchAgentId = j.dispatchAgentId;
        if (typeof j.dispatchModel === "string") state.config.dispatchModel = j.dispatchModel;
        // ！这行漏过：模型存了、provider 没读。
        //   重启后 dispatchModel 有值、dispatchProvider 是空的，
        //   而派活时 provider 是 session:switch-model 的必填字段——
        //   于是“换模型”永远报“没拿到 provider”，而且每次重启又犯一次。
        //   存了两个就得读两个，否则一半的配置是摆设。
        if (typeof j.dispatchProvider === "string") state.config.dispatchProvider = j.dispatchProvider;
      }
      log(`配置已加载：${CONFIG_PATH}`);
    } catch (e) {
      if (e?.code !== "ENOENT") warn(`配置读取失败（用默认值）：${msgOf(e)}`);
    }
  }
  function saveConfig() {
    try {
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(CONFIG_PATH, JSON.stringify({
        addonHost: state.config.addonHost,
        addonPort: state.config.addonPort,
        workDir: state.config.workDir,
        deliverTarget: state.config.deliverTarget || "",
        blenderPath: state.config.blenderPath || "",
        dispatchAgentId: state.config.dispatchAgentId || "",
        dispatchModel: state.config.dispatchModel || "",
        dispatchProvider: state.config.dispatchProvider || "",
      }, null, 2));
      return true;
    } catch (e) { warn(`配置保存失败：${msgOf(e)}`); return false; }
  }
  loadConfig();
  // workDir 可能被配置改过，重新确保存在
  try { mkdirSync(state.config.workDir, { recursive: true }); } catch { /* 忽略 */ }

  // ── 归档器 ─────────────────────────────────────────────────────────────────
  // 放在 app-data 而非 workDir：归档是户口，不应该跟临时产物混在一个篮子里。
  state.runs = createRunStore({
    root: join(dataDir, "runs"),
    log: (m) => log(m),
    warn: (m) => warn(m),
  });

  function withCode(message, code) {
    const e = new Error(message);
    e.code = code;
    return e;
  }

  // ── 私有运行时配置（0600，启动即删）────────────────────────────────────────
  function writeRuntimeConfig(port, readyMarker, controlKey) {
    const dir = join(dataDir, "integration");
    mkdirSync(dir, { recursive: true });
    const configPath = join(dir, `relay-${randomBytes(6).toString("hex")}.json`);
    const config = {
      mode: "managed",
      port,
      readyMarker,
      controlKey,
      addonHost: state.config.addonHost,
      addonPort: state.config.addonPort,
      workDir: state.config.workDir,
      timeoutMs: 60_000,
      logFile: join(dataDir, "logs", "relay.log"),
      note: `blender-bridge relay v${APP_VERSION} @ ${new Date().toISOString()}`,
    };
    writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
    try { chmodSync(configPath, 0o600); } catch { /* Windows 上多为 no-op */ }
    return configPath;
  }

  // ── 回收遗留 runtime ───────────────────────────────────────────────────────
  async function stopStaleRuntimes() {
    try {
      if (typeof sdk.runtime?.list !== "function") return;
      const list = await sdk.runtime.list();
      for (const rt of list || []) {
        if (!rt) continue;
        const active = rt.state === "starting" || rt.state === "ready";
        if (active && rt.runtimeId !== state.runtimeId) {
          try {
            await sdk.runtime.stop(rt.runtimeId);
            log(`已回收遗留 runtime ${rt.runtimeId}`);
          } catch (e) {
            warn(`回收遗留实例失败 ${rt.runtimeId}：${msgOf(e)}`);
          }
        }
      }
    } catch (e) {
      warn(`runtime.list 失败（忽略，继续启动）：${msgOf(e)}`);
    }
  }

  // ── 单次启动尝试 ──────────────────────────────────────────────────────────
  async function startOnce(attempt) {
    if (!sdk.runtime || typeof sdk.runtime.start !== "function") {
      throw withCode("宿主 ctx.runtime 不可用（app/runtime.execute 能力未授予或宿主过旧）", "unknown");
    }
    const port = randomInt(38000, 52001);
    const readyMarker = "BLENDER_RELAY_READY:" + randomBytes(18).toString("base64url");
    const controlKey = randomBytes(24).toString("base64url");
    const configPath = writeRuntimeConfig(port, readyMarker, controlKey);

    log(`启动中继受管 runtime（attempt ${attempt}/3，端口 ${port}，addon ${state.config.addonHost}:${state.config.addonPort}）`);
    let rt = null;
    try {
      rt = await sdk.runtime.start({
        runtime: "node",
        entry: RELAY_ENTRY,
        profile: "local-machine",
        network: "external",
        cwd: dataDir,
        args: [configPath],
        service: { port, readyMarker },
      });
    } catch (e) {
      try { rmSync(configPath, { force: true }); } catch { /* 忽略 */ }
      const raw = msgOf(e);
      warn(`ctx.runtime.start 被宿主拒绝：${raw}`);
      const code = /not authorized|authoriz|DENIED|declined/i.test(raw) ? "not-authorized" : "unknown";
      throw withCode(`${USER_TEXT[code]}（宿主：${raw}）`, code);
    }
    const cleanup = setTimeout(() => { try { rmSync(configPath, { force: true }); } catch { /* 忽略 */ } }, 10_000);
    cleanup.unref?.();

    const runtimeId = rt && rt.runtimeId;
    if (!runtimeId) throw withCode(`ctx.runtime.start 未返回 runtimeId：${JSON.stringify(rt || null)}`, "unknown");
    state.runtimeId = runtimeId;
    state.servicePort = typeof rt?.service?.port === "number" ? rt.service.port : port;
    state.controlKey = controlKey;
    state.lastInfo = rt;
    log(`runtimeId=${runtimeId} state=${rt.state || "starting"} servicePort=${state.servicePort}`);

    const deadline = Date.now() + READY_MAX_MS;
    for (;;) {
      let info = null;
      try {
        info = await sdk.runtime.get(runtimeId);
      } catch (e) {
        warn(`runtime.get 失败：${msgOf(e)}`);
      }
      if (info) {
        state.lastInfo = info;
        const st = info.state;
        const svc = info.service && info.service.state;
        if (st === "ready" && (!info.service || svc === "ready")) {
          state.phase = "ready";
          state.lastError = null;
          log(`中继就绪（runtimeId=${runtimeId}，端口 ${state.servicePort}）`);
          return info;
        }
        if (st === "failed" || st === "exited" || st === "stopped") {
          const code = st === "failed" ? "internal" : "internal";
          throw withCode(`${USER_TEXT[code]}（state=${st}, exitCode=${info.exitCode ?? "?"}）`, code);
        }
      }
      if (Date.now() > deadline) {
        throw withCode(USER_TEXT.timeout, "timeout");
      }
      await sleep(READY_POLL_MS);
    }
  }

  // ── 启动（单飞行，退避自愈）───────────────────────────────────────────────
  async function ensureStarted({ force = false } = {}) {
    if (state.phase === "ready" && state.runtimeId && !force) return state;
    if (state.starting) return state.starting;

    state.starting = (async () => {
      state.phase = "starting";
      state.lastError = null;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        state.attempt = attempt;
        try {
          await stopStaleRuntimes();
          await startOnce(attempt);
          return state;
        } catch (e) {
          const code = e.code || "unknown";
          state.lastError = { code, message: msgOf(e), userText: USER_TEXT[code] || USER_TEXT.unknown };
          error(`启动失败（attempt ${attempt}/3，${code}）：${msgOf(e)}`);
          if (attempt >= 3) {
            state.phase = "error";
            break;
          }
          const waitMs = RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)];
          log(`${waitMs}ms 后重试`);
          await sleep(waitMs);
        }
      }
      return state;
    })();

    try {
      return await state.starting;
    } finally {
      state.starting = null;
    }
  }

  // ── 调中继 ────────────────────────────────────────────────────────────────
  //
  // ！timeoutMs 上限是 30s，而且不是我们定的——是宿主 sdk.runtime.fetch 的
  //   契约写死的（HanaPluginRuntimeFetchInitV2："Integer milliseconds from 1
  //   through 30000; defaults to 30000"）。传更大的值会被默默砍回 30s。
  //
  //   这意味着一条硬约束：**任何超过 30s 的中继调用都不能靠同步等**。
  //   要么把它做得够快（实测：四张 Workbench 视图 3.6s），
  //   要么走“提交即返回 + 轮询”（render 动作就是这么做的，见 watchRenderJob）。
  //
  //   之前这里传 660_000 是在说假话：调用方以为能等 11 分钟，
  //   实际 30s 就断，而且报回来的错（callback.tools.execute timed out）
  //   跟真因（渲染没跑完）毫无关系。
  // ── 服务端日志（落盘）─────────────────────────────────────────────────────
  //
  // 为何要这一层：之前日志只存在于浏览器内存里（workbench.js 的 logs 数组）。
  //   两个后果：
  //     ① 刷新页面就没了——而“事后能查”才是日志的全部价值；
  //     ② **工具面调的请求一条也不在里面**。我（模型）调 runs op=views
  //        出了错，日志页上是空的，而真正出错的那次调用根本没被记。
  //        今天排查“拍视图拍出错的东西”时，就是因为这个才只能去翻宿主大日志。
  //
  // 挂在 relayFetch 上：它是所有中继调用的唯一收束点。
  //   写在调用点就要每处都记得写，而“哪处忘了写”是查不出来的——
  //   这与 UI 侧 api() 兼管日志是同一条道理。
  const LOG_MAX_BYTES = 2 * 1024 * 1024;   // 2MB 滚动上限（按字节裁，见 appLog）

  function logFilePath() {
    return join(dataDir, "logs", "app.log");
  }

  // 记一条。不抛异常：日志写不进去不能把业务带倒。
  function appLog(entry) {
    try {
      const dir = join(dataDir, "logs");
      mkdirSync(dir, { recursive: true });
      const f = logFilePath();
      // 超限就裁。
      //
      // ！按**字节**裁，不按行数。
      //   曾经写的是“保留最后 2000 行”—— 而每行的长度是不定的：
      //   一条 relay 记录带 brief/error 可以上千字符。实测（灌 4000 字符/行）：
      //   按 2000 行裁完还有 2244KB，**仍然超过 2MB 上限**。
      //   也就是说那个上限形同虚设，日志会一直涨下去。
      //   上限是按字节定的，裁剪就得按字节算。
      try {
        if (existsSync(f) && statSync(f).size > LOG_MAX_BYTES) {
          const lines = readFileSync(f, "utf8").split("\n");
          // 从后往前累加，累到上限的一半就停（留一半余量，不要一裁又满）。
          const keep = [];
          let bytes = 0;
          const budget = Math.floor(LOG_MAX_BYTES / 2);
          for (let i = lines.length - 1; i >= 0; i--) {
            const l = lines[i];
            const n = Buffer.byteLength(l, "utf8") + 1;
            if (bytes + n > budget && keep.length) break;
            keep.push(l);
            bytes += n;
          }
          keep.reverse();
          writeFileSync(f, keep.join("\n"), "utf8");
        }
      } catch { /* 裁剪失败不影响追加 */ }
      const ts = new Date().toISOString();
      const line = `[${ts}] ${JSON.stringify(entry)}`;
      appendFileSync(f, line + "\n", "utf8");
    } catch { /* 忽略 */ }
  }

  // 读最近 N 条（日志页用）。倒着读，不把整个文件读进来。
  function readAppLog(limit = 300) {
    try {
      const f = logFilePath();
      if (!existsSync(f)) return [];
      const lines = readFileSync(f, "utf8").split("\n").filter((l) => l.trim());
      return lines.slice(-Math.max(1, Math.min(2000, limit)));
    } catch { return []; }
  }

  async function relayFetch(path, body, timeoutMs = 60_000) {
    if (state.phase !== "ready" || !state.runtimeId) {
      await ensureStarted();
    }
    if (state.phase !== "ready" || !state.runtimeId) {
      throw withCode(state.lastError?.userText || "中继未就绪", state.lastError?.code || "unknown");
    }
    // ── 记四件：去哪、带了什么、回来什么、花了多久 ──
    // 带的是**摘要**不是全文：完整 body 里可能有几万字的生成器源码，
    // 记下来日志就没法看了。摘要够回答“这次调用是干什么的”。
    const t0 = Date.now();

    // ！探活/轮询不进日志。
    //
    //   实测（两小时）：4499 行里 4017 行是噪声——
    //     /health 2579、/doctor 1438、/raw 479（每 12 秒一次的集成状态轮询）
    //   而真正的业务调用只有 7 条（4 次 /rt/headless + 3 次 /rt/plan）。
    //   日志被心跳淹没，等于“能查到”这件事又被埋了——只是换了个方式。
    //   而日志的全部价值就是“出了事能一眼看到那几条相关的”。
    //
    //   判据不能只看路径：/raw 既是轮询也是用户动作。
    //   所以看**具体是什么请求**：
    //     · 已知探活路径 /health、/doctor
    //     · /raw 且 type 是 get_<x>_status（集成开关轮询）
    //     · /raw 且 type 是 list_scene_items（场景树轮询，12 秒一次）
    //
    //   ！list_scene_items 是实测补的：第一版只认了 get_*_status，
    //     而真正在每 12 秒刷屏的是场景树（loadScene → /blender-bridge/scene
    //     → /raw list_scene_items）。漏一个就白过滤一半。
    const NOISY_PATHS = new Set(["/health", "/doctor"]);
    const NOISY_RAW_TYPES = [/^get_[a-z0-9_]+_status$/, /^list_scene_items$/];
    const rawType = (() => {
      try { return String((body && body.type) || ""); } catch { return ""; }
    })();
    const isNoise = NOISY_PATHS.has(path)
      || (path === "/raw" && NOISY_RAW_TYPES.some((re) => re.test(rawType)));

    const brief = (() => {
      try {
        const b = body && typeof body === "object" ? body : {};
        const parts = [];
        if (b.op) parts.push(`op=${b.op}`);
        // type 也要记：/raw 那条路的全部信息都在 type 里，
        //   不记它就只能看到一句无用的 "type,params"。
        if (b.type) parts.push(`type=${b.type}`);
        if (b.name) parts.push(`name=${b.name}`);
        if (b.id) parts.push(`id=${b.id}`);
        if (b.file) parts.push(`file=${String(b.file).split(/[\\/]/).pop()}`);
        if (b.script) parts.push(`script=${String(b.script).length}字`);
        if (b.code) parts.push(`code=${String(b.code).length}字`);
        return parts.join(" ") || Object.keys(b).slice(0, 5).join(",");
      } catch { return ""; }
    })();

    let res, text, data;
    try {
      res = await sdk.runtime.fetch(state.runtimeId, path, {
        method: "POST",
        headers: { "content-type": "application/json", "x-relay-key": state.controlKey || "" },
        body: JSON.stringify(body && typeof body === "object" ? body : {}),
        timeoutMs: Math.min(Math.max(timeoutMs, 1000), 30_000),
      });
      text = await res.text();
    } catch (e) {
      // 探活**失败**要记——那是真信号（通道断了）。
      // 过掉的只是探活**成功**：那是常态。
      // （刚才这里写反了：注释说“失败要记”，代码却 !isNoise 跳过了。）
      appLog({ kind: "relay", path, brief, ms: Date.now() - t0, fail: "未送达", error: msgOf(e).slice(0, 200) });
      throw e;
    }

    data = null;
    let nonJson = false;
    try { data = text ? JSON.parse(text) : null; } catch { data = { ok: false, error: text.slice(0, 500) }; nonJson = true; }

    // ！非 JSON 应答单独标出来。
    //   这是“Internal Server Error”藏身的地方：中继崩了会回一段 HTML 错误页，
    //   JSON.parse 失败后 data.error 里就是那 500 个字符的 HTML 开头。
    //   不单独标的话，它和“中继正常返回了一个带 error 的 JSON”看着一样。
    // 探活成功不记；失败记（走下面的 error 字段），所以这里还要看 ok。
    if (!isNoise || !res.ok) {
      appLog({
        kind: "relay", path, brief,
        status: res.status, ms: Date.now() - t0,
        ...(nonJson ? { nonJson: true, head: String(text).slice(0, 160) } : {}),
        ...(res.ok ? {} : { error: String((data && data.error) || "").slice(0, 200) }),
      });
    }

    if (!res.ok) {
      throw withCode((data && data.error) || `中继 HTTP ${res.status}`, "internal");
    }
    return data;
  }

  // ── 状态聚合 ──────────────────────────────────────────────────────────────
  async function fullStatus() {
    const out = {
      ok: true,
      app: { id: APP_ID, version: APP_VERSION },
      phase: state.phase,
      runtimeId: state.runtimeId,
      servicePort: state.servicePort,
      addon: { host: state.config.addonHost, port: state.config.addonPort },
      workDir: state.config.workDir,
      lastError: state.lastError,
      ts: new Date().toISOString(),
    };
    if (state.phase === "ready") {
      try {
        out.health = await relayFetch("/health", {}, 8000);
      } catch (e) {
        out.health = { ok: false, error: msgOf(e) };
      }
    }

    // ── 五步真相 ─────────────────────────────────────────────────────────
    // 为什么单独算：phase==="ready" 只说「中继进程起来了」——
    // 跟 Blender 有没有起、addon 通不通、能不能跑 bpy 完全无关。
    // 之前把 ready 直接当「五步全通」写，于是 Blender 关着它也报全通。
    // 那种“状态不随实际变化”的显示比不显示更糟：它让人相信一个假事实。
    //
    // 真依据只有 /doctor（它对 ping 的结果做三级判定）。
    // 但 doctor 有往返成本，不能每次轮询都跑——所以缓存几秒。
    const steps = { relay: state.phase === "ready", service: false, tcp: false, addon: false, bpy: false };
    const h = out.health || {};
    // connected 是 addon 连接是否就绪（relay 自己维护的 socket 状态）
    steps.service = !!h.connected || !!h.ok;

    if (state.phase === "ready") {
      const now = Date.now();
      const fresh = state.lastDoctor && (now - state.lastDoctor.at) < 6000;
      if (!fresh) {
        try {
          const d = await relayFetch("/doctor", {}, 12_000);
          state.lastDoctor = { at: now, data: d };
        } catch (e) {
          state.lastDoctor = { at: now, data: { tcp: "fail", addon: "unknown", bpy: "unknown", lastError: msgOf(e) } };
        }
      }
      const d = (state.lastDoctor && state.lastDoctor.data) || {};
      steps.tcp = d.tcp === "ok";
      steps.addon = d.addon === "ok";
      // bpy 可能是 "unavailable"（精简版 addon 没 get_addon_info）——
      // 上游 doctor 自己把这种情况算作通过（out.ok 判的是 bpy !== "fail"）。
      // 这里跟着上游走，不自己加严。
      steps.bpy = d.bpy === "ok" || d.bpy === "unavailable";
      out.doctor = d;
    }
    out.steps = steps;
    out.stepsDone = [steps.relay, steps.service, steps.tcp, steps.addon, steps.bpy].filter(Boolean).length;
    out.allReady = out.stepsDone === 5;
    return out;
  }

  // ── 工具面：一个工具，action 分派 ─────────────────────────────────────────
  const TOOL_NAME = "blender";
  // ── 工具面：一个工具，action 分派 ─────────────────────────────────────────
  // 接口契约（actions / 参数表 / op 取值 / 提示）与两个派生函数
  // 现在住在 schema.js：它是唯一事实来源，能被测试直接 import，也能被自检读取。
  // 从前这几张表散在本文件里，各自手写、互相平行——新增一个参数要改三处，
  // 忘一处就静默失效（size 那次就是这么丢的）。
  //
  // 为什么搬出去而不是就地整理：只有出了这个闭包，它才「能被检查」。
  // 「能被检查」才是这类契约真正需要的性质，整洁只是顺带的。
  const { actions, actionBranches, actionCatalogText, selfCheck } = SCHEMA;

  // ── do 的危险操作扫描（P2 安全门）────────────────────────────────────────
  // 设计口径（计划书 §6-B 倾向「只提示不阻断」）：
  //   do 的价值就在「什么都能跑」——阻断会削掉它。所以命中危险模式时不拦截、
  //   而是在回执里**明确告知命中了什么**，把判断权交回模型与人。
  //   误伤比漏报更贵：bpy.ops.object.delete() 是常规建模操作，绝不能拦。
  const DANGER_PATTERNS = [
    { re: /\bos\.(remove|unlink|rmdir|removedirs|rename|replace)\s*\(/, what: "删除/重命名文件（os.*）" },
    { re: /\bshutil\.(rmtree|move|copy)\s*\(/, what: "文件树操作（shutil.*）" },
    { re: /\bsubprocess\b/, what: "启动外部进程（subprocess）" },
    { re: /\bos\.system\s*\(/, what: "调用系统命令（os.system）" },
    { re: /\beval\s*\(|\bexec\s*\(/, what: "动态执行代码（eval/exec）" },
    { re: /\bopen\s*\([^)]*['\"][wax]/, what: "写入/追加文件（open 模式 w/a/x）" },
    { re: /bpy\.ops\.wm\.(save_as_mainfile|save_mainfile|quit_blender|read_)/, what: "保存/退出/加载 blend 文件（wm.*）" },
    { re: /bpy\.ops\.(object|mesh)\.delete/, what: "删除物体（**常规建模操作**，仅提示）", benign: true },
    { re: /\b(sys\.exit|quit)\s*\(/, what: "退出进程（sys.exit）" },
  ];

  function scanDanger(code) {
    if (typeof code !== "string" || !code) return [];
    const hits = [];
    for (const p of DANGER_PATTERNS) {
      if (p.re.test(code)) hits.push({ what: p.what, benign: !!p.benign });
    }
    return hits;
  }

  function dangerNotice(code) {
    const hits = scanDanger(code);
    if (!hits.length) return "";
    const hard = hits.filter((h) => !h.benign);
    const soft = hits.filter((h) => h.benign);
    const lines = ["⚠ 这段代码包含需要注意的操作："];
    for (const h of hard) lines.push(`  - ${h.what}`);
    for (const h of soft) lines.push(`  - ${h.what}（常规操作，仅告知）`);
    if (hard.length) lines.push("（未阻断——do 的基本能力就是执行任意 Python，请确认后再依赖结果）");
    return lines.join("\n");
  }

  // ── 渲染任务桥（P3）────────────────────────────────────────────────────
  // 目标：提交即返回、后台跑、产物自动回会话。
  // 做法照 comfyui-hana：
  //   ctx.tasks.create({callToken, delivery:"next-step"}) → 后台轮询 → complete 带产物
  // 能力未授权时自动降级为「仅内存跟踪」，并在返回文案里如实说明（不制造预期落差）。
  const CAP_TASKS = "app/tasks.manage";
  const CAP_START_TURN = "app/session.start-turn";

  const renderWatches = new Map(); // jobId -> { taskId, timer, startedAt }
  const RENDER_WATCH_TIMEOUT_MS = 30 * 60 * 1000;

  // ── 心跳 ───────────────────────────────────────────────────────────────
  // 回执是“结束了”，心跳是“还在跑”。人焦虑的是后者：
  // 等待期间没有任何信息，就分不清它是在干活还是已经死了。
  //
  // 节流 5 秒：不是每次都发（那是刷屏），也不是静默（那就没意义）。
  // 这个数字照 comfyui-hana 的 maybeUpdateTaskProgress。
  const HEARTBEAT_MS = 5_000;
  const heartbeats = new Map(); // taskId -> { timer, startedAt, phase, lastNote }

  function startHeartbeat(taskId, label, getPhase) {
    if (!taskId) return;
    stopHeartbeat(taskId);
    const startedAt = Date.now();
    let lastPush = 0;
    const tick = async () => {
      const now = Date.now();
      if (now - lastPush < HEARTBEAT_MS) return;   // 节流
      lastPush = now;
      try {
        const phase = typeof getPhase === "function" ? getPhase() : getPhase;
        await sdk.tasks.update(taskId, {
          progress: {
            phase: String(phase || "执行中"),
            elapsedMs: now - startedAt,
            elapsedSec: Math.round((now - startedAt) / 100) / 10,
            label,
          },
        });
      } catch (e) {
        // 心跳失败不阻断正事，但要说一声——静默失败最难查
        warn(`任务心跳回写失败（${taskId}）：${msgOf(e)}`);
      }
    };
    const timer = setInterval(() => { void tick(); }, HEARTBEAT_MS);
    timer.unref?.();
    heartbeats.set(taskId, { timer, startedAt, label });
    void tick();   // 立即发一次：头 5 秒是最难等的
  }

  function stopHeartbeat(taskId) {
    if (!taskId) return;
    const h = heartbeats.get(taskId);
    if (!h) return;
    try { clearInterval(h.timer); } catch { /* 忽略 */ }
    heartbeats.delete(taskId);
  }

  // 把一段慢活包成“有回执的任务”。
  // 之前只有 render 接了桥，do / generator / qc / motion 全在裸奔：
  // 发出去就没声了。这里做成通用的，任何慢动作都能挂。
  //
  // 能力未授权时自动降级为“仅内存跟踪”，并在返回文案里如实说明——
  // 不制造预期落差（让用户以为会回执，结果没有）。
  async function makeTask({ label, callToken, action, meta, delivery = "next-turn" }) {
    if (!callToken) return { taskId: null, note: "无 callToken（非模型循环通道）：仅内存跟踪，不投递结果" };
    // session 级任务不允许 none——给了宿主就拒：
    //   Session-scope tasks require next-step or next-turn delivery
    // 这里撑一道，不让一个参数把整条桥卡死。
    const d = (delivery === "next-step" || delivery === "next-turn") ? delivery : "next-turn";
    const [c1, c2] = await Promise.all([hasCapability(CAP_TASKS), hasCapability(CAP_START_TURN)]);
    if (c1 === false) return { taskId: null, note: "缺少能力 app/tasks.manage（未创建宿主任务，完成后不会自动回执）" };
    if (c2 === false) return { taskId: null, note: "缺少能力 app/session.start-turn（未创建会话任务，完成后不会自动回执）" };
    try {
      const task = await sdk.tasks.create({
        callToken,
        label,
        delivery: d,
        metadata: { blender: { action, startedAt: Date.now(), ...(meta || {}) } },
      });
      const taskId = task && task.taskId ? String(task.taskId) : null;
      if (!taskId) return { taskId: null, note: "ctx.tasks.create 未返回 taskId（完成后不会自动回执）" };
      return { taskId, note: null };
    } catch (e) {
      const note = `宿主任务创建失败：${msgOf(e).slice(0, 160)}`;
      warn(note);
      return { taskId: null, note };
    }
  }

  // ── 慢活包装 ──────────────────────────────────────────────────────
  // 两个判断写了理由：
  //
  //   ① 只为真慢的活建任务（2.5 秒内结束就不建）。
  //      do 最常见的用法是“改个参数”“查个数”，那些是毫秒级；
  //      给它们都建一条任务，等于把会话刷成日志。
  //
  //   ② 同步路径用 delivery:"next-turn"，不用 "next-step"，更不能用 "none"。
  //
  //      ！这里我下午转过一个弯，错了：
  //      当时的理由是“结果已在工具返回值里，再 next-step 投一次是同一件事说两遍”——
  //      理由对，但结论下错了：我把“不重复播报”实现成了“干脆不建任务”，
  //      于是连心跳和收口一起丢了（而且宿主直接拒：
  //      Session-scope tasks require next-step or next-turn delivery）。
  //
  //      正确的分法：delivery 决定“结果投到哪”，不决定“要不要建任务”。
  //      next-turn = 下一轮开始时给，不像 next-step 那样打断当前回复，
  //      又能让心跳与收口正常工作。
  //      （render 不同：它提交就返回、正文里没结果，必须用 next-step 把图送回来。）
  const SLOW_GRACE_MS = 2_500;
  // 看门狗上限：从“活干完”起算，只用来接“忘了收口”，
  // 不是用来限制活本身的时长（那是各动作自己的 timeout 管的事）。
  const GUARD_MS = 60 * 1000;

  async function runTasked({ label, action, callToken, meta, delivery = "next-turn" }, fn) {
    const startedAt = Date.now();
    const p = (async () => fn())();
    let done = false;
    p.then(() => { done = true; }, () => { done = true; });
    await sleep(SLOW_GRACE_MS);
    if (done) return { result: await p, taskId: null, note: null, startedAt };

    const { taskId, note } = await makeTask({ label, callToken, action, meta, delivery });
    startHeartbeat(taskId, label, "执行中");
    // 看门狗：万一调用方忘了收口（走了未预期的分支、抛在外面），
    // 任务会永远停在“执行中”且心跳不停——
    // 那比“看不到”更坏：它一直显示一个不真的状态。
    //
    // 时机很讲究：不能从建任务那一刻起算。
    // 测出来的后果：活干完了、调用方还在写回执的那两行之间，
    // 它就把成功的活标成失败（终态不可改，改不回来）。
    // 所以从“活干完”那一刻起算——那时才真存在“该收没收”这个可能。
    let guard = null;
    const armGuard = () => {
      guard = setTimeout(() => {
        if (heartbeats.has(taskId)) {
          void settleErr(taskId, `${label}已跑完但未被收口（已自动标记）`);
        }
      }, GUARD_MS);
      guard.unref?.();
    };
    try {
      const result = await p;
      armGuard();
      return { result, taskId, note, startedAt };
    } catch (e) {
      await settleErr(taskId, `${label}失败：${msgOf(e).slice(0, 300)}`);
      throw e;
    }
  }

  // 成功收口：停心跳 → complete（先停心跳再 complete，
  // 否则“已完成”之后还可能蹦出一条“执行中”的进度，看着像又动了）
  async function settleOk(taskId, result) {
    if (!taskId) return;
    stopHeartbeat(taskId);
    // ！结算前先量一下大小。
    //   宿主对任务结果有 65536 字节硬上限，超了直接拒——
    //   而拒的后果是任务永远停在“未结算”，外面看不出异常。
    //   与其让它默默挂在那儿，不如自己先削：把最占地方的内容丢掉，
    //   保证“完成了”这件事能落下来。
    let payload = result;
    const n = resultBytes(payload);
    if (n > TASK_RESULT_MAX_BYTES) {
      warn(`任务结果过大（${n} > ${TASK_RESULT_MAX_BYTES} 字节），已削减后再结算`);
      const trimmed = { ...(result && typeof result === "object" ? result : { text: String(result) }) };
      delete trimmed.content;           // 内联图/大块内容先丢
      delete trimmed.images;
      if (resultBytes(trimmed) > TASK_RESULT_MAX_BYTES) {
        // 还超就只留一句话——至少让人知道“完成了、东西在磁盘上”
        const path = trimmed.blender?.file || trimmed.file || "";
        payload = { text: `完成${path ? `（产物：${path}）` : ""}`, trimmed: true };
      } else {
        payload = { ...trimmed, trimmed: true };
      }
    }
    try { await sdk.tasks.complete(taskId, payload); }
    catch (e) { warn(`任务结算失败（${taskId}）：${msgOf(e)}`); }
  }

  async function settleErr(taskId, text) {
    if (!taskId) return;
    stopHeartbeat(taskId);
    try { await sdk.tasks.fail(taskId, text); }
    catch (e) { warn(`任务失败回写异常（${taskId}）：${msgOf(e)}`); }
  }

  // 能力账本。
  //
  // 两个错都得记一下，因为“错得很安静”：
  //   ① verb 是 app:capabilities，不是 capability:list。
  //      猜的名字不在允许清单里，调用直接被拒 —— 而 catch 吃掉了它。
  //   ② 返回是 { capabilities: [{ capability, status }] }，是个数组，不是对象。
  //      当对象读 → map[word] 永远是 undefined → hasCapability 永远 false。
  //   两个叠一起的结果：任务桥从来没建过任务，而外面看不出任何异常。
  let capsCache = null;
  async function capabilitiesMap(force = false) {
    if (!force && capsCache && Date.now() - capsCache.at < 30_000) return capsCache.map;
    try {
      if (typeof sdk.bus?.request !== "function") return null;
      const res = await sdk.bus.request("app:capabilities", {}, { timeoutMs: 8000 });
      const map = {};
      const rows = res && Array.isArray(res.capabilities) ? res.capabilities : [];
      for (const c of rows) {
        if (c && typeof c.capability === "string") map[c.capability] = c.status;
      }
      capsCache = { at: Date.now(), map };
      return map;
    } catch (e) {
      warn(`app:capabilities 查询失败：${msgOf(e)}`);
      return null;
    }
  }

  async function hasCapability(word) {
    const map = await capabilitiesMap();
    if (!map) return false;
    const st = map[word];
    return st === "always" || st === "session";
  }

  function buildRenderResult(jobId, st) {
    const info = st.info || {};
    const secs = info.elapsedSec != null ? info.elapsedSec : Math.round((st.elapsedMs || 0) / 100) / 10;
    // ！任务结果只放“指路”信息，不放货。
    //
    // 这里踩过：早先把整张图的 base64 也塞进 result，
    //   而宿主对任务结果有 **65536 字节上限**。
    //   一张 900x1000 的 PNG 是 ~860KB，base64 后 ~1.1MB —— 必超。
    //   后果：图正常出、用户看得到，但 **任务结算被拒**，
    //   任务永远停在“未结算”，直到 App 重载被标成 aborted。
    //   （日志：`任务结算失败：result exceeds 65536 bytes`）
    //
    // 结果里给路径 + 元数据就够了：图在磁盘上，想看的人去看。
    // 跟“同步动作不重复播报结果”是同一个道理——
    // 任务结果的职责是告诉人去哪儿拿，不是把东西搬过去。
    const out = {
      text: `Blender 渲染完成（jobId ${jobId}，用时 ${secs}s，${st.bytes || 0} bytes）：\n- ${st.file}`,
      blender: {
        action: "render",
        jobId,
        file: st.file,
        bytes: st.bytes || 0,
        res: info.res || null,
        engine: info.engine || null,
        elapsedSec: secs,
      },
    };
    return out;
  }

  // 任务结果的大小上限（宿主硬限制）。
  // 放这里是为了让“写结果的人”能看到它，而不是靠记住。
  const TASK_RESULT_MAX_BYTES = 65536;

  function resultBytes(result) {
    try { return Buffer.byteLength(JSON.stringify(result), "utf8"); } catch { return Infinity; }
  }

  function watchRenderJob(jobId, taskId) {
    if (renderWatches.has(jobId)) return;
    const startedAt = Date.now();
    let lastPhase = "排队中";
    // 心跳：让“渲染中”在会话里看得见，而不是一片静默
    startHeartbeat(taskId, `Blender 渲染 · ${jobId}`, () => lastPhase);
    const timer = setInterval(async () => {
      try {
        const st = await relayFetch("/render/status", { jobId }, 20_000);
        if (st.state === "completed") {
          clearInterval(timer);
          renderWatches.delete(jobId);
          if (taskId) await settleOk(taskId, buildRenderResult(jobId, st));
          log(`渲染任务完成并已结算：${jobId}`);
          return;
        }
        if (st.state === "failed") {
          clearInterval(timer);
          renderWatches.delete(jobId);
          await settleErr(taskId, `渲染失败：${st.error || "未知原因"}`);
          return;
        }
        if (st.state === "canceled" || st.state === "interrupted") {
          clearInterval(timer);
          renderWatches.delete(jobId);
          if (taskId) { stopHeartbeat(taskId); try { await sdk.tasks.cancel(taskId, "用户取消（渲染已中断）"); } catch { /* 忽略 */ } }
          return;
        }
        lastPhase = st.state === "running" ? "渲染中" : "排队中";
        if (Date.now() - startedAt > RENDER_WATCH_TIMEOUT_MS) {
          clearInterval(timer);
          renderWatches.delete(jobId);
          await settleErr(taskId, "渲染跟踪超时（30 分钟）");
        }
      } catch (e) {
        warn(`渲染轮询异常（${jobId}）：${msgOf(e)}`);
      }
    }, 1500);
    timer.unref?.();
    renderWatches.set(jobId, { taskId, timer, startedAt });
  }

  function textResult(text, extra = {}) {
    return { content: [{ type: "text", text }], ...extra };
  }

  // 把产物收进 run。
  // 为什么要自动：让 agent 每次出图都手动 begin/put/finish 是不现实的——
  // 一忙就忘，忘了就退回到“产物散在 work/ 里”那个老状态。
  // 所以关键路径（出一组通道图、批量视角）自己就归档，agent 只管标基线。
  //   runId 给了就续进那个 run；没给就开一个新的。
  function autoArchive({ runId = null, label = "产出", action = "view", items = [] } = {}) {
    try {
      if (!state.runs) return null;
      let run = runId ? state.runs.get(runId) : null;
      let created = false;
      if (!run) {
        run = state.runs.begin({ label, action, meta: { by: "agent" } });
        created = true;
      }
      const got = [];
      for (const it of items) {
        if (!it || !it.from) continue;
        const rel = state.runs.put(run, { from: it.from, kind: it.kind || "view", name: it.name || null, note: it.note || null });
        if (rel) got.push(rel);
      }
      // 没收到任何东西就别留空壳目录
      if (!got.length && created) {
        try { rmSync(run.dir, { recursive: true, force: true }); } catch { /* 忽略 */ }
        return null;
      }
      if (created) state.runs.finish(run, {});
      return { id: run.id, dir: run.dir, created, rel: got };
    } catch (e) {
      warn(`自动归档失败（不影响主流程）：${msgOf(e)}`);
      return null;
    }
  }

  // 归档提示语。统一说法，免得每个分支各写一句
  function archiveNote(a) {
    if (!a) return "- 归档：无（没找到可收的产物）";
    return `- 归档：${a.created ? "新建" : "续入"} run ${a.id}（${a.rel.length} 个）· runs op=tag id=${a.id} tag=baseline 可标基线`;
  }

  // ── 派活（唯一实现）────────────────────────────────────────────────────────
  //
  // 两个入口共用这一段：卡片上的「派给助手」按钮（走 /dispatch 路由）
  // 和对话里的 blender action=dispatch（走工具面）。
  //
  // 为什么不各写一份：抄的那份不会报错，只会慢慢飘——
  // 而“换模型”这种待发的参数已经飘过一次（model ≠ modelId）。
  //
  // 取完整模型地址（modelId + provider）。
  //
  // ！为何要有这个函数：provider 和 modelId 是**成对**的——
  //   契约 AppSessionSwitchModelRequestV2 两个都必填。
  //   但它们不一定成对地存在。踩过：dispatchModel 存下了、
  //   dispatchProvider 没存（早先 loadConfig 压根没读它），
  //   于是重启后模型有值、provider 空，“换模型”永远报“没拿到 provider”。
  //   而人看到的是“没换成”，根本猜不到是配置只存了一半。
  //
  //   所以：只要知道 modelId，就去模型列表里把 provider 查出来。
  //   查不到就不编——编一个错的 provider 还不如明确说拿不到。
  async function resolveProvider(modelId, knownProvider = "") {
    if (knownProvider) return knownProvider;
    const id = String(modelId || "").trim();
    if (!id) return "";
    if (typeof sdk.bus?.request !== "function") return "";
    try {
      const r = await sdk.bus.request("model:list", undefined, { timeoutMs: 8000 });
      const raw = (r && r.models) || [];
      const hit = raw.find((m) => {
        if (!m || typeof m !== "object") return false;
        const mid = String(m.id || m.modelId || m.name || "");
        return mid === id;
      });
      return hit ? String(hit.provider || hit.providerId || "") : "";
    } catch { return ""; }
  }

  // 入参：{ brief, agentId?, modelId?, provider?, runId?, sessionId? }
  // 返回：{ ok, ... } 或抛错
  async function dispatchWork({ brief, agentId, modelId, provider, runId, sessionId } = {}) {
    const write = String(brief || "").trim();
    if (!write) throw new Error("先说一句要做什么");

    const wantAgent = String(agentId || state.config.dispatchAgentId || "");
    const wantModel = String(modelId || state.config.dispatchModel || "");
    // provider 必须一起带上。session:switch-model 的契约里
    // modelId 和 provider 都是必填（AppSessionSwitchModelRequestV2）。
    // 拿不到就现查——详见 resolveProvider 上面那段。
    const wantProvider = await resolveProvider(
      wantModel,
      String(provider || state.config.dispatchProvider || ""),
    );

    if (typeof sdk.bus?.request !== "function") throw new Error("宿主未提供 bus，无法派活");
    if (!wantAgent) throw new Error("派活必须知道发给谁——先选一个助手");

    // 把产物上下文一并带过去：agent 看到的是“针对这一版”的要求，
    // 而不是一句飘在空中的指令。
    const ctxLines = [];
    if (runId && state.runs) {
      const run = state.runs.get(runId);
      if (run) {
        ctxLines.push(`【当前产出】${run.label || run.id}${run.tag ? `（${run.tag}）` : ""}`);
        if (run.dir) ctxLines.push(`【目录】${run.dir}`);
        const files = run.files || {};
        const all = [];
        for (const k of Object.keys(files)) for (const f of files[k] || []) all.push(`${k}/${f.rel}`);
        if (all.length) ctxLines.push(`【产物】${all.slice(0, 12).join("、")}`);
        const fb = state.runs.readFeedback(run);
        if (fb) ctxLines.push(`【此前意见】\n${fb}`);
      }
    }

    // 找会话：优先复用**本 App 建的**那个活跃会话，没有才建新的。
    //
    // ！这里有两道坑，都踩过：
    //
    //   ① “列表失败就退回建新的”——听着像降级，实际是静默吞掉权限拒绝：
    //      manifest 没声明 app/sessions.read 时，session:list 会被拒，
    //      而外面看不出任何异常，只是每派一次就新建一个会话，无限堆积。
    //      所以现在失败要报出来。
    //
    //   ② 不能什么会话都复用。ownerPluginId 是宿主的归属戳：
    //      只挑本 App 建的，否则会把派活内容塞进用户自己的对话里。
    let sid = sessionId ? String(sessionId) : null;
    let created = null;
    let listError = null;
    if (!sid) {
      try {
        const sl = await sdk.bus.request("session:list", { scope: "all", agentId: wantAgent }, { timeoutMs: 8000 });
        const list = (sl && sl.sessions) || [];
        // 只看自己建的、还活着的
        const mine = list.filter((x) => x && x.sessionId && x.ownerPluginId === APP_ID);
        const active = mine.filter((x) => (x.lifecycle || "active") === "active");
        // 取最近改过的那个：同一助手可能有多个旧会话，用最新的才符合直觉
        const pick = active.sort((a, b) => String(b.modified || "").localeCompare(String(a.modified || "")))[0]
          || mine[0];
        if (pick && pick.sessionId) sid = String(pick.sessionId);
      } catch (e) {
        // 不吞。退到建新的可以，但得让人知道为什么没复用。
        listError = msgOf(e);
        warn(`会话列表读不到（将新建会话）：${listError}`);
      }
    }
    if (!sid) {
      // create 时不带 model：带了就多依赖一个权限，
      // 那边一拒，会话就建不出来（连带整个派活挂掉）。
      // 先建会话，要换模型再用 switch-model 单独换——两步各自失败互不牵连。
      const cr = await sdk.bus.request("session:create", { agentId: wantAgent }, { timeoutMs: 15000 });
      if (cr && (cr.sessionId || (cr.sessionRef && cr.sessionRef.sessionId))) {
        sid = String(cr.sessionId || cr.sessionRef.sessionId);
        created = sid;
      }
    }
    if (!sid) throw new Error("没拿到可发的会话——宿主没能给出那个助手的会话");

    const text = ["[Blender 助手 · 派活]", ...ctxLines, "【要求】", write].join("\n");

    // 换模型必须在发送之前。
    //
    // ！这里踩过一个很隐蔽的坑：早先是先发再切，理由是“万一切失败，话已经送到了，
    //   不用重发”。理由听着对，实际是拿主场景换边缘场景——
    //   主场景是“活应该跑在选的那个模型上”，而 send-custom 带 triggerTurn:true
    //   是**立即起跑**的，等切完活已经用旧模型干完了。
    //   （实测：会话里 model_change 到新模型的时间戳比 assistant 回复还晚 39ms。）
    // 换到前面还有个好处：切失败就还没发出去，能先告诉人再决定。
    //
    // ！字段名也踩过坑：契约是 { sessionId, modelId, provider }，
    //   两个都是必填。早先发的是 { sessionId, model } ——
    //   名字错、又缺 provider，这条路径从来没成功过。
    let modelSwitched = null;
    let modelError = null;
    if (wantModel) {
      if (!wantProvider) {
        // 不发一个注定被拒的请求。契约里 provider 是必填。
        modelSwitched = false;
        modelError = "没拿到这个模型的 provider——列表里可能没给出，换不了";
      } else {
        try {
          const mr = await sdk.bus.request("session:switch-model",
            { sessionId: sid, modelId: wantModel, provider: wantProvider },
            { timeoutMs: 8000 });
          // 成功形状是 ok:true；失败一般是抛异常。
          // 两种都判，不用 ok === false —— 那个条件永远不成立。
          if (mr && mr.ok !== true) { modelSwitched = false; modelError = mr.error || "被拒绝"; }
          else modelSwitched = true;
        } catch (e) { modelSwitched = false; modelError = msgOf(e); }
      }
    }

    const sr = await sdk.bus.request("session:send-custom", {
      scope: "all",
      sessionId: sid,
      customType: "blender-bridge-dispatch",
      display: true,
      triggerTurn: true,
      content: [{ type: "text", text }],
    }, { timeoutMs: 8000 });
    if (!sr || sr.ok !== true) {
      // 话没送到就要说清。模型换成了也得提一句——会话状态已经变了。
      const tail = modelSwitched === true ? "（模型已换成 " + wantModel + "，但这条要求没发出去）" : "";
      throw new Error(((sr && sr.error) || "宿主没有确认这条要求已接纳") + tail);
    }

    // 记住这次的选择，下次不用重选。
    // ！model 和 provider 要**一起**存：它们是同一个地址的两半。
    //   只存一半，下次启动就成了“模型有、provider 空”——
    //   而那个状态下的报错是“没拿到 provider”，跟“没存”看不出关系。
    const cfgPatch = {};
    if (wantAgent) { state.config.dispatchAgentId = wantAgent; cfgPatch.dispatchAgentId = wantAgent; }
    if (wantModel) { state.config.dispatchModel = wantModel; cfgPatch.dispatchModel = wantModel; }
    if (wantModel && wantProvider) { state.config.dispatchProvider = wantProvider; cfgPatch.dispatchProvider = wantProvider; }
    // 迁就旧状态：模型换了、provider 却是上一任模型留下的，就把它清掉。
    // 宁可下次重新查，也不要拿错 provider 去切——那会切失败，且原因看着像无关的。
    if (wantModel && !wantProvider && state.config.dispatchProvider) {
      state.config.dispatchProvider = "";
      cfgPatch.dispatchProvider = "";
    }
    if (Object.keys(cfgPatch).length) saveConfig();

    return {
      ok: true,
      entryId: sr.entryId || null,
      sessionId: sid,
      createdSession: !!created,
      modelSwitched,
      modelError,
      agentId: wantAgent,
      modelId: wantModel || null,
      provider: wantProvider || null,
      // 没复用上会话时，把原因一并带出去（多为权限缺失）。
      listError,
    };
  }

  // 从 list_scene_items 的 detail 里抽出物体类型。
  // detail 形如 "Mesh object in collection 'Flower'" —— 类型是开头的词，
  // 但要转成 UI 那边用的短名（MESH / LIGHT / CAMERA）。拿不到就返回 "?"，
  // 不编一个看着合理的值。
  function extractType(detail) {
    const w = String(detail || "").trim().split(/\s+/)[0] || "";
    const m = { Mesh: "MESH", Light: "LIGHT", Camera: "CAMERA", Empty: "EMPTY",
      Curve: "CURVE", Armature: "ARMATURE", Text: "FONT" };
    return m[w] || (w ? w.toUpperCase() : "?");
  }

  async function runAction(args) {
    const action = args && args.action;
    if (!action) throw new Error(`action 必填，取值：${actions.map((a) => a.id).join(" / ")}`);
    const timeoutMs = Number(args.timeoutMs || 0) || undefined;

    switch (action) {
      case "doctor": {
        await ensureStarted();
        if (state.phase !== "ready") {
          return textResult(`中继未就绪（phase=${state.phase}）。\n${state.lastError?.userText || ""}`);
        }
        const d = await relayFetch("/doctor", {}, 30_000);
        const lines = [
          `通道体检：${d.ok ? "正常" : "未通过"}`,
          `- TCP 到 addon ${d.addonHost}:${d.addonPort}：${d.tcp}`,
          `- addon 应答：${d.addon}`,
          `- bpy 往返：${d.bpy}${d.bpyNote ? `（${d.bpyNote}）` : ""}`,
          d.latencyMs != null ? `- 往返耗时：${d.latencyMs}ms` : "",
          d.lastError ? `- 最近错误：${d.lastError}` : "",
        ].filter(Boolean);
        return textResult(lines.join("\n"), { details: { doctor: d } });
      }

      case "view": {
        const spec = { from: args.from, look_at: args.look_at, width: args.width, height: args.height, lens: args.lens, ortho: args.ortho };
        const r = await relayFetch("/rt/view", { ...spec, asJson: true }, 60_000);
        if (r.ok === false) return textResult(`自定义视角出图失败：${r.error || "未知"}`);
        const meta = r.meta || {};
        const lines = [
          `已从指定视角出图`,
          `- 相机：from=[${(meta.spec?.from || args.from || []).join(", ")}] look_at=[${(meta.spec?.look_at || args.look_at || []).join(", ")}]`,
          `- 尺寸：${meta.width}×${meta.height}（mode=${meta.mode}）`,
          `- 落盘：${meta.path || "-"}`,
        ];
        if (meta.bytes) lines.push(`- 字节：${meta.bytes}`);
        // 单视角也归档：不然四张视角图各自孤立，看不出是同一批
        const arc = autoArchive({
          runId: args.runId || null,
          label: args.label || "视角",
          action: "view",
          items: meta.path ? [{ from: meta.path, kind: args.hero ? "hero" : "view", name: args.name || null }] : [],
        });
        if (arc) lines.push(archiveNote(arc));
        let content = [{ type: "text", text: lines.join("\n") }];
        if (meta.path && existsSync(meta.path)) {
          const img = readImageAsDataUrl(meta.path);
          if (img && img.base64) content.push({ type: "image", data: img.base64, mimeType: img.mimeType || "image/png" });
        }
        return { content };
      }

      case "loop": {
        const op = String(args.op || "status");
        const body = { op };
        if (op === "start") body.spec = args.spec || {};
        if (args.limit != null) body.limit = args.limit;
        if (args.history != null) body.history = args.history;
        if (args.path) body.path = args.path;
        if (args.top != null) body.top = args.top;
        if (args.iterations != null) body.iterations = args.iterations;
        const r = await relayFetch("/rt/loop", body, 120_000);
        const res = r.result || {};
        if (op === "start") {
          if (res.ok === false) return textResult(`内环启动失败：${res.err || res.error || "未知"}`);
          return textResult([
            `内环已启动`,
            `- 迭代上限：${res.limits?.iterations}｜时间上限：${res.limits?.budget_ms}ms`,
            `- top_k：${res.limits?.top_k ?? 0}`,
            `- 下一步：用 op=status 看进度，op=board 看候选表，op=export 导出脚本`,
          ].join("\n"), { details: res });
        }
        if (op === "status") {
          const lines = [
            `内环状态`,
            `- 进度：${res.i ?? 0}/${res.iterations ?? "?"}（${res.running ? "运行中" : res.done ? "已完成" : "未启动"}）`,
            `- 速度：${res.tps ?? 0} 次/秒｜耗时：${res.elapsed_ms ?? 0}ms`,
          ];
          if (res.best) lines.push(`- 最优：score=${res.best.score?.toFixed?.(6) ?? res.best.score}${res.best.params ? " params=" + JSON.stringify(res.best.params) : ""}`);
          if (res.error) lines.push(`- 错误：${String(res.error).slice(0, 300)}`);
          return textResult(lines.join("\n"), { details: res });
        }
        if (op === "board") {
          const flat = res.board?.flat || [];
          const lines = [`候选表（${flat.length} 条）`];
          for (const e of flat.slice(0, 15)) {
            lines.push(`- score=${e.score?.toFixed?.(6) ?? e.score} i=${e.i}${e.params ? " " + JSON.stringify(e.params) : ""}`);
          }
          if (!flat.length) lines.push("（还没有候选：先 op=start 并等它跑几轮）");
          return textResult(lines.join("\n"), { details: res });
        }
        return textResult(JSON.stringify(res, null, 2).slice(0, 4000));
      }

      case "txn": {
        const op = String(args.op || "list");
        const txArgs = { ...(args.args || {}) };
        if (args.label) txArgs.label = args.label;
        const r = await relayFetch("/rt/txn", { op, args: txArgs }, 120_000);
        const res = r.result || {};
        if (res.ok === false) return textResult(`事务 ${op} 失败：${res.error || "未知"}`);
        if (op === "mark") {
          return textResult(`已打回退点「${res.mark}」（记录了 ${res.objects} 个对象）\n- ${res.note || ""}\n- 要回滚：txn op=revert label=${res.mark}`, { details: res });
        }
        if (op === "revert") {
          return textResult(`已回滚到「${res.reverted}」（变更 ${res.changed_count} 项）\n- ${(res.changed || []).slice(0, 10).join("、")}`, { details: res });
        }
        if (op === "marks" || op === "list") {
          const marks = res.marks || [];
          const snaps = res.snapshots || [];
          const lines = ["事务状态"];
          lines.push(`- 回退点（对象级）：${marks.length ? marks.map((m) => `${m.label}(${m.objects} 对象)`).join("、") : "无"}`);
          lines.push(`- 快照（文件级）：${snaps.length ? snaps.map((x) => x.label || x.id || "?").join("、") : "无"}`);
          return textResult(lines.join("\n"), { details: res });
        }
        return textResult(JSON.stringify(res, null, 2).slice(0, 4000));
      }

      case "plan": {
        const op = String(args.op || "status");
        const r = await relayFetch("/rt/plan", { op, args: args.args || {} }, 180_000);
        const res = r.result || {};
        if (res && res.ok === false && res.error) return textResult(`契约层 ${op} 失败：${res.error}`);

        // 做可读摘要——裸 JSON 对使用不友好
        const lines = [`契约层 · ${op}`];
        const c = res.components ?? 0, cn = res.connections ?? res.connections_count ?? 0;
        if (op === "status") {
          lines.push(`- 组件：${c}｜连接：${cn}｜包络：${res.envelopes ?? 0}｜证据：${res.evidence ?? 0}`);
          if (res.unresolved_connections != null) lines.push(`- 未判别连接：${res.unresolved_connections}`);
          if (res.connections_detail) {
            for (const [id, v] of Object.entries(res.connections_detail)) {
              lines.push(`  · ${id}：${v.status}${v.note ? " — " + String(v.note).slice(0, 50) : ""}`);
            }
          }
        } else if (op === "verify") {
          lines.push(`- 判定：**${res.verdict || res.status}**`);
          if (res.why) {
            const why = Array.isArray(res.why) ? res.why : [res.why];
            for (const w of why.slice(0, 6)) lines.push(`  · ${String(w).slice(0, 120)}`);
          }
          if (res.needs_probe) lines.push(`- 还需要探针：${res.needs_probe}`);
        } else if (op === "flip") {
          lines.push(`- 已翻转到：${res.to || "?"}｜${res.why ? String(res.why).slice(0, 100) : ""}`);
        } else if (String(op).startsWith("generator")) {
          if (op === "generator_list") {
            lines.push(`- 注册表：${res.count ?? 0} 个生成器｜目录：${res.root || "-"}`);
            for (const g of (res.generators || []).slice(0, 15)) {
              lines.push(`  · ${g.name}${g.note ? " — " + String(g.note).slice(0, 50) : ""}`);
            }
          } else {
            lines.push(`- ${JSON.stringify(res).slice(0, 600)}`);
          }
        } else {
          const brief = JSON.stringify(res);
          lines.push(brief.length > 900 ? brief.slice(0, 900) + "…" : brief);
        }
        return textResult(lines.join("\n"), { details: res });
      }

      case "headless": {
        // 无头跑脚本是最慢的一类（默认 5 分钟）——一定要有心跳。
        const out = await runTasked(
          { label: `Blender 无头运行 · ${String(args.file || args.code || "").split("\n")[0].slice(0, 40)}`, action: "headless", callToken: args?.context?.callToken },
          () => relayFetch("/rt/headless", {
            script: args.code,
            file: args.file,
            outdir: args.outdir,
            args: args.args,
            timeoutMs: args.timeoutMs || 300_000,
          }, (Number(args.timeoutMs) || 300_000) + 20_000),
        );
        const r = out.result;
        // 先看 ok。不看就直接读 result，失败时拼出来的是个只有标题的空回执——
        // “看着成功了，实际什么也没跑”，比明确报错还难查。
        const okFlag = r && r.ok !== false;
        const res = (r && r.result) || {};
        if (!okFlag) {
          const why = (r && r.error) || "未知错误";
          await settleErr(out.taskId, `无头运行未能启动：${why}`);
          return textResult(`无头 Blender 没能启动：${why}`);
        }
        if (res.ok === false) {
          const why = res.error || "未知错误";
          await settleErr(out.taskId, `无头运行失败：${why}`);
          return textResult(`无头 Blender 运行失败：${why}`);
        }
        const lines = [`无头 Blender 运行完成（不占 GUI 通道）`];
        if (res.ms != null) lines.push(`- 耗时：${res.ms}ms`);
        if (res.exitCode != null) lines.push(`- 退出码：${res.exitCode}`);
        if (res.stdout) lines.push(`- stdout：${String(res.stdout).trim().slice(0, 600)}`);
        if (res.stderr) lines.push(`- stderr：${String(res.stderr).trim().slice(0, 600)}`);
        if (res.result) lines.push(`- 结果：${JSON.stringify(res.result).slice(0, 600)}`);
        if (res.exitCode && res.exitCode !== 0) {
          await settleErr(out.taskId, `无头运行退出码 ${res.exitCode}`);
        } else {
          await settleOk(out.taskId, { text: `无头 Blender 运行完成（${res.ms != null ? res.ms + "ms" : "已结束"}）` });
        }
        return textResult(lines.join("\n"), { details: res });
      }

      case "commands": {
        const r = await relayFetch("/rt/commands", {}, 60_000);
        const res = r.result || {};
        const avail = res.available || [];
        const lines = [`addon 命令面：可用 ${avail.length}/${res.total ?? "?"} 条（场景：${res.scene || "-"}）`];
        lines.push(`- ${avail.join(", ")}`);
        if (res.integrations) {
          lines.push(`- 集成：` + Object.entries(res.integrations).map(([k, v]) => `${k}=${v ? "开" : "关"}`).join(" "));
        }
        return textResult(lines.join("\n"), { details: res });
      }

      case "qc": {
        const op = String(args.op || "compare_auto");
        const r = await relayFetch("/rt/plan", { op: "qc_" + op, args: args.args || {} }, 300_000);
        const res = r.result || {};
        if (res.ok === false && res.error) return textResult(`QC ${op} 失败：${res.error}`);
        const lines = [`QC · ${op}`];
        if (res.iou != null) lines.push(`- IoU（固定对齐，诚实值）：**${res.iou}**`);
        if (res.iou_search != null) lines.push(`- IoU（搜索对齐，仅供参考）：${res.iou_search}`);
        if (res.dice != null) lines.push(`- Dice：${res.dice}`);
        if (res.warnings?.length) lines.push(`- ⚠ 告警：${res.warnings.join("；").slice(0, 200)}`);
        if (res.paths || res.out_path || res.overlay) {
          const p = res.overlay || res.out_path || res.path;
          lines.push(`- 对照图：${p || "-"}`);
        }
        if (lines.length === 1) lines.push(JSON.stringify(res).slice(0, 700));
        let content = [{ type: "text", text: lines.join("\n") }];
        const imgPath = res.overlay || res.out_path || res.path;
        if (imgPath && existsSync(imgPath)) {
          const img = readImageAsDataUrl(imgPath);
          if (img && img.base64) content.push({ type: "image", data: img.base64, mimeType: img.mimeType || "image/png" });
        }
        return { content };
      }

      case "deliver": {
        const op = String(args.op || "export");
        const r = await relayFetch("/rt/plan", { op: "deliver_" + op, args: args.args || {} }, 300_000);
        const res = r.result || {};
        if (res.ok === false && res.error) return textResult(`交付 ${op} 失败：${res.error}`);
        if (op === "export") {
          const files = res.files || {};
          const lines = [`已导出交付物：${res.name || "?"}（${res.fmt || "obj"}）`, `- 目录：${res.dir || "-"}`];
          for (const [k, v] of Object.entries(files)) {
            lines.push(`  · ${k}：${v.path || v}${v.bytes ? `（${v.bytes} bytes）` : ""}`);
          }
          if (res.units_note) lines.push(`- 单位：${String(res.units_note).slice(0, 120)}`);
          if (res.normalized) lines.push(`- 已归一化到单位盒（target_half_extent=${res.target_half_extent ?? 1}）`);
          return textResult(lines.join("\n"), { details: res });
        }
        if (op === "verify") {
          const checks = res.checks || [];
          const bad = checks.filter((c) => !c.ok);
          const lines = [
            res.ok ? `交付校验通过（${res.passed}/${checks.length}）` : `⚠ 交付校验**未通过**（${res.failed} 项 FAIL）`,
          ];
          for (const c of bad.slice(0, 10)) lines.push(`  ✗ ${c.name}${c.detail ? " — " + String(c.detail).slice(0, 90) : ""}`);
          if (!bad.length) for (const c of checks.slice(0, 8)) lines.push(`  · ${c.name}${c.detail ? " — " + String(c.detail).slice(0, 70) : ""}`);
          return textResult(lines.join("\n"), { details: res });
        }
        return textResult(JSON.stringify(res).slice(0, 2500), { details: res });
      }

      case "audit": {
        const op = String(args.op || "scene");
        const r = await relayFetch("/rt/plan", { op: "audit_" + op, args: args.args || {} }, 300_000);
        const res = r.result || {};
        if (res.ok === false && res.error) return textResult(`体检 ${op} 失败：${res.error}`);
        const lines = [`网格体检 · ${op}`];
        const t = res.totals || res;
        if (t.objects != null) {
          lines.push(`- 对象 ${t.objects}｜三角面 ${t.tris}｜边界边 ${t.boundary_edges}｜非流形边 ${t.nonmanifold_edges}`);
          lines.push(`- 退化面 ${t.degenerate_faces}｜孤立顶点 ${t.loose_verts}｜自相交 ${t.self_intersections}`);
        }
        const issues = res.issues || [];
        if (issues.length) {
          lines.push(`- 发现 ${issues.length} 处问题：`);
          for (const i of issues.slice(0, 8)) lines.push(`  · ${i.kind || i.type || "?"}${i.object ? " @" + i.object : ""}${i.detail ? " — " + String(i.detail).slice(0, 70) : ""}`);
        } else if (res.per_object) {
          for (const o of (res.per_object || []).slice(0, 10)) {
            lines.push(`  · ${o.name || o.object}：三角面 ${o.tris ?? "?"} 问题 ${(o.issues || []).length}`);
          }
        }
        if (lines.length === 1) lines.push(JSON.stringify(res).slice(0, 800));
        return textResult(lines.join("\n"), { details: res });
      }

      case "nodes": {
        // 几何节点 / 材质节点的**声明式配方**。
        //
        // 为何不是“把节点 JSON 贴给我”：
        //   那要求调用方知道每个节点的 bl_idname、每个插口的索引、
        //   新建节点组没有 Group Input/Output 得自己补……
        //   这些都不是“想做一片草地”的人该记的东西。
        //
        // 为何把 python 放在 runtime/nodes.py 而不是拼字符串：
        //   节点树逻辑有几百行，拼成 JS 字符串后无法单独语法检查、
        //   也无法直接跑。而现在这份 py 可以单独 exec 验证（已经验过了）。
        const op = String(args.op || "recipes");
        const pyPath = join(import.meta.dirname || ".", "runtime", "nodes.py");
        if (!existsSync(pyPath)) return textResult(`节点配方模块不在：${pyPath}`);
        const pySrc = readFileSync(pyPath, "utf8");

        // ── 自检 ────────────────────────────────────────────────────────
        // 自检脚本不能靠 stdout 回传：中继回包会混入别的东西，上层还会截断。
        // 所以把脚本拼进来跑，直接取它的 HEADLESS_RESULT 变量。
        if (op === "selftest") {
          const tPath = join(import.meta.dirname || ".", "runtime", "_selftest_nodes.py");
          if (!existsSync(tPath)) return textResult(`自检脚本不在：${tPath}`);
          const tSrc = readFileSync(tPath, "utf8");
          const code = [
            pySrc,
            // 自检脚本里还会 open(SRC) 载入一次 nodes.py —— 那种路径在安装后不同，
            // 所以先把源码塞进去，让它复用这份（见脚本开头的 _PRELOADED_SRC）。
            `_PRELOADED_SRC = ${JSON.stringify(pySrc)}`,
            tSrc,
            "print('DSH_SELFTEST ' + _json.dumps(HEADLESS_RESULT, ensure_ascii=False))",
          ].join("\n");
          const rr2 = await relayFetch("/do", { code: `import json as _json\n${code}`, timeoutMs: 120_000 }, 130_000);
          const out2 = String((rr2 && rr2.result && rr2.result.result) || "");
          const mm = /DSH_SELFTEST (\{[\s\S]*?\})\s*$/.exec(out2.trim());
          if (!mm) {
            const tail = (rr2 && rr2.result && (rr2.result.error || rr2.result.stderr)) || out2.slice(-500) || "无回执";
            return textResult(`自检没有回执：${String(tail).replace(/\s+/g, " ").slice(0, 500)}`);
          }
          let st = null;
          try { st = JSON.parse(mm[1]); } catch { st = null; }
          if (!st) return textResult(`自检回执不是合法 JSON：${mm[1].slice(0, 300)}`);
          const pass = Number(st.pass) || 0;
          const fail = Number(st.fail) || 0;
          const ls = [`节点自检：${pass} 过 / ${fail} 败`];
          for (const it of (st.items || [])) {
            ls.push(`  ${it.ok ? "✓" : "✗"} ${it.name}${it.extra ? "  — " + it.extra : ""}`);
          }
          return textResult(ls.join("\n"), { details: st });
        }

        // 把参数作为 JSON 字面量嵌进去。
        // 用 JSON.stringify 而不是手拼：参数里可能有引号、中文、负数。
        const payload = {
          recipe: args.recipe,
          name: args.name,
          group: args.group,
          object: args.object,
          mat: args.mat,
          color: args.color,
          size: args.size,
          density: args.density,
          height: args.height,
          width: args.width,
          tilt: args.tilt,
          clump_scale: args.clump_scale,
          count: args.count,
          offset: args.offset,
          strength: args.strength,
          scale: args.scale,
          roughness: args.roughness,
          contrast: args.contrast,
          bump: args.bump,
          metallic: args.metallic,
          seed: args.seed,
          prefix: args.prefix,
          clear: args.clear,
          // ！贴图相关的三个键。
          //   曾经只加了 Python 侧实现和参数 schema，**漏了这里的 payload**，
          //   结果 image 被默默丢掉、退回自动生成棋盘——
          //   而回执还写着“成功”，因为生成棋盘本身也是合法行为。
          //   参数要过三道：schema → payload → python，漏一道就静默失效。
          image: args.image,
          uv_scale: args.uv_scale,
          projection: args.projection,
        };
        for (const k of Object.keys(payload)) {
          if (payload[k] === undefined) delete payload[k];
        }

        const code = [
          pySrc,
          `_R = dispatch(${JSON.stringify(op)}, ${JSON.stringify(JSON.stringify(payload))})`,
          "print('DSH_NODES ' + _R)",
        ].join("\n");

        const rr = await relayFetch("/do", { code, timeoutMs: 60_000 }, 70_000);
        const out = String((rr && rr.result && rr.result.result) || "");
        const m = /DSH_NODES (\{[\s\S]*?\})\s*$/.exec(out.trim());
        if (!m) {
          // 没回执时把 stderr / 尾巴一并带出来 —— “未知错误” 比报错本身更费时间
          const tail = (rr && rr.result && (rr.result.error || rr.result.stderr)) || out.slice(-400) || "无回执";
          return textResult(`节点操作没有回执：${String(tail).replace(/\s+/g, " ").slice(0, 400)}`);
        }
        let res = null;
        try { res = JSON.parse(m[1]); } catch { res = null; }
        if (!res) return textResult(`回执不是合法 JSON：${m[1].slice(0, 300)}`);
        if (res.ok === false) return textResult(`节点操作失败：${res.error || "未知"}`);

        const lines = [`节点 · ${op}`];
        if (op === "recipes") {
          lines.push(`- 几何配方：${(res.geo || []).join("、")}`);
          lines.push(`- 材质配方：${(res.mat || []).join("、")}`);
        } else if (op === "list") {
          const g = res.geo || [];
          const s = res.shader || [];
          lines.push(`- 几何节点组 ${g.length} 个`);
          for (const x of g.slice(0, 12)) lines.push(`  · ${x.name}（${x.nodes} 节点，${x.users} 处引用）`);
          lines.push(`- 材质 ${s.length} 个`);
          for (const x of s.slice(0, 12)) lines.push(`  · ${x.name}（${x.nodes} 节点）`);
        } else if (op === "geo") {
          lines.push(`- 配方：${res.recipe}｜节点组：${res.group}（${res.nodes} 个节点）`);
          if (res.size != null) lines.push(`- 尺寸：${res.size}｜密度：${res.density}｜高度：${res.height ?? "-"}`);
          if (res.attach) {
            const a = res.attach;
            if (a.ok) lines.push(`- 已挂到 ${a.object}：${a.verts} 顶点 / ${a.polys} 面（这是节点树真算出来的）`);
            else lines.push(`- 挂载失败：${a.error || "未知"}`);
          }
        } else if (op === "mat") {
          lines.push(`- 配方：${res.recipe}｜材质：${res.material}（${res.nodes} 个节点）`);
          if (res.color) lines.push(`- 颜色：${res.color}｜粗糙度：${res.roughness ?? "-"}`);
          if (res.assigned_to) lines.push(`- 已赋给 ${res.assigned_to}`);
          if (res.assign_error) lines.push(`- 赋材质失败：${res.assign_error}`);
        } else if (op === "cleanup") {
          lines.push(`- 删了 ${res.count} 个：${(res.removed || []).join("、") || "无"}`);
        } else if (op === "attach") {
          lines.push(res.ok ? `- 已挂到 ${res.object}：${res.group}（${res.verts} 顶点 / ${res.polys} 面）` : `- 失败：${res.error}`);
        }
        if (lines.length === 1) lines.push(JSON.stringify(res).slice(0, 800));
        return textResult(lines.join("\n"), { details: res });
      }

      case "drive": {
        // 让已登记的关节真的动起来。
        //
        // 为何单独一个动作：motion 只有“量”（infer_axis / measure）和“导出”（urdf/usda），
        // **没有“驱动”**。它能告诉你炮塔该绕哪个轴转，却不能让它转一下。
        // 而“转一下”是最直接的验证：轴对不对、枢轴点对不对、带不带得动子物体，
        // 看一眼就知道。靠读 JSON 看不出来。
        const op = String(args.op || "status");
        const dPath = join(import.meta.dirname || ".", "runtime", "motion_drive.py");
        if (!existsSync(dPath)) return textResult(`驱动模块不在：${dPath}`);
        const dSrc = readFileSync(dPath, "utf8");

        const payload = {
          jid: args.jid || args.joint,
          angle: args.angle,
          unit: args.unit,
          pose: args.pose,
          axis: args.axis,
          anchor: args.anchor,
          include_descendants: args.include_descendants,
          start: args.start,
          end: args.end,
          steps: args.steps,
        };
        for (const k of Object.keys(payload)) {
          if (payload[k] === undefined) delete payload[k];
        }

        // 先确保 motion 装载了——它的 joints() 是驱动读关节库的唯一来源
        await relayFetch("/rt/plan", { op: "motion_status", args: {} }, 30_000).catch(() => null);

        const code = [
          dSrc,
          `_R = dispatch(${JSON.stringify(op)}, ${JSON.stringify(JSON.stringify(payload))})`,
          "print('DSH_DRIVE ' + _R)",
        ].join("\n");

        const rr = await relayFetch("/do", { code, timeoutMs: 90_000 }, 100_000);
        const out = String((rr && rr.result && rr.result.result) || "");
        const mm = /DSH_DRIVE (\{[\s\S]*?\})\s*$/.exec(out.trim());
        if (!mm) {
          const tail = (rr && rr.result && (rr.result.error || rr.result.stderr)) || out.slice(-400) || "无回执";
          return textResult(`驱动没有回执：${String(tail).replace(/\s+/g, " ").slice(0, 400)}`);
        }
        let res = null;
        try { res = JSON.parse(mm[1]); } catch { res = null; }
        if (!res) return textResult(`回执不是合法 JSON：${mm[1].slice(0, 300)}`);
        if (res.ok === false) return textResult(`驱动失败：${res.error || "未知"}`);

        const lines = [`关节驱动 · ${op}`];
        if (op === "status") {
          lines.push(`- 共有 ${res.joints} 个关节，${res.drivable} 个可驱动`);
          for (const it of (res.items || []).slice(0, 12)) {
            lines.push(`  · ${it.id}（${it.kind}）${it.can_drive ? "✅ 可驱动" : "⚠ 缺轴或枢轴点"}${it.verdict ? " " + it.verdict : ""}`);
          }
        } else if (op === "drive") {
          lines.push(`- ${res.joint}：转了 ${res.angle}${res.unit === "rad" ? " 弧度" : "°"}（${res.radians} rad）`);
          lines.push(`- 轴 [${(res.axis || []).join(", ")}]｜枢轴点 [${(res.anchor || []).join(", ")}]`);
          lines.push(`- 带动了 ${res.rotated_objects} 个对象：${(res.names_preview || []).join("、")}`);
          lines.push(`- 真的变形了：${res.moved ? "是" : "否（没动，检查轴与枢轴点）"}`);
          if (res.bbox_before && res.bbox_after) {
            lines.push(`- 包围盒：${res.bbox_before.size.join("×")} → ${res.bbox_after.size.join("×")}`);
          }
          if (res.restored) {
            lines.push(`- 已还原（${res.restored_objects} 个对象）${res.restore_exact ? "，位置精确回到原样" : "，⚠ 还原不完全"}`);
          } else {
            lines.push(`- 姿态已保留（pose=true）`);
          }
        } else if (op === "sweep") {
          lines.push(`- 扫 ${res.swept[0]}° → ${res.swept[1]}°，${res.steps} 步`);
          for (const s of (res.samples || [])) {
            // ！moved=false 在小角度/零角度下是**正常的**（没转就不该变）。
            //   曾经直接标“（未动）”，看着像 sweep 坏了。
            //   实际上真正要提示的是“零角度”这种预期内的情况。
            const atZero = Math.abs(Number(s.angle) || 0) < 1e-9;
            const tag = s.moved ? "" : (atZero ? "（0°，本来就不该动）" : "（⚠ 没动，检查轴）");
            lines.push(`  · ${s.angle}°：包围盒 ${(s.size || []).join("×")}${tag}`);
          }
        }
        return textResult(lines.join("\n"), { details: res });
      }

      case "wheel": {
        // 轮系驱动：轮子转 + 履带跟着走。
        //
        // 为何不归入 drive：drive 转的是“绕关节枢轴的那个子物体”，
        //   而履带根本不是转动——它是**沿一条环路径平移顶点**。用 drive 转履带只会把它转歪。
        //   且轮系要的是**多轴联动**：几个轮子同转速，履带按 r×θ 同步走。
        const op = String(args.op || "status");
        const wPath = join(import.meta.dirname || ".", "runtime", "motion_wheel.py");
        if (!existsSync(wPath)) return textResult(`轮系模块不在：${wPath}`);
        const wSrc = readFileSync(wPath, "utf8");

        const payload = {
          wheels: args.wheels,
          tracks: args.tracks,
          track: args.track,
          degrees: args.degrees,
          distance: args.distance,
          radius: args.radius,
          axis: args.axis,
          pose: args.pose,
          spin_sign: args.spin_sign,
        };
        for (const k of Object.keys(payload)) {
          if (payload[k] === undefined) delete payload[k];
        }

        const code = [
          wSrc,
          `_R = dispatch(${JSON.stringify(op)}, ${JSON.stringify(JSON.stringify(payload))})`,
          "print('DSH_WHEEL ' + _R)",
        ].join("\n");

        const rr = await relayFetch("/do", { code, timeoutMs: 90_000 }, 100_000);
        const out = String((rr && rr.result && rr.result.result) || "");
        const mm = /DSH_WHEEL (\{[\s\S]*?\})\s*$/.exec(out.trim());
        if (!mm) {
          const tail = (rr && rr.result && (rr.result.error || rr.result.stderr)) || out.slice(-400) || "无回执";
          return textResult(`轮系没有回执：${String(tail).replace(/\s+/g, " ").slice(0, 400)}`);
        }
        let res = null;
        try { res = JSON.parse(mm[1]); } catch { res = null; }
        if (!res) return textResult(`回执不是合法 JSON：${mm[1].slice(0, 300)}`);
        if (res.ok === false) return textResult(`轮系失败：${res.error || "未知"}`);

        const lines = [`轮系驱动 · ${op}`];
        if (op === "status") {
          const ws = res.wheels_guess || [];
          const ts = res.tracks_guess || [];
          // ！虎式有 54 个轮系对象，一行铺开根本读不了。按前缀归类后只报组数。
          const group = (list) => {
            const m = new Map();
            for (const n of list) {
              const k = n.replace(/[0-9]+/g, "#").replace(/#+/g, "#");
              m.set(k, (m.get(k) || 0) + 1);
            }
            return [...m.entries()].map(([k, c]) => (c > 1 ? `${k} ×${c}` : k));
          };
          lines.push(`- 轮系 ${ws.length} 个：${group(ws).join("、") || "无"}`);
          lines.push(`- 履带 ${ts.length} 个：${group(ts).join("、") || "无"}`);
          // ！挂在车身上当备品的履带不参与传动，得提醒一句。
          const spares = ts.filter((n) => /spare/i.test(n));
          if (spares.length) {
            lines.push(`  · ${spares.join("、")} 看着是**备品挂件**，不参与传动，别放进 tracks`);
          }
          lines.push(`（${res.note}）`);
        } else if (op === "spin") {
          lines.push(`- ${res.wheels} 个轮子转了 ${res.degrees}°`);
          lines.push(`- 轴 [${(res.axis || []).join(", ")}]`);
          lines.push(`- ${res.rotated_in_place ? "✅ 原地转（包围盒没变大）" : `⚠ 包围盒变了 ${res.bbox_grew}，轴可能选错`}`);
          if (res.restored) lines.push(`- 已还原`);
        } else if (op === "track_advance") {
          if (res.mode === "links") {
            lines.push(`- 逐节推进：${res.links} 节，走了 ${res.arc}（周长 ${res.perimeter}）`);
            lines.push(`- 节间距 ${res.spacing_min}～${res.spacing_max}${res.spacing_max / Math.max(res.spacing_min, 1e-9) < 1.3 ? "（均匀）" : "（⚠ 不均匀，链板可能会拉散）"}`);
          } else {
            lines.push(`- 整条带体推进 ${res.distance}（周期 ${res.period}）`);
          }
          lines.push(`- 动了 ${res.vertices_moved} 个顶点`);
          if (res.restored) lines.push(`- 已还原`);
        } else if (op === "roll") {
          lines.push(`- 转 ${res.degrees}°，${res.wheels} 个轮子 + ${res.tracks} 条履带`);
          lines.push(`- 半径 ${res.radius_used}，弧长 ${res.arc_distance}（r×θ）`);
          if (res.spin) {
            lines.push(`- 轮子：${res.spin.rotated_in_place ? "✅ 原地转" : "⚠ 轴可能不对"}`);
          }
          for (const t of (res.track_advance || [])) {
            lines.push(`- 履带 ${t.track}：${t.mode === "links" ? `逐节 ${t.links} 节` : "整条"}，动了 ${t.vertices_moved} 个顶点`);
          }
          if (res.restored) lines.push(`- 已还原（${res.restored_objects} 个对象 + 履带顶点）`);
        }
        return textResult(lines.join("\n"), { details: res });
      }

      case "rig": {
        // 骨架与蒙皮。
        //
        // 为何单独一个动作而不归入 drive：drive 动的是**已有父子关系的对象**，
        //   骨架动的是**骨骼**，而零件通过权重跟随骨骼。两层机制不一样。
        //   关键差别：drive 能带子孙，骨架靠**骨骼树**带；骨架没树就带不动。
        const op = String(args.op || "status");
        const gPath = join(import.meta.dirname || ".", "runtime", "motion_rig.py");
        if (!existsSync(gPath)) return textResult(`骨架模块不在：${gPath}`);
        const gSrc = readFileSync(gPath, "utf8");

        const payload = {
          // ！name 是全局参数（object/generator 用），别抢。rig 用 rig_name。
          name: args.rig_name || args.armature || "DSH_Rig",
          armature: args.armature,
          mode: args.mode,
          bind_mode: args.bind_mode,
          parts: args.parts,
          chains: args.chains,
          bone: args.bone,
          degrees: args.degrees,
          axis: args.axis,
          pose: args.pose,
          target: args.target,
          chain_length: args.chain_length,
          max_influences: args.max_influences,
          out: args.out,
          tracks: args.tracks,
        };
        for (const k of Object.keys(payload)) {
          if (payload[k] === undefined) delete payload[k];
        }

        const code = [
          gSrc,
          `_R = dispatch(${JSON.stringify(op)}, ${JSON.stringify(JSON.stringify(payload))})`,
          "print('DSH_RIG ' + _R)",
        ].join("\n");

        const rr = await relayFetch("/do", { code, timeoutMs: 120_000 }, 130_000);
        const out = String((rr && rr.result && rr.result.result) || "");
        const mm = /DSH_RIG (\{[\s\S]*?\})\s*$/.exec(out.trim());
        if (!mm) {
          const tail = (rr && rr.result && (rr.result.error || rr.result.stderr)) || out.slice(-400) || "无回执";
          return textResult(`骨架没有回执：${String(tail).replace(/\s+/g, " ").slice(0, 400)}`);
        }
        let res = null;
        try { res = JSON.parse(mm[1]); } catch { res = null; }
        if (!res) return textResult(`回执不是合法 JSON：${mm[1].slice(0, 300)}`);
        if (res.ok === false) return textResult(`骨架失败：${res.error || "未知"}`);

        const lines = [`骨架 · ${op}`];
        if (op === "status") {
          if (!res.armature_count) {
            lines.push(`- 还没有骨架（场景里 ${res.mesh_count} 个网格）`);
            lines.push(`- 用 op=build 建一个`);
          } else {
            for (const a of res.armatures) {
              lines.push(`- ${a.armature}：${a.bones} 根骨，${a.bound_meshes} 个网格绑上了，${a.ik_constraints} 个 IK`);
              if (!a.bound_meshes) lines.push(`  · ⚠ 一个都没绑上，用 op=bind`);
            }
          }
        } else if (op === "build") {
          const h = res.hierarchy || {};
          lines.push(`- 建了 ${res.bones} 根骨（${res.mode} 模式）`);
          lines.push(`- 骨骼树：${h.linked} 条父子关系，${h.roots} 根根骨`);
          if (h.roots > res.bones * 0.5) {
            lines.push(`  · ⚠ 根骨太多，零件之间可能没接上，转一根只会动它自己`);
          }
          lines.push(`- 尺寸 ${(res.bbox_size || []).join(" × ")}`);
        } else if (op === "bind") {
          lines.push(`- ${res.bound} 个绑定成功，${res.failed} 个失败（共 ${res.total_objects}）`);
          lines.push(`- 模式：${res.mode === "rigid" ? "rigid（每零件恒 1.0，机械体）" : "skin（多骨渐变，有机体）"}`);
          if (res.failed) {
            for (const o of (res.objects || []).filter(o => !o.ok).slice(0, 5)) {
              lines.push(`  · ❌ ${o.obj}：${o.error}`);
            }
          }
        } else if (op === "pose") {
          lines.push(`- ${res.bone} 转了 ${res.degrees}°（轴 ${(res.axis || []).join(",")}）`);
          lines.push(`- 带动了 ${res.meshes_moved}/${res.meshes_checked} 个网格，最大位移 ${res.max_displacement}`);
          if (!res.meshes_moved) lines.push(`  · ⚠ 一个都没动，绑定可能没生效`);
          lines.push(`- ${res.restored ? "已还原" : "姿态已保留（pose=true）"}`);
        } else if (op === "ik") {
          lines.push(`- ${res.bone} 挂了 IK，链长 ${res.chain_count}`);
          lines.push(`- 目标：${res.target}（在 Blender 里拖它就能驱动）`);
        } else if (op === "export") {
          const dg = res.diagnostics || {};
          lines.push(`- 导出 ${res.joints_count} 个关节、${(res.tracks || []).length} 条履带`);
          lines.push(`- 车体尺寸 ${((res.bbox || {}).size || []).join(" × ")}`);
          const sh = dg.axis_shapes || {};
          lines.push(`- 转轴推断：盘状 ${sh.disc || 0}、杆状 ${sh.rod || 0}、块状 ${sh.block || 0}`);
          const dh = dg.drive_hints || {};
          if (Object.keys(dh).length) {
            lines.push(`- 驱动建议：可动 ${dh.likely || 0}、存疑 ${dh.maybe || 0}、固定 ${dh.static || 0}`);
            if ((dh.static || 0) > 0) {
              lines.push(`  · “固定”是**建议**不是事实（翼子板/排气管/备用件）——几何看不出设计意图，需人工确认`);
            }
          }
          if (dg.assemblies_count) {
            lines.push(`- 装配层：${dg.assemblies_count} 个悬挂组，吸收了 ${dg.absorbed_joints} 个零件关节`);
            lines.push(`  · 独立旋钮：${dg.knobs_count} 个零件关节 + ${dg.assemblies_count} 个装配组 = ${(dg.knobs_count || 0) + (dg.assemblies_count || 0)} 个控制点`);
            if ((dg.knobs || []).length) {
              lines.push(`  · 零件关节：${(dg.knobs || []).join("、")}`);
            }
            for (const a of (res.assemblies_preview || []).slice(0, 4)) {
              lines.push(`    - ${a.id}：${a.member_count} 件，y [${a.y_span.join(", ")}]`);
            }
            if ((res.assemblies_preview || []).length > 4) {
              lines.push(`    - …共 ${dg.assemblies_count} 组`);
            }
          }
          if (dg.skipped_tracks_count) {
            lines.push(`- 履带单独归入 tracks，不进 joints：${(dg.skipped_tracks || []).join("、")}`);
          }
          if (dg.root_bones && dg.root_bones.length) {
            lines.push(`- 根骨固定（不参与转动）：${dg.root_bones.join("、")}`);
          }
          if (dg.child_bigger_count) {
            lines.push(`  · ⚠ ${dg.child_bigger_count} 根骨的包围盒比父骨还大，几何包含关系可能搞反了`);
            for (const x of (dg.child_bigger_than_parent || []).slice(0, 5)) {
              lines.push(`    - ${x.child} 比 ${x.parent} 大 ${x.vol_ratio}×`);
            }
          }
          if (res.path) lines.push(`- 已写：${res.path}`);
          else lines.push(`- ⚠ 没写文件（没给 out）`);
          if ((res.tracks || []).length) {
            for (const t of res.tracks) {
              lines.push(`  · ${t.name}：${t.links} 节，周长 ${t.perimeter}`);
            }
          }
        }
        return textResult(lines.join("\n"), { details: res });
      }

      case "perf": {
        const op = String(args.op || "status");
        const r = await relayFetch("/rt/perf", { op, args: args.args || {} }, 300_000);
        const res = r.result || {};
        const lines = [`渲染性能 · ${op}`];
        if (res.engine) lines.push(`- 引擎：${res.engine}`);
        if (res.analysis) lines.push(`- 分析：${JSON.stringify(res.analysis).slice(0, 400)}`);
        if (res.applied) lines.push(`- 已应用预设：${JSON.stringify(res.applied).slice(0, 300)}`);
        if (res.device) lines.push(`- 设备：${JSON.stringify(res.device).slice(0, 200)}`);
        if (lines.length === 1) lines.push(JSON.stringify(res).slice(0, 900));
        return textResult(lines.join("\n"), { details: res });
      }

      case "generator": {
        const op = String(args.op || "list");
        // 平铺传参：顶层常用键直接透传（generator_dispatch 会展开成 kwargs）
        // ！"params" **不在**这个名单里：它不是 generator_run 的 kwarg。
        //   早先把它也透传了，于是 payload 顶层多出一个 params，
        //   dispatch 拿它当 kwargs 直传 → 报
        //   "generator_run() got an unexpected keyword argument 'params'"。
        //   它必须走下面那段、被放到 payload.args 里去。
        const payload = { ...(args.args || {}) };
        for (const k of ["name", "code", "note", "dir", "overwrite", "expect", "engine", "use_cache", "timeout_ms", "factory_startup"]) {
          if (args[k] !== undefined && payload[k] === undefined) payload[k] = args[k];
        }
        // ── 把扁平 params 放到签名要的位置 ────────────────────────────
        //
        // 这一段反复栽过。下面不是推导，是**实跑回执**定下来的形状：
        //
        //   ① 工具代码：payload = {...args.args}，然后把 payload 交给 relay。
        //   ② relay 把它当 args 发给 generator_dispatch。
        //   ③ dispatch：for k,v in payload.items():
        //          if k == "args" and isinstance(v, dict): kw.update(v)
        //          else: kw[k] = v
        //      也就是 **payload.args 的值会被展开成 kwargs**。
        //   ④ generator_run(name, args=None, ...)
        //
        //   实测回执：
        //     payload.args = {args:{petals}}  → 展开 → kw={args:{petals}}
        //        → generator_run(args={petals})        ✓ PARAMS={petals}
        //     payload.args = {args:{args:{petals}}}
        //        → generator_run(args={args:{petals}}) ✗ PARAMS={args:{petals}}
        //          脚本读 PARAMS["petals"] 拿不到，静默用默认值
        //
        //   所以：**只包一层 args**。
        //   （曾经把 params 也平铺到 payload 顶层，导致顶层冒出 petals，
        //     报 "unexpected keyword 'petals'" —— 那是另一个 bug，已一并修。）
        //
        //   这个形状不该让人记。工具面接受扁平的 params，在这里包好。
        if (op === "run" || op === "save") {
          const flatParams = args.params;
          if (flatParams && typeof flatParams === "object" && !Array.isArray(flatParams)) {
            const prev = payload.args;
            const isObj = prev && typeof prev === "object" && !Array.isArray(prev);
            // 合并而不是覆盖：手写 args.args 的老用法仍然有效
            const deep = (isObj && prev.args && typeof prev.args === "object" && !Array.isArray(prev.args))
              ? prev.args : {};
            payload.args = {
              ...(isObj ? prev : {}),
              args: { ...deep, ...flatParams },
            };
          }
        }
        const r = await relayFetch("/rt/plan", { op: "generator_" + op, args: payload }, 600_000);
        const res = r.result || {};
        if (res.ok === false && res.error) return textResult(`生成器 ${op} 失败：${res.error}`);
        if (op === "run") {
          const lines = [
            res.verdict === "supported" ? `✅ 编译门通过（verdict=${res.verdict}）` : `⚠ verdict=${res.verdict}`,
            `- 回执：${JSON.stringify(res.receipt || res.actual || {}).slice(0, 300)}`,
          ];
          if (res.mode) lines.push(`- 模式：${res.mode}`);
          if (res.cached) lines.push(`- 命中缓存（源码未变）`);
          if (res.reason || res.why) lines.push(`- 说明：${String(res.reason || res.why).slice(0, 200)}`);
          if (res.outdir) lines.push(`- 产物：${res.outdir}`);
          return textResult(lines.join("\n"), { details: res });
        }
        if (op === "list") {
          const gens = res.generators || [];
          const lines = [`生成器注册表（${res.count ?? gens.length}）`, `- 根目录：${res.root || "-"}`];
          for (const g of gens.slice(0, 20)) lines.push(`  · ${g.name}${g.stale ? " ⚠ 源码已变（回执过期）" : ""}${g.note ? " — " + String(g.note).slice(0, 40) : ""}`);
          return textResult(lines.join("\n"), { details: res });
        }
        return textResult(JSON.stringify(res).slice(0, 2500), { details: res });
      }

      case "motion": {
        const op = String(args.op || "status");
        const payload = { ...(args.args || {}) };
        for (const k of ["jid", "parent", "child", "kind", "axis", "anchor", "limits", "note", "dir", "name", "joints", "meters_per_unit", "phases", "sweep_deg", "objects", "sample_cap"]) {
          if (args[k] !== undefined && payload[k] === undefined) payload[k] = args[k];
        }
        const r = await relayFetch("/rt/plan", { op: "motion_" + op, args: payload }, 600_000);
        const res = r.result || {};
        if (res.ok === false && res.error) return textResult(`机构 ${op} 失败：${res.error}`);
        if (op === "measure") {
          const icon = res.verdict === "supported" ? "✅" : res.verdict === "refuted" ? "❌" : "⚠";
          const lines = [
            `${icon} 扫掠验证：verdict=**${res.verdict}**`,
            `- 位移：${res.moved ? "有" : "无"}（${res.max_displacement_m ?? "?"} m）｜相位：${res.phases?.length ?? res.sweep?.phases ?? "?"}`,
            `- 场景还原：${res.restored?.ok ? "✅ 完整" : "⚠ 有残留"}（max_delta=${res.restored?.max_delta ?? "?"}）`,
          ];
          if (res.reason) lines.push(`- 判据：${String(res.reason).slice(0, 240)}`);
          return textResult(lines.join("\n"), { details: res });
        }
        if (op === "joints" || op === "status") {
          const js = res.joints;
          const list = Array.isArray(js) ? js : Object.values(js || {});
          const lines = [`已登记关节（${list.length}）`];
          for (const j of list.slice(0, 15)) {
            lines.push(`  · ${j.id}｜${j.kind}｜parent=${(j.parent || []).join("+")} child=${(j.child || []).join("+")}${j.axis ? " axis=" + JSON.stringify(j.axis.map((v) => Math.round(v * 1000) / 1000)) : ""}`);
          }
          if (res.units) lines.push(`- 单位：${res.units.length}`);
          return textResult(lines.join("\n"), { details: res });
        }
        return textResult(JSON.stringify(res).slice(0, 2500), { details: res });
      }

      case "preset": {
        const op = String(args.op || "list");
        const payload = { ...(args.args || {}) };
        for (const k of ["name", "data", "kind", "tags", "note", "targets", "dry_run", "names", "path", "overwrite"]) {
          if (args[k] !== undefined && payload[k] === undefined) payload[k] = args[k];
        }
        const r = await relayFetch("/rt/preset", { op, args: payload }, 120_000);
        const res = r.result || {};
        if (res.ok === false && res.error) return textResult(`配方 ${op} 失败：${res.error}`);
        if (op === "list") {
          const list = res.presets || [];
          const lines = [`配方库（${res.count ?? list.length}）`, `- 目录：${res.dir || "-"}`];
          for (const p of list.slice(0, 20)) lines.push(`  · ${p.name}${p.kind ? " [" + p.kind + "]" : ""}${p.note ? " — " + String(p.note).slice(0, 40) : ""}`);
          return textResult(lines.join("\n"), { details: res });
        }
        return textResult(JSON.stringify(res).slice(0, 2000), { details: res });
      }

      case "service": {
        const op = String(args.op || "status");
        if (op === "start") {
          const r = await relayFetch("/service/start", { path: args.path }, 30_000);
          if (!r.ok) return textResult(`启动 Blender 失败：${r.error}${r.tried ? `\n尝试过的路径：${JSON.stringify(r.tried)}` : ""}`);
          if (r.already) return textResult(`Blender 已在运行（${r.addon}${r.reachable ? "，addon 已应答" : "，但 addon 尚未应答"}）。`);
          return textResult(
            `已请求拉起 Blender（计划任务，独立于 Hana 存活）。\n` +
            `- blender.exe：${r.blenderExe}\n` +
            `- 启动器：${r.launcher}${r.hidden ? "（隐藏窗口）" : ""}\n` +
            `- 日志：${r.logFile}\n` +
            `首次启动约 10~30 秒（含 addon 自启动），随后用 doctor 确认。`,
          );
        }
        if (op === "stop") {
          const r = await relayFetch("/service/stop", {}, 30_000);
          if (!r.ok) {
            return textResult(`停止未完全成功：${JSON.stringify({ pids: r.pids, stopped: r.stopped, failed: r.failed, alive: r.alive })}`);
          }
          return textResult(r.already ? "Blender 未在运行。" : `已撤下 Blender 服务（终止 PID：${JSON.stringify(r.stopped)}）。`);
        }
        const r = await relayFetch("/service/status", {}, 15_000);
        const lines = [
          `Blender 服务状态`,
          `- 端口 ${state.config.addonPort} 监听：${r.listening ? `是（PID ${JSON.stringify(r.pids)}）` : "否"}`,
          `- addon 可应答：${r.reachable ? "是" : "否"}`,
          `- blender.exe：${r.blenderExe || "（未探测到）"}`,
          r.launcher ? `- 启动器：${r.launcher}` : "",
          r.logFile ? `- 日志：${r.logFile}` : "",
          r.startedAt ? `- 本次由 App 拉起于：${r.startedAt}` : "",
          r.lastError ? `- 最近错误：${r.lastError}` : "",
        ].filter(Boolean);
        return textResult(lines.join("\n"), { details: { service: r } });
      }

      case "connect": {
        // 先探活，别一上来就重启。
        //
        // 之前这里是 ensureStarted({force:true})，后果很重：
        // 工具面调用带着 callToken，而宿主的 local-machine profile 明确拒收它：
        //   “Local-machine execution does not accept readRoots, writeRoots, callToken, or taskId scope inputs.”
        // 于是本来活着的中继被停掉、新的一直起不来 —— 一次“连一下”变成“弄死它”。
        // （日志里的分水岭很清楚：19:39:08 App 启动时就绪，19:40:37 工具面调用后全部失败。）
        let alive = false;
        if (state.phase === "ready" && state.runtimeId) {
          try {
            const h = await relayFetch("/health", {}, 4000);
            alive = !!(h && h.ok);
          } catch { alive = false; }
        }
        if (alive) {
          return textResult(`中继已在跑（端口 ${state.servicePort}，addon ${state.config.addonHost}:${state.config.addonPort}），没有重启。`);
        }

        const inToolCall = !!(args && args.context && args.context.callToken);
        if (inToolCall) {
          // 不自作主张：这一路重启不了，而且会把它弄坏。说清楚，别静默失败。
          return textResult(
            "中继没在跑，但**在工具调用里重启不了**。\n" +
            "原因：工具调用带 callToken，而宿主的 local-machine 运行时不接受它（宿主会直接拒）。\n" +
            "怎么做：在 Blender 助手的应用页（侧栏面板）里点「重启中继」，那里不带工具上下文，能正常拉起。",
          );
        }

        await ensureStarted({ force: true });
        if (state.phase !== "ready") {
          return textResult(`启动失败：${state.lastError?.userText || "未知原因"}`);
        }
        return textResult(`中继已就绪（端口 ${state.servicePort}，addon ${state.config.addonHost}:${state.config.addonPort}）。`);
      }

      // ── 派活 ───────────────────────────────────────────────────────────────
      // 和卡片上那个「派给助手」按钮共用 dispatchWork 一个实现。
      // 为什么在工具面也要有：从对话里派活时，人不需要先去开一张卡。
      case "dispatch": {
        const r = await dispatchWork({
          brief: args.brief,
          agentId: args.agent,
          modelId: args.model,
          provider: args.provider,
          runId: args.runId,
        });
        const lines = [
          `已派给 ${r.agentId}`,
          `- 会话：${r.sessionId}${r.createdSession ? "（新建）" : "（复用已有的）"}`,
          r.modelId
            ? `- 模型：${r.modelId}（${r.provider}）— ${r.modelSwitched === true ? "已换" : "**没换成**：" + (r.modelError || "原因未知")}`
            : "- 模型：没指定，用那个助手本来的",
        ];
        if (r.listError) lines.push(`- 注：没能读到已有会话（${r.listError}），所以新建了一个`);
        return textResult(lines.join("\n"), { details: r });
      }

      // 派活的选项面：能发给谁、能选哪些模型。
      // 没有它就只能猜名字——而猜是今天已经错了四次的那件事。
      case "models": {
        const op = String(args.op || "agents");
        if (typeof sdk.bus?.request !== "function") return textResult("宿主未提供 bus。");
        if (op === "agents") {
          const al = await sdk.bus.request("agent:list", { scope: "all" }, { timeoutMs: 8000 });
          const list = (al && (al.agents || al.list)) || [];
          if (!list.length) return textResult("没拿到助手列表。");
          const rows = list.map((a) => {
            const id = String(a.id || a.agentId || "");
            const nm = String(a.name || a.label || id);
            const st = a.state || (a.retired ? "retired" : "active");
            return `- ${nm}（${id}）${st !== "active" ? ` [${st}]` : ""}`;
          });
          return textResult([`可发给（${list.length} 个）：`, ...rows,
            "", "用法：dispatch brief=\"要做什么\" agent=<上面括号里的 id>"].join("\n"));
        }
        const mr = await sdk.bus.request("model:list", undefined, { timeoutMs: 8000 });
        const raw = (mr && mr.models) || [];
        if (!raw.length) return textResult("没拿到模型列表。");
        const rows = raw.map((m) => {
          const id = String(m.id || m.modelId || "");
          const nm = String(m.name || m.label || id);
          const pv = String(m.provider || m.providerId || "");
          return `- ${nm}｜id=${id}｜provider=${pv || "⚠ 空"}${m.isCurrent ? " ← 当前" : ""}`;
        });
        return textResult([`可选模型（${raw.length} 个）：`, ...rows,
          "", "用法：dispatch brief=\"...\" agent=<id> model=<上面的 id> provider=<同一个 provider>"].join("\n"));
      }

      // ── 归档 ───────────────────────────────────────────────────────────────
      // 产物散在 work/ 里不好回溯；run 目录给它一个户口，也让「采用/回退」有落点。
      case "runs": {
        const op = String(args.op || "list");

        if (op === "begin") {
          if (!state.runs) return textResult("归档器未就绪。");
          // meta.script：这一版是哪个生成器跑出来的。
          //
          // 为何必须现在就能写：无头重建出图靠它——有它才能"把这一版重跑一遍"。
          // 而之前**没有任何代码写这个字段**：tiger 那版的 meta.script 是我
          // 手工填进 run.json 的。也就是说那项能力靠的是巧合，不是功能。
          // 从今以后由 begin 负责带上。
          const run = state.runs.begin({
            label: args.label, action: args.actionName || "run",
            meta: {
              by: "agent",
              note: args.note || null,
              parent: args.baseRun || null,
              script: args.script ? String(args.script) : null,
            },
          });
          return textResult(
            `run 已开：${run.id}\n- 目录：${run.dir}` +
            (run.meta && run.meta.script ? `\n- 来源脚本：${run.meta.script}（拍视图时会无头重跑它）` : "") +
            `\n- 后续把产物收进来：runs op=put id=${run.id} ...`,
            { details: { id: run.id, dir: run.dir, script: run.meta?.script || null } },
          );
        }

        if (op === "put") {
          if (!state.runs) return textResult("归档器未就绪。");
          if (!args.id) throw new Error("action=runs op=put 需要 id（先用 op=begin 或 op=list 拿）");
          const run = state.runs.get(args.id);
          if (!run) return textResult(`没找到 run：${args.id}`);
          const srcs = Array.isArray(args.files) ? args.files : (args.file ? [args.file] : []);
          if (!srcs.length) throw new Error("action=runs op=put 需要 file 或 files");
          const done = [];
          let i = 0;
          for (const f of srcs) {
            const rel = state.runs.put(run, {
              from: f, kind: args.kind || "view",
              name: args.name ? (srcs.length > 1 ? `${args.name}-${i + 1}` : args.name) : null,
              note: args.note || null,
            });
            if (rel) done.push(rel);
            i++;
          }
          return textResult(done.length ? `已收进 ${run.id}：\n${done.map((d) => "- " + d).join("\n")}` : "没有产物被收进来（源路径可能不存在）。");
        }

        if (op === "finish") {
          if (!state.runs) return textResult("归档器未就绪。");
          const run = state.runs.get(args.id);
          if (!run) return textResult(`没找到 run：${args.id}`);
          if (args.notes) state.runs.writeNotes(run, args.notes);
          const json = state.runs.finish(run, { summary: args.summary || null });
          const lines = [
            `run 已收口：${run.id}（${json.bytes} bytes）`,
            `- ${run.dir}`,
          ];
          // 收口时顺手拍一组视图。
          //
          // 为什么挂在这里：一次迭代 = 一组视图。
          // 触发点是“这一版做完了”，不是“场景变了”——
          // 否则改十次就拍十组，视图反而变成噪声。
          // 想要就带 views:true；不要就不拍（默认不拍，免得意外改用户视口）。
          if (args.views) {
            const got = await captureViewSet(run.id, args.viewAngles);
            if (got.error) lines.push(`- 拍视图失败：${got.error}`);
            else if (got.length) lines.push(`- 已拍视图：${got.join("、")}`);
            else lines.push("- 视图：一张都没拍成（看日志）");
          } else {
            lines.push(`- 拍一组视图：runs op=views id=${run.id}（或 finish 时带 views:true）`);
          }
          // 存一份几何。默认就做——它与 views 不同：不碰视口、不缺时间。
          //
          // 为何默认开：run 目录从前只存图，于是“切换产出”看到的只是照片，
          //   而且照片会串——视图拍的是**此刻场景**，不是那一版的东西。
          //   实测：在 tiger 那版点拍摄，得到的四张图与花那版**逐字节相同**。
          //   有了 GLB，每一版才真正自洽：它自己带几何。
          // 不想存就 model:false。
          if (args.model !== false) {
            const mm = await captureModel(run.id);
            if (mm && mm.ok) lines.push(`- 已存模型：${mm.rel}（${mm.meshes} 个网格，${mm.bytes} bytes）`);
            else if (mm && mm.error) lines.push(`- 模型：没存成（${mm.error}）`);
          } else {
            lines.push(`- 存模型：runs op=model id=${run.id}`);
          }
          // 再存一份**完整场景**（.blend）。它与 GLB 不是二选一：
          //   GLB     — 能看、能拿去别的软件用；但丢了修改器/骨骼/程序化节点
          //   .blend  — 能真正回退到这一版
          // 只存 GLB 就说“每一版可重建”是过了——那是两种不同的东西。
          // 默认存。不想存就 scene:false。
          if (args.scene !== false) {
            const bd = await captureSceneBlend(state.config.workDir, `_scene_${Date.now().toString(36)}`);
            if (bd && bd.ok) {
              // 写临时目录再入库：直接在 run.dir 里写再拷进 run.dir/scene/ 是绕路，
              // 而且中途会短暂出现两个同名文件。
              const rel2 = state.runs.put(run, { from: bd.file, kind: "scene", name: "scene", note: "blend", overwrite: true });
              try { rmSync(bd.file, { force: true }); } catch { /* 拷进去了，原件删不掉就算了 */ }
              lines.push(rel2
                ? `- 已存完整场景：${rel2}（${bd.objects} 个物体，${bd.bytes} bytes）`
                : `- 完整场景：归档失败`);
              if (bd.sessionTouched) lines.push(`  ⚠ 存快照时动了当前会话（不应发生）——请报告`);
            } else if (bd && bd.error) lines.push(`- 完整场景：没存成（${bd.error}）`);
          } else {
            lines.push(`- 存完整场景：runs op=scene id=${run.id}`);
          }
          lines.push(`- 标记为基线：runs op=tag id=${run.id} tag=baseline`);
          return textResult(lines.join("\n"), { details: json });
        }

        // 存一份几何。可以单独调，不用等收口。
        if (op === "model") {
          if (!state.runs) return textResult("归档器未就绪。");
          const run = state.runs.get(args.id);
          if (!run) return textResult(`没找到 run：${args.id}`);
          const mm = await captureModel(run.id);
          if (!mm || !mm.ok) return textResult(`存模型失败：${(mm && mm.error) || "未知"}`);
          return textResult(`已存模型：${mm.rel}\n- ${mm.meshes} 个网格，${mm.bytes} bytes`,
            { details: { runId: run.id, ...mm } });
        }

        // 存一份完整场景（.blend）。可以单独调，不用等收口。
        if (op === "scene") {
          if (!state.runs) return textResult("归档器未就绪。");
          const run = state.runs.get(args.id);
          if (!run) return textResult(`没找到 run：${args.id}`);
          const bd = await captureSceneBlend(state.config.workDir, `_scene_${Date.now().toString(36)}`);
          if (!bd || !bd.ok) return textResult(`存完整场景失败：${(bd && bd.error) || "未知"}`);
          const rel = state.runs.put(run, { from: bd.file, kind: "scene", name: "scene", note: "blend", overwrite: true });
          try { rmSync(bd.file, { force: true }); } catch { /* 忽略 */ }
          if (!rel) return textResult("归档失败（快照存下了，但没入库）");
          return textResult(`已存完整场景：${rel}\n- ${bd.objects} 个物体，${bd.bytes} bytes\n- 它比 GLB 多的是：修改器栈 / 骨骼 / 驱动 / 程序化节点——**能真正回退到这一版**`,
            { details: { runId: run.id, ...bd } });
        }

        // 把**当前场景**存一份快照（不写进任何 run）。
        // 用在“即将改动用户的场景”之前——手工打点用的。
        if (op === "snapshot") {
          const why = String(args.note || args.summary || "manual").replace(/[^\w.\u4e00-\u9fa5-]+/g, "_").slice(0, 30);
          const r = await snapshotBeforeChange(why);
          if (!r || !r.ok) return textResult(`存快照失败：${(r && r.error) || "未知"}`);
          return textResult(`已存快照：${r.file}\n- ${r.objects} 个物体，${r.bytes} bytes`,
            { details: { path: r.file, ...r } });
        }

        // 把一个 .blend 装回场景。
        //
        // ！默认先自动存一份“当前场景”的快照再装。
        //   这是“装”从破坏性变成可逆的关键：无论装进什么，都能退回装之前。
        //   要跳过就 snapshot:false（不建议——除非你确实不要手上的活）。
        if (op === "restore") {
          const src = String(args.file || args.path || "");
          if (!src) return textResult("要装哪个文件？file=<.blend 绝对路径>（或 id=<run> 装它自己的 scene.blend）");
          let target = src;
          // 也允许 id=<run>：装那一版自己的完整场景
          if (!src && args.id) target = "";
          if (args.id && state.runs) {
            const run = state.runs.get(args.id);
            if (!run) return textResult(`没找到 run：${args.id}`);
            const rec = ((run.files || {}).scene || [])[0];
            if (!rec) return textResult(`这一版没有存完整场景（runs op=scene 补一个）。`);
            target = join(state.runs.root, run.id, rec.rel);
          }
          if (!existsSync(target)) return textResult(`文件不存在：${target}`);
          let snap = null;
          if (args.snapshot !== false) {
            snap = await snapshotBeforeChange("before_restore");
            if (!snap || !snap.ok) {
              return textResult(`装之前没存成快照（${(snap && snap.error) || "未知"}）——已停下。\n`
                + `手上的活没被碰。要硬装就带 snapshot:false。`);
            }
          }
          const outWin = JSON.stringify(target.replace(/\\/g, "/"));
          const rr = await relayFetch("/do", {
            code: [
              "import bpy",
              `bpy.ops.wm.open_mainfile(filepath=${outWin})`,
              "print('DSH_RESTORE_OK', len(bpy.context.scene.objects))",
            ].join("\n"),
            timeoutMs: 120_000,
          }, 150_000);
          const out = String((rr && rr.result && rr.result.result) || "");
          const mm = /DSH_RESTORE_OK (\d+)/.exec(out);
          if (!mm) return textResult(`装入没有回执：${out.slice(0, 180)}`);
          const lines2 = [`已装入：${target}`, `- 当前场景 ${mm[1]} 个物体`];
          if (snap && snap.ok) lines2.push(`- 装之前已存快照：${snap.file}（想回去就用 runs op=restore file=...）`);
          return textResult(lines2.join("\n"), { details: { loaded: target, objects: Number(mm[1]), snapshot: snap } });
        }

        // 列已有快照。
        if (op === "snapshots") {
          const d = snapshotDir();
          let names = [];
          try { names = readdirSync(d).filter((f) => f.endsWith(".blend")).sort().reverse(); } catch { names = []; }
          if (!names.length) return textResult("还没有快照。");
          const rows = names.slice(0, 30).map((n) => {
            let sz = 0;
            try { sz = statSync(join(d, n)).size; } catch { /* 忽略 */ }
            return `  · ${n}（${Math.round(sz / 1024)} KB）`;
          });
          return textResult([`快照 ${names.length} 个：`, ...rows, "", "装入：runs op=restore file=<完整路径>"].join("\n"),
            { details: { dir: d, names } });
        }

        // 拍一组视图。这是“一次迭代一组视图”的那个动作。
        if (op === "views") {
          if (!state.runs) return textResult("归档器未就绪。");
          const run = state.runs.get(args.id);
          if (!run) return textResult(`没找到 run：${args.id}`);
          const got = await captureViewSet(run.id, args.viewAngles, args.noCache === true);
          const views = ((state.runs.get(run.id) || {}).files || {}).view || [];
          const lines = got.error
            ? [`拍视图失败：${got.error}`,
               `（这一版有来源脚本，所以走无头重建——它跟此刻场景无关，也不会碰你的 Blender。`,
               `拿不到脚本或渲染失败时**不会**退回拍视口：拍的是“此刻”，不是这一版。）`]
            : got.length
              ? [`已拍 ${got.length} 个方位：${got.join("、")}`]
              : ["一张都没拍成。检查：中继是否在跑、Blender 是否开着。"];
          if (views.length) lines.push(`- 这一版现有 ${views.length} 张视图：${views.map((f) => f.rel.replace(/^views\//, "")).join("、")}`);
          return textResult(lines.join("\n"), { details: { runId: run.id, angles: got, error: got.error || null } });
        }

        if (op === "tag") {
          if (!state.runs) return textResult("归档器未就绪。");
          // ！这里踩过：原先写的是 args.tag || TAG_BASELINE。
          //   而 null 是 falsy，于是「取消标记」会被 || 吃掉、又标回 baseline——
          //   工具面根本**没法取消标记**，人只能看到它反复说“已标为 baseline”。
          //   UI 那条路由（/runs/tag）一直是对的，两边行为不一致。
          //   现在两边同款：显式 null/"" 才算取消，否则才用默认值。
          const tag = (args.tag === null || args.tag === "") ? null : (args.tag || TAG_BASELINE);
          const j = state.runs.tag(args.id, tag);
          if (!j) return textResult(`没找到 run：${args.id}`);
          return tag
            ? textResult(`已将 ${j.id} 标记为「${j.tag}」（带标记的不会被自动清理）。`, { details: j })
            : textResult(`已取消 ${j.id} 的标记。`, { details: j });
        }

        if (op === "feedback") {
          if (!state.runs) return textResult("归档器未就绪。");
          const run = state.runs.get(args.id);
          if (!run) return textResult(`没找到 run：${args.id}`);
          // 不传 note 就是读；传了就是写一条
          if (args.note) {
            const line = state.runs.feedback(run, args.note);
            return line ? textResult(`已记下意见：${line}`, { details: { id: run.id } })
              : textResult("意见是空的。");
          }
          const fb = state.runs.readFeedback(run);
          return fb ? textResult(`run ${run.id} 的意见：\n${fb}`)
            : textResult(`run ${run.id} 还没有意见。`);
        }

        if (op === "get") {
          if (!state.runs) return textResult("归档器未就绪。");
          const run = state.runs.get(args.id);
          return run ? textResult(JSON.stringify(run, null, 2), { details: run })
            : textResult(`没找到 run：${args.id}`);
        }

        if (op === "prune") {
          if (!state.runs) return textResult("归档器未就绪。");
          const r = state.runs.prune({ keep: Number(args.keep) || DEFAULT_KEEP, dryRun: !!args.dryRun });
          const head = args.dryRun ? `将要清理 ${r.removed.length} 个（dry-run，未动磁盘）` : `已清理 ${r.removed.length} 个`;
          return textResult([head, `- 现有 ${r.total} 个（其中 ${r.tagged} 个带标记）`, r.removed.length ? "- " + r.removed.join("\n- ") : ""].filter(Boolean).join("\n"), { details: r });
        }

        // list（默认）
        if (!state.runs) return textResult("归档器未就绪。");
        const list = state.runs.list({ limit: Number(args.limit) || 20 });
        if (!list.length) return textResult("还没有任何 run。第一次产出时会自动建。");
        const lines = [`run 列表（${list.length}）`];
        for (const r of list) {
          lines.push(`  ${r.tag ? "★" : " "} ${r.id}｜${r.action}${r.summary ? "｜" + String(r.summary).slice(0, 40) : ""}`);
        }
        return textResult(lines.join("\n"), { details: { count: list.length } });
      }

      case "status": {
        const s = await fullStatus();
        return textResult(JSON.stringify(s, null, 2), { details: { status: s } });
      }

      case "see": {
        const r = await relayFetch("/see", {
          maxSize: Number(args.maxSize || 900),
          file: args.file,
          timeoutMs: timeoutMs || 30_000,
        }, 30_000);
        if (!r.ok) return textResult(`取景失败：${r.error}`);
        const content = [{ type: "text", text: `视口截图已就绪（${r.bytes || 0} bytes）：${r.file}` }];
        if (r.image) content.push({ type: "image", data: r.image, mimeType: r.mimeType || "image/png" });
        if (r.imageTooBig) content.push({ type: "text", text: "图片超过 8MB 未内联，请直接读取上面的文件路径。" });
        return { content };
      }

      case "do": {
        const notice = dangerNotice(args.code);
        const code = String(args.code || "");
        // 慢的 do 会挂上任务桥：心跳让“还在跑”看得见，收口时说清结果。
        // 快的（2.5s 内）安静地过去——不把会话刷成日志。
        const label = `Blender 执行 Python · ${code.split("\n")[0].slice(0, 40) || "(空)"}`;
        const out = await runTasked(
          { label, action: "do", callToken: args?.context?.callToken },
          () => relayFetch("/do", { code: args.code, timeoutMs: timeoutMs || 60_000 }, timeoutMs || 60_000),
        );
        const r = out.result;
        if (!r.ok) {
          const msg0 = `执行失败：${r.error}`;
          await settleErr(out.taskId, msg0);
          return textResult(`${notice ? notice + "\n\n" : ""}${msg0}`);
        }
        const body = JSON.stringify(r.result ?? null, null, 2);
        await settleOk(out.taskId, { text: `Blender 执行完成（用时 ${((Date.now() - out.startedAt) / 1000).toFixed(1)}s）` });
        return textResult(notice ? `${notice}\n\n${body}` : body);
      }

      case "channel": {
        const passes = Array.isArray(args.passes) && args.passes.length ? args.passes : ["depth"];
        const r = await relayFetch("/render/pass", {
          passes,
          object: args.object,
          width: args.width,
          height: args.height,
          frame: args.frame,
          engine: args.engine,
          file: args.file,
        }, 30_000);
        if (!r.ok) {
          return textResult(`渲染通道失败：${r.raw || r.error || "未知"}`);
        }
        const lines = [`渲染通道完成（${(r.info?.results || []).length} 个）`, `- 目录：${r.dir}`];
        for (const it of r.info?.results || []) {
          lines.push(`  · ${it.pass} → ${it.file}${it.ok ? "" : "（未生成）"}`);
        }
        if (r.info?.elapsedSec != null) lines.push(`- 耗时：${r.info.elapsedSec}s`);

        // 一组通道图天然就是一个 run——第一张当 hero，其余归 qc/
        const arc = autoArchive({
          runId: args.runId || null,
          label: args.label || args.file || (args.object ? `${args.object} 通道` : "通道图"),
          action: "channel",
          items: (r.info?.results || []).filter((it) => it.ok && it.file).map((it, i) => ({
            from: it.file, kind: i === 0 ? "hero" : "qc", name: `${args.object || "pass"}_${it.pass}`,
          })),
        });
        if (arc) lines.push(archiveNote(arc));

        // 投递到用户配置的目录（参数优先，否则用设置页里的默认值）
        const destDir = args.deliver || state.config.deliverTarget;
        if (destDir) {
          const files = (r.info?.files || []).filter((f) => /\.png$/i.test(f));
          const dv = await relayFetch("/deliver", { src: r.dir, destDir, files }, 20_000);
          if (dv.ok) {
            lines.push(`- 已投递 ${dv.copied.length} 个文件到：${dv.destDir}`);
            for (const c of dv.copied) lines.push(`  · ${c.name}（${c.bytes} bytes）`);
          } else {
            lines.push(`- 投递失败：${dv.error}`);
          }
        } else {
          lines.push(`- 产物只在本机：${r.dir}`);
          lines.push(`- 想自动拷到别处（如 ComfyUI input），在 App 设置页填「投递目录」，或本条带 deliver`);
        }

        const content = [{ type: "text", text: lines.join("\n") }];
        if (r.image) content.push({ type: "image", data: r.image, mimeType: r.mimeType || "image/png" });
        return { content };
      }

      case "assets": {
        const op = String(args.op || "status");

        if (op === "status") {
          const sources = [
            ["polyhaven", "PolyHaven（免费免 key，推荐）"],
            ["hyper3d", "Hyper3D Rodin（需 key）"],
            ["sketchfab", "Sketchfab（需 key）"],
            ["polypizza", "Poly Pizza（需 key）"],
            ["hunyuan3d", "Hunyuan3D（需 key）"],
            ["tripo", "Tripo（仅 Premium）"],
          ];
          const lines = ["资产源状态："];
          const details = {};
          for (const [id, label] of sources) {
            let r = null;
            try { r = await relayFetch("/raw", { type: `get_${id}_status` }, 20_000); } catch (e) {
              lines.push(`- ${label}：查询失败（${e?.message || e}）`);
              continue;
            }
            const res = r?.result || {};
            const on = res.enabled === true;
            details[id] = res;
            const msg = String(res.message || "").replace(/\s+/g, " ").trim();
            lines.push(`- ${on ? "✅" : "❌"} ${label}${on ? "" : " — " + (msg.slice(0, 100) || "未启用")}`);
          }
          lines.push("", "提示：经检索/下载请用 op=search / op=download。");
          return textResult(lines.join("\n"), { details });
        }

        if (op === "search") {
          const assetType = String(args.assetType || "all");
          const r = await relayFetch("/raw", {
            type: "search_polyhaven_assets",
            params: {
              asset_type: assetType,
              query: args.query || undefined,
              category: args.category || undefined,
              limit: args.limit || undefined,
            },
          }, 60_000);
          const res = r?.result;
          if (res?.error) return textResult(`检索失败：${res.error}`);
          let list = res?.assets;
          if (!Array.isArray(list) && res && typeof res === "object") {
            list = Object.entries(res).map(([id, v]) => ({ id, ...(v || {}) }));
          }
          if (!Array.isArray(list) || !list.length) {
            return textResult(`未找到匹配资产（assetType=${assetType} query=${args.query || "-"}）。试试换关键词，或用 category 按分类检索。`);
          }
          const lines = [`PolyHaven 检索「${args.query || args.category || assetType}」命中 ${list.length} 条：`];
          for (const a of list.slice(0, 30)) {
            const id = a.id || a.name || "?";
            const nm = a.name && a.name !== id ? `（${a.name}）` : "";
            const cat = a.categories?.length ? ` [${a.categories.slice(0, 3).join("/")}]` : "";
            const dl = a.download_count != null ? ` ↓${a.download_count}` : "";
            lines.push(`- ${id}${nm}${cat}${dl}`);
          }
          lines.push("", "用 op=download + assetId 下载并导入场景。");
          return textResult(lines.join("\n"), { details: { count: list.length, first: list[0] } });
        }

        if (op === "download") {
          if (!args.assetId) throw new Error("op=download 需要 assetId");
          const assetType = String(args.assetType || "");
          if (!assetType) throw new Error("op=download 需要 assetType（hdris / textures / models）");
          const r = await relayFetch("/raw", {
            type: "download_polyhaven_asset",
            params: {
              asset_id: args.assetId,
              asset_type: assetType,
              resolution: args.resolution || "1k",
              file_format: args.fileFormat || undefined,
            },
            timeoutMs: 300_000,
          }, 320_000);
          const res = r?.result;
          if (res?.error) return textResult(`下载失败：${res.error}`);
          const lines = [`已下载并导入：${args.assetId}（${assetType}）`];
          if (res?.message) lines.push(`- ${res.message}`);
          if (res?.imported_objects?.length) lines.push(`- 导入物体：${res.imported_objects.join(", ")}`);
          if (res?.image_name) lines.push(`- 贴图：${res.image_name}`);
          if (res?.world) lines.push(`- 世界：${res.world}`);
          if (res?.authors?.length) lines.push(`- 作者：${res.authors.join(", ")}`);
          if (res?.url) lines.push(`- 来源：${res.url}`);
          return textResult(lines.join("\n"), { details: res });
        }

        throw new Error(`action=assets 的 op 取值：status / search / download（收到 ${op}）`);
      }

      case "render": {
        const op = String(args.op || "start");
        if (op === "status") {
          if (!args.jobId) throw new Error("action=render op=status 需要 jobId");
          const r = await relayFetch("/render/status", { jobId: args.jobId }, 20_000);
          if (!r.ok) return textResult(`查渲染状态失败：${r.error}`);
          if (r.state === "running") {
            return textResult(`渲染进行中（jobId=${r.jobId}，已 ${Math.round((r.elapsedMs || 0) / 1000)}s）。稍后再查。`);
          }
          const content = [
            { type: "text", text: `渲染完成：${r.file}（${r.bytes || 0} bytes，${r.info?.res ? r.info.res.join("x") : "?"}，${r.info?.elapsedSec ?? "?"}s）` },
          ];
          if (r.image) content.push({ type: "image", data: r.image, mimeType: r.mimeType || "image/png" });
          if (r.imageTooBig) content.push({ type: "text", text: "图片超过 8MB 未内联，请直接读取上面的路径。" });
          return { content };
        }

        // op=start
        const started = await relayFetch("/render/start", {
          engine: args.engine, width: args.width, height: args.height,
          frame: args.frame, format: args.format, file: args.file,
        }, 30_000);
        if (!started.ok) return textResult(`发起渲染失败：${started.error}`);

        // 内联等待（可选，短图用）
        if (args.wait) {
          const deadline = Date.now() + 25_000;
          for (;;) {
            const st = await relayFetch("/render/status", { jobId: started.jobId }, 20_000);
            if (st.ok && st.state === "completed") {
              const content = [{ type: "text", text: `渲染完成：${st.file}（${st.bytes || 0} bytes，${st.info?.elapsedSec ?? "?"}s）` }];
              if (st.image) content.push({ type: "image", data: st.image, mimeType: st.mimeType || "image/png" });
              return { content };
            }
            if (st.ok && st.state === "failed") return textResult(`渲染失败：${st.error}`);
            if (Date.now() > deadline) {
              // 超时后转为后台跟踪，不让用户白等
              break;
            }
            await sleep(1200);
          }
        }

        // 任务桥：建宿主任务 → 后台轮询 → 完成时自动回会话
        const label = args.file ? `Blender 渲染 · ${String(args.file)}` : "Blender 渲染";
        const { taskId, note: bridgeNote } = await makeTask({
          label,
          callToken: args?.context?.callToken,
          action: "render",
          meta: { jobId: started.jobId },
        });

        if (taskId) watchRenderJob(started.jobId, taskId);

        return textResult(
          `渲染已发起（jobId=${started.jobId}）。\n` +
          `- 引擎：${started.engine || "BLENDER_EEVEE"}\n` +
          `- 分辨率：${(started.res || []).join("x") || "场景默认"}\n` +
          `- 输出：${started.file}\n` +
          (taskId
            ? `完成后会自动把图贴回本会话；也可随时用 action=render op=status jobId=${started.jobId} 主动取。`
            : `取图：action=render op=status jobId=${started.jobId}${bridgeNote ? `\n（${bridgeNote}）` : ""}`),
        );
      }

      case "scene": {
        const r = await relayFetch("/scene", {}, 25_000);
        if (!r.ok) return textResult(`读取场景失败：${r.error}`);
        return textResult(JSON.stringify(r.result ?? null, null, 2));
      }

      case "object": {
        // op 不传或 =get 就是原来的读。
        // 增删走同一个 action，因为它们都是“针对某个物体”的动作——
        // 分成两三个 action 会让模型得先猜该用哪个。
        const op = String(args.op || "get");
        if (op === "get") {
          const r = await relayFetch("/object", { name: args.name }, 25_000);
          if (!r.ok) return textResult(`读取物体失败：${r.error}`);
          return textResult(JSON.stringify(r.result ?? null, null, 2));
        }

        // 写操作：过租约门禁（别人持锁时返回 409，会由 relayFetch 带回来）
        const body = { op };
        for (const k of ["kind", "name", "to", "names", "location", "rotation", "scale", "offset", "material", "holder", "force"]) {
          if (args[k] !== undefined) body[k] = args[k];
        }
        const r = await relayFetch("/object/edit", body, 60_000);
        if (r.ok === false) {
          // 409 要说清是“被别人占着”，而不是“操作本身有问题”
          const extra = r.lease ? `（写锁被「${r.lease.holder}」持有，剩 ${Math.round((r.lease.expiresInMs || 0) / 1000)}s。等，或带 force:true 抢）` : "";
          return textResult(`物体操作失败：${r.error || "未知"}${extra}`);
        }
        const res = r.result || {};
        const lines = [];
        if (op === "add") {
          lines.push(`已新建 ${body.kind || "cube"}：${res.name}`);
          if (res.location) lines.push(`- 位置：[${res.location.map((n) => Number(n).toFixed(2)).join(", ")}]`);
        } else if (op === "remove") {
          const done = res.removed || [];
          const miss = res.missing || [];
          lines.push(done.length ? `已移入回收站（可恢复）：${done.join("、")}` : "没有可移除的物体");
          if (miss.length) lines.push(`- 没找到：${miss.join("、")}`);
          if (done.length) lines.push(`- 回收站集合：${res.trash}｜恢复用 object op=restore`);
        } else if (op === "restore") {
          const done = res.restored || [];
          const miss = res.missing || [];
          lines.push(done.length ? `已恢复：${done.join("、")}` : "回收站里没有这些物体");
          if (miss.length) lines.push(`- 没找到：${miss.join("、")}`);
        } else if (op === "rename") {
          lines.push(`已改名：${res.from} → ${res.to}`);
        } else if (op === "duplicate") {
          lines.push(`已复制：${res.from} → ${res.name}`);
        } else if (op === "trash_list") {
          const objs = res.objects || [];
          lines.push(objs.length ? `回收站（${objs.length} 个）：${objs.join("、")}` : "回收站是空的");
        } else if (op === "purge") {
          lines.push(`已真删回收站里的 ${res.purged ?? 0} 个物体（不可恢复）`);
        }
        // 改了场景就顺手记一笔，让“谁改的”有落点
        if (["add", "remove", "restore", "rename", "duplicate", "purge"].includes(op)) {
          const arc = autoArchive({
            runId: args.runId || null,
            label: args.label || `物体 · ${op}`,
            action: "object",
            items: [],
          });
          if (arc) lines.push(archiveNote(arc));
        }
        return textResult(lines.join("\n"), { details: { op, ...res } });
      }

      case "raw": {
        if (!args.type) throw new Error("action=raw 需要 type");
        const r = await relayFetch("/raw", { type: args.type, params: args.params || {}, timeoutMs: timeoutMs || 60_000 }, 30_000);
        if (!r.ok) return textResult(`命令失败：${r.error}`);
        return textResult(JSON.stringify(r.result ?? null, null, 2));
      }

      case "lease": {
        const op = String(args.op || "who");
        const holder = args.holder != null ? String(args.holder) : undefined;
        if (op === "who") {
          const r = await relayFetch("/rt/who", {}, 15_000);
          const lv = r.lease || {};
          const lines = [
            lv.active ? `写锁：被「${lv.holder}」持有，剩余 ${Math.round((lv.expiresInMs || 0) / 1000)}s` : "写锁：空闲（没人持有，写操作不受限）",
            `- TTL：${Math.round((lv.ttlMs || 0) / 1000)}s｜续期次数：${lv.renewals || 0}`,
          ];
          if (r.metrics) lines.push(`- 通道：调用 ${r.metrics.calls ?? "?"}｜错误 ${r.metrics.errors ?? "?"}｜超时 ${r.metrics.timeouts ?? "?"}`);
          return textResult(lines.join("\n"), { details: r });
        }
        if (op === "release") {
          const r = await relayFetch("/rt/release", { holder }, 15_000);
          return textResult(r.released ? `已释放「${r.released}」的写锁。` : "当前没有可释放的写锁（可能已过期）。", { details: r });
        }
        if (op === "renew") {
          const r = await relayFetch("/rt/lease", { holder: holder || "anonymous", renewOnly: true }, 15_000);
          return textResult(r.renewed ? "已续期。" : "未持有租约，未续期（不会在空闲时抢占）。", { details: r });
        }
        const r = await relayFetch("/rt/lease", {
          holder: holder || "ophelia", ttlMs: args.ttlMs, force: !!args.force,
          renewOnly: args.renewOnly === true,
        }, 15_000);
        if (r.ok === false || r.error === "leased") {
          return textResult(
            `拿不到写锁：已被「${r.holder}」持有，剩余约 ${Math.round((r.expiresInMs || 0) / 1000)}s。\n` +
            `- 等它过期，或带 force:true 抢占（会打断对方）。`,
          );
        }
        const lv = r.lease || {};
        return textResult(
          `写锁已拿到（holder=${lv.holder}，TTL ${Math.round((lv.ttlMs || 0) / 1000)}s）。\n` +
          `- 后续写操作带上 holder 会自动续期；做完用 lease op=release 释放。`,
          { details: r },
        );
      }

      case "worker": {
        const op = String(args.op || "status");
        if (op === "exec") {
          const r = await relayFetch("/rt/worker", {
            op, code: args.code, timeoutMs: args.timeoutMs, purgePrefix: args.purgePrefix,
          }, (Number(args.timeoutMs) || 120_000) + 20_000);
          const res = r.result || {};
          if (!r.ok) {
            const lines = [`热会话执行失败：${r.error || res.error || "未知"}`];
            if (r.traceback || res.traceback) lines.push(String(r.traceback || res.traceback).slice(0, 800));
            return textResult(lines.join("\n"));
          }
          const lines = ["热会话执行完成"];
          if (res.ms != null) lines.push(`- 耗时：${res.ms}ms`);
          if (res.stdout) lines.push(`- stdout：${String(res.stdout).trim().slice(0, 800)}`);
          return textResult(lines.join("\n"), { details: res });
        }
        if (op === "start" || op === "restart") {
          const r = await relayFetch("/rt/worker", { op, file: args.file }, 120_000);
          const res = r.result || {};
          return textResult(
            r.ok ? `热会话已${op === "restart" ? "重启" : "拉起"}（pid ${res.pid ?? "?"}，端口 ${res.port ?? "?"}）。` : `启动失败：${r.error || "未知"}`,
            { details: res },
          );
        }
        if (op === "stop") {
          const r = await relayFetch("/rt/worker", { op }, 60_000);
          return textResult(r.ok ? "热会话已关闭。" : `关闭失败：${r.error || "未知"}`, { details: r.result });
        }
        const r = await relayFetch("/rt/worker", { op: "status" }, 15_000);
        const res = r.result || {};
        const lines = [res.alive ? "热会话：活着" : "热会话：未启动"];
        if (res.alive) {
          if (res.pid != null) lines.push(`- pid ${res.pid}｜端口 ${res.port ?? "?"}`);
          if (res.uptimeMs != null) lines.push(`- 已存活 ${Math.round(res.uptimeMs / 1000)}s`);
          if (res.lastError) lines.push(`- 最近错误：${String(res.lastError).slice(0, 200)}`);
        } else {
          lines.push("- 用 op=start 拉起；适合批量出图/多角度 QC（首帧冷启动约 16s，之后每帧约 1.35s）");
        }
        return textResult(lines.join("\n"), { details: res });
      }

      case "job": {
        const op = String(args.op || "list");
        const r = await relayFetch("/rt/job", {
          op, id: args.id, script: args.code, file: args.file, outdir: args.outdir,
          tail: args.tail, timeoutMs: args.timeoutMs,
        }, 60_000);
        if (op === "start") {
          const j = r.job || {};
          return textResult(
            `作业已提交（id=${j.id || "?"}）。\n` +
            `- 产物：${j.outdir || "（默认）"}\n` +
            `- 跟进：action=job op=status id=${j.id}；取回用 op=collect。`,
            { details: j },
          );
        }
        if (op === "collect") {
          const j = r.job || {};
          const lines = [`作业 ${j.id || args.id}：${j.state || "?"}`];
          if (j.log || j.tail) lines.push("", String(j.log || j.tail).slice(-3000));
          if (j.outdir) lines.push("", `- 产物：${j.outdir}`);
          return textResult(lines.join("\n"), { details: j });
        }
        if (op === "status") {
          const j = r.job || {};
          return textResult(
            `作业 ${j.id || args.id}：${j.state || "?"}${j.ms != null ? `（${j.ms}ms）` : ""}`,
            { details: j },
          );
        }
        if (op === "kill") {
          return textResult(`已请求终止作业 ${args.id || "?"}。`, { details: r.job });
        }
        const list = r.jobs || [];
        const lines = [`作业列表（${list.length}）`];
        for (const j of list.slice(0, 20)) {
          lines.push(`  · ${j.id}｜${j.state || "?"}${j.ms != null ? `｜${j.ms}ms` : ""}${j.outdir ? `｜${j.outdir}` : ""}`);
        }
        if (!list.length) lines.push("（暂无作业）");
        return textResult(lines.join("\n"), { details: { count: list.length } });
      }

      default:
        throw new Error(`未知 action：${action}`);
    }
  }

  // ── 契约自检（启动时一次）────────────────────────────────────────────
  //
  // 为什么要在注册前跑：工具描述是从 schema 派生的。如果 schema 自己不一致
  // （参数声明了却没定义、动作没有分支），那种不一致会**直接变成**模型看到的东西，
  // 而模型不会报错——它只会传错参数，然后回执说"成功"。
  //
  // 只记日志，不拦启动：自检的职责是**让你看得见**，不是替你做决定。
  // 一条自检把整个 App 抬不起来，那是比它想防的错更大的错。
  try {
    const sc = selfCheck();
    if (sc.ok) {
      log(`契约自检：通过（${actions.length} 个动作 / ${Object.keys(SCHEMA.PARAM_SPEC).length} 个参数定义）`);
    } else {
      for (const p of sc.problems) {
        warn(`契约自检 [${p.kind}] ${p.detail.length} 项：${p.detail.slice(0, 12).join(", ")}`);
      }
    }
  } catch (e) {
    warn(`契约自检自身出错（不阻断启动）：${msgOf(e)}`);
  }

  try {
    await sdk.tools.register({
      name: TOOL_NAME,
      description:
        "Blender 助手：操作本机 Blender（经 addon 127.0.0.1:9876）的工具（一个 App 一个同名工具，action 选动作）。" +
        "典型节奏：see 看清现状 → do 改一处 → see 再确认；改动前不确定就先 txn op=mark 打回退点。首次使用、或 Blender 刚启动时，先 doctor 或 connect。" +
        `\n动作一览（共 ${actions.length} 个）：\n` + actionCatalogText(),
      parameters: { oneOf: actionBranches() },
      execute: async (args) => {
        try {
          return await runAction(args || {});
        } catch (e) {
          return textResult(`blender 工具出错：${msgOf(e)}`);
        }
      },
    });
    log(`工具注册：${TOOL_NAME}（${actions.map((a) => a.id).join("/")}）`);
  } catch (e) {
    error(`工具注册失败：${msgOf(e)}`);
  }

  // 视图拍摄的模块级出口。
  //
  // 为什么要这个：拍视图的那套代码（转视口 / 取景 / 还原 / 归档）
  // 现在住在 routes.register 的回调里，而 runAction 是模块级的，
  // 两边作用域不同——于是“收口时自动拍一组视图”这件事就做不成，
  // 只能让人手去点那个「取一张」。
  //
  // 把实现暴露到这里，收口和按钮走同一段代码。
  // （不把两百行搬出来的原因：搬的代价比接一根线大，而效果一样。）
  let captureViewImpl = null;
  // “这一版做完了”默认拍哪几个方位。
  // 一次迭代一组视图——不是每次改场景都拍。
  const DEFAULT_VIEW_SET = ["iso", "front", "right", "top"];

  // ── 把这一版的**几何**存下来 ────────────────────────────────────────────
  //
  // 为何要存几何：run 目录一直只存图。于是“切换产出”看到的只是照片，
  //   而且照片还会串——因为视图拍的是**此刻场景**，不是那一版的东西。
  //   实测过：在 tiger 那版点拍摄，拿到的四张图和花那版的**逐字节相同**。
  //
  // 存一份 GLB 之后，每一版才真正自洽：它自己带几何，不再依赖“拍的时候场景里恰好是什么”。
  //
  // 为什么是 GLB：单文件、带 PBR 材质、带层级和命名，浏览器/查看器/引擎都能直接读。
  // 为什么走 /do 而不是 export_scene：export_scene 也能用，但它把 Light/Camera
  //   的名字也列进 exported（几何并没写进去，容易误读）；这里自己控范围更清楚。
  //
  // 不碰用户的视口：只读对象、导出，不改任何场景状态。
  async function captureModel(runId, opts = {}) {
    if (!runId || !state.runs) return null;
    const run = state.runs.get(String(runId));
    if (!run) return null;
    const tmp = join(state.config.workDir, `_model_${Date.now().toString(36)}.glb`);
    const outWin = JSON.stringify(tmp.replace(/\\/g, "/"));
    const code = [
      "import bpy, os",
      `_out = ${outWin}`,
      "_meshes = [o.name for o in bpy.context.scene.objects",
      "           if o.type == 'MESH' and not o.hide_viewport and not o.hide_render]",
      "if not _meshes:",
      "    print('DSH_MODEL_EMPTY')",
      "else:",
      "    bpy.ops.object.select_all(action='DESELECT')",
      "    for _n in _meshes:",
      "        bpy.data.objects[_n].select_set(True)",
      "    bpy.ops.export_scene.gltf(filepath=_out, export_format='GLB',",
      "        use_selection=True, export_apply=True)",
      "    _sz = os.path.getsize(_out) if os.path.exists(_out) else -1",
      "    print('DSH_MODEL_OK', len(_meshes), _sz)",
    ].join("\n");
    try {
      const r = await relayFetch("/do", { code, timeoutMs: 90_000 }, 120_000);
      const out = String((r && r.result && r.result.result) || "");
      if (out.includes("DSH_MODEL_EMPTY")) return { ok: false, error: "场景里没有可见的网格，没东西可存" };
      const m = /DSH_MODEL_OK (\d+) (\d+)/.exec(out);
      if (!m) return { ok: false, error: "导出没有回执：" + out.slice(0, 160) };
      if (!existsSync(tmp)) return { ok: false, error: "导出没落盘" };
      // 存进 run：kind=model。overwrite 让重存顶掉旧的，不堆 model-2。
      const rel = state.runs.put(run, { from: tmp, kind: "model", name: opts.name || "model", note: "glb", overwrite: true });
      try { rmSync(tmp, { force: true }); } catch { /* 删不掉就留着 */ }
      return rel ? { ok: true, rel, meshes: Number(m[1]), bytes: Number(m[2]) } : { ok: false, error: "归档失败" };
    } catch (e) {
      return { ok: false, error: msgOf(e) };
    }
  }

  // ── 存一份**完整**场景快照（.blend）──────────────────────────────────────
  //
  // 为何 GLB 不够：它是**丢信息**的格式。带几何/材质/层级，
  //   但不带修改器栈、骨骼绑定、驱动表达式、程序化节点。
  //   所以 GLB 能“看和用”，**不等于能回退**。要真回退，必须存 .blend。
  //
  // 怎么做到“存了但不扰动当前会话”：
  //   bpy.ops.wm.save_as_mainfile(filepath=..., copy=True)
  //   copy=True 是存一份副本，**不改当前 filepath、不清 dirty 标记**。
  //   没这个参数的话，存一下就把用户手上这个未命名场景“另存为”了，
  //   下次 Ctrl+S 会写到我指定的地方去——那是很脏的副作用。
  //
  // 另外把当前会话的元信息一并带回来（是不是已存过、有没有未保存改动），
  //   好让上层说清“刚才那一份是什么”。
  async function captureSceneBlend(dirPath, baseName) {
    const safe = String(baseName || "scene").replace(/[^\w.\u4e00-\u9fa5-]+/g, "_").slice(0, 60) || "scene";
    mkdirSync(dirPath, { recursive: true });
    const dest = join(dirPath, `${safe}.blend`);
    const outWin = JSON.stringify(dest.replace(/\\/g, "/"));
    const code = [
      "import bpy, os",
      `_out = ${outWin}`,
      "_before_path = bpy.data.filepath",
      "_before_dirty = bpy.data.is_dirty",
      "_objs = len(bpy.context.scene.objects)",
      "bpy.ops.wm.save_as_mainfile(filepath=_out, copy=True)",
      "_after_path = bpy.data.filepath",
      "_after_dirty = bpy.data.is_dirty",
      "_sz = os.path.getsize(_out) if os.path.exists(_out) else -1",
      // 把“当前会话被动了没有”一并回传——这是判据，靠它才能说跟“不影响用户”
      "print('DSH_BLEND_OK', _sz, _objs, int(_before_path != _after_path), int(bool(_before_dirty) != bool(_after_dirty)))",
      "print('DSH_BLEND_PATH', _before_path, '|', _after_path)",
    ].join("\n");
    try {
      const r = await relayFetch("/do", { code, timeoutMs: 120_000 }, 150_000);
      const out = String((r && r.result && r.result.result) || "");
      const m = /DSH_BLEND_OK (-?\d+) (\d+) (\d) (\d)/.exec(out);
      if (!m) return { ok: false, error: "存快照没有回执：" + out.slice(0, 160) };
      const [, sz, objs, pathChanged, dirtyChanged] = m;
      return {
        ok: Number(sz) > 0, file: dest, bytes: Number(sz), objects: Number(objs),
        // 这两项应该都是 0。不为 0 就说明“不影响用户”这个前提破了，得报出来。
        sessionTouched: pathChanged === "1" || dirtyChanged === "1",
        error: Number(sz) > 0 ? null : "快照没落盘",
      };
    } catch (e) {
      return { ok: false, error: msgOf(e) };
    }
  }

  // 快照目录。与 runs 同根——它们都是“存档”，不该混进临时产物里。
  function snapshotDir() {
    const d = state.runs ? join(state.runs.root, "_snapshots") : join(state.config.workDir, "_snapshots");
    try { mkdirSync(d, { recursive: true }); } catch { /* 建不出来后面会报 */ }
    return d;
  }

  // 把当前场景存成一个带时间戳的快照。
  // 装入别的场景**之前**自动调它——这样“装入”就不再是破坏性的：随时能回到装之前。
  async function snapshotBeforeChange(why) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const r = await captureSceneBlend(snapshotDir(), `${stamp}_${why || "snap"}`);
    if (r && r.ok) log(`已存快照（${why || "snap"}）：${r.file}（${r.objects} 个物体）`);
    else warn(`存快照失败（${why || "snap"}）：${(r && r.error) || "未知"}`);
    return r;
  }

  // 从这一版的**来源脚本**无头重建，并渲染一组视图。
  //
  // 为何不是“拍视口”：
  //   “拍视口”拍的是**此刻场景**，不是那一版的东西。实测过两次：
  //     ① 在 tiger 那版点拍，场景里已经是花 → tiger/views 里装进花的四张图；
  //     ② 后来场景又换成默认立方体 → tiger/views 里是六个灰方块。
  //   两次都不是 bug，是**语义错了**——视图就不该与“现在”沾边。
  //
  // 为何无须碰用户的 Blender：
  //   headless 是独立进程（与 generator_run 同一通道），跑完就退。
  //   实测：重建 tiger + 导出 GLB 只花 3.6s，用户视口全程未被触及。
  const FRAMING_VER_HL = "hl1";

  // 拿这一版的生成器源码。三条路，从“最不依赖环境”到“最依赖”：
  //
  //   ① run 里存的副本（script/<name>.py）—— 最自足，不依赖任何外部状态
  //   ② 直接读盘（~/dsh_generators 或 DSH_GENERATOR_DIR）—— 不依赖 Blender
  //   ③ 走生成器注册表（/rt/plan generator_get）—— **需要 Blender 开着**
  //
  // 为何要 ① 和 ②：实测过——Blender 没开时，③ 直接报
  //   “connect ECONNREFUSED 127.0.0.1:9876”，于是“拍视图”整条路断掉。
  //   而“把这一版重建一遍”这件事，本来就不该依赖你开着 Blender。
  //
  // 拿到源码后顺手存一份进 run：下次就走 ①，不再依赖前两者。
  function generatorRoots() {
    const roots = [];
    const env = process.env.DSH_GENERATOR_DIR;
    if (env) roots.push(String(env));
    // 与 generator.py 的 _root() 保持一致：~/dsh_generators
    try {
      const home = process.env.USERPROFILE || process.env.HOME || "";
      if (home) roots.push(join(home, "dsh_generators"));
    } catch { /* 忽略 */ }
    return roots;
  }

  function readGeneratorFromDisk(name) {
    const bare = String(name || "").replace(/\.py$/i, "");
    if (!bare) return null;
    // 与 generator.py 的 _paths() 同一套净化规则，不然两边找的不是同一个文件
    const safe = bare.replace(/[^A-Za-z0-9._-]/g, "_");
    for (const root of generatorRoots()) {
      const p = join(root, safe + ".py");
      try {
        if (existsSync(p) && statSync(p).size > 0) {
          return { code: readFileSync(p, "utf8"), from: p, via: "disk" };
        }
      } catch { /* 换下一个根 */ }
    }
    return null;
  }

  // 从 run 里读存的源码副本
  function readGeneratorFromRun(run) {
    try {
      const recs = (run && run.files && run.files.script) || [];
      for (const r of recs) {
        const p = join(state.runs.root, run.id, r.rel);
        if (existsSync(p) && statSync(p).size > 0) {
          return { code: readFileSync(p, "utf8"), from: p, via: "run" };
        }
      }
    } catch { /* 忽略 */ }
    return null;
  }

  // 把源码存进 run（幂等：已有就顶掉）。存不下不报错——它只是加速器，不是必需。
  function stashGeneratorSource(run, name, code) {
    try {
      if (!state.runs || !code) return null;
      const tmpDir = join(state.config.workDir, `_gs_${Date.now().toString(36)}`);
      mkdirSync(tmpDir, { recursive: true });
      const bare = String(name || "generator").replace(/\.py$/i, "") || "generator";
      const f = join(tmpDir, bare + ".py");
      writeFileSync(f, code, "utf8");
      const rel = state.runs.put(run, { from: f, kind: "script", name: bare, overwrite: true });
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
      return rel;
    } catch { return null; }
  }

  async function resolveGeneratorSource(run) {
    const script = (run.meta && run.meta.script) ? String(run.meta.script) : "";
    if (!script) return { ok: false, error: "这一版没记来源脚本" };
    // ① run 自带的副本
    const inRun = readGeneratorFromRun(run);
    if (inRun) return { ok: true, script, ...inRun };
    // ② 直接读盘（不依赖 Blender）
    const onDisk = readGeneratorFromDisk(script);
    if (onDisk) {
      stashGeneratorSource(run, script, onDisk.code);
      return { ok: true, script, ...onDisk };
    }
    // ③ 注册表（需 GUI 在跑）——作为最后一条路
    try {
      const gname = script.replace(/\.py$/i, "");
      const g = await relayFetch("/rt/plan", { op: "generator_get", args: { name: gname } }, 30_000);
      const gres = (g && g.result) || {};
      if (!gres.ok) {
        return { ok: false, error: `拿不到脚本：${script}（${gres.error || "未知"}）` };
      }
      const code = String(gres.code || "");
      if (!code) return { ok: false, error: `脚本是空的：${script}` };
      stashGeneratorSource(run, script, code);
      return { ok: true, script, code, from: gres.path || "", via: "registry" };
    } catch (e) {
      return { ok: false,
        error: `拿不到脚本：${script}（三条路都没走通：run 里没副本、盘上没文件、注册表不可达——${msgOf(e).slice(0, 80)}）` };
    }
  }

  async function renderViewsFromScript(run, angles) {
    const script = (run.meta && run.meta.script) ? String(run.meta.script) : "";
    if (!script) return { ok: false, error: "这一版没记来源脚本" };
    const want = (Array.isArray(angles) && angles.length ? angles : DEFAULT_VIEW_SET)
      .map((a) => String(a || "").toLowerCase()).filter((a) => a);

    const got0 = await resolveGeneratorSource(run);
    if (!got0.ok) return { ok: false, error: got0.error };
    const src = got0.code;
    if (!src) return { ok: false, error: `脚本是空的：${script}` };

    const outDir = join(state.config.workDir, `_rv_${Date.now().toString(36)}`);
    try { mkdirSync(outDir, { recursive: true }); } catch { /* 后面会报 */ }
    const code = buildHeadlessRenderCode(src, want, outDir);
    try {
      // timeoutMs：宿主 sdk.runtime.fetch 契约写死 1〜30000（只有 30s），
      //   所以写更大的值是假承诺——它会被默默砍回 30s。
      //   写 28s：自己先报，错误信息就能说“渲染超时”，
      //   而不是让宿主抛一句“callback.tools.execute timed out”。
      //   实测四张 Workbench 共 3.6s，余量 8 倍。
      const r = await relayFetch("/rt/headless", {
        script: code, outdir: outDir, timeoutMs: 28_000,
      }, 28_000);
      const res = (r && r.result) || {};
      const stdout = String(res.stdout || "");
      if (stdout.includes("DSH_RV_EMPTY")) return { ok: false, error: "脚本跑完场景里没有网格（重建失败？）" };
      // 【不靠 stdout 回执】
      //   中继自己就有一条经验（renderStart 旁）：真实渲染会往 stdout 打
      //   大量 “Fra:1 …” 采样行，标记 JSON 会被冲掉/截断。
      //   而且 stdout 还可能被上层截断（实测工具面只留 600 字符）。
      //   所以判据用**文件**：图落盘了就是成了，这比解析 stdout 可靠。
      const got = [];
      for (const a of want) {
        const f = join(outDir, `${a}.png`);
        try { if (!existsSync(f) || statSync(f).size <= 0) continue; } catch { continue; }
        const rel = state.runs.put(run, { from: f, kind: "view", name: a, note: FRAMING_VER_HL, overwrite: true });
        if (rel) got.push(a);
      }
      if (!got.length) {
        const why = res.stderr || stdout.slice(-260) || "没有产出任何 PNG";
        return { ok: false, error: "无头渲染没出图：" + String(why).replace(/\s+/g, " ").slice(0, 240) };
      }
      // 回执只用来补充信息（网格/三角数），取不到也不影响成败
      const rep = /DSH_RV_OK (\d+) (\d+) (\d+)/.exec(stdout);
      try { rmSync(outDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
      return {
        ok: true, angles: got,
        meshes: rep ? Number(rep[1]) : null,
        tris: rep ? Number(rep[2]) : null,
        shots: rep ? Number(rep[3]) : got.length,
        via: "headless",
      };
    } catch (e) {
      try { rmSync(outDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
      return { ok: false, error: "无头渲染异常：" + msgOf(e) };
    }
  }

  // 拼出无头渲染脚本：注入源码 → 跑它 → 补相机/灯（如缺）→ 各方位正交渲染。
  function buildHeadlessRenderCode(scriptSrc, angles, outDir) {
    const outWin = outDir.replace(/\\/g, "/");
    const DIRS = {
      iso: [1, -1, 0.8], front: [0, -1, 0], back: [0, 1, 0],
      left: [-1, 0, 0], right: [1, 0, 0], top: [0, 0, 1], bottom: [0, 0, -1],
    };
    const jobs = angles.map((a) => [a, DIRS[a] || DIRS.iso]);
    return [
      "# 无头重建 + 渲染（自动生成，不要手改）",
      "import bpy, os, math, json",
      "from mathutils import Vector, Matrix",
      "PARAMS = {}",
      `_SRC = ${JSON.stringify(scriptSrc)}`,
      "exec(compile(_SRC, '<generator>', 'exec'), globals())",
      "_sc = bpy.context.scene",
      "_meshes = [o for o in _sc.objects if o.type == 'MESH']",
      "if not _meshes:",
      "    print('DSH_RV_EMPTY')",
      "    raise SystemExit(0)",
      "_tris = 0",
      "for _o in _meshes:",
      "    _o.data.calc_loop_triangles()",
      "    _tris += len(_o.data.loop_triangles)",
      "_pts = []",
      "for _o in _meshes:",
      "    for _c in _o.bound_box:",
      "        _pts.append(_o.matrix_world @ Vector(_c))",
      "_lo = Vector((min(p.x for p in _pts), min(p.y for p in _pts), min(p.z for p in _pts)))",
      "_hi = Vector((max(p.x for p in _pts), max(p.y for p in _pts), max(p.z for p in _pts)))",
      "_ctr = (_lo + _hi) / 2.0",
      "_rad = max((_hi - _lo).length / 2.0, 0.001)",
      "_cam = next((o for o in _sc.objects if o.type == 'CAMERA'), None)",
      "if _cam is None:",
      "    _cam = bpy.data.objects.new('DSH_CAM', bpy.data.cameras.new('DSH_CAM'))",
      "    _sc.collection.objects.link(_cam)",
      "_sc.camera = _cam",
      "_cam.data.type = 'ORTHO'",
      "_cam.data.clip_start = 0.01",
      "_cam.data.clip_end = _rad * 60.0",
      "if not _sc.world:",
      "    _sc.world = bpy.data.worlds.new('DSH_W')",
      "_sc.world.use_nodes = True",
      "_bg = _sc.world.node_tree.nodes.get('Background')",
      "if _bg:",
      "    _bg.inputs[0].default_value = (0.94, 0.93, 0.91, 1.0)",
      "    _bg.inputs[1].default_value = 1.0",
      // 不建灯：Workbench 自己打光，建灯不仅无用还拖慢无头启动。
      // 【引擎・实测依据】
      //   ✗ 曾经写 `'BLENDER_WORKBENCH' in _engines`（拿枚举列表判断）——
      //     无头下枚举只剩 ['BLENDER_EEVEE']，于是静默落到 EEVEE。
      //   ✓ 实情：Workbench **能直接赋值且能渲染**（不在枚举里不代表不能用）。
      //     实测同一场景 900×600：
      //       Workbench 1.47s  /  EEVEE 31.31s
      //     差距全在 EEVEE 的着色器首次编译上，而视图根本不需要它。
      //   视图是拿来看形状的，Workbench 的studio 打光 + 材质色正好够。
      //   所以：直接赋值，失败才退。不要用枚举当门禁。
      "_engine_pref = ['BLENDER_WORKBENCH', 'BLENDER_EEVEE_NEXT', 'BLENDER_EEVEE']",
      "for _e in _engine_pref:",
      "    try:",
      "        _sc.render.engine = _e",
      "        if _sc.render.engine == _e:",
      "            break",
      "    except Exception:",
      "        continue",
      "try:",
      "    _sc.display.shading.light = 'STUDIO'",
      // ！用 TEXTURE 不用 MATERIAL。
      //
      //   这是第三套颜色系统，比昨天那两套更隐蔽：
      //     · 节点 Base Color → 只影响 EEVEE/Cycles
      //     · mat.diffuse_color → 视口/Workbench 的 MATERIAL 模式
      //     · display.shading.color_type → 决定 Workbench 到底看哪一处
      //
      //   ！实测：color_type='MATERIAL' 时，**贴了图的模型拍出来看不到贴图**，
      //     因为 MATERIAL 模式只看 diffuse_color，根本不采样图片。
      //     （而我昨天就是写死的 MATERIAL——贴图功能一上，视图就是错的。）
      //
      //   实测 TEXTURE 是**严格更优**的：
      //     · 有贴图的材质 → 显示贴图（棋盘验证过，UV 映射也对）
      //     · 没贴图的材质 → 回退到 diffuse_color（纯色红立方体验证过，没变灰）
      //   所以统一用 TEXTURE，不管有没有图都对。
      "    _sc.display.shading.color_type = 'TEXTURE'",
      "    _sc.display.shading.show_shadows = False",
      "    _sc.display.shading.show_cavity = True",
      "    _sc.display.shading.cavity_type = 'BOTH'",
      "except Exception:",
      "    pass",
      // EEVEE 退路：光追必领关（CPU 上软件回退，实测第一张 30.9s → 20.5s）
      "try:",
      "    _sc.eevee.use_raytracing = False",
      "    _sc.eevee.taa_render_samples = 16",
      "except Exception:",
      "    pass",
      "_sc.render.resolution_x = 900",
      "_sc.render.resolution_y = 600",
      "_sc.render.resolution_percentage = 100",
      "_sc.render.image_settings.file_format = 'PNG'",
      "_sc.render.film_transparent = False",
      `_JOBS = ${JSON.stringify(jobs)}`,
      "_aspect = _sc.render.resolution_x / float(_sc.render.resolution_y)",
      "_done = 0",
      "for _name, _dir in _JOBS:",
      "    _d = Vector(_dir).normalized()",
      "    _ref = Vector((0, 0, 1))",
      "    if abs(_d.dot(_ref)) > 0.99:",
      "        _ref = Vector((0, 1, 0))",
      "    _e1 = _ref.cross(_d).normalized()",
      "    _e2 = _d.cross(_e1).normalized()",
      "    _A = [(p - _ctr).dot(_e1) for p in _pts]",
      "    _B = [(p - _ctr).dot(_e2) for p in _pts]",
      "    _a0, _a1 = min(_A), max(_A)",
      "    _b0, _b1 = min(_B), max(_B)",
      // ortho_scale 是**水平**视野宽。_e1 水平、_e2 垂直，aspect = w/h。
      // 垂直方向实际覆盖 = ortho_scale / aspect。
      //   水平要够：  scale >= a_span
      //   垂直要够：  scale / aspect >= b_span  →  scale >= b_span * aspect
      // 曾经写成 max(b_span, a_span/aspect)——把水平需求除了 aspect，
      // 水平就框不住，长坦克的左前被裁掉（tiger iso 实测）。
      "    _span = max(_a1 - _a0, (_b1 - _b0) * _aspect)",
      "    _cam.data.ortho_scale = max(_span * 1.08, 0.01)",
      "    _cam.matrix_world = Matrix((_e1, _e2, _d)).transposed().to_4x4()",
      "    _cam.location = _ctr + _e1 * ((_a0 + _a1) / 2.0) + _e2 * ((_b0 + _b1) / 2.0) + _d * (_rad * 15.0)",
      `    _path = os.path.join(${JSON.stringify(outWin)}, _name + '.png')`,
      "    _sc.render.filepath = _path",
      "    bpy.ops.render.render(write_still=True)",
      "    if os.path.exists(_path):",
      "        _done += 1",
      "        print('DSH_RV_SHOT', _name, os.path.getsize(_path))",
      "print('DSH_RV_OK', len(_meshes), _tris, _done)",
    ].join("\n");
  }

  // 拍一组视图。
  async function captureViewSet(runId, angles, noCache = false) {
    if (!captureViewImpl) return [];
    const want = (Array.isArray(angles) && angles.length ? angles : DEFAULT_VIEW_SET)
      .map((a) => String(a || "").toLowerCase())
      .filter((a) => a);
    // ── 先看这一版有没有“来源脚本” ──
    //
    // 有 → 走**无头重建 + 渲染**。图属于这一版本身，与“现在场景是什么”无关。
    // 没有 → 才走拍视口（用户手搭的东西只能这么拍）。
    //
    // 为何把无头放前面：拍视口那条路实测错过两次（拍出花、拍出立方体），
    //   而且错得没声音——图能出，只是出的不是这一版的东西。
    // 为何不看 noCache：无头渲染本来就是每次重算，没有“缓存命中”这回事。
    //
    // ！关键：有脚本的版本**绝不退回拍视口**。
    //   曾经写的是“无头失败→退回拍视口”。后果实测：
    //     取脚本时名字带了 .py（generator_get 会拼成 tiger_v10.py.py），
    //     无头失败 → 静默退回 → Blender 没开时拍不到，
    //     但却报“已拍 4 个方位”，而那 4 张是几小时前的旧图。
    //   对“有脚本”的版本，拍视口**永远不可能对**——它拍的是“此刻场景”，
    //   不是这一版。所以退回不是降级，是用一个静默错误盖住另一个。
    //   接不上就如实报错，让调用方知道。
    if (state.runs) {
      const run0 = state.runs.get(String(runId));
      if (run0 && run0.meta && run0.meta.script) {
        const hl = await renderViewsFromScript(run0, want);
        if (hl.ok) return hl.angles || [];
        warn(`从脚本渲染失败：${hl.error}`);
        // 返回带 error 的空数组：调用方能用 got.error 报真因，
        //   而 `got.length` 仍然是 0——不会把失败当成成功。
        const empty = [];
        empty.error = hl.error;
        empty.via = "headless";
        return empty;
      }
    }
    const got = [];
    for (const a of want) {
      try {
        const r = await captureViewImpl({ angle: a, runId, noCache });
        if (r && r.ok && r.file) got.push(a);
        else warn(`拍视图 ${a} 失败：${(r && r.error) || "未知"}`);
      } catch (e) {
        warn(`拍视图 ${a} 异常：${msgOf(e)}`);
      }
    }
    return got;
  }

  // ── 路由面（壳页 / 面板用）────────────────────────────────────────────────
  try {
    await sdk.routes.register((app) => {
      app.get("/blender-bridge/boot-state", (c) => {
        try {
          return c.json({
            ok: true,
            phase: state.phase,
            runtimeId: state.runtimeId,
            servicePort: state.servicePort,
            lastError: state.lastError,
          });
        } catch (e) { return c.json({ ok: false, error: msgOf(e) }, 500); }
      });

      app.get("/blender-bridge/status", async (c) => {
        try { return c.json(await fullStatus()); }
        catch (e) { return c.json({ ok: false, error: msgOf(e) }, 500); }
      });

      app.get("/blender-bridge/health", (c) => c.json({
        ok: true,
        app: { id: APP_ID, version: APP_VERSION },
        ts: new Date().toISOString(),
      }));

      // 服务端日志（落盘的那份）。
      //
      // 为何要这个端点：UI 那份日志只记浏览器发起的请求，
      //   而工具面（模型）调的请求它一条也看不到。
      //   出错时最该看的就是那一类，所以必须能从服务端拉。
      app.get("/blender-bridge/app-log", (c) => {
        const n = Number(c.req.query("n")) || 300;
        return c.json({ ok: true, file: logFilePath(), lines: readAppLog(n) });
      });

      app.post("/blender-bridge/relay/start", async (c) => {
        try {
          await ensureStarted({ force: true });
          return c.json({ ok: state.phase === "ready", phase: state.phase, lastError: state.lastError });
        } catch (e) { return c.json({ ok: false, error: msgOf(e) }, 500); }
      });

      app.post("/blender-bridge/doctor", async (c) => {
        try {
          const d = await relayFetch("/doctor", {}, 30_000);
          return c.json(d);
        } catch (e) { return c.json({ ok: false, error: msgOf(e) }, 502); }
      });

      app.post("/blender-bridge/run", async (c) => {
        try {
          let body = {};
          try { body = await c.req.json(); } catch { body = {}; }
          const r = await relayFetch("/do", { code: body.code }, 60_000);
          // 把危险扫描结果结构化，面板直接展示（与工具面同一套判据）
          return c.json({ ...r, danger: scanDanger(body.code) });
        } catch (e) { return c.json({ ok: false, error: msgOf(e) }, 502); }
      });

      // 取景公式的版本。改了公式就得加一——否则旧缓存的图会被当成“已经算过”，
      // 用户点一下看到的是旧公式的成果，看着像没修。
      // 这比“手动去删几个文件”可靠：下次改公式同样自动失效。
      const FRAMING_VER = "f3";

      // ── 视角 ──
      // 关键：截图（addon 的 get_viewport_screenshot）拍的是 **3D 视口**，
      // 用的是 space.region_3d 的矩阵，不是 scene.camera。
      // 所以要让视角真的变，必须改视口自身的朝向（view_rotation），
      // 而不是去摆那个相机——摆相机拍了四张字节数一模一样。
      //
      // 方向约定：to_track_quat('Z') 让相机局部 +Z 指向 _d，
      // 而相机看的是局部 -Z，所以**视点方向 = -_d**。
      // 车体长轴在 Y（实测 X=3.7 / Y=8.45 / Z=3.06），车头在 +Y。
      // 要看车头，得站在 +Y 往 -Y 看。
      const VIEW_ANGLES = {
        front: [0, 1, 0],
        back: [0, -1, 0],
        right: [1, 0, 0],
        left: [-1, 0, 0],
        top: [0, 0, 1],
        iso: [1, 1, 0.8],
      };

      // 取景要按视口的宽高比算，不能当正方形。
      // 实测用户视口 2100×1202（比 1.747）——宽的。
      // 只拿一个径向半径去乘常数，结果是竖向恰好、横向一大片空。
      // 正确的做法：把包围盒顶点投到屏幕的两个轴上，分别算需要的半宽/半高。
      function buildViewCode(dir) {
        return [
          "import bpy, math",
          "from mathutils import Vector",
          "area = next((a for a in bpy.context.screen.areas if a.type == 'VIEW_3D'), None)",
          "if area is None:",
          "    print('NO_VIEWPORT')",
          "else:",
          "    r3d = area.spaces.active.region_3d",
          "    reg = next((r for r in area.regions if r.type == 'WINDOW'), None)",
          "    aspect = (reg.width / reg.height) if reg and reg.height else 1.777",
          "    q = r3d.view_rotation",
          "    L = r3d.view_location",
          "    sp = area.spaces.active",
          // 覆盖层状态一并快照。
          // ！截图会把编辑器覆盖层也拍进去：网格地板、红绿坐标轴、3D 光标。
          //   实测 iso 那张的“内容”填充率 99.8%——因为网格被当成了模型。
          //   拍之前关掉，拍完恢复。
          "    _ov = [sp.overlay.show_overlays, sp.overlay.show_floor,",
          "           sp.overlay.show_axis_x, sp.overlay.show_axis_y, sp.overlay.show_axis_z,",
          "           sp.overlay.show_cursor, sp.overlay.show_text, sp.overlay.show_object_origins,",
          "           sp.show_gizmo, sp.show_region_header, sp.show_region_toolbar]",
          "    print('PREV|%.6f,%.6f,%.6f,%.6f|%.6f,%.6f,%.6f|%.6f|%s|%s' % (",
          "        q.w, q.x, q.y, q.z, L.x, L.y, L.z, r3d.view_distance, r3d.view_perspective,",
          "        ','.join('1' if v else '0' for v in _ov)))",
          `    _d = Vector(${JSON.stringify(dir)}).normalized()`,
          "    pts = []",
          "    for o in bpy.context.scene.objects:",
          "        if o.type != 'MESH' or o.hide_viewport or not o.visible_get(): continue",
          "        for c in o.bound_box: pts.append(o.matrix_world @ Vector(c))",
          "    if not pts: pts = [Vector((0,0,0))]",
          "    ctr = sum(pts, Vector((0,0,0))) / len(pts)",
          "    # 在垂直于视线的平面上建立基，把顶点投上去",
          "    _ref = Vector((0,0,1))",
          "    if abs(_d.dot(_ref)) > 0.99: _ref = Vector((0,1,0))",
          "    _e1 = _ref.cross(_d).normalized()",
          "    _e2 = _d.cross(_e1).normalized()",
          "    uv = []",
          "    for p in pts:",
          "        v = p - ctr",
          "        uv.append((v.dot(_e1), v.dot(_e2)))",
          "    # 主轴分析：找出投影轮廓最长的方向。",
          "    # 不这做的话，俯视时坦克的长轴会竖着摆在宽屏里——实测横向只用 18%。",
          "    mx = sum(u for u, v in uv) / len(uv)",
          "    my = sum(v for u, v in uv) / len(uv)",
          "    sxx = sum((u-mx)*(u-mx) for u, v in uv) / len(uv)",
          "    syy = sum((v-my)*(v-my) for u, v in uv) / len(uv)",
          "    sxy = sum((u-mx)*(v-my) for u, v in uv) / len(uv)",
          "    theta = 0.5 * math.atan2(2*sxy, sxx-syy)",
          "    ca, sa = math.cos(theta), math.sin(theta)",
          "    _r = (_e1 * ca + _e2 * sa).normalized()",
          "    _u = _d.cross(_r).normalized()",
          "    # 按投影包围盒的极值算半宽/半高，不是从均值点量 |max|。",
          "    # 包围盒角点的均值不等于视觉中心（128 个零件大小悬殊），",
          "    # 用均值点会算出偏大的半高，结果就是模型偏在一边、还占不满（实测 offy=0.154）。",
          "    A = [(p-ctr).dot(_r) for p in pts]",
          "    B = [(p-ctr).dot(_u) for p in pts]",
          "    a0, a1 = min(A), max(A)",
          "    b0, b1 = min(B), max(B)",
          "    hw = max((a1 - a0) / 2.0, 0.001)",
          "    hh = max((b1 - b0) / 2.0, 0.001)",
          "    # 同时装下宽与高，各留一成边",
          "    half = max(hh, hw / aspect) * 1.10",
          "    r3d.view_perspective = 'ORTHO'",
          "    # 相机局部轴：X=屏幕右，Y=屏幕上，Z=从目标指向相机",
          "    from mathutils import Matrix",
          "    r3d.view_rotation = Matrix((_r, _u, _d)).transposed().to_quaternion()",
          "    # 把视点挪到投影包围盒的中心（而不是顶点均值）",
          "    r3d.view_location = ctr + _r * ((a0 + a1) / 2.0) + _u * ((b0 + b1) / 2.0)",
          "    # 正交下 view_distance 与可见半高成固定比（随 lens 变）。",
          "    # 用当前值反推比例，不写死常数——lens 被人改过也不会错。",
          "    lens = area.spaces.active.lens or 50.0",
          "    half_fov = math.atan(18.0 / lens)",
          "    r3d.view_distance = half / math.tan(half_fov)",
          "    r3d.update()",
          // 关覆盖层（在取景算完之后关，不影响包围盒计算）。
          // 拍完由 restoreViewCode 恢复。
          "    sp.overlay.show_overlays = False",
          "    sp.show_gizmo = False",
          "    for a in bpy.context.screen.areas: a.tag_redraw()",
          "    print('VIEW_OK hw=%.3f hh=%.3f aspect=%.3f' % (hw, hh, aspect))",
        ].join("\n");
      }

      // 把视口放回它原来的样子。
      function restoreViewCode(snap) {
        const L = [
          "import bpy",
          "from mathutils import Quaternion, Vector",
          "area = next((a for a in bpy.context.screen.areas if a.type == 'VIEW_3D'), None)",
          "if area is not None:",
          "    r3d = area.spaces.active.region_3d",
          `    r3d.view_rotation = Quaternion((${snap.q}))`,
          `    r3d.view_location = Vector((${snap.loc}))`,
          `    r3d.view_distance = ${snap.dist}`,
          `    r3d.view_perspective = '${snap.persp}'`,
          "    r3d.update()",
        ];
        // 覆盖层也还原。没记录就不动——宁可少做，不要猜着做。
        if (snap.ov) {
          const k = ["show_overlays", "show_floor", "show_axis_x", "show_axis_y", "show_axis_z",
            "show_cursor", "show_text", "show_object_origins"];
          L.push("    sp = area.spaces.active");
          snap.ov.split("").slice(0, k.length).forEach((v, i) => {
            L.push(`    sp.overlay.${k[i]} = ${v === "1" ? "True" : "False"}`);
          });
          L.push("    sp.show_gizmo = True");
          L.push("    sp.show_region_header = True");
          L.push("    sp.show_region_toolbar = True");
        }
        L.push("    for a in bpy.context.screen.areas: a.tag_redraw()");
        L.push("    print('RESTORED')");
        return L.join("\n");
      }

      function parseSnap(out) {
        const m = String(out || "").match(/PREV\|([-\d.,]+)\|([-\d.,]+)\|([-\d.]+)\|(\w+)(?:\|([01]+))?/);
        if (!m) return null;
        return { q: m[1], loc: m[2], dist: m[3], persp: m[4], ov: m[5] || null };
      }


      // ── 拍一个方位的视图（唯一实现）──
      //
      // 两个入口共用它：面板的「取一张」（/see 路由）
      // 和 runAction 的 runs op=views（收口时自动拍一组）。
      //
      // 为什么提到这里：拍视图那套代码原本住在路由回调里，
      // 而 runAction 是模块级的，两边作用域不同——
      // 于是“收口时自动拍”只能靠手点。
      //
      // ！不要 app.request 之类的“内部转发”：
      //   宿主给的 app 类型是 unknown（HanaPluginRoutesV2.register
      //   签名 (app: unknown) => unknown），契约不保证它长什么样。
      //   猜一个 API 名就是在赌，赌输的表现是静默不生效。
      async function captureViewOnce({ angle, runId, noCache = false, maxSize = 900, file } = {}) {
        const ang = String(angle || "").toLowerCase();
        const rid = runId ? String(runId) : "";

        // ── 先查缓存 ──
        // 视角不是一个“查询”，它是一个**有副作用的动作**：
        // 要转视口（动用户的 Blender），再截图。转完他手里的视口就变了。
        // 所以：同一产出的同一方位，只算一次，存进那一版的产物里。
        // 想重算得显式说要重算。
        //
        // ！这里踩过：清旧图原来只写在缓存分支里，于是 noCache=true（“重拍”）
        //   绕过了清理，put() 碰到同名文件只能避开，就堆成 iso-2.png。
        //   拍两次 8 张、拍十次 40 张，而且缓存判断会因为两张都同方位而变得不确定。
        //   “同一版的同一方位”是**同一个位置的东西**，重拍就该顶掉旧的。
        //   清理挪到外面，两条路都先清。
        if (rid && ang && state.runs) {
          const run = state.runs.get(rid);
          const entries = (run && run.files.view) || [];
          const sameAngle = (f) => f.rel.replace(/^views\//, "").replace(/\.[^.]+$/, "") === ang;

          if (!noCache) {
            const hit = entries.find((f) => sameAngle(f) && f.note === FRAMING_VER);
            if (hit) {
              const fp = join(state.runs.root, rid, hit.rel);
              const img = existsSync(fp) ? readImageAsDataUrl(fp) : null;
              if (img && img.base64) {
                return {
                  ok: true, cached: true, angle: ang, file: fp,
                  image: img.base64, mimeType: img.mimeType || "image/png",
                  bytes: img.bytes || 0,
                };
              }
            }
          }

          // 同方位的旧图一律先清掉：
          //   缓存分支里是“取景公式变了”，noCache 分支里是“人要求重拍”。
          //   不删就会堆成 iso-2.png、iso-3.png……
          if (entries.some(sameAngle)) {
            for (const old of entries.filter(sameAngle)) {
              try { rmSync(join(state.runs.root, rid, old.rel), { force: true }); } catch { /* 删不掉就算了 */ }
            }
            run.files.view = entries.filter((f) => !sameAngle(f));
            state.runs.writeRun(run);
          }
        }

        // ── 真转视口，再截 ──
        // 截图拍的是 3D 视口（space.region_3d），不是 scene.camera。
        // 转之前先存下用户原状态，拍完放回去——
        // 这是他正在用的 Blender，不是我的渲染机。
        let fitSnapshot = null;
        if (ang && VIEW_ANGLES[ang]) {
          const fit = await relayFetch("/do", {
            code: buildViewCode(VIEW_ANGLES[ang]),
            timeoutMs: 30_000,
          }, 40_000);
          if (fit && fit.ok === false) {
            return { ok: false, error: "转视角失败：" + (fit.error || "未知") };
          }
          fitSnapshot = parseSnap(fit && fit.result && fit.result.result);
        }

        let r;
        try {
          r = await relayFetch("/see", { maxSize: Number(maxSize || 900), file }, 30_000);
        } finally {
          if (fitSnapshot) {
            await relayFetch("/do", { code: restoreViewCode(fitSnapshot) }, 20_000).catch(() => null);
          }
        }

        // ── 落进产出 ──
        // 这也是缓存下次能命中的前提：不存下来，下次还是得重算。
        //
        // overwrite: true —— 视图是“这一版的某个方位”，同名顶掉，不开 -2。
        // 不开的话：方位匹配会把 "iso-2" 当成另一个方位，旧图永远清不掉，
        // 缓存也会命中错的那张。
        let archived = null;
        if (rid && ang && r && r.ok && r.file && state.runs) {
          const run = state.runs.get(rid);
          if (run) {
            try {
              archived = state.runs.put(run, { from: r.file, kind: "view", name: ang, note: FRAMING_VER, overwrite: true });
            } catch { /* 归档失败不影响出图 */ }
          }
        }
        return { ...r, angle: ang || null, cached: false, archived };
      }

      // 挂到模块级出口，供 runAction 的 runs op=views 用
      captureViewImpl = captureViewOnce;

      app.post("/blender-bridge/see", async (c) => {
        try {
          let body = {};
          try { body = await c.req.json(); } catch { body = {}; }
          const out = await captureViewOnce({
            angle: body.angle,
            runId: body.runId,
            noCache: body.noCache === true,
            maxSize: body.maxSize,
            file: body.file,
          });
          return c.json(out, out && out.ok === false ? 502 : 200);
        } catch (e) { return c.json({ ok: false, error: msgOf(e) }, 502); }
      });

      // 任意视角出图（不动用户视口）
      app.post("/blender-bridge/view", async (c) => {
        try {
          let body = {};
          try { body = await c.req.json(); } catch { body = {}; }
          const spec = {
            from: body.from, look_at: body.look_at,
            width: body.width, height: body.height,
            lens: body.lens, ortho: body.ortho,
          };
          const r = await relayFetch("/rt/view", { ...spec, asJson: true }, 60_000);
          if (r.ok === false) return c.json({ ok: false, error: r.error || "未知" }, 502);
          const meta = r.meta || {};
          const out = {
            ok: true,
            width: meta.width, height: meta.height, mode: meta.mode,
            file: meta.path, bytes: meta.bytes,
          };
          if (meta.path && existsSync(meta.path)) {
            const img = readImageAsDataUrl(meta.path);
            if (img && img.base64) { out.image = img.base64; out.mimeType = img.mimeType || "image/png"; }
          }
          return c.json(out);
        } catch (e) { return c.json({ ok: false, error: msgOf(e) }, 502); }
      });

      // 拍一组视图（面板用）。和工具面 runs op=views 共用同一段实现。
      app.post("/blender-bridge/views", async (c) => {
        try {
          let body = {};
          try { body = await c.req.json(); } catch { body = {}; }
          if (!body.id) return c.json({ ok: false, error: "id 必填" }, 400);
          if (!state.runs) return c.json({ ok: false, error: "归档器未就绪" }, 500);
          const run = state.runs.get(String(body.id));
          if (!run) return c.json({ ok: false, error: `没找到 run：${body.id}` }, 404);
          const angles = await captureViewSet(run.id, body.angles, body.noCache === true);
          if (angles.error) return c.json({ ok: false, error: angles.error, angles: [] }, 502);
          return c.json({ ok: true, angles });
        } catch (e) { return c.json({ ok: false, error: msgOf(e) }, 502); }
      });

      // 读场景结构（面板用，直接给 objects 数组）
      //
      // ！为什么不用 get_scene_info：
      //   它硬编码「只返回前 10 个 objects」（addon 里 `if i >= 10: break`），
      //   而 object_count 是真实总数。两个字段一混，界面就写成了“10 个物体”——
      //   实测场景里有 30 个，少掉的那 20 个不但看不见，也删不掉。
      //
      //   list_scene_items 遍历全部对象，返回 { items, total }，limit 可到 100。
      //   用它，并把 objects 拼成前端原本就认的形状（兼容现有 UI）。
      app.post("/blender-bridge/scene", async (c) => {
        try {
          const r = await relayFetch("/raw", {
            type: "list_scene_items",
            params: { query: "", limit: 100 },
          }, 25_000);
          const res = r?.result || {};
          const items = res.items || [];
          const objects = items
            .filter((it) => it && it.kind === "object")
            .map((it) => ({ name: it.name, type: extractType(it.detail), location: null }));
          // total 是“对象+材质+集合”的合计数；物体数自己数。
          const objectTotal = objects.length;
          return c.json({
            ok: true,
            result: {
              name: "Scene",
              objects,
              object_count: objectTotal,
              // 说清“列表是不是全的”：不全的时候界面要如实标出来
              truncated: items.length >= 100,
            },
          });
        } catch (e) { return c.json({ ok: false, error: msgOf(e) }, 502); }
      });

      // 3D 模型增删（面板用）。和工具 action=object 的写分支共用 relay 端点。
      app.post("/blender-bridge/object-edit", async (c) => {
        try {
          let body = {};
          try { body = await c.req.json(); } catch { body = {}; }
          const op = String(body.op || "");
          if (!op) return c.json({ ok: false, error: "op 必填" }, 400);
          const payload = { op };
          for (const k of ["kind", "name", "to", "names", "location", "rotation", "scale", "offset", "material", "holder", "force"]) {
            if (body[k] !== undefined) payload[k] = body[k];
          }
          const r = await relayFetch("/object/edit", payload, 60_000);
          if (!r || r.ok === false) return c.json({ ok: false, error: (r && r.error) || "未知", lease: r && r.lease }, 502);
          return c.json({ ok: true, result: r.result ?? null });
        } catch (e) { return c.json({ ok: false, error: msgOf(e) }, 502); }
      });

      // Blender 服务起停（面板用）
      app.post("/blender-bridge/service", async (c) => {
        try {
          let body = {};
          try { body = await c.req.json(); } catch { body = {}; }
          const op = String(body.op || "status");
          if (op === "start") {
            const r = await relayFetch("/service/start", { path: body.path }, 60_000);
            return c.json({ ...r, detail: r.ok ? `Blender 已拉起（${r.blenderExe || "已探测"}）` : undefined });
          }
          if (op === "stop") {
            const r = await relayFetch("/service/stop", {}, 60_000);
            return c.json({ ...r, detail: r.ok ? "Blender 服务已撒下" : undefined });
          }
          const r = await relayFetch("/service/status", {}, 15_000);
          return c.json(r);
        } catch (e) { return c.json({ ok: false, error: msgOf(e) }, 502); }
      });

      // ── 可派活的助手与模型 ──
      // 这两者不是一类东西：助手是“谁来干”（一个 agent 有自己的会话与记忆），
      // 模型是“用哪个脑子”（同一会话换个模型即可）。所以它们走后端两个不同的口，
      // UI 上也不会做成同一个下拉框。
      app.get("/blender-bridge/agents", async (c) => {
        try {
          if (typeof sdk.bus?.request !== "function") {
            return c.json({ ok: false, error: "宿主未提供 bus" }, 503);
          }
          // scope:"all" 是必须的。不给 scope，agent:list 只返回「本应用自己的」助手——
          // Blender 助手没有自己的助手，于是列表永远是空的（界面上就是“无可选助手”）。
          // 跟 biaoqingbao 那边 session:list 要 scope:"all" 是同一个坑。
          const r = await sdk.bus.request("agent:list", { scope: "all" }, { timeoutMs: 8000 });
          const raw = (r && (r.agents || (Array.isArray(r) ? r : []))) || [];
          const agents = raw
            .map((a) => ({
              id: String(a.id || a.agentId || ""),
              name: String(a.name || a.id || ""),
              // 字段叫 state（"active"/"retired"），不叫 retired/lifecycle——
              // 字段名猜错的后果是“退位的助手照样出现在列表里”。
              retired: a.state === "retired" || a.retired === true || a.lifecycle === "retired",
            }))
            .filter((a) => a.id);
          return c.json({ ok: true, agents, current: state.config.dispatchAgentId || "" });
        } catch (e) {
          return c.json({ ok: false, error: msgOf(e) }, 502);
        }
      });

      app.get("/blender-bridge/models", async (c) => {
        try {
          if (typeof sdk.bus?.request !== "function") {
            return c.json({ ok: false, error: "宿主未提供 bus" }, 503);
          }
          const r = await sdk.bus.request("model:list", undefined, { timeoutMs: 8000 });
          const raw = (r && r.models) || [];
          // 探针：只记字段名，不记值（值可能带着凭据类信息）。
          // 为什么需要它：AppModelInfoV2 是 Record<string, unknown>，契约
          // 故意不保证字段名；而切模型需要 provider。宿主到底给不给，
          // 静态查不出来，只能实测。看到字段名就能确定这条路能不能走通。
          if (raw.length && raw[0] && typeof raw[0] === "object") {
            log(`模型投影字段：${Object.keys(raw[0]).join(",")}（共 ${raw.length} 个模型）`);
          }
          // AppModelInfoV2 是 Record<string, unknown>——字段名不保证，
          // 把常见的几种都搜一遍，拿不到就不编一个出来。
          // provider 必须一并拿到：它和 modelId 一起才算完整的地址，
          // 切模型时要两个一起发给宿主。
          const models = raw
            .map((m) => ({
              id: String(m.id || m.modelId || m.name || ""),
              label: String(m.label || m.displayName || m.name || m.id || m.modelId || ""),
              provider: String(m.provider || m.providerId || ""),
            }))
            .filter((m) => m.id);
          return c.json({ ok: true, models, current: state.config.dispatchModel || "", currentProvider: state.config.dispatchProvider || "" });
        } catch (e) {
          return c.json({ ok: false, error: msgOf(e) }, 502);
        }
      });

      app.post("/blender-bridge/dispatch", async (c) => {
        try {
          let body = {};
          try { body = await c.req.json(); } catch { body = {}; }
          const out = await dispatchWork({
            brief: body.brief,
            agentId: body.agentId,
            modelId: body.modelId,
            provider: body.provider,
            runId: body.runId,
            sessionId: body.sessionId,
          });
          return c.json(out);
        } catch (e) {
          // “先写一句”这类是调用方的问题（400），其余当服务端错（502）。
          const m = msgOf(e);
          return c.json({ ok: false, error: m }, /先说一句|必须知道发给谁/.test(m) ? 400 : 502);
        }
      });

      app.get("/blender-bridge/runs", (c) => {
        try {
          if (!state.runs) return c.json({ ok: false, error: "归档器未就绪" }, 500);
          return c.json({ ok: true, ...state.runs.stats(), runs: state.runs.list({ limit: 40 }).map((r) => {
            // 列表不带 dir：路径宿主内部知道就行，不必泄给前端
            const rest = { ...r };
            delete rest.dir;
            return rest;
          }) });
        } catch (e) { return c.json({ ok: false, error: msgOf(e) }, 500); }
      });

      // 存完整场景 / 装入场景（面板用）。和工具面共用同一段实现。
      app.post("/blender-bridge/runs/scene", async (c) => {
        try {
          let body = {};
          try { body = await c.req.json(); } catch { body = {}; }
          if (!state.runs) return c.json({ ok: false, error: "归档器未就绪" }, 500);
          const run = state.runs.get(String(body.id || ""));
          if (!run) return c.json({ ok: false, error: `没找到 run：${body.id}` }, 404);
          const bd = await captureSceneBlend(state.config.workDir, `_scene_${Date.now().toString(36)}`);
          if (!bd || !bd.ok) return c.json({ ok: false, error: (bd && bd.error) || "未知" }, 502);
          const rel = state.runs.put(run, { from: bd.file, kind: "scene", name: "scene", note: "blend", overwrite: true });
          try { rmSync(bd.file, { force: true }); } catch { /* 忽略 */ }
          if (!rel) return c.json({ ok: false, error: "归档失败" }, 502);
          return c.json({ ok: true, rel, objects: bd.objects, bytes: bd.bytes });
        } catch (e) { return c.json({ ok: false, error: msgOf(e) }, 502); }
      });

      app.post("/blender-bridge/runs/restore", async (c) => {
        try {
          let body = {};
          try { body = await c.req.json(); } catch { body = {}; }
          if (!state.runs) return c.json({ ok: false, error: "归档器未就绪" }, 500);
          const run = state.runs.get(String(body.id || ""));
          if (!run) return c.json({ ok: false, error: `没找到 run：${body.id}` }, 404);
          const rec = ((run.files || {}).scene || [])[0];
          if (!rec) return c.json({ ok: false, error: "这一版没有存完整场景" }, 404);
          const target = join(state.runs.root, run.id, rec.rel);
          if (!existsSync(target)) return c.json({ ok: false, error: `文件不存在：${target}` }, 404);
          // 装之前自动存快照——这是“装入”不破坏手上那活的关键。
          const snap = await snapshotBeforeChange("before_restore");
          if (!snap || !snap.ok) {
            return c.json({ ok: false,
              error: `装之前没存成快照（${(snap && snap.error) || "未知"}）——已停下，手上的活没被碰`,
            }, 502);
          }
          const outWin = JSON.stringify(target.replace(/\\/g, "/"));
          const rr = await relayFetch("/do", {
            code: ["import bpy", `bpy.ops.wm.open_mainfile(filepath=${outWin})`,
              "print('DSH_RESTORE_OK', len(bpy.context.scene.objects))"].join("\n"),
            timeoutMs: 120_000,
          }, 150_000);
          const out = String((rr && rr.result && rr.result.result) || "");
          const mm = /DSH_RESTORE_OK (\d+)/.exec(out);
          if (!mm) return c.json({ ok: false, error: "装入没有回执：" + out.slice(0, 180) }, 502);
          return c.json({ ok: true, objects: Number(mm[1]), snapshot: snap });
        } catch (e) { return c.json({ ok: false, error: msgOf(e) }, 502); }
      });

      app.post("/blender-bridge/runs/tag", async (c) => {
        try {
          let body = {};
          try { body = await c.req.json(); } catch { body = {}; }
          if (!state.runs) return c.json({ ok: false, error: "归档器未就绪" }, 500);
          const j = state.runs.tag(body.id, body.tag === null ? null : (body.tag || TAG_BASELINE));
          return j ? c.json({ ok: true, run: j }) : c.json({ ok: false, error: `没找到 run：${body.id}` }, 404);
        } catch (e) { return c.json({ ok: false, error: msgOf(e) }, 500); }
      });

      app.post("/blender-bridge/runs/feedback", async (c) => {
        try {
          let body = {};
          try { body = await c.req.json(); } catch { body = {}; }
          if (!state.runs) return c.json({ ok: false, error: "归档器未就绪" }, 500);
          const run = state.runs.get(body.id);
          if (!run) return c.json({ ok: false, error: `没找到 run：${body.id}` }, 404);
          const line = state.runs.feedback(run, body.text);
          if (!line) return c.json({ ok: false, error: "意见是空的" }, 400);
          // 回读完整意见列表：前端要能显示“历次说过什么”
          return c.json({ ok: true, line, feedback: state.runs.readFeedback(run) });
        } catch (e) { return c.json({ ok: false, error: msgOf(e) }, 500); }
      });

      // 取归档里的图片。必须防目录穿越：id/rel 都来自 URL，
      // 不校验的话 ../../ 能读到磁盘上任何地方。
      app.get("/blender-bridge/runs/asset", (c) => {
        try {
          const id = String(c.req.query("id") || "");
          const rel = String(c.req.query("rel") || "").replace(/\\/g, "/");
          if (!id || !rel) return c.json({ ok: false, error: "需要 id 与 rel" }, 400);
          if (!/^[\w.\u4e00-\u9fa5-]+$/.test(id)) return c.json({ ok: false, error: "id 不合法" }, 400);
          if (rel.indexOf("..") >= 0 || rel.startsWith("/") || /^[a-zA-Z]:/.test(rel)) {
            return c.json({ ok: false, error: "rel 不合法" }, 400);
          }
          const fp = join(state.runs.root, id, rel);
          // 拼完再核一次：必须在 run 根目录里面
          const norm = fp.replace(/\\/g, "/");
          if (!norm.startsWith(state.runs.root.replace(/\\/g, "/"))) {
            return c.json({ ok: false, error: "越界" }, 403);
          }
          if (!existsSync(fp)) return c.json({ ok: false, error: "文件不存在" }, 404);
          const img = readImageAsDataUrl(fp);
          if (!img || !img.base64) return c.json({ ok: false, error: "读不出图片" }, 415);
          return c.json({ ok: true, image: img.base64, mimeType: img.mimeType || "image/png" });
        } catch (e) { return c.json({ ok: false, error: msgOf(e) }, 500); }
      });

      app.post("/blender-bridge/runs/collect", async (c) => {
        try {
          let body = {};
          try { body = await c.req.json(); } catch { body = {}; }
          if (!state.runs) return c.json({ ok: false, error: "归档器未就绪" }, 500);
          // 面板把当前 workDir 里的产物一键收进来，不用手敲一串路径
          const kinds = Array.isArray(body.items) ? body.items : [];
          if (!kinds.length) return c.json({ ok: false, error: "没有要收的产物" }, 400);
          const run = state.runs.begin({ label: body.label || "panel", action: body.action || "collect", meta: { by: "human" } });
          const done = [];
          for (const it of kinds) {
            const rel = state.runs.put(run, { from: it.from, kind: it.kind || "view", name: it.name || null, note: it.note || null });
            if (rel) done.push({ kind: it.kind || "view", rel });
          }
          if (body.summary || body.notes) {
            if (body.notes) state.runs.writeNotes(run, body.notes);
            state.runs.finish(run, { summary: body.summary || null });
          }
          return c.json({ ok: true, id: run.id, dir: run.dir, collected: done });
        } catch (e) { return c.json({ ok: false, error: msgOf(e) }, 500); }
      });

      app.post("/blender-bridge/runs/prune", async (c) => {
        try {
          let body = {};
          try { body = await c.req.json(); } catch { body = {}; }
          if (!state.runs) return c.json({ ok: false, error: "归档器未就绪" }, 500);
          // 默认 dryRun：清理是破坏性动作，先看清楚再动手
          const dry = body.dryRun !== false;
          return c.json({ ok: true, dryRun: dry, ...state.runs.prune({ keep: Number(body.keep) || DEFAULT_KEEP, dryRun: dry }) });
        } catch (e) { return c.json({ ok: false, error: msgOf(e) }, 500); }
      });

      app.get("/blender-bridge/config", (c) => c.json({
        ok: true,
        addonHost: state.config.addonHost,
        addonPort: state.config.addonPort,
        workDir: state.config.workDir,
        deliverTarget: state.config.deliverTarget || "",
        blenderPath: state.config.blenderPath || "",
        dispatchAgentId: state.config.dispatchAgentId || "",
        dispatchModel: state.config.dispatchModel || "",
        dispatchProvider: state.config.dispatchProvider || "",
        configPath: CONFIG_PATH,
      }));

      app.post("/blender-bridge/config", async (c) => {
        try {
          let body = {};
          try { body = await c.req.json(); } catch { body = {}; }
          const before = { ...state.config };
          if (body.addonHost && typeof body.addonHost === "string") state.config.addonHost = body.addonHost;
          if (body.addonPort) {
            const p = Number(body.addonPort);
            if (Number.isInteger(p) && p > 0 && p < 65536) state.config.addonPort = p;
          }
          if (typeof body.deliverTarget === "string") state.config.deliverTarget = body.deliverTarget;
          if (typeof body.blenderPath === "string") state.config.blenderPath = body.blenderPath;
          if (typeof body.workDir === "string" && body.workDir) state.config.workDir = body.workDir;
          saveConfig();
          // 只有连接参数真变了才重启中继；改投递目录不必折腾
          const needRestart = before.addonHost !== state.config.addonHost || before.addonPort !== state.config.addonPort || before.workDir !== state.config.workDir;
          if (needRestart) await ensureStarted({ force: true });
          return c.json({ ok: true, config: state.config, phase: state.phase, restarted: needRestart });
        } catch (e) { return c.json({ ok: false, error: msgOf(e) }, 500); }
      });
    });
    log("路由注册：ctx.routes.register（/blender-bridge/boot-state|status|health|doctor|see|relay/start|config|runs|view|scene|service）");
  } catch (e) {
    error(`ctx.routes.register 失败（面板诊断面不可用，工具面仍可用）：${msgOf(e)}`);
  }

  // ── 轻量健康轮询（让壳页有实时状态）──────────────────────────────────────
  state.healthTimer = setInterval(() => {
    if (state.phase !== "ready") return;
    fire(relayFetch("/health", {}, 6000).then((h) => { state.health = h; }).catch(() => {}));
  }, 5000);
  state.healthTimer.unref?.();

  // ── 自动拉起（微任务，不占 apply 同步栈）───────────────────────────────────
  Promise.resolve()
    .then(async () => {
      await stopStaleRuntimes();
      await ensureStarted();
    })
    .catch((e) => warn(`自动拉起失败：${msgOf(e)}`));
});
