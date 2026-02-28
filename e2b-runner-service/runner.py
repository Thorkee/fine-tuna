"""
E2B training runner: upload CSV + script, run in sandbox, optionally autofix with OpenAI.
Ported from the user's e2b_runner_agent.py script.
"""
from __future__ import annotations

import json
import os
import shlex
import time
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple

# Load env (service .env/.env.local + repo root .env/.env.local)
from env import load_runner_env

load_runner_env()

try:
    from e2b_code_interpreter import Sandbox
    if not getattr(Sandbox, "create", None):
        raise ImportError(
            "e2b_code_interpreter.Sandbox has no 'create' method. "
            "Upgrade with: pip install 'e2b-code-interpreter>=2.0.0'"
        )
except ImportError as e:
    Sandbox = None  # type: ignore
    _E2B_IMPORT_ERROR = str(e)
except Exception as e:
    Sandbox = None  # type: ignore
    _E2B_IMPORT_ERROR = f"e2b_code_interpreter: {e}. Try: pip install 'e2b-code-interpreter>=2.0.0'"

try:
    from openai import OpenAI
except Exception:
    OpenAI = None  # type: ignore


@dataclass
class RunResult:
    ok: bool
    attempts: int
    stdout: str
    stderr: str
    sandbox_workdir: str
    produced_files: List[str]
    model_local_path: Optional[str]
    model_sandbox_path: Optional[str]
    applied_patches: List[str]


class E2BModelRunnerError(RuntimeError):
    pass


def get_e2b_import_error() -> str:
    err = globals().get("_E2B_IMPORT_ERROR")
    if err:
        return str(err)
    return "e2b_code_interpreter not installed or incompatible. Install with: pip install 'e2b-code-interpreter>=2.0.0'"


def _env_int(name: str, default: int) -> int:
    raw = (os.getenv(name) or "").strip()
    if raw == "":
        return default
    try:
        return int(raw)
    except Exception:
        return default


def _env_bool(name: str, default: bool) -> bool:
    raw = (os.getenv(name) or "").strip().lower()
    if raw in {"1", "true", "yes", "on"}:
        return True
    if raw in {"0", "false", "no", "off"}:
        return False
    return default


# Curated Colab-like baseline for common data/ML workflows.
_COLAB_CORE_PACKAGE_SPECS: List[Tuple[str, str]] = [
    ("numpy", "numpy"),
    ("pandas", "pandas"),
    ("scipy", "scipy"),
    ("matplotlib", "matplotlib"),
    ("seaborn", "seaborn"),
    ("scikit-learn", "sklearn"),
    ("statsmodels", "statsmodels"),
    ("xgboost", "xgboost"),
    ("plotly", "plotly"),
    ("sympy", "sympy"),
    ("networkx", "networkx"),
    ("joblib", "joblib"),
    ("tqdm", "tqdm"),
    ("tabulate", "tabulate"),
    ("requests", "requests"),
    ("httpx", "httpx"),
    ("beautifulsoup4", "bs4"),
    ("lxml", "lxml"),
    ("pillow", "PIL"),
    ("opencv-python-headless", "cv2"),
    ("pyarrow", "pyarrow"),
    ("openpyxl", "openpyxl"),
    ("pyyaml", "yaml"),
    ("nltk", "nltk"),
    ("spacy", "spacy"),
    ("transformers", "transformers"),
    ("datasets", "datasets"),
    ("accelerate", "accelerate"),
    ("sentencepiece", "sentencepiece"),
    ("evaluate", "evaluate"),
]

# Optional heavier set for users who want closer Colab parity.
_COLAB_EXTENDED_PACKAGE_SPECS: List[Tuple[str, str]] = [
    ("lightgbm", "lightgbm"),
    ("catboost", "catboost"),
    ("shap", "shap"),
    ("umap-learn", "umap"),
    ("gensim", "gensim"),
    ("sentence-transformers", "sentence_transformers"),
    ("torch", "torch"),
    ("torchvision", "torchvision"),
    ("torchaudio", "torchaudio"),
]

_DEPENDENCY_BOOTSTRAP_PREFIX = "__TUNA_BOOTSTRAP_JSON__"


def _dedupe_keep_order(values: List[str]) -> List[str]:
    seen = set()
    out: List[str] = []
    for value in values:
        if value in seen:
            continue
        seen.add(value)
        out.append(value)
    return out


def _parse_package_csv(raw: str) -> List[str]:
    if not raw:
        return []
    out: List[str] = []
    for chunk in raw.replace("\n", ",").split(","):
        piece = chunk.strip()
        if not piece:
            continue
        for token in piece.split():
            cleaned = token.strip()
            if cleaned:
                out.append(cleaned)
    return _dedupe_keep_order(out)


def _resolve_colab_profile() -> str:
    raw = (os.getenv("RUNNER_E2B_PREINSTALL_PROFILE") or "").strip().lower()
    if raw in {"", "default"}:
        return "core"
    if raw in {"off", "none", "disabled", "false", "0"}:
        return "off"
    if raw in {"full", "extended"}:
        return "extended"
    if raw == "core":
        return "core"
    return "core"


def _selected_colab_package_specs(profile: str) -> List[Tuple[str, str]]:
    if profile == "off":
        return []
    specs = list(_COLAB_CORE_PACKAGE_SPECS)
    if profile == "extended":
        specs.extend(_COLAB_EXTENDED_PACKAGE_SPECS)
    return specs


def _extract_dependency_bootstrap_result(stdout: str) -> Optional[Dict[str, Any]]:
    for line in stdout.splitlines():
        if not line.startswith(_DEPENDENCY_BOOTSTRAP_PREFIX):
            continue
        payload = line[len(_DEPENDENCY_BOOTSTRAP_PREFIX):]
        try:
            parsed = json.loads(payload)
            if isinstance(parsed, dict):
                return parsed
        except Exception:
            return None
    return None


def build_e2b_sandbox_create_kwargs(timeout_seconds: Optional[int] = None) -> Dict[str, Any]:
    kwargs: Dict[str, Any] = {}
    if timeout_seconds is not None:
        try:
            timeout_int = int(timeout_seconds)
            if timeout_int > 0:
                kwargs["timeout"] = timeout_int
        except Exception:
            pass
    template = (os.getenv("RUNNER_E2B_TEMPLATE") or "").strip()
    if template:
        kwargs["template"] = template
    return kwargs


