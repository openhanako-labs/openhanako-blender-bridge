# -*- coding: utf-8 -*-
"""跑上游契约层自检（先建 K 内核，再执自检脚本）。

为什么要这个包装：上游自检假设 K（K.dsh_rt_kernel）已被 preload 建好，
直接在 blender -b 下跑会因为 K 是 None 而崩。这里先执行 KERNEL_BOOTSTRAP。
"""
import bpy, sys, types, os, runpy

# 1) 建内核 K（与 engine.mjs 的 KERNEL_BOOTSTRAP 等价）
K = sys.modules.get("dsh_rt_kernel")
if K is None:
    K = types.ModuleType("dsh_rt_kernel")
    sys.modules["dsh_rt_kernel"] = K
import math, mathutils
K.Vector = mathutils.Vector
K.bpy = bpy

HERE = os.path.dirname(os.path.abspath(__file__))
PKG = os.path.dirname(HERE)          # dsh-rt
RUNTIME = os.path.join(PKG, "runtime")

# 契约层靠 K.runtime_dir 定位同目录的 assembly_features.json（它自己的注释里说了）
K.runtime_dir = RUNTIME

# 2) 把各 python 模块各自 exec 到独立命名空间（避免 _ 开头 helper 互相覆写），
#    并让它们把 API 挂到 K 上
import json
MODULES = ["contract", "txn", "qc", "runner", "view", "planner", "generator", "audit", "montage", "deliver", "motion", "perf", "presets", "worker"]
preload = [m for m in MODULES if m in sys.argv[0] or True]  # 全部加载

for name in MODULES:
    path = os.path.join(RUNTIME, name + ".py")
    if not os.path.exists(path):
        continue
    src = open(path, encoding="utf-8").read()
    ns = {"__name__": name}
    try:
        exec(compile(src, name + ".py", "exec"), ns)
    except Exception as e:
        print("PRELOAD_FAIL %s: %s" % (name, e))
        continue
    # 公开名回填 globals（向后兼容：直接调 c_xxx 的写法）
    globals().update({k: v for k, v in ns.items() if not k.startswith("_")})

print("KERNEL has contract_api:", hasattr(K, "dsh_contract_api"))
print("KERNEL has txn_api:", hasattr(K, "dsh_txn_api"))

# 3) 跑目标自检脚本
target = os.environ.get("DSH_SELFTEST", "contract_selftest.py")
tpath = os.path.join(HERE, target)
print("=== 运行 %s ===" % target)
sys.argv = [tpath] + [a for a in sys.argv[1:]]
runpy.run_path(tpath, run_name="__main__")
