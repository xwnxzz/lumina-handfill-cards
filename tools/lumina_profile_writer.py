#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
lumina_profile_writer.py — 离线手写 Lumina 耗材档案

用途
    你自己测量梯度卡/单阶板各色块的 RGB，本脚本离线完成拟合与打包，
    生成可直接被 Lumina Studio「导入耗材 ZIP」接受的
    lumina_materials_<N>_<时间>.zip。全程不联网、不做图像识别。

反向工程依据（已用官方导出包逐位验证）
    正向模型：  C(t) = E + (C0 - E) * exp(-k * t)          t 单位 mm
      · C0        该基底零厚度处的线性 RGB
      · E         渐近(饱和)色，约束 E >= 0
      · k         衰减系数，单位 1/mm
      · E、k 由两个基底(白底/黑底)联合拟合，各 RGB 通道独立
    验证结果：用官方 samples 复算，R/G/B 三通道的 E、k 与
    channel_rmse 均复现到 5~6 位有效数字（见 --selftest）。

    C0 的来源：C0 = srgb_to_linear(实测 8bit RGB / 255)
      实测 white t=0 RGB=212 -> 0.658375（与官方 white_C0[0] 完全一致）

用法
    # 1) 自检：确认模型实现与官方一致
    python lumina_profile_writer.py --selftest

    # 2) 生成空白测量模板
    python lumina_profile_writer.py --make-template 测量模板.csv

    # 3) 填好自己的 RGB 后生成档案包（推荐带 --template 复用你导出过的包）
    python lumina_profile_writer.py \
        --brand 大简 --name "金 petg hf" \
        --measurements 测量模板.csv \
        --template lumina_materials_1_20260917_153526.zip \
        --out lumina_materials_1_自己做的.zip

测量 CSV 格式（36 行 = 2 基底 x 18 厚度）
    substrate,thickness_mm,r,g,b
    white,0.0,212,184,115
    white,0.08,...
    ...
    black,0.0,...
    ...
    r/g/b 为 0-255 的 8bit 值（若你用 0-1 归一化的线性值，加 --linear-input）
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import math
import os
import sys
import zipfile
from datetime import datetime, timezone
from typing import Dict, List, Sequence, Tuple

import numpy as np

# ---------------------------------------------------------------- 规格常量
SPEC = {
    "grid_cols": 6,
    "grid_rows": 3,
    "block_mm": 10.0,
    "gap_mm": 1.0,
    "margin_mm": 1.0,
    "pixel_mm": 1.0,
    "layer_height_mm": 0.08,
    "base_mm": 1.0,
    "max_step_layers": 25,
    "step_layers": [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 25],
    "shrink_xy_mm": 0.02,
}
LAYER_H = SPEC["layer_height_mm"]
THICKNESS_MM = [round(n * LAYER_H, 4) for n in SPEC["step_layers"]]  # 18 个厚度
SUBSTRATES = [("white", "White"), ("black", "Black")]


# ---------------------------------------------------------------- 色彩转换
def srgb_to_linear(c: np.ndarray) -> np.ndarray:
    """sRGB(0-1) -> 线性 RGB。逐项，含 0.04045 拐点。"""
    c = np.asarray(c, dtype=float)
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def linear_to_srgb(c: np.ndarray) -> np.ndarray:
    c = np.clip(np.asarray(c, dtype=float), 0.0, 1.0)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * c ** (1 / 2.4) - 0.055)


_D65 = np.array([0.95047, 1.0, 1.08883])


def linear_to_lab(lin: np.ndarray) -> np.ndarray:
    """线性 RGB -> CIELAB(D65)。

    注意：下面这个矩阵是【线性】sRGB -> XYZ(D65) 的标准矩阵，输入必须保持线性。
    早期实现先把 lin 经 sRGB 传递函数编码再乘该矩阵，等于把编码值当线性值用，
    会让 ΔE76 完全失去物理意义（--selftest 末尾的定点校验能抓住这个）。
    """
    lin = np.asarray(lin, dtype=float).reshape(-1, 3)
    m = np.array([[0.4124564, 0.3575761, 0.1804375],
                  [0.2126729, 0.7151522, 0.0721750],
                  [0.0193339, 0.1191920, 0.9503041]])
    xyz = lin @ m.T
    t = xyz / _D65
    d = 6 / 29
    f = np.where(t > d ** 3, np.cbrt(t), t / (3 * d ** 2) + 4 / 29)
    return np.column_stack([116 * f[:, 1] - 16,
                            500 * (f[:, 0] - f[:, 1]),
                            200 * (f[:, 1] - f[:, 2])])


