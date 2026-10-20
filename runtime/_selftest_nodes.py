# nodes.py 的真机回归测试（在无头 Blender 里跑）
#
# 为什么要有这个：nodes.py 之前全是“我手动敲一遍看结果”，
#   而那种验法不可复现 —— 改一行、下次靠记忆重敲，漏掉就是静默回归。
#
# 这个脚本做的事：把每个配方都真建一遍，检查
#   ① 建得出来（不抛异常）
#   ② 挂到物体后**真算出几何**（顶点数 > 0）—— 这是“接上了”的唯一硬证据
#   ③ 参数真的生效（改 size/density，顶点数要跟着变）
#   ④ 颜色真的转了线性（#808080 的线性值应该约 0.216，不是 0.5）
#   ⑤ 清理不碰用户自己的节点组
import bpy
import json
import traceback

SRC = __import__('os').path.join(__import__('os').path.dirname(__file__), "nodes.py")

R = {"pass": 0, "fail": 0, "items": []}


# 载入源码：优先用调用方预先塞进来的，否则读盘。
#
# ！为何要有这个分支：安装后的路径不是开发路径，
#   而自检脚本会被打包进 App（runtime/_selftest_nodes.py），那份环境里
#   SRC 那个开发路径根本不存在。硬读就是 FileNotFoundError。
_SRC_TEXT = None
try:
    _SRC_TEXT = _PRELOADED_SRC  # noqa: F821
    _SRC_FROM = "preloaded"
except NameError:
    _SRC_FROM = SRC


def ok(name, cond, extra=""):
    R["items"].append({"name": name, "ok": bool(cond), "extra": str(extra)[:160]})
    if cond:
        R["pass"] += 1
    else:
        R["fail"] += 1


def fresh_object(name):
    """每次用一个全新空网格物体，避免上一轮残留的修改器影响判断。"""
    old = bpy.data.objects.get(name)
    if old:
        bpy.data.objects.remove(old, do_unlink=True)
    me = bpy.data.meshes.new(name)
    ob = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(ob)
    return ob


def eval_counts(ob):
    bpy.context.view_layer.update()
    dg = bpy.context.evaluated_depsgraph_get()
    ev = ob.evaluated_get(dg)
    try:
        me = ev.to_mesh()
        v, p = len(me.vertices), len(me.polygons)
        ev.to_mesh_clear()
        return v, p
    except Exception:
        return 0, 0


# ── 载入 ──
ns = {"__name__": "nodes_test"}
try:
    _code = _SRC_TEXT if _SRC_TEXT else open(SRC, encoding="utf-8").read()
    exec(compile(_code, _SRC_FROM, "exec"), ns)
    ok("载入 nodes.py", True)
except Exception:
    ok("载入 nodes.py", False, traceback.format_exc()[-300:])
    print("HEADLESS " + json.dumps(R, ensure_ascii=False))
    raise SystemExit(0)

d = ns["dispatch"]

# ── 1. 颜色转线性 ──
try:
    rgb = ns["_rgb"]("#808080")
    # sRGB 0.502 → 线性约 0.2159。若直接返回 0.502 就是没转。
    ok("颜色转线性（#808080 → ≈0.216，不是 0.5）",
       0.20 < rgb[0] < 0.23, "实际 %.4f" % rgb[0])
    white = ns["_rgb"]("#ffffff")
    ok("白色转线性还是 1.0", abs(white[0] - 1.0) < 1e-6, "实际 %.4f" % white[0])
    black = ns["_rgb"]("#000000")
    ok("黑色转线性还是 0", abs(black[0]) < 1e-6)
    bad = ns["_rgb"]("不是颜色")
    ok("非法颜色给 fallback 不崩", isinstance(bad, tuple) and len(bad) == 3)
except Exception:
    ok("颜色转线性", False, traceback.format_exc()[-200:])

# ── 2. 配方注册 ──
rec = json.loads(d("recipes", {}))
ok("几何配方齐（blades/grid_clumps/array/noise_displace）",
   set(rec.get("geo", [])) >= {"blades", "grid_clumps", "array", "noise_displace"},
   str(rec.get("geo")))
ok("材质配方齐（weathered/emissive/image）",
   set(rec.get("mat", [])) >= {"weathered", "emissive", "image"}, str(rec.get("mat")))

