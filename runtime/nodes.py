# nodes.py — 几何节点 / 材质节点的声明式包装
#
# 为什么要这一层：
#   bpy 的节点 API 能建任何节点树，但它要求调用方知道：
#     · 每个节点的 bl_idname（GeometryNodeMeshGrid 之类）
#     · 每个插口的**索引**（inputs[0] 是哪根线，各版本会变）
#     · 新建的节点组**默认没有 Group Input/Output**，得自己补
#     · 接口要 new_socket，且 socket_type 得写全名
#   这些都不是“想做一朵云的人”该记的东西。
#
# 所以这里提供**配方（recipe）**：说清要什么效果，包装负责变成节点树。
#   nodes op=geo recipe=grid_clumps size=8 density=40
#   nodes op=mat recipe=weathered color=#8a7f6a roughness=0.8
#
# 三条硬规矩：
#   ① 一律用 bl_idname，绝不用显示名。
#      中文 Blender 里 Grid 显示成“栅格”，写死显示名换语言就废。
#   ② 插口按名字找，不按索引。索引跨版本会变。
#   ③ 新建节点组自己补 Group Input/Output，否则接不进修改器。

import bpy
import json
import math
import sys

NODES_VERSION = 3

_K = sys.modules.get("dsh_rt_kernel")


def _j(o):
    return json.dumps(o, ensure_ascii=False)


def _ng_get(name):
    ng = bpy.data.node_groups.get(name)
    return ng


def _ensure_io(ng):
    """新建的 GeometryNodeTree 没有 Group Input/Output —— 补上。

    为何不靠“建组时自动生成”：实测过，新建的组里 nodes 是空的，
    只有 interface 里加了 socket 才会出现对应节点。
    所以这里显式建两个节点 + 两个 socket。
    """
    has_geo_in = any(
        s.in_out == "INPUT" and s.socket_type == "NodeSocketGeometry"
        for s in ng.interface.items_tree if hasattr(s, "in_out")
    )
    if not has_geo_in:
        ng.interface.new_socket(name="Geometry", in_out="INPUT", socket_type="NodeSocketGeometry")
    has_geo_out = any(
        s.in_out == "OUTPUT" and s.socket_type == "NodeSocketGeometry"
        for s in ng.interface.items_tree if hasattr(s, "in_out")
    )
    if not has_geo_out:
        ng.interface.new_socket(name="Geometry", in_out="OUTPUT", socket_type="NodeSocketGeometry")

    gi = next((n for n in ng.nodes if n.bl_idname == "NodeGroupInput"), None)
    if gi is None:
        gi = ng.nodes.new("NodeGroupInput")
    go = next((n for n in ng.nodes if n.bl_idname == "NodeGroupOutput"), None)
    if go is None:
        go = ng.nodes.new("NodeGroupOutput")
    return gi, go


def _out(gi, name):
    """按名字取 Group Input 的输出插口。"""
    for s in gi.outputs:
        if s.name == name:
            return s
    raise KeyError("Group Input 没有插口：%s（有：%s）" % (name, [s.name for s in gi.outputs]))


def _pick(sockets, *names):
    """按候选名依次找插口。

    ！为何要这个：同一件事在不同节点/不同版本里名字不一样。
      实测：噪波纹理的“强度”输出在 5.2 里叫 **Factor**，
      而我按记忆写了 Fac —— 直接 KeyError，整个配方挂掉。
      而几何节点那边的 Set Position 用的又是别的叫法。
      写死一个名字就是赌版本不变，赌输了就挂。
    """
    for n in names:
        for s in sockets:
            if s.name == n:
                return s
    raise KeyError("找不到插口（试过 %s，实际有：%s）"
                   % (list(names), [s.name for s in sockets]))


def _in(node, name, *aliases):
    return _pick(node.inputs, name, *aliases)


def _out_of(node, name, *aliases):
    return _pick(node.outputs, name, *aliases)


def _set(node, name, value):
    """给插口设默认值；设不上就静默跳过（某些插口只接受连线）。"""
    try:
        _in(node, name).default_value = value
        return True
    except Exception:
        return False


