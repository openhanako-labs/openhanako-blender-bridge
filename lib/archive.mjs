// 归档层 —— 把一次产出收进一个「run」目录。
//
// 为什么要有它：产物以前散在 work/ 里，命名全靠 stem 拼。同一批的多张图没有
// 共同归属，过两轮就分不清哪张属于哪一版；更麻烦的是「采用/回退」这种决定
// 没有落点——决定了也只是嘴上决定，磁盘上看不出差别。
//
// 所以：一个 run = 一次可交付的产出（一次多视角、一次 QC、一次导出）。
// 目录即单位，run.json 即户口。决定写在 tag 上，从此可查。
//
// 保留策略（用户定：标记制）：
//   - 打了 baseline 标记的永久留
//   - 其余只留最近 N 个（默认 20）
// 先清扫再落盘，是为了让「保留 N 个」在爆发式出图时也有意义。

import {
  mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync,
  existsSync, copyFileSync, statSync, openSync, readSync, closeSync, appendFileSync, renameSync,
} from "node:fs";
import { join, extname, basename, isAbsolute } from "node:path";

export const TAG_BASELINE = "baseline";
export const TAG_DELIVERED = "delivered";
// 有标记的 run 永不会被自动清理。三态是两个标记 + 三种无标记状态，
// 不是新建一个并行字段——现有 tag 已经是「决定写到哪」的地方了。
export const KEEP_TAGS = [TAG_BASELINE, TAG_DELIVERED];
export const DEFAULT_KEEP = 20;

// ── 小工具 ─────────────────────────────────────────────────────────────────