# ── 3. blades 真出几何 ──
ob = fresh_object("T_Blades")
r1 = json.loads(d("geo", {"recipe": "blades", "size": 2.0, "density": 60,
                          "height": 0.3, "width": 0.02, "name": "T_Blades"}))
ok("blades 建组成功", r1.get("ok") is True, r1.get("error", ""))
v1, p1 = eval_counts(ob)
ok("blades 挂上后真算出几何", v1 > 0 and p1 > 0, "%d 顶点 / %d 面" % (v1, p1))

# ── 4. 参数真生效（密度变大 → 顶点变多）──
ob2 = fresh_object("T_Blades2")
r2 = json.loads(d("geo", {"recipe": "blades", "size": 2.0, "density": 140,
                          "height": 0.3, "width": 0.02, "name": "T_Blades2"}))
v2, _ = eval_counts(ob2)
ok("密度 60→140 顶点数变多（参数真生效）", v2 > v1, "%d → %d" % (v1, v2))

# ── 5. grid_clumps ──
ob3 = fresh_object("T_Clumps")
r3 = json.loads(d("geo", {"recipe": "grid_clumps", "size": 2.0, "density": 20,
                          "clump_scale": 0.1, "name": "T_Clumps"}))
v3, p3 = eval_counts(ob3)
ok("grid_clumps 真算出几何", r3.get("ok") and v3 > 0, "%d 顶点" % v3)

# ── 6. noise_displace ──
ob4 = fresh_object("T_Noise")
bpy.context.view_layer.objects.active = ob4
# 先给它一点几何，否则噪波无从下手
import bmesh
bm = bmesh.new(); bmesh.ops.create_grid(bm, x_segments=8, y_segments=8, size=1.0)
bm.to_mesh(ob4.data); bm.free()
r4 = json.loads(d("geo", {"recipe": "noise_displace", "name": "T_Noise",
                          "strength": 0.2, "scale": 2.0}))
v4, _ = eval_counts(ob4)
ok("noise_displace 建组且挂载成功", r4.get("ok") is True, r4.get("error", ""))
ok("noise_displace 后顶点还在（没被吃空）", v4 > 0, "%d 顶点" % v4)

# ── 7. array ──
ob5 = fresh_object("T_Array")
bpy.context.view_layer.objects.active = ob5
bm = bmesh.new(); bmesh.ops.create_cube(bm, size=0.2)
bm.to_mesh(ob5.data); bm.free()
r5 = json.loads(d("geo", {"recipe": "array", "name": "T_Array", "count": 4,
                          "offset": [1.0, 0.0, 0.0]}))
ok("array 建组成功", r5.get("ok") is True, r5.get("error", ""))

# ── 8. 材质：两套颜色都要设 ──
rm = json.loads(d("mat", {"recipe": "weathered", "name": "T_Mat", "color": "#4a6b2f",
                          "roughness": 0.9}))
ok("weathered 建材质成功", rm.get("ok") is True, rm.get("error", ""))
m = bpy.data.materials.get("T_Mat")
if m:
    # 关键：diffuse_color 必须被设（Workbench 和视口只认它）
    dc = m.diffuse_color
    ok("diffuse_color 被设成绿色（不是默认灰 0.8）",
       dc[1] > dc[0] and abs(dc[0] - 0.8) > 0.01,
       "实际 %.3f,%.3f,%.3f" % (dc[0], dc[1], dc[2]))
    bsdf = next((n for n in m.node_tree.nodes if n.bl_idname == "ShaderNodeBsdfPrincipled"), None)
    ok("有 Principled BSDF", bsdf is not None)
else:
    ok("weathered 建出材质对象", False)

re_ = json.loads(d("mat", {"recipe": "emissive", "name": "T_Glow", "color": "#4a7bd0",
                           "strength": 5.0}))
ok("emissive 建材质成功", re_.get("ok") is True, re_.get("error", ""))

# ── 8b. 图片贴图 ──
# 建一个**没有 UV** 的球，验证“一条命令就能贴上图”这条路径
ob_t = fresh_object("T_Tex")
import bmesh as _bm
_bmf = _bm.new()
_bm.ops.create_uvsphere(_bmf, u_segments=20, v_segments=12, radius=1.0)
_bmf.to_mesh(ob_t.data); _bmf.free()
ok("测试球初始没有 UV（前提成立）", len(ob_t.data.uv_layers) == 0,
   str(list(ob_t.data.uv_layers.keys())))