def create_e2b_sandbox(timeout_seconds: Optional[int] = None) -> Any:
    if Sandbox is None:
        raise E2BModelRunnerError(get_e2b_import_error())
    kwargs = build_e2b_sandbox_create_kwargs(timeout_seconds)
    if not kwargs:
        return Sandbox.create()
    try:
        return Sandbox.create(**kwargs)
    except TypeError:
        fallback = dict(kwargs)
        fallback.pop("template", None)
        if fallback:
            try:
                return Sandbox.create(**fallback)
            except TypeError:
                pass
        return Sandbox.create()


def bootstrap_e2b_python_dependencies(sbx: Any) -> Dict[str, Any]:
    enabled = _env_bool("RUNNER_E2B_PREINSTALL_COLAB_DEPS", True)
    profile = _resolve_colab_profile()
    strict = _env_bool("RUNNER_E2B_PREINSTALL_STRICT", False)
    if not enabled or profile == "off":
        return {"ok": True, "skipped": True, "profile": profile, "installed": []}

    base_specs = _selected_colab_package_specs(profile)
    extra_packages = _parse_package_csv(os.getenv("RUNNER_E2B_PREINSTALL_EXTRA_PACKAGES", ""))
    requested_packages = _dedupe_keep_order([pkg for pkg, _ in base_specs] + extra_packages)
    if not requested_packages:
        return {"ok": True, "skipped": True, "profile": profile, "installed": []}

    payload = {
        "requirements": [{"package": pkg, "module": mod} for pkg, mod in base_specs],
        "extra_packages": extra_packages,
    }
    timeout_seconds = _env_int("RUNNER_E2B_PREINSTALL_TIMEOUT_SECONDS", 1200)
    if timeout_seconds < 0:
        timeout_seconds = 0

    script_lines = [
        "import importlib.util, json, subprocess, sys",
        f"payload = {json.dumps(payload, ensure_ascii=True)}",
        "requirements = payload.get('requirements') or []",
        "extra_packages = payload.get('extra_packages') or []",
        "missing = []",
        "for item in requirements:",
        "    if not isinstance(item, dict):",
        "        continue",
        "    package_name = str(item.get('package') or '').strip()",
        "    module_name = str(item.get('module') or '').strip()",
        "    if not package_name:",
        "        continue",
        "    installed = False",
        "    if module_name:",
        "        try:",
        "            installed = importlib.util.find_spec(module_name) is not None",
        "        except Exception:",
        "            installed = False",
        "    if not installed and package_name not in missing:",
        "        missing.append(package_name)",
        "for package_name in extra_packages:",
        "    value = str(package_name or '').strip()",
        "    if value and value not in missing:",
        "        missing.append(value)",
        "result = {'ok': True, 'missing': list(missing), 'installed': [], 'failed': []}",
        "if missing:",
        "    cmd = [sys.executable, '-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', '--quiet', *missing]",
        "    proc = subprocess.run(cmd, capture_output=True, text=True)",
        "    if proc.returncode == 0:",
        "        result['installed'] = list(missing)",
        "    else:",
        "        result['ok'] = False",
        "        result['failed'] = list(missing)",
        "        result['pip_stdout'] = (proc.stdout or '')[-2000:]",
        "        result['pip_stderr'] = (proc.stderr or '')[-4000:]",
        f"print('{_DEPENDENCY_BOOTSTRAP_PREFIX}' + json.dumps(result, sort_keys=True))",
        "if not result.get('ok'):",
        "    raise SystemExit(1)",
    ]
    try:
        execution = sbx.run_code("\n".join(script_lines), timeout=timeout_seconds)
        stdout, stderr, _ = _format_exec_logs(execution)
    except Exception as exc:
        message = f"Dependency bootstrap command failed: {exc}"
        if strict:
            raise E2BModelRunnerError(message) from exc
        return {
            "ok": False,
            "profile": profile,
            "strict": strict,
            "requested": requested_packages,
            "error": message,
        }

    parsed = _extract_dependency_bootstrap_result(stdout)
    if not parsed:
        message = "Dependency bootstrap did not return structured output."
        stderr_text = (stderr or "").strip()
        if stderr_text:
            message = f"{message} {stderr_text[:500]}"
        if strict:
            raise E2BModelRunnerError(message)
        return {
            "ok": False,
            "profile": profile,
            "strict": strict,
            "requested": requested_packages,
            "error": message,
        }

    parsed["profile"] = profile
    parsed["strict"] = strict
    parsed["requested"] = requested_packages
    if parsed.get("ok"):
        return parsed

    failure_detail = str(parsed.get("pip_stderr") or parsed.get("error") or "Unknown pip failure")
    if strict:
        raise E2BModelRunnerError(f"Failed to prepare sandbox dependencies: {failure_detail[:500]}")
    return parsed


def _clamp_int(value: int, *, min_value: int, max_value: int) -> int:
    return max(min_value, min(max_value, value))


def _effective_sandbox_timeout_seconds(requested: Optional[int]) -> int:
    """
    E2B sandboxes default to 300s (5 minutes) unless timeout is set.
    Default to 3600s (Base/Hobby max) and clamp to a configurable max.
    """
    default_timeout = _env_int("RUNNER_E2B_SANDBOX_TIMEOUT_SECONDS", 3600)
    max_timeout = _env_int("RUNNER_E2B_SANDBOX_MAX_TIMEOUT_SECONDS", 3600)
    desired = requested if requested is not None else default_timeout
    try:
        desired_int = int(desired)
    except Exception:
        desired_int = default_timeout
    if desired_int <= 0:
        desired_int = default_timeout
    effective_max = max_timeout if max_timeout > 0 else desired_int
    if effective_max > 0:
        desired_int = min(desired_int, effective_max)
    return _clamp_int(desired_int, min_value=60, max_value=effective_max if effective_max > 0 else desired_int)


def _refresh_sandbox_timeout(sbx: Sandbox, timeout_seconds: int) -> None:
    """Best-effort extend sandbox lifetime from 'now'."""
    try:
        setter = getattr(sbx, "set_timeout", None)
        if callable(setter):
            setter(int(timeout_seconds))
    except Exception:
        pass


def _read_local_text(path: str, max_chars: int = 200_000) -> str:
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        data = f.read()
    if len(data) > max_chars:
        return data[:max_chars] + "\n\n...[truncated]..."
    return data


