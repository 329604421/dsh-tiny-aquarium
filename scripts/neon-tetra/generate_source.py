"""Build the source neon tetra GLB from the user's multi-view references.

The short-lived token is supplied through WORKBUDDY_CLIENT_TEMP_TOKEN and is never
written to disk. The official WorkBuddy multimodal script performs the request.
"""
from __future__ import annotations

import base64
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]
SOURCE = Path(__file__).resolve().parent / "source"
SCRIPT = Path(os.environ["WORKBUDDY_MULTIMODAL_SCRIPT"])
TOKEN = os.environ["WORKBUDDY_CLIENT_TEMP_TOKEN"]


def encoded(name: str) -> str:
    return base64.b64encode((SOURCE / name).read_bytes()).decode("ascii")


spec = importlib.util.spec_from_file_location("buddy_multimodal_generation", SCRIPT)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
views = [
    {"ViewType": "top", "ViewImageBase64": encoded("top.png")},
    {"ViewType": "left_front", "ViewImageBase64": encoded("front.png")},
]
single_view = os.environ.get("NEON_TETRA_SINGLE_VIEW") == "1"
sys.argv = [
    str(SCRIPT), "3d",
    "--image-base64", encoded("side-clean.png"),
    *(("--multi-view", json.dumps(views, separators=(",", ":"))) if not single_view else ()),
    "--model", "3.1",
    "--enable-pbr",
    "--face-count", "10000",
    "--token", TOKEN,
]
stdout = io.StringIO()
try:
    with contextlib.redirect_stdout(stdout):
        module.main()
finally:
    text = stdout.getvalue()
    (SOURCE / ("generation-result-single.json" if single_view else "generation-result.json")).write_text(text, encoding="utf-8", newline="\n")
    print(text, end="")
