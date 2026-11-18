"""进程管理 + Token CLI。

五动作（对齐 dev-agent/scripts/runtime.py 语义）：
  start    默认前台启动（日志打终端）；`--background/-d` 后台守护
  stop     优雅停止后台进程
  restart  默认前台重启；`--background/-d` 后台重启
  status   查看运行状态
  check    健康检查 + MCP 协议验证（14 个工具名齐全）

Token CLI：
  client issue  --client-id <id> [--description] [--scopes logs:read|logs:probe] [--days 180]
  client revoke --client-id <id>
  client list

六项保护（方案 7.3）：
  ① PID 防复用（pid + 进程签名）
  ② 端口占用保护
  ③ 健康检查 GET /health
  ④ MCP 协议级验证（list_tools 含 14 个工具名）
  ⑤ 优雅停止 SIGTERM ≤ 25s
  ⑥ 文件锁互斥
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import signal
import socket
import stat
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path

from filelock import FileLock  # type: ignore[import-not-found]

# filelock 是可选依赖；缺失时回退到 fcntl 以避免强依赖
try:
    from filelock import FileLock as _FileLock  # noqa: F401

    HAVE_FILELOCK = True
except ImportError:
    HAVE_FILELOCK = False

# ctl.py 在 log-mcp/src/log_mcp/，parents[2] 即 log-mcp 项目根
PROJECT_ROOT = Path(__file__).resolve().parents[2]
SERVICE_NAME = "log-mcp"
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8766
SIGTERM_GRACE_SECONDS = 25
HEALTH_TIMEOUT_SECONDS = 3
READY_TIMEOUT_SECONDS = 25


class ControlError(RuntimeError):
    """可向操作者显示的生命周期错误。"""


@dataclass(frozen=True)
class Service:
    name: str
    command: tuple[str, ...]
    host: str
    port: int


def _data_root() -> Path:
    """解析数据根目录。"""
    from log_mcp.config import load_settings

    settings = load_settings()
    return settings.data_root_path


def _run_dir() -> Path:
    return _data_root() / "run"


def _log_dir() -> Path:
    return _data_root() / "logs"


def _settings() -> tuple[object, Service]:
    from log_mcp.config import load_settings

    s = load_settings()
    cmd = (sys.executable, "-m", "log_mcp.server")
    return s, Service(SERVICE_NAME, cmd, s.host, s.port)


def process_signature(pid: int) -> str:
    """核对 PID 启动时间与命令，避免误停被复用的进程。"""
    result = subprocess.run(  # noqa: S603
        ["/bin/ps", "-p", str(pid), "-o", "lstart=", "-o", "command="],
        capture_output=True,
        text=True,
        check=False,
    )
    return result.stdout.strip() if result.returncode == 0 else ""


def _read_record(name: str) -> dict | None:
    path = _run_dir() / f"{name}.json"
    if not path.exists():
        return None
    record = json.loads(path.read_text())
    if (
        not isinstance(record.get("pid"), int)
        or record["pid"] <= 1
        or not isinstance(record.get("signature"), str)
        or not record["signature"]
    ):
        raise ControlError("进程记录文件无效")
    return record


def _managed_running(name: str) -> bool:
    record = _read_record(name)
    return bool(record and process_signature(record["pid"]) == record["signature"])


def _listening(host: str, port: int) -> bool:
    try:
        with socket.create_connection((host, port), timeout=1):
            return True
    except OSError:
        return False


def _healthy(host: str, port: int) -> bool:
    import httpx

    try:
        with httpx.Client(trust_env=False, timeout=HEALTH_TIMEOUT_SECONDS) as client:
            resp = client.get(f"http://{host}:{port}/health")
            return resp.status_code == 200 and resp.json().get("status") == "ok"
    except (httpx.HTTPError, ValueError, AttributeError):
        return False


def _protected_open(path: Path, flags: int) -> int:
    fd = os.open(path, (flags & ~os.O_TRUNC) | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid():
            raise ControlError("运行态文件必须是当前用户的普通文件")
        os.fchmod(fd, 0o600)
        if flags & os.O_TRUNC:
            os.ftruncate(fd, 0)
        return fd
    except BaseException:
        os.close(fd)
        raise


def _assert_can_start(service: Service) -> None:
    """启动前冲突检查（前台/后台共用）。"""
    if _managed_running(service.name):
        raise ControlError(
            f"{service.name} 已在后台运行；请先 `uv run stop`，再重新启动"
        )
    if _listening(service.host, service.port):
        raise ControlError(f"{service.name} 端口被占用（{service.host}:{service.port}）")


def _run_foreground(service: Service) -> int:
    """前台跑 server：日志打到当前终端，Ctrl+C 退出；不写后台 PID 记录。"""
    print(
        f"{service.name}: foreground http://{service.host}:{service.port}/mcp  (Ctrl+C 停止)",
        flush=True,
    )
    os.environ.setdefault("PYTHONUNBUFFERED", "1")
    from log_mcp.server import main as server_main

    try:
        server_main()
    except KeyboardInterrupt:
        print(f"\n{service.name}: stopped", flush=True)
    return 0


def _start_service(service: Service) -> bool:
    """后台启动服务并等待就绪。返回是否新启动。"""
    if _managed_running(service.name):
        if not _healthy(service.host, service.port):
            raise ControlError(f"{service.name} 已运行但不健康")
        print(f"{service.name}: already running", flush=True)
        return False
    _assert_can_start(service)
    _log_dir().mkdir(parents=True, exist_ok=True, mode=0o700)
    log_path = _log_dir() / f"{service.name}.log"
    # PYTHONUNBUFFERED：子进程日志立即落盘，便于排查；也避免部分环境下缓冲导致启动异常
    child_env = {**os.environ, "PYTHONUNBUFFERED": "1"}
    with os.fdopen(_protected_open(log_path, os.O_WRONLY | os.O_APPEND), "ab") as output:
        child = subprocess.Popen(  # noqa: S603
            service.command,
            cwd=PROJECT_ROOT,
            stdin=subprocess.DEVNULL,
            stdout=output,
            stderr=output,
            start_new_session=True,
            env=child_env,
        )
    try:
        signature = process_signature(child.pid)
        if not signature:
            raise ControlError(f"{service.name} 启动后立即退出")
        _run_dir().mkdir(parents=True, exist_ok=True, mode=0o700)
        record_path = _run_dir() / f"{service.name}.json"
        with os.fdopen(_protected_open(record_path, os.O_WRONLY | os.O_TRUNC), "w") as out:
            json.dump({"pid": child.pid, "signature": signature}, out)
        deadline = time.monotonic() + READY_TIMEOUT_SECONDS
        while child.poll() is None:
            if _healthy(service.host, service.port):
                # macOS Python launcher 会再次 exec；就绪后刷新签名
                signature = process_signature(child.pid)
                with os.fdopen(_protected_open(record_path, os.O_WRONLY | os.O_TRUNC), "w") as out:
                    json.dump({"pid": child.pid, "signature": signature}, out)
                print(f"{service.name}: ready", flush=True)
                return True
            if time.monotonic() >= deadline:
                break
            time.sleep(0.2)
        raise ControlError(f"{service.name} 未就绪；检查运行日志 {log_path}")
    except BaseException:
        if child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=SIGTERM_GRACE_SECONDS)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait(timeout=5)
        (_run_dir() / f"{service.name}.json").unlink(missing_ok=True)
        raise


def _stop_service(name: str) -> None:
    record = _read_record(name)
    if not record:
        return
    if process_signature(record["pid"]) == record["signature"]:
        try:
            os.kill(record["pid"], signal.SIGTERM)
        except ProcessLookupError:
            pass
        deadline = time.monotonic() + SIGTERM_GRACE_SECONDS
        while process_signature(record["pid"]) == record["signature"]:
            if time.monotonic() >= deadline:
                raise ControlError(
                    f"{name} 未在 {SIGTERM_GRACE_SECONDS}s 内停止；请检查进行中的查询"
                )
            time.sleep(0.2)
    (_run_dir() / f"{name}.json").unlink(missing_ok=True)
    print(f"{name}: stopped", flush=True)


def _status_service(service: Service) -> bool:
    ready = _healthy(service.host, service.port)
    print(f"{service.name}: {'ready' if ready else 'unavailable'}", flush=True)
    return ready


async def _protocol_check(host: str, port: int, *, token: str | None = None) -> bool:
    """MCP 协议级验证：握手 + list_tools，确认 14 个工具名齐全。"""
    import httpx
    from mcp import ClientSession
    from mcp.client.streamable_http import streamable_http_client

    from log_mcp.server import ALL_TOOL_NAMES

    headers = {"Authorization": f"Bearer {token}"} if token else {}
    url = f"http://{host}:{port}/mcp"
    try:
        async with asyncio.timeout(12):
            async with httpx.AsyncClient(trust_env=False, timeout=10, headers=headers) as client:
                async with streamable_http_client(url, http_client=client) as (receive, send):
                    async with ClientSession(receive, send) as session:
                        await session.initialize()
                        names = {tool.name for tool in (await session.list_tools()).tools}
                        return ALL_TOOL_NAMES.issubset(names)
    except Exception:
        return False


def _check_runtime(service: Service, *, token: str | None = None) -> bool:
    checks = [_status_service(service)]
    authenticated = asyncio.run(_protocol_check(service.host, service.port, token=token))
    print(f"{service.name} protocol: {'ok' if authenticated else 'failed'}", flush=True)
    checks.append(authenticated)
    return all(checks)


def _ensure_dirs() -> None:
    for directory in (_run_dir(), _log_dir()):
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        info = directory.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or directory.is_symlink():
            raise ControlError("运行目录不安全")
        directory.chmod(0o700)


def _lock():
    """管理脚本互斥锁。"""
    _run_dir().mkdir(parents=True, exist_ok=True, mode=0o700)
    lock_path = _run_dir() / "manage.lock"
    if HAVE_FILELOCK:
        return FileLock(lock_path, timeout=1)
    # 回退实现：用 fcntl 简单独占
    return _FcntlLock(lock_path)


class _FcntlLock:
    """filelock 缺失时的回退锁。"""

    def __init__(self, path: Path) -> None:
        self.path = path
        self._fd: int | None = None

    def __enter__(self) -> _FcntlLock:
        import fcntl

        self._fd = os.open(self.path, os.O_CREAT | os.O_RDWR, 0o600)
        try:
            fcntl.flock(self._fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            os.close(self._fd)
            self._fd = None
            raise ControlError("管理脚本互斥锁获取失败") from exc
        return self

    def __exit__(self, *exc) -> None:
        import fcntl

        if self._fd is not None:
            fcntl.flock(self._fd, fcntl.LOCK_UN)
            os.close(self._fd)
            self._fd = None


def cmd_start(*, foreground: bool = True) -> int:
    """默认前台；`foreground=False` 时后台守护。"""
    _ensure_dirs()
    _, service = _settings()
    if foreground:
        try:
            with _lock():
                _assert_can_start(service)
            return _run_foreground(service)
        except ControlError as exc:
            print(f"runtime: {exc}")
            return 1
    with _lock():
        try:
            _start_service(service)
            return 0
        except ControlError as exc:
            print(f"runtime: {exc}")
            return 1


def cmd_stop() -> int:
    _ensure_dirs()
    with _lock():
        try:
            _stop_service(SERVICE_NAME)
            return 0
        except ControlError as exc:
            print(f"runtime: {exc}")
            return 1


def cmd_restart(*, foreground: bool = True) -> int:
    """先 stop 再 start；默认前台。子进程继承本命令的环境变量。"""
    _ensure_dirs()
    _, service = _settings()
    if foreground:
        try:
            with _lock():
                _stop_service(SERVICE_NAME)
                if _listening(service.host, service.port):
                    raise ControlError(
                        f"{service.name} 端口仍被占用（{service.host}:{service.port}）"
                    )
            return _run_foreground(service)
        except ControlError as exc:
            print(f"runtime: {exc}")
            return 1
    with _lock():
        try:
            _stop_service(SERVICE_NAME)
            _start_service(service)
            return 0
        except ControlError as exc:
            print(f"runtime: {exc}")
            return 1


def cmd_status() -> int:
    _ensure_dirs()
    _, service = _settings()
    return 0 if _status_service(service) else 1


def cmd_check() -> int:
    _ensure_dirs()
    _, service = _settings()
    # 若鉴权关闭，protocol_check 不带 token
    from log_mcp.config import load_settings

    settings = load_settings()
    token = None
    if not settings.auth.disabled and settings.host in {"127.0.0.1", "localhost", "::1"}:
        # 尝试用首个未吊销 client 换 token 做协议验证
        token = _try_get_check_token(settings)
    return 0 if _check_runtime(service, token=token) else 1


def _try_get_check_token(settings) -> str | None:
    """check 不持有明文 token，无法代调受鉴权的 /mcp；返回 None。"""
    return None


# ---------- Token CLI ----------


def cmd_client_issue(args: argparse.Namespace) -> int:
    from log_mcp.config import load_settings
    from log_mcp.token_store import TokenStore

    settings = load_settings()
    store = TokenStore(settings.data_root_path / "auth.db")
    token, expires_in = store.issue_token(
        client_id=args.client_id,
        description=args.description or "",
        scopes=args.scopes or "logs:read",
        ttl_days=args.days,
    )
    days = max(1, (expires_in + 86_399) // 86_400) if expires_in else 0
    print(f"client_id: {args.client_id}")
    print(f"token: {token}")
    print(f"expires_in_days: {days}")
    print("⚠️  token 仅此一次可见；放入调用方 LOG_MCP_BEARER_TOKEN，丢失请 revoke 后重新 issue")
    return 0


def cmd_client_revoke(args: argparse.Namespace) -> int:
    from log_mcp.config import load_settings
    from log_mcp.token_store import TokenStore

    settings = load_settings()
    store = TokenStore(settings.data_root_path / "auth.db")
    if store.revoke_client(args.client_id):
        print(f"client {args.client_id} revoked")
        return 0
    print(f"client {args.client_id} not found or already revoked")
    return 1


def cmd_client_list(args: argparse.Namespace) -> int:
    from log_mcp.config import load_settings
    from log_mcp.token_store import TokenStore

    settings = load_settings()
    store = TokenStore(settings.data_root_path / "auth.db")
    clients = store.list_clients()
    print(json.dumps(clients, ensure_ascii=False, indent=2))
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="log-mcp 进程管理 + Token CLI")
    sub = parser.add_subparsers(dest="command", required=True)

    start_p = sub.add_parser("start", help="启动 log-mcp（默认前台）")
    start_p.add_argument(
        "--background",
        "-d",
        action="store_true",
        help="后台守护（日志写入 dataRoot/logs）",
    )
    start_p.add_argument(
        "--foreground",
        "-f",
        action="store_true",
        help=argparse.SUPPRESS,  # 兼容旧参数；默认已是前台
    )
    start_p.set_defaults(func=lambda a: cmd_start(foreground=not a.background))

    sub.add_parser("stop", help="停止 log-mcp").set_defaults(func=lambda _: cmd_stop())

    restart_p = sub.add_parser("restart", help="重启 log-mcp（默认前台）")
    restart_p.add_argument(
        "--background",
        "-d",
        action="store_true",
        help="后台守护重启",
    )
    restart_p.add_argument(
        "--foreground",
        "-f",
        action="store_true",
        help=argparse.SUPPRESS,
    )
    restart_p.set_defaults(func=lambda a: cmd_restart(foreground=not a.background))

    sub.add_parser("status", help="查看运行状态").set_defaults(func=lambda _: cmd_status())
    sub.add_parser("check", help="健康检查 + MCP 协议验证").set_defaults(func=lambda _: cmd_check())

    client = sub.add_parser("client", help="调用方 API Token 管理")
    client_sub = client.add_subparsers(dest="client_command", required=True)
    issue = client_sub.add_parser("issue", help="颁发/轮换长期 Bearer token（仅此一次打印明文）")
    issue.add_argument("--client-id", required=True)
    issue.add_argument("--description", default="")
    issue.add_argument("--scopes", default="logs:read")
    issue.add_argument("--days", type=int, default=180, help="有效天数，默认 180")
    issue.set_defaults(func=cmd_client_issue)

    rev = client_sub.add_parser("revoke", help="吊销调用方")
    rev.add_argument("--client-id", required=True)
    rev.set_defaults(func=cmd_client_revoke)

    lst = client_sub.add_parser("list", help="列出调用方（不显示 token）")
    lst.set_defaults(func=cmd_client_list)

    args = parser.parse_args()
    try:
        return args.func(args)
    except ControlError as exc:
        print(f"runtime: {exc}")
        return 1
    except Exception as exc:  # noqa: BLE001
        print(f"runtime: failed ({type(exc).__name__}); check configuration and runtime logs")
        return 1


def _parse_background_flag() -> bool:
    """解析 `uv run start|restart --background|-d`；默认前台。"""
    parser = argparse.ArgumentParser(add_help=True)
    parser.add_argument("--background", "-d", action="store_true")
    parser.add_argument("--foreground", "-f", action="store_true")  # 兼容旧用法
    args, _unknown = parser.parse_known_args()
    return bool(args.background)


def entry_start() -> None:
    """`uv run start` 默认前台；`--background/-d` 后台。"""
    raise SystemExit(cmd_start(foreground=not _parse_background_flag()))


def entry_stop() -> None:
    """`uv run stop`"""
    raise SystemExit(cmd_stop())


def entry_restart() -> None:
    """`uv run restart` 默认前台；`--background/-d` 后台。"""
    raise SystemExit(cmd_restart(foreground=not _parse_background_flag()))


def entry_status() -> None:
    """`uv run status`"""
    raise SystemExit(cmd_status())


def entry_check() -> None:
    """`uv run check`"""
    raise SystemExit(cmd_check())


def entry_client() -> None:
    """`uv run client issue|revoke|list ...`"""
    # uv run client issue ... → 补上顶层子命令名 "client" 再交给 main()
    sys.argv = [sys.argv[0], "client", *sys.argv[1:]]
    raise SystemExit(main())


if __name__ == "__main__":
    sys.exit(main())
