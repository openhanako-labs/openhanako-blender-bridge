# motion_rig.py — 骨架与蒙皮（方案 C）
#
# 核心洞察：
#   “刚性绑定”和“蒙皮形变”不是两套系统，是**同一套系统的两个权重档**。
#   骨骼树、IK、导出全都一样，只差蒙皮权重是否允许跨骨骼渐变。
#
#   机械体：每个零件整体绑一根骨骼，权重恒为 1.0（权重退化）
#   有机体：顶点按距离分给多根骨骼，权重渐变（权重连续）
#
# 为什么不无脑用 Blender 的 ARMATURE_AUTO（自动权重）：
#   它是**热扩散**算法，假设网格连续、表面连通。
#   机械装配体是几十上百个互不相连的封闭零件——热扩散会在零件之间乱渗，
#   算出的权重看着“有值”，实际没有任何物理意义（钢板不会软）。
#   实测：在干净的测试件上它恰好算对了（Part_A→Bone_A 权重 8.0），
#   但那是因为零件间距规整；密集堆叠的虎式上不成立。
#   对刚性体，正确做法不是算法，而是**分配**。
#
# 三件事：
#   1. build   —— 从几何自动生成骨架（按包围盒切分，或用关节树）
#   2. bind    —— 绑定（rigid / skin 两档）
#   3. pose    —— IK 与姿态（可逆）

import bpy
import json
import math
import os
import re
import sys
from collections import Counter

RIG_VERSION = 1

_K = sys.modules.get("dsh_rt_kernel")


def _j(o):
    return json.dumps(o, ensure_ascii=False)


def _vec(*a):
    from mathutils import Vector
    return Vector(a)


def _objs(names, mesh_only=True):
    out = []
    for n in (names or []):
        ob = bpy.data.objects.get(str(n))
        if ob is None:
            continue
        if mesh_only and ob.type != "MESH":
            continue
        out.append(ob)
    return out


def _all_meshes():
    return [o for o in bpy.data.objects if o.type == "MESH"]


def _geo_center(ob):
    """物体的**几何**中心（世界坐标）。

    ！不能用 matrix_world.translation：生成器把几何烘焙进顶点，
      虎式 128 个对象的 location 全是 (0,0,0)。这个坑在方案 B 已经踩过一次。
    """
    mw = ob.matrix_world
    n = len(ob.data.vertices)
    if n == 0:
        return mw.translation.copy()
    acc = _vec(0.0, 0.0, 0.0)
    for v in ob.data.vertices:
        acc = acc + (mw @ v.co)
    return acc / n


def _world_bbox_range(objs):
    from mathutils import Vector
    pts = []
    for ob in objs:
        mw = ob.matrix_world
        for v in ob.data.vertices:
            pts.append(mw @ v.co)
    if not pts:
        return None
    lo = [min(p[i] for p in pts) for i in range(3)]
    hi = [max(p[i] for p in pts) for i in range(3)]
    return lo, hi


# ── 骨架构建 ────────────────────────────────────────────────

def _new_armature(name):
    ad = bpy.data.armatures.new(name)
    ob = bpy.data.objects.new(name, ad)
    bpy.context.collection.objects.link(ob)
    return ob


def _enter_edit(arm):
    bpy.context.view_layer.objects.active = arm
    if bpy.context.object and bpy.context.object.mode != "OBJECT":
        bpy.ops.object.mode_set(mode="OBJECT")
    bpy.ops.object.mode_set(mode="EDIT")


def _leave_edit():
    bpy.ops.object.mode_set(mode="OBJECT")


