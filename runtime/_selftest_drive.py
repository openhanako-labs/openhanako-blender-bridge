# motion_drive.py 的真机回归测试
#
# 为何需要：驱动动的是**用户的场景**。这类代码出错不是“没显示”，
#   是“把模型转歪了”或“转完没还原”。两种都很难事后发现。
#
# 所以关键检查不是“能不能转”，而是：
#   ① 只转 child 侧 —— parent 一根手指头都不碰
#   ② 默认转完**精确还原** —— 矩阵位级一致，不是“看着差不多”
#   ③ 角度算出的是对的 —— 用几何关系验，不是“变了没”
#   ④ 子孙对象跟着走 —— 否则小零件会留在原地
import bpy
import json
import math
import traceback

SRC = "W:/Games/Hanako/Work/blender-app/blender-bridge/runtime/motion_drive.py"
R = {"pass": 0, "fail": 0, "items": []}


def ok(name, cond, extra=""):
    R["items"].append({"name": name, "ok": bool(cond), "extra": str(extra)[:160]})
    if cond:
        R["pass"] += 1
    else:
        R["fail"] += 1


def finish():
    print("HEADLESS " + json.dumps(R, ensure_ascii=False))
    globals()["HEADLESS_RESULT"] = R
    raise SystemExit(0)


# ── 装载 ──
ns = {"__name__": "drive_test"}
try:
    _code = None
    try:
        _code = _PRELOADED_SRC  # noqa: F821
    except NameError:
        _code = open(SRC, encoding="utf-8").read()
    exec(compile(_code, SRC, "exec"), ns)
    ok("载入 motion_drive.py", True)
except Exception:
    ok("载入 motion_drive.py", False, traceback.format_exc()[-300:])
    finish()

d = ns["dispatch"]


def wloc(name):
    ob = bpy.data.objects.get(name)
    return tuple(round(v, 5) for v in ob.matrix_world.translation) if ob else None


def wmat(name):
    ob = bpy.data.objects.get(name)
    if not ob:
        return None
    return [round(x, 6) for row in ob.matrix_world for x in row]


# ── 造一个最小机械：底座 + 炮塔 + 炮管 + 炮管上的小零件 ──
import bmesh


def mk(name, fn, loc, rot=None):
    me = bpy.data.meshes.new(name)
    bm = bmesh.new(); fn(bm); bm.to_mesh(me); bm.free()
    ob = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(ob)
    ob.location = loc
    if rot:
        ob.rotation_euler = rot
    return ob


for o in [x.name for x in bpy.data.objects if x.type == "MESH"]:
    bpy.data.objects.remove(bpy.data.objects[o], do_unlink=True)

base = mk("Base", lambda bm: bmesh.ops.create_cube(bm, size=2.0), (0, 0, 0.5))
tur = mk("Turret", lambda bm: bmesh.ops.create_cone(
    bm, cap_ends=True, radius1=0.7, radius2=0.7, depth=0.6, segments=24), (0, 0, 1.6))
gun = mk("Gun", lambda bm: bmesh.ops.create_cone(
    bm, cap_ends=True, radius1=0.09, radius2=0.07, depth=2.0, segments=16),
    (0, 1.1, 1.6), rot=(math.radians(90), 0, 0))
bpy.context.view_layer.update()
gun.parent = tur
gun.matrix_parent_inverse = tur.matrix_world.inverted()
muzzle = mk("Muzzle", lambda bm: bmesh.ops.create_cube(bm, size=0.2), (0, 2.0, 1.6))
bpy.context.view_layer.update()
muzzle.parent = gun
muzzle.matrix_parent_inverse = gun.matrix_world.inverted()
bpy.context.view_layer.update()

ok("炮管是炮塔的子物体", gun.parent is not None and gun.parent.name == "Turret")
ok("小零件是炮管的子物体", muzzle.parent is not None and muzzle.parent.name == "Gun")

# 登记关节（用 motion 的记录库）
try:
    K = __import__("sys").modules.get("dsh_rt_kernel")
    if K is not None and hasattr(K, "dsh_motion_api"):
        K.dsh_motion_api["joint"]("turret_yaw", "Base", "Turret",
                                  kind="revolute", axis=[0, 0, 1], anchor=[0, 0, 1.6])
        ok("登记关节 turret_yaw", True)
    else:
        ok("motion 没装载（用替身关节库）", False, "跳过真实驱动测试")
        finish()
except Exception:
    ok("登记关节 turret_yaw", False, traceback.format_exc()[-200:])
    finish()

P0 = {n: wloc(n) for n in ["Base", "Turret", "Gun", "Muzzle"]}
M0 = {n: wmat(n) for n in ["Base", "Turret", "Gun", "Muzzle"]}

