from __future__ import annotations

import os
import re
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

try:
    import boto3
except Exception:
    boto3 = None  # type: ignore


class SageMakerExecutionError(RuntimeError):
    pass


@dataclass
class SageMakerRunResult:
    training_job_name: str
    final_status: str
    stdout: str
    stderr: str
    attempts: int
    produced_files: List[str]
    model_local_path: Optional[str]
    model_artifact_s3_uri: Optional[str]
    output_s3_uri: str
    summary: Dict[str, Any]


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _safe_channel_name(raw: str, fallback: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9_-]+", "-", raw.strip())
    cleaned = cleaned.strip("-_")
    return (cleaned[:63] if cleaned else fallback) or fallback


def _parse_positive_int(raw: Any, default: int) -> int:
    try:
        value = int(raw)
    except Exception:
        return default
    return value if value > 0 else default


def _parse_s3_uri(uri: str) -> Tuple[str, str]:
    value = (uri or "").strip()
    if not value.startswith("s3://"):
        raise SageMakerExecutionError("Expected s3:// URI")
    no_scheme = value[5:]
    if "/" not in no_scheme:
        return no_scheme, ""
    bucket, key = no_scheme.split("/", 1)
    return bucket, key


def _join_s3_key(prefix: str, suffix: str) -> str:
    left = (prefix or "").strip("/")
    right = (suffix or "").strip("/")
    if left and right:
        return f"{left}/{right}"
    return left or right


def _ensure_boto3() -> None:
    if boto3 is None:
        raise SageMakerExecutionError("boto3 is required for SageMaker execution. Install boto3 in runner service.")


