# motion_wheel.py — 轮系驱动（方案 B）
#
# 与方案 A 的区别：
#   A 是单轴：转一个关节，完事。
#   B 要**多轴联动**：轮子转的时候，履带得按弧长跟着走。
#
# 为何不能只靠 A 的 drive：
#   轮子绕自身轴转 —— 这个 A 能做（但 A 绕的是**关节枢轴**，不是轮心）。
#   履带不是绕轴转，它是**沿一条闭合路径**移动。
#   用 A 去转履带，只会把它整条转歪。
#
# 三种履带结构，三种处理：
#   ① 一整条连续带体（mesh 是闭合环）—— 沿长轴循环平移顶点
#   ② 几十个链板合并成一个 mesh（虎式 TrackLinks_L/R）—— 拆连通分量，逐节走
#   ③ 每节是独立物体 —— 直接对每个物体做 ②
#
# 为什么 ② 不能用整体平移：链板在环上，上排往下走、下排往上走。
#   整体平移会把上排推出履带、下排拉散。

import bpy
import json
import math
import re
import sys

WHEEL_VERSION = 1

_K = sys.modules.get("dsh_rt_kernel")


def _j(o):
    return json.dumps(o, ensure_ascii=False)


def _vec(*a):
    from mathutils import Vector
    return Vector(a)


def _objs(names):
    out = []
    for n in (names or []):
        ob = bpy.data.objects.get(str(n))
        if ob is not None and ob.type == "MESH":
            out.append(ob)
    return out


def _world_bbox(objs, exact=True):
    """世界包围盒。

    ！exact 默认 True，而且**必须**是 True。
      用 ob.bound_box 的 8 个角点算，是个陷阱：bound_box 是**本地**包围盒，
      乘上 matrix_world 得到的是“本地矩形旋转后的外接框”，不是真实顶点的范围。
      圆柱本地框是 0.6×0.6 的正方形，绕自身轴转 40° 后，
      这个假包围盒会变成 0.6×(cos40+sin40) = 0.845，凭空多出 0.245——
      于是“绕自身轴转不该变大”这条判据就会**错误地失败**。
      这个坑真实踩过一次。
    """
    from mathutils import Vector
    pts = []
    for ob in objs:
        if exact:
            mw = ob.matrix_world
            for v in ob.data.vertices:
                pts.append(mw @ v.co)
        else:
            for c in ob.bound_box:
                pts.append(ob.matrix_world @ Vector(c))
    if not pts:
        return None
    lo = [min(p[i] for p in pts) for i in range(3)]
    hi = [max(p[i] for p in pts) for i in range(3)]
    return {"min": [round(v, 5) for v in lo], "max": [round(v, 5) for v in hi],
            "size": [round(hi[i] - lo[i], 5) for i in range(3)],
            "exact": bool(exact)}


def _snap(objs):
    return {ob.name: [float(x) for row in ob.matrix_world for x in row] for ob in objs}


def _restore(snap):
    from mathutils import Matrix
    n = 0
    for name, flat in snap.items():
        ob = bpy.data.objects.get(name)
        if ob is None:
            continue
        ob.matrix_world = Matrix([flat[0:4], flat[4:8], flat[8:12], flat[12:16]])
        n += 1
    return n


def _snap_mesh(ob):
    """记录顶点坐标（履带推进改的是顶点，不是矩阵，所以要单独记）。"""
    return [tuple(v.co) for v in ob.data.vertices]


def _restore_mesh(ob, coords):
    for i, c in enumerate(coords):
        if i < len(ob.data.vertices):
            ob.data.vertices[i].co = c
    ob.data.update()
    bpy.context.view_layer.update()


# ── 连通分量 ────────────────────────────────────────────────

def _components(me):
    """把网格拆成连通分量（每块链板是一个分量）。

    为何需要：虎式的 TrackLinks_L/R 是**几十个链板合并成一个 mesh**，
      拓扑上完全断开，数据上却是一个物体。
      想单独动每一节，必须先认得出“哪几个顶点属于同一节”。
    """
    import bmesh
    bm = bmesh.new()
    bm.from_mesh(me)
    bm.verts.ensure_lookup_table()
    seen = set()
    groups = []
    for v in bm.verts:
        if v.index in seen:
            continue
        stack = [v]
        comp = []
        while stack:
            cur = stack.pop()
            if cur.index in seen:
                continue
            seen.add(cur.index)
            comp.append(cur.index)
            for e in cur.link_edges:
                o = e.other_vert(cur)
                if o.index not in seen:
                    stack.append(o)
        groups.append(sorted(comp))
    bm.free()
    return groups


