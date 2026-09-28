#!/usr/bin/env python3
"""Reproducible, non-generative jewelry retouch pipeline built around the skill's checks.

Subcommands (see "retouch.py <command> --help"):
  prepare      decode the source once into an immutable working original
  draft-masks  write DRAFT background/product/edge masks, a focus map and an overlay
  overlay      render masks over the working original or a version for review
  apply        apply a JSON recipe of masked, feathered tone steps from the working
               original; save a lossless master, re-open it, run audit_pixels.py
               and measure_look.py
  square       center the product on a 1:1 white canvas without resampling; save,
               re-open and run audit_canvas.py (the default delivery format)

Nothing here generates, clones, inpaints, resamples or recognizes jewelry. Draft
masks are plain thresholds: review and correct them before use. Final masks,
the recipe and the visual comparison with the references remain the operator's
responsibility. A passing audit does not prove the retouch looks right.

Workdir layout:
  working/original.npy, working/meta.json, working/profile.icc
  masks/draft/...                 draft masks written by draft-masks
  masks/*.npy|png                 final, reviewed masks referenced by recipes
  versions/<name>/...             one immutable folder per apply run
  versions/<name>/<square>/...    1:1 delivery made from that version

Requires NumPy, Pillow and SciPy. OpenCV (opencv-python-headless) is needed only
for 16-bit sources and to independently re-open 16-bit exports; without it such
files fail instead of being silently reduced to 8 bits.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import math
from pathlib import Path
import struct
import subprocess
import sys
import zlib

import numpy as np

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
LUMA = np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
COLORS = {
    "red": (255, 40, 40), "green": (40, 220, 40), "blue": (40, 110, 255),
    "yellow": (255, 220, 0), "magenta": (255, 0, 200), "cyan": (0, 220, 230),
}
# EXIF orientation -> transform giving the visible orientation (same as Pillow's exif_transpose).
ORIENTATION = {
    1: lambda a: a,
    2: lambda a: a[:, ::-1],
    3: lambda a: a[::-1, ::-1],
    4: lambda a: a[::-1],
    5: lambda a: a.swapaxes(0, 1),
    6: lambda a: np.rot90(a, -1),
    7: lambda a: a.swapaxes(0, 1)[::-1, ::-1],
    8: lambda a: np.rot90(a, 1),
}


class PipelineError(Exception):
    """An input or state problem the operator has to resolve."""


# ---------------------------------------------------------------------------
# small helpers


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def sha256_array(array: np.ndarray) -> str:
    digest = hashlib.sha256()
    digest.update(f"{array.dtype.str}{array.shape}".encode())
    digest.update(np.ascontiguousarray(array).tobytes())
    return digest.hexdigest()


def write_json(path: Path, data: dict) -> None:
    with path.open("x", encoding="utf-8") as stream:
        json.dump(data, stream, indent=2, ensure_ascii=False)
        stream.write("\n")


def save_npy(path: Path, array: np.ndarray) -> None:
    with path.open("xb") as stream:
        np.save(stream, array, allow_pickle=False)


def max_value(dtype: np.dtype) -> int:
    return int(np.iinfo(dtype).max)


def new_dir(path: Path) -> Path:
    if path.exists():
        raise PipelineError(f"{path} already exists; results are never overwritten, choose a new name")
    path.mkdir(parents=True)
    return path


def require_cv2(reason: str):
    try:
        import cv2  # noqa: PLC0415
    except ImportError as error:
        raise PipelineError(f"OpenCV is required to {reason}; install opencv-python-headless") from error
    return cv2


def preview8(array: np.ndarray) -> np.ndarray:
    """8-bit RGB copy for diagnostic previews only (never a deliverable)."""
    rgb = array[..., :3]
    if rgb.dtype == np.uint16:
        rgb = (rgb.astype(np.uint32) * 255 + 32767) // 65535
    return rgb.astype(np.uint8)


def save_preview(path: Path, rgb8: np.ndarray) -> None:
    from PIL import Image  # noqa: PLC0415

    with path.open("xb") as stream:
        Image.fromarray(np.ascontiguousarray(rgb8), "RGB").save(stream, format="PNG")


# ---------------------------------------------------------------------------
# decoding and lossless PNG export


def png_bit_depth(path: Path) -> int | None:
    with path.open("rb") as stream:
        if stream.read(8) != PNG_SIGNATURE:
            return None
        _length, kind = struct.unpack(">I4s", stream.read(8))
        if kind != b"IHDR":
            raise PipelineError(f"{path}: malformed PNG header")
        return stream.read(13)[8]


def decode_image(path: Path) -> tuple[np.ndarray, dict]:
    """Decode once, apply EXIF orientation, keep bit depth. Returns (array, metadata)."""
    from PIL import Image  # noqa: PLC0415

    info: dict = {"transforms": []}
    with Image.open(path) as image:
        info.update(format=image.format, pillow_mode=image.mode, size_wh=list(image.size))
        icc = image.info.get("icc_profile")
        orientation = int(image.getexif().get(0x0112, 1) or 1)
        depth = 8
        if image.format == "PNG":
            depth = png_bit_depth(path) or 8
        elif image.format == "TIFF":
            bits = image.tag_v2.get(258, 8)
            depth = max(bits) if isinstance(bits, tuple) else int(bits)
        if image.format in {"DNG", "CR2", "NEF", "ARW"}:
            raise PipelineError("RAW files must be developed first; record the development settings and pass the developed file")
        if depth > 8:
            info["decoder"] = "opencv IMREAD_UNCHANGED (pixels) + Pillow (metadata)"
            array = None
        else:
            info["decoder"] = f"Pillow {Image.__version__}"
            mode = image.mode
            if mode in {"RGB", "RGBA"}:
                array = np.asarray(image)
            elif mode == "P":
                target = "RGBA" if "transparency" in image.info else "RGB"
                array = np.asarray(image.convert(target))
                info["transforms"].append(f"palette expanded to {target} (lossless)")
            elif mode in {"L", "LA"}:
                gray = np.asarray(image)
                if mode == "LA":
                    array = np.dstack([gray[..., 0]] * 3 + [gray[..., 1]])
                else:
                    array = np.dstack([gray] * 3)
                info["transforms"].append(f"{mode} replicated to RGB channels (lossless)")
            else:
                raise PipelineError(f"unsupported mode {mode}; convert it deliberately and record the conversion")
    if array is None:
        cv2 = require_cv2(f"decode a {depth}-bit source without losing precision")
        array = cv2.imread(str(path), cv2.IMREAD_UNCHANGED)
        if array is None or array.dtype != np.uint16:
            raise PipelineError(f"{path}: OpenCV could not decode it as 16-bit")
        if array.ndim == 2:
            array = np.dstack([array] * 3)
            info["transforms"].append("gray replicated to RGB channels (lossless)")
        elif array.shape[2] == 3:
            array = array[..., ::-1]
        elif array.shape[2] == 4:
            array = array[..., [2, 1, 0, 3]]
        else:
            raise PipelineError(f"{path}: unsupported channel count {array.shape[2]}")
    if orientation not in ORIENTATION:
        raise PipelineError(f"unknown EXIF orientation {orientation}")
    if orientation != 1:
        array = ORIENTATION[orientation](array)
        info["transforms"].append(f"EXIF orientation {orientation} applied to pixels")
    info.update(bit_depth=depth, exif_orientation=orientation, icc_profile=icc)
    return np.ascontiguousarray(array), info


def write_png(path: Path, array: np.ndarray, icc: bytes | None) -> None:
    """Lossless 8/16-bit RGB(A) PNG with Paeth filtering and an optional iCCP chunk."""
    if array.ndim != 3 or array.shape[2] not in (3, 4) or array.dtype not in (np.uint8, np.uint16):
        raise PipelineError("PNG export expects H-by-W-by-3/4 uint8 or uint16")
    height, width, channels = array.shape
    depth = 8 * array.dtype.itemsize
    color_type = 2 if channels == 3 else 6
    bpp = channels * array.dtype.itemsize
    raw = np.ascontiguousarray(array.astype(array.dtype.newbyteorder(">"), copy=False))
    rows = raw.view(np.uint8).reshape(height, width * bpp)

    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    compressor = zlib.compressobj(6)
    idat = []
    block = max(1, 4_000_000 // max(1, rows.shape[1]))
    for start in range(0, height, block):
        cur = rows[start:start + block].astype(np.int16)
        up = np.zeros_like(cur)
        if start > 0:
            up[0] = rows[start - 1]
        up[1:] = cur[:-1]
        left = np.zeros_like(cur)
        left[:, bpp:] = cur[:, :-bpp]
        upleft = np.zeros_like(cur)
        upleft[:, bpp:] = up[:, :-bpp]
        estimate = left + up - upleft
        pa, pb, pc = np.abs(estimate - left), np.abs(estimate - up), np.abs(estimate - upleft)
        predictor = np.where((pa <= pb) & (pa <= pc), left, np.where(pb <= pc, up, upleft))
        filtered = ((cur - predictor) & 0xFF).astype(np.uint8)
        payload = np.hstack([np.full((filtered.shape[0], 1), 4, np.uint8), filtered])
        idat.append(compressor.compress(payload.tobytes()))
    idat.append(compressor.flush())
    parts = [PNG_SIGNATURE, chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, depth, color_type, 0, 0, 0))]
    if icc:
        parts.append(chunk(b"iCCP", b"ICC profile\x00\x00" + zlib.compress(icc, 9)))
    parts.append(chunk(b"IDAT", b"".join(idat)))
    parts.append(chunk(b"IEND", b""))
    with path.open("xb") as stream:
        stream.write(b"".join(parts))


def reopen_png(path: Path, expected: np.ndarray, icc: bytes | None) -> np.ndarray:
    """Re-open an export with an independent decoder and require an exact match."""
    from PIL import Image  # noqa: PLC0415

    with Image.open(path) as image:
        saved_icc = image.info.get("icc_profile")
        if expected.dtype == np.uint8:
            decoded = np.asarray(image)
    if expected.dtype == np.uint16:
        cv2 = require_cv2("re-open a 16-bit export for verification")
        decoded = cv2.imread(str(path), cv2.IMREAD_UNCHANGED)
        decoded = decoded[..., ::-1] if decoded.shape[2] == 3 else decoded[..., [2, 1, 0, 3]]
    decoded = np.ascontiguousarray(decoded)
    if decoded.shape != expected.shape or decoded.dtype != expected.dtype or not np.array_equal(decoded, expected):
        raise PipelineError(f"{path}: re-opened pixels differ from the array that was written")
    if (saved_icc or None) != (icc or None):
        raise PipelineError(f"{path}: ICC profile was not preserved")
    return decoded


# ---------------------------------------------------------------------------
# workdir state


def load_working(workdir: Path) -> tuple[np.ndarray, dict, bytes | None]:
    meta_path = workdir / "working" / "meta.json"
    if not meta_path.is_file():
        raise PipelineError(f"{workdir}: run 'prepare' first")
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    original = np.load(workdir / "working" / "original.npy", allow_pickle=False)
    if sha256_array(original) != meta["working_original"]["sha256"]:
        raise PipelineError("working original changed since prepare; it must stay immutable")
    icc_path = workdir / "working" / "profile.icc"
    return original, meta, icc_path.read_bytes() if icc_path.is_file() else None


def load_mask(path: Path, shape: tuple[int, int]) -> np.ndarray:
    if path.suffix.lower() == ".npy":
        mask = np.load(path, allow_pickle=False)
    else:
        from PIL import Image  # noqa: PLC0415

        with Image.open(path) as image:
            mask = np.asarray(image.convert("L"))
    if mask.shape != shape:
        raise PipelineError(f"{path}: mask shape {mask.shape} does not match image {shape}")
    values = np.unique(mask)
    if not (np.isin(values, (0, 1)).all() or np.isin(values, (0, 255)).all()):
        raise PipelineError(f"{path}: masks must be binary (bool, 0/1 or 0/255)")
    return mask != 0


def resolve(workdir: Path, name: str) -> Path:
    path = Path(name)
    return path if path.is_absolute() else workdir / path


def bbox(mask: np.ndarray) -> tuple[int, int, int, int]:
    ys, xs = np.nonzero(mask)
    if ys.size == 0:
        raise PipelineError("mask is empty")
    return int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1


# ---------------------------------------------------------------------------
# prepare


def cmd_prepare(args) -> dict:
    source = args.source.resolve()
    working = new_dir(args.workdir / "working")
    array, info = decode_image(source)
    icc = info.pop("icc_profile")
    save_npy(working / "original.npy", array)
    if icc:
        (working / "profile.icc").write_bytes(icc)
    meta = {
        "created": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "source": {"path": str(source), "sha256": sha256_file(source), **{k: info[k] for k in ("format", "pillow_mode", "size_wh", "bit_depth", "exif_orientation")}},
        "decoder": info["decoder"],
        "transforms": info["transforms"],
        "icc_profile": {"present": bool(icc), "sha256": hashlib.sha256(icc).hexdigest() if icc else None},
        "working_original": {"shape": list(array.shape), "dtype": array.dtype.str, "sha256": sha256_array(array)},
    }
    if array.shape[2] == 4:
        meta["working_original"]["alpha_fully_opaque"] = bool((array[..., 3] == max_value(array.dtype)).all())
    write_json(working / "meta.json", meta)
    return meta


# ---------------------------------------------------------------------------
# draft masks and overlays


def cmd_draft_masks(args) -> dict:
    from scipy import ndimage  # noqa: PLC0415

    original, _meta, _icc = load_working(args.workdir)
    out = args.workdir / "masks" / "draft"
    if out.exists() and not args.overwrite:
        raise PipelineError(f"{out} exists; pass --overwrite to replace the drafts")
    out.mkdir(parents=True, exist_ok=True)
    for old in out.iterdir():
        old.unlink()
    rgb = original[..., :3].astype(np.float32) / max_value(original.dtype)
    height, width = rgb.shape[:2]
    strip = max(2, round(min(height, width) * 0.02))
    border = np.zeros((height, width), bool)
    border[:strip], border[-strip:], border[:, :strip], border[:, -strip:] = True, True, True, True
    bg_color = np.median(rgb[border], axis=0)
    near = np.abs(rgb - bg_color).max(axis=2) <= args.bg_tolerance
    labels, _count = ndimage.label(near)
    border_labels = np.unique(labels[border & near])
    background = np.isin(labels, border_labels[border_labels > 0])
    product = ~background

    # Background-colored areas enclosed by the product: a ring's opening or cut-outs showing
    # the backdrop (small ones are usually highlights and are ignored).
    min_hole = max(1, round(height * width * args.min_hole_fraction))
    holes = []
    hole_full = np.zeros((height, width), bool)
    hole_labels, _ = ndimage.label(near & ~background)
    for index, box in enumerate(ndimage.find_objects(hole_labels), start=1):
        component = hole_labels[box] == index
        area = int(component.sum())
        if area >= min_hole:
            hole_full[box] |= component
            holes.append({"area": area, "bbox_ltrb": [box[1].start, box[0].start, box[1].stop, box[0].stop]})

    luminance = rgb @ LUMA
    laplacian = ndimage.laplace(ndimage.gaussian_filter(luminance, 1.0))
    energy = ndimage.gaussian_filter(laplacian * laplacian, 3.0)
    scale = float(np.percentile(energy[product], 99)) if product.any() else float(energy.max() or 1.0)
    focus = np.clip(energy / (scale or 1.0), 0, 1).astype(np.float32)

    # Shadow / reflection candidates: smooth, backdrop-tinted areas of the product mask. They keep
    # a guard distance from confident product pixels (fine detail or darker than any shadow), so
    # blurred metal next to sharp detail is not taken for a shadow.
    bg_lum = float(bg_color @ LUMA)
    chromaticity = rgb / np.maximum(rgb.sum(axis=2, keepdims=True), 1e-6)
    bg_chromaticity = bg_color / max(float(bg_color.sum()), 1e-6)
    shadow_range = luminance >= bg_lum - args.shadow_depth
    # A shadow or reflection never gets brighter than the backdrop, and its local contrast stays
    # low: polished jewelry puts dark reflections right next to bright highlights.
    not_brighter = luminance <= bg_lum + 0.01
    local_mean = ndimage.gaussian_filter(luminance, 3.0)
    amplitude = np.sqrt(np.maximum(ndimage.gaussian_filter(luminance * luminance, 3.0) - local_mean ** 2, 0))
    strong_detail = amplitude >= args.detail_amplitude * max(bg_lum, 1e-3)
    body = product & ~hole_full
    confident = body & (strong_detail | ~shadow_range | ~not_brighter)
    product_guard = ndimage.binary_dilation(confident, iterations=max(1, args.shadow_guard))
    shadow_like = (body & shadow_range & not_brighter & ~strong_detail & ~product_guard
                   & (np.abs(chromaticity - bg_chromaticity).max(axis=2) <= args.shadow_chroma))
    shadow_labels, _ = ndimage.label(shadow_like)

    def touching(region: np.ndarray) -> np.ndarray:
        reach = ndimage.binary_dilation(region, iterations=2)
        found = np.unique(shadow_labels[reach & shadow_like])
        return np.isin(shadow_labels, found[found > 0])

    # A jewelry piece standing on a surface casts its shadow and reflection BELOW itself. Only
    # components lying under the lowest confident jewelry pixel of their columns are proposed for
    # automatic whitening; anything else (light blurred metal beside the head, the backdrop seen
    # through the opening, side shadows of flat-lay shots) is offered for review only.
    columns = np.arange(width)
    has_conf = confident.any(axis=0)
    lowest = np.full(width, -1.0)
    if has_conf.any():
        lowest[has_conf] = height - 1 - np.argmax(confident[::-1, has_conf], axis=0)
        lowest = np.interp(columns, columns[has_conf], lowest[has_conf])
        lowest = ndimage.maximum_filter1d(lowest, size=max(3, 2 * args.shadow_guard + 1))
    under = np.arange(height)[:, None] > lowest[None, :]
    candidates = touching(background | hole_full)
    cand_labels, cand_count = ndimage.label(candidates)
    shadow_outer = np.zeros_like(candidates)
    if cand_count:
        under_share = ndimage.mean(under.astype(np.float32), cand_labels, index=np.arange(1, cand_count + 1))
        accepted = np.nonzero(np.asarray(under_share) >= 0.9)[0] + 1
        shadow_outer = np.isin(cand_labels, accepted) & under
    shadow_inner = candidates & ~shadow_outer

    # Uncertain band around what remains of the jewelry; nothing in it is whitened automatically.
    core = body & ~shadow_outer & ~shadow_inner
    distance = ndimage.distance_transform_edt(~core)
    edge_band = (distance > 0) & (distance <= args.edge_band)
    background_safe = background & ~edge_band
    hole_candidates = hole_full & ~edge_band
    shadow_candidates = shadow_outer & ~edge_band
    shadow_inner_candidates = shadow_inner & ~edge_band

    comp_labels, comp_count = ndimage.label(core)
    components = []
    for index, box in enumerate(ndimage.find_objects(comp_labels), start=1):
        area = int((comp_labels[box] == index).sum())
        components.append({"label": index, "area": area, "bbox_ltrb": [box[1].start, box[0].start, box[1].stop, box[0].stop]})
    components.sort(key=lambda item: item["area"], reverse=True)

    save_npy(out / "background.npy", background_safe)
    save_npy(out / "product.npy", product)
    save_npy(out / "product_core.npy", core)
    save_npy(out / "edge_band.npy", edge_band)
    save_npy(out / "hole_candidates.npy", hole_candidates)
    save_npy(out / "shadow_candidates.npy", shadow_candidates)
    save_npy(out / "shadow_review_candidates.npy", shadow_inner_candidates)
    save_npy(out / "product_guard.npy", product_guard)
    save_npy(out / "focus_map.npy", focus)
    save_preview(out / "focus_map.png", np.dstack([(focus * 255).astype(np.uint8)] * 3))
    overlay = preview8(original).astype(np.float32)
    for mask, color, alpha in ((background_safe, COLORS["blue"], 0.35), (edge_band, COLORS["yellow"], 0.6),
                               (hole_candidates, COLORS["magenta"], 0.35), (shadow_candidates, COLORS["green"], 0.45),
                               (shadow_inner_candidates, COLORS["red"], 0.45)):
        overlay[mask] = overlay[mask] * (1 - alpha) + np.array(color, np.float32) * alpha
    save_preview(out / "overlay.png", overlay.round().astype(np.uint8))
    report = {
        "mask_status": "draft_only",
        "warning": "Threshold drafts. Review overlay.png at full resolution and correct the masks before use.",
        "background_color_0_1": [round(float(v), 4) for v in bg_color],
        "bg_tolerance": args.bg_tolerance,
        "edge_band_px": args.edge_band,
        "shadow_guard_px": args.shadow_guard,
        "core_components_largest_first": components[:20],
        "core_component_count": int(comp_count),
        "hole_candidates": sorted(holes, key=lambda item: item["area"], reverse=True)[:20],
        "shadow_candidate_px": int(shadow_candidates.sum()),
        "shadow_review_candidate_px": int(shadow_inner_candidates.sum()),
        "overlay_colors": {"blue": "background.npy", "yellow": "edge_band.npy", "magenta": "hole_candidates.npy",
                           "green": "shadow_candidates.npy", "red": "shadow_review_candidates.npy (review!)"},
        "notes": [
            "Whiten set for a full shadow removal: background + hole_candidates + shadow_candidates (under the"
            " jewelry), and shadow_review_candidates only after checking each area is backdrop, not light or"
            " blurred metal (typical false alarm: the shank beside the head, the inner surface of the band).",
            "product_core.npy = product without backdrop-like areas: use it (reviewed) for centering and as the"
            " outer limit of metal and stone masks. product.npy is the raw threshold including shadows.",
            "edge_band.npy holds mixed contour pixels: never whiten it; use op 'decontaminate' on it to replace the"
            " old backdrop share with white. A contact shadow closer than --shadow-guard to the jewelry needs a"
            " reviewed manual mask.",
            "focus_map is a sharpness aid: bright = fine detail. It does not decide which stones are sharp.",
        ],
    }
    write_json(out / "draft_report.json", report)
    return report


def load_base(workdir: Path, base: str) -> np.ndarray:
    if base == "original":
        return load_working(workdir)[0]
    candidate = workdir / "versions" / base / "master_decoded.npy"
    path = candidate if candidate.is_file() else resolve(workdir, base)
    return np.load(path, allow_pickle=False)


def cmd_overlay(args) -> dict:
    image = load_base(args.workdir, args.base)
    canvas = preview8(image).astype(np.float32)
    used = []
    for spec in args.mask:
        name, _, color = spec.partition(":")
        color = color or "red"
        if color not in COLORS:
            raise PipelineError(f"unknown color {color}; use one of {', '.join(COLORS)}")
        mask = load_mask(resolve(args.workdir, name), image.shape[:2])
        canvas[mask] = canvas[mask] * (1 - args.alpha) + np.array(COLORS[color], np.float32) * args.alpha
        used.append({"mask": name, "color": color, "pixels": int(mask.sum())})
    if args.crop:
        left, top, right, bottom = args.crop
        canvas = canvas[top:bottom, left:right]
    if args.zoom > 1:
        canvas = canvas.repeat(args.zoom, axis=0).repeat(args.zoom, axis=1)
    save_preview(args.out, canvas.round().astype(np.uint8))
    return {"overlay": str(args.out), "masks": used, "crop": args.crop, "zoom": args.zoom}


# ---------------------------------------------------------------------------
# tone operations (all monotone per pixel, except the explicit local_contrast filter)


def monotone_curve(points) -> callable:
    """Fritsch-Carlson monotone cubic through control points on [0, 1]."""
    pts = np.asarray(points, dtype=np.float64)
    if pts.ndim != 2 or pts.shape[1] != 2 or len(pts) < 2:
        raise PipelineError("curve points must be a list of [x, y] pairs")
    x, y = pts[:, 0], pts[:, 1]
    if x[0] != 0 or x[-1] != 1 or np.any(np.diff(x) <= 0):
        raise PipelineError("curve x must start at 0, end at 1 and strictly increase")
    if np.any((y < 0) | (y > 1)) or np.any(np.diff(y) < 0):
        raise PipelineError("curve y must stay within [0, 1] and never decrease (monotone)")
    h = np.diff(x)
    delta = np.diff(y) / h
    m = np.zeros_like(y)
    m[0], m[-1] = delta[0], delta[-1]
    for i in range(1, len(y) - 1):
        m[i] = 0.0 if delta[i - 1] * delta[i] <= 0 else (delta[i - 1] + delta[i]) / 2
    for i, d in enumerate(delta):
        if d == 0:
            m[i] = m[i + 1] = 0.0
            continue
        a, b = m[i] / d, m[i + 1] / d
        if a * a + b * b > 9:
            t = 3 / math.sqrt(a * a + b * b)
            m[i], m[i + 1] = t * a * d, t * b * d

    def apply(values: np.ndarray) -> np.ndarray:
        v = np.clip(values, 0, 1).astype(np.float64)
        k = np.clip(np.searchsorted(x, v, side="right") - 1, 0, len(h) - 1)
        t = (v - x[k]) / h[k]
        t2, t3 = t * t, t * t * t
        out = ((2 * t3 - 3 * t2 + 1) * y[k] + (t3 - 2 * t2 + t) * h[k] * m[k]
               + (-2 * t3 + 3 * t2) * y[k + 1] + (t3 - t2) * h[k] * m[k + 1])
        return np.clip(out, 0, 1).astype(np.float32)

    return apply


def levels(step: dict) -> callable:
    black, white = float(step.get("in_black", 0.0)), float(step.get("in_white", 1.0))
    gamma = float(step.get("gamma", 1.0))
    out_black, out_white = float(step.get("out_black", 0.0)), float(step.get("out_white", 1.0))
    if not (0 <= black < white <= 1 and 0 <= out_black < out_white <= 1 and gamma > 0):
        raise PipelineError("levels need 0 <= in_black < in_white <= 1, 0 <= out_black < out_white <= 1, gamma > 0")

    def apply(values):
        norm = np.clip((values - black) / (white - black), 0, 1) ** (1 / gamma)
        return (out_black + (out_white - out_black) * norm).astype(np.float32)

    return apply


def in_space(rgb: np.ndarray, function, space: str) -> np.ndarray:
    if space == "rgb":
        return np.clip(function(rgb), 0, 1)
    if space != "luminance":
        raise PipelineError("space must be 'luminance' (keeps hue and saturation ratios) or 'rgb'")
    lum = rgb @ LUMA
    new = function(lum)
    safe = lum > 1e-6
    ratio = np.where(safe, new / np.where(safe, lum, 1), 1)
    out = np.where(safe[..., None], rgb * ratio[..., None], rgb + (new - lum)[..., None])
    return np.clip(out, 0, 1)


def run_step(rgb: np.ndarray, weight: np.ndarray, step: dict, extras: dict | None = None) -> tuple[np.ndarray, dict]:
    from scipy import ndimage  # noqa: PLC0415

    op = step.get("op")
    space = step.get("space", "luminance")
    details: dict = {}
    if op == "curve":
        target = in_space(rgb, monotone_curve(step["points"]), space)
    elif op == "levels":
        target = in_space(rgb, levels(step), space)
    elif op == "gains":
        gains = np.asarray(step["gains"], np.float32)
        if gains.shape != (3,) or np.any(gains <= 0):
            raise PipelineError("gains must be three positive RGB multipliers")
        target = np.clip(rgb * gains, 0, 1)
    elif op == "neutralize":
        strength = float(step.get("strength", 1.0))
        lum = rgb @ LUMA
        sample = (weight > 0) & (lum > 0.05) & (lum < 0.98)
        if sample.sum() < 50:
            raise PipelineError(f"step {step.get('name')}: too few mid-tone pixels to measure a cast")
        means = (rgb[sample] * weight[sample, None]).sum(0) / weight[sample].sum()
        gains = (means.mean() / means) ** strength
        details["measured_mean_rgb"] = [round(float(v), 4) for v in means]
        details["applied_gains"] = [round(float(v), 4) for v in gains]
        target = np.clip(rgb * gains.astype(np.float32), 0, 1)
    elif op == "whiten":
        target = np.ones_like(rgb)
    elif op == "decontaminate":
        # Mixed contour pixel p = a*B + (1-a)*F (old backdrop B, nearby jewelry color F): replace the
        # backdrop share by white, p + a*(1 - B). A pure jewelry pixel (a = 0) stays as it is.
        backdrop = extras["backdrop_rgb"]
        foreground = extras["foreground"].astype(np.float32)
        sigma = float(step.get("sigma", 3.0))
        norm = ndimage.gaussian_filter(foreground, sigma)
        local = np.dstack([ndimage.gaussian_filter(rgb[..., c] * foreground, sigma) for c in range(3)])
        has_fg = norm > 1e-3
        fg_color = np.where(has_fg[..., None], local / np.where(has_fg, norm, 1)[..., None], backdrop)
        direction = backdrop - fg_color
        length2 = (direction ** 2).sum(axis=2)
        usable = has_fg & (length2 >= float(step.get("min_contrast", 0.05)) ** 2 * 3)
        share = np.clip(((rgb - fg_color) * direction).sum(axis=2) / np.where(usable, length2, 1), 0, 1)
        share = np.where(usable, share, 0).astype(np.float32)
        details["backdrop_rgb"] = [round(float(v), 4) for v in backdrop]
        details["share_mean_in_mask"] = round(float(share[weight > 0].mean()) if (weight > 0).any() else 0.0, 4)
        target = np.clip(rgb + share[..., None] * (1 - backdrop), 0, 1)
    elif op == "local_contrast":
        sigma, amount = float(step.get("sigma", 2.0)), float(step.get("amount", 0.3))
        if sigma <= 0 or not 0 < amount <= 2:
            raise PipelineError("local_contrast needs sigma > 0 and 0 < amount <= 2")

        def boost(values):
            if values.ndim == 3:
                blurred = np.dstack([ndimage.gaussian_filter(values[..., c], sigma) for c in range(values.shape[2])])
            else:
                blurred = ndimage.gaussian_filter(values, sigma)
            return values + amount * (values - blurred)

        target = in_space(rgb, boost, space)
    else:
        raise PipelineError(f"unknown op {op!r}; use curve, levels, gains, neutralize, whiten, decontaminate or local_contrast")
    return (rgb + weight[..., None] * (target - rgb)).astype(np.float32), details


def feather_weight(allowed: np.ndarray, feather: float) -> np.ndarray:
    from scipy import ndimage  # noqa: PLC0415

    if feather <= 0:
        return allowed.astype(np.float32)
    distance = ndimage.distance_transform_edt(allowed)
    return np.clip(distance / feather, 0, 1).astype(np.float32)


def cmd_apply(args) -> dict:
    original, meta, icc = load_working(args.workdir)
    recipe_text = args.recipe.read_text(encoding="utf-8")
    recipe = json.loads(recipe_text)
    steps = recipe.get("steps") or []
    if not steps:
        raise PipelineError("recipe has no steps")
    shape = original.shape[:2]
    out_path = args.workdir / "versions" / args.version
    if out_path.exists():
        raise PipelineError(f"{out_path} already exists; results are never overwritten, choose a new name")

    permanent = np.zeros(shape, bool)
    for name in recipe.get("permanent_protect", []):
        permanent |= load_mask(resolve(args.workdir, name), shape)
    maxv = max_value(original.dtype)
    work = original[..., :3].astype(np.float32) / maxv
    allowed_total = np.zeros(shape, bool)
    step_reports = []
    for step in steps:
        name = step.get("name") or f"step{len(step_reports) + 1}"
        allowed = load_mask(resolve(args.workdir, step["mask"]), shape)
        protect = permanent.copy()
        for extra in step.get("protect", []):
            protect |= load_mask(resolve(args.workdir, extra), shape)
        overlap = int((allowed & protect).sum())
        if overlap:
            raise PipelineError(f"step {name}: allowed mask overlaps protection in {overlap} px; make the masks disjoint")
        if not allowed.any():
            raise PipelineError(f"step {name}: allowed mask is empty")
        feather = float(step.get("feather", 0))
        pad = int(math.ceil(feather + 4 * float(step.get("sigma", 0)))) + 2
        left, top, right, bottom = bbox(allowed)
        box = (slice(max(0, top - pad), min(shape[0], bottom + pad)), slice(max(0, left - pad), min(shape[1], right + pad)))
        weight = feather_weight(allowed[box], feather)
        extras = None
        if step.get("op") == "decontaminate":
            backdrop_mask = load_mask(resolve(args.workdir, step["backdrop_mask"]), shape)
            foreground = load_mask(resolve(args.workdir, step["foreground_mask"]), shape)
            if (foreground & allowed).any() or (backdrop_mask & allowed).any():
                raise PipelineError(f"step {name}: backdrop and foreground masks must not overlap the edited band")
            base_rgb = original[..., :3][backdrop_mask].astype(np.float32) / maxv
            if base_rgb.size == 0:
                raise PipelineError(f"step {name}: backdrop mask is empty")
            extras = {"backdrop_rgb": np.median(base_rgb, axis=0).astype(np.float32), "foreground": foreground[box]}
        work[box], details = run_step(work[box], weight, step, extras)
        allowed_total |= allowed
        step_reports.append({"name": name, "op": step.get("op"), "mask": step["mask"], "allowed_px": int(allowed.sum()),
                             "feather": feather, **details})

    quantized = np.rint(np.clip(work, 0, 1) * maxv).astype(original.dtype)
    result = original.copy()
    result[..., :3][allowed_total] = quantized[allowed_total]

    out_dir = new_dir(out_path)
    (out_dir / "recipe.json").write_text(recipe_text, encoding="utf-8")
    master = out_dir / f"{args.version}_master.png"
    write_png(master, result, icc)
    decoded = reopen_png(master, result, icc)
    save_npy(out_dir / "master_decoded.npy", decoded)
    save_npy(out_dir / "allowed_total.npy", allowed_total)
    save_npy(out_dir / "protected_total.npy", permanent)

    audits = {"vs_working_original": run_audit(
        "audit_pixels.py", out_dir / "audit_vs_original.json",
        ["--baseline", args.workdir / "working" / "original.npy", "--result", out_dir / "master_decoded.npy",
         "--allowed-mask", out_dir / "allowed_total.npy", "--protected-mask", out_dir / "protected_total.npy",
         "--difference-mask", out_dir / "changed.npy"])}
    if args.previous:
        if not (args.step_allowed and args.step_protected):
            raise PipelineError("--previous needs --step-allowed and --step-protected for this step's own audit")
        audits["vs_previous_version"] = run_audit(
            "audit_pixels.py", out_dir / "audit_vs_previous.json",
            ["--baseline", args.workdir / "versions" / args.previous / "master_decoded.npy",
             "--result", out_dir / "master_decoded.npy",
             "--allowed-mask", resolve(args.workdir, args.step_allowed),
             "--protected-mask", resolve(args.workdir, args.step_protected)])

    failed = [name for name, item in audits.items() if item["status"] != "pass"]
    if failed:
        write_json(out_dir / "report.json", {"version": args.version, "status": "audit_failed", "audits": audits})
        raise PipelineError(f"audit {', '.join(failed)} failed, see {out_dir}; do not deliver this version")

    changed = np.load(out_dir / "changed.npy", allow_pickle=False)
    diff = preview8(result).astype(np.float32) * 0.45
    magnitude = np.abs(result[..., :3].astype(np.float32) - original[..., :3]).max(axis=2) / maxv
    strength = np.clip(magnitude * 8, 0.25, 1)[changed]
    diff[changed] = diff[changed] * (1 - strength[:, None]) + np.array(COLORS["red"], np.float32) * strength[:, None]
    save_preview(out_dir / "diff_preview.png", diff.round().astype(np.uint8))

    look = look_table([args.workdir / "working" / "original.npy", out_dir / "master_decoded.npy"])
    (out_dir / "look.txt").write_text(look + "\n", encoding="utf-8")
    report = {
        "version": args.version,
        "master": str(master),
        "working_original_sha256": meta["working_original"]["sha256"],
        "master_sha256": sha256_file(master),
        "reopened_exactly": True,
        "icc_profile_preserved": bool(icc),
        "steps": step_reports,
        "changed_px": int(changed.sum()),
        "audits": audits,
        "look_table": look.splitlines(),
        "still_required": [
            "Inspect diff_preview.png and full-resolution fragments of metal, stones, edges and hallmarks.",
            "Compare with the matching reference (references/visual-target.md) and record the result.",
        ],
    }
    write_json(out_dir / "report.json", report)
    return report


def run_audit(script: str, report_path: Path, arguments: list) -> dict:
    command = [sys.executable, str(SCRIPT_DIR / script), *map(str, arguments), "--report", str(report_path)]
    completed = subprocess.run(command, capture_output=True, text=True, check=False)
    try:
        payload = json.loads(completed.stdout)
    except json.JSONDecodeError:
        payload = {"status": "fail", "error": completed.stderr.strip() or completed.stdout.strip()}
    return {"status": payload.get("status", "fail"), "exit_code": completed.returncode, "report": str(report_path),
            **{k: payload[k] for k in ("changed_outside_allowed_count", "changed_inside_protected_count",
                                       "changed_copied_pixel_count", "removed_protected_pixel_count",
                                       "nonwhite_padding_pixel_count", "error") if k in payload}}


def look_table(paths: list[Path]) -> str:
    import measure_look  # noqa: PLC0415

    rows = []
    for path in [*paths, *sorted(measure_look.REFERENCE_DIR.glob("reference-*.png"))]:
        try:
            rgb, info = measure_look.load_rgb(path)
            item = {**info, **measure_look.measure(rgb, 25.0, 0.03)}
        except (OSError, ValueError) as error:
            item = {"error": str(error)}
        label = path.name if path.parent.name != "working" else "working-original"
        if path.name == "master_decoded.npy":
            label = f"{path.parent.name}-result"
        rows.append(measure_look.table_row(label, item))
    return "\n".join(rows)


# ---------------------------------------------------------------------------
# 1:1 delivery


def cmd_square(args) -> dict:
    _original, meta, icc = load_working(args.workdir)
    version_dir = args.workdir / "versions" / args.version
    baseline_path = version_dir / "master_decoded.npy"
    if not baseline_path.is_file():
        raise PipelineError(f"{version_dir}: no verified master; run apply first")
    audit_report = version_dir / "audit_vs_original.json"
    if not audit_report.is_file() or json.loads(audit_report.read_text(encoding="utf-8")).get("status") != "pass":
        raise PipelineError(f"{version_dir}: tonal audit did not pass; fix the version before the canvas step")
    image = np.load(baseline_path, allow_pickle=False)
    height, width = image.shape[:2]
    product = load_mask(resolve(args.workdir, args.product_mask), (height, width))
    crop_allowed = load_mask(resolve(args.workdir, args.crop_allowed_mask), (height, width))
    if (product & crop_allowed).any():
        raise PipelineError("crop-allowed mask overlaps the product mask")
    bx0, by0, bx1, by1 = bbox(product)
    keep = ~crop_allowed
    region = (0, 0, width, height) if args.keep_full_canvas else bbox(keep)
    cx2, cy2 = bx0 + bx1, by0 + by1
    need = [
        bx1 - bx0 + 2 * args.min_margin, by1 - by0 + 2 * args.min_margin,
        cx2 - 2 * region[0], 2 * region[2] - cx2, cy2 - 2 * region[1], 2 * region[3] - cy2,
    ]
    if not args.keep_full_canvas:
        need.append(math.ceil(max(bx1 - bx0, by1 - by0) / args.fill))
    side = max(need)
    if args.side:
        if args.side < side:
            raise PipelineError(f"--side {args.side} is too small: the protected content needs at least {side}px")
        side = args.side
    while True:
        frame_left, frame_top = (cx2 - side) // 2, (cy2 - side) // 2
        if (frame_left <= region[0] and frame_left + side >= region[2]
                and frame_top <= region[1] and frame_top + side >= region[3]):
            break
        if args.side:
            raise PipelineError("--side cannot hold the protected content at this centering")
        side += 1
    crop = (max(frame_left, 0), max(frame_top, 0), min(frame_left + side, width), min(frame_top + side, height))
    paste = (crop[0] - frame_left, crop[1] - frame_top)
    removed = np.ones((height, width), bool)
    removed[crop[1]:crop[3], crop[0]:crop[2]] = False
    if (removed & keep).any():
        raise PipelineError("the square would crop protected pixels")

    maxv = max_value(image.dtype)
    canvas = np.full((side, side, image.shape[2]), maxv, dtype=image.dtype)
    retained = image[crop[1]:crop[3], crop[0]:crop[2]]
    canvas[paste[1]:paste[1] + retained.shape[0], paste[0]:paste[0] + retained.shape[1]] = retained

    seams = {}
    edges = {"left": retained[:, 0], "right": retained[:, -1], "top": retained[0], "bottom": retained[-1]}
    padded = {"left": paste[0] > 0, "top": paste[1] > 0,
              "right": paste[0] + retained.shape[1] < side, "bottom": paste[1] + retained.shape[0] < side}
    for side_name, line in edges.items():
        if padded[side_name]:
            deviation = (maxv - line[..., :3].astype(np.int64)).max(axis=-1) * 255.0 / maxv
            seams[side_name] = {"max_8bit": round(float(deviation.max()), 2), "p99_8bit": round(float(np.percentile(deviation, 99)), 2)}
    seam_warning = [name for name, value in seams.items() if value["p99_8bit"] > args.seam_tolerance]

    out_dir = new_dir(version_dir / args.name)
    stem = Path(meta["source"]["path"]).stem
    final = out_dir / f"{stem}_{args.version}_1x1.png"
    write_png(final, canvas, icc)
    decoded = reopen_png(final, canvas, icc)
    save_npy(out_dir / "final_decoded.npy", decoded)
    audit = run_audit("audit_canvas.py", out_dir / "audit_canvas.json",
                      ["--baseline", baseline_path, "--result", out_dir / "final_decoded.npy",
                       "--crop", *crop, "--paste", *paste,
                       "--crop-allowed-mask", resolve(args.workdir, args.crop_allowed_mask),
                       "--white-values", *([maxv] * image.shape[2])])
    jpeg_info = None
    if args.jpeg:
        jpeg_info = write_jpeg_copy(out_dir / f"{stem}_{args.version}_1x1.jpg", decoded, icc)

    new_bbox = (bx0 - crop[0] + paste[0], by0 - crop[1] + paste[1], bx1 - crop[0] + paste[0], by1 - crop[1] + paste[1])
    report = {
        "final": str(final),
        "final_sha256": sha256_file(final),
        "canvas_px": side,
        "bit_depth": 8 * image.dtype.itemsize,
        "icc_profile_preserved": bool(icc),
        "resampled": False,
        "crop_ltrb": list(crop),
        "paste_xy": list(paste),
        "product_bbox_in_final_ltrb": list(new_bbox),
        "product_margins_ltrb": [new_bbox[0], new_bbox[1], side - new_bbox[2], side - new_bbox[3]],
        "product_fill_of_side": round(max(bx1 - bx0, by1 - by0) / side, 3),
        "fill_requested": None if args.keep_full_canvas else args.fill,
        "seams_vs_white_8bit": seams,
        "seam_warning_sides": seam_warning,
        "audit_canvas": audit,
        "jpeg_copy": jpeg_info,
    }
    if seam_warning:
        report["seam_note"] = ("Background at these edges is not white; the added canvas may show a visible border. "
                               "Whiten the background by mask in a new version (apply), then square again.")
    write_json(out_dir / "square_report.json", report)
    if audit["status"] != "pass":
        raise PipelineError(f"canvas audit failed, see {out_dir}; do not deliver")
    return report


def write_jpeg_copy(path: Path, array: np.ndarray, icc: bytes | None) -> dict:
    from PIL import Image  # noqa: PLC0415

    notes = []
    if array.shape[2] == 4:
        if not (array[..., 3] == max_value(array.dtype)).all():
            raise PipelineError("JPEG cannot carry transparency; deliver the PNG")
        array = array[..., :3]
        notes.append("opaque alpha dropped")
    if array.dtype == np.uint16:
        array = ((array.astype(np.uint32) * 255 + 32767) // 65535).astype(np.uint8)
        notes.append("16-bit reduced to 8-bit for JPEG; the PNG keeps full depth")
    with path.open("xb") as stream:
        Image.fromarray(np.ascontiguousarray(array), "RGB").save(
            stream, format="JPEG", quality=100, subsampling=0, optimize=True, icc_profile=icc)
    return {"path": str(path), "quality": 100, "chroma_subsampling": "4:4:4", "notes": notes,
            "lossy": True}


# ---------------------------------------------------------------------------


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest="command", required=True)

    prepare = commands.add_parser("prepare", help="decode the source into an immutable working original")
    prepare.add_argument("source", type=Path)
    prepare.add_argument("--workdir", type=Path, required=True)

    draft = commands.add_parser("draft-masks", help="threshold DRAFT masks, focus map and overlay for review")
    draft.add_argument("--workdir", type=Path, required=True)
    draft.add_argument("--bg-tolerance", type=float, default=0.06, help="max channel distance from the border color, 0..1 (default 0.06)")
    draft.add_argument("--edge-band", type=int, default=4, help="uncertain band around the product kept out of the background mask, px (default 4)")
    draft.add_argument("--shadow-depth", type=float, default=0.4, help="darkest shadow candidate below the background luminance, 0..1 (default 0.4)")
    draft.add_argument("--detail-amplitude", type=float, default=0.06, help="local contrast (std, relative to backdrop luminance) from which pixels count as jewelry detail (default 0.06)")
    draft.add_argument("--shadow-guard", type=int, default=6, help="distance kept from sharp or dark product pixels, px (default 6)")
    draft.add_argument("--shadow-chroma", type=float, default=0.03, help="max chromaticity difference from the background (default 0.03)")
    draft.add_argument("--min-hole-fraction", type=float, default=0.002, help="smallest enclosed background-colored area offered as a hole candidate, fraction of the frame (default 0.002)")
    draft.add_argument("--overwrite", action="store_true", help="replace previous drafts (final masks are never touched)")

    overlay = commands.add_parser("overlay", help="render masks over an image for visual review")
    overlay.add_argument("--workdir", type=Path, required=True)
    overlay.add_argument("--base", default="original", help="'original', a version name, or an .npy path")
    overlay.add_argument("--mask", action="append", default=[], help="MASK_PATH[:color], repeatable")
    overlay.add_argument("--alpha", type=float, default=0.45)
    overlay.add_argument("--crop", type=int, nargs=4, metavar=("LEFT", "TOP", "RIGHT", "BOTTOM"))
    overlay.add_argument("--zoom", type=int, default=1, help="integer nearest-neighbour zoom for inspection")
    overlay.add_argument("--out", type=Path, required=True, help="new PNG path")

    apply = commands.add_parser("apply", help="apply a recipe from the working original and audit the saved master")
    apply.add_argument("--workdir", type=Path, required=True)
    apply.add_argument("--recipe", type=Path, required=True)
    apply.add_argument("--version", required=True, help="new version folder name, e.g. v01")
    apply.add_argument("--previous", help="previous accepted version for the second audit")
    apply.add_argument("--step-allowed", help="mask allowed in this step only (with --previous)")
    apply.add_argument("--step-protected", help="mask protected in this step (with --previous)")

    square = commands.add_parser("square", help="1:1 white canvas around the product, no resampling")
    square.add_argument("--workdir", type=Path, required=True)
    square.add_argument("--version", required=True, help="verified version to place on the canvas")
    square.add_argument("--product-mask", required=True, help="product only, without its shadow; defines the centering box")
    square.add_argument("--crop-allowed-mask", required=True, help="reviewed free background that may be cropped")
    square.add_argument("--fill", type=float, default=0.6, help="product's longer side as a fraction of the square side (default 0.6)")
    square.add_argument("--keep-full-canvas", action="store_true", help="never crop; only add white canvas")
    square.add_argument("--min-margin", type=int, default=0, help="minimum white margin around the product, px")
    square.add_argument("--side", type=int, help="exact square side, px; fails if too small")
    square.add_argument("--seam-tolerance", type=float, default=2.0, help="warn when edge background differs from white by more (8-bit units)")
    square.add_argument("--name", default="square", help="output folder inside the version (default 'square')")
    square.add_argument("--jpeg", action="store_true", help="also write a JPEG copy (q100, 4:4:4); the PNG stays the master")

    args = parser.parse_args()
    if getattr(args, "fill", 0.6) is not None and not 0 < getattr(args, "fill", 0.6) <= 1:
        parser.error("--fill must be within (0, 1]")
    handlers = {"prepare": cmd_prepare, "draft-masks": cmd_draft_masks, "overlay": cmd_overlay,
                "apply": cmd_apply, "square": cmd_square}
    try:
        result = handlers[args.command](args)
    except (PipelineError, OSError, KeyError, ValueError) as error:
        print(json.dumps({"status": "error", "command": args.command, "error": f"{type(error).__name__}: {error}"},
                         indent=2, ensure_ascii=False))
        return 2
    print(json.dumps({**result, "status": "ok", "command": args.command}, indent=2, ensure_ascii=False, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
