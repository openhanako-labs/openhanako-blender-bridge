// ui/assets/workbench.js — Blender 助手 · 整页工作台
//
// 取数必须走 hana.api.fetch，不能裸 fetch：
// 宿主把 App 路由挂在 /api/apps/<appId>/routes 下，且要带 appSurfaceSession 凭证。
// 裸 fetch 拿不到会话 → 403（不报错，只是取不到数据，页面上表现为"取不到 xx"）。
import { hana } from './sdk.js';
// 设置面板。原先挂在宿主的设置页，现在搬进本卡片的「设置」标签 ——
// 那份模块自己读/写 #host / #save / #deliver / #prune 这些 id，
// 它们就在本页的 #p-settings 里（模块脚本在 DOM 解析之后才执行，所以接得上）。
import './settings.js';

const $ = (id) => document.getElementById(id);

// ── 取数 ──────────────────────────────────────────────────────────────────
//
// ！这个函数兼管日志。放在这里而不是各调用点，是因为：
//   日志的价值在于「事后能查出发生了什么」，而“哪个调用点忘了记”是查不出来的。
//   实测教训：用户在派活栏碰到 Internal Server Error，
//   而日志页只有「派活：炮口再长一点」这种——
//   没有 URL、没有状态码、没有响应体，根本没法定位。
//
// 记什么（四条，少一条就查不下去）：
//   去哪（方法 + 路径）、回什么（状态码）、花了多久、失败时说清原因。
//
// 不记成功请求的响应体：那不是日志，那是数据。
let LOG_SINK = null;   // 由下方接上 logLine，避免函数声明顺序问题

