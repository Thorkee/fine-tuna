#!/usr/bin/env python3
"""
Minimal SageMaker training entrypoint for Tuna runner contract.

Expected input channels:
- /opt/ml/input/data/training : primary dataset file
- /opt/ml/input/data/script   : user training script (.py)
- /opt/ml/input/data/<extra>  : optional extra files/channels

Behavior:
- Copies channel files into /opt/ml/code
- Runs the script with a few argument variants:
  1) --input <file> --out /opt/ml/model/<expected>
  2) --csv <file> --out /opt/ml/model/<expected>
  3) no args
- Produces model artifacts under /opt/ml/model for SageMaker to upload.
"""

from __future__ import annotations

import json
import os
import shlex
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Dict, List, Optional

OPT_ML = Path("/opt/ml")
INPUT_ROOT = OPT_ML / "input" / "data"
CONFIG_DIR = OPT_ML / "input" / "config"
MODEL_DIR = OPT_ML / "model"
WORK_DIR = Path("/opt/ml/code")

SCRIPT_CHANNEL = "script"
TRAINING_CHANNEL = "training"


def log(msg: str) -> None:
    print(msg, flush=True)


def load_hyperparameters() -> Dict[str, str]:
    path = CONFIG_DIR / "hyperparameters.json"
    if not path.exists():
        return {}
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}

    out: Dict[str, str] = {}
    if not isinstance(raw, dict):
        return out
    for key, value in raw.items():
        k = str(key)
        if isinstance(value, str):
            # Some clients pass quoted JSON string values. Decode once when possible.
            normalized = value
            try:
                decoded = json.loads(value)
                if isinstance(decoded, (str, int, float, bool)):
                    normalized = str(decoded)
            except Exception:
                pass
            out[k] = normalized
        else:
            out[k] = str(value)
    return out


def copy_channel_to_workdir(channel: str) -> List[Path]:
    channel_dir = INPUT_ROOT / channel
    copied: List[Path] = []
    if not channel_dir.exists():
        return copied

    for source in sorted(channel_dir.rglob("*")):
        if not source.is_file():
            continue

        if channel in {SCRIPT_CHANNEL, TRAINING_CHANNEL}:
            dest = WORK_DIR / source.name
        else:
            rel = source.relative_to(channel_dir)
            dest = WORK_DIR / channel / rel

        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, dest)
        copied.append(dest)
    return copied


def first_file(paths: List[Path], suffix: Optional[str] = None) -> Optional[Path]:
    for path in paths:
        if not path.is_file():
            continue
        if suffix and path.suffix.lower() != suffix.lower():
            continue
        return path
    return None


def run_command(cmd: List[str], env: Dict[str, str]) -> subprocess.CompletedProcess[str]:
    printable = " ".join(shlex.quote(part) for part in cmd)
    log(f"$ {printable}")
    proc = subprocess.run(
        cmd,
        cwd=str(WORK_DIR),
        env=env,
        text=True,
        capture_output=True,
    )
    if proc.stdout:
        print(proc.stdout, end="", flush=True)
    if proc.stderr:
        print(proc.stderr, end="", file=sys.stderr, flush=True)
    return proc


def has_any_model_artifact() -> bool:
    if not MODEL_DIR.exists():
        return False
    for candidate in MODEL_DIR.rglob("*"):
        if candidate.is_file():
            return True
    return False


def copy_fallback_artifact(expected_path: Path) -> bool:
    patterns = ("*.pkl", "*.pt", "*.bin", "*.onnx", "*.safetensors", "*.tar.gz")
    for pattern in patterns:
        for candidate in sorted(WORK_DIR.rglob(pattern)):
            if not candidate.is_file():
                continue
            expected_path.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(candidate, expected_path)
            log(f"Copied fallback artifact {candidate} -> {expected_path}")
            return True
    return False


def run_training() -> int:
    WORK_DIR.mkdir(parents=True, exist_ok=True)
    MODEL_DIR.mkdir(parents=True, exist_ok=True)

    hp = load_hyperparameters()
    expected_name = (hp.get("tuna_expected_output_name") or "model.pkl").strip() or "model.pkl"
    expected_path = MODEL_DIR / expected_name
    log(f"Expected model artifact: {expected_path}")

    script_files = copy_channel_to_workdir(SCRIPT_CHANNEL)
    training_files = copy_channel_to_workdir(TRAINING_CHANNEL)

    extras: Dict[str, List[Path]] = {}
    if INPUT_ROOT.exists():
        for item in INPUT_ROOT.iterdir():
            if not item.is_dir():
                continue
            channel = item.name
            if channel in {SCRIPT_CHANNEL, TRAINING_CHANNEL}:
                continue
            extras[channel] = copy_channel_to_workdir(channel)

    script_path = first_file(script_files, suffix=".py") or first_file(script_files)
    if not script_path:
        raise RuntimeError("No training script found in /opt/ml/input/data/script")

    input_path = first_file(training_files)
    if not input_path:
        raise RuntimeError("No training input file found in /opt/ml/input/data/training")

    runtime_env = os.environ.copy()
    runtime_env["TUNA_TASK_ID"] = hp.get("tuna_task_id", "")
    runtime_env["TUNA_EXPECTED_OUTPUT_NAME"] = expected_name
    runtime_env["TUNA_INPUT_PATH"] = str(input_path)
    runtime_env["TUNA_SCRIPT_PATH"] = str(script_path)
    for channel in extras:
        env_name = f"TUNA_CHANNEL_{channel.upper()}_DIR"
        runtime_env[env_name] = str((WORK_DIR / channel).resolve())

    commands: List[List[str]] = [
        [sys.executable, str(script_path), "--input", str(input_path), "--out", str(expected_path)],
        [sys.executable, str(script_path), "--csv", str(input_path), "--out", str(expected_path)],
        [sys.executable, str(script_path)],
    ]

    last_return_code = 1
    for idx, cmd in enumerate(commands, start=1):
        proc = run_command(cmd, runtime_env)
        last_return_code = proc.returncode
        if expected_path.is_file() or has_any_model_artifact():
            log(f"Training command variant #{idx} produced artifact(s).")
            return 0
        if "unrecognized arguments" in (proc.stderr or "").lower() and idx < len(commands):
            log("Command args rejected; trying next variant.")
            continue

    if expected_path.is_file() or has_any_model_artifact():
        return 0
    if copy_fallback_artifact(expected_path):
        return 0

    log("No model artifact found under /opt/ml/model after training run.")
    return last_return_code if last_return_code != 0 else 2


def main() -> int:
    # SageMaker custom training passes "train". We treat unknown args as train too.
    if len(sys.argv) <= 1 or sys.argv[1] == "train":
        return run_training()
    return run_training()


if __name__ == "__main__":
    sys.exit(main())

