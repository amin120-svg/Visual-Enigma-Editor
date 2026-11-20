"""Create and verify the portable VEE Windows archive.

This is a maintainer build helper. End users launch VisualEnigmaEditor.exe and
do not need Python, a terminal, or this script.
"""

from __future__ import annotations

import hashlib
import argparse
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from tempfile import NamedTemporaryFile
from zipfile import ZIP_DEFLATED, ZipFile


DESKTOP_ROOT = Path(__file__).resolve().parents[1]
DIST_ROOT = DESKTOP_ROOT / "dist"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def portable_files(portable_root: Path) -> list[Path]:
    files = sorted(path for path in portable_root.rglob("*") if path.is_file())
    if not files:
        raise RuntimeError(f"Portable folder is empty: {portable_root}")
    executable = portable_root / "VisualEnigmaEditor.exe"
    package = portable_root / "resources" / "app" / "package.json"
    if not executable.is_file() or not package.is_file():
        raise RuntimeError("Portable folder is missing its executable or application entry")
    package_data = json.loads(package.read_text(encoding="utf-8"))
    if package_data.get("main") != "main.cjs":
        raise RuntimeError("Packaged application entry is not the normal main.cjs entry")
    if any(path.name == "qa-harness.cjs" or path.suffix == ".env" for path in files):
        raise RuntimeError("A QA harness or environment file cannot be shipped")
    return files


def build_archive(files: list[Path], portable_root: Path, archive_path: Path) -> None:
    DIST_ROOT.mkdir(parents=True, exist_ok=True)
    with NamedTemporaryFile(
        prefix=f".{archive_path.name}.", suffix=".tmp", dir=DIST_ROOT, delete=False
    ) as temporary:
        temporary_path = Path(temporary.name)
    try:
        with ZipFile(
            temporary_path, "w", compression=ZIP_DEFLATED, compresslevel=6, allowZip64=True
        ) as archive:
            for path in files:
                relative = path.relative_to(portable_root)
                archive.write(path, (Path(portable_root.name) / relative).as_posix())
        with ZipFile(temporary_path, "r") as archive:
            bad_member = archive.testzip()
            if bad_member is not None:
                raise RuntimeError(f"ZIP integrity check failed at {bad_member}")
            expected = {
                (Path(portable_root.name) / path.relative_to(portable_root)).as_posix()
                for path in files
            }
            actual = set(archive.namelist())
            if actual != expected:
                raise RuntimeError("ZIP member list does not match the portable folder")
        # Link publication refuses an existing archive rather than overwriting a
        # previous delivery. Both files are on the same local build volume.
        os.link(temporary_path, archive_path)
    finally:
        temporary_path.unlink(missing_ok=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("portable_root", type=Path)
    args = parser.parse_args()
    portable_root = args.portable_root.resolve(strict=True)
    if portable_root.parent != DIST_ROOT.resolve() or portable_root.name == "VisualEnigmaEditor-0.1.0-win-x64":
        raise RuntimeError("Choose a new portable release directly inside desktop/dist")
    archive_path = DIST_ROOT / f"{portable_root.name}.zip"
    checksum_path = DIST_ROOT / f"{portable_root.name}.SHA256SUMS.txt"
    manifest_path = DIST_ROOT / f"{portable_root.name}.release.json"
    if any(path.exists() for path in [archive_path, checksum_path, manifest_path]):
        raise RuntimeError("Release output already exists; previous deliveries are preserved")
    files = portable_files(portable_root)
    build_archive(files, portable_root, archive_path)
    executable = portable_root / "VisualEnigmaEditor.exe"
    executable_hash = sha256(executable)
    archive_hash = sha256(archive_path)
    checksum_text = (
        f"{executable_hash}  {portable_root.name}/VisualEnigmaEditor.exe\n"
        f"{archive_hash}  {archive_path.name}\n"
    )
    with checksum_path.open("x", encoding="ascii", newline="\n") as output:
        output.write(checksum_text)
    package = json.loads((portable_root / "resources/app/package.json").read_text(encoding="utf-8"))
    manifest = {
        "product": "Visual Enigma Editor",
        "version": package["version"],
        "releaseIdentifier": package["releaseIdentifier"],
        "platform": "win32-x64",
        "portableDirectory": portable_root.name,
        "archive": archive_path.name,
        "fileCount": len(files),
        "uncompressedBytes": sum(path.stat().st_size for path in files),
        "archiveBytes": archive_path.stat().st_size,
        "sha256": {
            "executable": executable_hash,
            "archive": archive_hash,
        },
        "signed": False,
        "createdUtc": datetime.now(timezone.utc).isoformat(),
    }
    with manifest_path.open("x", encoding="ascii", newline="\n") as output:
        output.write(json.dumps(manifest, indent=2, ensure_ascii=True) + "\n")
    print(json.dumps(manifest, ensure_ascii=True))


if __name__ == "__main__":
    main()
