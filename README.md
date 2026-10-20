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

## 站在谁的肩膀上

**这个 App 的大部分能力不是我们写的。** 三十五、六个 action 里，契约层、规划器、内环搜索、
事务回滚、QC 比对、生成器、机构解算那一整套，来自下面这个上游项目；
Blender 侧的通信底座来自另一个；建模方法论来自第三个。

本项目的改动集中在两件很具体的事上：**把直连通道改造成受管 runtime 的形态**，
以及**接进 Hana 的工具面与卡片**。其余是上游的功劳，见 [`docs/vendor.md`](docs/vendor.md)。

### 代码上游

| 项目 | 许可 | 在本项目里的位置 |
|---|---|---|
| [**sixtysevenlf/dsh-blender-plugin**](https://github.com/sixtysevenlf/dsh-blender-plugin)<br>DSH × Blender 直连实时插件 | BSD-3-Clause | `vendor/dsh-rt/` —— **能力族的主体**：契约层、规划器（`plan`）、内环搜索（`loop`）、事务（`txn`）、QC、生成器、机构（`motion`）、无头进程等 |
| [**ahujasid/mcp-for-blender**](https://github.com/ahujasid/blender-mcp)<br>Blender 侧 MCP 桥接 addon | MIT | `vendor/blender-mcp-addon.py` —— TCP 通道与 `bpy` 主线程执行的那一端 |
| [**RobLe3/cc-blender-skill**](https://github.com/RobLe3/cc-blender-skill) | MIT | `skills/blender-modeling/` 的决策树、配方、坑表 |
| [**arjun988/blender-skills**](https://github.com/arjun988/blender-skills) | MIT | 同上：六步总纲、修改器栈哲学、清理清单 |

后两个的上游是 sixtysevenlf 那份随包技能的再上游；本项目的建模技能是它们三者的融合派生，
改写说明见 `skills/blender-modeling/NOTICE.md`。

### 族内参考

发布形态、通道骨架、视觉规范向这几个 App 看齐：

| 仓库 | 借了什么 |
|---|---|
| [hanako-gallery](https://github.com/openhanako-labs/openhanako-gallery) | 受管 runtime 的骨架（`lib/runtime-host.mjs` + `runtime/service.mjs`），五道闸的实物对照 |
| [hanako-mail](https://github.com/openhanako-labs/openhanako-mail) | 带 backend 依赖的打包口径、`CHANGELOG` 写法 |
| [bilibili-intake-v2](https://github.com/openhanako-labs/openhanako-bilibili-intake) | App 沙箱内跑外部程序的五道坎 |
| [eleckoi-tavern](https://github.com/openhanako-labs/openhanako-tavern) | 卡片分「验收」与「操作」两张的设计取向 |

---

## 安装

见 [`INSTALL.md`](INSTALL.md)。两半：装 Blender 本体 + 装 Blender 侧 addon。

## 依赖

- Blender 4.x / 5.x（GUI 模式运行）
- Blender 侧 addon：`ahujasid/mcp-for-blender`（**MIT**，已随包带在 `vendor/`）
- 无需额外装 Node（中继跑在 Hana 的受管 runtime 里）

## 许可

自有代码 AGPL-3.0-or-later。`vendor/dsh-rt/` 为 upstream **BSD-3-Clause**，
`vendor/blender-mcp-addon.py` 为 **MIT**，`skills/blender-modeling/` 为 MIT 派生作品。
分项与全文见 [`LICENSE`](LICENSE)，上游明细见 [`docs/vendor.md`](docs/vendor.md)。

## 变更

见 [`CHANGELOG.md`](CHANGELOG.md)。安全策略见 [`SECURITY.md`](SECURITY.md)，参与方式见 [`CONTRIBUTING.md`](CONTRIBUTING.md)。
