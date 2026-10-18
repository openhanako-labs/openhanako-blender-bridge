// ui/assets/host-theme.js — 跟随宿主主题
//
// 为什么需要这一层（不是装饰，是修一个静默失效）：
//
//   宿主会往 App / 卡片的 iframe 里注入**当前主题的 CSS**（一个
//   <style data-hana-theme-style>），那份 CSS 带着颜色。但那十套主题里，
//   除默认那套外**全部写成 `[data-theme="<id>"]`，没有裸 :root 规则**；
//   而 SDK 只把主题 id 报给我（theme.getSnapshot().theme），**自己从不设这个属性**。
//   结果就是：宿主注入的样式一条都不匹配，颜色的唯一来源变成我自己写的兜底值。
//   它不会报错——只会悄悄不跟随。这是最难查的那种坏法。
//
//   所以这里做三件宿主没做的事：
//     1. 把主题 id 打到 <html data-theme="…"> 上，让宿主注入的样式真的生效
//     2. 补一层尺度变量（--space-* / --fs-* / --radius-*）——宿主那份只带颜色，
//        尺度表只在主窗口的 <head> 里，App iframe 拿不到
//     3. 深浅判不出来时，从宿主自己的 --bg 亮度反推，而不是猜 "light"
//
// 事实依据：宿主 renderer 的 themes/*.css 实读 + 生态内 hana-excalidraw
// src/hostTheme.js 与 theme-fallback.css 的实测结论（同一机制的独立验证）。

export const THEME_ATTR = "data-theme";

/** 宿主主题里我们可以依赖的颜色 token。 */
const COLOR_TOKENS = [
  "--bg", "--bg-card", "--sidebar-bg",
  "--text", "--text-light", "--text-muted",
  "--border", "--shadow",
  "--accent", "--accent-hover", "--accent-light", "--accent-rgb",
  "--green", "--coral", "--danger", "--danger-rgb",
  "--overlay-subtle", "--overlay-light", "--overlay-medium", "--overlay-strong",
];

/**
 * 把宿主的当前主题 id 打到 documentElement 上。
 *
 * 这是让那份注入 CSS 生效的开关。**故意不清除属性**：属性缺席时默认主题的
 * `:root:not([data-theme])` 才会生效，删掉属性是"改变"而不是"还原"。
 * 宿主没给 id 时保持现状，比退回默认更稳。
 */
export function syncThemeAttr(themeId, doc) {
  const el = (doc || document)?.documentElement;
  if (!el) return;
  const id = typeof themeId === "string" ? themeId.trim() : "";
  if (!id) return;
  if (el.getAttribute(THEME_ATTR) === id) return;
  el.setAttribute(THEME_ATTR, id);
}

/** '#rgb' / '#rrggbb' / 'rgb()' / 'rgba()' → [r,g,b]，其它返回 null。 */
function parseColor(value) {
  const text = String(value ?? "").trim().toLowerCase();
  if (!text) return null;
  if (text.startsWith("#")) {
    const hex = text.slice(1);
    const body = hex.length === 8 ? hex.slice(0, 6) : hex.length === 4 ? hex.slice(0, 3) : hex;
    if (body.length === 3) {
      const [r, g, b] = body.split("");
      return [parseInt(r + r, 16), parseInt(g + g, 16), parseInt(b + b, 16)];
    }
    if (body.length === 6 && /^[0-9a-f]{6}$/.test(body)) {
      return [parseInt(body.slice(0, 2), 16), parseInt(body.slice(2, 4), 16), parseInt(body.slice(4, 6), 16)];
    }
    return null;
  }
  const fn = text.match(/^rgba?\(([^)]+)\)$/);
  if (fn) {
    const parts = fn[1].split(/[\s,/]+/).filter(Boolean).slice(0, 3);
    if (parts.length < 3) return null;
    const [r, g, b] = parts.map((p) => (p.endsWith("%") ? (parseFloat(p) / 100) * 255 : parseFloat(p)));
    return [r, g, b].every((n) => Number.isFinite(n)) ? [r, g, b] : null;
  }
  return null;
}

/** 按 Rec.709 亮度判这个宿主 token 读起来是浅面还是深面。 */
export function classifyLuminance(value) {
  const rgb = parseColor(value);
  if (!rgb) return null;
  const lum = (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;
  return lum >= 0.5 ? "light" : "dark";
}

/** 宿主真给了 appearance 就用它；没给返回 null（不要把"沉默"折成 light）。 */
export function declaredAppearance(snapshot) {
  const raw = snapshot && snapshot.appearance;
  return raw === "dark" || raw === "light" ? raw : null;
}

/**
 * 从宿主自己的背景 token 反推深浅。
 * 只有在 syncThemeAttr 已经把属性打上之后，这一步读到的才是宿主的值；
 * 否则它读的是本文件的兜底值，等于自问自答。
 */
export function measureAppearance(doc) {
  const d = doc || (typeof document !== "undefined" ? document : null);
  if (!d?.documentElement || typeof getComputedStyle !== "function") return null;
  let style;
  try { style = getComputedStyle(d.documentElement); } catch { return null; }
  for (const name of ["--bg", "--sidebar-bg", "--bg-card"]) {
    const v = classifyLuminance(style.getPropertyValue(name));
    if (v) return v;
  }
  return null;
}

/** 三档收敛到一处，避免各处判断漂移。 */
export function resolveAppearance(snapshot, doc) {
  return declaredAppearance(snapshot) ?? measureAppearance(doc) ?? "light";
}

/**
 * 读出宿主当前实际生效的颜色（用于在无宿主环境下生成等价的内联主题）。
 * 返回 { '--bg': '#...', ... }，只含真拿到值的项。
 */
export function readHostColors(doc) {
  const d = doc || (typeof document !== "undefined" ? document : null);
  if (!d?.documentElement || typeof getComputedStyle !== "function") return {};
  let style;
  try { style = getComputedStyle(d.documentElement); } catch { return {}; }
  const out = {};
  for (const name of COLOR_TOKENS) {
    const v = style.getPropertyValue(name);
    if (v && v.trim()) out[name] = v.trim();
  }
  return out;
}

/**
 * 一行接入：接上宿主主题、订阅变化、暴露深浅 class。
 * 返回一个 { sync } 供调用方在需要时手动重跑。
 */
export function attachHostTheme({ hana, doc, onChange } = {}) {
  const d = doc || (typeof document !== "undefined" ? document : null);
  if (!d) return { sync() {} };

  function sync() {
    let snap = null;
    try { snap = hana?.theme?.getSnapshot?.() || null; } catch { snap = null; }

    // 1) 打主题属性 —— 这一步之前，宿主注入的 CSS 形同不存在
    syncThemeAttr(snap?.theme, d);

    // 2) 深浅 class（给需要自己分叉的样式用）
    const appearance = resolveAppearance(snap, d);
    const el = d.documentElement;
    el.setAttribute("data-appearance", appearance);
    if (d.body) d.body.classList.toggle("t-dark", appearance === "dark");

    // 3) 记下手上有哪些宿主色（调试与无宿主降级都用得上）
    const colors = readHostColors(d);
    el.setAttribute("data-host-theme", snap?.theme || "");
    if (typeof onChange === "function") {
      try { onChange({ theme: snap?.theme || "", appearance, colors }); } catch { /* 忽略 */ }
    }
    return { theme: snap?.theme || "", appearance, colors };
  }

  const first = sync();
  try { hana?.theme?.subscribe?.(() => sync()); } catch { /* 忽略 */ }
  return { sync, initial: first };
}
