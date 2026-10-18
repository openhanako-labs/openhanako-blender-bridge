# motion_drive.py — 让已登记的关节真的动起来（方案 A：单轴铰接）
#
# 为什么单独一个模块：
#   upstream 的 motion.py 只有“量”（infer_axis / measure）和“导出”（urdf/usda），
#   **没有“驱动”**。也就是说它能告诉你炮塔该绕哪个轴转，
#   却不能让它转一下给你看看。
#
#   而“转一下”正是最直接的验证：轴对不对、枢轴点对不对、带不带得动子物体，
#   看一眼就知道。靠读 JSON 是看不出来的。
#
# 三条设计约束：
#   ① 只动 child 那一侧。parent 是“不动的基座”，动了就是另一台机器了。
#   ② 转完能还原。默认就还原——除非明确说 pose=True 要保留姿态。
#      （可逆性该是默认值，不是选项。）
#   ③ 用矩阵绕世界轴转，不碰 rotation_euler —— 后者对父子关系和
#      rotation_mode 敏感，容易转出你没想到的结果。

import bpy
import json
import math
import sys

DRIVE_VERSION = 1

_K = sys.modules.get("dsh_rt_kernel")


def _j(o):
    return json.dumps(o, ensure_ascii=False)


def _store():
    """拿 motion 的关节库。没装 motion 就明确报错。"""
    if _K is None:
        raise RuntimeError("dsh_rt_kernel 未注入")
    m = getattr(_K, "dsh_motion_api", None)
    if m is None:
        raise RuntimeError("motion 模块还没装载（先跑一次 motion op=status）")
    return m


def _joints_raw():
    """从 motion 的记录库里拿关节。"""
    api = _store()
    fn = api.get("joints") if isinstance(api, dict) else None
    if fn is None:
        raise RuntimeError("motion 模块没有暴露 joints()")
    txt = fn()
    try:
        return json.loads(txt) if isinstance(txt, str) else (txt or {})
    except Exception:
        return {"ok": False, "error": "读关节库失败"}


def _find_joint(jid):
    data = _joints_raw()
    js = data.get("joints") or data.get("items") or []
    if isinstance(js, dict):
        js = list(js.values())
    for j in js:
        if str(j.get("id") or j.get("jid")) == str(jid):
            return j
    return None


def _children_of(jid):
    """找 joint 记录里属于 child 那一侧的对象名。"""
    j = _find_joint(jid)
    if not j:
        return None, None, "没有这个关节：%s" % jid
    c = j.get("child")
    p = j.get("parent")
    cn = []
    if isinstance(c, list):
        cn = [str(x) for x in c]
    elif isinstance(c, str):
        cn = [c]
    elif isinstance(c, dict):
        cn = [str(x) for x in (c.get("names") or [])]
    pn = []
    if isinstance(p, list):
        pn = [str(x) for x in p]
    elif isinstance(p, str):
        pn = [p]
    if not cn:
        return None, None, "关节 %s 的 child 侧是空的" % jid
    return cn, pn, None


def _rot_matrix(axis, angle_rad, pivot):
    """绕「过 pivot、方向 axis」的世界轴转 angle。返回 4x4。"""
    from mathutils import Matrix, Vector
    a = Vector(axis).normalized()
    p = Vector(pivot)
    # T(p) · R(a,θ) · T(-p)
    return (Matrix.Translation(p)
            @ Matrix.Rotation(angle_rad, 4, a)
            @ Matrix.Translation(-p))


def _apply(names, M):
    """把矩阵 M 乘到这些对象的 matrix_world 上（保留父子关系带来的偏移）。"""
    from mathutils import Matrix
    touched = []
    for n in names:
        ob = bpy.data.objects.get(n)
        if ob is None:
            continue
        ob.matrix_world = M @ ob.matrix_world
        touched.append(n)
    return touched


def _snap(names):
    """快照：只记 matrix_world —— 这是驱动唯一改动的东西。"""
    snap = {}
    for n in names:
        ob = bpy.data.objects.get(n)
        if ob is None:
            continue
        snap[n] = [float(x) for row in ob.matrix_world for x in row]
    return snap