def _read_local_bytes(path: str, max_bytes: int = 20_000_000) -> bytes:
    with open(path, "rb") as f:
        data = f.read(max_bytes + 1)
    if len(data) > max_bytes:
        raise ValueError(f"File too large (>{max_bytes} bytes): {path}")
    return data


def _list_dir_recursive(sbx: Sandbox, root: str) -> List[str]:
    out: List[str] = []

    def walk(dir_path: str):
        entries = sbx.files.list(dir_path)
        for e in entries:
            out.append(e.path)
            if str(e.type).lower().endswith("dir") or "DIR" in str(e.type):
                if getattr(e, "symlink_target", None):
                    continue
                if e.path in ("/proc", "/sys", "/dev"):
                    continue
                walk(e.path)

    walk(root)
    return out


def _build_run_command(
    script_name: str,
    input_name: str,
    model_out: str,
    extra_args: Optional[List[str]],
    sandbox_workdir: str,
) -> str:
    base = f"python {script_name}"
    if extra_args:
        base += " " + " ".join(extra_args)
    input_abs = f"{sandbox_workdir}/{input_name}"
    out_abs = f"{sandbox_workdir}/{model_out}"
    cmd_input = base + f" --input {input_abs} --out {out_abs}"
    cmd_csv = base + f" --csv {input_abs} --out {out_abs}"
    base_no_args = f"python {script_name}"
    return cmd_input + "\n" + cmd_csv + "\n" + base_no_args


def _kaggle_bootstrap_prefix() -> str:
    return "\n".join(
        [
            "set -euo pipefail",
            "python - <<'PY'",
            "import json, os, pathlib, subprocess, sys",
            "token = (os.environ.get('KAGGLE_TOKEN_VALUE') or '').strip()",
            "if not token:",
            "    raise SystemExit('Missing Kaggle token in KAGGLE_TOKEN_VALUE.')",
            "username = None",
            "key = None",
            "try:",
            "    parsed = json.loads(token)",
            "    if isinstance(parsed, dict):",
            "        username = str(parsed.get('username') or '').strip()",
            "        key = str(parsed.get('key') or '').strip()",
            "except Exception:",
            "    pass",
            "if (not username or not key) and ':' in token:",
            "    left, right = token.split(':', 1)",
            "    username = username or left.strip()",
            "    key = key or right.strip()",
            "if not username or not key:",
            "    raise SystemExit('Kaggle token must be a kaggle.json string or username:key.')",
            "cfg_dir = pathlib.Path.home() / '.kaggle'",
            "cfg_dir.mkdir(parents=True, exist_ok=True)",
            "cfg_path = cfg_dir / 'kaggle.json'",
            "cfg_path.write_text(json.dumps({'username': username, 'key': key}), encoding='utf-8')",
            "cfg_path.chmod(0o600)",
            "try:",
            "    import kaggle  # noqa: F401",
            "except Exception:",
            "    subprocess.check_call([sys.executable, '-m', 'pip', 'install', '--quiet', 'kaggle'])",
            "PY",
        ]
    )


def _shell_quote(value: str) -> str:
    return shlex.quote(value)


def build_kaggle_dataset_download_command(dataset: str, target_dir: str, unzip: bool = True) -> str:
    dataset_value = dataset.strip()
    target_value = target_dir.strip() or "/code/kaggle"
    unzip_flag = "--unzip" if unzip else ""
    parts = [
        _kaggle_bootstrap_prefix(),
        f"mkdir -p {_shell_quote(target_value)}",
        "kaggle datasets download "
        f"--dataset {_shell_quote(dataset_value)} "
        f"--path {_shell_quote(target_value)} "
        f"{unzip_flag}".strip(),
    ]
    return "\n".join(parts)


def build_kaggle_dataset_upload_command(
    source_dir: str,
    dataset_slug: str,
    title: Optional[str] = None,
    *,
    private: bool = True,
    message: Optional[str] = None,
) -> str:
    source_value = source_dir.strip()
    slug_value = dataset_slug.strip()
    title_value = (title or "").strip() or slug_value.split("/")[-1]
    privacy_value = "private" if private else "public"
    message_value = (message or "").strip() or "Updated by tuna runner"
    metadata_cmd = "\n".join(
        [
            "python - <<'PY'",
            "import json, os, pathlib",
            "src = pathlib.Path(os.environ['KAGGLE_SOURCE_DIR'])",
            "slug = os.environ['KAGGLE_DATASET_SLUG']",
            "title = os.environ['KAGGLE_DATASET_TITLE']",
            "privacy = os.environ['KAGGLE_DATASET_PRIVACY']",
            "meta_path = src / 'dataset-metadata.json'",
            "if not meta_path.exists():",
            "    meta = {'title': title, 'id': slug, 'licenses': [{'name': 'CC0-1.0'}], 'isPrivate': privacy == 'private'}",
            "    meta_path.write_text(json.dumps(meta, indent=2), encoding='utf-8')",
            "PY",
        ]
    )
    return "\n".join(
        [
            _kaggle_bootstrap_prefix(),
            f"test -d {_shell_quote(source_value)}",
            metadata_cmd,
            f"cd {_shell_quote(source_value)}",
            f"kaggle datasets version -p . -m {_shell_quote(message_value)} --dir-mode zip",
        ]
    )


def build_kaggle_competition_submit_command(competition: str, file_path: str, message: str) -> str:
    comp_value = competition.strip()
    file_value = file_path.strip()
    msg_value = message.strip() or "Submission from tuna runner"
    return "\n".join(
        [
            _kaggle_bootstrap_prefix(),
            f"test -f {_shell_quote(file_value)}",
            "kaggle competitions submit "
            f"--competition {_shell_quote(comp_value)} "
            f"--file {_shell_quote(file_value)} "
            f"--message {_shell_quote(msg_value)}",
        ]
    )


