"""Compatibility entry point for the explicit-target Node packaged GUI runner.

Pass portable root and an output directory. No default artifact is selected and
no shell is launched. Set VEE_NODE_EXECUTABLE if Node is not on PATH.
"""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import shutil
import subprocess


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("portable_root", type=Path)
    parser.add_argument("output_root", type=Path)
    args = parser.parse_args()
    node = os.environ.get("VEE_NODE_EXECUTABLE") or shutil.which("node")
    if not node:
        parser.error("Node executable unavailable; set VEE_NODE_EXECUTABLE")
    runner = Path(__file__).with_name("run-packaged-qa.cjs")
    result = subprocess.run(
        [node, str(runner), str(args.portable_root), str(args.output_root)],
        shell=False,
        check=False,
    )
    raise SystemExit(result.returncode)


if __name__ == "__main__":
    main()
