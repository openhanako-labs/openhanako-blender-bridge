/**
 * 比例模板（按画风分档的身体比例）。
 *
 * ── 为什么单独成文件（2026-10-20）────────────────────────────────────────
 *
 * 这块逻辑原先写在 index.js 的 `case "plan"` 里，而它累积了**三个**独立缺陷，
 * 且全部只在「真调一次」时才暴露：
 *
 *   ① 结构上到不了 —— 分支写在「拿到上游 res 之后」，而上游不认识 proportion，
 *      回 "unknown contract op" 就早退了。从 v1.52 上线起一次都没跑过。
 *   ② 引用不存在的名字 —— 代码里写 `fs.readFileSync` 和 `path.join`，
 *      而这个模块只 import 了 `readFileSync` / `join`，没有 `fs` / `path` 命名空间。
 *   ③ `__dirname` 在 ES module 里不存在 —— 同一行还有第三个坑。
 *
 * 三个错叠在一起，因为它们**从未被执行过一次**。单元层面的绿灯（schema 有、
 * 文件在、数据对）一个都不少，因为灯照的是零件，不是这条调用。
 *
 * 所以这里把它挪出闭包：纯函数、可被测试直接调用。
 * 测试打的是**真实调用路径**，不是旁边的零件。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

/** 相对 app 根目录的模板文件位置。 */
export const TEMPLATE_REL = "runtime/proportion_templates.json";

/**
 * 读模板文件。
 * @param {string} appDir app 根目录（index.js 里用 import.meta.dirname）
 */
export function loadTemplates(appDir) {
  return JSON.parse(readFileSync(join(appDir, TEMPLATE_REL), "utf8"));
}

/** 可选画风名，按模板文件顺序。 */
export function styleNames(pt) {
  return Object.keys((pt && pt.styles) || {});
}

/**
 * 生成可读的比例报告。
 *
 * @param {object} pt        模板（loadTemplates 的结果）
 * @param {string} [styleRaw] 画风名；空 / "list" → 列全部
 * @returns {string[]} 行数组，调用方 join("\n")
 */
export function proportionReport(pt, styleRaw) {
  const style = String(styleRaw || "").toLowerCase();
  const styles = (pt && pt.styles) || {};
  const names = Object.keys(styles);
  const lines = [`比例模板 · 单位：${(pt && pt.units) || "ratio"}`];

  if (!style || style === "list") {
    lines.push(`- 共 ${names.length} 种画风`);
    for (const k of names) {
      const v = styles[k];
      lines.push(`  · ${k}（${v.cn}）→ ${v.heads}头身｜身 ${v.torso_h}｜腿 ${v.legs_h}｜臂 ${v.arms_h}`);
    }
    lines.push(`- 用法：plan op=proportion style=<画风名>`);
    return lines;
  }

  const t = styles[style];
  if (!t) {
    lines.push(`- 未找到画风「${style}」。可选：${names.join(" / ")}`);
    return lines;
  }

  lines.push(`- ${style}（${t.cn}）：${t.heads}头身`);
  lines.push(`  头：1｜身：${t.torso_h}｜腿：${t.legs_h}｜臂：${t.arms_h}`);
  if (t.note) lines.push(`  ${t.note}`);
  return lines;
}

/**
 * 按比例算出一组实际高度（头部高度 = 1 的相对值 × unitHeight）。
 * 建模时可以直接拿这些数字去定各段尺寸——省得模型每次自己乘。
 *
 * @param {object} pt
 * @param {string} style
 * @param {number} unitHeight 头部实际高度（米）
 */
export function proportionDimensions(pt, style, unitHeight) {
  const t = ((pt && pt.styles) || {})[String(style || "").toLowerCase()];
  if (!t) return null;
  const u = Number(unitHeight);
  if (!Number.isFinite(u) || u <= 0) return null;
  return {
    style: String(style).toLowerCase(),
    heads: t.heads,
    unit: u,
    head: u,
    torso: u * t.torso_h,
    legs: u * t.legs_h,
    arms: u * t.arms_h,
    total: u * (1 + t.torso_h + t.legs_h),
  };
}