# ── 1. status 认得这个关节 ──
st = json.loads(d("status", {}))
ok("status 报出 1 个可驱动关节", st.get("drivable") == 1, str(st.get("items"))[:120])

# ── 2. 错误路径 ──
bad = json.loads(d("drive", {"jid": "不存在", "angle": 10}))
ok("drive 不存在的关节明确报错", bad.get("ok") is False and bad.get("error"))
nojid = json.loads(d("drive", {"angle": 10}))
ok("drive 不给 jid 明确报错", nojid.get("ok") is False)

# ── 3. 转 50°，验四件事 ──
# ！关键：这里必须用 pose=True，否则测完就还原了。
#   而且测完要手动还原回 M0 —— 否则后面的“位级一致”会拿错基准。
#   （第一版测试就栽在这里：M0 是 50° 姿态下存的，后面对不上。）
r = json.loads(d("drive", {"jid": "turret_yaw", "angle": 50, "pose": True}))
ok("drive 成功", r.get("ok") is True, r.get("error", ""))
ok("真的动过（moved=true）", r.get("moved") is True)
# 炮塔 + 炮管 + 小零件 = 3。子孙跟着走才对。
ok("带动了 3 个对象（炮塔+炮管+小零件）", r.get("rotated_objects") == 3,
   str(r.get("names_preview")))
ok("子孙对象被包含（include_descendants 生效）",
   "Muzzle" in (r.get("names_preview") or []), str(r.get("names_preview")))

# ① parent 一根手指头都没碰
ok("底座（parent 侧）位置没变", wloc("Base") == P0["Base"],
   "%s -> %s" % (P0["Base"], wloc("Base")))
ok("底座矩阵位级一致", wmat("Base") == M0["Base"])

# ③ 角度算得对：炮管绕 Z 转 50°，位置应为 (-1.1·sin50, 1.1·cos50)
gx, gy, gz = wloc("Gun")
exp_x = round(-1.1 * math.sin(math.radians(50)), 4)
exp_y = round(1.1 * math.cos(math.radians(50)), 4)
ok("炮管位置符合 50° 旋转公式",
   abs(gx - exp_x) < 2e-3 and abs(gy - exp_y) < 2e-3,
   "实际 (%.4f, %.4f)，应为 (%.4f, %.4f)" % (gx, gy, exp_x, exp_y))

# ④ 子孙跟着走：小零件原先在 (0,2.0)，转后也该到半径 2.0 的圆弧上
mx, my, mz = wloc("Muzzle")
r_actual = math.hypot(mx, my)
ok("小零件（子孙）跟着转了（半径不变）",
   abs(r_actual - 2.0) < 0.02, "半径 %.4f（应 2.0）" % r_actual)
ok("小零件世界位置变了", (mx, my) != P0["Muzzle"][:2],
   "%s -> %s" % (P0["Muzzle"], (mx, my, mz)))
ok("小零件高度没变（绕 Z 转不动 Z）", abs(mz - P0["Muzzle"][2]) < 1e-4)

# ── 4. 先手动转回去（把姿态还原），再测默认还原 ──
# 这一步是为了让 M0 成为“真正的原样”。
nb = json.loads(d("drive", {"jid": "turret_yaw", "angle": -50, "pose": True}))
ok("反向转回原位", nb.get("ok") is True)
ok("基准已回到原样（先验基准对，再验还原）",
   all(wmat(n) == M0[n] for n in ["Turret", "Gun", "Muzzle"]),
   "这一步不过，后面的还原测试就不算数")

# ── 5. 默认（pose 不给）必须精确还原 ──
r2 = json.loads(d("drive", {"jid": "turret_yaw", "angle": 37}))
ok("默认 drive 会还原", r2.get("restored") is True)
ok("回执声称还原精确", r2.get("restore_exact") is True)
for n in ["Base", "Turret", "Gun", "Muzzle"]:
    ok("%s 矩阵回到原样（位级）" % n, wmat(n) == M0[n],
       ("最大差 %.2e" % max(abs(a - b) for a, b in zip(wmat(n), M0[n]))) if wmat(n) != M0[n] else "")

# ── 6. sweep：每个角度都该还原回来（不累计）──
sw = json.loads(d("sweep", {"jid": "turret_yaw", "start": -40, "end": 40, "steps": 5}))
ok("sweep 成功", sw.get("ok") is True, sw.get("error", ""))
ok("sweep 采样了 5 个角度", len(sw.get("samples") or []) == 5)
ok("sweep 后模型回到原位（不累计转角）",
   all(wmat(n) == M0[n] for n in ["Turret", "Gun", "Muzzle"]))
sizes = [s.get("size") for s in (sw.get("samples") or [])]
ok("sweep 各角度的包围盒有差异（真的在每个角度量了）",
   len(set(tuple(s) for s in sizes if s)) > 1, str(sizes[:3]))

finish()