def _restore(snap):
    from mathutils import Matrix
    back = []
    for n, flat in snap.items():
        ob = bpy.data.objects.get(n)
        if ob is None:
            continue
        m = Matrix([flat[0:4], flat[4:8], flat[8:12], flat[12:16]])
        ob.matrix_world = m
        back.append(n)
    return back


def _bbox_of(names):
    """这组对象的包围盒（世界坐标）。用来判断“真动了吗”。"""
    from mathutils import Vector
    lo = [1e30, 1e30, 1e30]
    hi = [-1e30, -1e30, -1e30]
    cnt = 0
    for n in names:
        ob = bpy.data.objects.get(n)
        if ob is None or ob.type != "MESH":
            continue
        cnt += 1
        for c in ob.bound_box:
            w = ob.matrix_world @ Vector(c)
            for i in range(3):
                lo[i] = min(lo[i], w[i])
                hi[i] = max(hi[i], w[i])
    if cnt == 0:
        return None
    return {"min": [round(v, 5) for v in lo], "max": [round(v, 5) for v in hi],
            "size": [round(hi[i] - lo[i], 5) for i in range(3)], "objects": cnt}


def drive(jid, angle=0.0, unit="deg", pose=False, axis=None, anchor=None,
          include_descendants=True):
    """让关节 jid 转 angle 度（或弧度）。

    参数：
      pose=True  保留姿态（不还原）。默认还原 —— 可逆性是默认值，不是选项。
      axis/anchor  显式覆盖关节记录里的值（调试用）。
      include_descendants  把 child 的子孙对象也一起转（默认 True；
                 否则只转子部件，子部件上的小零件会留在原地）。
    """
    cn, pn, err = _children_of(jid)
    if err:
        return {"ok": False, "error": err}

    j = _find_joint(jid) or {}
    ax = axis if axis else j.get("axis")
    anc = anchor if anchor else j.get("anchor")
    if not ax:
        return {"ok": False,
                "error": "关节 %s 没有可用轴（推断失败？先 motion op=infer_axis）" % jid,
                "verdict": j.get("axis_verdict")}
    if not anc:
        return {"ok": False, "error": "关节 %s 没有枢轴点 anchor" % jid}

    # 收集要转的对象：child 侧 + 它的子孙（按对象父子关系）
    names = list(cn)
    if include_descendants:
        stack = list(cn)
        seen = set(names)
        while stack:
            cur = stack.pop()
            ob = bpy.data.objects.get(cur)
            if ob is None:
                continue
            for ch in ob.children:
                if ch.name not in seen:
                    seen.add(ch.name)
                    names.append(ch.name)
                    stack.append(ch.name)

    # 别把 parent 侧也转了 —— 那是基座
    if pn:
        names = [n for n in names if n not in set(pn)]
    if not names:
        return {"ok": False, "error": "算完要转的对象是空的"}

    rad = float(angle) if unit == "rad" else math.radians(float(angle))

    before = _bbox_of(names)
    snap = _snap(names)
    M = _rot_matrix(ax, rad, anc)
    touched = _apply(names, M)
    bpy.context.view_layer.update()
    after = _bbox_of(names)

    # 真动了吗：比包围盒
    moved = False
    if before and after:
        d = max(abs(after["min"][i] - before["min"][i]) for i in range(3))
        d = max(d, max(abs(after["max"][i] - before["max"][i]) for i in range(3)))
        moved = d > 1e-6

    out = {
        "ok": True,
        "joint": str(jid),
        "angle": angle,
        "unit": unit,
        "radians": round(rad, 6),
        "axis": [round(float(x), 6) for x in ax],
        "anchor": [round(float(x), 6) for x in anc],
        "rotated_objects": len(touched),
        "names_preview": touched[:12],
        "moved": moved,
        "bbox_before": before,
        "bbox_after": after,
    }

    if not pose:
        back = _restore(snap)
        bpy.context.view_layer.update()
        out["restored"] = True
        out["restored_objects"] = len(back)
        after2 = _bbox_of(names)
        # 还原到底到不到位：和 before 比
        if before and after2:
            dd = max(abs(after2["min"][i] - before["min"][i]) for i in range(3))
            out["restore_exact"] = dd < 1e-6
    else:
        out["restored"] = False
        out["note"] = "pose=True：姿态已保留（要撤销用 motion_drive op=undo，或自己还原）"

    return out


