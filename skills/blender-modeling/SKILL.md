---
name: blender-modeling
description: Blender 建模流程与装配作业指导书。触发场景：做一个 / 建一个 / 捏一个 3D 物体、加个立方体 / 球 / 圆柱 / 圆环、挤出 / 内插 / 倒角某个面、加修改器、挖个洞（布尔）、做个剑 / 椅子 / 门 / 水壶 / 车 / 人形、按参考图还原外形、量比例、把照片里的东西建出来、装配体检（查穿模 / 浮空 / 间隙 / 连通性）、多 agent 分工造一台机器、要"像不像"的数值证据（IoU / 剖面 / 尺寸对拍）、模型改了一版要验收、交付前过数值门、渲染取景切边、长活续跑。也用于：模型建完但"看着对、没依据"、要报 unresolved 而不是二选一、要把参数搜索交给机器跑（内环）。不触发：只查通道状态、只起停 Blender、与本机 Blender 无关的建模讨论。
---

# Blender 建模（入口）

> 本文件是**入口**，保持短。细节按主题**按需加载** `references/` 下的文档。
> 主线内容来自上游 `dsh-blender-plugin` 随包技能（MIT，见文末许可）。

## 一、先记三条纪律，再看工具

这三条是这个技能真正值钱的地方。**不遵守它们，后面的配方一条都用不对。**

### 1. 改一步看一眼 —— 不要一口气写完整个模型再回来看

每一步都要有**画面或数字证据**。没有证据的"我建好了"，是本技能明确反对的。

> 实测来源：一个项目几何阶段 138 件一次过网格门（8 个计数全 0），
> 而**渲染阶段返工两轮** —— 取景按 AABB 估（3/4 视角全切边）、改 `location` 没刷依赖图（差 2.2 倍）、
> 居中解符号写反（发散到 1e15）。**这些都不是几何错，是"没改一步看一眼"。**

### 2. 三态判定：证据不足要报 `unresolved`，不许二选一

`supported` / `refuted` / **`unresolved`（证据不足是一等状态，不是失败）**。

还有一层叫**可辨识性**：某个参数在允许区间内变来变去、而外部证据完全不变（极差≈0）
→ 必须**说出来"在现有证据下判不了"**，不能随手取一个值当结论。

### 3. 破坏性操作前置门控

`boolean_union` / `weld`（拓扑焊接）/ `apply_transform` —— **判别清楚前一律不做**。
理由：拓扑一旦被改写，假设翻转后无法恢复；参数化一丢，区间就失去意义。

配套：大改前 `txn` 打回退点。**对象级 `mark/revert` 是毫秒级的；拓扑改动必须 `snapshot/restore`。**

## 二、工具译名表（★ 动手前必读）

> ⚠ **先读下面那条「能力缺口」——本 App 的 runtime 比这份指导书旧很多，
> 书里大批 op 我们根本没有。** 不看那一条就照书调，会一直失败。

**本 App 的工具面是一个 `blender` 工具 + `action=`。**
下面这套命名来自上游文档 —— **同一个内核（`dsh-rt`），只是叫法不同**。
`references/upstream-playbook.md` 整本都写的是左列的名字，读的时候对着这张表换。