def _rgb(hexstr, fallback=(0.5, 0.5, 0.5)):
    """#rrggbb → 线性 RGB。

    ！必须转线性：Blender 的 Base Color 是线性空间，
      直接把 sRGB 的 0-1 值塞进去，颜色会明显偏亮偏灰。
    """
    try:
        s = str(hexstr or "").strip().lstrip("#")
        if len(s) == 3:
            s = "".join(c * 2 for c in s)
        if len(s) != 6:
            return fallback
        srgb = [int(s[i:i + 2], 16) / 255.0 for i in (0, 2, 4)]
    except Exception:
        return fallback

    def to_lin(c):
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4

    return tuple(to_lin(c) for c in srgb)


# ─────────────────────────────────────────────────────────────
# 配方：几何节点
# ─────────────────────────────────────────────────────────────

def _geo_blades(size=4.0, density=80.0, height=0.35, width=0.035,
                tilt=0.55, seed=0.0, mat=None):
    """草/毛：面上撒点 → 每点一片**细长并倾斜**的叶。

    ！”球“不是草。我自己先犯过这个：
      写 grid_clumps 时用小球当单株，结果画面像碎石地不是草地。
      草的关键不在“多”，在**形状**：细长、有方向、随机倾斜。
      球没有方向，所以再怎么撒都不像。

    做法：
      栅格 → 撒点 → 每点实例化一个拉长的立方体 → 随机旋转
      拉长是 scale=(width, width, height)，旋转靠“随机值”节点。
    """
    ng = bpy.data.node_groups.new("DSH_Geo_Blades", "GeometryNodeTree")
    gi, go = _ensure_io(ng)

    grid = ng.nodes.new("GeometryNodeMeshGrid")
    _set(grid, "Size X", float(size))
    _set(grid, "Size Y", float(size))
    _set(grid, "Vertices X", max(2, int(size * 3)))
    _set(grid, "Vertices Y", max(2, int(size * 3)))

    dist = ng.nodes.new("GeometryNodeDistributePointsOnFaces")
    _set(dist, "Density", float(density))
    _set(dist, "Seed", float(seed))

    # 一片叶：细长的立方体
    blade = ng.nodes.new("GeometryNodeMeshCube")
    try:
        _in(blade, "Size").default_value = (float(width), float(width) * 0.4, float(height))
    except Exception:
        pass
    # 把叶子的底边拉到原点（默认立方体是居中的，不拉就上下各伸一半）
    shift = ng.nodes.new("GeometryNodeTransform")
    try:
        _in(shift, "Translation").default_value = (0.0, 0.0, float(height) / 2.0)
    except Exception:
        pass
    ng.links.new(blade.outputs["Mesh"], _in(shift, "Geometry"))

    # 随机值 → 旋转
    #
    # ！不能直接给 (x,y) 随机倾斜 ——
    #   那样叶子是**相对世界坐标**歪的，结果全场朝东南一个方向倒，
    #   像插了一地卡片。真草的叶子是**绕着自身轴**往各个方向倒。
    #
    #   正解：两个随机量串联
    #     ① Z 轴随机 0～2π（朝向：朝哪边长）
    #     ② 倾斜大小随机 0～tilt（歪多少）
    #   再把②变成“绕水平轴的倾斜”，这就是“各向倒伏”的样子。
    yaw = ng.nodes.new("FunctionNodeRandomValue")
    try:
        yaw.data_type = "FLOAT"
        _in(yaw, "Min").default_value = 0.0
        _in(yaw, "Max").default_value = 6.283185307
    except Exception:
        pass

    lean = ng.nodes.new("FunctionNodeRandomValue")
    try:
        lean.data_type = "FLOAT"
        _in(lean, "Min").default_value = 0.0
        _in(lean, "Max").default_value = float(tilt)
    except Exception:
        pass

    # 把 (lean, 0, yaw) 合成欧拉角：先绕自身 Z 转过头，再沿 X 倾斜。
    # 实测这是最省节点又看得对的一种 —— 纯靠 XYZ 随机不行。
    comb = ng.nodes.new("ShaderNodeCombineXYZ")
    ng.links.new(_out_of(lean, "Value"), comb.inputs[0])
    try:
        comb.inputs[1].default_value = 0.0
    except Exception:
        pass
    ng.links.new(_out_of(yaw, "Value"), comb.inputs[2])

    inst = ng.nodes.new("GeometryNodeInstanceOnPoints")
    try:
        ng.links.new(_out_of(comb, "Vector"), _in(inst, "Rotation"))
    except Exception:
        pass

    realize = ng.nodes.new("GeometryNodeRealizeInstances")

    ng.links.new(grid.outputs["Mesh"], _in(dist, "Mesh"))
    ng.links.new(_out_of(dist, "Points"), _in(inst, "Points"))
    ng.links.new(_out_of(shift, "Geometry"), _in(inst, "Instance"))
    ng.links.new(_out_of(inst, "Instances"), _in(realize, "Geometry"))

    tail = _out_of(realize, "Geometry")
    if mat:
        m = bpy.data.materials.get(mat)
        if m is not None:
            setmat = ng.nodes.new("GeometryNodeSetMaterial")
            setmat.inputs["Material"].default_value = m
            ng.links.new(tail, _in(setmat, "Geometry"))
            tail = _out_of(setmat, "Geometry")

    ng.links.new(tail, go.inputs["Geometry"])
    return ng, {"recipe": "blades", "size": size, "density": density,
                "height": height, "tilt": tilt, "nodes": len(ng.nodes)}