def _ring_order(centers):
    """把一堆点排成一条闭合环（最近邻贪心）。

    为何不能单轴排序：履带是一个**环**——从上面绕过去，再从下面回来。
      按 Y 排序会把“上边那排”和“下边那排”混在一起，推进时链板会乱窜。
      最近邻链能正确走出“上行→绕过前轮→下行→绕过后轮”的路径。
    """
    n = len(centers)
    if n < 3:
        return list(range(n))
    used = [False] * n
    order = [0]
    used[0] = True
    for _ in range(n - 1):
        cur = order[-1]
        best, bd = -1, None
        for i in range(n):
            if used[i]:
                continue
            d = (centers[i] - centers[cur]).length
            if bd is None or d < bd:
                bd, best = d, i
        if best < 0:
            break
        order.append(best)
        used[best] = True
    return order


def _advance_links(ob, comps, distance):
    """逐节推进履带：每节沿环形路径走 distance。

    ！为什么不能“按弧长重采样”（第一版就死在这里）：
      弧长重采样会把链板**重新均匀分布**。而真实履带的链板本来就不均布——
      直道密、弯道疏（虎式上间距 0.149～0.677，差 4.5 倍）。
      强行均匀化 = 周长缩短（实测 12.116 → 11.858，少了 0.26）、链板被挤到一起。

    ✓ 正确做法：**链板整体沿环滑动**，不改它们之间的相对分布：
      1. 用角度排序得到环上顺序（平面环：绕质心角度单调，对体育场形也成立）
      2. 每个链板走到“环上弧长 = 自己弧长 + distance”处的点
      3. 关键在于：位置用的是**环上插值**，但距离是沿着环量出来的，
         所以弯道上稀疏的点不会被拉向直道
    """
    me = ob.data
    mw = ob.matrix_world
    centers = []
    for g in comps:
        acc = _vec(0.0, 0.0, 0.0)
        for i in g:
            acc = acc + me.vertices[i].co
        centers.append(mw @ (acc / len(g)))

    order = _ring_order(centers)
    ring = [centers[i] for i in order]
    n = len(ring)
    if n < 4:
        return None

    s = [0.0]
    for i in range(1, n):
        s.append(s[-1] + (ring[i] - ring[i - 1]).length)
    total = s[-1] + (ring[0] - ring[-1]).length
    if total <= 1e-6:
        return None

    def at(u):
        """环上弧长 u 处的点（线性插值）。"""
        u = u % total
        for i in range(1, n):
            if u <= s[i]:
                seg = s[i] - s[i - 1]
                t = 0.0 if seg <= 1e-9 else (u - s[i - 1]) / seg
                return ring[i - 1].lerp(ring[i], t)
        seg = total - s[-1]
        t = 0.0 if seg <= 1e-9 else (u - s[-1]) / seg
        return ring[-1].lerp(ring[0], t)

    d = float(distance)
    inv = mw.inverted()

    # ！关键：不能“每节走到环上弧长+d 的位置”——
    #   那会让每节做**直线位移**，而环是弯的。直线弦长总小于弧长，
    #   累积 58 节就变成周长缩短（实测 -0.26，改成滑弧后仍 -0.13）。
    #
    # ✓ 正确做法：**离散置换**。
    #   每节直接占据“它前方那一节原来的位置”，链板之间保持精确刚性。
    #   形状完全不变，就是整体沿着环滑了 k 节。
    #   d 不是整节时，再做一次小数部分的小位移。
    n = len(ring)
    step = total / n  # 名义节距
    k = int(d // step) if step > 1e-9 else 0
    frac = d - k * step

    shifts = []
    nv = 0
    for kk, idx in enumerate(order):
        # 目标：向前 k 节（再叠小数部分）
        j = (kk + k) % n
        target = ring[j]
        if abs(frac) > 1e-9:
            # 小数部分：往 j 的下一节方向再走 frac/step 的比例
            j2 = (j + 1) % n
            seg = (ring[j2] - ring[j]).length
            t = 0.0 if seg <= 1e-9 else min(frac / seg, 1.0)
            target = ring[j].lerp(ring[j2], t)
        delta = target - ring[kk]
        shifts.append(delta.length)
        if delta.length < 1e-9:
            continue
        for vi in comps[idx]:
            w = mw @ me.vertices[vi].co + delta
            me.vertices[vi].co = inv @ w
            nv += 1
    me.update()
    bpy.context.view_layer.update()

    # ！自检指标：位移量应该**彼此接近**（都是名义节距的整数倍），
    #   而不要求间距均匀——弯道本来就疏、直道本来就密。
    return {"links": n, "perimeter": round(total, 4),
            "vertices_moved": nv, "arc": round(d, 4),
            "links_shifted": k,
            "shift_min": round(min(shifts), 4) if shifts else 0,
            "shift_max": round(max(shifts), 4) if shifts else 0,
            "spacing_min": round(min(s[i] - s[i - 1] for i in range(1, n)), 4),
            "spacing_max": round(max(s[i] - s[i - 1] for i in range(1, n)), 4)}


def _advance_single(ob, distance):
    """对**一整条连续带体**沿长轴循环平移顶点。"""
    me = ob.data
    mw = ob.matrix_world
    pts = [mw @ v.co for v in me.vertices]
    spans = [max(p[i] for p in pts) - min(p[i] for p in pts) for i in range(3)]
    ax = spans.index(max(spans))
    lo = min(p[ax] for p in pts)
    hi = max(p[ax] for p in pts)
    period = hi - lo
    if period <= 1e-6:
        return {"ok": False, "error": "带体在某轴上没有长度，无法判定路径"}
    d = float(distance)
    inv = mw.inverted()
    moved = 0
    for v in me.vertices:
        w = mw @ v.co
        nv = w[ax] + d
        if nv > hi:
            nv -= period
        elif nv < lo:
            nv += period
        if abs(nv - w[ax]) > 1e-9:
            moved += 1
        w[ax] = nv
        v.co = inv @ w
    me.update()
    bpy.context.view_layer.update()
    return {"ok": True, "mode": "single_band", "track": ob.name,
            "axis_index": ax, "period": round(period, 4),
            "distance": d, "vertices_moved": moved, "total": len(me.vertices)}


# ── 对外动作 ────────────────────────────────────────────────

def _bbox_center(ob):
    """物体的**几何**中心（世界坐标）。

    ！为什么不能用 ob.matrix_world.translation：
      生成器把几何烘焙进 mesh 顶点（虎式全部 48 个轮子的 location 都是 (0,0,0)，
      真实位置全在顶点坐标里）。用对象原点当枢轴 = 绕世界原点旋转，
      一转眼轮子就飞出去了（实测包围盒涨 2.6）。
      这个坑在自建测试模型上发现不了——那些模型的 origin 恰好在中心。
    """
    mw = ob.matrix_world
    acc = _vec(0.0, 0.0, 0.0)
    n = len(ob.data.vertices)
    if n == 0:
        return mw.translation.copy()
    for v in ob.data.vertices:
        acc = acc + (mw @ v.co)
    return acc / n


def spin(names, degrees, axis=None, pose=False):
    """让一组轮子绕**各自中心**、沿给定轴转。

    为何不是绕一个共同枢轴：轮子各转各的。绕共同枢轴会变成“整体公转”，
    那是行星齿轮，不是负重轮。

    ！判据：绕自身轴转，包围盒**不该变大**。
      若变大，说明转的不是“自身轴”（多半轴选错了）。
    """
    objs = _objs(names)
    if not objs:
        return {"ok": False, "error": "没有可用轮子（对象不存在或不是 mesh）"}
    from mathutils import Matrix, Vector
    ax = Vector(axis or (0, 1, 0)).normalized()
    rad = math.radians(float(degrees))
    before = _world_bbox(objs)
    snap = _snap(objs)

    for ob in objs:
        pivot = _bbox_center(ob)
        M = (Matrix.Translation(pivot)
             @ Matrix.Rotation(rad, 4, ax)
             @ Matrix.Translation(-pivot))
        ob.matrix_world = M @ ob.matrix_world
    bpy.context.view_layer.update()

    after = _world_bbox(objs)
    out = {"ok": True, "wheels": len(objs), "names": [o.name for o in objs],
           "degrees": float(degrees), "axis": [round(float(x), 6) for x in ax],
           "bbox_before": before, "bbox_after": after}
    if before and after:
        grow = max(after["size"][i] - before["size"][i] for i in range(3))
        out["bbox_grew"] = round(grow, 5)
        out["rotated_in_place"] = grow <= 0.02
    if not pose:
        _restore(snap)
        bpy.context.view_layer.update()
        out["restored"] = True
    return out


def track_advance(name, distance, pose=False):
    """履带推进 distance（场景单位）。自动识别三种结构。

    · links —— 几十个链板合并成一个 mesh（虎式就是这种）
        拆连通分量，每节沿环形路径走到自己弧长 + distance 处
    · single_band —— 带体本身就是一整条闭合环
        按长轴循环平移顶点
    """
    ob = bpy.data.objects.get(str(name or ""))
    if ob is None or ob.type != "MESH":
        return {"ok": False, "error": "没有这个网格：%s" % name}
    me = ob.data
    if len(me.vertices) < 12:
        return {"ok": False, "error": "顶点太少（%d），不像履带" % len(me.vertices)}

    m_snap = _snap_mesh(ob)
    comps = _components(me)
    per = len(me.vertices) / max(len(comps), 1)
    looks_like_links = (len(comps) >= 8 and per <= 40)

    if looks_like_links:
        res = _advance_links(ob, comps, distance)
        if res is None:
            return {"ok": False, "error": "链板路径退化（弧长过小）",
                    "components": len(comps)}
        res.update({"ok": True, "mode": "links", "track": ob.name,
                    "distance": float(distance)})
    else:
        res = _advance_single(ob, distance)
        res["components"] = len(comps)

    if not pose and res.get("ok"):
        _restore_mesh(ob, m_snap)
        res["restored"] = True
    return res


def roll(wheels=None, tracks=None, degrees=0.0, radius=None, axis=None,
         pose=False, spin_sign=1):
    """一次把整个轮系转起来：轮子按角度转，履带按弧长推进。

    radius：轮子半径（米），用来把角度换成弧长（distance = r × θ）。
      不给则从轮子包围盒估（取最小那维的一半）。
    """
    wheels = wheels or []
    tracks = tracks or []
    wobjs = _objs(wheels)
    tobjs = _objs(tracks)
    if not wobjs and not tobjs:
        return {"ok": False, "error": "wheels 和 tracks 都是空的"}

    rad = math.radians(float(degrees))
    r = radius
    if r is None and wobjs:
        sizes = []
        for ob in wobjs:
            bb = _world_bbox([ob])
            if bb:
                sizes.append(min(bb["size"]))
        r = (sum(sizes) / len(sizes) / 2.0) if sizes else None
    dist = (float(r) * rad * float(spin_sign)) if r else 0.0

    allobjs = wobjs + tobjs
    before = _world_bbox(allobjs) if allobjs else None
    snap = _snap(allobjs)
    m_snaps = {ob.name: _snap_mesh(ob) for ob in tobjs}

    out = {"ok": True, "degrees": float(degrees),
           "radius_used": round(float(r), 5) if r else None,
           "arc_distance": round(dist, 5),
           "wheels": len(wobjs), "tracks": len(tobjs)}

    if wobjs:
        sp = spin([o.name for o in wobjs], float(degrees), axis=axis, pose=True)
        out["spin"] = {"wheels": sp.get("wheels"),
                       "rotated_in_place": sp.get("rotated_in_place"),
                       "bbox_grew": sp.get("bbox_grew"),
                       "error": sp.get("error")}

    track_res = []
    for ob in tobjs:
        track_res.append(track_advance(ob.name, dist, pose=True))
    if track_res:
        out["track_advance"] = track_res

    after = _world_bbox(allobjs) if allobjs else None
    out["bbox_before"] = before
    out["bbox_after"] = after

    if not pose:
        _restore(snap)
        for ob in tobjs:
            _restore_mesh(ob, m_snaps[ob.name])
        bpy.context.view_layer.update()
        out["restored"] = True
        out["restored_objects"] = len(allobjs)
    else:
        out["restored"] = False
    return out


def status():
    """猜一下场景里哪些东西像轮子、像履带。"""
    wheels, tracks, other = [], [], []
    for ob in bpy.data.objects:
        if ob.type != "MESH":
            continue
        n = ob.name.lower()
        if re.search(r"wheel|roller|sprocket|idler|轮", n):
            wheels.append(ob.name)
        elif re.search(r"track|belt|履带|chain", n):
            tracks.append(ob.name)
        else:
            other.append(ob.name)
    return {"ok": True, "version": WHEEL_VERSION,
            "wheels_guess": wheels, "tracks_guess": tracks,
            "other_count": len(other),
            "note": "名字带 wheel/roller/sprocket/idler/轮 猜是轮系，"
                    "带 track/belt/履带/chain 猜是履带"}


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
        if op == "spin":
            return _j(spin(lst("wheels") or lst("names"), num("degrees", 15.0),
                            axis=a.get("axis"), pose=bool(a.get("pose"))))
        if op == "track_advance":
            return _j(track_advance(str(a.get("track") or a.get("name") or ""),
                                    num("distance", 0.0), pose=bool(a.get("pose"))))
        if op == "roll":
            return _j(roll(wheels=lst("wheels"), tracks=lst("tracks"),
                           degrees=num("degrees", 15.0),
                           radius=(num("radius", 0) or None),
                           axis=a.get("axis"), pose=bool(a.get("pose")),
                           spin_sign=num("spin_sign", 1)))
        return _j({"ok": False, "error": "unknown wheel op: %s" % op,
                   "ops": ["status", "spin", "track_advance", "roll"]})
    except Exception as e:
        import traceback
        return _j({"ok": False, "error": "%s: %s" % (type(e).__name__, str(e)[:300]),
                   "traceback": traceback.format_exc()[-700:]})


if _K is not None:
    _K.dsh_wheel_api = {"version": WHEEL_VERSION, "dispatch": dispatch}