// Promise 超时闸。
//
// 为什么必须有：宿主桥的 fetch 在极端情况下**不返回也不报错**——
// 实测过一次，「派活」发出后卡片按钮永远停在「派发中…」。
// 因为 后端每个 bus.request 有 8-15s 超时，而前端这条链上一个都没有，
// 所以任何一环挂死，调用方的 .then/.catch 都不触发，UI 就冻在那里。
//
// 超时后 reject，让 UI 能说「没回来」，而不是永远「在忙」。
function withTimeout(promise, ms, label) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label || '请求'}超时（${Math.round(ms / 1000)}s 未应答）`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => { if (timer) clearTimeout(timer); });
}

async function api(path, body) {
  const init = body === undefined
    ? { cache: 'no-store' }
    : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
  const method = body === undefined ? 'GET' : 'POST';
  const t0 = Date.now();
  let r;
  try {
    // ！总超时：后端每个 bus.request 都有 8-15s 超时，但**前端没有**。
    //   宿主桥一旦不返回（session:send-custom 带 triggerTurn 会在宿主侧
    //   真起一轮对话，那条路径挂死过一次），Promise 就悬着，
    //   调用方的 .then/.catch 都不触发——按钮永远停在「派发中…」。
    //   所以这里加一道闸：超时就 reject，让人看到「没回来」而不是「一直在忙」。
    r = await withTimeout(hana.api.fetch(path, init), 45000, `${method} ${path}`);
  } catch (e) {
    // 连请求都没发出去（凭证缺失、网络层报错）——这比 HTTP 错误更难查，单独记
    if (LOG_SINK) LOG_SINK(`✗ ${method} ${path} 未送达（${Math.round(Date.now() - t0)}ms）：${e}`);
    throw e;
  }
  const t = await r.text();
  const ms = Math.round(Date.now() - t0);
  let parsed = null;
  try { parsed = t ? JSON.parse(t) : null; }
  catch {
    // 响应不是 JSON，而这条 App 的所有路由都返回 JSON——
    // 所以走到这里意味着请求压根没进我的代码（宿主的兜底页、网关错误）。
    // 这类情况以前完全看不见，正是“Internal Server Error”那个坑的藏身处。
    if (LOG_SINK) {
      LOG_SINK(`✗ ${method} ${path} → ${r.status} ${r.statusText || ''}（${ms}ms）`
        + `｜响应不是 JSON：${String(t).slice(0, 120).replace(/\s+/g, ' ')}`);
    }
    return { ok: false, error: String(t).slice(0, 300), _status: r.status, _nonJson: true };
  }
  // 失败的记全；成功的只记一行，不碍眼
  if (LOG_SINK) {
    if (!r.ok || (parsed && parsed.ok === false)) {
      LOG_SINK(`✗ ${method} ${path} → ${r.status}（${ms}ms）｜${String((parsed && parsed.error) || '').slice(0, 140)}`);
    } else if (ms > 3000) {
      // 慢而成功的也值得留一笔：它解释“为什么刚才卡了一下”
      LOG_SINK(`· ${method} ${path} → ${r.status}（${ms}ms，慢）`);
    }
  }
  return parsed;
}

const state = { runs: [], runsSig: "", cur: null, viewAngle: 'iso', scene: [], sceneSig: "" };

function setMsg(t, busy) {
  // 空闲时不写字：相位已经由旁边那个 chip 表达，
  // 两个都写「就绪」看着像出了重复渲染的毛病。
  const m = $('msg'); if (m) m.textContent = busy ? t : '';
  const d = $('dot'); if (d) d.className = 'dot' + (busy ? ' run' : '');
}

// 短暂提示：说完自动淡出，不占着地方
let msgTimer = null;
function flashMsg(t) {
  const m = $('msg'); if (!m) return;
  m.textContent = t;
  clearTimeout(msgTimer);
  msgTimer = setTimeout(() => { m.textContent = ''; }, 3200);
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function fmtBytes(n) {
  n = Number(n) || 0;
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}

// 时间必须是本地时间。run.json 存 UTC ISO，直接切字符串会少 8 小时——
// 这种错不报错，只是静静地给你看错的时间。
function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso).slice(0, 16);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ── 主题跟随 ──────────────────────────────────────────────────────────────
// 主题名显示在宿主侧栏；这里只负责把 data-theme 打到 <html> 上——
// 那一步才是让宿主注入的颜色真正生效的开关。
// （宿主那十套主题全写成 [data-theme="<id>"] 选择器，而 SDK 自己从不设这个属性：
//   不设 = 静默退回兜底色，不报错。）
let hostThemeName = '';
(async () => {
  try {
    await hana.ready();
    const ht = await import('./host-theme.js');
    ht.attachHostTheme({
      hana,
      onChange: (info) => {
        hostThemeName = (info && info.theme) || '';
      },
    });
  } catch { /* 无宿主：兜底色板 */ }
})();

// ── 标签切换 ──────────────────────────────────────────────────────────────
function showTab(t) {
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.t === t));
  document.querySelectorAll('.wb-pane').forEach((p) => p.classList.toggle('on', p.id === 'p-' + t));
  if (history.replaceState) history.replaceState(null, '', '#' + t);
}
document.querySelectorAll('#tabs button').forEach((b) => { b.onclick = () => showTab(b.dataset.t); });
(function initTab() {
  const h = location.hash.replace(/^#/, '');
  if (['runs', 'view', 'exec', 'log'].includes(h)) showTab(h);
})();

// ── 通道状态 ──────────────────────────────────────────────────────────────
// 状态展示在宿主侧栏（manifest 的 functionPanel → sidepanel.html）。
// 本页只留一个相位指示器；查状态是为了让顶栏提示是真值。
// 每个元素先判存在——页面布局变了不会报错。
async function loadStatus() {
  let s;
  try { s = await api('/blender-bridge/status'); } catch { s = null; }
  // 顶栏与侧栏必须一个口径。
  // 之前这里也把 phase==="ready" 当“就绪”，于是侧栏说「卡在 TCP」、
  // 顶栏说「就绪」——同一屏两个说法。两处都改同一份真相（steps）。
  const phase = (s && s.phase) || '—';
  const relayUp = phase === 'ready';
  const st = (s && s.steps) || {};
  const done = [st.relay, st.service, st.tcp, st.addon, st.bpy].filter(Boolean).length;
  const allOk = relayUp && done === 5;
  const p = $('phase-mini');
  if (p) {
    p.className = 'chip' + (allOk ? ' ok' : (phase === 'error' ? ' bad' : (relayUp ? '' : ' bad')));
    p.textContent = allOk ? '通道可用'
      : (relayUp ? `${done}/5` : (phase === 'starting' ? '启动中' : (phase === 'error' ? '出错' : '未启动')));
  }
  state.phase = phase;
  return s;
}

// ── 归档 ──────────────────────────────────────────────────────────────────
// 签名：只用“列表本身长什么样”算，不含选中状态。
// 用它判断“要不要重绘”——轮询不该把用户正在看的那一版、正在写的意见冲掉。
function runsSig(runs) {
  return runs.map((x) => `${x.id}:${x.tag || ""}:${x.bytes || 0}`).join("|");
}

// opts.silent = 后台轮询用：列表没变就什么都不做
async function loadRuns(keepSel, opts) {
  const silent = !!(opts && opts.silent);
  let r;
  try { r = await api('/blender-bridge/runs'); } catch { r = null; }
  if (!r || r.ok === false) {
    // 后台轮询失败不报——网络抰一下不该在界面上刷红字
    if (!silent) $('rlist').innerHTML = '<div class="wb-rli muted">取不到归档列表</div>';
    return;
  }
  const next = r.runs || [];
  const sig = runsSig(next);
  // 内容一样：后台轮询就安静退场；手动刷新仍然走完整重绘
  if (silent && sig === state.runsSig) return;
  state.runsSig = sig;
  state.runs = next;
  $('lcnt').textContent = state.runs.length + ' 个';

  const box = $('rlist');
  if (!state.runs.length) {
    box.innerHTML = '<div class="wb-rli muted">还没有产出</div>';
    $('empty').hidden = false;
    $('dbody').hidden = true;
    return;
  }
  box.innerHTML = state.runs.map((x) =>
    `<div class="wb-rli${state.cur && state.cur.id === x.id ? ' on' : ''}" data-id="${esc(x.id)}">`
    + `<div class="wb-rli-h"><span class="star">${x.tag ? '★' : ''}</span>`
    + `<span class="wb-rli-t">${esc(x.label || x.id)}</span></div>`
    + `<div class="wb-rli-m">${esc(x.action || '')}${x.bytes ? ' · ' + fmtBytes(x.bytes) : ''}</div>`
    + '</div>').join('');
  box.querySelectorAll('.wb-rli[data-id]').forEach((el) => {
    el.onclick = () => selectRun(el.dataset.id);
  });

  const want = keepSel || (state.cur && state.cur.id);
  if (want && state.runs.some((x) => x.id === want)) { selectRun(want); return; }
  selectRun(state.runs[0].id);
}
// 一版里的所有图片产物都当缩略图摆出来——切图看的是同一批东西，
// 不用回去翻文件列表。点哪张，大图就换成哪张。
let curShots = [];   // [{label, mime, data}]
let notesOpen = false;

async function selectRun(id) {
  const run = state.runs.find((x) => x.id === id);  if (!run) return;
  state.cur = run;
  document.querySelectorAll('.wb-rli[data-id]').forEach((el) => {
    el.classList.toggle('on', el.dataset.id === id);
  });
  $('empty').hidden = true;
  $('dbody').hidden = false;
  // 切换产出时把重拍确认条收掉：
  // 那句话是“针对某一版”说的，留着会跟新选中的那版对不上。
  const _sc = $('d-shoot-confirm');
  if (_sc) _sc.hidden = true;
  $('d-label').textContent = run.label || run.id;
  $('d-id').textContent = run.id + (run.tag ? `　·　${run.tag}` : '');
  $('d-untag').disabled = !run.tag;
  $('d-baseline').disabled = run.tag === 'baseline';

  const cells = [
    ['动作', run.action || '—'],
    ['创建', fmtTime(run.createdAt)],
    ['收口', run.finishedAt ? fmtTime(run.finishedAt) : '未收口'],
    ['体积', fmtBytes(run.bytes)],
    ['状态', run.tag === 'baseline' ? '已采用' : run.tag === 'delivered' ? '已投递'
      : run.tag ? run.tag : '草稿'],
  ];
  $('d-meta').innerHTML = cells.map((c) =>
    `<div class="wb-cell"><div class="k">${esc(c[0])}</div><div class="v">${esc(c[1])}</div></div>`).join('');

  // ── 产物 → 缩略图 + 文件列表 ──
  const files = run.files || {};
  const rows = [];
  const imgs = [];
  const IMG_RE = /\.(png|jpe?g|webp|bmp|gif)$/i;
  Object.keys(files).forEach((kind) => {
    (files[kind] || []).forEach((f) => {
      rows.push(`<div class="frow"><span class="ic">${esc(kind)}</span>`
        + `<span class="nm">${esc(f.rel)}</span><span></span>`
        + `<span class="sz">${fmtBytes(f.bytes)}</span></div>`);
      if (IMG_RE.test(f.rel || '')) imgs.push({ kind, rel: f.rel });
    });
  });
  $('d-files').innerHTML = rows.length ? rows.join('')
    : '<div class="frow"><span class="ic"></span><span class="nm">（没有产物记录）</span><span></span><span></span></div>';
  const fc = $('d-fcount');
  if (fc) fc.textContent = rows.length ? String(rows.length) : '';

  // 依次取图。取不到就跳过——不摆占位图骗人。
  curShots = [];
  for (const im of imgs) {
    try {
      const a = await api('/blender-bridge/runs/asset?id=' + encodeURIComponent(run.id)
        + '&rel=' + encodeURIComponent(im.rel));
      if (a && a.ok && a.image) {
        curShots.push({
          kind: im.kind, rel: im.rel,
          label: String(im.rel).replace(/\.[^.]+$/, ''),
          mime: a.mimeType || 'image/png',
          data: a.image,
        });
      }
    } catch { /* 单张取不到不影响其他的 */ }
  }
  renderShots();

  const nh = $('d-notes-h'), np = $('d-notes');
  // 备注默认折叠：它很长，展开着会把右栏顶穿。
  if (run.notes) {
    np.textContent = plainNotes(run.notes);
    notesOpen = false;
    np.hidden = true;
    nh.hidden = false;
    const n = $('d-notes-n');
    if (n) n.textContent = `${String(run.notes).split('\n').length} 行`;
    const t = $('d-notes-toggle');
    if (t) { t.hidden = false; t.textContent = '展开'; }
  } else {
    np.hidden = true; nh.hidden = true;
  }

  // 之前写下的意见：服务端存的，不只浏览器本地——
  // localStorage 换台机器就没了，那不叫意见有落点。
  const fbBox = $('d-fb'), fbEmpty = $('d-fb-empty');
  const n = (run.feedback || '').split('\n').filter((x) => x.trim()).length;
  if (fbBox) {
    if (run.feedback) { fbBox.textContent = plainFeedback(run.feedback); fbBox.hidden = false; }
    else { fbBox.hidden = true; }
  }
  if (fbEmpty) fbEmpty.hidden = !!run.feedback;
  const fbc = $('d-fbcount');
  if (fbc) fbc.textContent = n ? String(n) : '';

  $('d-note').value = '';
  $('d-hint').textContent = '回车提交（Shift+回车换行）';
}

// 备注盘上存的是 markdown，但这里只是一块窄栏，不是渲染器。
// 直接把 # ## - 露出来，在 208px 宽里就是没洗的菜。
// 只去标记，不做排版——真要看原文有文件。
function plainNotes(md) {
  return String(md || '')
    .split('\n')
    .map((l) => l.replace(/^\s{0,3}#{1,6}\s*/, '')
      .replace(/^\s{0,3}[-*+]\s+/, '· ')
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/`([^`]+)`/g, '$1'))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// 意见盘上是 `- 2026-10-15T10:06:14.062Z 炮口再长一点` 这种行。
// 直接摆给人看就是“机器日志”。把时间戳解析成本地时间再显示，
// 不报错、只是静静给看错的时间/看不懂的东西——两种都不行。
function plainFeedback(txt) {
  return String(txt || '').split('\n').map((l) => {
    const m = l.match(/^\s*-\s*(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s*(.*)$/);
    if (!m) return l;
    const d = new Date(m[1]);
    if (isNaN(d.getTime())) return l;
    const p = (n) => String(n).padStart(2, '0');
    const t = `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    return `· ${m[2]}  ${t}`;
  }).join('\n').trim();
}

// 取四个角的平均色。失败就退回原底色——不因为一个装饰性细节而报错。
function sampleEdgeColor(img, stage) {
  const apply = () => {
    try {
      const S = 8;
      const c = document.createElement('canvas');
      c.width = S; c.height = S;
      const g = c.getContext('2d');
      g.drawImage(img, 0, 0, S, S);
      const d = g.getImageData(0, 0, S, S).data;
      let r = 0, gg = 0, b = 0, n = 0;
      // 只取最外一圈，中间的不算（中间是模型，不是背景）
      for (let y = 0; y < S; y++) {
        for (let x = 0; x < S; x++) {
          const edge = x === 0 || y === 0 || x === S - 1 || y === S - 1;
          if (!edge) continue;
          const i = (y * S + x) * 4;
          r += d[i]; gg += d[i + 1]; b += d[i + 2]; n++;
        }
      }
      if (!n) return;
      stage.style.backgroundColor = `rgb(${Math.round(r / n)},${Math.round(gg / n)},${Math.round(b / n)})`;
    } catch { /* 取不到就算了，用原底色 */ }
  };
  if (img.complete && img.naturalWidth) apply();
  else img.addEventListener('load', apply, { once: true });
}

// 缩略图与大图。只有一张图时也摆一个缩略图：位置固定才看得出“这一版有几张”。
function renderShots(pick) {
  const box = $('d-thumbs');
  const stage = $('d-stage');
  const ph = $('d-stage-ph');
  const img = $('d-hero');  const tag = $('d-stage-tag');
  if (!box || !stage || !ph || !img) return;

  if (!curShots.length) {
    box.innerHTML = '';
    img.hidden = true;
    ph.hidden = false;
    if (tag) tag.hidden = true;
    return;
  }
  ph.hidden = true;
  img.hidden = false;
  const idx = Math.max(0, pick == null ? 0 : pick);
  const cur = curShots[idx] || curShots[0];
  img.src = 'data:' + cur.mime + ';base64,' + cur.data;
  if (tag) { tag.hidden = false; tag.textContent = cur.label; }
  // 取图片四个角的颜色当舞台底色。
  // 图片比例（1.75）几乎不会刚好等于盒子比例，contain 必然产生信箱边——
  // 视口截图是深色的，用浅色底就是两道白带。取图自己的边色，边就看不出来了。
  sampleEdgeColor(img, stage);

  box.innerHTML = curShots.map((s, i) =>
    `<div class="wb-th${i === idx ? ' on' : ''}" data-i="${i}">`
    + `<div class="im" style="background-image:url(data:${s.mime};base64,${s.data})"></div>`
    + `<div class="lb">${esc(s.label)}</div></div>`).join('');
  box.querySelectorAll('.wb-th[data-i]').forEach((el) => {
    el.onclick = () => renderShots(Number(el.dataset.i));
  });
  // “重算”只在当前方位已有图时出现：没图时“取一张”就是第一次算，
  // 摆一个“重算”在那儿只会让人犹豫点哪个。
  //
  // ！b-resee 这块曾是死的：既不在 HTML 里，也没有任何地方注入它，
  //   而 $('b-resee') 又把它当成预期存在的控件。视口 tab 撤掉时
  //   这个按钮一起没了，代码却留着。现在删干净。
}

function markTag(id, tag) {
  setMsg(tag ? '正在标为基线…' : '正在取消标记…', true);
  api('/blender-bridge/runs/tag', { id, tag })
    .then((r) => {
      if (r && r.ok) { flashMsg(tag ? '已标为基线（不会被自动清理）' : '已取消标记'); loadRuns(id); }
      else flashMsg('标记失败：' + ((r && r.error) || '未知'));
    })
    .catch((e) => flashMsg('标记失败：' + e));
}
$('d-baseline').onclick = () => { if (state.cur) markTag(state.cur.id, 'baseline'); };
$('d-shoot').onclick = () => shootViews();
$('d-delivered').onclick = () => { if (state.cur) markTag(state.cur.id, 'delivered'); };
$('d-untag').onclick = () => { if (state.cur) markTag(state.cur.id, null); };
$('d-notes-toggle').onclick = () => {
  notesOpen = !notesOpen;
  const np = $('d-notes'), t = $('d-notes-toggle');
  if (np) np.hidden = !notesOpen;
  if (t) t.textContent = notesOpen ? '收起' : '展开';
};

// ── 记意见 ──
// 与“派活”不是同一件事：
//   意见 = 存到这一版上，给下一版当输入（存在磁盘上，比浏览器活得久）
//   派活 = 真的送进会话，让助手当场开始干
// 两者共用 /runs/feedback 落盘，但记意见**不发给任何人**，只存。
async function saveNote() {
  const ta = $('d-note'), hint = $('d-hint'), btn = $('d-fb-send');
  if (!ta) return;
  const v = String(ta.value || '').trim();
  if (!v) { ta.focus(); return; }
  if (!state.cur) { if (hint) hint.textContent = '先选一个产出'; return; }
  if (btn) { btn.disabled = true; btn.textContent = '存入中…'; }
  try {
    const r = await api('/blender-bridge/runs/feedback', { id: state.cur.id, text: v });
    if (btn) { btn.disabled = false; btn.textContent = '记下'; }
    if (!r || !r.ok) { if (hint) hint.textContent = '没存上：' + ((r && r.error) || '未知'); return; }
    // 回读服务端写下的全文，不自己拼——自己拼的迟早跟盘上不一样
    const fb = r.feedback || '';
    state.cur.feedback = fb;
    const box = $('d-fb');
    if (box) { box.textContent = plainFeedback(fb); box.hidden = !fb; }
    const e = $('d-fb-empty'); if (e) e.hidden = !!fb;
    const c = $('d-fbcount'); if (c) c.textContent = String(fb.split('\n').filter((x) => x.trim()).length || '');
    ta.value = '';
    if (hint) hint.textContent = '已记下（会跟着这一版进下一版的上下文）';
    flashMsg('已记下意见');
    logLine('意见：' + v.slice(0, 60));
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = '记下'; }
    if (hint) hint.textContent = '没存上：' + String((e && e.message) || e).slice(0, 70);
  }
}
if ($('d-fb-send')) $('d-fb-send').onclick = saveNote;
if ($('d-note')) $('d-note').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveNote(); }
});

// ── 派活 ──
// 与“记意见”不是同一件事，虽然写的是同一句话：
//   意见 = 存到这一版上，给下一版当输入（比浏览器活得久）
//   派活 = 真的送进会话，让助手当场开始干
// 所以一次提交把两件都做了，而且是先落盘再发送：
// 落盘失败还发出去，等于说了话却没留底。
async function dispatch() {
  const ta = $('d-brief'), hint = $('d-dhint'), btn = $('d-dispatch');
  const v = String(ta.value || '').trim();
  if (!v) { ta.focus(); hint.textContent = '先写一句再派'; return; }
  if (!state.cur) { hint.textContent = '先选一个产出'; return; }
  const agentId = $('d-agent') ? $('d-agent').value : '';
  const modelSel = $('d-model');
  const modelId = modelSel ? modelSel.value : '';
  // provider 跟着模型一起走：切模型的契约里两个都是必填。
  const provider = (modelSel && modelSel.selectedOptions && modelSel.selectedOptions[0])
    ? (modelSel.selectedOptions[0].dataset.provider || '') : '';
  const runId = state.cur.id;
  // 没选助手就不发。不把“发给谁”这个问题推给宿主——它在这页里没有答案。
  if (!agentId) {
    hint.classList.remove('ok');
    hint.textContent = '先选一个助手（派活得知道发给谁）';
    if ($('d-agent')) $('d-agent').focus();
    return;
  }
  btn.disabled = true; btn.textContent = '派发中…';

  // ！兜底闸：无论下面发生什么（含 api 挂死、异常没被接到），
  //   按钮必须在 60s 内恢复。一次派活的正常耗时是秒级，
  //   超过这个数就是出了问题——而此时最不该做的是让人对着一个“永远在忙”的按钮。
  const restoreBtn = () => {
    try { btn.disabled = false; btn.textContent = '派给助手'; } catch { /* 元素可能已卸载 */ }
  };
  const btnGuard = setTimeout(() => {
    restoreBtn();
    hint.classList.remove('ok');
    hint.textContent = '没发出去：请求超时未应答（后端或宿主桥没回）';
  }, 60000);

  api('/blender-bridge/runs/feedback', { id: runId, text: v })
    .catch(() => null)
    .then((fr) => {
      if (fr && fr.ok) {
        const fbBox = $('d-fb');
        if (fbBox) { fbBox.textContent = plainFeedback(fr.feedback); fbBox.hidden = !fr.feedback; }
        if (state.cur) state.cur.feedback = fr.feedback || '';
        const fe = $('d-fb-empty'); if (fe) fe.hidden = true;
        const fbc = $('d-fbcount');
        if (fbc) fbc.textContent = String((fr.feedback || '').split('\n').filter((x) => x.trim()).length || '');
      }
      return api('/blender-bridge/dispatch', { brief: v, runId, agentId, modelId, provider });
    })
    .then((r) => {
      clearTimeout(btnGuard);
      restoreBtn();
      if (r && r.ok) {
        // 把“去了哪”说清楚。模型换失败要带原因——
        // 只说“没换成”等于没说，人不知道该去改什么。
        const bits = [];
        if (r.createdSession) bits.push('已建会话');
        if (r.modelSwitched === true) bits.push('已换模型');
        else if (r.modelSwitched === false) bits.push('模型没换成：' + (r.modelError || '原因未知'));
        hint.textContent = '已派给助手' + (bits.length ? ' · ' + bits.join(' · ') : '');
        hint.classList.add('ok');
        ta.value = '';
        flashMsg('已派给助手');
        logLine('派活：' + v.slice(0, 60));
      } else {
        hint.classList.remove('ok');
        hint.textContent = '没发出去：' + ((r && r.error) || '未知');
      }
    })
    .catch((e) => {
      clearTimeout(btnGuard);
      restoreBtn();
      hint.classList.remove('ok');
      hint.textContent = '没发出去：' + String((e && e.message) || e).slice(0, 80);
    });
}
if ($('d-dispatch')) $('d-dispatch').onclick = dispatch;
if ($('d-brief')) $('d-brief').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); dispatch(); }
});

// ── 助手与模型 ──
// 两者不是一类东西：助手是“谁来干”（有自己的会话与记忆），
// 模型是“用哪个脑子”（同一会话换个模型即可）。所以两个下拉框，不是一个。
async function loadAgents() {
  const sel = $('d-agent');
  if (!sel) return;
  try {
    const r = await api('/blender-bridge/agents');
    if (!r || !r.ok) {
      // 取不到就说取不到，不假装成“没有助手”。
      // “无可选”和“没取到”是两件事，混在一起就不利查因了。
      sel.innerHTML = '<option value="">取不到助手列表</option>';
      sel.title = (r && r.error) || '取不到助手列表';
      return;
    }
    const list = (r.agents || []).filter((a) => !a.retired);
    if (!list.length) {
      sel.innerHTML = '<option value="">没读到助手</option>';
      sel.title = '宿主返回了空列表——列表默认只含本应用自己的助手，后端已改走 scope:all';
      return;
    }
    // 没有“跟随”这个选项：派活必须知道发给谁。
    // 之前留了“跟随当前会话”，但整页卡片根本没有“当前会话”——
    // 它是个听起来合理的空答案，只会把错误推到发不出去的时候才暴露。
    const want = r.current || (state.cur && state.cur.agentId) || '';
    sel.innerHTML = list.map((a) =>
      `<option value="${esc(a.id)}"${a.id === want ? ' selected' : ''}>${esc(a.name)}</option>`).join('');
    sel.title = `${list.length} 个助手可选`;
  } catch (e) {
    sel.innerHTML = '<option value="">取不到助手列表</option>';
    sel.title = String(e);
  }
}

async function loadModels() {
  const sel = $('d-model');
  if (!sel) return;
  try {
    const r = await api('/blender-bridge/models');
    if (!r || !r.ok) { sel.title = (r && r.error) || '取不到模型列表'; return; }
    const list = r.models || [];
    if (!list.length) { sel.innerHTML = '<option value="">无可用模型</option>'; return; }
    // 空值 = 不换模型，用那个助手本来的——不是“跟随会话”。
    // 整页卡片没有“当前会话”这回事，写“跟随会话”等于给一个做不到的答案。
    sel.innerHTML = '<option value="">不换（用助手默认）</option>'
      + list.map((m) => `<option value="${esc(m.id)}" data-provider="${esc(m.provider || '')}"`
        + `${m.id === r.current ? ' selected' : ''}>`
        + `${esc(m.label)}${m.provider ? ' · ' + esc(m.provider) : ''}</option>`).join('');
  } catch (e) { sel.title = String(e); }
}

// ── 服务起停 ──────────────────────────────────────────────────────────────
// 启动/停止的入口在宿主侧栏（sidepanel.html）。这里不再自带按钮——
// 两处都放服务按钮，人会不知道该按哪个。
// 保留这个函数：将来若页内需要快捷入口，直接调即可。
async function svc(op, label) {
  setMsg(label, true);
  try {
    const r = await api('/blender-bridge/service', { op });
    flashMsg(r && r.ok ? (r.detail || '完成') : '失败：' + ((r && r.error) || '未知'));
  } catch (e) { flashMsg('请求失败：' + e); }
  setTimeout(() => { loadStatus(); }, 2600);
}

// ── 视口 ─────────────────────────────────────────────────────────────────
// 「取一张」面板已去掉：视图现在由收口时自动拍（runs op=views），
// 在产出页看各个方位。这里只留“给当前这一版补拍一组”的能力。
const ANGLE_NAME = { iso: '等轴', front: '正视图', back: '后视图', left: '左侧视', right: '右侧视', top: '俯视' };

// 拍视图是两件事，得分开看：
//   · 收口时自动拍（runs op=finish 带 views:true）——那一刻场景 = 那一版模型，图天然对。
//   · 手动拍（这个按钮）——拍的是**此刻场景**，而场景可能早就不是你做这一版时的样子。
//
// 实测的坑：在 tiger 那一版里点手拍，场景里已经换成了花，
//   于是 tiger 的 views/ 里装进了花的四张图 —— 而且**逐字节相同**。
//   两个 run 的视图长得一模一样，从图里分不出谁是谁。
//
// 所以手动拍的规则：
//   已有图 → 先说清楚“会盖掉、且拍的是当下”再动。
//   没图   → 不拦。那就是补拍，没有可丢的东西。
function shootConfirmText(run) {
  const vcount = ((run.files || {}).view || []).length;
  const script = (run.meta && run.meta.script) ? String(run.meta.script) : '';
  const lines = [];
  if (vcount) {
    lines.push(`这一版已有 ${vcount} 张视图，重拍会**覆盖**它们。`);
  } else {
    lines.push('这一版还没有视图，现在可以补拍。');
  }
  lines.push('拍的是**此刻场景里的东西**——不一定是做这一版时的样子。');
  if (script) {
    lines.push(`这版记录着来源脚本 ${script}；想让图对得上，先重建它再拍。`);
  }
  return lines.join('\n');
}

async function shootViews(confirmed) {
  if (!state.cur) { flashMsg('先选一个产出'); return; }
  const run = state.cur;

  // 没图不拦：补拍而已。有图才先问。
  const needAsk = ((run.files || {}).view || []).length > 0;
  if (needAsk && !confirmed) {
    // 走同一个确认条（与“装入”共用）——否则会用 d-shoot-yes 的旧绑定的。
    showConfirm(shootConfirmText(run), 'shoot', false);
    return;
  }
  hideConfirm();

  const btn = $('d-shoot');
  if (btn) { btn.disabled = true; btn.textContent = '拍中…'; }
  setMsg('拍一组视图…', true);
  try {
    // 走工具面的同一条路：runs op=views。
    // 不在这里逐个调 /see——那样就没归档，也不会去重。
    const r = await api('/blender-bridge/views', { id: run.id, noCache: !!confirmed });
    if (r && r.ok) {
      const n = (r.angles || []).length;
      flashMsg(n ? `已拍 ${n} 个方位` : '一张都没拍成，看日志');
      logLine(`拍视图：${(r.angles || []).join('、') || '无'}`);
      await selectRun(run.id);
    } else {
      flashMsg('拍视图失败：' + ((r && r.error) || '未知'));
    }
  } catch (e) {
    flashMsg('拍视图失败：' + e);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '拍一组视图'; }
  }
}
if ($('d-shoot-no')) $('d-shoot-no').onclick = () => { const b = $('d-shoot-confirm'); if (b) b.hidden = true; };

// ── 装入场景 ────────────────────────────────────────────────────────────────
//
// “装入”会把那一版的完整场景（.blend）装回 Blender。
// 它**不破坏手上的活**——后端在装之前会自动存一份当前场景的快照，随时能退回去。
// 这一点很重要：不然“看一下历史”和“丢掉手上的活”就是一回事。
//
// 但它确实会改变你面前这个 Blender 的样子，所以要问一句。
// 确认条与拍视图共用一个（同位置同形式，不另开一个）——
// 靠 confirmKind 区分点“确认”后该干哪件事。
let confirmKind = 'shoot';
let confirmNoBlend = false;   // “没存过完整场景”那种情况：确认后是去存，不是去装

function showConfirm(text, kind, noBlend) {
  confirmKind = kind;
  confirmNoBlend = !!noBlend;
  const bar = $('d-shoot-confirm');
  if (!bar) return;
  $('d-shoot-why').textContent = text;
  bar.hidden = false;
  const yes = $('d-shoot-yes');
  if (yes) yes.textContent = noBlend ? '存一份' : (kind === 'load' ? '装入' : '重拍');
}
function hideConfirm() {
  const bar = $('d-shoot-confirm');
  if (bar) bar.hidden = true;
}
function confirmYes() {
  hideConfirm();
  if (confirmKind === 'load') { if (confirmNoBlend) saveSceneNow(); else doRestore(); return; }
  shootViews(true);
}

async function saveSceneNow() {
  const run = state.cur; if (!run) return;
  const btn = $('d-load');
  if (btn) { btn.disabled = true; btn.textContent = '存中…'; }
  setMsg('存完整场景…', true);
  try {
    const r = await api('/blender-bridge/runs/scene', { id: run.id });
    if (r && r.ok) { flashMsg('已存完整场景'); logLine(`存完整场景：${run.id}`); await selectRun(run.id); }
    else flashMsg('存失败：' + ((r && r.error) || '未知'));
  } catch (e) { flashMsg('存失败：' + e); }
  finally { if (btn) { btn.disabled = false; btn.textContent = '装入场景'; } }
}

function askRestore() {
  if (!state.cur) { flashMsg('先选一个产出'); return; }
  const run = state.cur;
  const hasBlend = ((run.files || {}).scene || []).length > 0;
  if (!hasBlend) {
    // 没存过就当场补一个——不是先报错再让人去找按钮。
    // 但得说清楚：存的是**此刻场景**，不一定还是做这一版时的样子。
    showConfirm('这一版还没存过完整场景。现在存一个吗？\n'
      + '存的是**此刻场景**——不一定还是做这一版时的样子。', 'load', true);
    return;
  }
  // 这种图算一下“装完会变掉多少”不好做，不编数字；只说机制。
  showConfirm(`把「${run.label || run.id}」的完整场景装回 Blender？\n`
    + '装之前会自动把**你现在手上的场景**存一份快照，随时能退回去。', 'load', false);
}

async function doRestore() {
  const run = state.cur; if (!run) return;
  const btn = $('d-load');
  if (btn) { btn.disabled = true; btn.textContent = '装入中…'; }
  setMsg('装入场景…', true);
  try {
    const r = await api('/blender-bridge/runs/restore', { id: run.id });
    if (r && r.ok) {
      flashMsg(`已装入（${r.objects} 个物体）`);
      logLine(`装入场景：${run.id}`);
      if (r.snapshot && r.snapshot.ok) logLine(`  装之前已存快照：${r.snapshot.file}`);
    } else {
      flashMsg('装入失败：' + ((r && r.error) || '未知'));
    }
  } catch (e) { flashMsg('装入失败：' + e); }
  finally {
    if (btn) { btn.disabled = false; btn.textContent = '装入场景'; }
    loadScene();
  }
}

if ($('d-load')) $('d-load').onclick = () => askRestore();
if ($('d-shoot-yes')) $('d-shoot-yes').onclick = () => confirmYes();

$('b-scene').onclick = loadScene;

// 进页面就自动读一次场景：要人先点一下才看得到东西，等于把“还没读”装成“没有”。
// opts.silent = 后台轮询用：场景没变就不重绘（不然输入焦点会被冲掉）。
async function loadScene(opts) {
  const silent = !!(opts && opts.silent);
  if (!silent) setMsg('读场景…', true);
  try {
    const r = await api('/blender-bridge/scene', {});
    const res = (r && r.ok && r.result) || {};
    const objs = res.objects || [];
    // ！这里踩过：早先写的是 objs.length + ' 个物体'。
    //   而 addon 的 get_scene_info **只返回前 10 个** objects，
    //   总数在 object_count 里（实测：30 个物体，列表只给 10 条）。
    //   于是界面写“10 个物体”，而其实有 30 个——
    //   少掉的那 20 个不但看不见，也删不掉。
    //   两个字段都得用：总数看 object_count，列表长度只能说明“拿到了多少条”。
    const total = Number.isFinite(res.object_count) ? res.object_count : objs.length;
    // 签名：物体名 + 类型。变了才重绘。
    const sig = objs.map((o) => `${o.name}:${o.type}`).join("|");
    if (silent && sig === state.sceneSig) return;
    state.sceneSig = sig;
    state.scene = objs;
    // ！曾经这里还写了一句 $('obj-kv').innerHTML = ...，而 HTML 里没有 obj-kv，
    //   于是 null.innerHTML 抛 TypeError。要命的是它在 $('tree') **之后**——
    //   界面已经画好了、计数也更新了，报错才姗姗来迟，看起来像“刷新成功但报错”。
    //   截断提示直接并进 scene-count，不再单开一个不存在的元素。
    const sh = $('scene-short');
    $('scene-count').textContent = total ? total + ' 个物体' : '—';
    if (sh) sh.textContent = objs.length < total ? `（列表只含前 ${objs.length} 个）` : '';
    if (!objs.length) {
      $('tree').innerHTML = '<div class="ph">场景里没有读到物体</div>';
    } else {
      // 相机/灯光不给删——删了场景就看不见东西了，那是自找麻烦
      $('tree').innerHTML = objs.slice(0, 200).map((o) => {
        const canDel = o.type === 'MESH';
        return `<div class="srow" data-name="${esc(o.name || '')}">`
          + `<span class="ty">${esc(o.type || '?')}</span>`
          + `<span class="nm">${esc(o.name || '?')}</span>`
          + `<span class="sp"></span>`
          + (canDel ? `<button class="b mini del" data-del="${esc(o.name || '')}" title="移入回收站（可恢复）">删除</button>` : '')
          + `</div>`;
      }).join('');
      $('tree').querySelectorAll('[data-del]').forEach((b) => {
        b.onclick = () => removeObject(b.dataset.del);
      });
    }
    flashMsg('场景已读取');
  } catch (e) { flashMsg('读场景失败：' + e); }
}

// 增删都走 /object/edit。删不真删——进回收站，删错了能捞回来。
async function editObject(body, okText) {
  setMsg('处理中…', true);
  try {
    const r = await api('/blender-bridge/object-edit', body);
    if (!r || !r.ok) {
      flashMsg('失败：' + ((r && r.error) || '未知'));
      return null;
    }
    flashMsg(okText);
    logLine(okText);
    await loadScene();
    return r.result || {};
  } catch (e) { flashMsg('请求失败：' + e); return null; }
}

async function removeObject(name) {
  if (!name) return;
  await editObject({ op: 'remove', name }, `已把 ${name} 移入回收站`);
}

const addSel = $('add-kind');
const addBtn = $('b-add');
if (addBtn) {
  addBtn.onclick = async () => {
    const kind = addSel ? addSel.value : 'cube';
    await editObject({ op: 'add', kind }, `已新建 ${kind}`);
  };
}
const trashBtn = $('b-trash');
if (trashBtn) {
  trashBtn.onclick = async () => {
    const res = await editObject({ op: 'trash_list' }, '回收站已读取');
    if (!res) return;
    const objs = res.objects || [];
    if (!objs.length) { flashMsg('回收站是空的'); return; }
    // 恢复/真删都给出来——回收站的意义就是“删错了还能救”
    const box = $('trash-box');
    if (!box) return;
    box.hidden = false;
    box.innerHTML = '<div class="mhint">回收站（' + objs.length + '）：点名字恢复</div>'
      + objs.map((n) => `<button class="b mini" data-restore="${esc(n)}">${esc(n)}</button>`).join(' ')
      + ' <button class="b mini danger" id="b-purge">全部真删</button>';
    box.querySelectorAll('[data-restore]').forEach((b) => {
      b.onclick = async () => { await editObject({ op: 'restore', name: b.dataset.restore }, `已恢复 ${b.dataset.restore}`); box.hidden = true; };
    });
    const pg = $('b-purge');
    if (pg) pg.onclick = async () => { await editObject({ op: 'purge' }, '回收站已清空（不可恢复）'); box.hidden = true; };
  };
}

// ── 执行 ──────────────────────────────────────────────────────────────────
const DANGER = [
  [/bpy\.ops\.wm\.(quit|exit)/i, '退出 Blender'],
  [/bpy\.ops\.wm\.save_as_mainfile/i, '另存主文件'],
  [/bpy\.ops\.object\.delete/i, '删除物体'],
  [/bpy\.data\.objects\.remove/i, '移除数据块'],
  [/shutil\.rmtree|os\.remove|os\.unlink/i, '文件删除'],
];
function scanDanger(code) {
  const hits = [];
  for (const [re, label] of DANGER) if (re.test(code || '')) hits.push(label);
  return hits;
}
$('code')?.addEventListener('input', () => {
  const hits = scanDanger($('code').value);
  const d = $('danger');
  if (hits.length) { d.hidden = false; d.textContent = '⚠ 这段代码包含：' + hits.join('、'); }
  else d.hidden = true;
});
$('b-run').onclick = async function () {
  const code = $('code').value.trim();
  if (!code) { $('code').focus(); return; }
  this.disabled = true;
  $('run-hint').textContent = '执行中…';
  setMsg('执行 Python…', true);
  try {
    const r = await api('/blender-bridge/run', { code });
    if (r && r.ok) {
      $('result').textContent = typeof r.result === 'string' ? r.result : JSON.stringify(r.result, null, 2);
      $('run-hint').textContent = '完成';
      logLine('执行成功');
    } else {
      $('result').textContent = String((r && r.error) || '执行失败');
      $('run-hint').textContent = '失败';
      logLine('执行失败：' + ((r && r.error) || '未知'));
    }
  } catch (e) {
    $('result').textContent = String(e);
    $('run-hint').textContent = '失败';
  }
  this.disabled = false;
  setTimeout(() => { $('run-hint').textContent = ''; }, 3000);
};
$('b-mark').onclick = async function () {
  const code = $('code').value.trim() || '(空)';
  this.disabled = true;
  setMsg('打回退点…', true);
  try {
    const r = await api('/blender-bridge/relay/start', {}).catch(() => null);
    // 回退点要走工具面的 txn；面板这里只提示，避免误以为已打点
    $('run-hint').textContent = '请在会话里说「先 mark」——回退点由事务层建';
    logLine('提示：回退点需经会话走 txn op=mark');
  } catch (e) { /* ignore */ }
  this.disabled = false;
};

// ── 日志 ──────────────────────────────────────────────────────────────────
// 这一页的用处是「出了事能查」。所以：
//   · 请求失败自动落这里（见上面 api()，接在 LOG_SINK 上）
//   · 能一键复制，不用人拿眼睛一行行抄
const logs = [];
function logLine(t) {
  const ts = new Date().toLocaleTimeString();
  logs.push(`[${ts}] ${t}`);
  if (logs.length > 300) logs.shift();
  const el = $('log');
  if (el) { el.textContent = logs.join('\n'); el.scrollTop = el.scrollHeight; }
}

// ── 服务端日志（拉）─────────────────────────────────────────────────────
//
// 为何要拉：上面那份 logs 是**浏览器内存**里的，只记 UI 自己发的请求。
//   两个缺口：
//     ① 刷新页面就没了——而“事后能查”才是日志的全部价值；
//     ② **工具面（模型）调的请求一条都不在里面**。
//        实测：点「拍视图」出了错，日志页上什么都没有，
//        而真正出错的那次调用根本没被记——排查时只能去翻宿主大日志。
//
// 服务端那份（app.log）挂在 relayFetch 上，是**所有**中继调用的收束点，
//   不管谁调的（UI 还是模型）都会经过。拉它才能看到全貌。
const serverLogs = [];
function renderLog() {
  const el = $('log');
  if (!el) return;
  const head = serverLogs.length ? [`── 服务端（共 ${serverLogs.length} 条，含工具面调用）──`, ...serverLogs, ''] : [];
  const tail = logs.length ? [`── 本次页面 ──`, ...logs] : [];
  el.textContent = [...head, ...tail].join('\n');
  el.scrollTop = el.scrollHeight;
}
async function loadServerLog() {
  try {
    // ！必须走 hana.api.fetch，不能用裸 fetch。
    //   App 路由要凭证头（X-Hana-App-Surface-Session），而裸 fetch 不带它。
    //   这就是 BUG-115（settings.js 用了 hana.api.url 而没有凭证）。
    const r = await hana.api.fetch('/blender-bridge/app-log?n=300', { cache: 'no-store' });
    if (!r.ok) return;
    const j = await r.json();
    if (!j || !j.ok) return;
    serverLogs.length = 0;
    // 把 JSON 行转成人看的一行：时间 + 路径 + 结果 + 耗时
    for (const raw of j.lines || []) {
      try {
        const m = /^\[(.*?)\]\s*(.*)$/.exec(raw);
        if (!m) { serverLogs.push(raw); continue; }
        const t = new Date(m[1]);
        const ts = isNaN(t) ? m[1] : t.toLocaleTimeString();
        const o = JSON.parse(m[2]);
        if (o.kind !== 'relay') { serverLogs.push(`[${ts}] ${m[2]}`); continue; }
        const bad = o.fail || o.error || o.nonJson || (o.status && o.status >= 400);
        const mark = o.fail ? '✗未送达' : o.nonJson ? '✗非JSON' : (o.status >= 400) ? `✗${o.status}` : (o.ms > 3000 ? '·慢' : '·');
        serverLogs.push(`[${ts}] ${mark} ${o.path}${o.brief ? ' ' + o.brief : ''}（${o.ms}ms）`
          + (o.error ? `｜${o.error}` : '')
          + (o.head ? `｜${String(o.head).replace(/\s+/g, ' ').slice(0, 90)}` : ''));
      } catch { serverLogs.push(raw); }
    }
    if (serverLogs.length > 400) serverLogs.splice(0, serverLogs.length - 400);
    renderLog();
  } catch { /* 拉不到就只显示本地那份 */ }
}

// 把 api() 的日志出口接上。它在本文件顶部声明时是 null，
// 那时 logLine 还没定义（函数声明会提升，但这里用的是变量赋值，顺序很明确）。
LOG_SINK = logLine;

// 进日志页时拉一次服务端日志。
// 不包 showTab（它还会在初始化时被调，包了容易绕）。
// 直接在 tab 按钮上多挂一个 handler，并在页面带 #log 打开时拉一次。
document.querySelectorAll('#tabs button').forEach((b) => {
  if (b.dataset.t !== 'log') return;
  const prev = b.onclick;
  b.onclick = (ev) => { if (prev) prev.call(b, ev); loadServerLog(); };
});
if (location.hash === '#log') loadServerLog();
if ($('b-refresh-log')) $('b-refresh-log').onclick = () => { loadServerLog().then(() => flashMsg('已刷新服务端日志')); };

$('b-clear').onclick = () => { logs.length = 0; if ($('log')) $('log').textContent = ''; };

// 一键复制。为什么需要：这些日志本来就是要拿去别处说事的，
// 而从前只能对着屏幕手抄——实测用户碰到 500 时就是这么干的，抄了半天。
if ($('b-copy-log')) {
  $('b-copy-log').onclick = async () => {
    const text = logs.join('\n');
    if (!text) { flashMsg('日志是空的'); return; }
    try {
      await navigator.clipboard.writeText(text);
      flashMsg(`已复制 ${logs.length} 行`);
    } catch {
      // 剪贴板可能被权限挡。退到“选中内容”，人自己 Ctrl+C——总比什么都没有强
      const el = $('log');
      if (el && window.getSelection) {
        const rg = document.createRange();
        rg.selectNodeContents(el);
        const sel = window.getSelection();
        sel.removeAllRanges(); sel.addRange(rg);
        flashMsg('已选中，按 Ctrl+C 复制');
      } else flashMsg('复制失败，请手动选择');
    }
  };
}

// ── 起手 ──────────────────────────────────────────────────────────────────
async function boot() {
  try { await hana.ready(); } catch { /* 无宿主 */ }
  loadStatus();
  loadRuns();
  loadScene();
  loadAgents();
  loadModels();
  setInterval(loadStatus, 8000);
  // 产出列表也要轮询。
  //
  // ！这里曾经不对称：loadStatus 每 8 秒刷，loadRuns 只在 boot 跑一次。
  //   后果：卡片开着的时候，Agent 那边新产生的 run 不会出现——
  //   而界面上根本没有“刷新”这个入口。
  //   实测：花已经落盘（864KB），App 里还写着“run 数 1”。
  //   silent=true：列表没变就不重绘，不会把正在看的选中态和输入冲掉。
  setInterval(() => { loadRuns(null, { silent: true }); }, 10000);
  // 场景树同理。Agent 那边用 do 建了一堆部件，
  // 而卡片还写着建之前的物体数——同一个不对称毛病。
  setInterval(() => { loadScene({ silent: true }); }, 12000);
}
boot();