| 上游写法 | 本 App 里怎么调 |
|---|---|
| `blender_rt_do` | `do` |
| `blender_rt_see` | `see`（当前视口，自动取景）/ `view`（任意机位，不动你的视口） |
| `blender_rt_watch` | **未接** —— 要看"动没动"就用 `see` 连拍两次比对 |
| `blender_rt_loop` | `loop` |
| `blender_rt_cmd` / `blender_rt_commands` | `raw` / `commands` |
| `blender_rt_perf` | `perf` |
| `blender_rt_opt` | **未接** |
| `blender_rt_headless` | `headless` |
| `blender_rt_worker` | `worker` |
| `blender_rt_txn` | `txn` |
| `blender_rt_preset` | `preset` |
| `blender_rt_job` | `job` |
| `blender_rt_plan(op=X)` | `plan op=X`（`plan` 的 op 是自由面） |
| `blender_rt_plan(op="audit_*")` | `audit op=*` |
| `blender_rt_plan(op="qc_*")` | `qc op=*` |
| `blender_rt_plan(op="deliver_*")` | `deliver op=*` |
| `blender_rt_plan(op="generator_*")` | `generator op=*` |
| `blender_rt_plan(op="motion_*")` | `motion op=*` |
| `blender_rt_plan(op="preset_*")` | `preset op=*` |
| `blender_viewport(op="doctor")` | `doctor` |
| `blender_viewport(op="launch"/"start")` | `service op=start` |
| `blender_viewport(op="stop")` | `service op=stop` |
| `blender_viewport(op="who"/"lease")` | `lease op=who` |
| `K.dsh_audit_api("mesh"/"connectivity"/"gate")` | `audit op=mesh` 等（同一个内核，只是入口不同） |
| `K.dsh_measure['silhouette_iou']` | 在 `loop` 的 `measure` 里直接用（内核里就是这个名字） |

**本 App 还有几个上游那本没写的动作**：`nodes`（配方 / geo / mat / uv / attach）、
`drive`、`wheel`、`rig`、`runs`（归档）、`dispatch`（派活）、`models`（列助手与模型）、`assets`（PolyHaven）、`channel`（渲染通道）。
不确定有什么，先 `commands` 列一遍，别猜。

## 二之二、能力缺口（★ 实测，2026-10-20）

**本 App 的 runtime 是上游 v0.9.0（2026-09-17）的快照，而本指导书写于 v1.x / v2.x。**
把书里出现的 59 个 `op` 逐个对过：**17 个有，42 个没有**。

**整族缺失**（每一个都调不通，别去试）：

| 族 | 缺什么 | 书里用它干什么 |
|---|---|---|
| `shape_*` | draft / plan / revolve / loft / sections / fit / regions / panels | §0.7 类型表的主力（旋转体、放样、参考图还原） |
| `human_*` | base / head / measure / spec | Recipe 15 / 16 |
| `vehicle_*` | package / base / sections / loft / panels / fit / regions | Recipe 17–21 |
| `sculpt_*` | scan / setup / apply / mask / filter | Recipe 11 |
| `gate_*` | plan / run | 装配总验收（三态） |
| 其它 | `print_report` / `sweep_analyze` / `sweep_build` / `crease_lines` / `inset_lines` / `img_rectify` / `img_diff` / `pipe_run` / `fix_repair` / `fix_decimate` / `uv_smart_project` / `uv_unwrap` / `uv_pack` / `uv_stats` / `clear_check` / `face_ratios` / `catalog` | §6 门清单、Recipe 11–24 的一大半 |

**实测确认**：`plan op=catalog` → `unknown contract op`；
整个 `vendor/dsh-rt/runtime` 里搜不到这些名字（不是找错文件）。

**那我们有什么**（这些是通的）：

- 通道与执行：`doctor` / `service` / `see` / `view` / `do` / `raw` / `commands` / `headless` / `worker` / `job` / `status`
- **契约层本身是活的**：`plan op=status` 正常（组件 / 连接 / 包络 / 证据 / 未判别连接）——
  即 `register_connection` / `check_envelope` / `check_interference` / `check_interface` /
  `destructive_guard` / `verify` / `flip` / `evidence` / `ledger` / `report`
- 内环：`loop`（setup/step/measure/board/export）
- 事务：`txn`（mark/revert/snapshot/restore）
- 体检：`audit op=mesh / scene / duplicates / collide`
- 判据：`qc op=compare / compare_auto / self_check / render_views`
- 导出：`deliver op=export / verify`
- 生成器：`generator op=save / run / list / get / diff` —— **参数化建模靠它**
- 机构：`motion op=joint / joints / infer_axis / measure / export_urdf / export_usda`
- 归档：`runs op=begin / put / finish / tag / views / prune / …`
- 本 App 自己加的：`nodes`（配方/geo/mat/uv/attach）/ `drive` / `wheel` / `rig` / `dispatch` / `models` / `assets` / `channel`