def build_kaggle_kernel_push_command(
    source_dir: str,
    kernel_slug: str,
    *,
    title: Optional[str] = None,
    competition: Optional[str] = None,
    enable_gpu: bool = False,
    enable_internet: bool = True,
) -> str:
    source_value = source_dir.strip()
    slug_value = kernel_slug.strip()
    title_value = (title or "").strip() or slug_value.split("/")[-1]
    competition_value = (competition or "").strip()
    kernel_metadata_cmd = "\n".join(
        [
            "python - <<'PY'",
            "import json, os, pathlib",
            "src = pathlib.Path(os.environ['KAGGLE_SOURCE_DIR'])",
            "kernel_slug = os.environ['KAGGLE_KERNEL_SLUG']",
            "kernel_title = os.environ['KAGGLE_KERNEL_TITLE']",
            "competition = os.environ.get('KAGGLE_COMPETITION') or ''",
            "meta_path = src / 'kernel-metadata.json'",
            "if not meta_path.exists():",
            "    meta = {",
            "      'id': kernel_slug,",
            "      'title': kernel_title,",
            "      'code_file': 'main.ipynb' if (src / 'main.ipynb').exists() else 'main.py',",
            "      'language': 'python',",
            "      'kernel_type': 'notebook' if (src / 'main.ipynb').exists() else 'script',",
            "      'is_private': True,",
            "      'enable_gpu': os.environ.get('KAGGLE_ENABLE_GPU') == '1',",
            "      'enable_internet': os.environ.get('KAGGLE_ENABLE_INTERNET') == '1',",
            "    }",
            "    if competition:",
            "      meta['competition_sources'] = [competition]",
            "    meta_path.write_text(json.dumps(meta, indent=2), encoding='utf-8')",
            "PY",
        ]
    )
    return "\n".join(
        [
            _kaggle_bootstrap_prefix(),
            f"test -d {_shell_quote(source_value)}",
            kernel_metadata_cmd,
            f"cd {_shell_quote(source_value)}",
            "kaggle kernels push -p .",
        ]
    )


def _format_exec_logs(execution: Any) -> Tuple[str, str, str]:
    stdout, stderr = "", ""
    try:
        logs = execution.logs
        if hasattr(logs, "stdout") and isinstance(logs.stdout, list):
            stdout = "".join(logs.stdout)
        if hasattr(logs, "stderr") and isinstance(logs.stderr, list):
            stderr = "".join(logs.stderr)
        return stdout, stderr, f"STDOUT:\n{stdout}\n\nSTDERR:\n{stderr}"
    except Exception:
        pass
    for attr in ("stdout", "text", "result"):
        if hasattr(execution, attr):
            try:
                stdout = str(getattr(execution, attr) or "")
                break
            except Exception:
                continue
    if hasattr(execution, "error"):
        try:
            stderr = str(execution.error or "")
        except Exception:
            stderr = ""
    return stdout, stderr, f"STDOUT:\n{stdout}\n\nSTDERR:\n{stderr}"


def _openai_suggest_patch(
    client: Any,
    script_text: str,
    stderr: str,
    stdout: str,
    input_preview: str,
) -> Optional[str]:
    if client is None:
        return None
    model = os.getenv("OPENAI_MODEL", "gpt-4o")
    prompt = f"""
You are helping fix a Python training script that runs in a clean Linux container.
The script should read an input file and produce a model file (model.pkl).
It currently errors.

Rules:
- Output ONLY a unified diff patch (git-style) that modifies the script.
- Do not add new external dependencies unless absolutely necessary.
- Prefer robust, minimal changes.
- The script must exit with code 0 on success.
- Keep output model file at '/code/model.pkl' by default, or respect --out if present.
- Input path should be '/code/input.*' by default, or respect --input / --csv if present.

Input preview (first ~50 lines or so):
{input_preview}

STDOUT:
{stdout}

STDERR:
{stderr}

Script:
{script_text}
""".strip()
    try:
        resp = client.chat.completions.create(
            model=model,
            messages=[{"role": "user", "content": prompt}],
        )
        patch = (resp.choices[0].message.content or "").strip()
        if patch.startswith("diff --git") or patch.startswith("---") or patch.startswith("***"):
            return patch
        patch = patch.strip("`")
        if "diff --git" in patch or patch.startswith("---"):
            return patch
        return None
    except Exception:
        return None


def _apply_unified_diff(original_text: str, patch: str, filename: str) -> Optional[str]:
    lines = original_text.splitlines(keepends=True)
    patch_lines = patch.splitlines(keepends=True)
    hunks: List[Tuple[int, int, int, int, List[str]]] = []
    i = 0
    while i < len(patch_lines):
        line = patch_lines[i]
        if line.startswith("@@"):
            try:
                parts = line.split()
                minus, plus = parts[1], parts[2]
                m_l, m_s = minus[1:].split(",")
                p_l, p_s = plus[1:].split(",")
                m_l, m_s, p_l, p_s = int(m_l), int(m_s), int(p_l), int(p_s)
            except Exception:
                return None
            i += 1
            body: List[str] = []
            while i < len(patch_lines) and not patch_lines[i].startswith("@@"):
                if patch_lines[i].startswith("diff --git") or patch_lines[i].startswith("--- "):
                    break
                body.append(patch_lines[i])
                i += 1
            hunks.append((m_l, m_s, p_l, p_s, body))
            continue
        i += 1
    if not hunks:
        return None
    out_lines: List[str] = []
    src_index = 0
    for (m_l, _m_s, _p_l, _p_s, body) in hunks:
        target_index = m_l - 1
        if target_index < src_index:
            return None
        out_lines.extend(lines[src_index:target_index])
        src_index = target_index
        for b in body:
            tag = b[:1]
            content = b[1:]
            if tag == " ":
                if src_index >= len(lines) or lines[src_index] != content:
                    return None
                out_lines.append(lines[src_index])
                src_index += 1
            elif tag == "-":
                if src_index >= len(lines) or lines[src_index] != content:
                    return None
                src_index += 1
            elif tag == "+":
                out_lines.append(content)
            else:
                return None
    out_lines.extend(lines[src_index:])
    return "".join(out_lines)


def _model_exists_via_list(
    sbx: Sandbox,
    sandbox_workdir: str,
    expected_model_filename: str,
    all_stderr: str,
) -> Tuple[bool, Optional[str], str]:
    target_name = expected_model_filename
    for _ in range(15):
        try:
            entries = sbx.files.list(sandbox_workdir)
            names = [e.name for e in entries]
            if target_name in names:
                return True, f"{sandbox_workdir}/{expected_model_filename}", all_stderr
        except Exception as e:
            all_stderr += f"\n--- files.list failed ---\n{e}\n"
        time.sleep(0.2)
    return False, None, all_stderr


_PREFETCH_RESULT_PREFIX = "__PREFETCH_RESULT__"


def _extract_prefetch_result(stdout: str) -> Optional[Dict[str, Any]]:
    for line in reversed(stdout.splitlines()):
        if not line.startswith(_PREFETCH_RESULT_PREFIX):
            continue
        payload = line[len(_PREFETCH_RESULT_PREFIX):].strip()
        if not payload:
            continue
        try:
            parsed = json.loads(payload)
            if isinstance(parsed, dict):
                return parsed
        except Exception:
            continue
    return None