def _geo_grid_clumps(size=8.0, density=40.0, clump_scale=0.18, seed=0.0, mat=None):
    """栅格 + 面上撒点 + 每点长一个小刺球（实例化）。

    这是最通用的一条：草、毛、苔、碎石、珊瑚，改参数就是不同东西。
    """
    ng = bpy.data.node_groups.new("DSH_Geo_Clumps", "GeometryNodeTree")
    gi, go = _ensure_io(ng)

    grid = ng.nodes.new("GeometryNodeMeshGrid")
    _set(grid, "Size X", float(size))
    _set(grid, "Size Y", float(size))
    # 顶点数决定网格密度；给个下限，太稀撒点会漏
    _set(grid, "Vertices X", max(2, int(size * 4)))
    _set(grid, "Vertices Y", max(2, int(size * 4)))

    dist = ng.nodes.new("GeometryNodeDistributePointsOnFaces")
    _set(dist, "Density", float(density))
    _set(dist, "Seed", float(seed))

    # 每个点上长一个小球
    ico = ng.nodes.new("GeometryNodeMeshIcoSphere")
    _set(ico, "Radius", float(clump_scale))
    _set(ico, "Subdivisions", 1)

    inst = ng.nodes.new("GeometryNodeInstanceOnPoints")

    realize = ng.nodes.new("GeometryNodeRealizeInstances")

    ng.links.new(grid.outputs["Mesh"], _in(dist, "Mesh"))
    ng.links.new(_out_of(dist, "Points"), _in(inst, "Points"))
    ng.links.new(ico.outputs["Mesh"], _in(inst, "Instance"))
    ng.links.new(_out_of(inst, "Instances"), _in(realize, "Geometry"))

    tail = _out_of(realize, "Geometry")

    if mat:
        setmat = ng.nodes.new("GeometryNodeSetMaterial")
        m = bpy.data.materials.get(mat)
        if m is not None:
            setmat.inputs["Material"].default_value = m
            ng.links.new(tail, _in(setmat, "Geometry"))
            tail = _out_of(setmat, "Geometry")

    ng.links.new(tail, go.inputs["Geometry"])
    return ng, {"recipe": "grid_clumps", "size": size, "density": density,
                "clump_scale": clump_scale, "nodes": len(ng.nodes)}