def _bone_hierarchy(arm, objs, link_threshold=None):
    """给“每个零件一根骨”的骨架建立父子关系。

    ！为何必需：刚绑完时每根骨骼都是孤立的。
      转炮塔骨，**炮管不会跟着转**（它绑的是自己的骨）。
      这不是 bug，是没有骨骼树——而真实机械有传动关系。

    ✓ 判定依据：零件 A 的包围盒被零件 B 包含 → A 是子，B 是父。
      不用名字猜（Gun_Barrel 不属于 Turret_Body，但几何上它坐在炮塔里）。
      同一层有多个候选父时，选**体积最小**的那个（最紧包含）。
    """
    from mathutils import Vector
    boxes = {}
    for ob in objs:
        mw = ob.matrix_world
        pts = [mw @ v.co for v in ob.data.vertices]
        if not pts:
            continue
        lo = Vector((min(p[i] for p in pts) for i in range(3)))
        hi = Vector((max(p[i] for p in pts) for i in range(3)))
        boxes[ob.name] = (lo, hi, (hi - lo).x * (hi - lo).y * (hi - lo).z)

    # 计算每个零件附属于谁
    #
    # ！不能用“整体包含”：炮管的中心在 (0, 2.92, 2.2)，
    #   而炮塔体只到 y=0.76——炮管是**伸出去**的，中心在塔体外面。
    #   按整体包含判定，炮管就永远不属炮塔，转炮塔时炮管会留在原地。
    #
    # ✓ 改用**部分重叠**：A 有顶点落在 B 的包围盒里，且 B 比 A 大，
    #   则 A 以 B 为父。炮管的尾端在塔体里（y 0.92～0.76 重叠），所以成立。
    parents = {}
    for a, (alo, ahi, avol) in boxes.items():
        cands = []
        for b, (blo, bhi, bvol) in boxes.items():
            if a == b:
                continue
            if bvol <= avol * 1.05:
                continue
            # 用 A 的包围盒与 B 的包围盒是否有交叠（按体积占比算重叠度）
            ov = 1.0
            for i in range(3):
                lo_i = max(alo[i], blo[i])
                hi_i = min(ahi[i], bhi[i])
                span = max(ahi[i] - alo[i], 1e-9)
                ov *= max(0.0, (hi_i - lo_i)) / span if hi_i > lo_i else 0.0
            # 只要有一点点交叠就当作附属（机械零件就是这样嵌套的）
            if ov > 0.0:
                cands.append((bvol, b))
            else:
                # 退让：A 的中心在 B 内也算（有些零件完全裹在内部）
                ac = [(alo[i] + ahi[i]) / 2.0 for i in range(3)]
                if all(blo[i] <= ac[i] <= bhi[i] for i in range(3)):
                    cands.append((bvol, b))
        if cands:
            # 有交叠：选体积最小的那个（最紧的容器）
            cands.sort()
            parents[a] = cands[0][1]
        else:
            # ！兜底：包围盒**间隙**最小的更大零件
            #   炮管从防盾前沿伸出，两段只是“刚好接上”（Gun_Barrel y=[0.92,4.92]，
            #   Gun_Mantlet y=[0.73,0.91]）——间隙 0.01。
            #
            # ！曾经用“中心距离”做兜底，结果炮管被接到了 SprocketTeeth_L（主动轮齿）上：
            #   主动轮贴在后部，与炮管中心的距离比防盾还短。中心距离完全不反映传动关系。
            #   间隙（gap）才是“相接”的直接证据。
            def gap_between(a1, a2, b1, b2):
                s = 0.0
                for i in range(3):
                    g = max(b1[i] - a2[i], a1[i] - b2[i], 0.0)
                    s += g * g
                return s ** 0.5

            best, bg = None, None
            for b, (blo, bhi, bvol) in boxes.items():
                if a == b or bvol <= avol * 1.05:
                    continue
                g = gap_between(alo, ahi, blo, bhi)
                # 门槛：间隙不能超过 A 自身最大跨度的 60%（否则不相干）
                diag = max(ahi[i] - alo[i] for i in range(3))
                if g <= max(diag * 0.6, 0.05) and (bg is None or g < bg):
                    bg, best = g, b
            if best is not None:
                parents[a] = best

    # 应用到骨骼（需要 EDIT 模式）
    _enter_edit(arm)
    try:
        eb = arm.data.edit_bones
        linked = 0
        for child_name, parent_name in parents.items():
            cb = eb.get(_safe_bone_name(child_name))
            pb = eb.get(_safe_bone_name(parent_name))
            if cb is None or pb is None:
                continue
            # 避免环：沿父链往上走，不能再回到自己
            ptr = pb
            cyc = False
            for _ in range(64):
                if ptr is None:
                    break
                if ptr.name == cb.name:
                    cyc = True
                    break
                ptr = ptr.parent
            if cyc:
                continue
            cb.parent = pb
            # 不 use_connect：机械零件靠位置绑定，连上会挪动骨头
            cb.use_connect = False
            linked += 1
    finally:
        _leave_edit()
    bpy.context.view_layer.update()
    return {"linked": linked, "candidates": len(parents),
            "roots": len([o for o in boxes if o not in parents])}


def build(name="DSH_Rig", mode="auto", parts=None, chains=None, keep_existing=False):
    """生成骨架。

    mode:
      · auto  —— 自动判定。零件数多且互不相连 → 按“连接分块”建骨
      · parts —— 每个零件一根骨骼（最细粒度，适合机械体）
      · chain —— 沿某个轴切成 N 段（适合连续网格，如管道、尾巴）
    """
    if not keep_existing:
        old = bpy.data.objects.get(name)
        if old is not None:
            bpy.data.objects.remove(old, do_unlink=True)

    objs = _objs(parts) if parts else _all_meshes()
    if not objs:
        return {"ok": False, "error": "没有可用的网格对象"}

    bb = _world_bbox_range(objs)
    if bb is None:
        return {"ok": False, "error": "网格没有顶点"}
    lo, hi = bb
    size = [hi[i] - lo[i] for i in range(3)]

    arm = _new_armature(name)
    _enter_edit(arm)
    eb = arm.data.edit_bones

    made = []
    try:
        if mode == "chain":
            n = int((chains or {}).get("segments", 4)) if isinstance(chains, dict) else 4
            n = max(2, min(n, 32))
            # 沿最大跨度轴切分
            ax = size.index(max(size))
            parent = None
            for i in range(n):
                t0 = i / n
                t1 = (i + 1) / n
                h = [lo[k] + size[k] * (t0 if k == ax else 0.5) for k in range(3)]
                t = [lo[k] + size[k] * (t1 if k == ax else 0.5) for k in range(3)]
                b = eb.new("Seg_%02d" % i)
                b.head = h
                b.tail = t
                if parent is not None:
                    b.parent = parent
                    b.use_connect = True
                parent = b
                made.append(b.name)
        else:
            # parts / auto：每个零件一根骨骼
            parent = None
            for i, ob in enumerate(objs):
                c = _geo_center(ob)
                blo, bhi = _world_bbox_range([ob])
                # 骨骼长度取该零件在某轴上的跨度，最短的轴当骨长轴更自然
                spans = [bhi[k] - blo[k] for k in range(3)]
                k_ax = spans.index(min(spans))  # 最扁的方向 = 骨骼朝向
                half = max(spans[k_ax] / 2.0, 0.02)
                h = [c[0], c[1], c[2] - half]
                t = [c[0], c[1], c[2] + half]
                h[k_ax] -= 0  # 保持
                b = eb.new(_safe_bone_name(ob.name))
                b.head = h
                b.tail = t
                # 父子关系稍后由 _bone_hierarchy 按几何包含判定（不靠名字猜）
                made.append(b.name)
    finally:
        _leave_edit()

    hier = {"linked": 0, "candidates": 0, "roots": 0}
    if mode in ("auto", "parts"):
        hier = _bone_hierarchy(arm, objs)

    bpy.context.view_layer.update()
    return {"ok": True, "armature": arm.name, "bones": len(made),
            "mode": mode, "names_preview": made[:10],
            "hierarchy": hier,
            "bbox_size": [round(v, 3) for v in size]}


