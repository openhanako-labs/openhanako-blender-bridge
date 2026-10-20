# Blender 助手

把本机 Blender 接进 Hana。模型可以直接**看视口、跑 bpy 代码、读场景结构、搜索参数、下判断**——不需要点鼠标，不需要把截图塞进提示词。

> 起这个名字是因为它做的事很清楚：一座桥。桥的两头是 Hana 和 Blender。

---

## 它解决什么

给 Blender 加 AI 这件事，难点不在模型，在**通道**：

- Blender 的所有 `bpy` 操作**必须在主线程**跑，外部进程直接调会崩或静默失效
- Hana App 的 AppHost **默认拒绝** raw socket、子进程、任意网络
- 中间还隔着 Blender 自己的 UI 线程模型

所以这个 App 是三段式：**Blender addon 起本地 TCP 服务 → 受管 Node 中继翻译协议 → Hana 工具面**。

---

## 工具

一个工具 `blender`，`action` 选动作：

### 基础

| action | 做什么 |
|---|---|
| `doctor` | 通道体检：TCP → addon → bpy 三级诊断。**装完或连不上先跑它** |
| `see` | 看当前视口，返回一张图（`maxSize` 最长边，默认 900，上限 1600） |
| `view` | **从任意角度出图**（`from` / `look_at`）——不建相机、不动你的视口 |
| `do` | 在 Blender 主线程执行 Python（`bpy` 可用） |
| `scene` | 读场景结构（物体清单、类型、位置） |
| `object` | 读单个物体详情（参数 `name`） |
| `raw` | 直通 addon 原生命令（`type` / `params`） |
| `commands` | 列出 addon 当前可用命令面（哪些常驻、哪些因开关/缺 key 不可用） |
| `status` | 本 App 与中继的运行状态 |
| `connect` | 显式拉起/重连中继 |

### 搜索与判定

| action | 做什么 |
|---|---|
| `loop` | **内环搜索**：把几千次迭代放 Blender 侧跑（实测 ~170 次/秒，不消耗模型回合）。`spec.step` 写搜索步骤、`spec.measure` 给 `score` 赋值 |
| `plan` | **契约层 + 规划器**：假设 / 区间 / 可辨识性 / 证据 / 破坏性门控 / 三态判定。**证据不足时它报 `unresolved` 而不是二选一** |
| `txn` | **事务回滚**：对象级 `mark`/`revert`（毫秒级）+ 文件级 `snapshot`/`restore` |

### 产出

| action | 做什么 |
|---|---|
| `render` | 渲染出图（`op=start`/`status`），默认 EEVEE |
| `channel` | **渲染通道**：depth / normal / color / alpha / mist / position / mask → PNG，可直接喂 ComfyUI ControlNet |
| `assets` | **资产源**：PolyHaven 检索 / 下载 / 导入场景 |
| `headless` | **无头进程**：独立 `blender -b` 跑脚本，不占 GUI 通道 |
| `service` | Blender 服务进程起停（`op=status`/`start`/`stop`，走计划任务，独立于 Hana 存活） |
| `runs` | **产物归档**：把一次产出收进带户口的 run 目录（见下） |

### 质量

| action | 做什么 |
|---|---|
| `qc` | **QC 比对**：`compare`（两版并排）/ `compare_auto` / `render_views` / `self_check` |
| `deliver` | 交付导出与校验：`export` / `verify` |
| `audit` | 场景体检：`mesh` / `scene` / `duplicates` |
| `perf` | 性能分析：`status` / `analyze` / `apply` / `revert` |
| `generator` | 参数化生成器：`save` / `run` / `list` / `get` / `diff` |
| `motion` | 机构：关节建模、轴向推断、URDF / USDA 导出 |
| `preset` | 配方库：参数组合存成可套用、可分发的资产 |

### 通道管理（多会话共存）

| action | 做什么 |
|---|---|
| `lease` | **写锁**：`op=who` 看是谁持有 / `acquire` 拿写权（可 `force` 抢占）/ `release` 释放 / `renew` 心跳续期 |
| `worker` | **热会话**：常驻 Blender 进程。连续渲染时每帧 ~16s → ~1.35s |
| `job` | **后台作业**：提交即返回，`status` / `collect` / `kill` 跟进 |

---

## 产物归档（run）

以前产物散在 `work/` 里，命名靠 stem 拼——同一批的多张图没有共同归属，过两轮就分不清哪张属于哪一版。更麻烦的是「采用这一版 / 退回那一版」这种决定**没有落点**：决定了也只是嘴上决定，磁盘上看不出差别。

