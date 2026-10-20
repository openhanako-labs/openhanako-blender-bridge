# motion_rig.py 的 export 专项自检
#
# 为何单独测导出：导出是**只读快照**，但它是外部（卡片/文档/引擎）唯一的入口。
#   它错的地方不是“崩”，而是“看着合理但结构不对”：
#     · 履带被当成绕轴转的关节
#     · 车体（根骨）被给了转轴
#     · 杆状零件的轴推到长轴上（自转，不是摆动）
#   这三种在 JSON 里都合法，下游会画出荒谬的东西。
import bpy
import bmesh
import json
import math
import os
import traceback

SRC = __import__('os').path.join(__import__('os').path.dirname(__file__), "motion_rig.py")
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


ns = {"__name__": "rig_export_test"}
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

# ── 纯函数：轴推断 ──
inf = ns["_infer_axis"]

ai, shape, conf = inf([2.30, 2.29, 0.94], None)
ok("盘状（炮塔）→ 最扁的轴 Z", ai == 2 and shape == "disc", "%s %s" % ("XYZ"[ai], shape))

ai, shape, conf = inf([0.20, 4.00, 0.18], 2)
ok("杆状（炮管，父轴 Z）→ 垂直轴向 X",
   ai == 0 and shape == "rod", "%s %s" % ("XYZ"[ai], shape))

ai, shape, conf = inf([0.12, 0.69, 0.69], None)
ok("盘状（轮子）→ 最扁的轴 X", ai == 0 and shape == "disc", "%s %s" % ("XYZ"[ai], shape))

# 关键判据：杆状零件的轴**绝不能**是它自己的长轴
ai, shape, conf = inf([0.20, 4.00, 0.18], None)
ok("杆状零件的轴不是长轴 Y（否则是自转不是摆动）", ai != 1,
   "选到了 %s" % "XYZ"[ai])

# ── 是否该当履带 ──
is_trk = ns["_is_track_like"]
ok("名字带 Track 的判为履带", is_trk("TrackLinks_L"))
ok("SpareTrack（备品）不判为履带", not is_trk("SpareTrack_Nose"))
ok("名字普通的杆不判为履带", not is_trk("Gun_Barrel", [0.2, 4.0, 0.18]))

# ── 造一个最小机械，跑完整导出 ──
for o in [x.name for x in bpy.data.objects]:
    bpy.data.objects.remove(bpy.data.objects[o], do_unlink=True)

from mathutils import Vector


def mk_box(name, size, loc):
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


# 车体 + 炮塔（盘状）+ 炮管（杆状，中心在塔外）
mk_box("Base", (2.0, 3.0, 0.6), (0, 0, 0.3))
mk_box("Tower", (1.2, 1.2, 0.8), (0, 0, 1.0))
mk_box("Barrel", (0.16, 2.4, 0.16), (0, 1.5, 1.3))
bpy.context.view_layer.update()

b = json.loads(d("build", {"name": "XRig", "mode": "auto"}))
ok("build 成功", b.get("ok") is True, b.get("error", ""))
bd = json.loads(d("bind", {"armature": "XRig", "mode": "rigid"}))
ok("bind 成功", bd.get("ok") is True, bd.get("error", ""))

OUT = os.path.join(os.environ.get("TEMP", "."), "_selftest_motion.json")
e = json.loads(d("export", {"armature": "XRig", "out": OUT}))
ok("export 成功", e.get("ok") is True, e.get("error", ""))
ok("导出了 3 个关节", e.get("joints_count") == 3, str(e.get("joints_count")))
ok("文件真的写出来了", os.path.exists(OUT), OUT)

