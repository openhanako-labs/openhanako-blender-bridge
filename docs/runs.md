# 产物归档（run）

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

## 保留策略（标记制）

打了 `baseline` 的永久保留，其余只留最近 20 个。

```
runs op=prune dryRun=true     # 先看要清理什么（默认就是 dry-run）
runs op=prune                 # 真清
runs op=tag id=<run> tag=baseline
```

## 为什么归档在 App 数据目录、投递另配

归档必须通用（宿主按用户分配 `app-data`，写在哪儿都找得到）；投递则是「把成品再拷一份到我在乎的地方」（比如 ComfyUI 的 input）。后者是个人偏好，所以做成设置页里填的绝对路径，**默认空——没配就不投**。

## 建议的用法

- 产出多张图 / 一次 QC / 一次导出时：先 `begin` 再逐张 `put`，最后 `finish`
- 做完一版建议 `finish` 时带 `views:true`——一次迭代对应一组视图，人在面板上一眼能看全
- 单拍用 `op=views`
- 可交付的那一版记得 `tag=baseline`；已投递到目标目录的标 `delivered`
- 开新一版之前先 `runs op=feedback` 读一下上一版留下的意见——**那是人给的输入，不是背景噪音**