// 20261014T2217 —— 本地时间，人一眼能读。ISO 的 T/Z 在这里只是噪音。
function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}T${p(d.getHours())}${p(d.getMinutes())}`;
}

function slug(s, max = 40) {
  return String(s || "run").trim()
    .replace(/[^\w\u4e00-\u9fa5.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max) || "run";
}

// 同名目录加序号，不覆盖。宁可难看，不可丢东西。
function uniqueDir(root, name) {
  let dir = join(root, name);
  let n = 2;
  while (existsSync(dir)) dir = join(root, `${name}-${n++}`);
  return dir;
}

function readJson(p) {
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; }
}

function isPng(p) {
  // 只嗅魔数，不信扩展名——扩展名是标签，内容是事实
  try {
    const fd = openSync(p, "r");
    const b = Buffer.alloc(8);
    readSync(fd, b, 0, 8, 0);
    closeSync(fd);
    return b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
  } catch { return false; }
}

function dirSize(dir) {
  let total = 0;
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) total += dirSize(p);
      else { try { total += statSync(p).size; } catch { /* 跳过 */ } }
    }
  } catch { /* 忽略 */ }
  return total;
}

// ── 归档器 ─────────────────────────────────────────────────────────────────

export function createRunStore({ root, log = () => {}, warn = () => {} }) {
  mkdirSync(root, { recursive: true });

  // 开一个 run。此时只建目录，产物边做边放——中途崩了也留下现场。
  function begin({ label = "run", action = "unknown", meta = {} } = {}) {
    const dir = uniqueDir(root, `${stamp()}_${slug(label)}`);
    mkdirSync(dir, { recursive: true });
    const run = {
      id: basename(dir),
      dir,
      action,
      label,
      createdAt: new Date().toISOString(),
      tag: null,
      parent: meta.parent || null,
      meta,
      files: {},
    };
    writeRun(run);
    log(`run 已开：${run.id}`);
    return run;
  }

  function writeRun(run) {
    // 体积在落盘时算，不靠调用方记——账要能自洽
    const json = { ...run, bytes: dirSize(run.dir) };
    delete json.dir;
    writeFileSync(join(run.dir, "run.json"), JSON.stringify(json, null, 2));
    return json;
  }

  // 把产物收进来。kind 决定落哪个子目录，是给人看的分组，也是给程序找的锚点。
  //   hero    → hero.png（主图，验收第一眼看的）
  //   view    → views/
  //   qc      → qc/
  //   export  → export/
  //   proof   → proof/（对照图、参考照之类）
  // kind → 子目录。
  //
  // ！从前这里是一串嵌套三元，最后兜底到 "proof"：
  //     kind === "view" ? "views" : kind === "export" ? "export" : kind === "qc" ? "qc" : "proof"
  //   后果：新加的 kind（实测 model）会**静默落进 proof/**——
  //   不报错、不警告，只是东西存到了不相干的地方。
  //   一份 GLB 躺在 proof/ 里，谁也看不懂。
  //   改成查表 + 未知名开自己的目录（至少不会放错地方）。
  const KIND_DIR = { view: "views", export: "export", qc: "qc", model: "model", scene: "scene", proof: "proof" };
  function kindSubdir(kind) {
    const k = String(kind || "view");
    return KIND_DIR[k] || k;   // 未知名用自己当目录名，而不是偷偷塞进 proof
  }

  function put(run, { from, kind = "view", name = null, note = null, overwrite = false } = {}) {
    if (!from) return null;
    if (typeof from === "string" && from.startsWith("data:")) {
      return putBuffer(run, Buffer.from(from.split(",")[1] || "", "base64"), { kind, name, note, overwrite });
    }
    try {
      if (!existsSync(from)) { warn(`归档源不存在，跳过：${from}`); return null; }
      const kindDir = kind === "hero" ? run.dir : join(run.dir, kindSubdir(kind));
      mkdirSync(kindDir, { recursive: true });
      const base = name ? slug(name, 48) : slug(basename(from, extname(from)), 48);
      const ext = extname(from) || ".png";
      let dest = join(kindDir, kind === "hero" ? "hero.png" : base + ext);
      // overwrite：同名就顶掉，不开新档。
      //
      // ！为何需要它：视图（kind=view）代表“这一版的某个方位”，是**同一个位置的东西**。
      //   而默认逻辑是“撞名就加 -2”——那是给“一次跑出多张平行产物”用的。
      //   两者混在一起的后果实测过：
      //     拍两次 → iso.png + iso-2.png；拍十次 → 堆到 iso-10。
      //   更麻烦的是 -2 那些**清理不掉**：按方位匹配时
      //   "iso-2" !== "iso"，于是旧图永远留在盘上，缓存也会命中错的那张。
      let replaced = null;
      if (overwrite && existsSync(dest)) {
        replaced = dest;
      } else {
        let n = 2;
        while (existsSync(dest)) dest = join(kindDir, `${base}-${n++}${ext}`);
      }
      copyFileSync(from, dest);
      const rel = dest.slice(run.dir.length + 1).replace(/\\/g, "/");
      // 顶掉的时候，旧的那条记录也得一并除名，否则 run.json 会同时记着
      // 同名的新旧两条（实测出现过 12 条里 4 条重复）。
      const prior = (run.files[kind] || []).filter((f) => f.rel === rel);
      if (prior.length) run.files[kind] = run.files[kind].filter((f) => f.rel !== rel);
      (run.files[kind] ||= []).push({ rel, bytes: statSync(dest).size, note });
      writeRun(run);
      return rel;
    } catch (e) {
      warn(`归档失败（${kind}）：${e?.message || e}`);
      return null;
    }
  }

  function putBuffer(run, buf, { kind = "view", name = null, note = null, overwrite = false } = {}) {
    try {
      const kindDir = kind === "hero" ? run.dir : join(run.dir, kindSubdir(kind));
      mkdirSync(kindDir, { recursive: true });
      const base = slug(name || "image", 48);
      let dest = join(kindDir, kind === "hero" ? "hero.png" : base + ".png");
      if (!overwrite) {
        let n = 2;
        while (existsSync(dest)) dest = join(kindDir, `${base}-${n++}.png`);
      }
      writeFileSync(dest, buf);
      const rel = dest.slice(run.dir.length + 1).replace(/\\/g, "/");
      if (overwrite) run.files[kind] = (run.files[kind] || []).filter((f) => f.rel !== rel);
      (run.files[kind] ||= []).push({ rel, bytes: buf.length, note });
      writeRun(run);
      return rel;
    } catch (e) {
      warn(`归档失败（buffer/${kind}）：${e?.message || e}`);
      return null;
    }
  }

  // 记一笔意见。
  // 为什么不能只存 localStorage：那是浏览器本地的，换台机器、清个缓存就没了。
  // 意见是「下一版的输入」——它必须比浏览器活得久，否则写它等于没写。
  // 存成 runs/<id>/feedback.md，一条一行，带时间。
  function feedback(run, text) {
    const t = String(text || "").trim();
    if (!t) return null;
    const line = `- ${new Date().toISOString()} ${t.replace(/\s+/g, " ")}\n`;
    const p = join(run.dir, "feedback.md");
    try {
      appendFileSync(p, line);
      run.feedbackAt = new Date().toISOString();
      writeRun(run);
      return line.trim();
    } catch (e) {
      warn(`意见写失败：${e?.message || e}`);
      return null;
    }
  }

  function readFeedback(run) {
    try { return readFileSync(join(run.dir, "feedback.md"), "utf8").trim(); }
    catch { return ""; }
  }

  // 记账本是给人看的散文，不是给机器查的 KV——机器看 run.json。
  function writeNotes(run, notes) {
    try {
      writeFileSync(join(run.dir, "notes.md"), String(notes || "").trim() + "\n");
    } catch (e) { warn(`notes.md 写失败：${e?.message || e}`); }
  }

  function finish(run, patch = {}) {
    Object.assign(run, patch);
    run.finishedAt = new Date().toISOString();
    const json = writeRun(run);
    log(`run 已收：${run.id}（${json.bytes} bytes）`);
    return json;
  }

  function list({ limit = 50 } = {}) {
    let names = [];
    try { names = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); }
    catch { return []; }
    const runs = [];
    for (const n of names) {
      const j = readJson(join(root, n, "run.json"));
      if (!j) continue;
      const item = { ...j, id: j.id || n, dir: join(root, n) };
      // 列表里带上 notes / feedback：面板选中时不用再发一次请求
      try { item.notes = readFileSync(join(root, n, "notes.md"), "utf8").trim(); } catch { /* 没写就算了 */ }
      try { item.feedback = readFileSync(join(root, n, "feedback.md"), "utf8").trim(); } catch { /* 没写就算了 */ }
      runs.push(item);
    }
    // createdAt 可能撞在同一毫秒（批量开 run 时很常见），退了再用 id 比。
    // 不清这个并列，prune 会清掉谁就变得随机——而它清的是数据。
    runs.sort((a, b) => {
      const t = String(b.createdAt || "").localeCompare(String(a.createdAt || ""));
      return t !== 0 ? t : String(b.id || "").localeCompare(String(a.id || ""));
    });
    return runs.slice(0, limit);
  }

  function get(id) {
    const dir = join(root, String(id));
    const j = readJson(join(dir, "run.json"));
    if (!j) return null;
    const out = { ...j, id: j.id || String(id), dir };
    // notes.md 是正文，不进 run.json（人写的东西不该被 JSON 转义折腾）
    try { out.notes = readFileSync(join(dir, "notes.md"), "utf8").trim(); } catch { /* 没写就算了 */ }
    try { out.feedback = readFileSync(join(dir, "feedback.md"), "utf8").trim(); } catch { /* 没写就算了 */ }
    return out;
  }

  // 标记即决定。基线是唯一的硬承诺，其余标记随保留策略一起走。
  function tag(id, value) {
    const run = get(id);
    if (!run) return null;
    run.tag = value || null;
    delete run.dir;    const json = { ...run, bytes: dirSize(join(root, String(id))) };
    writeFileSync(join(root, String(id), "run.json"), JSON.stringify(json, null, 2));
    log(`run ${id} 标记为 ${value || "（无）"}`);
    return json;
  }

  // 清扫：基线永久留，其余留最近 keep 个。
  // 先按时间排，再决定谁走——不靠目录名排序（名字里是同分钟的时间戳，会撞）。
  function prune({ keep = DEFAULT_KEEP, dryRun = false } = {}) {
    const all = list({ limit: 100000 });
    const untagged = all.filter((r) => !r.tag);
    const doomed = untagged.slice(keep);
    const kept = [];
    const removed = [];
    for (const r of doomed) {
      if (dryRun) { removed.push(r.id); continue; }
      try { rmSync(r.dir, { recursive: true, force: true }); removed.push(r.id); log(`清扫：${r.id}`); }
      catch (e) { warn(`清扫失败 ${r.id}：${e?.message || e}`); kept.push(r.id); }
    }
    return {
      total: all.length,
      tagged: all.filter((r) => r.tag).length,
      removed,
      kept: all.length - removed.length,
    };
  }

  // 单条删除。
  //
  // 为何要有它：prune 只能按数量保留最近 N 个，而人想删的往往不是最旧的
  //   （实测：最占地方的那几个恰好都是近期产物，keep=20 永远碰不到）。
  //
  // 为何是移到 trash/ 而不是 rmSync：删错了能捡回来。prune 用的 rmSync 是既存行为，不改。
  function removeOne(id, { dryRun = false } = {}) {
    const all = list({ limit: 100000 });
    const hit = all.find((r) => r.id === String(id));
    if (!hit) return { ok: false, error: `没有这个 run：${id}` };
    if (dryRun) return { ok: true, dryRun: true, id: hit.id, dir: hit.dir };
    const trashRoot = join(root, ".trash");
    try {
      mkdirSync(trashRoot, { recursive: true });
      // 带上时间戳，同名不会撞；也便于事后认出是哪次删的
      const dest = join(trashRoot, `${hit.id}_${Date.now().toString(36)}`);
      renameSync(hit.dir, dest);
      log(`移除：${hit.id} -> .trash`);
      return { ok: true, id: hit.id, trashed: dest };
    } catch (e) {
      warn(`移除失败 ${hit.id}：${e?.message || e}`);
      return { ok: false, error: String(e?.message || e) };
    }
  }

  // trash 里有什么（能捡回来）
  function listTrash() {
    const trashRoot = join(root, ".trash");
    if (!existsSync(trashRoot)) return [];
    return readdirSync(trashRoot, { withFileTypes: true })
      .filter((e2) => e2.isDirectory())
      .map((e2) => ({ name: e2.name, dir: join(trashRoot, e2.name) }));
  }

  // 从 trash 捞回来
  function restoreOne(name) {
    const trashRoot = join(root, ".trash");
    const src = join(trashRoot, String(name));
    if (!existsSync(src)) return { ok: false, error: `restore 里没有：${name}` };
    // 原名 = 去掉最后那段 _<时间戳>
    const orig = String(name).replace(/_[0-9a-z]+$/, "");
    const dest = join(root, orig);
    try {
      if (existsSync(dest)) return { ok: false, error: `目标已存在：${orig}（先改个名再恢复）` };
      renameSync(src, dest);
      log(`恢复：${orig}`);
      return { ok: true, id: orig };
    } catch (e) {
      return { ok: false, error: String(e?.message || e) };
    }
  }

  // 真删 trash（不可恢复）
  function purgeTrash() {
    const items = listTrash();
    let n = 0;
    for (const it of items) {
      try { rmSync(it.dir, { recursive: true, force: true }); n += 1; } catch (e) { warn(`清 trash 失败 ${it.name}：${e?.message || e}`); }
    }
    return { ok: true, purged: n };
  }

  function stats() {
    const all = list({ limit: 100000 });
    const byTag = {};
    for (const r of all) {
      const k = r.tag || '(无标记)';
      byTag[k] = (byTag[k] || 0) + 1;
    }
    return {
      root,
      total: all.length,
      tagged: all.filter((r) => r.tag).length,
      byTag,
      withFeedback: all.filter((r) => r.feedback).length,
      bytes: all.reduce((s, r) => s + (r.bytes || 0), 0),
      latest: all.slice(0, 5).map((r) => ({ id: r.id, label: r.label, tag: r.tag, createdAt: r.createdAt })),
    };
  }

  return { root, begin, put, putBuffer, writeNotes, feedback, readFeedback, finish, list, get, tag, prune, stats, writeRun,
    removeOne, listTrash, restoreOne, purgeTrash };
}
