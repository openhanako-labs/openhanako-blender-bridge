# 工具清单

一个工具 `blender`，`action` 选动作，共 35 个。

## 基础

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

## 搜索与判定

| action | 做什么 |
|---|---|
| `loop` | **内环搜索**：把几千次迭代放 Blender 侧跑（实测 ~170 次/秒，不消耗模型回合）。`spec.step` 写搜索步骤、`spec.measure` 给 `score` 赋值 |
| `plan` | **契约层 + 规划器**：假设 / 区间 / 可辨识性 / 证据 / 破坏性门控 / 三态判定。**证据不足时它报 `unresolved` 而不是二选一** |
| `txn` | **事务回滚**：对象级 `mark`/`revert`（毫秒级）+ 文件级 `snapshot`/`restore` |

## 产出

| action | 做什么 |
|---|---|
| `render` | 渲染出图（`op=start`/`status`），默认 EEVEE |
| `channel` | **渲染通道**：depth / normal / color / alpha / mist / position / mask → PNG，可直接喂 ComfyUI ControlNet |
| `assets` | **资产源**：PolyHaven 检索 / 下载 / 导入场景 |
| `headless` | **无头进程**：独立 `blender -b` 跑脚本，不占 GUI 通道 |
| `service` | Blender 服务进程起停（`op=status`/`start`/`stop`，走计划任务，独立于 Hana 存活） |
| `runs` | **产物归档**：把一次产出收进带户口的 run 目录（见 [`runs.md`](runs.md)） |

## 质量

| action | 做什么 |
|---|---|
| `qc` | **QC 比对**：`compare`（两版并排）/ `compare_auto` / `render_views` / `self_check` |
| `deliver` | 交付导出与校验：`export` / `verify` |
| `audit` | 场景体检：`mesh` / `scene` / `duplicates` |
| `perf` | 性能分析：`status` / `analyze` / `apply` / `revert` |
| `generator` | 参数化生成器：`save` / `run` / `list` / `get` / `diff` |
| `motion` | 机构：关节建模、轴向推断、URDF / USDA 导出 |
| `preset` | 配方库：参数组合存成可套用、可分发的资产 |

## 通道管理（多会话共存）

| action | 做什么 |
|---|---|
| `lease` | **写锁**：`op=who` 看是谁持有 / `acquire` 拿写权（可 `force` 抢占）/ `release` 释放 / `renew` 心跳续期 |
| `worker` | **热会话**：常驻 Blender 进程。连续渲染时每帧 ~16s → ~1.35s |
| `job` | **后台作业**：提交即返回，`status` / `collect` / `kill` 跟进 |
