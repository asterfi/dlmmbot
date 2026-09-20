#!/usr/bin/env python3
"""Minimal localhost-only Laya inference sidecar for the DLMbot Eys gate.

The sidecar intentionally exposes inference only. It has no wallet, RPC, exchange,
filesystem-write, or subprocess integration. Load one checkpoint at startup and
serialize inference calls so CPU memory/latency remain bounded.
"""
from __future__ import annotations

import json
import os
import signal
import sys
import threading
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, Optional, Tuple

MAX_BODY_BYTES = 512 * 1024
MAX_QUESTIONS = 8
MAX_QUESTION_ID_CHARS = 64
MAX_INSTRUCTIONS_CHARS = 4096
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 18150


def _json_bytes(value: Any) -> bytes:
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def validate_request(value: Any) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
    if not isinstance(value, dict):
        return None, "request must be a JSON object"
    state = value.get("state")
    questions = value.get("questions")
    if not isinstance(state, dict):
        return None, "state must be an object"
    if not isinstance(questions, dict) or not questions or len(questions) > MAX_QUESTIONS:
        return None, "questions must be a non-empty object"
    for question_id, question in questions.items():
        if not isinstance(question_id, str) or not isinstance(question, dict):
            return None, "questions must map string ids to objects"
        if (
            not question_id or len(question_id) > MAX_QUESTION_ID_CHARS or
            not (question_id[0].isalpha() and all(ch.isalnum() or ch in "_-" for ch in question_id))
        ):
            return None, f"invalid question id for {question_id!r}"
        if question.get("type") not in {"choice", "score", "noul"}:
            return None, f"unsupported question type for {question_id!r}"
        instructions = question.get("instructions")
        if not isinstance(instructions, str) or not instructions.strip() or len(instructions) > MAX_INSTRUCTIONS_CHARS:
            return None, f"instructions missing for {question_id!r}"
        criteria = question.get("criteria")
        if not isinstance(criteria, (dict, list)) or not criteria:
            return None, f"criteria missing for {question_id!r}"
    return {"state": state, "questions": questions}, None


def _reject_json_constant(value: str) -> Any:
    raise ValueError(f"invalid JSON constant: {value}")


def _loopback_host(value: str) -> Optional[str]:
    host = value.strip().lower()
    return host if host in {"127.0.0.1", "localhost", "::1"} else None


class InferenceBusyError(RuntimeError):
    """Raised when the single CPU inference slot is already occupied."""


class LayaRuntime:
    def __init__(self, model_id: str, subfolder: Optional[str], device: str) -> None:
        # Import only after process configuration is established; importing torch is expensive.
        os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
        os.environ.setdefault("USE_TF", "0")
        os.environ.setdefault("USE_TORCH", "1")
        import laya  # type: ignore

        self.model_id = model_id
        self.subfolder = subfolder
        self.device = device
        self.loaded_at = time.time()
        self.agent = laya.load(model_id, device=device, subfolder=subfolder)
        self.inference_lock = threading.Lock()

    def predict(self, state: Any, questions: Dict[str, Any]) -> Dict[str, Any]:
        if not self.inference_lock.acquire(blocking=False):
            raise InferenceBusyError("inference_busy")
        try:
            return self.agent.predict(state, questions)
        finally:
            self.inference_lock.release()


