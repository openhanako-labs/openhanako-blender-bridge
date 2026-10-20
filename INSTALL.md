# Blender 助手 · 安装（Blender 本体 + addon）

你机器上目前**没有 Blender**，所以「给 Hana 搞 Blender App」需要两半：App 侧（已就绪）+ Blender 侧（这份文档）。

---

## 一、装 Blender 本体

两条路，选一条：

### 路线 A：官网（推荐，干净）

1. 打开 https://www.blender.org/download/
2. 下载 Windows x64 的 **.msi** 或 **.zip**（4.2 LTS 或 5.x 都行）
3. .msi 直接装；.zip 解压到任意目录，把里面的 `blender.exe` 路径记下来

### 路线 B：Steam

Steam 库里搜 Blender 免费安装即可（但 Steam 版 addon 目录在用户配置里，也照样能用）。

装完确认一下——在 Blender 里 **Edit → Preferences → Add-ons** 能看到插件列表就说明本体没问题。

---

## 二、装 Blender 侧 addon

App 要连的是 Blender 里的一个 addon（开源项目 `ahujasid/mcp-for-blender`，BSD-3）。

仓库里已经带了一份：`vendor/blender-mcp-addon.py`

步骤：

1. Blender → **Edit → Preferences → Add-ons**
2. 右上角下拉 **Install from Disk…**（老版本是 **Install…**）
3. 选 `vendor/blender-mcp-addon.py`
4. 在列表里找到 **MCP for Blender**（或 "Blender MCP"），**勾选启用**
5. 回到 3D 视图，按 **N** 打开侧边栏
6. 找到 **MCP for Blender** 面板 → 点 **Connect**（默认 127.0.0.1:9876）

看到面板显示已连接（或端口 9876 在监听）就成了。

> 换端口：面板里可以改。改完回到 Hana 的 Blender 助手 → 设置，把地址同步改掉。

---

## 三、验证

在 Hana 里对这个 App 说：

> 用 blender 工具跑一次 doctor

或者打开 **Blender 助手** 卡片，点 **体检**。

三项都通过（TCP / addon / bpy）就算装好了。之后：

- 「看视口」→ 拿到一张当前视图的图
- 「执行」→ 直接跑 Blender Python
- 也可以让模型自己：*"用 blender 看下现在的场景"* / *「加一个立方体，然后截图给我看」*

---

## 四、想直接打端点验证？

中继开了一条**免鉴权只读面**（`/health`、`/preview` 等八条），不用 key 就能调，适合卡片或脚本自己取图。完整清单、以及「端口怎么找」这个坑，见 `README.md` 的 **「中继 HTTP 面」** 一节。

最短的一条验证：

```powershell
# 1) 找中继端口（它是动态的，别读配置文件）
$ns = Get-Process hana-server
$port = foreach ($p in $ns) {
  $cmd = (Get-CimInstance Win32_Process -Filter "ProcessId=$($p.Id)").CommandLine
  if ($cmd -match 'blender-relay') {
    (Get-NetTCPConnection -OwningProcess $p.Id -State Listen).LocalPort |
      Where-Object { $_ -gt 10000 }
  }
}
# 2) 问它自己
Invoke-RestMethod "http://127.0.0.1:$port/health"
```

`connected: true` 就说明 addon 已应答。再打 `/preview` 能拿到一张当前视口 PNG。

---

## 为什么需要 addon，不能直连

Blender 的所有 `bpy` 操作**必须在主线程**跑。addon 的作用就是起一个本地 TCP 服务，把外部命令排队扔回主线程执行——这是绕过 Blender 线程模型的唯一正路。所以 App 侧永远是「连 addon」，不是「连 Blender」。

## 通道怎么走的

```
Hana 模型 → blender 工具
      → App 主进程（AppHost，无 socket 权限）
        → 受管 Node 中继（runtime/blender-relay.mjs）
          → TCP 127.0.0.1:9876
            → Blender addon（主线程执行 bpy）
```

中继是**受管 runtime**：宿主逐次授予权限，App 主进程永远拿不到 socket 句柄。这条设计是被 AppHost 的默认策略逼出来的，也是本机 ComfyUI App 在用的同款范式。
