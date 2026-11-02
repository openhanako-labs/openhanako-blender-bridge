/**
 * addon 协议 —— 只支持本仓 `DSH Blender Bridge` 的**扁平协议**（v2.3 起）。
 *
 * 历史（已删除）：v2.0 之前还支持上游 `MCP for Blender`（模块 `blender_mcp`）与
 * harveyxiacn `blender_mcp_addon`（category-action 协议）。v2.3 起选中/集合/activity
 * 都依赖本仓 addon v1.8，继续兼容旧 addon 只会让用户拿到"模型工具能用、新功能永远不可用"
 * 的半残状态，因此**旧 addon 支持与双名回退全部删除**；用户必须使用本仓 addon。
 *
 * 协议形状（扁平 / 无分帧）：
 *   请求  {"type":"get_scene_info","params":{}}
 *   应答  {"status":"success","result":{…}} / {"status":"error","message":"…"}
 */

import net from 'node:net';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 解析 addon 调用方令牌（与 addon 侧 vendor/_addon_auth.py 同源规则）。
 *
 * 威胁模型：addon 的 9876 端口是 localhost 回环，原本零鉴权。这里把令牌注入每条命令，
 * 让 addon 入口在「执行前」识别已授权调用方（见仓库 SECURITY.md G0 与 PR #123）。
 *
 * 优先级：env BLENDERMCP_ADDON_TOKEN > env BLENDERMCP_ADDON_TOKEN_FILE >
 *         默认文件 <tmp>/blender-bridge.addon-token（宿主每次启动生成并写入）。
 * 返回 '' 表示未配置 —— 此时不注入 auth，addon 会因令牌缺失而拒绝（保持关闭）。
 */
export function resolveAddonToken() {
  const direct = process.env.BLENDERMCP_ADDON_TOKEN;
  if (direct) return direct;
  const file = process.env.BLENDERMCP_ADDON_TOKEN_FILE;
  const p = file || path.join(os.tmpdir(), 'blender-bridge.addon-token');
  try { return fs.readFileSync(p, 'utf8').trim(); } catch { return ''; }
}

/** 本仓 addon 的协议描述符（唯一一种）。 */
export const PROTOCOLS = {
  flat: {
    id: 'flat',
    label: '直连 addon · 扁平协议（无分帧；实测 v1.7/v1.8 都通 —— 活版本看 rt_cmd get_addon_info）',
    framing: 'none',
    panelHint: '「DSH Blender Bridge」面板 → Connect',
    plan(type, params) {
      const wire = { type: type, params: params || {} };
      // G0：调用方令牌（与 addon 入口校验对应）。未配置则不注入 —— addon 端据此拒绝。
      const token = resolveAddonToken();
      if (token) wire.auth = token;
      return { wire };
    },
    encode(wire) { return JSON.stringify(wire); },
    decode(raw) {
      const o = JSON.parse(raw);
      if (o.status === 'error') return { ok: false, message: String(o.message || 'addon error') };
      return { ok: true, data: o.result === undefined ? {} : o.result };
    },
  },
};

export const PROTOCOL_IDS = Object.keys(PROTOCOLS);

/**
 * 探一次：发扁平 ping，有 JSON 回包即证明对面是本仓 addon。
 * @returns {Promise<{id:string, ms:number}|null>} null = addon 不在 / 端口不通
 */
export async function detectProtocol(host, port, timeoutMs = 1000) {
  const t0 = Date.now();
  const proto = PROTOCOLS.flat;
  return new Promise((resolve) => {
    const s = net.connect({ host: host, port: port });
    let buf = '';
    let settled = false;
    const done = (v) => { if (settled) return; settled = true; clearTimeout(t); try { s.destroy(); } catch (e) { /* ignore */ } resolve(v); };
    const t = setTimeout(() => done(null), timeoutMs);
    s.once('connect', () => {
      try { s.write(proto.encode(proto.plan('ping', {}).wire, { id: 'probe', timeoutMs: timeoutMs })); } catch (e) { done(null); }
    });
    s.once('error', () => done(null));
    s.on('data', (d) => {
      buf += d.toString('utf8');
      try { JSON.parse(buf.trim()); done({ id: 'flat', ms: Date.now() - t0 }); } catch (e) { /* 继续攒 */ }
    });
  });
}

/** 兼容旧调用点（已无缓存；保留导出避免破坏调用方）。 */
export function resetProtocolCache() { /* no-op */ }

/**
 * 得到实际要用的协议描述符。只支持扁平协议 —— `prefer` 参数仅为兼容旧调用点，直接忽略。
 * @returns {Promise<{proto:object, from:'config'}>}
 */
export async function resolveProtocol() {
  return { proto: PROTOCOLS.flat, from: 'config' };
}