**怎么用这份书**：

- **方法论部分照用**——§0.5 多 Agent 分工、§1 六步总纲、§2 决策树、§4 六条必踩的坑、§5 修改器栈序、
  §6 门清单的**判据思想**，这些不依赖具体 op，而且正是这份书最值钱的地方。
- **操作部分先对照本表**——书上写的 op 不在上面那条"我们有"的名单里，就自己用 `do` 写 bpy 实现，
  或者先把缺的能力接回来（升级 runtime）。
- **不要因为书里写了就以为它存在**——不确定先 `commands` 列一遍，或者 `plan op=<名字>` 试一下（会回 `unknown contract op`）。

## 三、有限硬件下的约束（本机实测）

- **headless 里慎用 `bpy.ops`**：`bpy.ops` 是动态的，且无头进程里 `bpy.app.timers` **不会触发**
  （实测 1.2 s 内 0 次）→ 无头里用**阻塞循环**，内环留给 GUI 会话。
- **推荐姿势**：走 `bmesh` 与数据 API（确定性、可复现、零 context 报错）。
  本 App 自己的水壶生成器就是纯 `from_pydata` 手写面 —— 那是被无头环境逼出来的正解。
- **法线方向是一切穿模判据的前提**。先 `audit op=mesh` 看 `nonmanifold / boundary`，再谈干涉。

## 四、按需加载

| 你要做的事 | 读哪份 |
|---|---|
| 任一件事，先看总览与决策树 | `references/upstream-playbook.md`（§0 通道语义 / §2 决策树 / §1 六步总纲） |
| 具体怎么建（24 条编号配方） | `references/upstream-playbook.md` §3 |
| 六条必踩的坑 | `references/upstream-playbook.md` §4 |
| 交付前的数值门（**唯一权威门表**） | `references/upstream-playbook.md` §6 |
| 渲染 / 动画 / 长活 | `references/upstream-playbook.md` §6.5 |
| 多 Agent 并行建模的分工 | `references/upstream-playbook.md` §0.5 |
| 按参考图还原外形（"像不像"） | `references/参考图通用还原SOP.md` + `references/multiview-calibration.md` |
| 验收清单（交付/交接前逐条过） | `references/验收清单.md` |
| 建模概念与新手上手 | `references/modeling-overview.md` |

**上游那本有 163 KB、2060 行** —— 别一次读完。按上表取你当下需要的那一节。

## 五、它自己承认的盲区（记着，别重复踩）

- **单视 IoU 是必要不充分条件**：深度、内部特征（板缝/格栅/灯）、曲面张力它全看不见，
  而且"把轮廓填满"就能刷高它。配套必须再加间隙检查 + 尺寸对拍 + 特征线对照。
- **比值 / IoU 在均匀缩放下完全不变** → 结构上就看不见"绝对口径"差异。
  涉及绝对尺寸的项必须**单列一张对照表**并写清采用哪一套口径。
- **`transform_apply` 不会缩放 Bevel 修改器的宽度** → 做等比归一时必须先把修改器烘进网格。

## 六、来源与许可

本技能是 `sixtysevenlf/dsh-blender-plugin` 的随包技能 `skills/blender-modeling` 的收录（**MIT**）。
该技能本身融合自：

- `RobLe3/cc-blender-skill`（MIT）—— 决策树、8 个配方、三条关键坑、修改器栈序与症状表
- `arjun988/blender-skills`（MIT）—— 六步总纲、集合结构、修改器栈哲学、清理清单、MUST/NOT MUST

**原样收录、未作内容修改**，仅重排了文件位置（原 `SKILL.md` → `references/upstream-playbook.md`）
并补了本入口文件与译名表。完整版权与许可文本见同目录 `LICENSE` 与 `NOTICE.md`。
