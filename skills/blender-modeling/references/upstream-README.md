# blender-modeling（随插件捆绑）

> **这份 skill 已经并进插件仓库**（`@dsh-external/dsh-blender-plugin` 的 `skills/blender-modeling/`），
> 从 **v2.2.0** 起由插件在 DSH 启动时**自动注册为 bundled skill** —— 装插件就自带，
> **不需要**再单独 clone / 下载 / 软链。

## 用户怎么用

- 安装插件并**重启 DSH** 后，会话里的技能目录（`skill` 工具的 available skills 列表）会直接出现 `blender-modeling`；
  模型遇到「建一个 / 捏一个 3D 物体」「按参考图还原外形」「多 agent 分工造一台机器」「装配体检」这类任务时会自动加载。
- 手动确认：在会话里让模型 `skill` 加载 `blender-modeling`，或看技能目录里是否有这一条。
- **优先级**：如果你此前已经把独立仓库装进了 `~/.dsh/skills/blender-modeling`（user 级），它会**优先于**本包内的 bundled 副本
  （DSH 的 rank 规则：user 400 < bundled 600）；两份内容一样，不影响使用。想强制使用包内版本，删掉用户级目录/软链即可。

## 不装插件、只想把 skill 给别的宿主（Claude Code / Codex / Cursor…）

包安装目录就是一份标准 `skills/<name>/SKILL.md` 目录，直接软链或拷贝即可：

```bash
# 找到本包安装位置（示例：DSH profile 的 node_modules）
PLUGIN="$(dirname "$(node -e "console.log(require.resolve('@dsh-external/dsh-blender-plugin/package.json'))")")"
mkdir -p ~/.dsh/skills
ln -s "$PLUGIN/skills/blender-modeling" ~/.dsh/skills/blender-modeling   # 或者 cp -r
```

> ⚠ `SKILL.md` **必须保留 YAML frontmatter**（`name` / `description` / `license`）——加载器靠它建技能目录。

## 内容

- `SKILL.md` —— 建模 / 装配作业指导书（决策树、24 条编号配方、六条必踩的坑、数值门清单、多 Agent 分工范式）。
- `references/modeling-overview.md` —— 上游英文原文收录（深水参考）。
- `references/multiview-calibration.md` —— 三视图联立标定脚本（可 `--selftest`）。
- `references/参考图通用还原SOP.md` —— 参考图还原九步（含 S0 草稿评估）。
- `references/验收清单.md` —— 独立验证子代理专用（约 4.2k 字符，别让它加载整本 SKILL.md）。

## 许可与来源

- 本目录内容：**MIT**（见 [LICENSE](LICENSE)），Copyright © 2026 sixtyseven67。
- 派生自两个 MIT 项目（决策树 / 配方 / 坑表 / 六步总纲等），工具调用已改写为本插件 `blender_rt_*` 直连链：
  [RobLe3/cc-blender-skill](https://github.com/RobLe3/cc-blender-skill) ·
  [arjun988/blender-skills](https://github.com/arjun988/blender-skills)。
- 完整归属与本地改动见 [NOTICE.md](NOTICE.md)。
- 独立分发镜像（历史仓库，内容与本目录同步）：<https://github.com/sixtysevenlf/dsh-skill-blender-modeling>。

---

**同步口径**：本目录内容于 2026-10-19 从独立仓库工作区（HEAD `10d78cd` + v9 未提交改动）镜像而来；
此后**以本仓库为真源**维护，独立仓库仅作镜像/历史。
