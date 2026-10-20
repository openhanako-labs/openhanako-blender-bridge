/**
 * 零件干涉探针：一份 python + 判定在 JS。
 *
 * ── 为什么单独成文件（2026-10-20）────────────────────────────────────────
 *
 * 这段探针原先在 index.js 里有**两份副本**：
 *   · `audit op=collide`（较全，带 allow / 排序）
 *   · `do check=collide`（较简，少了 allow 与排序）
 * 两份已经开始漂移，而且其中一个 bug 只出现在其中一份上
 * （`check=collide` 把回执对象直接 String()，产出 `[object Object]`）。
 * 一份代码写两遍，就是等着「同一个 bug 修一处漏一处」。
 *
 * ── 同时修掉一个判据错误 ─────────────────────────────────────────────────
 *
 * 旧写法把「包含」判成**尺寸包含**：
 *     contains = all(da[i] >= db[i]) or all(db[i] >= da[i])
 * 那只说明 b 尺寸比 a 小，**不说明 b 真的在 a 里面**。
 * 实测：一条臂插进躯干一半 —— 臂三个方向都小于躯干，于是被判成
 * 「一个包住了另一个，多半尺寸弄反」，而这个提示本身是错的。
 *
 * 新版用**空间包含**：b 在 a 内 ⟺ a 的包围盒三个方向都把 b 包住。
 * 判定挪到 JS，可以喂合成数据直接测（见 _probe/collide-probe.test.mjs）。
 */

/** 生成在 Blender 主线程跑的探针脚本。 */
export function buildCollideScript({ eps = 0.0005, allow = [], maxPairs = 60 } = {}) {
  return [
    "import bpy, itertools, json",
    "from mathutils import Vector",
    "def _bb(o):",
    "    lo = Vector((1e18,)*3); hi = Vector((-1e18,)*3)",
    "    for c in o.bound_box:",
    "        w = o.matrix_world @ Vector(c)",
    "        for i in range(3):",
    "            lo[i]=min(lo[i],w[i]); hi[i]=max(hi[i],w[i])",
    "    return lo,hi",
    "objs = [o for o in bpy.context.scene.objects if o.type=='MESH' and not o.hide_viewport]",
    "bb = {o.name: _bb(o) for o in objs}",
    "EPS = " + JSON.stringify(eps),
    "ALLOW = set(" + JSON.stringify(allow) + ")",
    "def allowed(a, b):",
    "    return (a in ALLOW) or (b in ALLOW) or ((a + '|' + b) in ALLOW) or ((b + '|' + a) in ALLOW)",
    "hits = []",
    "for a, b in itertools.combinations(sorted(bb), 2):",
    "    la, ha = bb[a]; lb, hb = bb[b]",
    "    d = [min(ha[i], hb[i]) - max(la[i], lb[i]) for i in range(3)]",
    "    if not all(v > EPS for v in d):",
    "        continue",
    "    da = [ha[i]-la[i] for i in range(3)]",
    "    db = [hb[i]-lb[i] for i in range(3)]",
    "    # ！空间包含，不是尺寸包含。",
    "    #   旧写法看的是「a 三向都比 b 大」——那只说明 b 尺寸小，",
    "    #   不说明 b 在里面。实测：臂插进躯干一半，臂三向都小于躯干，",
    "    #   于是被误标成「包住」，并给出「尺寸弄反」这种误导提示。",
    "    a_in_b = all(lb[i] <= la[i] + EPS and hb[i] >= ha[i] - EPS for i in range(3))",
    "    b_in_a = all(la[i] <= lb[i] + EPS and ha[i] >= hb[i] - EPS for i in range(3))",
    "    inner = 'a' if a_in_b else ('b' if b_in_a else None)",
    "    thin_mm = round(min(d)*1000, 2)",
    "    hits.append({'a': a, 'b': b, 'overlap_mm': [round(v*1000, 2) for v in d],",
    "                 'vol_mm3': round(d[0]*d[1]*d[2]*1e9, 1), 'thinnest_mm': thin_mm,",
    "                 'flat_a': round(min(da)*1000, 2), 'flat_b': round(min(db)*1000, 2),",
    "                 'inner': inner, 'allowed': allowed(a, b)})",
    "hits.sort(key=lambda h: -h['vol_mm3'])",
    "print('DSH_COLLIDE ' + json.dumps({",
    "    'ok': True, 'objects': len(objs), 'pairs': len(hits),",
    "    'blocking': [h for h in hits if not h['allowed']][:" + JSON.stringify(maxPairs) + "],",
    "}, ensure_ascii=False))",
  ].join("\n");
}

