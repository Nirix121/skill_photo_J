#!/usr/bin/env python3
"""Audit pixel constraints between canonical baseline and decoded export arrays.

Requires only NumPy. This tool does not decode images, convert colors, align
coordinates, judge masks, or prove that a requested retouch was accomplished.
All channels (including an alpha channel, if supplied) participate in comparison.

Example:
  python audit_pixels.py --baseline baseline.npy --result export-decoded.npy \
    --allowed-mask allowed.npy --protected-mask protected.npy --report audit.json

Exit status: 0 = supplied pixel constraints passed, 1 = constraint violation,
2 = invalid input, invalid output destination, or another processing error.
JSON is always printed to stdout after argument parsing; optional output paths
must be new files and must not refer to any input. Masks are H-by-W arrays of
bool, 0/1, or 0/255 values; a mixture of 1 and 255 is rejected as ambiguous.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import sys

import numpy as np


LIMITATIONS = [
    "Equality refers only to the supplied arrays and all their supplied channels.",
    "Mask correctness, image appearance, image decoding, color management, and coordinate correspondence are not verified.",
    "A pass does not establish that the requested retouch was completed; zero changed pixels can also pass.",
]


def load_array(path: Path, label: str, report: dict) -> np.ndarray:
    """Hash file contents and load without permitting pickle/object payloads."""
    item = {"path": str(path.resolve())}
    report["inputs"][label] = item
    with path.open("rb") as stream:
        digest = hashlib.sha256()
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
        item["sha256"] = digest.hexdigest()
        stream.seek(0)
        array = np.load(stream, allow_pickle=False)
    if not isinstance(array, np.ndarray):
        if hasattr(array, "close"):
            array.close()
        raise ValueError(f"{label}: expected one .npy array, not an archive")
    item.update(shape=list(array.shape), dtype=array.dtype.str)
    if array.dtype.kind not in "buif":
        raise ValueError(f"{label}: dtype must be boolean, integer, or floating point")
    if not np.isfinite(array).all():
        raise ValueError(f"{label}: contains NaN or infinite values")
    return array


def parse_mask(mask: np.ndarray, shape: tuple, label: str) -> np.ndarray:
    if mask.shape != shape:
        raise ValueError(f"{label}: expected shape {shape}, got {mask.shape}")
    values = np.unique(mask)
    is_unit = np.isin(values, (0, 1)).all()
    is_byte = np.isin(values, (0, 255)).all()
    if not (is_unit or is_byte):
        raise ValueError(f"{label}: use bool, 0/1, or 0/255; mixed or intermediate values are ambiguous")
    return mask != 0


def max_abs_delta(baseline: np.ndarray, result: np.ndarray):
    """Return an exact integer delta, without native integer subtraction overflow."""
    kind = baseline.dtype.kind
    if kind in "bui":
        if baseline.dtype.itemsize < 8 or kind == "b":
            return int(np.abs(result.astype(np.int64) - baseline.astype(np.int64)).max()), "number"
        # Map signed integers to ordered unsigned values before subtraction.
        # The full int64 span is representable by uint64 (2**64 - 1).
        if kind == "i":
            high_bit = np.uint64(1 << 63)
            a = baseline.astype(np.int64).view(np.uint64) ^ high_bit
            b = result.astype(np.int64).view(np.uint64) ^ high_bit
        else:
            a, b = baseline.astype(np.uint64), result.astype(np.uint64)
        return int((np.maximum(a, b) - np.minimum(a, b)).max()), "number"
    # Use min/max differences in Python decimal only for a floating overflow.
    # This rare fallback keeps the JSON valid on platforms whose longdouble
    # has the same range as float64.
    with np.errstate(over="ignore", invalid="ignore"):
        deltas = np.abs(result.astype(np.longdouble) - baseline.astype(np.longdouble))
        maximum = deltas.max()
    if np.isfinite(maximum) and maximum <= sys.float_info.max:
        return float(maximum), "number"
    from decimal import Decimal, localcontext

    with localcontext() as context:
        context.prec = 1100
        largest = Decimal(0)
        for old, new in zip(baseline.flat, result.flat):
            # NumPy float16/32/64 values are exactly representable in Python
            # float. Longdouble uses its own decimal string representation.
            if baseline.dtype.itemsize <= 8:
                old_value, new_value = Decimal.from_float(float(old)), Decimal.from_float(float(new))
            else:
                old_value, new_value = Decimal(str(old)), Decimal(str(new))
            largest = max(largest, abs(new_value - old_value))
    return str(largest), "decimal_string"


def validate_destinations(args, input_paths: list[Path]) -> None:
    outputs = [path for path in (args.report, args.difference_mask) if path is not None]
    resolved_inputs = {path.resolve() for path in input_paths}
    resolved_outputs: set[Path] = set()
    for path in outputs:
        resolved = path.resolve()
        if resolved in resolved_inputs:
            raise ValueError(f"output must not overwrite an input: {path}")
        if resolved in resolved_outputs:
            raise ValueError("report and difference-mask must use different output files")
        if path.exists() or path.is_symlink():
            raise ValueError(f"output already exists; choose a new path: {path}")
        if not path.parent.is_dir():
            raise ValueError(f"output directory does not exist: {path.parent}")
        resolved_outputs.add(resolved)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--baseline", type=Path, required=True, help="canonical baseline .npy")
    parser.add_argument("--result", type=Path, required=True, help="decoded final export .npy, same coordinate system and dtype")
    parser.add_argument("--allowed-mask", type=Path, required=True, help="H-by-W allowed edit mask .npy")
    parser.add_argument("--protected-mask", type=Path, help="optional H-by-W protected pixels .npy")
    parser.add_argument("--report", type=Path, help="optional new JSON file, also printed to stdout")
    parser.add_argument("--difference-mask", type=Path, help="optional new .npy boolean mask of changed pixels")
    args = parser.parse_args()

    report = {
        "schema_version": 1,
        "status": "fail",
        "check": "supplied_array_pixel_constraints",
        "retouch_completion_verified": False,
        "inputs": {},
        "limitations": LIMITATIONS,
    }
    write_report = False
    try:
        input_paths = [args.baseline, args.result, args.allowed_mask]
        if args.protected_mask is not None:
            input_paths.append(args.protected_mask)
        validate_destinations(args, input_paths)
        write_report = True
        baseline = load_array(args.baseline, "baseline", report)
        result = load_array(args.result, "result", report)
        if baseline.ndim not in (2, 3) or any(size == 0 for size in baseline.shape):
            raise ValueError("baseline: expected nonempty H-by-W or H-by-W-by-C array")
        if baseline.shape != result.shape:
            raise ValueError(f"result shape {result.shape} does not match baseline {baseline.shape}")
        if baseline.dtype != result.dtype:
            raise ValueError(f"result dtype {result.dtype} does not match baseline {baseline.dtype}")
        shape = baseline.shape[:2]
        allowed = parse_mask(load_array(args.allowed_mask, "allowed_mask", report), shape, "allowed_mask")
        protected = np.zeros(shape, dtype=bool)
        if args.protected_mask is not None:
            protected = parse_mask(load_array(args.protected_mask, "protected_mask", report), shape, "protected_mask")
        overlap_count = int(np.count_nonzero(allowed & protected))
        report["mask_overlap_count"] = overlap_count
        if overlap_count:
            raise ValueError("allowed_mask and protected_mask must not overlap")

        changed = baseline != result
        if baseline.ndim == 3:
            changed = np.any(changed, axis=2)
        changed_count = int(np.count_nonzero(changed))
        outside_count = int(np.count_nonzero(changed & ~allowed))
        protected_count = int(np.count_nonzero(changed & protected))
        maximum, maximum_encoding = max_abs_delta(baseline, result)
        report.update(
            status="pass" if outside_count == 0 and protected_count == 0 else "fail",
            total_pixel_count=int(changed.size),
            channel_count=int(baseline.shape[2]) if baseline.ndim == 3 else 1,
            allowed_pixel_count=int(np.count_nonzero(allowed)),
            protected_pixel_count=int(np.count_nonzero(protected)),
            changed_count=changed_count,
            unchanged_count=int(changed.size) - changed_count,
            changed_outside_allowed_count=outside_count,
            changed_inside_protected_count=protected_count,
            max_abs_delta=maximum,
            max_abs_delta_encoding=maximum_encoding,
            all_channels_compared=True,
        )
        if changed_count == 0:
            report["notice"] = "No supplied pixels changed. This does not prove completion of any requested retouch."
        exit_code = 0 if report["status"] == "pass" else 1
        if exit_code:
            report["failure_reason"] = "pixel_constraint_violation"
        if args.difference_mask is not None:
            with args.difference_mask.open("xb") as stream:
                np.save(stream, changed, allow_pickle=False)
            report["difference_mask"] = str(args.difference_mask.resolve())
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
