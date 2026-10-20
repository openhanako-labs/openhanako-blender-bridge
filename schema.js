// schema.js — 工具接口的单一事实来源
//
// 为什么要在 index.js 之外：
//   这份契约原本散在四张表里（actions / PARAM_SPEC / ACTION_PARAMS / OP_VALUES），
//   外加 BRANCH_HINT 和两个派生函数。四张表各自手写、互相平行，
//   于是「新增一个参数」变成「改三处」，忘改一处就静默失效——
//   size 那次（参数被丢掉、配方用默认尺寸，回执还写着"尺寸：8"）就是这么来的。
//
// 为什么单独成文件而不是抽成函数：
//   抽函数只解决重复，不解决"唯一来源"。只有搬出这个闭包，
//   它才能被测试直接 import、被启动自检读取——
//   而"能被检查"才是这类契约真正需要的性质。
//
// 这个模块不依赖 sdk / state / 任何闭包变量，纯数据 + 纯函数。

  export const actions = [
    {
      id: "doctor",
      summary: "通道体检（TCP → addon → bpy 往返三级诊断）。装完或连不上时先跑这个。",
    },
    {
      id: "see",
      summary: "看当前视口，返回一张图（base64 data URL）。不需要先建相机会自动取景；可指定 maxSize（最长边，默认 900，上限 1600）与 file 落盘名。",
    },
    {
      id: "do",
      summary: "在 Blender 主线程执行一段 Python（bpy 可用）。改了场景想立刻确认，用 see 再看一眼。check=collide 会在执行完后自动跑一次零件碰撞检查（建完一批零件时传它，省一次手动 audit）。不确定就先 txn op=mark 打回退点。",
    },
    {
      id: "scene",
      summary: "读当前场景结构（物体清单、类型、位置等）。",
    },
    {
      id: "object",
      summary: "读单个物体的详细信息，参数 name。",
    },
    {
      id: "raw",
      summary: "直通 addon 原生命令：type 必填（如 ping / get_addon_info / list_scene_items 等），params 可选。用于 addon 提供了封装之外的能力。",
    },
    {
      id: "status",
      summary: "本 App 与中继的运行状态（含中继侧健康与指标）。回执里的 health.publicRead 列出中继上**不需 key 就能读**的路径——外部脚本、CI、排查终端靠它接入；其余路径都要 x-relay-key（key 只在宿主内存，不落盘）。",
    },
    {
      id: "channel",
      summary: "渲染通道：出 depth / normal / color / alpha / mist / position / mask 的 PNG，可直接喂 ComfyUI。passes 指定通道（默认 [\"depth\"]）；mask 是黑底白块的二值剪影（须配 object 指定物体），适合局部重绘/inpaint；deliver 指定投递目录（如 ComfyUI 的 input 目录）。",
    },
    {
      id: "assets",
      summary: "资产源（P4-2）：从 PolyHaven 等来源检索/下载/导入资产。op=status（六家可用状态）/search（检索，需 assetType + query/category）/download（下载并导入场景，需 assetId + assetType）。免费无需 key 的只有 PolyHaven；其余五家需先在设置里配 API key，未配置会明确报错。",
    },
    {
      id: "render",
      summary: "渲染出图（op=start/status）。start=发起渲染（异步，立即返回 jobId）；status=查进度/取图（带 jobId）。默认 EEVEE；可指定 engine/width/height/frame/format/file。",
    },
    {
      id: "view",
      summary: "从任意角度出图（不建相机、不动你的视口）。from/look_at 为 [x,y,z]；可选 lens/ortho/width/height。比 see 强在：不用改用户视角就能从指定位置看。",
    },
    {
      id: "loop",
      summary: "【内环搜索】把几千次迭代放到 Blender 侧跑（实测 ~175 次/秒，不消耗模型回合）。op=start/status/stop/board/export/help。spec.step 写搜索步骤、spec.measure 必须给 score 赋值——注意：step/measure 里直接写变量名（ns 是执行作用域），不写 ns['x']。",
    },
    {
      id: "txn",
      summary: "【事务/回滚】两级：对象级 mark/revert（只记 transform/材质槽/可见性/修改器开关，毫秒级）+ 文件级 snapshot/restore（整场景 .blend 副本）。做了可能后悔的改动前先 mark。op=mark/revert/marks/list/help。",
    },
    {
      id: "plan",
      summary: "【契约层 + 规划器】把「假设/区间/可辨识性/证据/破坏性门控」与「对象图编译」变成可调用 API。op=status/register_connection/check_envelope/qc_compare/generator_*/fit_help/mate_check/... 证据不足时它报 unresolved 而不是二选一。装配辅助：op=fit_help 查特征库（9种特征+四档公差+ISO 273），op=mate_check 网格级配合门判 supported/refuted/unresolved。",
    },
    {
      id: "headless",
      summary: "【无头 Blender】独立进程跑脚本（blender -b）：不占 GUI 通道、不动你正看着的场景。适合重渲染/批量几何/数据校验/长任务。code 为要执行的 Python；可给 file（跑 .py 文件）与 outdir。",
    },
    {
      id: "commands",
      summary: "列出 addon 当前可用的命令面（哪些常驻、哪些因集成开关/缺 key 不可用）。调 raw 之前先看它。",
    },
    {
      id: "qc",
      summary: "【QC 判据】客观比对：参考图 vs 渲染图 → IoU / 剖面差 / 对照图。op=compare（需 ref_path + render_path，可选 ref_box）/ compare_auto（掩膜自适应 + 对齐搜索，推荐）/ self_check / render_views（多视角渲染 harness）/ help。",
    },
    {
      id: "deliver",
      summary: "【交付导出】单位盒归一化 + 多组 OBJ/MTL/STL + manifest（逐文件 md5）。op=export（需 dir，可给 objects/name/fmt/normalize）/ verify（读回逐项自检：文件存在、md5 一致、面数一致——**改一字节必 FAIL**）/ help。",
    },
    {
      id: "audit",
      summary: "【网格体检】查孤立顶点 / 退化面 / 非流形边 / 自相交 / 越界。op=mesh（单体或一组）/ scene（全场景，先看哪几个最脏）/ duplicates（查重）/ help。",
    },
    {
      id: "nodes",
      summary: "【几何节点 / 材质】声明式配方：说清要什么效果，包装搭出节点树。op=recipes（看配方）/ geo（recipe=blades 草毛·grid_clumps 碎石苔藓·array 阵列·noise_displace 噪波扰动）/ mat（recipe=weathered 做旧·emissive 自发光·image 图片贴图）/ uv（展 UV，box/smart）/ attach（挂现成组）/ list / cleanup / selftest（跑 33 项真机自检）。★ 建几何组时给 name= 会顺手挂上去，回执发**节点树真算出来的**顶点/面数。",
    },
    {
      id: "drive",
      summary: "【关节驱动】让已登记的关节**真的动起来**（motion 只能量、能导出，不能驱动）。op=status（哪些关节可驱动）/ drive（jid + angle，默认转完就还原；pose=true 保留姿态）/ sweep（扫角度区间看包围盒变化，判断会不会穿模）。★ 默认**可逆**：转完自动还原到原样，回执会报还原是否精确。",
    },
    {
      id: "wheel",
      summary: "【轮系驱动】轮子转 + **履带跟着走**。op=status（猜哪些是轮子/履带）/ spin（一组轮子绕各自中心转）/ track_advance（履带推进一段弧长；自动分辨「一整条带体」与「几十个链板拼成一个 mesh」）/ roll（一次联动：轮子转 degrees，履带按 r×θ 走）。★ 默认可逆，转完自动还原。",
    },
    {
      id: "rig",
      summary: "【骨架与蒙皮】给模型套 armature。op=status / build（从几何自动建骨+按几何包含/间隙建骨骼树）/ bind（**rigid**=每零件恒 1.0，适合机械体；**skin**=多骨渐变，适合有机体）/ pose（转一根骨验证绑定，默认还原）/ ik（加 IK 约束与目标）。★ 刚性与蒙皮是同一套系统的两个权重档，不是两套东西。",
    },
    {
      id: "perf",
      summary: "【渲染性能】Cycles/EEVEE 瓶颈诊断与优化预设。op=status / analyze（差分实测）/ apply（应用预设）/ revert / help。",
    },
    {
      id: "generator",
      summary: "【代码化建模】模型由一段 Python 程序算出来（程序即形状）。op=save（存生成器）/run（**编译门**：在全新无头进程里从零跑一遍才算数）/list/get/diff。缓存按源码 hash，**源码一变回执过期**。",
    },
    {
      id: "motion",
      summary: "【机构/铰接】关节轴实测（旋转对称 + 接触带两条独立证据）+ **扫掠验证**（运动学+BVH，不是物理仿真）+ URDF/USDA 导出。op=joint/joints/infer_axis/measure/export_urdf/export_usda/status。⚠ measure 在没有「旁观者」对象时会报 unresolved——**它不给空洞证据发通过**。",
    },
    {
      id: "preset",
      summary: "【配方库】把参数组合做成可保存/套用/分发的资产。op=save/list/get/delete/apply/export/import/help（独立端点）。",
    },
    {
      id: "service",
      summary: "Blender 服务进程起停（op=status/start/stop）。status=查状态/监听 PID/Blender 路径；start=拉起 Blender（走计划任务，独立于 Hana 存活）；stop=撤下服务（taskkill 9876 上的进程）。",
    },
    {
      id: "runs",
      summary: "【产物归档】把一次产出收进一个带户口的 run 目录，让「采用/回退」有落点。op=begin（开一个 run，给 label）/ put（把产物收进来，file 或 files，kind=hero/view/qc/export/proof）/ finish（收口，可带 summary、notes；带 views:true 则顺手拍一组视图）/ views（拍一组视图：iso/front/right/top，可用 viewAngles 指定）/ tag（标记：baseline=采用并永久保留；delivered=已投递永久保留）/ feedback（读或写意见：不传 note 就是读，传了就是追加一条）/ get / list / prune（keep=N 保留最近 N 个未标记的，dryRun 只报告）。\n产出多张图 / 一次 QC / 一次导出时，建议先 begin 再逐张 put，最后 finish。\n做完一版建议 finish 时带 views:true——一次迭代对应一组视图，人在面板上一眼能看全。\n开新一版之前建议先 runs op=feedback 读一下上一版留下的意见——那是人给的输入，不是背景噪音。",
    },
    {
      id: "connect",
      summary: "显式拉起/重连中继（首次使用、改了 Blender 端口、或中继异常后用它）。",
    },
    {
      id: "dispatch",
      summary: "【派活】把一条要求交给某个助手，在他自己的会话里开工。参数：op=start（默认）/status，brief（要做什么，必填）、agent（发给谁，必填——不替你猜）、model（用哪个模型，空=不换）、provider（与 model 成对，换模型时必填）、runId（带上一版产出做上下文）、taskId（op=status 查结果用）。\n先用 models 看能发给谁、能选哪些模型。\n★ 提交即返回：很快的情况直接给结果；慢的给 taskId，用 op=status 查——**先查再重发**，重发会让助手收到两遍。",
    },
    {
      id: "models",
      summary: "【可选目标】派活能发给谁、能选哪些模型。op=agents（助手清单）/ models（模型清单，带 provider）。",
    },
    {
      id: "lease",
      summary: "【写锁】多会话共存时避免互相踩。op=who（看当前持有者与剩余时间）/ acquire（拿写权限，可带 ttlMs，force 抢占）/ release（主动释放）/ renew（心跳续期）。\n当另一个会话改了场景、你的写操作返回 409 leased 时，先 op=who 看是谁，再决定等还是 force 抢。只读操作（体检/读场景/QC 比对）不受租约限制。\n⚠ **租约保护的是「知道自己要写」的路。** 走 object op=add/remove、/rt/act、/rt/plan 这类显式写路由的动作受保护；**do 是逃生门，不受租约约束**——do 的价值就在能跑任意 Python，先拿写权限再跑会削掉它。多会话共存时用 do 改场景，需要你自己确认没有别人在同时改。",
    },
    {
      id: "worker",
      summary: "【热会话】常驻的无头 Blender 进程，专门治「每次渲染都要重新编译着色器」。op=start（拉起常驻进程）/ exec（在热进程里跑代码，连续多帧渲染时每帧从 ~16s 降到 ~1.35s）/ status / stop / restart。\n适合：批量出图、参数扫描、多角度 QC。不适合：单一偶发渲染（用 render 就好，冷启动成本收回不来）。",
    },
    {
      id: "job",
      summary: "【后台作业】长活后台化：op=start（立即返回 jobId，不阻塞）/ status（看进度）/ collect（取日志与产物）/ kill / list。\n适合：渲染一整晚、批量几何、大场景导出。与 worker 的区别：job 是「跑完就走」的一次性长任务，worker 是「一直开着」的热会话。",
    },
  ];

  // ── 参数定义表（每个参数只定义一次；分支按动作组装）─────────────────────
  // 为什么要这张表：原来 25 个分支各自内联同一份 31 属性副本，改一处要改 25 处，
  // 而且后写的键覆盖先写的（code/name/params 各被覆盖一次），参数描述与实际语义漂移。
  export const COMMON_PARAMS = ["timeoutMs"];

  export const PARAM_SPEC = {
    timeoutMs: { type: "integer", description: "可选超时（毫秒）。" },
    check: { type: "string", description: "do：执行完后自动跑碰撞检查。填 collide 会跑一次零件间包围盒相交 + 穿模判定（拼缝自动过滤）。纯读取脚本不必传。" },
    holder: { type: "string", description: "租约持有者标识（lease 用；省略则为 anonymous）。" },
    ttlMs: { type: "integer", description: "租约有效期毫秒（默认 10 分钟，范围 5s~24h）。" },
    force: { type: "boolean", description: "true 则抢占别人的租约（lease / 写操作均可带）。" },
    renewOnly: { type: "boolean", description: "true 则只在本来就持有租约时续期，空闲时不抢占。" },
    id: { type: "string", description: "作业 id（job 用）。" },
    tail: { type: "integer", description: "取回日志末尾行数（job collect，默认 4000）。" },
    purgePrefix: { type: "string", description: "worker exec 用：跑前先清掉这些前缀的模块（逗号分隔）。" },
    code: { type: "string", description: "要执行的 Blender Python 代码（bpy 可用）。" },
    file: { type: "string", description: "落盘 / 输入文件名。见各 action 说明。" },
    name: { type: "string", description: "物体名（object / generator / motion / preset 用）。" },
    type: { type: "string", description: "addon 原生命令名（raw 用，如 ping / get_addon_info / list_scene_items）。" },
    params: { type: "object", description: "参数对象。generator op=run/save 时：这里直接写生成器要读的 PARAMS（扁平，例 {\"petals\":[12,10],\"head_z\":1.2}）——不用关心底层嵌套。raw 时是命令参数。" },
    maxSize: { type: "integer", description: "最长边像素（默认 900，上限 1600）。" },
    allow: { type: "array", items: { type: "string" }, description: "audit op=collide：装配白名单。写 'A|B' 指名一对，或写单个名字表示与它相关的相交都不报。用于风扇装外壳、螺丝装孔这类合理相交。" },
    eps: { type: "number", description: "audit op=collide：轻碰阈值（米）。重叠小于它的不算干涉，默认 0.0005（0.5mm）。" },
    maxPairs: { type: "integer", description: "audit op=collide：最多返回多少处，默认 60。" },
    grazing: { type: "boolean", description: "audit op=collide：true 则连拼缝/装配接触一起列出。默认只报真干涉（重叠区三个方向都有厚度）。" },
    seamMm: { type: "number", description: "audit op=collide：薄壳判定阈值（毫米）。零件最薄边 ≤ 它就当作板件。两个零件都是板件时，它们的相交归为拼缝。默认 12。" },
    view: { type: "string", description: "see：从哪个方位拍。iso（默认）/ front / back / left / right / top。给了就先转到那个方位再拍，拍完把视口还原。" },
    fit: { type: "string", description: "see：boolean，是否自动取景。默认 true（按场景包围盒取，任何尺度都成立）；false = 拍当前视口（人自己调好了角度时用）。plan op=fit_help/mate_check：string，公差档——clearance（自由滑动 0.25）/ location（手压定位 0.15，默认）/ press（过盈压配 -0.05）/ snap（卡扣间隙 0.20）。" },
    op: { type: "string", description: "子动作。取值见该 action 的说明。" },
    args: { type: "object", description: "透传给契约层 / 规划器 / 生成器 / 机构的参数对象。plan op=fit_help 可传 {feature, d, m}；op=mate_check 可传 {conn_id, fit, nominal, tol_mm}。" },
    feature: { type: "string", description: "装配特征名（plan op=fit_help）：peg / socket / bolt_hole / bolt_circle / boss / snap_tab / snap_window / tab / slot。返回对应的公差值与 Blender 侧造法。" },

    nominal: { type: "number", description: "标称值（mm），plan op=mate_check 用：配合面的名义间隙。" },
    d: { type: "number", description: "直径（mm），plan op=fit_help 用：特征的关键尺寸，如 peg 的直径。" },
    m: { type: "number", description: "公制螺纹标称直径（mm），plan op=fit_help 用：查 ISO 273 间隙孔表，返回 clearance_diameter。" },
    conn_id: { type: "string", description: "连接 id（plan op=mate_check 用）：由 plan op=register_connection 返回。" },
    style: { type: "string", description: "画风名（plan op=proportion 用）：chibi（Q版）/ anime（二次元）/ realistic（写实）/ mc（体素方块）。查比例模板用。" },
    tol_mm: { type: "number", description: "允许偏差（mm），plan op=mate_check 用：实测间隙落在 [nominal-tol, nominal+tol] 内判 supported。默认 0.15。" },
    path: { type: "string", description: "service op=start：blender.exe 显式路径。loop op=export：导出路径。preset：路径。" },
    jobId: { type: "string", description: "渲染任务 id（render op=status 用）。" },
    passes: { type: "array", items: { type: "string" }, description: "要出的通道：depth / normal / color / alpha / mist / position / mask。" },
    object: { type: "string", description: "目标物体名。channel 出 mask 时必给（不传则用场景第一个可见网格）。" },
    assetType: { type: "string", description: "资产类型：hdris / textures / models / all。" },
    query: { type: "string", description: "检索词（assets op=search）。" },
    category: { type: "string", description: "分类路径（如 'Metal/Sheet'），父级包含子级。" },
    assetId: { type: "string", description: "资产 id（slug，如 GreenChair_01）。" },
    resolution: { type: "string", description: "分辨率：1k / 2k / 4k（默认 1k）。" },
    fileFormat: { type: "string", description: "格式：hdris→hdr/exr，textures→jpg/png/exr，models→blend。" },
    limit: { type: "integer", description: "返回条数（assets 默认 20 上限 50；loop 用于候选/历史条数）。" },
    from: { type: "array", items: { type: "number" }, description: "相机位置 [x,y,z]。" },
    look_at: { type: "array", items: { type: "number" }, description: "注视点 [x,y,z]。" },
    lens: { type: "number", description: "焦距（默认 50）。" },
    ortho: { type: "boolean", description: "是否正交投影。" },
    spec: { type: "object", description: "迭代规格：{setup, step, measure, iterations, budget_ms, top_k, minimize}。" },
    label: { type: "string", description: "回退点名称（txn op=mark/revert/drop）。" },
    history: { type: "integer", description: "返回的历史条数（默认 8）。" },
    iterations: { type: "integer", description: "迭代次数（loop 用，覆盖 spec.iterations）。" },
    top: { type: "integer", description: "取前 N 条（loop 用）。" },
    outdir: { type: "string", description: "产物输出目录。" },
    expect: { type: "object", description: "对拍预期：{objects, names, min_objects, max_objects, max_tris}。不给则判定为 unresolved。" },
    parent: { type: "array", items: { type: "string" }, description: "父对象名（或列表）。" },
    child: { type: "array", items: { type: "string" }, description: "子对象名（或列表）。" },
    data: { type: "object", description: "配方内容（preset op=save）。" },
    deliver: { type: "string", description: "投递目标绝对目录（如 ComfyUI 的 input 目录）。不给则用设置页里填的默认投递目录。" },
    engine: { type: "string", description: "渲染引擎（默认 BLENDER_EEVEE）。" },
    width: { type: "integer", description: "宽（像素，上限 4096）。" },
    height: { type: "integer", description: "高（像素，上限 4096）。" },
    frame: { type: "integer", description: "帧号（默认 1）。" },
    format: { type: "string", description: "输出格式（默认 PNG）。" },
    wait: { type: "boolean", description: "true 则内联等待完成（最长约 25 秒，适合快图；慢图请用轮询）。" },
    note: { type: "string", description: "备注文本。" },
    dir: { type: "string", description: "目录 / 方向参数（generator 存目录、motion 方向）。" },
    overwrite: { type: "boolean", description: "已存在时是否覆盖。" },
    // ── nodes（几何节点 / 材质）───────────────────────────────────────
    // ！这些键必须在这里登记。
    //   工具参数是**白名单式**的：没登记的键会被默默丢掉，不报错。
    //   后果是“配方收到了默认值”，看起来像参数没生效——极难查。
    recipe: { type: "string", description: "nodes 的配方名（op=recipes 看全部）。几何：blades（草叶）/grid_clumps（碎石苔藓）/array（阵列）/noise_displace（噪波扰动）；材质：weathered（做旧）/emissive（自发光）。" },
    color: { type: "string", description: "颜色，十六进制如 #5a7d3a。会自动转线性空间。" },
    density: { type: "number", description: "撒点密度（每单位面积多少个）。草 100+，碎石 40 左右。" },
    tilt: { type: "number", description: "草的随机倾斜幅度（弧度）。0.6 左右自然，0 就是一片笔直立着的麦田。" },
    clump_scale: { type: "number", description: "grid_clumps 里单块的大小（米）。" },
    roughness: { type: "number", description: "材质粗糙度 0-1。做旧的给 0.85+。" },
    contrast: { type: "number", description: "做旧材质的粗糙度波动幅度。0.25 左右能看出脏。" },
    bump: { type: "number", description: "微凹凸强度 0-1。0.15 就够。" },
    metallic: { type: "number", description: "金属度 0-1。" },
    seed: { type: "number", description: "随机种子。同一个种子出同一片草。" },
    strength: { type: "number", description: "自发光强度。" },
    count: { type: "integer", description: "array 配方的份数。" },
    group: { type: "string", description: "节点组名（nodes op=attach 用）。" },
    mat: { type: "string", description: "建几何节点时顺手用的材质名。" },
    prefix: { type: "string", description: "nodes op=cleanup 要删的前缀（默认 DSH_，不碰你自己的节点组）。" },
    // ── drive（关节驱动）────────────────────────────────────────
    // ！参数白名单每天在坑我：没登记的键会被默默丢掉，不报错。
    //   本次已由 arg-chain.test.mjs 检查 payload/schema/python 三道。
    angle: { type: "number", description: "drive 要转多少度（unit=rad 时是弧度）。" },
    unit: { type: "string", description: "角度单位：deg（默认）/ rad。" },
    pose: { type: "boolean", description: "true = 保留姿态；默认 false = 转完自动还原。可逆性是默认值。" },
    include_descendants: { type: "boolean", description: "把子部件的子孙对象也一起转（默认 true）。false 只转子部件，子部件上的小零件会留在原地。" },
    start: { type: "number", description: "sweep 的起始角（度）。" },
    end: { type: "number", description: "sweep 的结束角（度）。" },
    steps: { type: "integer", description: "sweep 的采样步数（默认 5）。" },
    // ── wheel（轮系驱动）───────────────────────────────────────
    wheels: { type: "array", items: { type: "string" }, description: "wheel op=spin/roll 要转的轮子对象名列表。" },
    tracks: { type: "array", items: { type: "string" }, description: "wheel op=roll 要跟着推进的履带对象名列表。" },
    track: { type: "string", description: "wheel op=track_advance 的单个履带对象名。" },
    degrees: { type: "number", description: "wheel 转多少度。" },
    distance: { type: "number", description: "wheel op=track_advance 推进多少（场景单位）。" },
    radius: { type: "number", description: "wheel op=roll 的轮子半径，用来算弧长。不给则从包围盒估。" },
    spin_sign: { type: "number", description: "wheel op=roll 的履带推进方向（1 / -1）。" },
    // ── rig（骨架与蒙皮）─────────────────────────────────────
    rig_name: { type: "string", description: "rig op=build 的骨架对象名（默认 DSH_Rig）。" },
    armature: { type: "string", description: "rig op=bind/pose/ik 要操作的骨架对象名。" },
    bind_mode: { type: "string", description: "rig op=bind 的绑定模式：rigid（每零件恒 1.0，机械体）/ skin（多骨渐变，有机体）。" },
    parts: { type: "array", items: { type: "string" }, description: "rig op=build/bind 要处理的网格对象名列表；不给则全部。" },
    chains: { type: "object", description: "rig op=build mode=chain 时的分段参数，如 {segments: 6}。" },
    bone: { type: "string", description: "rig op=pose/ik 的骨骼名。" },
    target: { type: "string", description: "rig op=ik 的目标物体名；不给则自动建一个空物体。" },
    chain_length: { type: "integer", description: "rig op=ik 的 IK 链长。" },
    max_influences: { type: "integer", description: "rig op=bind mode=skin 时每个顶点最多受几根骨影响。" },
    mode: { type: "string", description: "子模式：nodes 是配方类别；rig op=build 是 auto / parts / chain；rig op=bind 是 rigid / skin（与 bind_mode 等价）。" },
    out: { type: "string", description: "rig op=export 的输出路径（.json）。不给则只返回摘要不写文件。" },
    clear: { type: "boolean", description: "挂节点前先清掉该物体上已有的节点修改器。" },
    // ！size 必须登记：blades / grid_clumps 都靠它。
    //   曾经漏了它，参数会被静默丢掉、配方用默认尺寸——
    //   而回执上写着“尺寸：8”（默认值），看着像生效了。
    size: { type: "number", description: "几何配方的尺寸（米）。blades/grid_clumps 的栅格边长。默认 4～8。" },
    image: { type: "string", description: "图片：已加载的图名，或磁盘上的绝对路径。不传则自动生成一张棋盘（用来直观看 UV 对不对）。" },
    uv_scale: { type: "number", description: "贴图重复次数（1=铺一遍，4=铺四通）。不动模型自身的 UV 数据。" },
    projection: { type: "string", description: "展 UV 的方式：box（盒式，快，适合平面/方块）/ smart（智能展开，慢些，曲面用这个）。默认 box。" },
    use_cache: { type: "boolean", description: "是否命中源码 hash 缓存（默认 true）。" },
    joints: { type: "array", description: "关节定义列表（motion 用）。" },
    axis: { type: "array", items: { type: "number" }, description: "关节轴向量。" },
    anchor: { type: "array", items: { type: "number" }, description: "关节锚点。" },
    limits: { type: "object", description: "关节活动范围。" },
    kind: { type: "string", description: "场景相关语义（按动作区分）：object op=add 是基础体类型（cube/sphere/cylinder/cone/torus/plane/monkey，默认 cube）；motion 是关节类型（默认 revolute）；preset 是配方种类；runs op=put 是产物种类（view/export/qc/model/scene/proof，默认 view）。" },
    names: { type: "array", items: { type: "string" }, description: "名称列表（按动作区分）：object op=remove/restore 是物体名列表；preset 是配方名列表。" },
    jid: { type: "string", description: "关节 id（motion 用）。" },
    joint: { type: "string", description: "关节 id（drive 用）——与 jid 等价，两个名字都接受。" },
    phases: { type: "array", description: "扫掠相位列表（motion 用）。" },
    sweep_deg: { type: "number", description: "扫掠角度（度）。" },
    objects: { type: "array", items: { type: "string" }, description: "作用对象名列表。" },
    tags: { type: "array", items: { type: "string" }, description: "配方标签。" },
    dry_run: { type: "boolean", description: "只预演不落盘。" },
    // 下面几个是 runs 用的
    files: { type: "array", items: { type: "string" }, description: "多个源文件路径（runs op=put 批量收）。" },    tag: { type: "string", description: "标记值（runs op=tag，默认 baseline）。带标记的 run 不会被清理。" },
    keep: { type: "integer", description: "保留最近 N 个未标记 run（runs op=prune，默认 20）。" },
    dryRun: { type: "boolean", description: "true 则只报告要清理什么，不动磁盘。" },
    summary: { type: "string", description: "一句话结论（runs op=finish 用）。" },
    notes: { type: "string", description: "多行备注，写进 run 目录的 notes.md。" },
    actionName: { type: "string", description: "动作名（runs op=begin 用，便于列表里看出这是什么活）。" },
    runId: { type: "string", description: "续入已有的 run（不给则自动开一个新的）。用 runs op=list 拿 id。" },
    continueRun: { type: "boolean", description: "view：true 则续入**上一版** run（而不是新建）。同一个模型的多轮出图用它，否则每拍一张就多一版。默认 false（开新的一版）。" },
    hero: { type: "boolean", description: "view 用：true 则这张当主图（hero.png）。" },
    baseRun: { type: "string", description: "父 run id（记录这一版基于哪一版）。" },
    scene: { type: "boolean", description: "runs：是否顺手存一份 .blend 场景快照。默认 true，显式 false 才跳过。" },
    snapshot: { type: "boolean", description: "runs：是否拍快照。默认 true，显式 false 才跳过。" },
    script: { type: "string", description: "runs：这一版的来源脚本路径或源码（generator 产出用）。给了才能从脚本无头重建视图。" },
    noCache: { type: "boolean", description: "runs op=views：true 则无视缓存重拍（同方位的旧图会先被顶掉）。默认 false。" },
    // 下面几个是 dispatch / models 用的
    brief: { type: "string", description: "派活：要做什么（必填）。写成对那个人说得清的一句话。" },
    taskId: { type: "string", description: "dispatch op=status：start 时返回的任务号。" },
    sessionId: { type: "string", description: "dispatch：直接发到这个会话（可空；不传就先找本 App 建的活跃会话，没有才新建）。" },
    agent: { type: "string", description: "派活：发给哪个助手（必填，用 agent id）。先用 models op=agents 拿。不传会明确报错——不替你猜。" },
    model: { type: "string", description: "派活：用哪个模型（可空 = 不换，用那个助手本来的）。用 models op=models 拿 id。" },
    provider: { type: "string", description: "派活：模型的 provider（跟 model 成对，换模型时要一起给）。" },
    // 下面几个是 object 增删用的
    to: { type: "string", description: "object op=rename 的新名字；op=duplicate 的副本名（可空）。" },
    location: { type: "array", items: { type: "number" }, description: "位置 [x,y,z]（object op=add）。默认 [0,0,0]。" },
    rotation: { type: "array", items: { type: "number" }, description: "旋转弧度 [x,y,z]（object op=add）。" },
    scale: { type: "array", items: { type: "number" }, description: "缩放 [x,y,z]（object op=add）。默认 [1,1,1]。" },
    offset: { type: "array", items: { type: "number" }, description: "副本偏移 [x,y,z]（object op=duplicate）。" },
    material: { type: "string", description: "材质名（object op=add，场景里已有的才生效）。" },
    // 下面两个是 runs op=views / finish 用的
    views: { type: "boolean", description: "runs op=finish 时：true 则收口后顺手拍一组视图（默认不拍，免得意外改用户视口）。" },
    viewAngles: { type: "array", items: { type: "string" }, description: "拍哪几个方位（runs op=views / finish）。默认 [iso, front, right, top]。可选 front/back/left/right/top/iso。" },
  };

  // 每个动作真正会读的参数（依据各 case 分支里实际访问的 args 键）
  export const ACTION_PARAMS = {
    doctor: [],
    see: ["maxSize", "file", "view", "fit"],
    do: ["code", "timeoutMs", "check"],
    scene: [],
    object: ["op", "name", "kind", "to", "names", "location", "rotation", "scale", "offset", "material", "holder", "force", "runId", "label"],
    raw: ["type", "params", "timeoutMs"],
    status: [],
    channel: ["passes", "object", "width", "height", "frame", "engine", "file", "deliver", "runId", "label"],
    assets: ["op", "assetType", "query", "category", "limit", "assetId", "resolution", "fileFormat"],
    render: ["op", "jobId", "engine", "width", "height", "frame", "format", "file", "wait"],
    view: ["from", "look_at", "width", "height", "lens", "ortho", "runId", "label", "name", "hero", "continueRun"],
    loop: ["op", "spec", "limit", "history", "path", "top", "iterations"],
    txn: ["op", "args", "label"],
    plan: ["op", "args", "feature", "fit", "nominal", "tol_mm", "d", "m", "conn_id", "style"],
    headless: ["code", "file", "outdir", "args", "timeoutMs"],
    commands: [],
    qc: ["op", "args"],
    deliver: ["op", "args"],
    audit: ["op", "args", "allow", "eps", "maxPairs", "grazing", "seamMm"],
    nodes: ["op","recipe","name","group","object","mat","color","size","density","height","width","tilt","clump_scale","count","offset","strength","scale","roughness","contrast","bump","metallic","seed","prefix","clear","image","uv_scale","projection"],
    drive: ["op","jid","joint","angle","unit","pose","axis","anchor","include_descendants","start","end","steps"],
    wheel: ["op","wheels","tracks","track","degrees","distance","radius","axis","pose","spin_sign"],
    rig: ["op","rig_name","armature","mode","bind_mode","parts","chains","bone","degrees","axis","pose","target","chain_length","max_influences","out","tracks"],
    perf: ["op", "args"],
    generator: ["op", "args", "name", "code", "params", "note", "dir", "overwrite", "expect", "use_cache", "timeoutMs"],
    motion: ["op", "args", "jid", "parent", "child", "kind", "axis", "anchor", "limits", "note", "dir", "name", "joints", "phases", "sweep_deg", "objects"],
    preset: ["op", "args", "name", "data", "kind", "tags", "note", "path", "overwrite", "dry_run", "names"],
    service: ["op", "path"],
    connect: [],
    dispatch: ["op", "brief", "agent", "model", "provider", "runId", "taskId", "sessionId"],
    models: ["op"],
    runs: ["op", "id", "label", "actionName", "note", "notes", "summary", "tag", "keep", "dryRun", "limit", "baseRun", "file", "files", "kind", "name", "views", "viewAngles", "model", "scene", "snapshot", "path", "script", "noCache"],    lease: ["op", "holder", "ttlMs", "force", "renewOnly"],    worker: ["op", "code", "timeoutMs", "file", "outdir", "purgePrefix"],
    job: ["op", "id", "code", "file", "outdir", "tail", "timeoutMs"],
  };

  // 每个动作的取值清单（仅在 summary 未自带 op= 时补充，给模型看）
  export const OP_VALUES = {
    nodes: "recipes / selftest / geo / mat / uv / attach / list / cleanup",
    drive: "status / drive / sweep",
    wheel: "status / spin / track_advance / roll",
    rig: "status / build / bind / pose / ik / export",
    assets: "status / search / download",
    render: "start / status",
    loop: "start / status / stop / board / export / help",
    txn: "mark / revert / marks / list / snapshot / restore / drop / help",
    plan: "自由 op（status / register_connection / check_envelope / qc_compare / generator_* / fit_help / mate_check / proportion / ...）",
    qc: "compare / compare_auto / self_check / render_views / help",
    deliver: "export / verify / help",
    audit: "mesh / scene / duplicates / collide / help",
    perf: "status / analyze / apply / revert / help",
    generator: "save / run / list / get / diff",
    motion: "joint / joints / infer_axis / measure / export_urdf / export_usda / status",
    runs: "begin / put / finish / tag / feedback / get / list / prune / views / model / scene / snapshot / snapshots / restore / help",
    preset: "save / list / get / delete / apply / export / import / help",
    service: "status / start / stop",
    object: "get（读单个物体，默认）/ add（新建基础体：cube/sphere/cylinder/cone/torus/plane/monkey）/ hide（隐藏，视口与渲染同时关）/ show（重新显示）/ hidden_list（列出当前藏起来的）/ remove（移入回收站，可恢复）/ restore（从回收站捞回）/ rename / duplicate / trash_list / purge（真删回收站，不可恢复）",
    lease: "who / acquire / release / renew",
    models: "agents / models",
    dispatch: "start（默认，提交即返回）/ status（查结果，需 taskId）",
    worker: "start / exec / status / stop / restart",
    job: "start / status / collect / kill / list",
  };

  export const BRANCH_HINT = {
    doctor: "先跑这个确认通道。",
    see: "自动取景，不必先建相机；改完场景用它复核。",
    do: "不确定就先 txn op=mark 打回退点。",
    render: "发起后立即返回，不要原地等。",
    channel: "要出的通道见 passes；mask 需配 object；产物会自动收进 run 目录（带 runId 则续入同一个）。",
    view: "一次出多个视角时，第一个带 hero:true，其余带同一个 runId 续入。",
    assets: "免 key 只有 PolyHaven；其余五家未配 key 会明确报错。",
    lease: "写操作返回 409 leased 时用它：who 看是谁，再决定等还是 force 抢。",
    worker: "连续渲染多帧才划算（首帧冷启动约 16s）。",
    job: "提交即返回，不要原地等；用 status/collect 跟进。",
    runs: "产出多张图/次 QC/次导出时：先 begin 再逐张 put，最后 finish。做完一版建议 finish 时带 views:true（一次迭代一组视图）；单拍用 op=views。可交付的那一版记得 tag=baseline；已投递到目标目录的标 delivered。开新一版前先 op=feedback 读一下上次的意见。",
    dispatch: "先用 models 看能发给谁、能选哪些模型。agent 必选——不替你猜。",
    models: "op=agents 看助手，op=models 看模型（带 provider）。",
  };

  export function actionBranches() {
    return actions.map((a) => {
      const names = COMMON_PARAMS.concat(ACTION_PARAMS[a.id] || []);
      const properties = {
        action: {
          const: a.id,
          description: `${a.summary}${BRANCH_HINT[a.id] ? " " + BRANCH_HINT[a.id] : ""}`,
        },
      };
      for (const n of names) {
        if (n === "op" && OP_VALUES[a.id]) {
          properties.op = { ...PARAM_SPEC.op, description: `子动作：${OP_VALUES[a.id]}。` };
        } else if (PARAM_SPEC[n]) {
          properties[n] = PARAM_SPEC[n];
        }
      }
      return {
        type: "object",
        required: ["action"],
        properties,
        additionalProperties: false,
      };
    });
  }

  // action → summary 全文（工具描述由它派生，不再手写，避免与实现漂移）
  // 每条附上该动作的 op 取值与关键参数，使“名字”变成“能干什么”。
  export function actionCatalogText() {
    return actions
      .map((a) => {
        const head = `- ${a.id}：${a.summary}`;
        const extra = [];
        // summary 里没写 op= 的，才补上取值清单（写了的补一遍是重复）
        if (OP_VALUES[a.id] && !/op=/.test(a.summary)) extra.push(`op=${OP_VALUES[a.id]}`);
        if (BRANCH_HINT[a.id]) extra.push(BRANCH_HINT[a.id]);
        return extra.length ? `${head} ${extra.join(" ")}` : head;
      })
      .join("\n");
  }