现在一次产出 = 一个 **run 目录**：

```
runs/20261014T2315_tiger-v12/
  run.json        户口：动作、时间、标记、体积、产物清单
  hero.png        主图（验收第一眼看的）
  views/          其他视角
  qc/             通道图、对比图
  export/         导出产物
  notes.md        人写的备注
```

**目录即单位，`run.json` 即户口。** 决定写在 `tag` 上，从此可查。

- 出一组通道图 / 一次多视角 / 一次 QC 时，App **自动建 run 并收产物**——不指望 agent 每次记得手动归档（一忙就忘，忘了就退回老状态）
- 一次产多个视角时，第一个带 `hero:true`，其余带同一个 `runId` 续入
- 想手动控制：`runs op=begin` → `put` → `finish`

**保留策略（标记制）**：打了 `baseline` 的永久保留，其余只留最近 20 个。

```
runs op=prune dryRun=true     # 先看要清理什么（默认就是 dry-run）
runs op=prune                 # 真清
runs op=tag id=<run> tag=baseline
```

**为什么归档在 App 数据目录、投递另配**：归档必须通用（宿主按用户分配 `app-data`，写在哪儿都找得到）；投递则是「把成品再拷一份到我在乎的地方」（比如 ComfyUI 的 input）。后者是个人偏好，所以做成设置页里填的绝对路径，**默认空——没配就不投**。

---

## 界面

两张卡，面向两种时刻：

| 卡 | 面向 | 内容 |
|---|---|---|
| **工作台** | **验收者**——「这版做得怎么样」 | run 列表、主图、产物清单、标基线、写意见、**设置** |
| **控制台** | **操作者**——「手上还有活要干」 | 冷启动五步进度、服务起停、bpy 执行、通道与体检 |

**设置为什么不放宿主的设置页**：它曾经挂在那边（`contributes.settings` → 独立一页）。
搬进卡片的理由不是“少一次跳转”，而是**归属**：「装了什么 addon、往哪投、归档怎么清、怎么装」
是**用这个 App 时随时要看的**，不是安装时看一眼就再也不碰的东西。
散在宿主总设置里，人根本不会去那里找。

（搬的时候顺手把 `panel.css` 剪干净了：它原先是那独立页的样式表，
里面还留着上一代「控制台」页的残留，以及三个会和 workbench 抢同名类的规则
——`.shell` / `.mono` / `.dot`。细节见该文件头部注释。）

主界面按**结果**优先设计。理由：这个 App 里主要甚至全部工作都由 agent 完成，人要做的是**看结果、下判断**，不是操作面板。所以工作台是默认的那张。

**写意见**：run 详情里有自由输入框（不只有「采用 / 回退 / 再改一版」三个按钮——只给选项等于把话堵死，人想说的常常不在选项里）。写下的话存在本地，切走再回来还在，回会话里说一声 agent 就照着改。

**主题跟随**：界面颜色从宿主主题读，不写死。宿主不注入主题时**如实标「兜底色板」**，不假装跟随成功。

---

## 架构

```
Hana 模型 → blender 工具
      → App 主进程（AppHost，无 socket 权限）
        → 受管 Node 中继（runtime/blender-relay.mjs，local-machine profile）
          → 单一 TCP 127.0.0.1:9876
            → Blender addon（把命令排队回主线程执行 bpy）
```

中继是**受管 runtime**：宿主逐次授予权限，App 主进程永远拿不到 socket 句柄。这不是过度设计——是 AppHost 的默认策略逼出来的唯一正路，本机 ComfyUI App 用的是同款范式。

**为什么是「单一 TCP」**：addon 的应答**没有帧分隔符**（无换行，多条应答直接拼接），且命令在 addon 侧**全局串行**（一个 `command_queue`）。多开连接没有性能收益，只增加交错与重连复杂度。所以中继进程内直接复用上游 engine 的客户端——**一进程、一连接、全能力**。

---

## 中继 HTTP 面（免鉴权只读）

中继的主要消费者是工具面，但它也开了一条**很窄的 HTTP 面**，给卡片、脚本这类「拿不到 key」的调用方用。

**只有下面这些路径免鉴权**，其余一律要 `x-relay-key` 头——key 每次启动随机生成，只经一个启动用的临时配置文件交给中继，**中继读完即删**：

