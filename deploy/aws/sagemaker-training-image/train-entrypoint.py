#!/usr/bin/env python3
"""
SageMaker training entrypoint for Tuna runner contract.

Expected input channels:
- /opt/ml/input/data/training : primary dataset file
- /opt/ml/input/data/script   : user training script (.py)
- /opt/ml/input/data/<extra>  : optional extra files/channels

HF prefetch: reads ``tuna_hf_models`` / ``tuna_hf_datasets`` from
hyperparameters (JSON arrays) and downloads them via
``huggingface_hub.snapshot_download`` before running the user script.
Environment variables ``HF_MODEL_DIR``, ``HF_DATASET_DIR``, etc. are set
so training scripts can locate the prefetched assets.

Behavior:
- Prefetches HF models/datasets if configured
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
import re
import shlex
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

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


def _safe_slug(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]", "-", value).strip("-_")[:128] or "item"


def _parse_json_hp(raw: str) -> Any:
    """Decode a hyperparameter that may be double-JSON-encoded by SageMaker."""
    if not raw:
        return None
    try:
        first = json.loads(raw)
    except Exception:
        return None
    if isinstance(first, str):
        try:
            return json.loads(first)
        except Exception:
            return first
    return first


def prefetch_hf_assets(hp: Dict[str, str]) -> Dict[str, str]:
    """Download HF models/datasets specified in hyperparameters.

    Returns a dict of environment variables to inject into the training
    script's runtime environment.
    """
    raw_models = _parse_json_hp(hp.get("tuna_hf_models", ""))
    raw_datasets = _parse_json_hp(hp.get("tuna_hf_datasets", ""))
    hf_models: List[Dict[str, Any]] = raw_models if isinstance(raw_models, list) else []
    hf_datasets: List[Dict[str, Any]] = raw_datasets if isinstance(raw_datasets, list) else []

    if not hf_models and not hf_datasets:
        return {}

    from huggingface_hub import snapshot_download  # available in the container image

    hf_token = os.environ.get("HUGGINGFACE_HUB_TOKEN", "").strip() or None
    hf_root = WORK_DIR / ".hf"
    hf_cache = hf_root / "cache"
    hf_cache.mkdir(parents=True, exist_ok=True)

    env: Dict[str, str] = {
        "HF_HOME": str(hf_cache),
        "HF_HUB_CACHE": str(hf_cache / "hub"),
        "HF_DATASETS_CACHE": str(hf_cache / "datasets"),
        "TRANSFORMERS_CACHE": str(hf_cache / "transformers"),
    }

    model_dirs: Dict[str, str] = {}
    for item in hf_models:
        repo = str((item or {}).get("repo", "")).strip()
        if not repo:
            continue
        target = hf_root / "models" / _safe_slug(repo)
        if target.exists():
            shutil.rmtree(target)
        kwargs: Dict[str, Any] = {"repo_id": repo, "local_dir": str(target)}
        revision = str((item or {}).get("revision", "")).strip()
        if revision:
            kwargs["revision"] = revision
        allow = [str(v) for v in ((item or {}).get("allow_patterns") or []) if str(v).strip()]
        ignore = [str(v) for v in ((item or {}).get("ignore_patterns") or []) if str(v).strip()]
        if allow:
            kwargs["allow_patterns"] = allow
        if ignore:
            kwargs["ignore_patterns"] = ignore
        if hf_token:
            kwargs["token"] = hf_token
        log(f"Prefetching HF model: {repo}")
        snapshot_download(**kwargs)
        model_dirs[repo] = str(target)

    dataset_dirs: Dict[str, str] = {}
    for item in hf_datasets:
        repo = str((item or {}).get("repo", "")).strip()
        if not repo:
            continue
        target = hf_root / "datasets" / _safe_slug(repo)
        if target.exists():
            shutil.rmtree(target)
        kwargs = {"repo_id": repo, "repo_type": "dataset", "local_dir": str(target)}
        revision = str((item or {}).get("revision", "")).strip()
        if revision:
            kwargs["revision"] = revision
        allow = [str(v) for v in ((item or {}).get("allow_patterns") or []) if str(v).strip()]
        ignore = [str(v) for v in ((item or {}).get("ignore_patterns") or []) if str(v).strip()]
        if allow:
            kwargs["allow_patterns"] = allow
        if ignore:
            kwargs["ignore_patterns"] = ignore
        if hf_token:
            kwargs["token"] = hf_token
        log(f"Prefetching HF dataset: {repo}")
        snapshot_download(**kwargs)
        dataset_dirs[repo] = str(target)

    if model_dirs:
        env["HF_MODEL_DIR"] = next(iter(model_dirs.values()))
        env["HF_MODEL_DIRS"] = json.dumps(model_dirs, sort_keys=True)
    if dataset_dirs:
        env["HF_DATASET_DIR"] = next(iter(dataset_dirs.values()))
        env["HF_DATASET_DIRS"] = json.dumps(dataset_dirs, sort_keys=True)

    log(f"HF prefetch complete: {len(model_dirs)} model(s), {len(dataset_dirs)} dataset(s)")
    return env


def run_training() -> int:
    WORK_DIR.mkdir(parents=True, exist_ok=True)
    MODEL_DIR.mkdir(parents=True, exist_ok=True)

    hp = load_hyperparameters()
    expected_name = (hp.get("tuna_expected_output_name") or "model.pkl").strip() or "model.pkl"
    expected_path = MODEL_DIR / expected_name
    log(f"Expected model artifact: {expected_path}")

    hf_env = prefetch_hf_assets(hp)

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
    runtime_env.update(hf_env)
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

