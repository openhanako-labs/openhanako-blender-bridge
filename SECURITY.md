# 安全策略（Security Policy）

## 支持的版本

安全修复会合并到 main 分支并随下一个版本发布。建议始终使用最新 release。

## 报告安全漏洞

**请勿在 GitHub Issues 中公开安全漏洞。**

请将漏洞详情私密发送至仓库维护者（GitHub 私信 / 邮件见仓库首页），并在主题中注明 `[SECURITY]`。

报告时请包含：

- 受影响的版本与文件；
- 可复现的最小步骤或 PoC（避免包含真实凭据）；
- 影响的严重程度评估（如可被利用的途径）。

## 本项目的安全边界

Blender 助手启动一个监听 `127.0.0.1` 的中继服务，并按 Hana 的受管服务规范实现多道闸。
其中 **G0** 保护「Blender 侧 addon 的 `127.0.0.1:9876` 入口」——这是 2026-11 安全审查
（市场 PR #123 审查意见）指出的边界：该入口原本**零鉴权**，任何能连上该回环端口的本机进程
都能以 Blender 用户权限调用 `execute_code` 执行任意 Python，从而绕过受管中继。G0 之后，
直连 9876 也必须持有共享令牌。

| 闸 | 保护对象 | 实现 |
|---|---|---|
| **G0 addon 入口鉴权** | Blender addon `127.0.0.1:9876` | 每条命令须带 `auth` 令牌（常量时间比较）；缺失 / 错误一律拒绝执行。令牌由宿主每次启动生成，写入本用户临时目录令牌文件（0600），relay 经协议层 `addon-protocol.mjs` 的 `plan()` 注入，addon 入口 `vendor/blender-mcp-addon.py` 校验。env `BLENDERMCP_ADDON_TOKEN` / `BLENDERMCP_ADDON_TOKEN_FILE` 可覆盖以便宿主强注入。未配置令牌时 addon **安全默认=拒绝全部命令**。 |
| G1 调用方密钥 | 中继自身 HTTP 控制面 | `randomBytes(32).hex` 经 **argv 末位**传入，不落盘；请求头 `X-Hanako-Service-Key`；`timingSafeEqual` 常时比较 |
| G2 Host / 浏览器指纹 | Host 白名单 `127.0.0.1:<PORT>` / `localhost:<PORT>`；带 `Origin` 或 `Sec-Fetch-Site`（非 none）即 403 |
| G3 方法分级 | 写路由 POST-only，方法不对回 **405**（不是 404） |
| G4 请求格式 | 写路由强制 `application/json`，缺失也拒（415）；body 须为非数组 JSON 对象 |
| G5 参数绑定 | `dest`/`dir`/`files` 一律解析真实路径并绑定允许根；`files` 每项须为裸文件名 |

免鉴权面只开给**只读**路径（`/health` `/doctor` `/preview` `/scene` `/object` `/rt/commands` `/rt/capabilities` `/rt/who`），且按路径白名单判定——不按 op 判，因为 body 只能读一次。

## 报告范围内的已知取舍

- `do` 动作刻意不阻断：它能跑任意 Python，这是设计意图。**租约不覆盖它**，README 已写明。
- **G0 对 `vendor/` 的改动是刻意的、受控的**：为在 addon 入口加鉴权，仅在协议适配层
  `vendor/dsh-rt/runtime/addon-protocol.mjs` 的 `plan()` 注入 `auth` 字段（不改变上游算法/生成器），
  令牌读取逻辑与 `vendor/blender-mcp-addon.py`（MIT，本仓已大幅改造）共用同一套解析规则
  （见 `vendor/_addon_auth.py`）。上游 BSD 的算法/机构/生成器代码未改动。
- `vendor/` 为上游 BSD-3-Clause 代码，安全修复以上游为准。

## 处理流程

1. 确认收到后 7 天内给出初步评估；
2. 修复合并到 main 并发布新版本（不替换已发布版本）；
3. 在 Release notes 中致谢报告者（除非要求匿名）。
