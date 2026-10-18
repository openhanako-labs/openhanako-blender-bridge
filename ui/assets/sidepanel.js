// ui/assets/sidepanel.js — 挂在宿主侧边栏的紧凑状态面板
//
// 取数必须走 hana.api.fetch：宿主把 App 路由挂在 /api/apps/<appId>/routes 下，
// 且要带 appSurfaceSession 凭证。裸 fetch 拿不到会话 → 403，
// 表现为"取不到数据"而不报错——最容易误判成"没数据"。
import { hana } from './sdk.js';

const $ = (id) => document.getElementById(id);

async function api(path, body) {
  const init = body === undefined
    ? { cache: 'no-store' }
    : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
  const r = await hana.api.fetch(path, init);
  const t = await r.text();
  try { return t ? JSON.parse(t) : null; }
  catch { return { ok: false, error: t.slice(0, 200) }; }
}

function fmtBytes(n) {
  n = Number(n) || 0;
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}

// 五步各自的短名，用于"卡在哪一步"的提示
const STEP_NAMES = ['中继', 'Blender 服务', 'TCP 连接', 'addon 应答', 'bpy 可执行'];

function setSteps(flags) {
  // flags 是 5 个布尔。第 i 个为真 → 前 i+1 格点亮。
  const done = flags.filter(Boolean).length;
  const running = done < 5 && flags.some(Boolean) ? done : -1;
  document.querySelectorAll('#bs i').forEach((el, i) => {
    el.className = i < done ? 'done' : (i === running ? 'run' : '');
  });
  return done;
}

// ── 主题跟随：真正让宿主颜色生效的是把 data-theme 打到 <html> 上 ──
// 宿主那十套主题全写成 [data-theme="<id>"] 选择器，而 SDK 从不设这个属性。
let themeName = '';
function paintTheme() {
  const el = $('theme');
  if (el) el.textContent = themeName || '兜底色板';
}
(async () => {
  try {
    await hana.ready();
    const ht = await import('./host-theme.js');
    ht.attachHostTheme({
      hana,
      onChange: (info) => { themeName = (info && info.theme) || ''; paintTheme(); },
    });
  } catch { /* 无宿主：兜底色板 */ }
  paintTheme();
})();

async function loadStatus() {
  let s;
  try { s = await api('/blender-bridge/status'); } catch { s = null; }
  if (!s || s.ok === false) {
    const p = $('phase');
    p.className = 'chip bad';
    p.textContent = '取不到';
    $('note').className = 'note err';
    $('note').textContent = (s && s.error) ? String(s.error).slice(0, 160) : '状态接口无应答';
    return;
  }

  const phase = s.phase || '—';
  const relayUp = phase === 'ready';
  const steps = s.steps || {};
  const flags = [!!steps.relay, !!steps.service, !!steps.tcp, !!steps.addon, !!steps.bpy];
  const done = setSteps(flags);

  // 状态片说的是"通道能用到哪一步"，不是"进程起没起"。
  // 这个区别很重要：中继起来了但 Blender 没开，跟完全没起来是两回事。
  const allReady = done === 5;
  const p = $('phase');
  p.className = 'chip' + (allReady ? ' ok' : (phase === 'error' ? ' bad' : (relayUp ? '' : ' bad')));
  p.textContent = allReady ? '可用'
    : (relayUp ? `${done}/5` : (phase === 'starting' ? '启动中' : (phase === 'error' ? '出错' : '未启动')));

  $('port').textContent = s.servicePort || '—';
  // 字段名要跟 /status 返回的一致：那边叫 addon，不是 config。
  // （上轮改五步时动了 fullStatus 的结构，读漏了这里——
  //  结果就是“Blender 版本读得到、addon 永远显示 —”。）
  const ad = s.addon || {};
  $('addon').textContent = ad.host ? `${ad.host}:${ad.port}` : '—';

  // Blender 版本只在真问到的时候显示。问不到就写实际原因，不写 "—" 蒙混。
  const d = s.doctor || {};
  const bl = d.addonInfo || {};
  const ver = bl.blender_version || bl.version || bl.blenderVersion;
  if (ver) $('blender').textContent = ver;
  else if (!relayUp) $('blender').textContent = '中继未启';
  else if (d.tcp === 'fail') $('blender').textContent = '未运行';
  else if (!d.addon || d.addon === 'unknown') $('blender').textContent = '未应答';
  else $('blender').textContent = '已应答';

  // 卡在哪一步：说清楚“在等”还是“有问题”
  const bnote = $('bnote'), bsr = $('bsr');
  const warming = startingSince && (Date.now() - startingSince) < WARMUP_MS;
  if (allReady) {
    startingSince = 0;
    bnote.textContent = '五步全通'; bsr.textContent = '就绪';
  } else if (relayUp && done > 0) {
    bnote.textContent = warming
      ? `启动中 · 等「${STEP_NAMES[done] || '?'}」`
      : `卡在「${STEP_NAMES[done] || '?'}」`;
    bsr.textContent = `${done}/5`;
  } else if (phase === 'starting') {
    bnote.textContent = '中继启动中'; bsr.textContent = '—';
  } else {
    bnote.textContent = '未启动'; bsr.textContent = '—';
  }

  // 提示行：以本次算出来的状态为准，不靠“之前是不是出过错”。
  // 之前那种写法一旦进了 err 就再也出不来——于是“五步全通”底下
  // 永远挂着一行早已过时的红错误，看着像刚又失败了。
  const note = $('note');
  let noteText = '';
  let noteErr = false;
  if (!allReady && relayUp) {
    if (warming) {
      const left = Math.max(0, Math.ceil((WARMUP_MS - (Date.now() - startingSince)) / 1000));
      noteText = `Blender 正在拉起（约 30~90 秒，再等 ${left} 秒）`;
    } else if (done <= 1) {
      noteText = '点「启动」拉起 Blender';
    } else if (d.lastError) {
      noteText = String(d.lastError).slice(0, 120);
      noteErr = true;
    } else {
      noteText = `卡在「${STEP_NAMES[done] || '?'}」——若刚启动过，再等一会儿`;
    }
  } else if (d.lastError && !allReady && !relayUp) {
    noteText = String(d.lastError).slice(0, 120);
    noteErr = true;
  }
  note.className = noteErr ? 'note err' : 'note';
  note.textContent = noteText;
  note.hidden = noteText === '';
}