def run_training_in_sagemaker(
    *,
    task_id: uuid.UUID,
    input_path: str,
    script_path: str,
    input_name: str,
    expected_model_filename: str,
    local_output_dir: str,
    extra_inputs: Optional[List[Tuple[str, str]]] = None,
    sagemaker_config: Optional[Dict[str, Any]] = None,
    wandb_config: Optional[Dict[str, Any]] = None,
    timeout_seconds: Optional[int] = None,
    on_status_update: Optional[Callable[[str, Optional[str]], None]] = None,
) -> SageMakerRunResult:
    _ensure_boto3()
    cfg = dict(sagemaker_config or {})
    wandb = dict(wandb_config or {})

    region = (os.getenv("AWS_REGION") or "us-east-1").strip()
    role_arn = (cfg.get("execution_role_arn") or os.getenv("SAGEMAKER_EXECUTION_ROLE_ARN") or "").strip()
    image_uri = (cfg.get("image_uri") or os.getenv("SAGEMAKER_TRAINING_IMAGE_URI") or "").strip()
    output_s3_uri = (cfg.get("output_s3_uri") or os.getenv("SAGEMAKER_OUTPUT_S3_URI") or "").strip()
    if not role_arn:
        raise SageMakerExecutionError("SageMaker execution role ARN is required.")
    if not image_uri:
        raise SageMakerExecutionError("SageMaker training image URI is required.")
    if not output_s3_uri:
        raise SageMakerExecutionError("SageMaker output S3 URI is required.")

    sm_client = boto3.client("sagemaker", region_name=region)
    s3_client = boto3.client("s3", region_name=region)

    output_bucket, output_prefix = _parse_s3_uri(output_s3_uri)
    task_root = _join_s3_key(output_prefix, f"tasks/{task_id}")
    inputs_root = _join_s3_key(task_root, "inputs")

    channels: List[Dict[str, Any]] = []
    upload_manifest: List[Dict[str, str]] = []

    def upload_and_add_channel(channel_name: str, local_path: str, remote_name: str) -> None:
        key = _join_s3_key(inputs_root, remote_name)
        s3_client.upload_file(local_path, output_bucket, key)
        channel_uri = f"s3://{output_bucket}/{key}"
        channels.append(
            {
                "ChannelName": channel_name,
                "DataSource": {
                    "S3DataSource": {
                        "S3DataType": "S3Prefix",
                        "S3Uri": channel_uri,
                        "S3DataDistributionType": "FullyReplicated",
                    }
                },
                "ContentType": "application/octet-stream",
            }
        )
        upload_manifest.append({"channel": channel_name, "local_path": local_path, "s3_uri": channel_uri})

    upload_and_add_channel("training", input_path, _join_s3_key("training", Path(input_name).name))
    upload_and_add_channel("script", script_path, _join_s3_key("script", Path(script_path).name))

    for index, pair in enumerate(extra_inputs or []):
        extra_name, extra_path = pair
        channel = _safe_channel_name(f"extra-{index + 1}-{extra_name}", f"extra-{index + 1}")
        upload_and_add_channel(channel, extra_path, _join_s3_key("extras", Path(extra_name).name))

    requested_job_name = (cfg.get("training_job_name") or "").strip()
    if requested_job_name:
        training_job_name = _safe_channel_name(requested_job_name, f"tuna-{task_id.hex[:12]}")
    else:
        training_job_name = _safe_channel_name(f"tuna-{task_id.hex[:8]}-{int(time.time())}", "tuna-training")

    instance_type = (cfg.get("instance_type") or os.getenv("SAGEMAKER_INSTANCE_TYPE") or "ml.g5.xlarge").strip()
    instance_count = _parse_positive_int(cfg.get("instance_count"), 1)
    volume_size_gb = _parse_positive_int(cfg.get("volume_size_gb"), 100)
    default_runtime = _parse_positive_int(os.getenv("SAGEMAKER_MAX_RUNTIME_SECONDS"), 7_200)
    max_runtime_seconds = _parse_positive_int(cfg.get("max_runtime_seconds"), default_runtime)
    if timeout_seconds and timeout_seconds > 0:
        max_runtime_seconds = min(max_runtime_seconds, int(timeout_seconds))

    hyperparameters: Dict[str, str] = {}
    for key, value in (cfg.get("hyperparameters") or {}).items():
        hyperparameters[str(key)] = str(value)
    hyperparameters.setdefault("tuna_task_id", str(task_id))
    hyperparameters.setdefault("tuna_expected_output_name", expected_model_filename or "model.tar.gz")
    if wandb.get("project"):
        hyperparameters.setdefault("wandb_project", str(wandb.get("project")))
    if wandb.get("entity"):
        hyperparameters.setdefault("wandb_entity", str(wandb.get("entity")))
    if wandb.get("run_name"):
        hyperparameters.setdefault("wandb_run_name", str(wandb.get("run_name")))

    environment: Dict[str, str] = {}
    wandb_api_key = (os.getenv("WANDB_API_KEY") or "").strip()
    if wandb_api_key:
        environment["WANDB_API_KEY"] = wandb_api_key
    if wandb.get("project"):
        environment.setdefault("WANDB_PROJECT", str(wandb.get("project")))
    if wandb.get("entity"):
        environment.setdefault("WANDB_ENTITY", str(wandb.get("entity")))

    request: Dict[str, Any] = {
        "TrainingJobName": training_job_name,
        "RoleArn": role_arn,
        "AlgorithmSpecification": {
            "TrainingImage": image_uri,
            "TrainingInputMode": "File",
        },
        "InputDataConfig": channels,
        "OutputDataConfig": {"S3OutputPath": output_s3_uri},
        "ResourceConfig": {
            "InstanceType": instance_type,
            "InstanceCount": instance_count,
            "VolumeSizeInGB": volume_size_gb,
        },
        "StoppingCondition": {"MaxRuntimeInSeconds": max_runtime_seconds},
        "HyperParameters": hyperparameters,
    }
    if environment:
        request["Environment"] = environment

    sm_client.create_training_job(**request)
    if on_status_update:
        on_status_update("submitted", None)

    poll_interval_seconds = _parse_positive_int(os.getenv("SAGEMAKER_POLL_INTERVAL_SECONDS"), 15)
    attempts = 0
    status_lines = [
        f"{_now_iso()} SageMaker job submitted: {training_job_name}",
        f"{_now_iso()} region={region} instance={instance_type}x{instance_count}",
    ]
    last_status: Optional[str] = None
    last_secondary: Optional[str] = None
    terminal_desc: Dict[str, Any] = {}

    while True:
        attempts += 1
        desc = sm_client.describe_training_job(TrainingJobName=training_job_name)
        status = str(desc.get("TrainingJobStatus") or "Unknown")
        secondary = desc.get("SecondaryStatus")
        secondary_text = str(secondary) if secondary else None
        if status != last_status or secondary_text != last_secondary:
            status_lines.append(f"{_now_iso()} status={status} secondary={secondary_text or 'n/a'}")
            last_status = status
            last_secondary = secondary_text
            if on_status_update:
                on_status_update(status, secondary_text)
        if status in {"Completed", "Failed", "Stopped"}:
            terminal_desc = desc
            break
        time.sleep(poll_interval_seconds)

    final_status = str(terminal_desc.get("TrainingJobStatus") or "Unknown")
    model_artifact_s3_uri = (
        terminal_desc.get("ModelArtifacts", {}) or {}
    ).get("S3ModelArtifacts")
    model_local_path: Optional[str] = None
    produced_files: List[str] = []
    stderr = ""

    if final_status == "Completed":
        output_dir = Path(local_output_dir)
        output_dir.mkdir(parents=True, exist_ok=True)
        if isinstance(model_artifact_s3_uri, str) and model_artifact_s3_uri.startswith("s3://"):
            try:
                model_bucket, model_key = _parse_s3_uri(model_artifact_s3_uri)
                suggested_name = Path(model_key).name or "model.tar.gz"
                local_name = suggested_name if "." in suggested_name else (expected_model_filename or "model.tar.gz")
                local_target = output_dir / local_name
                s3_client.download_file(model_bucket, model_key, str(local_target))
                model_local_path = str(local_target)
                produced_files.append(str(local_target))
                status_lines.append(f"{_now_iso()} downloaded model artifact: {model_artifact_s3_uri}")
            except Exception as download_error:
                placeholder = output_dir / "model-artifact-uri.txt"
                placeholder.write_text(str(model_artifact_s3_uri), encoding="utf-8")
                model_local_path = str(placeholder)
                produced_files.append(str(placeholder))
                status_lines.append(
                    f"{_now_iso()} model download failed ({download_error}); wrote artifact URI placeholder instead."
                )
        else:
            placeholder = output_dir / "model-artifact-uri.txt"
            placeholder.write_text("No S3 model artifact URI was returned by SageMaker.", encoding="utf-8")
            model_local_path = str(placeholder)
            produced_files.append(str(placeholder))
            status_lines.append(f"{_now_iso()} no model artifact URI returned by SageMaker.")
    else:
        failure_reason = str(terminal_desc.get("FailureReason") or "").strip()
        stderr = failure_reason or f"SageMaker job finished with status={final_status}"
        status_lines.append(f"{_now_iso()} terminal_status={final_status} reason={stderr}")
        raise SageMakerExecutionError(stderr)

    status_lines.append(f"{_now_iso()} terminal_status={final_status}")
    summary = {
        "training_job_name": training_job_name,
        "region": region,
        "instance_type": instance_type,
        "instance_count": instance_count,
        "volume_size_gb": volume_size_gb,
        "max_runtime_seconds": max_runtime_seconds,
        "output_s3_uri": output_s3_uri,
        "model_artifact_s3_uri": model_artifact_s3_uri,
        "uploaded_inputs": upload_manifest,
        "final_description": {
            "TrainingStartTime": str(terminal_desc.get("TrainingStartTime") or ""),
            "TrainingEndTime": str(terminal_desc.get("TrainingEndTime") or ""),
            "BillableTimeInSeconds": terminal_desc.get("BillableTimeInSeconds"),
            "FinalMetricDataList": terminal_desc.get("FinalMetricDataList") or [],
        },
    }
    return SageMakerRunResult(
        training_job_name=training_job_name,
        final_status=final_status,
        stdout="\n".join(status_lines),
        stderr=stderr,
        attempts=attempts,
        produced_files=produced_files,
        model_local_path=model_local_path,
        model_artifact_s3_uri=str(model_artifact_s3_uri) if model_artifact_s3_uri else None,
        output_s3_uri=output_s3_uri,
        summary=summary,
    )
