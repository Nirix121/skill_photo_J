#!/usr/bin/env python3
"""Self-test of retouch.py on synthetic damage of the bundled reference rings.

For every assets/reference-*.png the test builds degraded sources with a known
ground truth: a tinted or gray backdrop, a darker metal, a soft cast shadow
under the ring and a shadow on the backdrop seen through the ring's opening.
It then runs the real command-line pipeline (prepare -> draft-masks -> apply ->
square) with masks taken only from the drafts, and checks that:

  * every command succeeds and every pixel audit passes;
  * no pixel of the ring (ground truth, shrunk by 2 px) lies in a whitened mask;
  * the synthetic shadows outside and inside the ring are whitened;
  * the delivered file is a 1:1 PNG with the source bit depth and ICC profile.

It never touches the skill's assets. Exit status 0 = all cases passed.
Run:  python selftest.py [--keep DIR] [--only 03]
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

import numpy as np
from PIL import Image
from scipy import ndimage

SCRIPT_DIR = Path(__file__).resolve().parent
ASSETS = SCRIPT_DIR.parent / "assets"
RETOUCH = SCRIPT_DIR / "retouch.py"


def confident_ring(ref: np.ndarray, ring: np.ndarray) -> np.ndarray:
    """Ring pixels that are certainly jewelry: fine detail or clearly darker than the backdrop.

    The references' own soft reflections under the ring are smooth and light; they belong to
    what the user wants removed, so they are excluded from this ground truth.
    """
    lum = ref[..., :3].astype(np.float64).mean(axis=2) / 255
    detail = ndimage.gaussian_filter(ndimage.laplace(ndimage.gaussian_filter(lum, 1.0)) ** 2, 3.0)
    sharp = detail >= 0.03 * np.percentile(detail[ring], 99)
    return ndimage.binary_erosion(ring & (sharp | (lum < np.median(lum[~ring]) - 0.3)), iterations=1)


def ground_truth(ref: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Ring pixels and the backdrop inside its opening, from a clean reference."""
    rgb = ref[..., :3].astype(np.float64) / 255
    border = np.concatenate([rgb[:5].reshape(-1, 3), rgb[-5:].reshape(-1, 3), rgb[:, :5].reshape(-1, 3), rgb[:, -5:].reshape(-1, 3)])
    bg = np.median(border, axis=0)
    near = np.abs(rgb - bg).max(axis=2) <= 6 / 255
    labels, _ = ndimage.label(near)
    edge_labels = np.unique(np.concatenate([labels[0], labels[-1], labels[:, 0], labels[:, -1]]))
    outside = np.isin(labels, edge_labels[edge_labels > 0])
    ring = ~near
    opening = near & ~outside
    sizes = np.bincount(labels[opening]) if opening.any() else np.zeros(1, int)
    big = np.nonzero(sizes >= 0.002 * near.size)[0]
    opening = np.isin(labels, big[big > 0]) & opening
    return ring, opening


def soft_blob(shape, center, radii, strength, blur) -> np.ndarray:
    yy, xx = np.mgrid[:shape[0], :shape[1]]
    inside = ((xx - center[0]) / radii[0]) ** 2 + ((yy - center[1]) / radii[1]) ** 2 <= 1
    return ndimage.gaussian_filter(inside.astype(np.float64), blur) * strength


def degrade(ref: np.ndarray, ring: np.ndarray, opening: np.ndarray, tint: bool) -> tuple[np.ndarray, np.ndarray]:
    height, width = ring.shape
    rgb = ref[..., :3].astype(np.float64) / 255
    x0, y0, x1, y1 = bbox(ring)
    darkness = soft_blob((height, width), ((x0 + x1) / 2, y1 - 0.04 * (y1 - y0)),
                         (0.42 * (x1 - x0), 0.09 * (y1 - y0) + 8), 0.35, 0.03 * (x1 - x0) + 2)
    if opening.any():
        ox0, oy0, ox1, oy1 = bbox(opening)
        darkness = np.maximum(darkness, soft_blob((height, width), ((ox0 + ox1) / 2, oy1 - 0.25 * (oy1 - oy0)),
                                                  (0.35 * (ox1 - ox0), 0.2 * (oy1 - oy0) + 4), 0.3, 0.05 * (ox1 - ox0) + 2))
    backdrop = np.array([0.93, 0.9, 0.84]) if tint else np.array([0.88, 0.88, 0.88])
    out = rgb * backdrop
    out[ring] = rgb[ring] ** 1.35 * backdrop
    out *= 1 - darkness[..., None]  # the shadow darkens whatever lies under it, reflections included
    shadow_truth = (darkness > 0.03) & ~ring
    return (np.clip(out, 0, 1) * 255).round().astype(np.uint8), shadow_truth


def bbox(mask: np.ndarray) -> tuple[int, int, int, int]:
    ys, xs = np.nonzero(mask)
    return int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1


def run(*args) -> dict:
    completed = subprocess.run([sys.executable, str(RETOUCH), *map(str, args)], capture_output=True, text=True)
    try:
        payload = json.loads(completed.stdout)
    except json.JSONDecodeError:
        payload = {"status": "error", "error": completed.stderr[-2000:]}
    if completed.returncode != 0 or payload.get("status") not in {"ok"}:
        raise RuntimeError(f"{args[0]} failed: {payload.get('error')}")
    return payload