def _prefetch_assets_in_sandbox(
    sbx: Sandbox,
    sandbox_workdir: str,
    *,
    hf_models: Optional[List[Dict[str, Any]]] = None,
    hf_datasets: Optional[List[Dict[str, Any]]] = None,
    github_repos: Optional[List[Dict[str, Any]]] = None,
    hf_token: Optional[str] = None,
    github_token: Optional[str] = None,
    kaggle_datasets: Optional[List[Dict[str, Any]]] = None,
    kaggle_token: Optional[str] = None,
) -> Tuple[Dict[str, str], str, str]:
    payload = {
        "sandbox_workdir": sandbox_workdir,
        "hf_models": hf_models or [],
        "hf_datasets": hf_datasets or [],
        "github_repos": github_repos or [],
        "kaggle_datasets": kaggle_datasets or [],
        "hf_token": (hf_token or "").strip(),
        "github_token": (github_token or "").strip(),
        "kaggle_token": (kaggle_token or "").strip(),
        "hf_cache_root": (os.getenv("RUNNER_HF_CACHE_ROOT") or "").strip(),
        "github_root": (os.getenv("RUNNER_GITHUB_ROOT") or "").strip(),
    }
    payload_json = json.dumps(payload)
    script_lines = [
        "import json, os, pathlib, shutil, subprocess, sys, tempfile, urllib.request, zipfile",
        f'PREFIX = "{_PREFETCH_RESULT_PREFIX}"',
        "result = None",
        "try:",
        f"    payload = json.loads({json.dumps(payload_json)})",
        "    workdir = str(payload.get('sandbox_workdir') or '/code')",
        "    hf_models = payload.get('hf_models') or []",
        "    hf_datasets = payload.get('hf_datasets') or []",
        "    github_repos = payload.get('github_repos') or []",
        "    kaggle_datasets = payload.get('kaggle_datasets') or []",
        "    runtime_env = {}",
        "    hf_model_dirs = {}",
        "    hf_dataset_dirs = {}",
        "    github_repo_dirs = {}",
        "    kaggle_dataset_dirs = {}",
        "",
        "    def safe_slug(value):",
        "        cleaned = ''.join(ch if ch.isalnum() or ch in ('-', '_', '.') else '-' for ch in str(value))",
        "        cleaned = cleaned.strip('-._')",
        "        return cleaned or 'item'",
        "",
        "    def normalize_path_filters(values):",
        "        out = []",
        "        for v in values or []:",
        "            s = str(v or '').strip().strip('/')",
        "            if s:",
        "                out.append(s)",
        "        return out",
        "",
        "    def apply_path_filters(root, include_paths, exclude_paths):",
        "        include_paths = normalize_path_filters(include_paths)",
        "        exclude_paths = normalize_path_filters(exclude_paths)",
        "        if not include_paths and not exclude_paths:",
        "            return root",
        "        source = pathlib.Path(root)",
        "        filtered = source.parent / (source.name + '__filtered')",
        "        if filtered.exists():",
        "            shutil.rmtree(filtered)",
        "        filtered.mkdir(parents=True, exist_ok=True)",
        "        for path in source.rglob('*'):",
        "            if not path.is_file():",
        "                continue",
        "            rel = path.relative_to(source).as_posix()",
        "            if include_paths and not any(rel == p or rel.startswith(p + '/') for p in include_paths):",
        "                continue",
        "            if exclude_paths and any(rel == p or rel.startswith(p + '/') for p in exclude_paths):",
        "                continue",
        "            dest = filtered / rel",
        "            dest.parent.mkdir(parents=True, exist_ok=True)",
        "            shutil.copy2(path, dest)",
        "        return str(filtered)",
        "",
        "    def install_hf_if_needed():",
        "        try:",
        "            from huggingface_hub import snapshot_download  # noqa: F401",
        "            return",
        "        except Exception:",
        "            pass",
        "        proc = subprocess.run(",
        "            [sys.executable, '-m', 'pip', 'install', '--quiet', 'huggingface_hub>=0.24.0'],",
        "            text=True,",
        "            capture_output=True,",
        "        )",
        "        if proc.returncode != 0:",
        "            raise RuntimeError('Failed to install huggingface_hub: ' + (proc.stderr or proc.stdout or '').strip())",
        "",
        "    def install_kaggle_if_needed():",
        "        try:",
        "            import kaggle  # noqa: F401",
        "            return",
        "        except Exception:",
        "            pass",
        "        proc = subprocess.run(",
        "            [sys.executable, '-m', 'pip', 'install', '--quiet', 'kaggle'],",
        "            text=True,",
        "            capture_output=True,",
        "        )",
        "        if proc.returncode != 0:",
        "            raise RuntimeError('Failed to install kaggle: ' + (proc.stderr or proc.stdout or '').strip())",
        "",
        "    def configure_kaggle_token(raw_token):",
        "        token = str(raw_token or '').strip()",
        "        if not token:",
        "            raise RuntimeError('kaggle token missing for kaggle_datasets prefetch')",
        "        token_json = None",
        "        if token.startswith('{'):",
        "            try:",
        "                parsed = json.loads(token)",
        "                if isinstance(parsed, dict):",
        "                    token_json = parsed",
        "            except Exception:",
        "                token_json = None",
        "        if token_json is None:",
        "            if ':' not in token:",
        "                raise RuntimeError('kaggle token must be kaggle.json JSON or username:key')",
        "            username, key = token.split(':', 1)",
        "            token_json = {'username': username.strip(), 'key': key.strip()}",
        "        if not token_json.get('username') or not token_json.get('key'):",
        "            raise RuntimeError('kaggle token missing username/key')",
        "        cfg_dir = pathlib.Path.home() / '.kaggle'",
        "        cfg_dir.mkdir(parents=True, exist_ok=True)",
        "        cfg_path = cfg_dir / 'kaggle.json'",
        "        cfg_path.write_text(json.dumps(token_json), encoding='utf-8')",
        "        os.chmod(cfg_path, 0o600)",
        "",
        "    def download_github_zip(repo, ref, dest, token):",
        "        ref_value = (ref or '').strip() or 'HEAD'",
        "        url = f'https://api.github.com/repos/{repo}/zipball/{ref_value}'",
        "        headers = {'User-Agent': 'tuna-runner'}",
        "        if token:",
        "            headers['Authorization'] = f'Bearer {token}'",
        "        req = urllib.request.Request(url, headers=headers)",
        "        with urllib.request.urlopen(req, timeout=300) as resp:",
        "            blob = resp.read()",
        "        with tempfile.TemporaryDirectory() as tmp_dir:",
        "            archive = pathlib.Path(tmp_dir) / 'repo.zip'",
        "            archive.write_bytes(blob)",
        "            with zipfile.ZipFile(str(archive), 'r') as zf:",
        "                zf.extractall(tmp_dir)",
        "            root = pathlib.Path(tmp_dir)",
        "            candidates = [p for p in root.iterdir() if p.is_dir()]",
        "            source_dir = candidates[0] if candidates else root",
        "            if os.path.isdir(dest):",
        "                shutil.rmtree(dest)",
        "            pathlib.Path(dest).parent.mkdir(parents=True, exist_ok=True)",
        "            shutil.copytree(source_dir, dest)",
        "",
        "    def clone_github_repo(repo, ref, dest, token):",
        "        git_bin = shutil.which('git')",
        "        if not git_bin:",
        "            return False, 'git not available'",
        "        if os.path.isdir(dest):",
        "            shutil.rmtree(dest)",
        "        pathlib.Path(dest).parent.mkdir(parents=True, exist_ok=True)",
        "        cmd = [git_bin]",
        "        if token:",
        "            cmd += ['-c', f'http.extraHeader=Authorization: Bearer {token}']",
        "        cmd += ['clone', '--depth', '1']",
        "        if ref:",
        "            cmd += ['--branch', ref]",
        "        cmd += [f'https://github.com/{repo}.git', dest]",
        "        proc = subprocess.run(cmd, text=True, capture_output=True)",
        "        if proc.returncode == 0:",
        "            return True, ''",
        "        return False, (proc.stderr or proc.stdout or '').strip()",
        "",
        "    if hf_models or hf_datasets:",
        "        hf_root = pathlib.Path(workdir) / '.hf'",
        "        hf_cache_root = str(payload.get('hf_cache_root') or '').strip() or str(hf_root / 'cache')",
        "        pathlib.Path(hf_cache_root).mkdir(parents=True, exist_ok=True)",
        "        runtime_env['HF_HOME'] = hf_cache_root",
        "        runtime_env['HF_HUB_CACHE'] = os.path.join(hf_cache_root, 'hub')",
        "        runtime_env['HF_DATASETS_CACHE'] = os.path.join(hf_cache_root, 'datasets')",
        "        runtime_env['TRANSFORMERS_CACHE'] = os.path.join(hf_cache_root, 'transformers')",
        "        os.environ.update(runtime_env)",
        "        hf_token = str(payload.get('hf_token') or '').strip()",
        "        if hf_token:",
        "            os.environ['HUGGINGFACE_HUB_TOKEN'] = hf_token",
        "        install_hf_if_needed()",
        "        from huggingface_hub import snapshot_download",
        "        for item in hf_models:",
        "            repo = str((item or {}).get('repo') or '').strip()",
        "            if not repo:",
        "                continue",
        "            target = hf_root / 'models' / safe_slug(repo)",
        "            if target.exists():",
        "                shutil.rmtree(target)",
        "            kwargs = {'repo_id': repo, 'local_dir': str(target)}",
        "            revision = str((item or {}).get('revision') or '').strip()",
        "            if revision:",
        "                kwargs['revision'] = revision",
        "            allow_patterns = [str(v) for v in ((item or {}).get('allow_patterns') or []) if str(v).strip()]",
        "            ignore_patterns = [str(v) for v in ((item or {}).get('ignore_patterns') or []) if str(v).strip()]",
        "            if allow_patterns:",
        "                kwargs['allow_patterns'] = allow_patterns",
        "            if ignore_patterns:",
        "                kwargs['ignore_patterns'] = ignore_patterns",
        "            if hf_token:",
        "                kwargs['token'] = hf_token",
        "            snapshot_download(**kwargs)",
        "            hf_model_dirs[repo] = str(target)",
        "        for item in hf_datasets:",
        "            repo = str((item or {}).get('repo') or '').strip()",
        "            if not repo:",
        "                continue",
        "            target = hf_root / 'datasets' / safe_slug(repo)",
        "            if target.exists():",
        "                shutil.rmtree(target)",
        "            kwargs = {'repo_id': repo, 'repo_type': 'dataset', 'local_dir': str(target)}",
        "            revision = str((item or {}).get('revision') or '').strip()",
        "            if revision:",
        "                kwargs['revision'] = revision",
        "            allow_patterns = [str(v) for v in ((item or {}).get('allow_patterns') or []) if str(v).strip()]",
        "            ignore_patterns = [str(v) for v in ((item or {}).get('ignore_patterns') or []) if str(v).strip()]",
        "            if allow_patterns:",
        "                kwargs['allow_patterns'] = allow_patterns",
        "            if ignore_patterns:",
        "                kwargs['ignore_patterns'] = ignore_patterns",
        "            if hf_token:",
        "                kwargs['token'] = hf_token",
        "            snapshot_download(**kwargs)",
        "            hf_dataset_dirs[repo] = str(target)",
        "        if hf_model_dirs:",
        "            runtime_env['HF_MODEL_DIR'] = next(iter(hf_model_dirs.values()))",
        "        if hf_dataset_dirs:",
        "            runtime_env['HF_DATASET_DIR'] = next(iter(hf_dataset_dirs.values()))",
        "        runtime_env['HF_MODEL_DIRS'] = json.dumps(hf_model_dirs, sort_keys=True)",
        "        runtime_env['HF_DATASET_DIRS'] = json.dumps(hf_dataset_dirs, sort_keys=True)",
        "",
        "    if github_repos:",
        "        github_root = str(payload.get('github_root') or '').strip() or str(pathlib.Path(workdir) / '.gh')",
        "        pathlib.Path(github_root).mkdir(parents=True, exist_ok=True)",
        "        github_token = str(payload.get('github_token') or '').strip()",
        "        for item in github_repos:",
        "            repo = str((item or {}).get('repo') or '').strip()",
        "            if not repo or '/' not in repo:",
        "                continue",
        "            owner, name = repo.split('/', 1)",
        "            ref = str((item or {}).get('ref') or '').strip()",
        "            repo_root = os.path.join(github_root, safe_slug(owner), safe_slug(name))",
        "            cloned, clone_error = clone_github_repo(repo, ref, repo_root, github_token)",
        "            if not cloned:",
        "                try:",
        "                    download_github_zip(repo, ref, repo_root, github_token)",
        "                except Exception as zip_error:",
        "                    detail = f'git: {clone_error}; zip: {zip_error}' if clone_error else str(zip_error)",
        "                    raise RuntimeError(f'Failed to fetch github repo {repo}: {detail}')",
        "            effective_root = repo_root",
        "            subdir = str((item or {}).get('subdir') or '').strip().strip('/')",
        "            if subdir:",
        "                candidate = os.path.join(repo_root, subdir)",
        "                if not os.path.isdir(candidate):",
        "                    raise RuntimeError(f'GitHub subdir not found for {repo}: {subdir}')",
        "                effective_root = candidate",
        "            effective_root = apply_path_filters(",
        "                effective_root,",
        "                (item or {}).get('include_paths') or [],",
        "                (item or {}).get('exclude_paths') or [],",
        "            )",
        "            github_repo_dirs[repo] = str(effective_root)",
        "        if github_repo_dirs:",
        "            runtime_env['GITHUB_REPO_DIR'] = next(iter(github_repo_dirs.values()))",
        "        runtime_env['GITHUB_REPO_DIRS'] = json.dumps(github_repo_dirs, sort_keys=True)",
        "",
        "    if kaggle_datasets:",
        "        install_kaggle_if_needed()",
        "        configure_kaggle_token(payload.get('kaggle_token') or '')",
        "        kaggle_root = pathlib.Path(workdir) / '.kaggle_data'",
        "        kaggle_root.mkdir(parents=True, exist_ok=True)",
        "        for item in kaggle_datasets:",
        "            dataset = str((item or {}).get('dataset') or '').strip()",
        "            if not dataset or '/' not in dataset:",
        "                continue",
        "            target_dir = str((item or {}).get('target_dir') or '').strip()",
        "            if not target_dir:",
        "                target_dir = str(kaggle_root / safe_slug(dataset))",
        "            pathlib.Path(target_dir).mkdir(parents=True, exist_ok=True)",
        "            unzip = bool((item or {}).get('unzip', True))",
        "            cmd = ['kaggle', 'datasets', 'download', '-d', dataset, '-p', target_dir]",
        "            if unzip:",
        "                cmd.append('--unzip')",
        "            proc = subprocess.run(cmd, text=True, capture_output=True)",
        "            if proc.returncode != 0:",
        "                raise RuntimeError('kaggle download failed for ' + dataset + ': ' + ((proc.stderr or proc.stdout or '').strip()))",
        "            kaggle_dataset_dirs[dataset] = str(target_dir)",
        "        if kaggle_dataset_dirs:",
        "            runtime_env['KAGGLE_DATASET_DIR'] = next(iter(kaggle_dataset_dirs.values()))",
        "        runtime_env['KAGGLE_DATASET_DIRS'] = json.dumps(kaggle_dataset_dirs, sort_keys=True)",
        "",
        "    result = {",
        "        'ok': True,",
        "        'runtime_env': runtime_env,",
        "        'hf_model_dirs': hf_model_dirs,",
        "        'hf_dataset_dirs': hf_dataset_dirs,",
        "        'github_repo_dirs': github_repo_dirs,",
        "        'kaggle_dataset_dirs': kaggle_dataset_dirs,",
        "    }",
        "except Exception as exc:",
        "    result = {'ok': False, 'error': str(exc), 'runtime_env': runtime_env if 'runtime_env' in dir() else {}}",
        "print(PREFIX + json.dumps(result))",
    ]
    # Disable the default ~5 minute run_code timeout for prefetch steps.
    prefetch_timeout = int(os.getenv("RUNNER_PREFETCH_TIMEOUT_SECONDS", "900") or "900")
    execution = sbx.run_code("\n".join(script_lines), timeout=prefetch_timeout)
    stdout, stderr, _ = _format_exec_logs(execution)
    parsed = _extract_prefetch_result(stdout)
    if not parsed:
        detail_parts = []
        if stderr.strip():
            detail_parts.append(f"stderr:\n{stderr[:2000]}")
        if stdout.strip():
            detail_parts.append(f"stdout:\n{stdout[:2000]}")
        detail = "\n".join(detail_parts) if detail_parts else "No output captured."
        raise E2BModelRunnerError(
            f"Prefetch step did not return structured output.\n{detail}"
        )
    if not parsed.get("ok"):
        raise E2BModelRunnerError(
            f"Prefetch failed: {parsed.get('error') or 'Unknown error'}"
        )
    env_raw = parsed.get("runtime_env")
    runtime_env: Dict[str, str] = {}
    if isinstance(env_raw, dict):
        for key, value in env_raw.items():
            if isinstance(key, str) and isinstance(value, str):
                runtime_env[key] = value
    return runtime_env, stdout, stderr