def _safe_bone_name(s):
    n = re.sub(r"[^0-9A-Za-z_\-\u4e00-\u9fff]", "_", str(s))
    return n[:60] or "bone"


# ── 绑定 ────────────────────────────────────────────────────

def _match_bone(arm, ob):
    """给零件找对应的骨骼（按名字或最近几何中心）。"""
    nm = _safe_bone_name(ob.name)
    if nm in arm.data.bones:
        return arm.data.bones[nm]
    # 退化：找几何中心最近的骨骼中点
    c = _geo_center(ob)
    best, bd = None, None
    for b in arm.data.bones:
        mid = (b.head_local + b.tail_local) / 2.0
        # head_local 是 armature 空间；armature 通常在世界原点
        d = (mid - c).length
        if bd is None or d < bd:
            bd, best = d, b
    return best


def bind(armature, parts=None, mode="rigid", max_influences=4, replace=True):
    """把网格绑到骨架上。

    mode:
      · rigid —— 每个零件整体绑一根骨骼，权重恒 1.0。
                 正确的机械体做法：**不算法，只分配**。
      · skin  —— 每个顶点按到骨骼的距离衰减，最多 max_influences 根。
                 给连续曲面用。注意：这不是热扩散，是简化的距离权重，
                 对有机体够用，但对精细角色不如 Blender 的 ARMATURE_AUTO。
    """
    arm = bpy.data.objects.get(str(armature or ""))
    if arm is None or arm.type != "ARMATURE":
        return {"ok": False, "error": "找不到骨架：%s" % armature}
    if not arm.data.bones:
        return {"ok": False, "error": "骨架里没有骨骼"}

    objs = _objs(parts) if parts else _all_meshes()
    objs = [o for o in objs if o.type == "MESH"]
    if not objs:
        return {"ok": False, "error": "没有可绑定的网格"}

    report = []
    for ob in objs:
        if replace:
            for g in list(ob.vertex_groups):
                ob.vertex_groups.remove(g)

        if mode == "rigid":
            b = _match_bone(arm, ob)
            if b is None:
                report.append({"obj": ob.name, "ok": False, "error": "没有匹配的骨骼"})
                continue
            vg = ob.vertex_groups.get(b.name) or ob.vertex_groups.new(name=b.name)
            vg.add(list(range(len(ob.data.vertices))), 1.0, "REPLACE")
            report.append({"obj": ob.name, "ok": True, "bone": b.name,
                           "verts": len(ob.data.vertices), "weight": 1.0})
        else:
            # skin：距离衰减
            vgmap = {}
            for b in arm.data.bones:
                vgmap[b.name] = ob.vertex_groups.get(b.name) or ob.vertex_groups.new(name=b.name)
            bones = list(arm.data.bones)
            mw = ob.matrix_world
            for v in ob.data.vertices:
                w = mw @ v.co
                dists = []
                for b in bones:
                    mid = (b.head_local + b.tail_local) / 2.0
                    dists.append(((mid - w).length, b.name))
                dists.sort()
                pick = dists[:max(1, int(max_influences))]
                inv = [(1.0 / max(d, 1e-4), nm) for d, nm in pick]
                tot = sum(x for x, _ in inv) or 1.0
                for val, nm in inv:
                    vgmap[nm].add([v.index], val / tot, "REPLACE")
            report.append({"obj": ob.name, "ok": True, "bones": min(len(bones), max_influences),
                           "verts": len(ob.data.vertices)})

        # 加骨架修改器
        has = any(m.type == "ARMATURE" and m.object == arm for m in ob.modifiers)
        if not has:
            m = ob.modifiers.new(name="DSH_Armature", type="ARMATURE")
            m.object = arm
        # 父级指到骨架（只设父级，不移动）
        if ob.parent != arm:
            mw_save = ob.matrix_world.copy()
            ob.parent = arm
            ob.matrix_parent_inverse = arm.matrix_world.inverted()
            ob.matrix_world = mw_save

    bpy.context.view_layer.update()
    ok_n = sum(1 for r in report if r.get("ok"))
    return {"ok": ok_n > 0, "armature": arm.name, "mode": mode,
            "bound": ok_n, "failed": len(report) - ok_n,
            "objects": report[:12], "total_objects": len(report)}


# ── 姿态 / IK ───────────────────────────────────────────────

def _snap_pose(arm):
    return {b.name: ([float(x) for x in b.rotation_quaternion],
                     [float(x) for x in b.location],
                     b.rotation_mode) for b in arm.pose.bones}


def _restore_pose(arm, snap):
    for name, (q, loc, mode) in snap.items():
        pb = arm.pose.bones.get(name)
        if pb is None:
            continue
        pb.rotation_mode = mode
        pb.rotation_quaternion = q
        pb.location = loc
    bpy.context.view_layer.update()


