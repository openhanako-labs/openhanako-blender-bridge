# 参与贡献（Contributing）

## 仓库布局：本仓库是发布物，开发树在旁

**本仓库（`openhanako-blender-bridge`）= 发布物，App 内容直接在根目录。**
这与族内其他仓库（gallery / mail / tavern）一致。

但**开发工作不在这里做**。开发树在本地另一个目录，App 本体是它的一个**子目录**：

```
blender-app/                    ← 开发树（开发仓库的根，不对外）
├── blender-bridge/             ← App 本体，对应本仓库的根
│   ├── index.js                ┐
│   ├── manifest.json           │  这些在发布仓库里
│   └── ui/ runtime/ vendor/... ┘  是【根目录】下的同名项
├── _probe/                     ← 测试与打包工具（不发布）
├── generators/                 ← 生成器源（不发布）
├── PLAN-*.md                   ← 计划文档（不发布）
└── package.json                ← 开发工作区的包描述（不发布）
```

**坐标变换：`blender-app/blender-bridge/X` → 本仓库的 `X`。**
子目录提根，其余全部不进去。

### 怎么从开发树同步到这里

```bash
# 在开发树上操作；开工前先确认工作区干净
git -C <开发树> status --short

# 抽出发布树（把子目录提到根，历史保留）
git -C <开发树> subtree split --prefix=blender-bridge -b _release-src

# 建一个独立 worktree（不要 checkout！见下）
git -C <开发树> worktree add <临时目录> _release-src

# 推到本仓库
cd <临时目录>
git push origin HEAD:main

# 收尾
git -C <开发树> worktree remove <临时目录>
git -C <开发树> branch -D _release-src
```

> ⚠️ **不要直接 `git checkout <发布分支>`。** 那会把整个工作目录换成发布树，
> `blender-bridge/` 目录会消失，`_probe/` 等未跟踪文件也可能被连带清掉。
> 用 `worktree add` 在另一个目录里操作，完全不碰当前工作树。

> ⚠️ **不要用 `gh repo create --source=.`。** 它在 worktree 里会报
> “not a git repository”（worktree 的 `.git` 是指针文件），但**可能在报错前
> 已经把当前分支推上去**。建仓库用 `gh api orgs/<org>/repos -X POST`，
> 再单独配 remote、单独推——分两步，每步都能验。

### 哪些不进去

| 排除 | 理由 |
|---|---|
| `PLAN-*.md`、`CLEANUP-清单.md`、`*工作底稿*` | 计划与过程文档，属于开发树 |
| `_probe/` | 测试与打包工具，随开发树 |
| `generators/` | 生成器源，运行时从 App 数据目录读 |
| `_camera-v1/`、`_kettle-v2/`、`_vendor-dsh/`、`_assets/` | 开发期素材 |
| `dist/` | 构建产物（已在 `.gitignore`） |
| `hana-app-skeleton/`、`package.json`（开发用） | 开发侧参考与脚本 |

**判据不是名称前缀，而是「这句东西对使用这个 App 的人有没有用」。**
例如 `_camera-v1/spec.py` 名字看着像临时目录，实际是完整的生成器规格，
应该留在开发树（进开发仓库），但不进发布仓库。

---

## 环境

- Windows（本项目在 Windows 10 + PowerShell 7 上开发与验证）
- Node.js ≥ 20
- Blender 4.x 及以上（addon 需要 GUI 常驻，`--background` 模式不支持实时通道）

## 开发工作流

在**开发树**里操作。源码在本仓库对应 `blender-bridge/` 子目录。修改后：

```bash
# 1. 跑测试（一条命令跑完全部）
npm test

# 2. 打包
node _probe/pack.cjs

# 3. 装到本机
#    extension_manager install <zip>  → 确认 → reload
```

打包器会自查：manifest 声明的入口、卡片路由、封面、侧栏路由、detached 路由是否都进了包，以及各个 HTML 里引用的资源是否存在。**自查不过的包不要发。**

## 提交规范

提交信息用中文，首行写清「做了什么」，正文写「为什么」。

```
feat(v1.63.1): 封面身份色条从通宽改为居中短横

手册 §4.2 原写「通宽」，与全族实物不符。对四张现役封面扫像素实测：
图库 23.9% / 音频 40.6% / 摄取 48.0% / 邮件 49.8%，均居中短横。
```

版本号遵循 `主.次.修订`：
- `主`：架构级改动（runtime 换代、路由面重构）
- `次`：新能力或新动作
- `修订`：修 bug 与视觉调整

**不替换已发布的同版本包**——修复一律发新版本号。

## 测试

`npm test` 跑 `_probe/run-all.mjs`，覆盖：

- 参数契约（schema → payload → python 三道贯通）
- 中继鉴权面（`relay-policy.test.mjs`：G2 指纹、G5 路径净化的负向矩阵）
- 路由与方法分级（`relay-routes.test.mjs`：源码真实路由与镜像清单对拍）
- 视图取景、对象操作、归档、日志轮转等

新增能力请补对应测试。**能抓住真实 bug 的测试才算测试**——改完代码后，把 bug 手动复原一次，确认测试会红。

## 上游代码

- `vendor/` 为 BSD-3-Clause 代码，**不修改**。升级上游不需要打补丁。
- `skills/blender-modeling/` 为 MIT 派生作品，改写说明见其 `NOTICE.md`。

## 视觉规范

图标与封面遵循 `HanaApp发布与视觉手册`。要点：

- 图标 256×256，描边 ≥ 画布 4%，元素 ≤ 3，每张一个身份色
- 封面 1080×1440（3:4），标题字号 ≥110px、总宽 ≤92%
- 身份色条 **13–14px 居中短横**（宽 24%–50%），**不是通宽**

## 报告问题

功能问题走 Issues；安全漏洞见 `SECURITY.md`（**不要公开提**）。