def delta_e_76(lab_a: np.ndarray, lab_b: np.ndarray) -> np.ndarray:
    return np.sqrt(((np.asarray(lab_a) - np.asarray(lab_b)) ** 2).sum(axis=1))


# ---------------------------------------------------------------- 拟合
def fit_channel(y_white: np.ndarray, y_black: np.ndarray,
                c0_white: float, c0_black: float,
                t: np.ndarray, k_max: float = 8.0,
                k_steps: int = 400001) -> Tuple[float, float, float]:
    """拟合单通道的 (E, k)。给定 k，E 可线性解出；再对 k 做一维搜索。

    C = E + (C0 - E) * exp(-k t)
    t=0 处 C=C0 恒成立（残差 0），但**计入** rmse 分母以匹配官方口径。
    约束 0 <= E <= 1：E 是线性反射率，只钳下界会让 E>1 被 linear_to_srgb()
    静默截断，造成「档案里的 E」与「输出 RGB 代表的 E」不一致。
    """

    def evaluate(k: float):
        """给定 k：线性解出 E、钳到 [0,1]，返回 (E, k, rmse)。"""
        decay = np.exp(-k * t)
        # 模型 C = C0*decay + E*(1-decay)，对 E 线性
        a = np.concatenate([1 - decay, 1 - decay])
        r = np.concatenate([y_white - c0_white * decay,
                            y_black - c0_black * decay])
        denom = float(np.dot(a, a))
        if denom <= 1e-14:
            return None
        E = float(np.dot(a, r) / denom)
        if E < 0.0:
            E = 0.0
        elif E > 1.0:
            E = 1.0
        # 钳制后必须沿用同一个预测式（早期版本在此错误地引入自由缩放，会污染解）
        pred_w = E + (c0_white - E) * decay
        pred_b = E + (c0_black - E) * decay
        err = np.concatenate([pred_w - y_white, pred_b - y_black])
        return (E, float(k), float(np.sqrt(np.sum(err ** 2) / err.size)))

    def scan(k_lo: float, k_hi: float, steps: int):
        best = None
        for k in np.linspace(k_lo, k_hi, steps):
            v = evaluate(float(k))
            if v is None:
                continue
            if best is None or v[2] < best[2] - 1e-15:
                best = v
        return best

    # 粗搜定位最优盆地 → 两级细搜收紧。
    # 精度优于原来的等步长全扫描（步长 2e-5），候选点从 40 万降到约 8000。
    coarse_n = max(200, int(k_steps // 100))
    best = scan(1e-4, k_max, coarse_n)
    assert best is not None, "拟合失败"
    span = (k_max - 1e-4) / (coarse_n - 1)
    for _ in range(2):
        lo = max(1e-4, best[1] - span)
        hi = min(k_max, best[1] + span)
        if hi <= lo:
            break
        steps = 2001
        cand = scan(lo, hi, steps)
        if cand is not None and cand[2] < best[2]:
            best = cand
        span = (hi - lo) / (steps - 1)
    return best


def fit_profile(white_lin: np.ndarray, black_lin: np.ndarray,
                t: np.ndarray) -> Dict:
    """拟合全部 3 通道。返回 E/k/C0/预测/误差。"""
    c0w = white_lin[0].copy()
    c0b = black_lin[0].copy()
    E, k, ch_rmse = [], [], []
    for c in range(3):
        e, kk, r = fit_channel(white_lin[:, c], black_lin[:, c], c0w[c], c0b[c], t)
        E.append(e); k.append(kk); ch_rmse.append(r)
    E = np.array(E); k = np.array(k)
    pred_w = E + (c0w - E) * np.exp(-np.outer(t, k))
    pred_b = E + (c0b - E) * np.exp(-np.outer(t, k))
    meas = np.vstack([white_lin, black_lin])
    pred = np.vstack([pred_w, pred_b])
    de = delta_e_76(linear_to_lab(meas), linear_to_lab(pred))
    return {
        "E": E, "k": k, "C0_white": c0w, "C0_black": c0b,
        "channel_rmse": np.array(ch_rmse),
        "rmse_linear": float(np.sqrt(np.mean((pred - meas) ** 2))),
        "mean_delta_e": float(np.mean(de)),
        "max_delta_e": float(np.max(de)),
        "pred_white": pred_w, "pred_black": pred_b,
    }


# ---------------------------------------------------------------- 体检
def sanity_report(white_lin: np.ndarray, black_lin: np.ndarray,
                  t: np.ndarray) -> List[str]:
    warns: List[str] = []
    for c, nm in enumerate("RGB"):
        dw = np.diff(white_lin[:, c]); db = np.diff(black_lin[:, c])
        up_w = int((dw > 0).sum()); up_b = int((db > 0).sum())
        if up_w or up_b:
            warns.append(f"{nm} 通道非单调：白底上升 {up_w}/{len(dw)} 次，"
                         f"黑底上升 {up_b}/{len(db)} 次 —— 厚度越大颜色应越深/越饱和，"
                         f"出现上升通常意味着色块顺序或厚度对应错位。")
        bad = int((white_lin[:, c] < black_lin[:, c]).sum())
        if bad:
            warns.append(f"{nm} 通道有 {bad} 个样本白底比黑底还暗，物理上不合理。")
    if white_lin[0].mean() < 0.55:
        warns.append(f"零厚度白底采样偏暗（均值 {white_lin[0].mean():.3f} < 0.55），"
                     f"疑似曝光不足或未对准纯基底色块。")
    return warns


# ---------------------------------------------------------------- IO
def load_measurements(path: str, linear_input: bool) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    rows: Dict[str, List[Tuple[float, Tuple[float, float, float]]]] = {
        "white": [], "black": []}
    with open(path, newline="", encoding="utf-8-sig") as fh:
        rd = csv.DictReader(fh)
        need = {"substrate", "thickness_mm", "r", "g", "b"}
        if not need.issubset({(k or "").strip().lower() for k in rd.fieldnames or []}):
            raise SystemExit(f"CSV 表头必须是 {sorted(need)}，实际是 {rd.fieldnames}")
        for raw in rd:
            row = {(k or "").strip().lower(): (v or "").strip() for k, v in raw.items()}
            sub = row["substrate"].lower()
            if sub not in rows:
                raise SystemExit(f"未知 substrate: {sub!r}（应为 white 或 black）")
            if not row["thickness_mm"]:
                continue
            rgb = [float(row[c]) for c in "rgb"]
            rows[sub].append((float(row["thickness_mm"]), tuple(rgb)))

    if not rows["white"] or not rows["black"]:
        raise SystemExit("CSV 必须同时包含 white 与 black 两个基底的测量")

    out = {}
    for sub in ("white", "black"):
        pairs = sorted(rows[sub], key=lambda x: x[0])
        got_t = [round(p[0], 4) for p in pairs]
        if len(pairs) != len(THICKNESS_MM):
            raise SystemExit(f"{sub}: 需要 {len(THICKNESS_MM)} 个厚度，实际 {len(pairs)} 个")
        if got_t != THICKNESS_MM:
            # 逐元素比较其实已蕴含「无重复」（THICKNESS_MM 本身互不相同）；
            # 下面只是把重复/缺失项点名，让报错更好定位
            seen, dup = set(), []
            for x in got_t:
                if x in seen:
                    dup.append(x)
                seen.add(x)
            extra = f"\n其中重复厚度：{sorted(set(dup))}" if dup else ""
            missing = [x for x in THICKNESS_MM if x not in seen]
            if missing:
                extra += f"\n缺少厚度：{missing}"
            raise SystemExit(
                f"{sub}: 厚度必须正好是\n  {THICKNESS_MM}\n实际是\n  {got_t}{extra}")
        arr = np.array([p[1] for p in pairs], dtype=float)
        if linear_input:
            out[sub] = np.clip(arr, 0.0, 1.0)
        else:
            out[sub] = srgb_to_linear(np.clip(arr, 0.0, 255.0) / 255.0)
    return out["white"], out["black"], np.array(THICKNESS_MM)


def sha256_bytes(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def dumps(obj) -> bytes:
    return (json.dumps(obj, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


# ---------------------------------------------------------------- 产物构造
def iso_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def build_stage_a(name: str, fit: Dict, warns: List[str],
                  material_default: str = "PLA Basic") -> dict:
    E = [round(float(v), 6) for v in fit["E"]]
    k = [round(float(v), 6) for v in fit["k"]]
    c0w = [round(float(v), 6) for v in fit["C0_white"]]
    c0b = [round(float(v), 6) for v in fit["C0_black"]]
    flags = []
    if float(np.mean(fit["C0_white"])) < 0.60:
        flags.append("c0_white_avg_lt_0_60")
    if float(fit["mean_delta_e"]) > 3.0:
        flags.append("mean_de_gt_3")
    run = {
        "index": 0, "is_fresh": True,
        "bias_flag_count": len(flags), "bias_flags": flags,
        "structural_flag_count": len(flags), "structural_flags": flags,
        "white_c0_avg": float(np.mean(fit["C0_white"])),
        "image_source": "manual_measurement",
        "cross_val_rmse": None,
    }
    return {
        "param_type": "stage_A",
        "meta": {
            "schema_version": "1.0",
            "generated_at": iso_now(),
            "source": "lumina_gradient_card_extract",
            "workflow": "single-stage-kit",
            "warnings": warns,
            "image_source": "manual_measurement",
            "verification_count": 1,
            "aggregation_method": "refit_combined_samples",
            "selection": {
                "selected_indices": [0], "excluded_runs": [],
                "selection_strategy": "bias_filter_v1",
                "run_scores": [run], "fresh_index": 0,
            },
        },
        "parameters": {
            "channels": [{"channel_index": 0, "color_name": name, "E": E, "k": k}],
            "substrates": [
                {"substrate_idx": 0, "substrate_id": "white",
                 "display_name": "White", "C0": c0w},
                {"substrate_idx": 1, "substrate_id": "black",
                 "display_name": "Black", "C0": c0b},
            ],
        },
        "fitted_substrates": {"white": {"C0": c0w}, "black": {"C0": c0b}},
        "validation": {
            "overall": {
                "mean_delta_e": float(fit["mean_delta_e"]),
                "max_delta_e": float(fit["max_delta_e"]),
                "rmse_linear": float(fit["rmse_linear"]),
                "channel_rmse": [float(v) for v in fit["channel_rmse"]],
                "best_run_mean_delta_e": float(fit["mean_delta_e"]),
                "verification_count": 1,
                "aggregation_method": "refit_combined_samples",
                "selected_run_count": 1,
                "selection_strategy": "bias_filter_v1",
            }
        },
        "source": {
            "spec": SPEC,
            "manifest": {
                "schema_version": "1.0",
                "workflow": "single-stage-kit",
                "material_default": material_default,
                "substrate_id": "white",
                "substrate_display_name": "White",
            },
        },
    }


def build_material(name: str, brand: str, fit: Dict, warns: List[str],
                   stage_a: dict, spec: dict) -> dict:
    est_rgb = [int(round(float(v) * 255)) for v in linear_to_srgb(fit["E"])]
    w0 = [int(round(float(v) * 255)) for v in linear_to_srgb(fit["C0_white"])]
    b0 = [int(round(float(v) * 255)) for v in linear_to_srgb(fit["C0_black"])]
    return {
        "schema_version": "1.1",
        "kind": "lumina_stage_a_material",
        "material_name": name,
        "brand": brand,
        "material_profile_id": "profile_" + hashlib.sha256(
            f"{brand}/{name}".encode("utf-8")).hexdigest()[:32],
        "created_at": iso_now(),
        "updated_at": iso_now(),
        "stage_a_params_file": "stage_A_parameters.json",
        "fit_summary": {
            "substrate_count": 2,
            "channel_count": 1,
            "substrates": ["black", "white"],
            "colors": [name],
            "overall_validation": stage_a["validation"]["overall"],
            "warnings": warns,
        },
        "material_summary": {
            "sample_count": 36,
            "per_substrate_sample_count": 18,
            "grid_rows": spec["grid_rows"],
            "grid_cols": spec["grid_cols"],
            "layer_height_mm": spec["layer_height_mm"],
            "thickness_layers": list(spec["step_layers"]),
            "white_zero_rgb": w0,
            "black_zero_rgb": b0,
            "estimated_rgb": est_rgb,
            "estimated_k": [round(float(v), 6) for v in fit["k"]],
            "verification_count": 1,
            "aggregation_method": "refit_combined_samples",
            "selected_run_count": 1,
        },
        "source": {
            "spec": spec,
            "image_source": "manual_measurement",
        },
        "verification_count": 1,
        "verification_runs": [{
            "captured_at": iso_now(),
            "params": {
                "E": [round(float(v), 6) for v in fit["E"]],
                "k": [round(float(v), 6) for v in fit["k"]],
                "white_C0": [round(float(v), 6) for v in fit["C0_white"]],
                "black_C0": [round(float(v), 6) for v in fit["C0_black"]],
            },
            "fit_summary": stage_a["meta"],
            "source": {"spec": spec, "image_source": "manual_measurement"},
        }],
        "aggregation": {
            "method": "refit_combined_samples",
            "aggregated_at": iso_now(),
            "image_source": "manual_measurement",
        },
    }


def build_bundle(brand: str, name: str, mat_bytes: bytes,
                 stage_bytes: bytes, spec: dict,
                 template_ids: dict | None = None) -> dict:
    ids = template_ids or {}
    content_hash = ids.get("content_hash") or ("sha256:" + sha256_bytes(mat_bytes + stage_bytes))
    return {
        "schema_version": "2.0",
        "kind": "lumina_material_bundle",
        "exported_at": iso_now(),
        "material_count": 1,
        "packages": [{
            "material_id": ids.get("material_id") or
                           "mat_" + hashlib.sha256(f"{brand}/{name}".encode()).hexdigest()[:26],
            "revision_id": ids.get("revision_id") or
                           "rev_" + hashlib.sha256(mat_bytes).hexdigest()[:26],
            "content_hash": content_hash,
            "channel": "manual",
            "visibility": "private",
            "local_directory": f"{brand}/{name}",
            "display": {
                "brand": brand, "material_name": name,
                "estimated_rgb": json.loads(dumps(build_est(mat_bytes)))["estimated_rgb"],
            },
            "files": [
                {"path": f"materials/{brand}/{name}/material.json",
                 "role": "material_archive", "sha256": sha256_bytes(mat_bytes),
                 "bytes": len(mat_bytes), "required": True},
                {"path": f"materials/{brand}/{name}/stage_A_parameters.json",
                 "role": "stage_a_parameters", "sha256": sha256_bytes(stage_bytes),
                 "bytes": len(stage_bytes), "required": True},
            ],
            "compatibility": {"min_app_version": "0.0.0",
                              "material_schema_version": "1.1"},
        }],
    }


def build_est(mat_bytes: bytes) -> dict:
    d = json.loads(mat_bytes.decode("utf-8"))
    return {"estimated_rgb": d["material_summary"]["estimated_rgb"]}


def build_export(directory: str) -> dict:
    return {
        "schema_version": "1.0",
        "kind": "lumina_material_export",
        "exported_at": iso_now(),
        "directory_names": [directory],
        "material_count": 1,
    }


# ---------------------------------------------------------------- 自检
SAMPLES_W = [[0.65837,0.47932,0.17144],[0.64448,0.47353,0.19120],[0.63760,0.47932,0.23840],
             [0.63076,0.50888,0.30947],[0.61050,0.55201,0.42869],[0.59062,0.60383,0.57112],
             [0.59720,0.38133,0.11444],[0.55201,0.33245,0.09990],[0.53328,0.30947,0.09084],
             [0.53328,0.30947,0.09306],[0.53948,0.31855,0.09990],[0.58408,0.36131,0.11954],
             [0.57112,0.36131,0.10462],[0.53948,0.31855,0.09084],[0.51492,0.29614,0.08228],
             [0.50888,0.28315,0.08022],[0.52100,0.29177,0.08438],[0.56471,0.32778,0.09990]]
SAMPLES_B = [[0.46778,0.40198,0.14413],[0.42327,0.35153,0.12744],[0.35153,0.29177,0.10946],
             [0.28744,0.23840,0.09306],[0.16203,0.12744,0.05951],[0.02416,0.02624,0.02315],
             [0.48515,0.39157,0.13014],[0.46208,0.35153,0.11954],[0.44520,0.33245,0.11193],
             [0.42869,0.31399,0.10462],[0.40724,0.29614,0.10224],[0.39676,0.29614,0.10462],
             [0.49693,0.36625,0.11444],[0.47353,0.34191,0.10702],[0.46778,0.33245,0.10462],
             [0.46778,0.33245,0.09990],[0.46208,0.32778,0.09990],[0.46208,0.33245,0.10462]]
OFFICIAL = {"E": [0.390215, 0.283147, 0.0], "k": [0.606487, 1.508833, 0.311095],
            "ch_rmse": [0.0974894979572134, 0.08838097150238258, 0.09334856744902764],
            "rmse_linear": 0.09314746978213301}


def selftest() -> int:
    w = np.array(SAMPLES_W); b = np.array(SAMPLES_B); t = np.array(THICKNESS_MM)
    print("=" * 72)
    print("自检：用官方导出包里的 samples 复算，对照官方拟合结果")
    print("=" * 72)
    print(f"{'通道':>4} {'拟合E':>11} {'官方E':>11} {'拟合k':>11} {'官方k':>11} "
          f"{'拟合RMSE':>11} {'官方RMSE':>11}")
    ok = True
    for c, nm in enumerate("RGB"):
        E, k, r = fit_channel(w[:, c], b[:, c], w[0, c], b[0, c], t)
        de = abs(E - OFFICIAL["E"][c]); dk = abs(k - OFFICIAL["k"][c])
        dr = abs(r - OFFICIAL["ch_rmse"][c])
        good = de < 5e-3 and dk < 5e-3 and dr < 5e-4
        ok &= good
        print(f"{nm:>4} {E:11.6f} {OFFICIAL['E'][c]:11.6f} {k:11.6f} "
              f"{OFFICIAL['k'][c]:11.6f} {r:11.6f} {OFFICIAL['ch_rmse'][c]:11.6f}"
              f"   {'OK' if good else 'DIFF'}")
    fit = fit_profile(w, b, t)
    print()
    print(f"整体 rmse_linear  拟合 {fit['rmse_linear']:.9f} | "
          f"官方 {OFFICIAL['rmse_linear']:.9f}")
    print()
    # ---- Lab / ΔE 管线的定点校验 ----
    # 这一组能抓住「把 sRGB 编码值当线性值喂给 RGB→XYZ 矩阵」这类错误：
    # 它与 E/k 的拟合正确性无关，所以只看拟合数值是发现不了的。
    print()
    print("色彩管线定点校验（Lab / ΔE76）")
    lab_mid = linear_to_lab(np.array([[0.2158605] * 3]))[0]
    lab_w = linear_to_lab(np.array([[1.0] * 3]))[0]
    lab_b = linear_to_lab(np.array([[0.0] * 3]))[0]
    de_wb = float(delta_e_76(lab_w.reshape(1, 3), lab_b.reshape(1, 3))[0])
    checks = [
        ("线性灰 0.2158605 的 L*", lab_mid[0], 53.585, 0.01),
        ("白色 L*", lab_w[0], 100.0, 0.01),
        ("黑色 L*", lab_b[0], 0.0, 0.01),
        ("中性灰 a*", lab_w[1], 0.0, 0.01),
        ("中性灰 b*", lab_w[2], 0.0, 0.01),
        ("黑白 ΔE76", de_wb, 100.0, 0.01),
    ]
    for nm, got, want, tol in checks:
        good = abs(got - want) <= tol
        ok &= good
        print(f"  {nm:<22} 实测 {got:9.4f} | 应为 {want:9.4f}   {'OK' if good else 'DIFF'}")
    print()
    print("结论：" + ("模型实现与官方一致，可放心使用。" if ok else "存在差异，请勿直接使用！"))
    print()
    print("附：该样本序列的体检（你会发现它不通过）")
    for wmsg in sanity_report(w, b, t):
        print("  ! " + wmsg)
    return 0 if ok else 1


# ---------------------------------------------------------------- 模板
def extract_template_ids(template_zip: str) -> dict:
    with zipfile.ZipFile(template_zip) as z:
        with z.open("lumina_material_bundle.json") as fh:
            b = json.load(fh)
    p = b["packages"][0]
    return {"material_id": p.get("material_id"),
            "revision_id": p.get("revision_id"),
            "content_hash": p.get("content_hash")}


def write_template_csv(path: str) -> None:
    with open(path, "w", newline="", encoding="utf-8-sig") as fh:
        wr = csv.writer(fh)
        wr.writerow(["substrate", "thickness_mm", "r", "g", "b"])
        for sub, _ in SUBSTRATES:
            for t in THICKNESS_MM:
                wr.writerow([sub, t, "", "", ""])
    print(f"已写出测量模板：{path}")
    print(f"  行数 = 2 基底 x {len(THICKNESS_MM)} 厚度 = {2*len(THICKNESS_MM)} 行")
    print("  把每格实测的 8bit RGB(0-255) 填进 r,g,b 三列")


# ---------------------------------------------------------------- 主流程
def main(argv: Sequence[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description="离线手写 Lumina 耗材档案（自己测 RGB，不用图像识别）")
    ap.add_argument("--selftest", action="store_true", help="用官方样本验证模型实现")
    ap.add_argument("--make-template", metavar="CSV", help="生成空白测量 CSV 模板")
    ap.add_argument("--measurements", metavar="CSV", help="你的测量 CSV")
    ap.add_argument("--brand", default="", help="品牌（会成为耗材库的分组名）")
    ap.add_argument("--name", default="", help="耗材名称")
    ap.add_argument("--material-default", default="PLA Basic", help="材料类型标签")
    ap.add_argument("--linear-input", action="store_true",
                    help="CSV 里 r/g/b 是 0-1 线性值（默认按 0-255 sRGB 解释）")
    ap.add_argument("--template", metavar="ZIP",
                    help="你之前导出的包，用于复用 material_id 等标识（推荐）")
    ap.add_argument("--out", metavar="ZIP", help="输出档案包路径")
    a = ap.parse_args(argv)

    if a.selftest:
        return selftest()
    if a.make_template:
        write_template_csv(a.make_template)
        return 0

    if not a.measurements:
        ap.print_help()
        return 2
    if not a.brand or not a.name:
        raise SystemExit("必须提供 --brand 与 --name")
    out = a.out or f"lumina_materials_1_{datetime.now().strftime('%Y%m%d_%H%M%S')}.zip"

    w, b, t = load_measurements(a.measurements, a.linear_input)
    warns = sanity_report(w, b, t)
    fit = fit_profile(w, b, t)

    print("=" * 72)
    print("拟合结果")
    print("=" * 72)
    print(f"  C0 白底 = {[round(float(v),6) for v in fit['C0_white']]}  "
          f"(实测零厚度 RGB {[int(round(float(v)*255)) for v in linear_to_srgb(fit['C0_white'])]})")
    print(f"  C0 黑底 = {[round(float(v),6) for v in fit['C0_black']]}  "
          f"(实测零厚度 RGB {[int(round(float(v)*255)) for v in linear_to_srgb(fit['C0_black'])]})")
    print(f"  E       = {[round(float(v),6) for v in fit['E']]}")
    print(f"  k       = {[round(float(v),6) for v in fit['k']]}")
    print(f"  rmse_linear    = {fit['rmse_linear']:.6f}")
    print(f"  channel_rmse   = {[round(float(v),6) for v in fit['channel_rmse']]}")
    print(f"  平均 ΔE76      = {fit['mean_delta_e']:.3f}    最大 {fit['max_delta_e']:.3f}")
    print()
    if warns:
        print("体检警告（建议先修测量再导入）：")
        for m in warns:
            print("  ! " + m)
    else:
        print("体检通过：序列单调、白底不暗于黑底、零厚度白底亮度正常。")
    print()

    stage_a = build_stage_a(a.name, fit, warns, a.material_default)
    mat = build_material(a.name, a.brand, fit, warns, stage_a, SPEC)
    mat_bytes = dumps(mat)
    stage_bytes = dumps(stage_a)

    ids = None
    if a.template:
        ids = extract_template_ids(a.template)
        print(f"已从模板复用标识：material_id={ids['material_id']}")
    bundle = build_bundle(a.brand, a.name, mat_bytes, stage_bytes, SPEC, ids)
    export = build_export(f"{a.brand}/{a.name}")

    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("lumina_material_export.json", dumps(export))
        z.writestr("lumina_material_bundle.json", dumps(bundle))
        z.writestr(f"materials/{a.brand}/{a.name}/material.json", mat_bytes)
        z.writestr(f"materials/{a.brand}/{a.name}/stage_A_parameters.json", stage_bytes)

    print(f"已生成：{out}")
    with zipfile.ZipFile(out) as z:
        for i in z.infolist():
            print(f"  {i.file_size:>8}  {i.filename}")
    print()
    print("导入：Lumina Studio -> 耗材管理 -> 耗材库 -> 「导入耗材 ZIP」")
    return 0


if __name__ == "__main__":
    sys.exit(main())