rt = json.loads(d("mat", {"recipe": "image", "name": "T_TexMat", "object": "T_Tex",
                          "projection": "box"}))
ok("image 配方建材质成功", rt.get("ok") is True, rt.get("error", ""))
ok("自动展了 UV", len(ob_t.data.uv_layers) > 0,
   str([l.name for l in ob_t.data.uv_layers]))
ok("UV 没有退化面（贴图不会被挤成一线）",
   (rt.get("uv") or {}).get("degenerate_faces", 999) == 0,
   "退化 %s 面" % (rt.get("uv") or {}).get("degenerate_faces"))
m_t = bpy.data.materials.get("T_TexMat")
if m_t:
    has_img = any(n.bl_idname == "ShaderNodeTexImage" and n.image for n in m_t.node_tree.nodes)
    ok("材质里有带图的 Image Texture 节点", has_img)
else:
    ok("T_TexMat 建出来了", False)

# smart 投影也要能跑（无头下需要 EDIT 模式，容易挂）
while len(ob_t.data.uv_layers):
    ob_t.data.uv_layers.remove(ob_t.data.uv_layers[0])
rs = json.loads(d("uv", {"name": "T_Tex", "projection": "smart"}))
ok("smart 投影在无头下也能跑", rs.get("ok") is True, rs.get("error", ""))
ok("smart 投影真的展出了 UV", len(ob_t.data.uv_layers) > 0)

# 几何节点产物的“空网格”陷阱：展 UV 前必须实化
ob_g = fresh_object("T_GeoUV")
rg = json.loads(d("geo", {"recipe": "blades", "size": 1.0, "density": 30,
                          "height": 0.2, "width": 0.02, "name": "T_GeoUV"}))
ok("几何节点先挂上了", rg.get("ok") is True, rg.get("error", ""))
ok("几何节点产物的源网格是空的（陷阱存在）",
   len(ob_g.data.polygons) == 0 or len(ob_g.data.vertices) == 0,
   "源网格 %d 顶点 / %d 面" % (len(ob_g.data.vertices), len(ob_g.data.polygons)))
ruv = json.loads(d("uv", {"name": "T_GeoUV", "projection": "box"}))
ok("对几何节点产物展 UV 会先实化，不静默失败",
   ruv.get("ok") is True and ruv.get("applied_geometry") is True,
   "ok=%s applied=%s" % (ruv.get("ok"), ruv.get("applied_geometry")))

# ── 9. 清理只动 DSH_ 前缀 ──
# 造一个“用户的”节点组，清理后必须还在
user_ng = bpy.data.node_groups.new("MineNotDSH", "GeometryNodeTree")
cl = json.loads(d("cleanup", {"prefix": "DSH_"}))
ok("cleanup 删了东西", cl.get("count", 0) > 0, "%d 个" % cl.get("count", 0))
ok("cleanup 没有删用户自己的节点组（MineNotDSH 还在）",
   bpy.data.node_groups.get("MineNotDSH") is not None)
bpy.data.node_groups.remove(user_ng)

# ── 10. 错误处理：不存在的配方要明确报，不是崩 ──
badr = json.loads(d("geo", {"recipe": "不存在的配方"}))
ok("未知配方明确报错并给出可用列表",
   badr.get("ok") is False and badr.get("available"), str(badr.get("available")))

# ── 11. 别名查找（Fac/Factor 那类坑）──
try:
    # _pick 应该能按第二个候选名找到
    class FakeSocket:
        def __init__(self, n):
            self.name = n
    got = ns["_pick"]([FakeSocket("Factor")], "Fac", "Factor")
    ok("插口别名能匹配（Fac → Factor）", got.name == "Factor")
    try:
        ns["_pick"]([FakeSocket("X")], "A", "B")
        ok("找不到插口时应该抛错", False, "没抛")
    except KeyError:
        ok("找不到插口时抛 KeyError 并列出实际名", True)
except Exception:
    ok("插口别名", False, traceback.format_exc()[-200:])

print("HEADLESS " + json.dumps(R, ensure_ascii=False))
# 也放进全局，供 nodes op=selftest 读（stdout 会被截断，不能只靠它）
HEADLESS_RESULT = R
