#!/usr/bin/env python3
"""Verify lossless crop-and-pad placement using decoded NumPy image arrays.

Example:
  python audit_canvas.py --baseline before-canvas.npy --result export-decoded.npy \
    --crop 10 0 410 300 --paste 30 20 --crop-allowed-mask expendable-background.npy \
    --white-values 255 255 255 --report canvas-audit.json

The crop is LEFT TOP RIGHT BOTTOM in source coordinates, with exclusive right
and bottom edges. Paste is the integer X Y position of the retained rectangle's
top-left corner in the result. No pixels are resampled. The result's dimensions
define the final canvas. All supplied channels, including alpha, are compared.

Requires NumPy and audit_pixels.py in the same directory. Supports uint8,
uint16, float32, and float64 arrays, H-by-W or H-by-W-by-C with 1 to 4 channels.
White values are required for every channel in the array's own numeric encoding;
this script neither interprets a profile nor decides what constitutes white.

Exit status: 0 = supplied constraints passed; 1 = pixel constraint violation;
2 = invalid input, output destination, or processing error. JSON is printed to
stdout after argument parsing. An optional report must be a new file.
"""

from __future__ import annotations

import argparse
from decimal import Decimal, InvalidOperation
import json
from pathlib import Path

import numpy as np

from audit_pixels import load_array, parse_mask


LIMITATIONS = [
    "Only supplied decoded arrays, the declared crop, placement, mask, and white values are checked.",
    "Mask correctness, selection of the intended jewelry, actual centering, appearance, decoding, and color management are not verified.",
    "White values are compared numerically; their visual meaning, color profile, and alpha convention are not inferred.",
    "Use the verified post-retouch, pre-canvas array as baseline if tone or color corrections preceded the canvas operation.",
    "A pass does not prove completion of the user's composition or retouch requirements.",
]


def validate_image(array: np.ndarray, label: str) -> None:
    if array.ndim not in (2, 3) or any(size == 0 for size in array.shape):
        raise ValueError(f"{label}: expected nonempty H-by-W or H-by-W-by-C array")
    if array.ndim == 3 and not 1 <= array.shape[2] <= 4:
        raise ValueError(f"{label}: supported channel counts are 1, 2, 3, or 4")
    if (array.dtype.kind, array.dtype.itemsize) not in {("u", 1), ("u", 2), ("f", 4), ("f", 8)}:
        raise ValueError(f"{label}: supported dtypes are uint8, uint16, float32, or float64")


def parse_white(tokens: list[str], dtype: np.dtype, channels: int) -> np.ndarray:
    if len(tokens) != channels:
        raise ValueError(f"white-values: expected {channels} explicit channel values, got {len(tokens)}")
    parsed = []
    for token in tokens:
        try:
            number = Decimal(token)
        except InvalidOperation as error:
            raise ValueError(f"white-values: invalid number {token!r}") from error
        if not number.is_finite():
            raise ValueError("white-values: NaN and infinite values are not supported")
        if dtype.kind == "u":
            if number != number.to_integral_value() or not 0 <= number <= np.iinfo(dtype).max:
                raise ValueError(f"white-values: {token!r} must be an integer within {dtype}'s range")
            parsed.append(int(number))
        else:
            with np.errstate(over="ignore", under="ignore", invalid="ignore"):
                value = np.asarray(token, dtype=dtype).item()
            if not np.isfinite(value) or (number != 0 and value == 0):
                raise ValueError(f"white-values: {token!r} overflows or underflows {dtype}")
            parsed.append(value)
    return np.asarray(parsed, dtype=dtype)


def validate_report_path(path: Path | None, input_paths: list[Path]) -> None:
    if path is None:
        return
    if path.resolve() in {item.resolve() for item in input_paths}:
        raise ValueError(f"report must not overwrite an input: {path}")
    if path.exists() or path.is_symlink():
        raise ValueError(f"report already exists; choose a new path: {path}")
    if not path.parent.is_dir():
        raise ValueError(f"report directory does not exist: {path.parent}")