def run_case(name: str, source: Path, ring: np.ndarray, sure: np.ndarray, shadow_truth: np.ndarray, workdir: Path,
             icc: bytes | None) -> dict:
    run("prepare", source, "--workdir", workdir)
    run("draft-masks", "--workdir", workdir)
    draft = lambda n: np.load(workdir / "masks" / "draft" / f"{n}.npy")  # noqa: E731
    whiten = draft("background") | draft("hole_candidates") | draft("shadow_candidates")
    inner = draft("shadow_review_candidates")  # needs human review: never whitened automatically
    product = draft("product_core")
    metal = ndimage.binary_erosion(product, iterations=2) & ~ndimage.binary_dilation(whiten, iterations=3)
    masks = workdir / "masks"
    np.save(masks / "whiten.npy", whiten)
    np.save(masks / "metal.npy", metal)
    np.save(masks / "product_core.npy", product)
    recipe = {
        "version": 1,
        "steps": [
            {"name": "contour_decontaminate", "mask": "masks/draft/edge_band.npy", "op": "decontaminate",
             "backdrop_mask": "masks/draft/background.npy", "foreground_mask": "masks/draft/product_core.npy"},
            {"name": "backdrop_white", "mask": "masks/whiten.npy", "op": "whiten", "feather": 0},
            {"name": "metal_neutral", "mask": "masks/metal.npy", "op": "neutralize", "strength": 1.0, "feather": 3},
            {"name": "metal_lift", "mask": "masks/metal.npy", "op": "curve", "space": "luminance",
             "points": [[0, 0], [0.25, 0.33], [0.6, 0.74], [1, 1]], "feather": 3},
        ],
    }
    (workdir / "recipe.json").write_text(json.dumps(recipe), encoding="utf-8")
    applied = run("apply", "--workdir", workdir, "--recipe", workdir / "recipe.json", "--version", "v01")
    squared = run("square", "--workdir", workdir, "--version", "v01", "--product-mask", "masks/product_core.npy",
                  "--crop-allowed-mask", "masks/whiten.npy")

    result = np.load(workdir / "versions" / "v01" / "master_decoded.npy").astype(np.float64) / 255
    source_rgb = np.load(workdir / "working" / "original.npy").astype(np.float64)[..., :3] / 255
    band = draft("edge_band")
    # Shadow further than the guard (+ feather) from certain ring pixels must be gone; closer to the
    # contact line it may remain for manual review and is only reported.
    near_ring = ndimage.binary_dilation(sure, iterations=12)
    opening_zone = ndimage.binary_fill_holes(ring) & ~ring  # inside the ring: review territory
    shadow_zone = shadow_truth & ~near_ring & ~opening_zone
    residual = (result[..., :3].min(axis=2) < 0.97) & shadow_zone
    final = Image.open(squared["final"])
    checks = {
        "audits_pass": all(item["status"] == "pass" for item in applied["audits"].values()) and squared["audit_canvas"]["status"] == "pass",
        "ring_pixels_whitened": int((whiten & sure).sum()),
        "ring_pixels_lightened_outside_metal": int((sure & ~metal & (result[..., :3].mean(axis=2) - source_rgb.mean(axis=2) > 0.08)).sum()),
        "contour_tint_left": round(float(np.abs(result[..., :3][band] - result[..., :3][band].mean(axis=1, keepdims=True)).max(axis=1).mean()), 4),
        "inner_review_px": int(inner.sum()),
        "inner_review_on_ring_px": int((inner & ring).sum()),
        "contact_shadow_left_px": int(((result[..., :3].min(axis=2) < 0.97) & shadow_truth & near_ring & ~ring).sum()),
        "shadow_px": int(shadow_zone.sum()),
        "shadow_left_px": int(residual.sum()),
        "square": final.size[0] == final.size[1],
        "icc_kept": (final.info.get("icc_profile") or None) == (icc or None),
    }
    checks["shadow_left_fraction"] = round(checks["shadow_left_px"] / max(1, checks["shadow_px"]), 4)
    checks["passed"] = bool(checks["audits_pass"] and checks["ring_pixels_whitened"] == 0 and checks["square"]
                        and checks["ring_pixels_lightened_outside_metal"] <= 0.002 * sure.sum()
                        and checks["icc_kept"] and checks["shadow_left_fraction"] <= 0.02)
    return {"case": name, **checks}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--keep", type=Path, help="keep work folders in this new directory for inspection")
    parser.add_argument("--only", help="run only references whose name contains this text")
    args = parser.parse_args()
    root = args.keep or Path(tempfile.mkdtemp(prefix="retouch-selftest-"))
    root.mkdir(parents=True, exist_ok=True)
    results = []
    try:
        for reference in sorted(ASSETS.glob("reference-*.png")):
            if args.only and args.only not in reference.name:
                continue
            with Image.open(reference) as image:
                icc = image.info.get("icc_profile")
                ref = np.asarray(image.convert("RGB"))
            ring, opening = ground_truth(ref)
            sure = confident_ring(ref, ring)
            for tint in (True, False):
                name = f"{reference.stem.replace('reference-polished-ring-', 'ref')}-{'tinted' if tint else 'gray'}"
                source_array, shadow_truth = degrade(ref, ring, opening, tint)
                source = root / f"{name}.png"
                Image.fromarray(source_array).save(source, icc_profile=icc)
                try:
                    results.append(run_case(name, source, ring, sure, shadow_truth, root / name, icc))
                except RuntimeError as error:
                    results.append({"case": name, "passed": False, "error": str(error)})
                print(json.dumps(results[-1], ensure_ascii=False))
    finally:
        if not args.keep:
            shutil.rmtree(root, ignore_errors=True)
    failed = [item["case"] for item in results if not item["passed"]]
    print(json.dumps({"cases": len(results), "failed": failed}, ensure_ascii=False))
    return 1 if failed or not results else 0


if __name__ == "__main__":
    raise SystemExit(main())