def pose(armature, bone, degrees, axis="X", pose_keep=False):
    """单独转一根骨骼。默认转完还原。

    ！为何要单独一个 minimal 版本：验证骨架绑定是否真的生效，
      最直接的办法就是转一根骨头看零件动不动。
      如果零件不动，说明权重没写上（绑定失败），
      如果零件乱飞，说明权重分错了。
    """
    arm = bpy.data.objects.get(str(armature or ""))
    if arm is None or arm.type != "ARMATURE":
        return {"ok": False, "error": "找不到骨架：%s" % armature}
    pb = arm.pose.bones.get(str(bone or ""))
    if pb is None:
        return {"ok": False, "error": "骨架里没有这根骨：%s" % bone}

    from mathutils import Vector
    ax = {"X": Vector((1, 0, 0)), "Y": Vector((0, 1, 0)),
          "Z": Vector((0, 0, 1))}.get(str(axis).upper())
    if ax is None:
        try:
            ax = Vector(axis).normalized()
        except Exception:
            return {"ok": False, "error": "轴不合法：%s" % axis}

    snap = _snap_pose(arm)
    deps = bpy.context.evaluated_depsgraph_get()

    def sample_positions():
        """采样每个网格的**顶点平均朝向**与位置，能反映纯旋转。

        ！为何不能只看中心点位移：骨骼绕自己的头部转，
          而绑在这根骨上的零件往往**就在它的轴线上**——
          转了 40°，中心点纹丝不动，但零件确实转了。
          实测：转塔骨时塔自己的中心没动，却真的转了。
          所以看顶点的位移，不看中心。
        """
        out = {}
        for ob in bpy.data.objects:
            if ob.type != "MESH":
                continue
            if not any(m.type == "ARMATURE" and m.object == arm for m in ob.modifiers):
                continue
            ev = ob.evaluated_get(deps)
            me = ev.to_mesh()
            if len(me.vertices):
                # 取包围盒对角线当“形状指纹”，纯旋转不会改变它；
                # 真正判断“动了”要看顶点坐标是否变
                coords = tuple(tuple(round(c, 6) for c in (ev.matrix_world @ v.co))
                               for v in me.vertices[:24])
                out[ob.name] = coords
            ev.to_mesh_clear()
        return out

    before = sample_positions()

    rad = math.radians(float(degrees))
    pb.rotation_mode = "QUATERNION"
    from mathutils import Quaternion

    # ！致命细节：pose bone 的 rotation_quaternion 是**骨骼本地空间**的旋转，
    #   不是世界轴。直接 Quaternion(世界Z, rad) 会沿着骨骼自己的朝转——
    #   而骨骼是“从零件底部指到顶部”，那个方向往往不是世界 Z。
    #   实测：绕 Z 转后炮管 z 从 1.3000 掉到 1.1362，高度变了。绕 Z 不该动高度。
    #
    # ✓ 正确做法：把世界轴变换到骨骼的本地坐标系。
    #   pose bone 的旋转发生在它的 rest 矩阵空间里，所以：
    #       axis_local = (arm.matrix_world @ pb.bone.matrix_local).inverted().to_3x3() @ axis_world
    #   注意用 bone.matrix_local（rest），不是 pose 状态下的。
    base_mat = arm.matrix_world @ pb.bone.matrix_local
    ax_local = (base_mat.to_3x3().inverted() @ ax).normalized()

    pb.rotation_quaternion = Quaternion(ax_local, rad)
    bpy.context.view_layer.update()

    deps = bpy.context.evaluated_depsgraph_get()
    after = sample_positions()

    moved = {k: (before[k], after[k]) for k in before
             if k in after and before[k] != after[k]}

    def _maxdisp(a, b):
        if not a or not b:
            return 0.0
        m = 0.0
        for p, q in zip(a, b):
            m = max(m, sum((p[i] - q[i]) ** 2 for i in range(3)) ** 0.5)
        return m

    total = max((_maxdisp(before[k], after[k]) for k in before if k in after),
                default=0.0)

    out = {"ok": True, "armature": arm.name, "bone": pb.name,
           "degrees": float(degrees), "axis": [round(x, 4) for x in ax],
           "meshes_checked": len(before), "meshes_moved": len(moved),
           "max_displacement": round(total, 5),
           "moved_preview": list(moved.keys())[:8]}

    if not pose_keep:
        _restore_pose(arm, snap)
        out["restored"] = True
    else:
        out["restored"] = False
    return out


def _dist3(a, b):
    return sum((a[i] - b[i]) ** 2 for i in range(3)) ** 0.5


def ik(armature, bone, target=None, chain_length=2):
    """给一根骨骼加 IK 约束。

    target 不给时，在骨尾位置放一个空物体当目标（可直接拖动）。
    """
    arm = bpy.data.objects.get(str(armature or ""))
    if arm is None or arm.type != "ARMATURE":
        return {"ok": False, "error": "找不到骨架：%s" % armature}
    pb = arm.pose.bones.get(str(bone or ""))
    if pb is None:
        return {"ok": False, "error": "骨架里没有这根骨：%s" % bone}

    tgt = None
    if target:
        tgt = bpy.data.objects.get(str(target))
    if tgt is None:
        tgt_name = "DSH_IK_%s" % pb.name
        tgt = bpy.data.objects.get(tgt_name)
        if tgt is None:
            tgt = bpy.data.objects.new(tgt_name, None)
            bpy.context.collection.objects.link(tgt)
            tgt.empty_display_type = "SPHERE"
            tgt.empty_display_size = 0.15
        # 放到骨尾的世界位置
        tgt.location = arm.matrix_world @ pb.tail

    for c in list(pb.constraints):
        if c.type == "IK":
            pb.constraints.remove(c)
    con = pb.constraints.new("IK")
    con.target = tgt
    con.chain_count = max(1, int(chain_length))
    bpy.context.view_layer.update()

    return {"ok": True, "armature": arm.name, "bone": pb.name,
            "target": tgt.name, "chain_count": con.chain_count,
            "note": "拖动 %s 就能驱动；约束是可见的，随时能删" % tgt.name}


def _bone_children_map(arm):
    m = {}
    for b in arm.data.bones:
        m[b.name] = []
    for b in arm.data.bones:
        if b.parent is not None:
            m.setdefault(b.parent.name, []).append(b.name)
    return m