def changed_pixels(first: np.ndarray, second: np.ndarray) -> np.ndarray:
    changed = first != second
    return np.any(changed, axis=2) if first.ndim == 3 else changed


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--baseline", type=Path, required=True, help="canonical image BEFORE crop/padding .npy")
    parser.add_argument("--result", type=Path, required=True, help="reopened and decoded final export .npy")
    parser.add_argument("--crop", type=int, nargs=4, required=True, metavar=("LEFT", "TOP", "RIGHT", "BOTTOM"))
    parser.add_argument("--paste", type=int, nargs=2, required=True, metavar=("X", "Y"))
    parser.add_argument("--crop-allowed-mask", type=Path, required=True, help="source H-by-W binary mask; true means cropping is allowed")
    parser.add_argument("--white-values", nargs="+", required=True, help="one explicit value per channel, including alpha if present")
    parser.add_argument("--report", type=Path, help="optional new JSON file, also printed to stdout")
    args = parser.parse_args()

    report = {
        "schema_version": 1,
        "status": "fail",
        "check": "supplied_array_crop_and_pad_constraints",
        "centering_verified": False,
        "retouch_completion_verified": False,
        "all_channels_compared": False,
        "tolerance": 0,
        "inputs": {},
        "mapping": {
            "crop_ltrb_half_open": args.crop,
            "paste_xy": args.paste,
            "formula": "result[y - top + paste_y, x - left + paste_x, ...] = baseline[y, x, ...] for left <= x < right and top <= y < bottom",
        },
        "limitations": LIMITATIONS,
    }
    write_report = False
    try:
        validate_report_path(args.report, [args.baseline, args.result, args.crop_allowed_mask])
        write_report = True
        baseline = load_array(args.baseline, "baseline", report)
        result = load_array(args.result, "result", report)
        validate_image(baseline, "baseline")
        validate_image(result, "result")
        if baseline.ndim != result.ndim or baseline.shape[2:] != result.shape[2:]:
            raise ValueError("result channel layout must exactly match baseline")
        if baseline.dtype != result.dtype:
            raise ValueError(f"result dtype {result.dtype} does not match baseline {baseline.dtype}")
        channels = baseline.shape[2] if baseline.ndim == 3 else 1
        white = parse_white(args.white_values, baseline.dtype, channels)
        report["white_values_requested"] = args.white_values
        report["white_values_in_array_dtype"] = white.tolist()
        allowed = parse_mask(
            load_array(args.crop_allowed_mask, "crop_allowed_mask", report),
            baseline.shape[:2], "crop_allowed_mask",
        )
        protected_count = int(np.count_nonzero(~allowed))
        report["protected_source_pixel_count"] = protected_count
        if protected_count == 0:
            raise ValueError("crop-allowed-mask must retain a protected area; it cannot authorize cropping the entire image")

        source_height, source_width = baseline.shape[:2]
        target_height, target_width = result.shape[:2]
        left, top, right, bottom = args.crop
        paste_x, paste_y = args.paste
        if not (0 <= left < right <= source_width and 0 <= top < bottom <= source_height):
            raise ValueError("crop must be a nonempty half-open rectangle within baseline bounds")
        retained_width, retained_height = right - left, bottom - top
        if not (0 <= paste_x and 0 <= paste_y and paste_x + retained_width <= target_width and paste_y + retained_height <= target_height):
            raise ValueError("paste placement must fit the entire retained rectangle inside the result")

        retained = baseline[top:bottom, left:right]
        copied = result[paste_y:paste_y + retained_height, paste_x:paste_x + retained_width]
        copied_changed_count = int(np.count_nonzero(changed_pixels(retained, copied)))
        removed = np.ones(baseline.shape[:2], dtype=bool)
        removed[top:bottom, left:right] = False
        removed_protected_count = int(np.count_nonzero(removed & ~allowed))
        padding = np.ones(result.shape[:2], dtype=bool)
        padding[paste_y:paste_y + retained_height, paste_x:paste_x + retained_width] = False
        nonwhite = result != (white if result.ndim == 3 else white[0])
        if result.ndim == 3:
            nonwhite = np.any(nonwhite, axis=2)
        nonwhite_padding_count = int(np.count_nonzero(nonwhite & padding))
        passed = copied_changed_count == removed_protected_count == nonwhite_padding_count == 0
        report.update(
            status="pass" if passed else "fail",
            all_channels_compared=True,
            channel_count=int(channels),
            copied_pixel_count=int(retained_width * retained_height),
            changed_copied_pixel_count=copied_changed_count,
            removed_pixel_count=int(np.count_nonzero(removed)),
            removed_protected_pixel_count=removed_protected_count,
            padding_pixel_count=int(np.count_nonzero(padding)),
            nonwhite_padding_pixel_count=nonwhite_padding_count,
        )
        exit_code = 0 if passed else 1
        if not passed:
            report["failure_reason"] = "crop_and_pad_constraint_violation"
    except (OSError, EOFError, ValueError, TypeError, OverflowError) as error:
        report.update(status="fail", failure_reason="validation_or_processing_error", error=str(error))
        exit_code = 2

    serialized = json.dumps(report, indent=2, ensure_ascii=False, allow_nan=False)
    if args.report is not None and write_report:
        try:
            with args.report.open("x", encoding="utf-8") as stream:
                stream.write(serialized + "\n")
        except OSError as error:
            report.update(status="fail", failure_reason="report_write_error", error=str(error))
            serialized = json.dumps(report, indent=2, ensure_ascii=False, allow_nan=False)
            exit_code = 2
    print(serialized)
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