if os.path.exists(OUT):
    with open(OUT, encoding="utf-8") as f:
        J = json.load(f)
    ok("JSON 可解析", isinstance(J, dict))
    ok("version 字段在", J.get("version") == "1.2", str(J.get("version")))
    ok("bbox 有三边", len((J.get("bbox") or {}).get("size") or []) == 3,
       str((J.get("bbox") or {}).get("size")))
    ok("joints 是数组", isinstance(J.get("joints"), list),
       str(type(J.get("joints"))))

    js = {j["id"]: j for j in (J.get("joints") or [])}
    ok("三个关节都在", set(js.keys()) == {"Base", "Tower", "Barrel"}, str(sorted(js.keys())))

    # 根骨必须 fixed，且**不带轴**
    base = js.get("Base") or {}
    ok("根骨 kind = fixed", base.get("kind") == "fixed", str(base.get("kind")))
    ok("根骨不带转轴（否则下游会画一个不存在的旋钮）",
       "axis" not in base, str(base.get("axis")))

    # 非根骨必须 revolute 且带轴
    tw = js.get("Tower") or {}
    ok("非根骨 kind = revolute", tw.get("kind") == "revolute", str(tw.get("kind")))
    ok("非根骨带转轴", isinstance(tw.get("axis"), list), str(tw.get("axis")))
    ok("炮塔的轴是 Z（盘状）", tw.get("axis") == [0, 0, 1], str(tw.get("axis")))

    bl = js.get("Barrel") or {}
    ok("炮管的轴是 X（垂直于杆）", bl.get("axis") == [1, 0, 0], str(bl.get("axis")))
    ok("炮管父级正确", bl.get("parent") == "Tower", str(bl.get("parent")))

    # pivot 必须等于骨骼头
    ok("pivot 字段存在", isinstance(tw.get("pivot"), list), str(tw.get("pivot")))
    ok("pivot 与 head 一致", tw.get("pivot") == tw.get("head"),
       "%s vs %s" % (tw.get("pivot"), tw.get("head")))

    # 每根骨都要有 bbox（下游画盒子用）
    ok("每个关节都有 bbox", all("bbox" in j for j in js.values()),
       str([k for k, v in js.items() if "bbox" not in v]))

    # diagnostics 要诚实
    dg = J.get("diagnostics") or {}
    ok("diagnostics 报了轴形态统计", isinstance(dg.get("axis_shapes"), dict),
       str(dg.get("axis_shapes")))
    ok("diagnostics 报了根骨", "Base" in (dg.get("root_bones") or []),
       str(dg.get("root_bones")))
    # ！不要再断言“同轴警告”：那个判据本身是错的（轮毂与轮子本来就同轴）
    ok("不再拿“与父同轴”当警告（换成几何反包检查）",
       "same_axis_as_parent" not in dg, str(list(dg.keys())))
    ok("diagnostics 标注了快照性质", "note" in dg, str(dg.get("note"))[:60])

    # ！关键：给驱动建议而不是替用户决定“能不能转”
    ok("每个关节都有 drive_hint", all("drive_hint" in j for j in js.values()),
       str([k for k, v in js.items() if "drive_hint" not in v]))
    ok("根骨的 drive_hint 是 static",
       (js.get("Base") or {}).get("drive_hint") == "static",
       str((js.get("Base") or {}).get("drive_hint")))
    ok("legend 说明了这是建议不是事实",
       "note" in (J.get("drive_hint_legend") or {}),
       str(J.get("drive_hint_legend")))
    ok("diagnostics 统计了 drive_hints",
       isinstance(dg.get("drive_hints"), dict), str(dg.get("drive_hints")))

    # ── 装配层 ──
    ok("assemblies 字段存在", isinstance(J.get("assemblies"), list),
       str(type(J.get("assemblies"))))
    ok("diagnostics 报了装配组数", isinstance(dg.get("assemblies_count"), int),
       str(dg.get("assemblies_count")))
    ok("diagnostics 报了旋钮数", isinstance(dg.get("knobs_count"), int),
       str(dg.get("knobs_count")))
    ok("diagnostics 解释了旋钮规则", bool(dg.get("knob_rule")), str(dg.get("knob_rule"))[:50])

    # 无轮系的模型不该凭空造出装配组
    ok("没有轮系的模型不产生装配组", len(J.get("assemblies") or []) == 0,
       str(len(J.get("assemblies") or [])))

    # 聚类函数本身：造 6 个轮子，两侧各 3 个
    cl = ns["_cluster_assemblies"]
    fake = []
    for side, sx in (("L", -1.0), ("R", 1.0)):
        for i, y in enumerate((-1.0, 0.0, 1.0)):
            fake.append({"id": "RoadWheel_%s%03d" % (side, i),
                         "head": [sx * 1.4, y, 0.4],
                         "axis": [1, 0, 0], "drive_hint": "likely"})
            fake.append({"id": "Hub_%s%03d" % (side, i),
                         "head": [sx * 1.45, y, 0.44],
                         "axis": [1, 0, 0], "drive_hint": "likely"})
    gg = cl(fake)
    ok("聚类：6 个轮 + 6 个毂 -> 6 组（每轮带毂）", len(gg) == 6, str(len(gg)))
    ok("聚类：每组 2 件（轮+毂）", all(g["member_count"] == 2 for g in gg),
       str([g["member_count"] for g in gg]))
    ok("聚类：左右分开", len(set(g["side"] for g in gg)) == 2,
       str(set(g["side"] for g in gg)))
    ok("聚类：固定件不参与", len(cl(fake + [{"id": "Fender", "head": [0, 0, 1],
                                            "axis": [0, 0, 1],
                                            "drive_hint": "static"}])) == 6,
       "固定件被算进去了")

# ── 错误路径 ──
e1 = json.loads(d("export", {"armature": "不存在"}))
ok("导出不存在的骨架明确报错", e1.get("ok") is False and e1.get("error"))

# ── 只读性：导出不该改场景 ──
before = sorted([o.name for o in bpy.data.objects])
d("export", {"armature": "XRig"})
after = sorted([o.name for o in bpy.data.objects])
ok("导出是只读的（不新增/删除对象）", before == after,
   "%d -> %d" % (len(before), len(after)))

finish()
