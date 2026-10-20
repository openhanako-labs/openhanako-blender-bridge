# Blender 助手

[![version](https://img.shields.io/badge/version-1.63.1-4A6E80)](https://github.com/openhanako-labs/openhanako-blender-bridge/releases)
[![license](https://img.shields.io/badge/license-AGPL--3.0-4A6E80)](LICENSE)
[![blender](https://img.shields.io/badge/blender-4.x%2B-4A6E80)](https://www.blender.org/)

把本机 Blender 接进 Hana。模型可以直接**看视口、跑 bpy 代码、读场景结构、搜索参数、下判断**——不需要点鼠标，不需要把截图塞进提示词。

> 起这个名字是因为它做的事很清楚：一座桥。桥的两头是 Hana 和 Blender。

| | |
|---|---|
| **版本** | [1.63.1](CHANGELOG.md) |
| **环境** | Windows · Node ≥ 20 · Blender 4.x+ |
| **安装** | [`INSTALL.md`](INSTALL.md) |
| **变更** | [`CHANGELOG.md`](CHANGELOG.md) |
| **安全** | [`SECURITY.md`](SECURITY.md)（五道闸，勿公开提漏洞） |
| **参与** | [`CONTRIBUTING.md`](CONTRIBUTING.md)（含仓库布局与同步方法） |

---

## 它解决什么

给 Blender 加 AI，难点不在模型，在**通道**：

- Blender 的所有 `bpy` 操作**必须在主线程**跑，外部进程直接调会崩或静默失效
- Hana App 的 AppHost **默认拒绝** raw socket、子进程、任意网络
- 中间还隔着 Blender 自己的 UI 线程模型

---

## 架构

三段式：**Blender addon 起本地 TCP 服务 → 受管 Node 中继翻译协议 → Hana 工具面**。

```
Hana 模型 → blender 工具
      → App 主进程（AppHost，无 socket 权限）
        → 受管 Node 中继（runtime/blender-relay.mjs，local-machine profile）
          → 单一 TCP 127.0.0.1:9876
            → Blender addon（把命令排队回主线程执行 bpy）
```

三个关键决定：

**中继是受管 runtime。** 宿主逐次授予权限，App 主进程永远拿不到 socket 句柄。这不是过度设计——是 AppHost 的默认策略逼出来的唯一正路。

**单一 TCP，不是连接池。** addon 的应答没有帧分隔符（无换行，多条应答直接拼接），且命令在 addon 侧全局串行（一个 `command_queue`）。多开连接没有性能收益，只增加交错与重连复杂度。所以中继进程内直接复用上游 engine 的客户端——**一进程、一连接、全能力**。

**工具面是一个工具、35 个动作。** 一个 `blender` 工具，`action` 选动作。分组：基础（`doctor` `see` `view` `do` `scene` `object` `raw`）、搜索与判定（`loop` `plan` `txn`）、产出（`render` `channel` `assets` `headless` `runs`）、质量（`qc` `deliver` `audit` `perf` `generator` `motion` `preset`）、通道管理（`lease` `worker` `job`）。完整清单见 [`docs/tools.md`](docs/tools.md)。

其余机制文档在 [`docs/`](docs/README.md)：中继 HTTP 面与五道闸、产物归档、界面取向、随包技能、第三方组件。

---

## 参考仓库

本项目照着族内这几个 App 做的，通道范式、发布规程、视觉规范都源自它们：

| 仓库 | 借了什么 |
|---|---|
| [hanako-gallery](https://github.com/openhanako-labs/openhanako-gallery) | 受管 runtime 的骨架（`lib/runtime-host.mjs` + `runtime/service.mjs`），五道闸的实物对照 |
| [hanako-mail](https://github.com/openhanako-labs/openhanako-mail) | 带 backend 依赖的打包口径、`CHANGELOG` 写法 |
| [bilibili-intake-v2](https://github.com/openhanako-labs/openhanako-bilibili-intake) | App 沙箱内跑外部程序的五道坎 |
| [eleckoi-tavern](https://github.com/openhanako-labs/openhanako-tavern) | 卡片分「验收」与「操作」两张的设计取向 |

发布规程与视觉规范见内部文档《HanaApp 发布与视觉手册》（五道闸口径、图标封面七条、发版流水线）。

---

## 安装

见 [`INSTALL.md`](INSTALL.md)。两半：装 Blender 本体 + 装 Blender 侧 addon。

## 依赖

- Blender 4.x / 5.x（GUI 模式运行）
- Blender 侧 addon：`ahujasid/mcp-for-blender`（BSD-3，已随包带在 `vendor/`）
- 无需额外装 Node（中继跑在 Hana 的受管 runtime 里）

## 许可

自有代码 AGPL-3.0-or-later；`vendor/` 为上游 BSD-3-Clause，`skills/blender-modeling/` 为 MIT 派生作品。详见 [`LICENSE`](LICENSE)。

## 变更

见 [`CHANGELOG.md`](CHANGELOG.md)。安全策略见 [`SECURITY.md`](SECURITY.md)，参与方式见 [`CONTRIBUTING.md`](CONTRIBUTING.md)。
