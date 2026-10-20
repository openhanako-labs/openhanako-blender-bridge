# 中继 HTTP 面（免鉴权只读）

中继的主要消费者是工具面，但它也开了一条**很窄的 HTTP 面**，给卡片、脚本这类「拿不到 key」的调用方用。

**只有下面这些路径免鉴权**，其余一律要 `X-Hanako-Service-Key` 头——key 每次启动重新生成，**经 argv 末位交给中继，不落盘**（发布手册 §1.1 G1 口径，与 `hanako-gallery` / `hanako-mail` 同形）：

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

> 免鉴权门只开给**读**。写操作（`/do`、`/render`、`/service/*`）永远要 key，别为了图方便往里加。
> 白名单漏了只是少一个入口；黑名单漏了是开一个口子。

---

## 五道安全闸（发布审查口径，手册 §1.1）

本 App 带受管 runtime，属「受管服务 App」，须过五道闸。全部已做：

| 闸 | 实现 |
|---|---|
| **G1 调用方密钥** | `randomBytes(32).hex`，经 **argv 末位**传给中继，**不落盘**；请求头 `X-Hanako-Service-Key`；服务侧 `timingSafeEqual` 常时比较 |
| **G2 Host / 浏览器指纹** | Host 只认 `127.0.0.1:<PORT>` / `localhost:<PORT>`；带 `Origin`、或 `Sec-Fetch-Site` 值不是 `none` → 403。实现在 `runtime/relay-policy.mjs` |
| **G3 方法分级** | 路径认得但方法不对 → **405**（不是 404）。404 说"不存在"，405 说"存在但不接受这个方法"，是两件事 |
| **G4 请求格式** | 写路由强制 `Content-Type: application/json`，**缺失也拒**（415）；body 须为非数组 JSON 对象（400） |
| **G5 参数绑定** | `/deliver` 的 `src` 须落在允许根内；`files` 每项须为**裸文件名**（无分隔符、不是 `.` 或 `..`） |

**G2 的坑**：不要「见 `Sec-Fetch-*` 就拦」。实测 Node v24+ 的 undici fetch 会主动带 `sec-fetch-mode: cors`，
一刀切会把宿主桥自己误杀。要看的是 `Sec-Fetch-**Site**` 的**值**。
「地址栏直接打开」发的是 `Sec-Fetch-Site: none`，所以自己去看一眼不受影响。

**G5 的取舍**：锁名字而不是锁目录。`destDir` 是**用户配置的出口**（ComfyUI input 之类），
按设计不能锁在某个根内；能锁的只有名字。要子目录就分两次调用，代价为零。

---

## 三个容易踩的点

**① 端口是动态的，而且配置文件常常是旧的。**

每次拉起中继都换端口。别读 `app-data/blender-bridge/integration/relay-*.json`——那份文件可能是上一轮的旧值，甚至在中继启动后就被删了。可靠做法是**从进程反查**：命令行含 `blender-relay` 的那个 `hana-server` 子进程，取它 listen 的端口；或者先打 `/health` 问它自己。

**② 白名单只答了「谁免鉴权」，没答「怎么调」。**

`/preview` 是 **GET**，其余多数是 **POST**。方法不对照样 403——路径在白名单里不等于能调通。改这块时这两处要一起看（`PUBLIC_READ_PATHS` 和 `isPublicRead`）。

**③ `/preview` 为什么单开一条，不复用 `/see`。**

`/see` 接 `maxSize` / `file` 等参数，而预览只要一张快照；单开一条让调用方不必猜参数。
它进免鉴权面的理由也很硬：预览是纯读（截图），不放它就得把 key 交给调用方，而 key 拿不到。