def _geo_array(source_obj=None, count=5, offset=(2.0, 0.0, 0.0)):
    """把一个物体按方向阵列出 count 份。用物体自身的几何当输入。"""
    if not source_obj:
        raise ValueError("recipe=array 需要 name=<物体名>（阵列的源）")
    ob = bpy.data.objects.get(source_obj)
    if ob is None:
        raise ValueError("没有这个物体：%s" % source_obj)

    ng = bpy.data.node_groups.new("DSH_Geo_Array", "GeometryNodeTree")
    gi, go = _ensure_io(ng)

    oi = ng.nodes.new("GeometryNodeObjectInfo")
    oi.inputs["Object"].default_value = ob

    # 用一系列 Transform 复制太傻；这里用「实例化于点上」的简化版：
    # 造一条直线上的点，每点放一份源几何。
    line = ng.nodes.new("GeometryNodeMeshLine")
    _set(line, "Count", int(max(1, count)))
    try:
        off = _in(line, "Offset")
        off.default_value = (float(offset[0]), float(offset[1]), float(offset[2]))
    except Exception:
        pass

    inst = ng.nodes.new("GeometryNodeInstanceOnPoints")
    realize = ng.nodes.new("GeometryNodeRealizeInstances")

    ng.links.new(_out_of(line, "Mesh"), _in(inst, "Points"))
    ng.links.new(_out_of(oi, "Geometry"), _in(inst, "Instance"))
    ng.links.new(_out_of(inst, "Instances"), _in(realize, "Geometry"))
    ng.links.new(_out_of(realize, "Geometry"), go.inputs["Geometry"])

    return ng, {"recipe": "array", "source": source_obj, "count": count,
                "offset": list(offset), "nodes": len(ng.nodes)}


def _geo_noise_displace(strength=0.15, scale=3.0, name=None):
    """用噪波纹理扰动位置 —— 给平整表面加“不规整”。

    为什么不用内置的 Displace 修改器：那是另一个系统，
    而这里要的是**几何节点内部**的一步，能继续往下接。
    """
    target = bpy.data.objects.get(name) if name else None
    if target is None:
        raise ValueError("recipe=noise_displace 需要 name=<物体名>")

    ng = bpy.data.node_groups.new("DSH_Geo_Noise" + (name or ""), "GeometryNodeTree")
    gi, go = _ensure_io(ng)

    setpos = ng.nodes.new("GeometryNodeSetPosition")
    noise = ng.nodes.new("ShaderNodeTexNoise")
    _set(noise, "Scale", float(scale))
    _set(noise, "Detail", 2.0)

    # 噪波输出 Color → 转成向量偏移（-0.5 居中，避免整体平移）
    vsub = ng.nodes.new("ShaderNodeVectorMath")
    vsub.operation = "SUBTRACT"
    try:
        _in(vsub, "Vector").default_value = (0.5, 0.5, 0.5)
        vsub.inputs[0].default_value = (0.5, 0.5, 0.5)
    except Exception:
        pass

    vmul = ng.nodes.new("ShaderNodeVectorMath")
    vmul.operation = "MULTIPLY"
    try:
        vmul.inputs[1].default_value = (float(strength), float(strength), float(strength))
    except Exception:
        pass

    ng.links.new(gi.outputs["Geometry"], _in(setpos, "Geometry"))
    ng.links.new(_out_of(noise, "Color"), vsub.inputs[0])
    ng.links.new(_out_of(vsub, "Vector"), vmul.inputs[0])
    ng.links.new(_out_of(vmul, "Vector"), _in(setpos, "Offset"))
    ng.links.new(_out_of(setpos, "Geometry"), go.inputs["Geometry"])

    return ng, {"recipe": "noise_displace", "strength": strength, "scale": scale,
                "target": name, "nodes": len(ng.nodes)}


GEO_RECIPES = {
    "blades": _geo_blades,
    "grid_clumps": _geo_grid_clumps,
    "array": _geo_array,
    "noise_displace": _geo_noise_displace,
}


# ─────────────────────────────────────────────────────────────
# 配方：材质
# ─────────────────────────────────────────────────────────────

def _mat_base(name, color="#8a8a8a", roughness=0.6, metallic=0.0):
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    m.use_nodes = True
    rgb = _rgb(color)

    # ！两套颜色都得设。
    #
    #   节点树里的 Base Color 只影响**真实渲染**（EEVEE/Cycles）。
    #   而**视口和 Workbench** 取的是 m.diffuse_color —— 那是材质的
    #   “视口显示色”，与节点毫无关系。
    #
    #   实测：只设节点色时，Workbench 渲出来整片灰白（就像没材质）；
    #   因为 diffuse_color 默认是 0.8 灰。这是“看着没生效”的典型陷阱。
    m.diffuse_color = (*rgb, 1.0)
    m.roughness = float(roughness)
    m.metallic = float(metallic)

    nt = m.node_tree
    bsdf = next((n for n in nt.nodes if n.bl_idname == "ShaderNodeBsdfPrincipled"), None)
    if bsdf is None:
        bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
        out = next((n for n in nt.nodes if n.bl_idname == "ShaderNodeOutputMaterial"), None) or nt.nodes.new("ShaderNodeOutputMaterial")
        nt.links.new(_out_of(bsdf, "BSDF"), _in(out, "Surface"))
    _set(bsdf, "Base Color", (*rgb, 1.0))
    _set(bsdf, "Roughness", float(roughness))
    _set(bsdf, "Metallic", float(metallic))
    return m, bsdf, nt


