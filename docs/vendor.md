# 第三方组件与许可

本 App 内嵌了两份第三方代码，**许可不同**，不能笼统归为一种：

| 位置 | 许可 | 版权 |
|---|---|---|
| `vendor/dsh-rt/` | **BSD 3-Clause** | sixtyseven67 |
| `vendor/blender-mcp-addon.py` | **MIT** | Siddharth Ahuja |

## 1. `vendor/blender-mcp-addon.py`（MIT）

Blender 侧的 MCP 桥接 addon。来源 `ahujasid/mcp-for-blender`
（https://github.com/ahujasid/blender-mcp，MIT，3 万+ 星）。
它负责 TCP 通道的另一端，以及把命令排队回主线程执行 `bpy`。

许可全文见 `vendor/LICENSE-blender-mcp.txt`。

## 2. `vendor/dsh-rt/`（BSD-3-Clause）—— 迁移自 `dsh-blender-plugin`

一个成熟的 DSH × Blender 直连插件。

**当前 vendor 版本：上游 `main`（v2.5 线，2026-10-20 取）。**

> 历史：最初 vendor 的是 **v0.9.0（2026-09-17）**的快照，它缺了整整一层「能力族」。
> 这件事是**实测撞出来的**：装上随包建模技能后，把书里 59 个 `op` 逐个对过，
> **只有 17 个能接** —— 而书里「动手前先查」的那张类型表，12 行里有 9 行
> 指向不存在的 op（`shape_revolve` / `vehicle_loft` / `human_base` / `gate_run` …）。
>
> 补齐后：**20 → 52 个文件 / 1810 KB**，新增 28 个模块
> （`shapegen` / `human` / `vehicle` / `sculpt` / `gate` / `printcheck` / `sweep` /
> `uv_tools` / `mesh_fix` / `material` / `imgtools` / `pipeline` / `clearance` /
> `geo` / `calib` / `faceeval` / `catalog` / `paths` …）。

这次升级实测只付了一处代价：**中继零代码改动**。它只用了 `createEngine` / `AddonClient` 两个符号（新版都有），加一个 `DSH_BLENDER_EXE` 环境变量。

**没换 addon**：上游 v2.3 起弃用了我们正在用的 `MCP for Blender`，但实测它**不硬拦**（无版本闸门，只读 `dshbb_` 前缀与 `dshbb_use_*` 开关，读不到就是"没开"）。代价是 15 个新命令（`get_selection` / `get_collections` / `get_activity_state` / `send_*_to_dsh`）不可用 —— **那 15 个是宿主集成，不是建模能力族**；建模族全在 Python 侧，与 addon 版本无关。协议实测同形：`ping` → `{"status":"success","result":{"pong":true}}`。

- **来源**：`sixtysevenlf/dsh-blender-plugin`
  （此前这里写的是 `sixtyseven67` —— 那是爱发电的 ID，仓库作者是 `sixtysevenlf`，已改）
- **许可**：BSD-3-Clause，全文见 `vendor/LICENSE-dsh-blender.txt`
- **变更说明**：本 App 迁移了其 `runtime/`（Node 后端 + Blender 侧 Python 模块），并做了以下改动：
  1. 目录重排为 `runtime/` + `tests/` + `docs/`（满足其自检脚本的路径假设）
  2. **不启动**其自带 HTTP 服务（`server.mjs`）；改为在 App 中继进程内动态 import `engine.mjs`，让它的 addon 客户端成为**唯一**的 TCP 连接持有者
  3. 新增 `tests/_run_selftest.py`：一个跑其自检的包装（先建 K 内核）

  其核心逻辑（契约层、规划器、内环、事务、QC、布局、生成器、机构等）**未作修改**。

- **版权声明**：

  ```
  BSD 3-Clause License

  Copyright (c) 2026, sixtyseven67
  All rights reserved.
  ```

**我们不为此衍生品声称任何原创性或背书**。上游的一切功劳归上游。