class Handler(BaseHTTPRequestHandler):
    runtime: Optional[LayaRuntime] = None
    request_count = 0
    request_lock = threading.Lock()

    def log_message(self, format: str, *args: Any) -> None:
        # Do not log request bodies or model state; only endpoint/status metadata.
        sys.stderr.write("[laya] " + (format % args) + "\n")

    def _send(self, status: int, payload: Dict[str, Any]) -> None:
        body = _json_bytes(payload)
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            # The bounded DLMbot client may cancel a slow CPU inference before
            # the sidecar finishes. There is no response to deliver, and this
            # is not an inference or service failure.
            return

    def do_GET(self) -> None:  # noqa: N802
        if self.path not in {"/healthz", "/readyz"}:
            self._send(HTTPStatus.NOT_FOUND, {"ok": False, "error": "not_found"})
            return
        ready = self.runtime is not None
        status = HTTPStatus.OK if ready else HTTPStatus.SERVICE_UNAVAILABLE
        self._send(status, {
            "ok": ready,
            "ready": ready,
            "model": self.runtime.model_id if self.runtime else None,
            "subfolder": self.runtime.subfolder if self.runtime else None,
            "device": self.runtime.device if self.runtime else None,
        })

    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/v1/systemone":
            self._send(HTTPStatus.NOT_FOUND, {"ok": False, "error": "not_found"})
            return
        if self.runtime is None:
            self._send(HTTPStatus.SERVICE_UNAVAILABLE, {"ok": False, "error": "model_not_ready"})
            return
        try:
            length = int(self.headers.get("Content-Length", "-1"))
        except ValueError:
            length = -1
        if length < 0 or length > MAX_BODY_BYTES:
            self._send(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, {"ok": False, "error": "request_too_large"})
            return
        raw = self.rfile.read(length)
        try:
            request = json.loads(raw.decode("utf-8"), parse_constant=_reject_json_constant)
        except (UnicodeDecodeError, ValueError):
            self._send(HTTPStatus.BAD_REQUEST, {"ok": False, "error": "invalid_json"})
            return
        validated, error = validate_request(request)
        if error:
            self._send(HTTPStatus.BAD_REQUEST, {"ok": False, "error": error})
            return
        started = time.perf_counter()
        try:
            assert validated is not None
            result = self.runtime.predict(validated["state"], validated["questions"])
            elapsed_ms = round((time.perf_counter() - started) * 1000, 2)
            with self.request_lock:
                type(self).request_count += 1
            result["sidecar"] = {
                "model": self.runtime.model_id,
                "subfolder": self.runtime.subfolder,
                "device": self.runtime.device,
                "latency_ms": elapsed_ms,
                "calibration": "unverified",
            }
            self._send(HTTPStatus.OK, result)
        except InferenceBusyError:
            self._send(HTTPStatus.SERVICE_UNAVAILABLE, {"ok": False, "error": "inference_busy"})
        except Exception as exc:  # inference errors must become a fail-closed HTTP failure
            self.log_message("inference failure: %s", str(exc).splitlines()[0][:240])
            self._send(HTTPStatus.INTERNAL_SERVER_ERROR, {"ok": False, "error": "inference_failed"})


def main() -> int:
    model_id = os.environ.get("LAYA_MODEL", "convaiinnovations/laya")
    subfolder = os.environ.get("LAYA_SUBFOLDER", "typed-decisions") or None
    device = os.environ.get("LAYA_DEVICE", "cpu")
    host = _loopback_host(os.environ.get("LAYA_HOST", DEFAULT_HOST))
    if host is None:
        print("[laya] refusing non-loopback LAYA_HOST", file=sys.stderr, flush=True)
        return 2
    try:
        port = int(os.environ.get("LAYA_PORT", str(DEFAULT_PORT)))
    except ValueError:
        print("[laya] refusing invalid LAYA_PORT", file=sys.stderr, flush=True)
        return 2
    if not 1 <= port <= 65_535:
        print("[laya] refusing out-of-range LAYA_PORT", file=sys.stderr, flush=True)
        return 2

    print(f"[laya] loading model={model_id} subfolder={subfolder} device={device}", flush=True)
    try:
        Handler.runtime = LayaRuntime(model_id, subfolder, device)
    except Exception as exc:
        print(f"[laya] model load failed: {str(exc).splitlines()[0][:400]}", file=sys.stderr, flush=True)
        return 1

    server = ThreadingHTTPServer((host, port), Handler)
    server.daemon_threads = True
    print(f"[laya] ready on http://{host}:{port}", flush=True)

    def stop(_signum: int, _frame: Any) -> None:
        server.shutdown()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        server.serve_forever(poll_interval=0.5)
    finally:
        server.server_close()
        print("[laya] stopped", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
