"""Binary evidence provider for components without source access.

Resolve each component's podspec.json from the internal spec repo, download the
immutable COS framework artifact, and extract navigation-grade evidence:
public headers (interfaces with line anchors), ObjC classes/methods, and
user-visible Chinese strings (error copy first).

Design rules (aligned with generate.py / version-registry):
- manifest-driven: a component is never guessed, only declared in
  binary-components.json;
- fail-soft: per-component failures are recorded in the output, never replaced
  by a nearby version or fabricated data;
- immutable identity: `resolved_commit` carries the artifact's SHA-256
  (64 hex chars, satisfies the MCP IndexEntry commit validator) because binary
  pods publish no source commit; `artifact_sha256` states this explicitly.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import tarfile
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

# 中文字符串置信过滤：命中高频功能字的串才视为真实 UI 文案（静态库全量
# UTF-16LE 扫描会有对齐噪声；正式实现可按 ar 归档逐个 .o 解析 __ustring 段）。
COMMON_CHARS = set("的了是我你他请不在有课题目答案直播网络时间失败成功提交选择查看没有无法手机页面老师学生班级作业")
ERROR_KEYS = ("失败", "超时", "重试", "无法", "错误", "异常")
BIZ_KEYS = ("课", "直播", "题", "答", "讲", "老师")
MAX_PATHS = 12
MAX_KEYWORDS = 60

INTERFACE = re.compile(r"@(?:interface|protocol)\s+([A-Za-z_][\w]*)")
OBJC_CLASS = re.compile(r"_OBJC_CLASS_\$_(.+)")
METHOD = re.compile(r"^[-+]\[\w+[\w ]*\]")


def _token() -> str | None:
    return os.environ.get("HARMONY_AGENT_GITLAB_TOKEN") or os.environ.get("ANALYSIS_GIT_TOKEN")


def ensure_spec_repo(url: str, cache: Path) -> Path:
    """浅克隆/复用 spec 仓。token 取自项目既有的环境变量约定。"""
    dest = cache / "XesAppRepo"
    if (dest / ".git").exists():
        return dest
    token = _token()
    authed = url.replace("https://", f"https://oauth2:{token}@") if token else url
    cache.mkdir(parents=True, exist_ok=True)
    subprocess.run(["git", "clone", "--quiet", "--depth", "1", authed, str(dest)],
                   check=True, capture_output=True)
    return dest


def artifact_url(spec_repo: Path, name: str, version: str) -> str:
    podspec = spec_repo / name / version / f"{name}.podspec.json"
    if not podspec.exists():
        raise FileNotFoundError(f"spec 仓无 {name} {version}: {podspec}")
    url = json.loads(podspec.read_text(encoding="utf-8")).get("source", {}).get("http")
    if not url:
        raise ValueError(f"{name} {version} podspec 无 http artifact")
    return url


def fetch_artifact(url: str, dest: Path) -> tuple[Path, str]:
    """下载并解包 COS artifact，返回 (framework 路径, tarball sha256)。幂等。"""
    marker = dest / ".artifact_sha256"
    if dest.exists() and marker.exists():
        fws = list(dest.rglob("*.framework"))
        if fws:
            return fws[0], marker.read_text().strip()
    dest.mkdir(parents=True, exist_ok=True)
    tarball = dest / "pkg.tar.bz2"
    urllib.request.urlretrieve(url, tarball)
    digest = hashlib.sha256(tarball.read_bytes()).hexdigest()
    with tarfile.open(tarball) as tar:
        tar.extractall(dest, filter="data")
    tarball.unlink()
    marker.write_text(digest)
    fws = list(dest.rglob("*.framework"))
    if not fws:
        raise FileNotFoundError(f"{dest} 内无 .framework")
    return fws[0], digest


def find_binary(fw: Path) -> Path | None:
    for cand in fw.iterdir():
        if cand.is_file() and cand.suffix == "":
            return cand
    bins = [p for p in fw.rglob("*") if p.is_file() and p.suffix in ("", ".a")
            and "Headers" not in p.parts]
    return max(bins, key=lambda p: p.stat().st_size) if bins else None


def header_pointers(fw: Path, artifact_root: Path) -> list[dict[str, Any]]:
    """从头文件提取符号指针（真实文件 + 真实行号，可直接读证）。"""
    headers = sorted(fw.rglob("Headers/*.h"),
                     key=lambda p: -p.stat().st_size)[:MAX_PATHS]
    out: list[dict[str, Any]] = []
    for header in headers:
        try:
            text = header.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        decl = next(INTERFACE.finditer(text), None)
        symbol = decl.group(1) if decl else header.stem
        line = text[: decl.start()].count("\n") + 1 if decl else 1
        out.append({
            "path": header.relative_to(artifact_root).as_posix(),
            "symbol": symbol,
            "role": "接口头文件",
            "line_start": line,
            "line_end": min(text.count("\n") + 1, line + 80),
            "key_symbols": [f"{symbol}@{line}"],
            "terms": sorted({header.stem, symbol})[:12],
        })
    return out


def extract_strings(binary: Path) -> tuple[list[str], list[str]]:
    data = binary.read_bytes()
    text = data.decode("utf-16-le", errors="ignore")
    runs = re.findall(r"[一-鿿0-9A-Za-z，。、：；！？（）【】《》%\-\.]{4,}", text)
    real = sorted({r for r in runs if any(c in COMMON_CHARS for c in r)})
    errors = [r for r in real if any(k in r for k in ERROR_KEYS)]
    biz = [r for r in real if any(k in r for k in BIZ_KEYS) and r not in errors]
    return errors, biz


def binary_stats(fw: Path, binary: Path | None) -> dict[str, int]:
    stats = {"headers": len(list(fw.rglob("Headers/*.h"))),
             "objc_classes": 0, "objc_methods": 0,
             "error_strings": 0, "biz_strings": 0}
    if binary is None:
        return stats
    nm = subprocess.run(["nm", "-gU", str(binary)],
                        capture_output=True, text=True, errors="ignore").stdout
    stats["objc_classes"] = len(set(OBJC_CLASS.findall(nm)))
    raw = subprocess.run(["strings", str(binary)],
                         capture_output=True, text=True, errors="ignore").stdout
    stats["objc_methods"] = len({l for l in raw.splitlines() if METHOD.match(l)})
    return stats


def build_record(component: dict[str, Any], fw: Path, artifact_root: Path,
                 digest: str, url: str, generated: str) -> dict[str, Any]:
    name, version = component["name"], component["pod_version"]
    scope = component["scope"]
    binary = find_binary(fw)
    stats = binary_stats(fw, binary)
    errors, biz = extract_strings(binary) if binary else ([], [])
    stats["error_strings"], stats["biz_strings"] = len(errors), len(biz)
    paths = header_pointers(fw, artifact_root)
    keywords = sorted({name, name.replace("CloudLearning_", ""),
                       *[p["symbol"] for p in paths],
                       *errors[:20], *biz[:20]})[:MAX_KEYWORDS]
    entry_id = hashlib.sha256(
        f"binary|{name}|{scope['platform']}|{scope['product_line']}|{scope['form_factor']}|{scope['version']}|{digest}".encode()
    ).hexdigest()[:24]
    return {
        "schema_version": 1,
        "entry_id": entry_id,
        "record_type": "binary_component",
        "evidence_level": "binary",
        "title": f"{name}（二进制证据）",
        "module_id": f"binary-{name.replace('_', '-').lower()}",
        "aliases": component.get("aliases", []),
        "keywords": keywords,
        **{k: scope.get(k) for k in ("platform", "product_line", "form_factor", "version")},
        "build": scope.get("build"),
        "repository_id": component.get("repository_id", "unknown/binary-only"),
        "resolved_commit": digest,  # artifact SHA-256：二进制 pod 无源码 commit
        "artifact_sha256": digest,
        "pod_version": version,
        "artifact_url": url,
        "paths": paths or [{"path": f"{name}.framework", "symbol": name,
                            "role": "framework", "terms": [name]}],
        "data_flow": {},
        "related_modules": [],
        "source": "generated",
        "generated_at": generated,
        "matched_file_count": stats["headers"] or 1,
        "mapping_method": "binary-artifact-scan",
        "stats": stats,
        "sample_error_strings": errors[:8],
        "note": "无源码权限组件的二进制证据：接口/符号/文案可定位，无方法体实现。",
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=Path,
                        default=Path("code-index/binary-components.json"))
    parser.add_argument("--output", type=Path,
                        default=Path("code-index/binary-index.jsonl"))
    parser.add_argument("--data-root", type=Path,
                        default=Path(".data/code-index"))
    args = parser.parse_args()
    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    generated = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")

    records: list[dict[str, Any]] = []
    failures: list[dict[str, str]] = []
    spec_repo = ensure_spec_repo(manifest["spec_repo"], args.data_root / "spec-repos")
    for component in manifest.get("components", []):
        name, version = component["name"], component["pod_version"]
        try:
            url = artifact_url(spec_repo, name, version)
            artifact_root = args.data_root / "bin-artifacts" / name / version
            fw, digest = fetch_artifact(url, artifact_root)
            records.append(build_record(component, fw, artifact_root, digest, url, generated))
            print(f"ok: {name} {version} -> {digest[:12]}")
        except Exception as exc:  # 记录缺口，不伪造
            failures.append({"name": name, "version": version, "error": str(exc)})
            print(f"failed: {name} {version}: {exc}")

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        "".join(json.dumps(r, ensure_ascii=False, separators=(",", ":")) + "\n" for r in records),
        encoding="utf-8")
    print(json.dumps({"records": len(records), "failures": failures}, ensure_ascii=False))


if __name__ == "__main__":
    main()