def _infer_axis(spans, parent_axis=None):
    """从包围盒三边推算转速轴。

    ！为什么不能一律取最短轴：
      炮塔 2.30×2.29×0.94（盘状）-> 最短轴 Z，对。
      炮管 0.20×4.00×0.18（杆状）-> 最短轴是 Z，但圆柱绕自己长轴转只是自转，
        真车的炮管是**摆动**的，轴应垂直于杆。

    规则：
      · 盘状（最短/中间 < 0.62） -> 最扁那轴
      · 杆状（最长/中间 > 2.0） -> 垂直于杆的两轴里，与父轴不同的那个
      · 其他 -> 最扁那轴
    返回 (axis_index, shape, confidence)
    """
    s = list(spans)
    order = sorted(range(3), key=lambda i: s[i])
    short_i, mid_i, long_i = order[0], order[1], order[2]
    eps = 1e-9
    if s[mid_i] <= eps:
        return 0, "degenerate", 0.2
    ratio_sm = s[short_i] / s[mid_i]
    ratio_lm = s[long_i] / max(s[mid_i], eps)

    if ratio_sm < 0.62:
        # 盘状：绕最扁的轴
        return short_i, "disc", round(min(0.95, 0.55 + (0.62 - ratio_sm)), 3)
    if ratio_lm > 2.0:
        # 杆状：找垂直于杆的两轴中，与父轴不同的那个
        perp = [i for i in range(3) if i != long_i]
        if parent_axis is not None and parent_axis in perp:
            cand = [i for i in perp if i != parent_axis]
            if cand:
                return max(cand, key=lambda i: s[i]), "rod", 0.55
        return max(perp, key=lambda i: s[i]), "rod", 0.45
    return short_i, "block", 0.4


def _track_info(name):
    """算一条履带的周长与链板数（不改场景）。

    ！这里重写了一份最小的分量+路径分析，而不是去 import motion_wheel：
      模块之间互相依赖会让装载顺序变成坑（wheel 依赖 drive 的 kernel 注册）。
      这段只读顶点坐标，20 行就够。
    """
    ob = bpy.data.objects.get(str(name or ""))
    if ob is None or ob.type != "MESH":
        return None
    me = ob.data
    if len(me.vertices) < 12:
        return None
    import bmesh
    bm = bmesh.new(); bm.from_mesh(me); bm.verts.ensure_lookup_table()
    seen = set(); comps = []
    for v in bm.verts:
        if v.index in seen:
            continue
        stack = [v]; comp = []
        while stack:
            cur = stack.pop()
            if cur.index in seen:
                continue
            seen.add(cur.index); comp.append(cur.index)
            for e in cur.link_edges:
                o = e.other_vert(cur)
                if o.index not in seen:
                    stack.append(o)
        comps.append(comp)
    bm.free()

    mw = ob.matrix_world
    centers = []
    for g in comps:
        acc = _vec(0.0, 0.0, 0.0)
        for i in g:
            acc = acc + me.vertices[i].co
        centers.append(mw @ (acc / len(g)))
    n = len(centers)
    if n < 4:
        return None

    # 最近邻环
    used = [False] * n; order = [0]; used[0] = True
    for _ in range(n - 1):
        cur = order[-1]; best, bd = -1, None
        for i in range(n):
            if used[i]:
                continue
            d = (centers[i] - centers[cur]).length
            if bd is None or d < bd:
                bd, best = d, i
        if best < 0:
            break
        order.append(best); used[best] = True

    ring = [centers[i] for i in order]
    per = sum((ring[i] - ring[i - 1]).length for i in range(1, len(ring)))
    per += (ring[0] - ring[-1]).length
    return {"name": ob.name, "links": n, "perimeter": round(per, 4),
            "link_verts": int(len(me.vertices) / n) if n else 0,
            "center": [round(c, 4) for c in
                       (sum(ring, _vec(0.0, 0.0, 0.0)) / len(ring))]}