| 路径 | 方法 | 做什么 |
|---|---|---|
| `/health` | GET / POST | 进程与连接状态、调用计数、**当前免鉴权路径清单** |
| `/doctor` | POST | 三级探测（ping → addon → bpy），不改任何东西 |
| `/preview` | **GET** | **实时预览快照**：当前视口一张 PNG（固定 `maxSize=900`） |
| `/scene` | POST | 读场景结构 |
| `/object` | POST | 读单个物体 |
| `/rt/commands` | POST | 列 addon 命令面 |
| `/rt/capabilities` | POST | 列能力 |
| `/rt/who` | POST | 查写锁（lease）持有者 |

### 三个容易踩的点

**① 端口是动态的，而且配置文件常常是旧的。**
每次拉起中继都换端口。别读 `app-data/blender-bridge/integration/relay-*.json`——那份文件可能是上一轮的旧值，甚至在中继启动后就被删了。可靠做法是**从进程反查**：命令行含 `blender-relay` 的那个 `hana-server` 子进程，取它 listen 的端口；或者先打 `/health` 问它自己。

**② 白名单只答了「谁免鉴权」，没答「怎么调」。**
`/preview` 是 **GET**，其余多数是 **POST**。方法不对照样 403——路径在白名单里不等于能调通。改这块时这两处要一起看（`PUBLIC_READ_PATHS` 和 `isPublicRead`）。

**③ `/preview` 为什么单开一条，不复用 `/see`。**
`/see` 接 `maxSize` / `file` 等参数，而预览只要一张快照；单开一条让调用方不必猜参数。它进免鉴权面的理由也很硬：预览是纯读（截图），不放它就得把 key 交给调用方，而 key 拿不到。

> 免鉴权门只开给**读**。写操作（`/do`、`/render`、`/service/*`）永远要 key，别为了图方便往里加。

---

## 安装

见 `INSTALL.md`。两半：装 Blender 本体 + 装 Blender 侧 addon（`vendor/blender-mcp-addon.py`）。

---

## 依赖

- Blender 4.x / 5.x（GUI 模式运行）
- Blender 侧 addon：`ahujasid/mcp-for-blender`（BSD-3，已随包带在 `vendor/`）
- 无需额外装 Node（中继跑在 Hana 的受管 runtime 里）

---

## 第三方组件与许可

本 App 内嵌了两份第三方代码，均为 **BSD-3-Clause**，版权归原作者：

### 1. `vendor/blender-mcp-addon.py`
Blender 侧的 MCP 桥接 addon。

### 2. `vendor/dsh-rt/` — 迁移自 `dsh-blender-plugin`
一个成熟的 DSH × Blender 直连插件（v0.9.0）。

- **来源**：`dsh-blender-plugin`，作者 sixtyseven67
- **许可**：BSD-3-Clause，全文见 `vendor/LICENSE-dsh-blender.txt`
- **变更说明**：本 App 迁移了其 `runtime/`（Node 后端 + Blender 侧 Python 模块），
  并做了以下改动：
  1. 目录重排为 `runtime/` + `tests/` + `docs/`（满足其自检脚本的路径假设）
  2. **不启动**其自带 HTTP 服务（`server.mjs`）；改为在 App 中继进程内
     动态 import `engine.mjs`，让它的 addon 客户端成为**唯一**的 TCP 连接持有者
  3. 新增 `tests/_run_selftest.py`：一个跑其自检的包装（先建 K 内核）

  其核心逻辑（契约层、规划器、内环、事务、QC、布局、生成器、机构等）**未作修改**。

- **版权声明**：
  ```
  BSD 3-Clause License

  Copyright (c) 2026, sixtyseven67
  All rights reserved.
  ```

**我们不为此衍生品声称任何原创性或背书**。上游的一切功劳归上游。

---

## 版本

- `1.54.0` — **中继免鉴权只读面**（`/preview` 等八条，见上）；装配特征库（`plan op=fit_help` / `mate_check`）；生成后自动干涉检查（`do check=collide`）；画风比例模板（`plan op=proportion`）。schema 抽成 `schema.js` 单一事实源，自检对齐 35 action / 137+ 参数
- `1.2.0` — 归档体系（run 目录 + 标记制 + 工作台）、多会话写锁、热会话、后台作业、配置落盘、包体精简 0.85 MB
- `1.1.0` — 能力面修复：25 条 action 说明接回工具描述（此前是死代码），schema 103 KB → 14.4 KB
- `0.8.0` — 迁移上游 runtime：任意视角、内环搜索、契约层（三态判定）、事务回滚、无头进程