def _mat_weathered(name="DSH_Mat_Weathered", color="#8a7f6a", roughness=0.85,
                   scale=6.0, contrast=0.25, bump=0.15):
    """做旧：噪波扰动粗糙度 + 微凹凸。

    这是“塑料感”消失的最短路径 —— 一个噪波同时喂 roughness 和 normal。
    """
    m, bsdf, nt = _mat_base(name, color, roughness, 0.0)

    noise = nt.nodes.new("ShaderNodeTexNoise")
    _set(noise, "Scale", float(scale))
    _set(noise, "Detail", 6.0)
    _set(noise, "Roughness", 0.6)

    # 噪波 → 色阶（拉开对比，避免一片糊）
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    try:
        ramp.color_ramp.elements[0].position = 0.35
        ramp.color_ramp.elements[1].position = 0.65
    except Exception:
        pass
    nt.links.new(_out_of(noise, "Factor", "Fac"), _in(ramp, "Fac", "Factor"))

    # 喂粗糙度：把 0-1 映射到 roughness±contrast
    math1 = nt.nodes.new("ShaderNodeMath")
    math1.operation = "MULTIPLY_ADD"
    math1.inputs[1].default_value = float(contrast) * 2.0
    math1.inputs[2].default_value = float(roughness) - float(contrast)
    nt.links.new(_out_of(ramp, "Color"), math1.inputs[0])
    nt.links.new(_out_of(math1, "Value"), _in(bsdf, "Roughness"))

    # 微凹凸
    if bump and bump > 0:
        bmp = nt.nodes.new("ShaderNodeBump")
        _set(bmp, "Strength", float(bump))
        nt.links.new(_out_of(noise, "Factor", "Fac"), _in(bmp, "Height"))
        nt.links.new(_out_of(bmp, "Normal"), _in(bsdf, "Normal"))

    return m, {"recipe": "weathered", "material": m.name, "color": color,
               "roughness": roughness, "nodes": len(nt.nodes)}


def _mat_emissive(name="DSH_Mat_Emissive", color="#4a7bd0", strength=3.0):
    m, bsdf, nt = _mat_base(name, color, 0.4, 0.0)
    rgb = _rgb(color)
    _set(bsdf, "Emission Color", (*rgb, 1.0))
    _set(bsdf, "Emission Strength", float(strength))
    return m, {"recipe": "emissive", "material": m.name, "color": color,
               "strength": strength, "nodes": len(nt.nodes)}