/** 回执里那个 JSON 的标记。 */
export const COLLIDE_MARKER = "DSH_COLLIDE";

/**
 * 从 /do 的 stdout 里取出回执。
 * @param {string} stdout
 * @returns {object|null}
 */
export function parseCollide(stdout) {
  const m = new RegExp(COLLIDE_MARKER + " (\\{[\\s\\S]*\\})\\s*$").exec(String(stdout || "").trim());
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

/**
 * 把相交分两档：拦截（blocking）与剥蚀（grazing = 拼缝 / 装配接触）。
 *
 * 判据看**形状**而不是重叠多少：
 *   两个零件都是薄壳，且互相搭一截 → 拼缝（板与板的正常搭接）
 *   其中一个是厚实体 → 真干涉
 * 空间包含的单列出来（那是尺寸/坐标搞错，另一种病）。
 *
 * @param {object[]} blocking 相交清单（探针的 blocking）
 * @param {object}  [opts]
 * @param {number}  [opts.seamMm=12]      判定"薄壳"的板厚量级
 * @param {boolean} [opts.skipGrazing=true] 是否过滤掉拼缝
 */
export function classifyHits(blocking, opts = {}) {
  const seamMm = Number.isFinite(opts.seamMm) ? opts.seamMm : 12;
  const skipGrazing = opts.skipGrazing !== false;
  const list = Array.isArray(blocking) ? blocking : [];

  const isSeam = (h) => {
    if (h && h.inner) return false;                       // 空间包含绝不归为拼缝
    const aFlat = Number(h && h.flat_a) <= seamMm;
    const bFlat = Number(h && h.flat_b) <= seamMm;
    return aFlat && bFlat;
  };

  const shown = skipGrazing ? list.filter((h) => !isSeam(h)) : list.slice();
  return { shown, grazing: list.length - shown.length, isSeam };
}

/** 单条相交的一句话说明（两种调用方共用）。 */
export function hitTag(h) {
  return h && h.inner ? "｜一个包住了另一个（空间包含，多半尺寸或坐标弄反）" : "";
}

/** 单条相交的一行明细。 */
export function hitLine(h) {
  const ov = Array.isArray(h.overlap_mm) ? h.overlap_mm.join("×") : "?";
  return `${h.a} × ${h.b}：重叠 ${ov} mm（最薄 ${h.thinnest_mm}mm），${h.vol_mm3} mm³${hitTag(h)}`;
}

/** 碰撞结论：PASS / FAIL + 行数组。`do check=collide` 用这个拼回执。 */
export function collideVerdict(parsed, opts = {}) {
  const seamMm = Number.isFinite(opts.seamMm) ? opts.seamMm : 12;
  if (!parsed) return { verdict: "⚠ 无回执", lines: ["探针没吐回执——检查 Blender 是否在跑。"] };
  const blocking = parsed.blocking || [];
  const { shown, grazing } = classifyHits(blocking, { seamMm, skipGrazing: true });
  const head = `${parsed.objects} 个网格 · ${parsed.pairs} 处相交`;
  if (!shown.length) {
    const lines = [`${head}`, "无需要处理的干涉"];
    if (grazing > 0) lines.push(`（另有 ${grazing} 处拼缝/装配接触，两个零件都是薄壳，不视为干涉）`);
    return { verdict: `✅ PASS`, lines };
  }
  const lines = [`${head}`, `需要处理 ${shown.length} 处：`];
  for (const h of shown.slice(0, 10)) lines.push(`  · ${hitLine(h)}`);
  if (shown.length > 10) lines.push(`  …另有 ${shown.length - 10} 处`);
  return { verdict: `❌ FAIL`, lines };
}
