# motion_rig.py 的真机回归测试
#
# 为何要专门测：骨架出错的形态最隐晦——
#   转骨骼时零件不动（权重没写上）、零件乱飞（权重分错）、
#   或者更糟：**看着动了，但该跟着的没跟着**（骨骼树断了一节）。
#   最后一种在渲染图上几乎看不出来，只有数“动了几个”才能发现。
#
# 关键判据：
#   ① 骨架真的建出来了，骨骼数与零件数对得上
#   ② rigid 绑定的权重**严格等于 1.0**（不是 0.99，也不是多骨混合）
#   ③ 转一根骨骼，**它自己和它在树上的子孙**都动，别人不动
#   ④ 骨骼树无环（环会让 Blender 直接崩或无限递归）
#   ⑤ 默认姿态还原到精度极限
import bpy
import bmesh
import json
import math
import traceback

SRC = "W:/Games/Hanako/Work/blender-app/blender-bridge/runtime/motion_rig.py"
R = {"pass": 0, "fail": 0, "items": []}


def ok(name, cond, extra=""):
    R["items"].append({"name": name, "ok": bool(cond), "extra": str(extra)[:170]})
    if cond:
        R["pass"] += 1
    else:
        R["fail"] += 1


def finish():
    print("HEADLESS " + json.dumps(R, ensure_ascii=False))
    globals()["HEADLESS_RESULT"] = R
    raise SystemExit(0)


ns = {"__name__": "rig_test"}
try:
    _code = None
    try:
        _code = _PRELOADED_SRC  # noqa: F821
    except NameError:
        _code = open(SRC, encoding="utf-8").read()
    exec(compile(_code, SRC, "exec"), ns)
    ok("载入 motion_rig.py", True)
except Exception:
    ok("载入 motion_rig.py", False, traceback.format_exc()[-300:])
    finish()

d = ns["dispatch"]

# ── 清场 ──
for o in [x.name for x in bpy.data.objects]:
    bpy.data.objects.remove(bpy.data.objects[o], do_unlink=True)

from mathutils import Matrix, Vector


def mk_box(name, size, loc, parent=None):
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts:
        for i in range(3):
            v.co[i] *= size[i]
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(ob)
    ob.location = loc
    return ob


# 造一个“机械”：底盘 + 塔座 + 炮管（伸出塔外，模拟虎式的结构难点）
base = mk_box("Base", (2.0, 3.0, 0.6), (0, 0, 0.3))
tower = mk_box("Tower", (1.2, 1.2, 0.8), (0, 0, 1.0))
# 炮管中心在塔外（y=1.5），只尾端相接——这正是虎式 Gun_Barrel 的情况
barrel = mk_box("Barrel", (0.16, 2.4, 0.16), (0, 1.5, 1.3))
bpy.context.view_layer.update()
ok("测试场景建好了", True, "Base/Tower/Barrel（炮管中心在塔外）")

# ── 1. 建骨架 ──
r = json.loads(d("build", {"name": "TRig", "mode": "auto"}))
ok("build 成功", r.get("ok") is True, r.get("error", ""))
ok("骨骼数 = 零件数", r.get("bones") == 3, str(r.get("bones")))
hier = r.get("hierarchy") or {}
ok("建起了父子关系（不是全孤立）", (hier.get("linked") or 0) >= 2,
   json.dumps(hier, ensure_ascii=False))
ok("只剩 1 个根骨", (hier.get("roots") or 0) == 1, str(hier.get("roots")))

arm = bpy.data.objects.get("TRig")
ok("骨架对象存在", arm is not None and arm.type == "ARMATURE")

# ── 2. 骨骼树不能有环 ──
cyc = False
for b in arm.data.bones:
    seen = set()
    p = b
    for _ in range(64):
        if p is None:
            break
        if p.name in seen:
            cyc = True
            break
        seen.add(p.name)
        p = p.parent
ok("骨骼树无环", not cyc)

# 炮管必须挂在塔下面（这是虎式踩过的坑）
def chain(n):
    out = []
    b = arm.data.bones.get(n)
    while b:
        out.append(b.name)
        b = b.parent
    return out


ok("炮管挂在塔的骨链下（不是孤儿）",
   "Tower" in chain("Barrel"), " <- ".join(chain("Barrel")[:4]))
ok("塔挂在底盘下", "Base" in chain("Tower"), " <- ".join(chain("Tower")[:4]))

# ── 3. 绑定 ──
b = json.loads(d("bind", {"armature": "TRig", "mode": "rigid"}))
ok("bind 成功", b.get("ok") is True, b.get("error", ""))
ok("3 个都绑上了", b.get("bound") == 3, "%s bound / %s failed" %
   (b.get("bound"), b.get("failed")))

# rigid 权重必须严格 1.0
bad_w = []
for name in ["Base", "Tower", "Barrel"]:
    ob = bpy.data.objects[name]
    vgs = {g.name: g for g in ob.vertex_groups}
    if len(vgs) != 1:
        bad_w.append("%s 有 %d 个顶点组" % (name, len(vgs)))
        continue
    for v in ob.data.vertices:
        tot = sum(g.weight for g in v.groups)
        if abs(tot - 1.0) > 1e-6:
            bad_w.append("%s v%d 权重和 %.4f" % (name, v.index, tot))
            break
ok("rigid 权重严格 1.0（不是软混合）", not bad_w, "; ".join(bad_w[:3]))

# ── 4. 转塔骨：自己 + 子孙动，别人不动 ──
p = json.loads(d("pose", {"armature": "TRig", "bone": "Tower",
                          "degrees": 40, "axis": "Z", "pose": True}))