def sweep(jid, start=-45.0, end=45.0, steps=5, pose=False, axis=None, anchor=None):
    """扫一遍角度区间，回每个角度的包围盒尺寸。

    用途：判断“扫过去会不会穿模”“转到极限有没有撞到别的部件”。
    只回到数据，不渲染 —— 要图用 render。
    """
    res = []
    try:
        for i in range(max(2, int(steps))):
            t = i / float(max(1, int(steps) - 1))
            ang = float(start) + (float(end) - float(start)) * t
            r = drive(jid, angle=ang, pose=pose, axis=axis, anchor=anchor)
            if not r.get("ok"):
                return {"ok": False, "error": r.get("error"), "at_angle": ang,
                        "partial": res}
            res.append({"angle": round(ang, 3),
                        "size": (r.get("bbox_after") or {}).get("size"),
                        "moved": r.get("moved")})
    finally:
        pass
    return {"ok": True, "joint": str(jid), "samples": res,
            "swept": [float(start), float(end)], "steps": steps}


def reset_pose():
    """把当前场景的变换全部归零？不行——那会毁掉用户的布局。
    这里只给一条明确的提示，不做事。
    """
    return {"ok": False,
            "error": "没有“全部归零”这回事——那会把你的场景布局一起毁掉。"
                     "每个 drive 默认就会自己还原；要手动还原请用 pose=False 重跑一次。"}


def status():
    data = _joints_raw()
    js = data.get("joints") or data.get("items") or []
    if isinstance(js, dict):
        js = list(js.values())
    ready = []
    for j in js:
        ax = j.get("axis")
        an = j.get("anchor")
        ready.append({"id": j.get("id") or j.get("jid"),
                      "kind": j.get("kind"),
                      "can_drive": bool(ax) and bool(an),
                      "axis": ax, "has_anchor": bool(an),
                      "verdict": j.get("axis_verdict")})
    return {"ok": True, "version": DRIVE_VERSION,
            "joints": len(js), "drivable": sum(1 for r in ready if r["can_drive"]),
            "items": ready}


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

    try:
        if op == "status":
            return _j(status())
        if op == "reset_pose":
            return _j(reset_pose())
        if op == "drive":
            jid = a.get("jid") or a.get("id") or a.get("joint")
            if not jid:
                return _j({"ok": False, "error": "要转哪个关节？给 jid"})
            r = drive(str(jid), angle=num("angle", 0.0),
                      unit=str(a.get("unit") or "deg"),
                      pose=bool(a.get("pose")),
                      axis=a.get("axis"), anchor=a.get("anchor"),
                      include_descendants=a.get("include_descendants", True) is not False)
            return _j(r)
        if op == "sweep":
            jid = a.get("jid") or a.get("id") or a.get("joint")
            if not jid:
                return _j({"ok": False, "error": "要扫哪个关节？给 jid"})
            return _j(sweep(str(jid), num("start", -45.0), num("end", 45.0),
                            int(num("steps", 5)), pose=bool(a.get("pose")),
                            axis=a.get("axis"), anchor=a.get("anchor")))
        return _j({"ok": False, "error": "unknown drive op: %s" % op,
                   "ops": ["status", "drive", "sweep", "reset_pose"]})
    except Exception as e:
        import traceback
        return _j({"ok": False, "error": "%s: %s" % (type(e).__name__, str(e)[:300]),
                   "traceback": traceback.format_exc()[-700:]})


if _K is not None:
    _K.dsh_drive_api = {"version": DRIVE_VERSION, "dispatch": dispatch,
                        "drive": drive, "sweep": sweep, "status": status}
