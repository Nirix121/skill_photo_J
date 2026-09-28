#!/usr/bin/env python3
"""Measure rough look metrics of jewelry photos for comparison with the references.

Prints, for each supplied image, the background level and neutrality, the tone
distribution of the product, the share of very dark product pixels, and the
product bounding box with its margins. Use it to compare a saved result with
the bundled references (--with-references) next to the visual inspection.

The numbers are guidance, not acceptance thresholds, and nothing here passes or
fails. The product mask is a crude threshold against the background level: it
may include the darker part of a shadow and miss near-white highlights. Never
use it as an allowed or protected retouch mask.

Inputs are .npy arrays (H-by-W-by-3/4, integer or 0..1 float) or image files
decoded with Pillow, if Pillow is installed. Values are reported on the 0..255
scale of encoded (not linearized) channel values; the ICC profile is ignored.

Example:
  python measure_look.py result.png --with-references --table
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

import numpy as np


REFERENCE_DIR = Path(__file__).resolve().parent.parent / "assets"
DARK_LEVEL = 60.0


def load_rgb(path: Path) -> tuple[np.ndarray, dict]:
    info: dict = {"path": str(path)}
    if path.suffix.lower() == ".npy":
        array = np.load(path, allow_pickle=False)
    else:
        try:
            from PIL import Image
        except ImportError as error:
            raise ValueError(f"{path}: Pillow is required for image files; pass a decoded .npy instead") from error
        with Image.open(path) as image:
            info["format"] = image.format
            info["mode"] = image.mode
            array = np.asarray(image)
    if array.ndim != 3 or array.shape[2] not in (3, 4) or 0 in array.shape:
        raise ValueError(f"{path}: expected H-by-W-by-3 or H-by-W-by-4 array, got {array.shape}")
    if array.dtype.kind in "ui":
        scale = 255.0 / np.iinfo(array.dtype).max
    elif array.dtype.kind == "f":
        scale = 255.0
    else:
        raise ValueError(f"{path}: unsupported dtype {array.dtype}")
    info.update(shape=list(array.shape), dtype=array.dtype.str)
    rgb = array[..., :3].astype(np.float64) * scale
    if array.shape[2] == 4:
        alpha = array[..., 3].astype(np.float64) * scale
        info["alpha_fully_opaque"] = bool((alpha >= 254.5).all())
    return rgb, info


def rounded(values) -> list[float]:
    return [round(float(v), 1) for v in np.atleast_1d(values)]


def measure(rgb: np.ndarray, bg_delta: float, border: float) -> dict:
    height, width, _ = rgb.shape
    lum = rgb.mean(axis=2)
    chroma = rgb.max(axis=2) - rgb.min(axis=2)

    strip = max(2, int(round(min(height, width) * border)))
    frame = np.zeros((height, width), dtype=bool)
    frame[:strip], frame[-strip:], frame[:, :strip], frame[:, -strip:] = True, True, True, True
    corners = [rgb[:strip, :strip], rgb[:strip, -strip:], rgb[-strip:, :strip], rgb[-strip:, -strip:]]
    corner_means = [c.reshape(-1, 3).mean(axis=0) for c in corners]
    bg_level = float(np.median([m.mean() for m in corner_means]))

    result = {
        "background": {
            "corner_mean_rgb": [rounded(m) for m in corner_means],
            "level": round(bg_level, 1),
            "border_strip_lum_min_median_max": rounded(np.percentile(lum[frame], [0, 50, 100])),
            "border_strip_chroma_p99": round(float(np.percentile(chroma[frame], 99)), 1),
        }
    }

    product = lum < bg_level - bg_delta
    if not product.any():
        result["product"] = None
        result["notice"] = "No pixels darker than background by --bg-delta; product metrics skipped."
        return result
    ys, xs = np.nonzero(product)
    left, top, right, bottom = int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1
    box_rgb = rgb[top:bottom, left:right]
    result["product"] = {
        "threshold_lum_below": round(bg_level - bg_delta, 1),
        "pixel_count": int(product.sum()),
        "lum_percentiles_5_25_50_75_95": rounded(np.percentile(lum[product], [5, 25, 50, 75, 95])),
        "dark_fraction_lum_below_60": round(float((lum[product] < DARK_LEVEL).mean()), 4),
        "chroma_median_p95": rounded(np.percentile(chroma[product], [50, 95])),
        "mean_blue_minus_red": round(float((rgb[..., 2] - rgb[..., 0])[product].mean()), 2),
        "clipped_fraction_in_bbox": (
            round(float((box_rgb.min(axis=2) >= 254.5).mean()), 4) if bg_level < 253 else None
        ),
    }
    result["framing"] = {
        "bbox_left_top_right_bottom": [left, top, right, bottom],
        "margins_left_top_right_bottom": [left, top, width - right, height - bottom],
        "fill_width_height": [round((right - left) / width, 3), round((bottom - top) / height, 3)],
        "center_offset_x_y": [
            round(((left + right) / 2 - width / 2) / width, 3),
            round(((top + bottom) / 2 - height / 2) / height, 3),
        ],
    }
    return result


def table_row(name: str, item: dict) -> str:
    if "error" in item:
        return f"{name:<34} ERROR {item['error']}"
    bg = item["background"]
    line = f"{name:<34} bg {bg['level']:>5.1f} chroma99 {bg['border_strip_chroma_p99']:>4.1f}"
    product = item.get("product")
    if product:
        p5, _, p50, _, p95 = product["lum_percentiles_5_25_50_75_95"]
        fw, fh = item["framing"]["fill_width_height"]
        ox, oy = item["framing"]["center_offset_x_y"]
        line += (
            f" | L p5 {p5:>5.1f} p50 {p50:>5.1f} p95 {p95:>5.1f}"
            f" dark {product['dark_fraction_lum_below_60']:.3f} B-R {product['mean_blue_minus_red']:>+5.2f}"
            f" | fill {fw:.2f}x{fh:.2f} offset {ox:+.3f},{oy:+.3f}"
        )
    return line


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("images", nargs="*", type=Path, help=".npy arrays or image files to measure")
    parser.add_argument("--with-references", action="store_true", help="also measure assets/reference-*.png")
    parser.add_argument("--bg-delta", type=float, default=25.0, help="product = mean channel below background level minus this (default 25)")
    parser.add_argument("--border", type=float, default=0.03, help="border strip and corner size as a fraction of the short side (default 0.03)")
    parser.add_argument("--table", action="store_true", help="print a compact table instead of JSON")
    args = parser.parse_args()

    paths = list(args.images)
    if args.with_references:
        paths += sorted(REFERENCE_DIR.glob("reference-*.png"))
    if not paths:
        parser.error("supply at least one image or --with-references")

    results = []
    exit_code = 0
    for path in paths:
        try:
            rgb, info = load_rgb(path)
            results.append({**info, **measure(rgb, args.bg_delta, args.border)})
        except (OSError, ValueError) as error:
            results.append({"path": str(path), "error": str(error)})
            exit_code = 2

    if args.table:
        for item in results:
            print(table_row(Path(item["path"]).name, item))
    else:
        print(json.dumps({"schema_version": 1, "guidance_only": True, "images": results}, indent=2, ensure_ascii=False))
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