ok("pose 成功", p.get("ok") is True, p.get("error", ""))
ok("转了 40° 真的产生位移", (p.get("max_displacement") or 0) > 0.05,
   str(p.get("max_displacement")))

moved = set(p.get("moved_preview") or [])
ok("塔自己动了", "Tower" in moved, str(sorted(moved)))
ok("炮管跟着动了（子树继承）", "Barrel" in moved, str(sorted(moved)))
ok("底盘没动（不属塔的子树）", "Base" not in moved, str(sorted(moved)))
ok("恰好 2 个动了（塔+炮管）", p.get("meshes_moved") == 2,
   "%s 个：%s" % (p.get("meshes_moved"), sorted(moved)))

# ── 5. 几何验证：炮管绕塔轴转 φ 后，位置符合旋转公式 ──
# 先还原（用产品代码自己的还原，基准才对得上）
for pb in arm.pose.bones:
    pb.rotation_mode = "QUATERNION"
    pb.rotation_quaternion = (1, 0, 0, 0)
    pb.location = (0, 0, 0)
    pb.scale = (1, 1, 1)
bpy.context.view_layer.update()


def barrel_center():
    dg = bpy.context.evaluated_depsgraph_get()
    ob = bpy.data.objects["Barrel"]
    ev = ob.evaluated_get(dg)
    me = ev.to_mesh()
    acc = Vector((0, 0, 0))
    for v in me.vertices:
        acc += ev.matrix_world @ v.co
    c = acc / max(len(me.vertices), 1)
    ev.to_mesh_clear()
    return c


c0 = barrel_center()
PHI = 40.0
d("pose", {"armature": "TRig", "bone": "Tower", "degrees": PHI,
           "axis": "Z", "pose": True})
c1 = barrel_center()
r0 = math.hypot(c0.x, c0.y)
r1 = math.hypot(c1.x, c1.y)
ok("炮管绕塔轴转（半径不变）", abs(r1 - r0) < 0.02,
   "半径 %.4f -> %.4f" % (r0, r1))
exp = math.radians(PHI)
ok("炮管角度符合旋转公式",
   abs(math.atan2(c0.y, c0.x) + exp - math.atan2(c1.y, c1.x)) % (2 * math.pi) < 0.02
   or abs(abs(math.atan2(c0.y, c0.x) + exp - math.atan2(c1.y, c1.x))
          - 2 * math.pi) < 0.02,
   "角度 %.4f -> %.4f，应 +%.4f rad" % (math.atan2(c0.y, c0.x),
                                    math.atan2(c1.y, c1.x), exp))
ok("炮管高度不变（绕 Z 转）", abs(c1.z - c0.z) < 0.01,
   "z %.4f -> %.4f" % (c0.z, c1.z))

# ── 6. 默认还原（pose 不给 → 自动还原）──
# ！注意：上一段 pose_keep=True 已经把姿态留在 40°，这里不手动复位就测不准。
#   先手动归零，再用默认参数转一次，验证它自己会还原。
for pb in arm.pose.bones:
    pb.rotation_quaternion = (1, 0, 0, 0)
    pb.location = (0, 0, 0)
bpy.context.view_layer.update()
c_mid = barrel_center()
d("pose", {"armature": "TRig", "bone": "Tower", "degrees": 33, "axis": "Z"})
c2 = barrel_center()
ok("默认 pose 自动还原到原样", (c2 - c_mid).length < 1e-4,
   "差 %.2e" % (c2 - c_mid).length)

# ── 7. IK 约束 ──
ikr = json.loads(d("ik", {"armature": "TRig", "bone": "Tower", "chain_length": 2}))
ok("ik 成功", ikr.get("ok") is True, ikr.get("error", ""))
ok("IK 目标物体建出来了", ikr.get("target") and
   bpy.data.objects.get(ikr.get("target")) is not None, ikr.get("target"))
has_ik = any(c.type == "IK" for pb in arm.pose.bones for c in pb.constraints)
ok("IK 约束真的挂上了", has_ik)

# ── 8. status 如实反映 ──
st = json.loads(d("status", {}))
rows = st.get("armatures") or []
ok("status 报出 1 个骨架", len(rows) == 1, str(len(rows)))
if rows:
    ok("status 报 3 根骨", rows[0].get("bones") == 3, str(rows[0].get("bones")))
    ok("status 报 3 个绑定网格", rows[0].get("bound_meshes") == 3,
       str(rows[0].get("bound_meshes")))

# ── 9. skin 模式能跑（不崩就行，不验精度）──
sk = json.loads(d("bind", {"armature": "TRig", "mode": "skin",
                           "max_influences": 2}))
ok("skin 模式不崩", sk.get("ok") is True, sk.get("error", ""))
ob = bpy.data.objects["Barrel"]
multi = 0
for v in ob.data.vertices:
    if len([g for g in v.groups if g.weight > 0.01]) > 1:
        multi += 1
ok("skin 模式确实产生了多骨混合（不是退化成 rigid）", multi > 0,
   "%d 个顶点有多骨权重" % multi)

# ── 10. 错误路径 ──
e1 = json.loads(d("bind", {"armature": "不存在"}))
ok("绑定不存在的骨架明确报错", e1.get("ok") is False and e1.get("error"))
e2 = json.loads(d("pose", {"armature": "TRig", "bone": "没这根骨"}))
ok("转不存在的骨骼明确报错", e2.get("ok") is False and e2.get("error"))
e3 = json.loads(d("不存在的op", {}))
ok("未知 op 报错并列出可用的", e3.get("ok") is False and e3.get("ops"),
   str(e3.get("ops")))

finish()