async function loadRuns() {
  let r;
  try { r = await api('/blender-bridge/runs'); } catch { r = null; }
  if (!r || r.ok === false) { $('runtotal').textContent = '—'; return; }
  $('runtotal').textContent = r.total != null ? r.total : '—';
  $('runtag').textContent = r.tagged != null ? r.tagged : '—';
  $('runbytes').textContent = fmtBytes(r.bytes);
}

// 启动标记：点了启动之后，Blender 要 30~90 秒才能把 addon 拉起来。
// 这段时间里的 "2/5" 不是失败，是“还没起完”——两种得分开说。
// 不分开的后果：用户看到“卡在 TCP”以为坏了，其实只是要等。
let startingSince = 0;
const WARMUP_MS = 120_000;   // 超过这个时长还没通，才当真的失败

async function svc(op) {
  const b = $(op === 'start' ? 'b-start' : 'b-stop');
  b.disabled = true;
  $('bnote').textContent = op === 'start' ? '已受理，拉起中' : '停止中';
  if (op === 'start') { startingSince = Date.now(); setSteps([true, false, false, false, false]); }
  try {
    const r = await api('/blender-bridge/service', { op });
    if (r && r.ok) {
      if (op === 'stop') { startingSince = 0; setSteps([true, false, false, false, false]); $('bnote').textContent = '已撤下'; $('bsr').textContent = '—'; }
      else { $('bnote').textContent = '拉起中（冷启动 30~90 秒）'; }
    } else {
      startingSince = 0;
      $('bnote').textContent = (op === 'start' ? '启动' : '停止') + '失败';
      $('note').className = 'note err';
      $('note').textContent = String((r && r.error) || '未知');
      $('note').hidden = false;
    }
  } catch (e) {
    startingSince = 0;
    $('note').className = 'note err';
    $('note').textContent = String(e && e.message || e).slice(0, 160);
    $('note').hidden = false;
  }
  b.disabled = false;
  // 启动后查得勤一点：刚拉起时状态变化快，8 秒一次太钝
  setTimeout(loadStatus, op === 'start' ? 2500 : 1200);
}

$('b-start').onclick = () => svc('start');
$('b-stop').onclick = () => svc('stop');
$('b-relay').onclick = async function () {
  this.disabled = true;
  $('bnote').textContent = '重启中继…';
  try {
    const r = await api('/blender-bridge/relay/start', {});
    $('bnote').textContent = r && r.ok ? '中继就绪' : '重启失败';
    if (!(r && r.ok)) {
      $('note').className = 'note err';
      $('note').textContent = String((r && r.error) || '未知');
      $('note').hidden = false;
    }
  } catch { $('bnote').textContent = '重启失败'; }
  this.disabled = false;
  setTimeout(loadStatus, 1200);
};

async function boot() {
  try { await hana.ready(); } catch { /* 无宿主 */ }
  loadStatus();
  loadRuns();
  setInterval(loadStatus, 8000);
}
boot();
