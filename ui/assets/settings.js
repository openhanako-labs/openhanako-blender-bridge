// ui/assets/settings.js — Blender 助手 · 设置页
import { hana } from './sdk.js';

// 跟随宿主主题。
//
// ！这里漏过：设置页早先只用 panel.css 里那两个写错名字的变量
//   （--hana-bg / --hana-fg，从来没被注入过），于是永远走深色 fallback，
//   在浅色主题上就是深底深字。workbench 看得清、设置页看不清，差别就在这里。
//   host-theme.js 是要**显式调用**的（不是自执行），所以必须在这里接上。
(async () => {
  try {
    await hana.ready();
    const ht = await import('./host-theme.js');
    ht.attachHostTheme({ hana });
  } catch { /* 无宿主：用 app.css 里那份浅色默认值 */ }
})();

const $ = (id) => document.getElementById(id);

// 取数必须走 hana.api.fetch，不能裸 fetch：
// 宿主把 App 路由挂在 /api/apps/<appId>/routes 下，且要带 appSurfaceSession 凭证。
//
// ！这个文件曾经漏过。它写的是 fetch(hana.api.url(path))，
//   看着“用了 sdk”，其实两条路不等价：
//     hana.api.url()   → 只拼 URL，**不塞凭证**
//     hana.api.fetch() → 拼 URL + 塞 X-Hana-App-Surface-Session
//   于是这一页的取数一直是 403。
//
//   它藏得深：设置页的默认值恰好就是正确值（127.0.0.1 / 9876），
//   取数失败时不覆盖字段，于是页面看上去完全正常——
//   只有改过配置、发现存不上，才会察觉。
//   静默降级比报错难发现得多。
async function api(path, body) {
  const init = body === undefined
    ? { cache: 'no-store' }
    : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
  const res = await hana.api.fetch(path, init);
  const text = await res.text();
  try { return text ? JSON.parse(text) : null; }
  catch { return { ok: false, error: text.slice(0, 300) }; }
}

function fmtBytes(n) {
  n = Number(n) || 0;
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}

async function load() {
  const c = await api('/blender-bridge/config');
  if (c && c.ok) {
    $('host').value = c.addonHost || '127.0.0.1';
    $('port').value = c.addonPort || 9876;
    $('deliver').value = c.deliverTarget || '';
    $('workdir').textContent = `工作目录：${c.workDir || '（默认）'}`;
    $('cfgpath').textContent = c.configPath ? `配置文件：${c.configPath}` : '';
  }
  const r = await api('/blender-bridge/runs');
  if (r && r.ok) {
    $('runs-note').textContent =
      `当前 ${r.total} 个 run（${r.tagged} 个带标记），共 ${fmtBytes(r.bytes)}。`;
  }
}

async function saveCfg(payload, noteEl, okText) {
  noteEl.textContent = '保存中…';
  const r = await api('/blender-bridge/config', payload);
  if (r && r.ok) {
    // 说清"存了"和"生效了"是两件事——重启中继要时间，不能含糊
    noteEl.textContent = r.restarted
      ? `${okText}，中继已重启（${r.phase}）。`
      : `${okText}。`;
  } else {
    noteEl.textContent = `保存失败：${(r && r.error) || '无应答'}`;
  }
}

$('save').addEventListener('click', () => {
  const host = $('host').value.trim() || '127.0.0.1';
  const port = Number($('port').value) || 9876;
  saveCfg({ addonHost: host, addonPort: port }, $('save-note'), '已保存')
    .catch((e) => { $('save-note').textContent = String(e?.message || e); });
});

$('save-deliver').addEventListener('click', () => {
  const v = $('deliver').value.trim();
  // 只做形状检查（绝对路径），不检查存在性——目录可能还没建
  if (v && !/^[a-zA-Z]:[\\/]|^\\\\|^\//.test(v)) {
    $('deliver-note').textContent = '要填绝对路径（例如 D:\\ComfyUI\\input）';
    return;
  }
  saveCfg({ deliverTarget: v }, $('deliver-note'), v ? '已保存投递目录' : '已清空，不再投递')
    .catch((e) => { $('deliver-note').textContent = String(e?.message || e); });
});

$('prune').addEventListener('click', async () => {
  $('prune-note').textContent = '正在统计…';
  // 默认 dryRun：清理是破坏性动作，先看清楚再动手
  const r = await api('/blender-bridge/runs/prune', { keep: 20, dryRun: true });
  if (r && r.ok) {
    if (!r.removed.length) {
      $('prune-note').textContent = '没有需要清理的（都在保留额度内）。';
      $('prune-list').textContent = '';
    } else {
      $('prune-note').textContent = `要清理 ${r.removed.length} 个（未动磁盘）：`;
      $('prune-list').textContent = r.removed.join('、');
    }
  } else {
    $('prune-note').textContent = `统计失败：${(r && r.error) || '无应答'}`;
  }
});

await hana.ready();
load().catch(() => {});