def export(armature="DSH_Rig", out=None, tracks=None, include_all=True):
    """导出一份**给外部消费的结构描述**（不是网格，是骨架）。

    为什么需要它：rig build/bind 建的骨骼树只在 Blender 里。
      卡片、外部工具、文档全都要一份能读的机器可读快照。
      导出它是**只读**操作，不改场景。

    输出设计取舍：
      · 存骨架和转轴（几 KB），不存三角面（MB）
      · 每个关节带 pivot / axis / axis_source，手动改过的能看出来
      · 带 bbox，卡片能直接定相机
    """
    arm = bpy.data.objects.get(str(armature or ""))
    if arm is None or arm.type != "ARMATURE":
        return {"ok": False, "error": "找不到骨架：%s" % armature}
    if not arm.data.bones:
        return {"ok": False, "error": "骨架里没有骨骼"}

    objs = _all_meshes()
    bb = _world_bbox_range(objs)
    if bb is None:
        return {"ok": False, "error": "场景里没有网格顶点"}
    lo, hi = bb

    # 每个网格的包围盒（按骨骼名索引）
    boxes = {}
    for ob in objs:
        mw = ob.matrix_world
        pts = [mw @ v.co for v in ob.data.vertices]
        if not pts:
            continue
        bl = [min(p[i] for p in pts) for i in range(3)]
        bh = [max(p[i] for p in pts) for i in range(3)]
        boxes[_safe_bone_name(ob.name)] = {
            "min": [round(v, 4) for v in bl],
            "max": [round(v, 4) for v in bh],
            "size": [round(bh[i] - bl[i], 4) for i in range(3)],
            "obj": ob.name,
        }

    kids = _bone_children_map(arm)
    joints = []
    axis_hist = {"disc": 0, "rod": 0, "block": 0, "degenerate": 0}
    diff_with_parent = []
    skipped = {"tracks": [], "root": []}

    for b in arm.data.bones:
        nm = _safe_bone_name(b.name)
        bx = boxes.get(nm)
        head_w = arm.matrix_world @ b.head_local
        tail_w = arm.matrix_world @ b.tail_local

        # ！履带不进 joints：它是平移的，不是转的。单独进 tracks。
        if bx and _is_track_like(bx["obj"], bx["size"]):
            skipped["tracks"].append(nm)
            continue

        parent_axis = None
        if b.parent is not None:
            pb = boxes.get(_safe_bone_name(b.parent.name))
            # ！父骨是根骨（fixed）时，**不要**拿它的轴去传给子骨：
            #   根骨不转，它的“轴”只是尺寸推断的副产物，没有约束意义。
            #   真机踩过：Hull_Upper 被算成盘状 Z，于是 Turret_Body 也被标为“与父同轴”。
            if pb and b.parent.parent is not None:
                pax, _, _ = _infer_axis(pb["size"], None)
                parent_axis = pax

        if bx:
            ax_i, shape, conf = _infer_axis(bx["size"], parent_axis)
            axis_hist[shape] = axis_hist.get(shape, 0) + 1
        else:
            ax_i, shape, conf = None, "unknown", 0.0

        # ！不再拿“轴向量相同”当警告（真机踩过）：
        #   66 个同轴里绝大多数是**对的**：轮毂与轮子本来就同轴、
        #   排气管与车体板缝都“扁”但都不该转。拿轴相同报警，
        #   等于把正常结构当成缺陷报，噪声会把真问题埋掉。
        #
        # 真正值得警告的是：**子骨的包围盒比父骨还大**——
        #   那意味着几何包含关系搞反了（子骨吞了父骨），骨骼树是错的。
        if bx and b.parent is not None:
            pb = boxes.get(_safe_bone_name(b.parent.name))
            if pb:
                vc = 1.0
                vp = 1.0
                for i in range(3):
                    vc *= max(bx["size"][i], 1e-6)
                    vp *= max(pb["size"][i], 1e-6)
                if vc > vp * 1.35:
                    diff_with_parent.append({"child": nm, "parent": pb["obj"],
                                             "vol_ratio": round(vc / vp, 2)})

        is_root = b.parent is None
        if is_root:
            skipped["root"].append(nm)

        # ！关键判断：“能转”不等于“该转”。
        #   真实虎式上，翼子板、排气管、工具箱、备用履带板都是焊死的。
        #   但几何看不出设计意图：改装件的翼子板可能真是铰接的。
        #
        #   ✓ 不替用户决定，给**置信度 + 推荐**，让下游能筛：
        #     drive_hint = "likely"   —— 形状和名字都像能动的（炮塔、炮管、轮子、舱盖）
        #     drive_hint = "maybe"    —— 形状像，但名字像结构件
        #     drive_hint = "static"   —— 名字强烈暗示是固定件
        STATIC_WORDS = ("seam", "fender", "stowage", "spare", "tools",
                        "exhaust", "visor", "plate", "armor", "mount", "bracket")
        MOVING_WORDS = ("turret", "gun", "barrel", "wheel", "hub", "sprocket",
                        "idler", "hatch", "cupola", "mantlet", "muzzle",
                        "periscope", "loader", "coax")
        low = nm.lower()
        if any(w in low for w in STATIC_WORDS):
            drive_hint = "static"
        elif any(w in low for w in MOVING_WORDS):
            drive_hint = "likely"
        else:
            drive_hint = "maybe"

        rec = {
            "id": nm,
            "parent": _safe_bone_name(b.parent.name) if b.parent else None,
            "children": [_safe_bone_name(c) for c in kids.get(b.name, [])][:24],
            "head": [round(v, 4) for v in head_w],
            "tail": [round(v, 4) for v in tail_w],
            "pivot": [round(v, 4) for v in head_w],
            "drive_hint": drive_hint,
        }
        # ！根骨永远固定：车体不会自己转。
        #   否则尺寸推断会把它算成“扁盘绕 Z”，看着像可以转，卡片就会给它一个旋钮。
        if is_root:
            rec["kind"] = "fixed"
            rec["drive_hint"] = "static"
        else:
            rec["kind"] = "revolute"
            if ax_i is not None:
                ax = [0, 0, 0]; ax[ax_i] = 1
                rec["axis"] = ax
                rec["axis_source"] = "inferred"
                rec["axis_conf"] = conf
                rec["shape"] = shape
        if bx:
            rec["bbox"] = {"min": bx["min"], "max": bx["max"]}
            rec["radius"] = round(max(
                max(abs(bx["max"][0] - head_w[0]), abs(bx["min"][0] - head_w[0])),
                max(abs(bx["max"][1] - head_w[1]), abs(bx["min"][1] - head_w[1])),
            ), 4)
        joints.append(rec)

    # 履带（只算名字像履带的；不传则自己找）
    tnames = tracks or [o.name for o in objs
                        if re.search(r"track|belt|履带|chain", o.name, re.I)
                        and not re.search(r"spare", o.name, re.I)]
    trk = []
    for t in tnames:
        info = _track_info(t)
        if info:
            trk.append(info)

    # ── 装配层：把轮系聚成悬挂组 ──
    # ！不把零件从 joints 里删掉：下游可能还需要逐个零件的 bbox。
    #   而是**另给一层** assemblies，并标出哪些关节被吸收了。
    assemblies = _cluster_assemblies(joints)
    absorbed = set()
    for g in assemblies:
        for m in g["members"]:
            absorbed.add(m)
    for j in joints:
        if j["id"] in absorbed:
            j["in_assembly"] = True

    # ── 真正的“顶层旋钮” ──
    # ！之前算错过：把“不在装配组且非固定”当顶层，得到 13 个，
    #   但其中 Turret_Roof / Cupola / LoaderHatch / Turret_SideHatch 都是
    #   炮塔的子件——转炮塔时它们已经跟着动了，**不该再有自己的旋钮**。
    #
    # ✓ 顶层 = 自己能转，**且父骨不转**（父骨固定或在装配组里）。
    #
    # ！只收 drive_hint == "likely"：否则 Hull_Lower / Headlamp / HullMG
    #   这些 maybe 会浮上来（它们挂在根骨下，父骨不转）。说不准的东西不该给旋钮。
    #
    # ！关键例外：**轴与父骨不同**时，即使父骨能转，子骨仍需独立旋钮。
    #   炮管挂在炮塔下，炮塔是 likely，但炮管是 X、炮塔是 Z——
    #   炮塔转方向、炮管调俯仰，两个自由度。
    #   反过来 Turret_Roof / Cupola / LoaderHatch 都与炮塔同轴（Z），
    #   转炮塔时它们跟着走，不需要自己的旋钮。
    by_id = {j["id"]: j for j in joints}
    knobs = []
    for j in joints:
        if j.get("drive_hint") != "likely":
            continue
        if j.get("in_assembly"):
            continue
        par = j.get("parent")
        pj = by_id.get(par) if par else None
        parent_moves = bool(pj and pj.get("drive_hint") == "likely"
                            and not pj.get("in_assembly"))
        if not parent_moves:
            knobs.append(j["id"])
            continue
        # 父骨能转：只有在“自由度不同”时才给独立旋钮
        if j.get("axis") and pj.get("axis") and j["axis"] != pj["axis"]:
            knobs.append(j["id"])

    payload = {
        "version": "1.2",
        "units": "m",
        "model": {"armature": arm.name,
                  "bones": len(arm.data.bones),
                  "meshes": len(objs)},
        "bbox": {"min": [round(v, 4) for v in lo],
                 "max": [round(v, 4) for v in hi],
                 "size": [round(hi[i] - lo[i], 4) for i in range(3)]},
        "joints": joints,
        "assemblies": assemblies,
        "tracks": trk,
        "drive_hint_legend": {
            "likely": "名字和形状都像能动（炮塔/炮管/轮/舱盖）",
            "maybe": "形状像能转，但名字不明确",
            "static": "名字强烈暗示是固定件（翼子板/排气管/备用件/板缝）",
            "note": "这是**建议**不是事实。几何看不出设计意图，请人工确认。",
        },
        "diagnostics": {
            "axis_shapes": axis_hist,
            "child_bigger_than_parent": diff_with_parent[:20],
            "child_bigger_count": len(diff_with_parent),
            "skipped_tracks": skipped["tracks"][:12],
            "skipped_tracks_count": len(skipped["tracks"]),
            "root_bones": skipped["root"],
            "drive_hints": dict(Counter(j.get("drive_hint") for j in joints)),
            "assemblies_count": len(assemblies),
            "absorbed_joints": len(absorbed),
            "knobs": knobs[:24],
            "knobs_count": len(knobs),
            "knob_rule": "自己能转且父骨不转（父骨固定或在装配组里）",
            "note": "几何快照：导出的尺寸/周长是**当前场景状态**，不是原始建模状态",
        },
    }

    # 写文件
    wrote = None
    if out:
        try:
            p = str(out)
            d = os.path.dirname(p)
            if d and not os.path.isdir(d):
                os.makedirs(d, exist_ok=True)
            with open(p, "w", encoding="utf-8") as f:
                json.dump(payload, f, ensure_ascii=False, indent=1)
            wrote = p
        except Exception as e:
            payload["diagnostics"]["write_error"] = "%s: %s" % (type(e).__name__, e)

    payload["ok"] = True
    payload["path"] = wrote
    # 不把整个 joints 塞进工具回执（128 根会刷屏）
    payload["joints_preview"] = joints[:6]
    payload["joints_count"] = len(joints)
    payload.pop("joints", None)
    # 装配组列表也可能很长（左8右8），回执只给前 8 个，完整看文件
    if isinstance(payload.get("assemblies"), list):
        payload["assemblies_preview"] = payload["assemblies"][:8]
        payload.pop("assemblies", None)
    return payload