def _mat_image(name="DSH_Mat_Image", image=None, color="#8a8a8a",
               roughness=0.7, uv_scale=1.0, projection="box"):
    """图片贴图材质。

    image 可以是：
      · 已存在的图片名（bpy.data.images[name]）
      · 磁盘上的绝对路径（会 load 进来）
      · 空 → 生成一张棋盘（用于“先看 UV 对不对”）

    projection：贴着图的盒子映射，目前只做 box（盒式）；
      UV 的展法在 _ensure_uv 里，这里只负责材质。
    """
    m, bsdf, nt = _mat_base(name, color, roughness, 0.0)

    img = None
    if image:
        s = str(image)
        img = bpy.data.images.get(s)
        if img is None and ("/" in s or "\\" in s):
            try:
                img = bpy.data.images.load(s, check_existing=True)
            except Exception as e:
                img = None
        if img is None:
            return None, {"error": "找不到图：%s（既不是已加载的图名，也不是可读路径）" % s}
    else:
        # 没给图就造棋盘：它能把“UV 拉伸/翻转”直接暴露出来，
        # 而纯色贴图看不出这些。
        img = bpy.data.images.new(name + "_checker", width=256, height=256, alpha=False)
        pix = [0.0] * (256 * 256 * 4)
        for y in range(256):
            for x in range(256):
                c = 0.85 if ((x // 32 + y // 32) % 2 == 0) else 0.18
                i = (y * 256 + x) * 4
                pix[i] = c; pix[i + 1] = c; pix[i + 2] = c; pix[i + 3] = 1.0
        img.pixels[:] = pix

    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = img
    try:
        tex.interpolation = "Linear"
        if uv_scale and float(uv_scale) != 1.0:
            # 用映射节点缩放 UV，比改 UV 本身安全（不动用户的 UV 数据）
            mp = nt.nodes.new("ShaderNodeMapping")
            mp.inputs["Scale"].default_value = (float(uv_scale), float(uv_scale), 1.0)
            uvn = nt.nodes.new("ShaderNodeUVMap")
            nt.links.new(uvn.outputs["UV"], mp.inputs["Vector"])
            nt.links.new(mp.outputs["Vector"], tex.inputs["Vector"])
    except Exception:
        pass

    nt.links.new(tex.outputs["Color"], _in(bsdf, "Base Color"))

    return m, {"recipe": "image", "material": m.name, "image": img.name,
               "image_size": [img.size[0], img.size[1]],
               "nodes": len(nt.nodes), "projection": projection}


MAT_RECIPES = {
    "weathered": _mat_weathered,
    "emissive": _mat_emissive,
    "image": _mat_image,
}


def _ensure_uv(name, mode="box"):
    """保证物体有 UV，且真的能用。返回诊断信息。

    ！！最大的坑：几何节点产出的物体，**自身网格是空的**。
      几何由修改器实时算出来，所以 me.uv_layers 展在 0 个面上一一
      看起来“展了”，实际上贴图会全挤成一个颜色。
      必须先到 evaluate 后的网格上展，或者把修改器 apply 成真网格。

    这里选“apply”：因为 UV 是**要存下来的数据**，
      留在修改器里展不了。代价是改了物体的性质（不再是纯程序化）。
      所以回执里会明说。
    """
    ob = bpy.data.objects.get(str(name or ""))
    if ob is None or ob.type != "MESH":
        return {"ok": False, "error": "没有这个网格物体：%s" % name}

    applied = False
    # 有几何节点修改器时，先把它实化
    gn = [m for m in ob.modifiers if m.type == "NODES"]
    if gn:
        try:
            bpy.context.view_layer.objects.active = ob
            for m in gn:
                bpy.ops.object.modifier_apply(modifier=m.name)
            applied = True
        except Exception as e:
            # apply 失败（例如无头 context 不对）就退到 evaluate 后的网格
            try:
                dg = bpy.context.evaluated_depsgraph_get()
                ev = ob.evaluated_get(dg)
                newme = bpy.data.meshes.new_from_object(ev)
                ob.modifiers.clear()
                old = ob.data
                ob.data = newme
                if old.users == 0:
                    bpy.data.meshes.remove(old)
                applied = True
            except Exception as e2:
                return {"ok": False, "error": "实化几何失败：%s / %s" % (str(e)[:80], str(e2)[:80])}

    me = ob.data
    if len(me.polygons) == 0:
        return {"ok": False, "error": "物体没有面，无法展 UV（网格是空的）",
                "applied": applied}

    had = [l.name for l in me.uv_layers]
    if not me.uv_layers:
        me.uv_layers.new(name="UVMap")

    n_degenerate = 0
    # ！smart_err 必须先初始化。
    #   曾经只在 mode=='smart' 分支里赋值，外面却无条件读它，
    #   结果走 box 分支时直接 UnboundLocalError。
    #   这就是“分支内赋值、分支外读取”的经典陷阱。
    smart_err = None
    if mode == "smart":
        # smart_project 需要 EDIT 模式 + 选中。无头下实测能跑。
        try:
            bpy.context.view_layer.objects.active = ob
            ob.select_set(True)
            bpy.ops.object.mode_set(mode="EDIT")
            bpy.ops.mesh.select_all(action="SELECT")
            bpy.ops.uv.smart_project(angle_limit=1.15, island_margin=0.02)
            bpy.ops.object.mode_set(mode="OBJECT")
        except Exception as e:
            mode = "box"  # 退回去，不让它失败
            smart_err = str(e)[:120]
            try:
                bpy.ops.object.mode_set(mode="OBJECT")
            except Exception:
                pass
    if mode != "smart":
        lay = me.uv_layers[0]
        # 盒式投影：按面法线的主方向选两个轴
        for poly in me.polygons:
            n = poly.normal
            ax = max(range(3), key=lambda i: abs(n[i]))
            for li in poly.loop_indices:
                v = me.vertices[me.loops[li].vertex_index].co
                if ax == 0:
                    u, w = v.y, v.z
                elif ax == 1:
                    u, w = v.x, v.z
                else:
                    u, w = v.x, v.y
                lay.data[li].uv = ((u + 1.0) / 2.0, (w + 1.0) / 2.0)

    # 数一下有没有面积归零的面 —— 那意味着贴图在那张面上会挤成一线
    lay = me.uv_layers[0]
    for poly in me.polygons:
        uvs = [lay.data[li].uv for li in poly.loop_indices]
        if len(uvs) >= 3:
            area = 0.0
            for i in range(len(uvs)):
                x1, y1 = uvs[i]
                x2, y2 = uvs[(i + 1) % len(uvs)]
                area += x1 * y2 - x2 * y1
            if abs(area) / 2.0 < 1e-8:
                n_degenerate += 1

    return {"ok": True, "object": ob.name, "uv_layer": lay.name,
            "faces": len(me.polygons), "mode": mode,
            "applied_geometry": applied, "had_uv_before": had,
            "degenerate_faces": n_degenerate,
            **({"smart_error": smart_err} if smart_err else {})}


# ─────────────────────────────────────────────────────────────
# 挂载 / 查询 / 清理
# ─────────────────────────────────────────────────────────────

def _attach(name, group_name, clear=False):
    ob = bpy.data.objects.get(name)
    if ob is None:
        return {"ok": False, "error": "没有这个物体：%s" % name}
    ng = _ng_get(group_name)
    if ng is None:
        return {"ok": False, "error": "没有这个节点组：%s" % group_name}
    if clear:
        for md in [m for m in ob.modifiers if m.type == "NODES"]:
            ob.modifiers.remove(md)
    md = ob.modifiers.new("DSH_Nodes", "NODES")
    md.node_group = ng
    bpy.context.view_layer.update()

    # 数一下真出了多少几何 —— 这是“接上了没有”的唯一硬证据
    verts = polys = 0
    try:
        dg = bpy.context.evaluated_depsgraph_get()
        ev = ob.evaluated_get(dg)
        me = ev.to_mesh()
        verts, polys = len(me.vertices), len(me.polygons)
        ev.to_mesh_clear()
    except Exception:
        pass
    return {"ok": True, "object": name, "group": ng.name, "modifier": md.name,
            "verts": verts, "polys": polys}


def _list_groups():
    geo, mat = [], []
    for ng in bpy.data.node_groups:
        kind = "geo" if ng.bl_idname == "GeometryNodeTree" else "shader"
        item = {"name": ng.name, "nodes": len(ng.nodes), "kind": kind,
                "users": ng.users}
        (geo if kind == "geo" else mat).append(item)
    return {"geo": geo, "shader": mat}


def _recipes():
    return {"geo": sorted(GEO_RECIPES), "mat": sorted(MAT_RECIPES)}


def _cleanup(prefix="DSH_"):
    """删掉本次建的东西。只认 DSH_ 前缀 —— 不碰用户自己的节点组。"""
    removed = []
    for ng in [g for g in bpy.data.node_groups if g.name.startswith(prefix)]:
        removed.append(ng.name)
        bpy.data.node_groups.remove(ng)
    return {"removed": removed, "count": len(removed)}


def dispatch(op, args=None):
    """统一入口。args 是 dict 或 JSON 字符串。"""
    if isinstance(args, str):
        try:
            args = json.loads(args) if args.strip() else {}
        except Exception:
            args = {}
    a = args or {}

    def num(k, d):
        try:
            return float(a.get(k, d))
        except Exception:
            return float(d)

    try:
        if op == "recipes":
            return _j({"ok": True, **_recipes()})

        if op == "list":
            return _j({"ok": True, **_list_groups()})

        if op == "cleanup":
            return _j({"ok": True, **_cleanup(str(a.get("prefix") or "DSH_"))})

        if op == "geo":
            rec = str(a.get("recipe") or "grid_clumps")
            fn = GEO_RECIPES.get(rec)
            if fn is None:
                return _j({"ok": False, "error": "没有这个几何配方：%s" % rec,
                           "available": sorted(GEO_RECIPES)})
            kw = {}
            if rec == "blades":
                kw = dict(size=num("size", 4.0), density=num("density", 80.0),
                          height=num("height", 0.35), width=num("width", 0.035),
                          tilt=num("tilt", 0.55), seed=num("seed", 0.0),
                          mat=a.get("mat"))
            elif rec == "grid_clumps":
                kw = dict(size=num("size", 8.0), density=num("density", 40.0),
                          clump_scale=num("clump_scale", 0.18),
                          seed=num("seed", 0.0), mat=a.get("mat"))
            elif rec == "array":
                off = a.get("offset") or [2.0, 0.0, 0.0]
                kw = dict(source_obj=a.get("name"), count=int(num("count", 5)),
                          offset=[float(x) for x in off])
            elif rec == "noise_displace":
                kw = dict(strength=num("strength", 0.15), scale=num("scale", 3.0),
                          name=a.get("name"))
            ng, info = fn(**kw)
            out = {"ok": True, "group": ng.name, **info}
            # 给了 name= 就顺手挂上去
            if a.get("name") and rec != "array":
                out["attach"] = _attach(str(a["name"]), ng.name, clear=bool(a.get("clear")))
            return _j(out)

        if op == "mat":
            rec = str(a.get("recipe") or "weathered")
            fn = MAT_RECIPES.get(rec)
            if fn is None:
                return _j({"ok": False, "error": "没有这个材质配方：%s" % rec,
                           "available": sorted(MAT_RECIPES)})
            kw = dict(name=str(a.get("name") or ("DSH_Mat_" + rec)),
                      color=str(a.get("color") or "#8a8a8a"))
            if rec == "weathered":
                kw.update(roughness=num("roughness", 0.85), scale=num("scale", 6.0),
                          contrast=num("contrast", 0.25), bump=num("bump", 0.15))
            elif rec == "emissive":
                kw.update(strength=num("strength", 3.0))
            elif rec == "image":
                kw.update(image=a.get("image"), roughness=num("roughness", 0.7),
                          uv_scale=num("uv_scale", 1.0),
                          projection=str(a.get("projection") or "box"))
            m, info = fn(**kw)
            if m is None:
                return _j({"ok": False, "error": (info or {}).get("error", "建材质失败"),
                           "available": sorted(MAT_RECIPES)})
            out = {"ok": True, **info}
            # 给了 object= 就顺手：先保证有 UV（贴图必需），再赋材质
            obn = a.get("object")
            if obn:
                ob = bpy.data.objects.get(str(obn))
                if ob is not None:
                    if rec == "image":
                        uvres = _ensure_uv(str(obn), str(a.get("projection") or "box"))
                        out["uv"] = uvres
                        if not uvres.get("ok"):
                            return _j({"ok": False,
                                       "error": "展 UV 失败，贴图无法正确映射：%s" % uvres.get("error"),
                                       "uv": uvres})
                    if ob.data and hasattr(ob.data, "materials"):
                        ob.data.materials.clear()
                        ob.data.materials.append(m)
                        out["assigned_to"] = ob.name
                else:
                    out["assign_error"] = "没有这个物体：%s" % obn
            return _j(out)

        if op == "uv":
            return _j(_ensure_uv(str(a.get("name") or ""),
                                 str(a.get("projection") or "box")))

        if op == "attach":
            return _j({"ok": True, **_attach(str(a.get("name") or ""),
                                             str(a.get("group") or ""),
                                             clear=bool(a.get("clear")))})

        return _j({"ok": False, "error": "unknown nodes op: %s" % op,
                   "ops": ["recipes", "list", "geo", "mat", "attach", "cleanup"]})
    except Exception as e:
        return _j({"ok": False, "error": "%s: %s" % (type(e).__name__, str(e)[:300])})


if _K is not None:
    _K.dsh_nodes_api = {"version": NODES_VERSION, "dispatch": dispatch,
                        "recipes": _recipes, "list": _list_groups}