def run_training_in_e2b(
    input_path: str,
    script_path: str,
    *,
    input_name: Optional[str] = None,
    expected_model_filename: str = "model.pkl",
    sandbox_workdir: str = "/code",
    timeout_seconds: Optional[int] = None,
    extra_args: Optional[List[str]] = None,
    max_attempts: int = 3,
    use_openai_autofix: bool = True,
    local_output_dir: str = "./outputs",
    extra_inputs: Optional[List[Tuple[str, str]]] = None,
    hf_models: Optional[List[Dict[str, Any]]] = None,
    hf_datasets: Optional[List[Dict[str, Any]]] = None,
    github_repos: Optional[List[Dict[str, Any]]] = None,
    hf_token: Optional[str] = None,
    github_token: Optional[str] = None,
    kaggle_datasets: Optional[List[Dict[str, Any]]] = None,
    kaggle_token: Optional[str] = None,
) -> RunResult:
    if Sandbox is None:
        raise E2BModelRunnerError(get_e2b_import_error())
    if not os.path.exists(input_path):
        raise FileNotFoundError(input_path)
    if not os.path.exists(script_path):
        raise FileNotFoundError(script_path)
    api_key = (os.getenv("E2B_API_KEY") or "").strip()
    if not api_key:
        raise E2BModelRunnerError("E2B_API_KEY is missing. Set it in the runner service environment.")
    os.makedirs(local_output_dir, exist_ok=True)

    script_name = os.path.basename(script_path)
    input_name = (input_name or os.path.basename(input_path)).strip() or os.path.basename(input_path)
    openai_client = None
    if use_openai_autofix and OpenAI is not None and os.getenv("OPENAI_API_KEY"):
        openai_client = OpenAI()

    script_text = _read_local_text(script_path)
    input_preview = _read_local_text(input_path, max_chars=50_000)

    applied_patches: List[str] = []
    all_stdout = ""
    all_stderr = ""
    produced_files: List[str] = []
    model_local_path: Optional[str] = None
    model_sandbox_path: Optional[str] = None
    runtime_env: Dict[str, str] = {}

    sbx_timeout = _effective_sandbox_timeout_seconds(timeout_seconds)
    sbx_ctx = create_e2b_sandbox(sbx_timeout)
    with sbx_ctx as sbx:
        _refresh_sandbox_timeout(sbx, sbx_timeout)
        bootstrap_result = bootstrap_e2b_python_dependencies(sbx)
        if bootstrap_result.get("installed"):
            installed_count = len(bootstrap_result.get("installed") or [])
            all_stdout += f"\n--- dependency bootstrap ---\nInstalled {installed_count} package(s)."
        elif not bootstrap_result.get("ok"):
            detail = str(bootstrap_result.get("error") or bootstrap_result.get("pip_stderr") or "Unknown error")
            all_stderr += f"\n--- dependency bootstrap warning ---\n{detail}"
        sbx.files.make_dir(sandbox_workdir)
        sbx.files.write(f"{sandbox_workdir}/{script_name}", script_text)
        input_bytes = _read_local_bytes(input_path, max_bytes=20_000_000)
        sbx.files.write(f"{sandbox_workdir}/{input_name}", input_bytes)
        for extra in extra_inputs or []:
            name, path = extra
            if not name or not path:
                continue
            extra_bytes = _read_local_bytes(path, max_bytes=20_000_000)
            sbx.files.write(f"{sandbox_workdir}/{name}", extra_bytes)
        if hf_models or hf_datasets or github_repos or kaggle_datasets:
            _refresh_sandbox_timeout(sbx, sbx_timeout)
            prefetched_env, prefetch_stdout, prefetch_stderr = _prefetch_assets_in_sandbox(
                sbx,
                sandbox_workdir,
                hf_models=hf_models,
                hf_datasets=hf_datasets,
                github_repos=github_repos,
                hf_token=hf_token,
                github_token=github_token,
                kaggle_datasets=kaggle_datasets,
                kaggle_token=kaggle_token,
            )
            runtime_env.update(prefetched_env)
            if prefetch_stdout.strip():
                all_stdout += f"\n--- prefetch stdout ---\n{prefetch_stdout}"
            if prefetch_stderr.strip():
                all_stderr += f"\n--- prefetch stderr ---\n{prefetch_stderr}"
        hf_token_value = (hf_token or "").strip()
        github_token_value = (github_token or "").strip()
        kaggle_token_value = (kaggle_token or "").strip()
        if hf_token_value:
            runtime_env["HUGGINGFACE_HUB_TOKEN"] = hf_token_value
        if github_token_value:
            runtime_env["GITHUB_TOKEN"] = github_token_value
        if kaggle_token_value:
            runtime_env["KAGGLE_TOKEN"] = kaggle_token_value

        cmd_variants = _build_run_command(
            script_name, input_name, expected_model_filename, extra_args, sandbox_workdir
        ).splitlines()

        attempt = 0
        ok = False

        while attempt < max_attempts and not ok:
            attempt += 1
            stdout, stderr = "", ""
            _refresh_sandbox_timeout(sbx, sbx_timeout)
            for idx, cmd in enumerate(cmd_variants):
                py = f"""
import os, subprocess, sys
os.chdir("{sandbox_workdir}")
run_env = os.environ.copy()
run_env.update({json.dumps(runtime_env)})
p = subprocess.run({json.dumps(cmd)}, shell=True, text=True, capture_output=True, env=run_env)
print(p.stdout, end="")
print(p.stderr, end="", file=sys.stderr)
sys.exit(p.returncode)
""".strip()
                # Disable the default ~5 minute run_code timeout for training commands.
                execution = sbx.run_code(py, timeout=0)
                stdout, stderr, _ = _format_exec_logs(execution)
                label = f"variant {idx + 1}"
                all_stdout += f"\n--- attempt {attempt} {label} stdout ---\n{stdout}"
                all_stderr += f"\n--- attempt {attempt} {label} stderr ---\n{stderr}"
                if ("unrecognized arguments" in stderr.lower()) and idx < len(cmd_variants) - 1:
                    continue
                break

            ok, found, all_stderr = _model_exists_via_list(
                sbx, sandbox_workdir, expected_model_filename, all_stderr
            )
            if ok and found:
                model_sandbox_path = found
                break

            if openai_client is not None:
                patch = _openai_suggest_patch(
                    openai_client,
                    script_text=script_text,
                    stderr=stderr,
                    stdout=stdout,
                    input_preview=input_preview,
                )
                if patch:
                    patched = _apply_unified_diff(script_text, patch, filename=script_name)
                    if patched:
                        script_text = patched
                        applied_patches.append(patch)
                        sbx.files.write(f"{sandbox_workdir}/{script_name}", script_text)
                        continue
                break

        try:
            produced_files = _list_dir_recursive(sbx, sandbox_workdir)
        except Exception:
            produced_files = []

        if not ok or not model_sandbox_path:
            raise E2BModelRunnerError(
                "Training failed in E2B sandbox.\n"
                f"Attempts: {attempt}\n\n"
                f"STDOUT:\n{all_stdout}\n\n"
                f"STDERR:\n{all_stderr}\n"
            )

        ts = int(time.time())
        out_name = f"model_{ts}.pkl"
        model_local_path = os.path.join(local_output_dir, out_name)
        data = sbx.files.read(model_sandbox_path)
        if isinstance(data, str):
            with open(model_local_path, "w", encoding="utf-8") as f:
                f.write(data)
        else:
            with open(model_local_path, "wb") as f:
                f.write(data)

        return RunResult(
            ok=True,
            attempts=attempt,
            stdout=all_stdout.strip(),
            stderr=all_stderr.strip(),
            sandbox_workdir=sandbox_workdir,
            produced_files=produced_files,
            model_local_path=model_local_path,
            model_sandbox_path=model_sandbox_path,
            applied_patches=applied_patches,
        )