def _is_track_like(name, size=None):
    """这个网格该不该当作**履带**（不是绕轴转的关节）。

    ！为何必须分开处理：履带不转，它沿环路径**平移**。
      按尺寸算它会变成“长杆”或“扁盘”，然后被当成关节导出——
      卡片拿到的就是“一条绕 Z 旋转的履带”，荒谬且难看。

    ！为何**不能**单靠几何判据（真机踩过）：
      车体 3.56×6.32×0.80 也满足“极长且扁平”，
      于是 Hull_Upper / Hull_Lower / Fender 全被剔出 joints，
      128 根骨只导出 10 个关节。

    ✓ 正确做法：名字优先。几何只在**名字已候选**时做二次确认。
      名字不像履带的，不管多长多扁，都不当履带。
    """
    n = str(name or "")
    name_hit = bool(re.search(r"track|belt|履带|chain", n, re.I)) and \
               not re.search(r"spare", n, re.I)
    if not name_hit:
        return False
    # 名字命中后，几何做二次确认：真正的履带是长而扁的环
    if size:
        s = sorted(size)
        if s[0] > 1e-6 and s[2] / s[0] < 2.0:
            # 三维都很接近（正方体/球），不像履带
            return False
    return True


def _cluster_assemblies(joints, y_tol=0.35):
    """把轮系零件聚成**装配单元**（悬挂组），而不是 96 个独立关节。

    为何必需：虎式有 48 个负重轮 + 48 个轮毂 + 4 个主动轮 + 2 个诱导轮。
      每个都当独立关节，下游拿到 102 个旋钮，而真车只有 7 组悬挂。
      **机械运动发生在装配层，不是零件层。**

    判据（全用几何，不靠名字）：
      ① 同侧（head.x 同号）
      ② 同轴（axis 相同）
      ③ head.y 相近（≤ y_tol）

    为何用 y 而不聚类三维距离：轮毂紧贴轮子（x 差 0.04），
      而相邻悬挂组 y 差 0.743——按 y 切分能干净地把“同一根轴上的轮”归组。

    ！限制：y_tol 是固定值。轮距更小的模型会把相邻组并到一起，
      轮距更大的会把一组拆开。回执里会把实际分组数报出来供人核对。
    """
    WHEEL_WORDS = ("wheel", "hub", "sprocket", "idler", "roller")
    wl = []
    for j in joints:
        n = str(j.get("id") or "").lower()
        if j.get("drive_hint") == "static":
            continue
        if any(w in n for w in WHEEL_WORDS) and isinstance(j.get("head"), list):
            wl.append(j)
    if not wl:
        return []

    buckets = {}
    for j in wl:
        h = j["head"]
        side = "L" if h[0] < 0 else "R"
        ax = tuple(j.get("axis") or (0, 0, 0))
        key = (side, ax)
        buckets.setdefault(key, []).append(j)

    groups = []
    for (side, ax), items in buckets.items():
        items.sort(key=lambda x: x["head"][1])
        cur = [items[0]]
        for j in items[1:]:
            if abs(j["head"][1] - cur[-1]["head"][1]) <= y_tol:
                cur.append(j)
            else:
                groups.append((side, ax, cur))
                cur = [j]
        groups.append((side, ax, cur))

    out = []
    for side, ax, members in groups:
        ys = [m["head"][1] for m in members]
        xs = [m["head"][0] for m in members]
        zs = [m["head"][2] for m in members]
        # 取成员的“主件”作为代表名：优先非 Hub
        # ！一组里可能既有负重轮又有主动轮（虎式的主动轮紧贴最后一组），
        #   只用第一个成员命名会把 Sprocket 那组叫成 RoadWheel，误导人。
        mains = [m["id"] for m in members if "hub" not in m["id"].lower()]
        tag = "grp"
        if mains:
            # 看组里有没有更“特殊”的件（主动轮/诱导轮）
            special = [x for x in mains
                       if any(w in x.lower() for w in ("sprocket", "idler"))]
            tag = special[0] if special else mains[0]
            if len(mains) > 1:
                tag = "%s+%d" % (tag, len(mains) - 1)
        out.append({
            "id": "Susp_%s_%s" % (side, tag),
            "kind": "wheel_group",
            "side": side,
            "axis": list(ax),
            "pivot": [round(sum(xs) / len(xs), 4),
                      round(sum(ys) / len(ys), 4),
                      round(sum(zs) / len(zs), 4)],
            "y_span": [round(min(ys), 4), round(max(ys), 4)],
            "members": [m["id"] for m in members],
            "member_count": len(members),
            "has_sprocket": any("sprocket" in m["id"].lower() for m in members),
            "has_idler": any("idler" in m["id"].lower() for m in members),
            "drive_hint": "likely",
        })
    out.sort(key=lambda g: (g["side"], g["pivot"][1]))
    return out


