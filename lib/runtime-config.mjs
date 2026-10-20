/**
 * 中继启动配置文件的清理。
 *
 * ── 背景（2026-10-20）─────────────────────────────────────────────────────
 *
 * 启动中继前，App 会把一份配置写到 `app-data/blender-bridge/integration/`：
 * 端口、readyMarker，以及**明文 controlKey**。中继读走它之后就该消失。
 *
 * 但删除原先挂在「启动后 10 秒的定时器」上——定时器绑在 App 进程上，
 * 进程早退它就永不触发。实测漏过一个（`relay-2d6d6e10114c.json`，
 * 2026-10-15 的 v1.8.0），里面的 key 一直躺在那儿，还会误导后来查端口的人：
 * 它指着一个早已不存在的进程。
 *
 * 现在的分工：
 *   ① 中继读到配置后**立刻自删**（blender-relay.mjs）——最短因果链
 *   ② 写新配置前，顺手清掉目录里的陈年残留（本文件的 prune）——兜底
 *
 * 另：`mode 0o600` + `chmod` 在 Windows 上多半是 no-op，不能当成防线。
 * 所以「删得干净」比「设了权限」重要得多。
 */

import { readdirSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";

/** 启动配置文件的名字形态：relay-<12 位 hex>.json */
export const RELAY_CONFIG_RE = /^relay-[0-9a-f]+\.json$/;

/** 默认只清「一小时前的」。留这个窗口是为了不误伤并发启动中的中继。 */
export const DEFAULT_STALE_MS = 60 * 60 * 1000;

/**
 * 清理目录里陈年的中继启动配置。
 *
 * @param {string} dir          集成目录（可能不存在）
 * @param {object} [opts]
 * @param {number} [opts.maxAgeMs]  超过这个年龄才清
 * @param {number} [opts.now]       当前时间（测试注入用）
 * @returns {string[]} 被删掉的文件名（便于测试与日志；失败的空数组）
 */
export function pruneStaleRuntimeConfigs(dir, opts = {}) {
  const maxAgeMs = Number.isFinite(opts.maxAgeMs) ? opts.maxAgeMs : DEFAULT_STALE_MS;
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const removed = [];
  try {
    for (const f of readdirSync(dir)) {
      if (!RELAY_CONFIG_RE.test(f)) continue;   // 只碰中继配置，别的一律不动
      const p = join(dir, f);
      try {
        if (now - statSync(p).mtimeMs > maxAgeMs) {
          rmSync(p, { force: true });
          removed.push(f);
        }
      } catch { /* 单个文件失败不影响其余 */ }
    }
  } catch { /* 目录不存在 / 不可读：没什么可清的 */ }
  return removed;
}