// ── 启动自检 ────────────────────────────────────────────────────────────
//
// 为什么要有它：写「！size 必须登记」这种防御性注释，挡不住下一次漏登记。
// 注释靠人记得读，自检靠代码自己报。
//
// 只在返回里给出问题，不抛异常——调用方决定是打印警告还是当成致命错。
// 这样开发期能看见，生产期不会因为一条自检把整个 App 起不来。
export function selfCheck() {
  const problems = [];

  // 1) PARAM_SPEC 里的键，有没有任何 action 用到？
  //    没用到的多半是"曾经用、后来删了动作"，留着会误导模型。
  const usedByAny = new Set();
  for (const list of Object.values(ACTION_PARAMS)) for (const k of list) usedByAny.add(k);
  const orphans = Object.keys(PARAM_SPEC).filter((k) => !usedByAny.has(k) && !COMMON_PARAMS.includes(k));
  if (orphans.length) problems.push({ kind: "orphan-param", detail: orphans });

  // 2) ACTION_PARAMS 里声明的键，PARAM_SPEC 里有没有定义？
  //    没有就是"送进去了但模型不知道该传什么"。
  const undefinedKeys = [];
  for (const [act, list] of Object.entries(ACTION_PARAMS)) {
    for (const k of list) {
      if (k === "op") { if (!OP_VALUES[act]) undefinedKeys.push(`${act}.op`); continue; }
      if (!PARAM_SPEC[k] && !COMMON_PARAMS.includes(k)) undefinedKeys.push(`${act}.${k}`);
    }
  }
  if (undefinedKeys.length) problems.push({ kind: "undefined-param", detail: undefinedKeys });

  // 3) actions 里列了、ACTION_PARAMS 里没有条目的动作。
  //    这种动作的分支只剩 action + timeoutMs——除非它本来就不收参数。
  const noBranch = actions.map((a) => a.id).filter((id) => !(id in ACTION_PARAMS));
  if (noBranch.length) problems.push({ kind: "no-param-branch", detail: noBranch });

  return { ok: problems.length === 0, problems };
}