def status():
    rows = []
    for arm in bpy.data.objects:
        if arm.type != "ARMATURE":
            continue
        bound = 0
        for ob in bpy.data.objects:
            if ob.type == "MESH" and any(
                    m.type == "ARMATURE" and m.object == arm for m in ob.modifiers):
                bound += 1
        iks = sum(1 for pb in arm.pose.bones for c in pb.constraints if c.type == "IK")
        rows.append({"armature": arm.name, "bones": len(arm.data.bones),
                     "bound_meshes": bound, "ik_constraints": iks})
    meshes = _all_meshes()
    return {"ok": True, "version": RIG_VERSION, "armatures": rows,
            "armature_count": len(rows),
            "mesh_count": len(meshes),
            "note": "bound_meshes 是挂了骨架修改器的网格数；0 表示没绑上"}


def dispatch(op, args=None):
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

    def lst(k):
        v = a.get(k)
        if v is None:
            return []
        return [v] if isinstance(v, str) else [str(x) for x in v]

    try:
        if op == "status":
            return _j(status())
        if op == "build":
            return _j(build(name=str(a.get("name") or "DSH_Rig"),
                            mode=str(a.get("mode") or "auto"),
                            parts=lst("parts"), chains=a.get("chains")))
        if op == "bind":
            return _j(bind(str(a.get("armature") or "DSH_Rig"),
                           parts=lst("parts"),
                           mode=str(a.get("bind_mode") or a.get("mode") or "rigid"),
                           max_influences=int(num("max_influences", 4))))
        if op == "pose":
            return _j(pose(str(a.get("armature") or "DSH_Rig"),
                           str(a.get("bone") or ""), num("degrees", 20.0),
                           axis=a.get("axis") or "X",
                           pose_keep=bool(a.get("pose"))))
        if op == "ik":
            return _j(ik(str(a.get("armature") or "DSH_Rig"),
                         str(a.get("bone") or ""), target=a.get("target"),
                         chain_length=int(num("chain_length", 2))))
        if op == "export":
            # ！只认 out，不要留别名后备（注释里也别写出 a-get 调用形式：
            #   参数链测试是正则扫描的，它分不清代码和注释，会把注释里的
            #   键当成一个永远从工具面传不进来的参数，然后误报“漏了”。
            return _j(export(str(a.get("armature") or "DSH_Rig"),
                             out=a.get("out"),
                             tracks=lst("tracks") or None))
        return _j({"ok": False, "error": "unknown rig op: %s" % op,
                   "ops": ["status", "build", "bind", "pose", "ik", "export"]})
    except Exception as e:
        import traceback
        return _j({"ok": False, "error": "%s: %s" % (type(e).__name__, str(e)[:300]),
                   "traceback": traceback.format_exc()[-800:]})


if _K is not None:
    _K.dsh_rig_api = {"version": RIG_VERSION, "dispatch": dispatch}
