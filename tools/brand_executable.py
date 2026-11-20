"""Apply VEE resources to a new portable EXE, never to the source runtime."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

from PyInstaller import config
from PyInstaller.utils.win32.icon import CopyIcons
from PyInstaller.utils.win32.versioninfo import (
    FixedFileInfo, StringFileInfo, StringStruct, StringTable, VarFileInfo,
    VarStruct, VSVersionInfo, read_version_info_from_executable,
    write_version_info_to_executable,
)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("executable", type=Path)
    parser.add_argument("icon", type=Path)
    parser.add_argument("release_identifier")
    args = parser.parse_args()
    desktop = Path(__file__).resolve().parents[1]
    executable = args.executable.resolve(strict=True)
    icon = args.icon.resolve(strict=True)
    dist = (desktop / "dist").resolve()
    relative = executable.relative_to(dist)
    if len(relative.parts) != 2 or executable.name != "VisualEnigmaEditor.exe":
        raise ValueError("Only a new portable VEE executable can be branded")
    if relative.parts[0] == "VisualEnigmaEditor-0.1.0-win-x64":
        raise ValueError("The previous portable release must be preserved")
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,79}", args.release_identifier):
        raise ValueError("Invalid release identifier")
    config.CONF["workpath"] = str(executable.parent)
    CopyIcons(str(executable), str(icon))
    date_parts = re.match(r"^(\d{4})\.(\d{1,2})\.(\d{1,2})", args.release_identifier)
    file_version = (*map(int, date_parts.groups()), 0) if date_parts else (0, 1, 0, 0)
    info = VSVersionInfo(
        ffi=FixedFileInfo(
            filevers=file_version, prodvers=(0, 1, 0, 0),
            mask=0x3F, flags=0, OS=0x40004, fileType=1, subtype=0, date=(0, 0),
        ),
        kids=[
            StringFileInfo([StringTable("040904B0", [
                StringStruct("CompanyName", "Py Snake"),
                StringStruct("FileDescription", "Visual Enigma Editor"),
                StringStruct("FileVersion", args.release_identifier),
                StringStruct("InternalName", "VisualEnigmaEditor"),
                StringStruct("OriginalFilename", "VisualEnigmaEditor.exe"),
                StringStruct("ProductName", "Visual Enigma Editor"),
                StringStruct("ProductVersion", "0.1.0"),
            ])]),
            VarFileInfo([VarStruct("Translation", [0x0409, 1200])]),
        ],
    )
    write_version_info_to_executable(str(executable), info)
    verified = read_version_info_from_executable(str(executable))
    if verified is None or "Visual Enigma Editor" not in str(verified):
        raise RuntimeError("Executable product metadata verification failed")
    print(json.dumps({"product": "Visual Enigma Editor", "releaseIdentifier": args.release_identifier,
                      "iconApplied": True, "metadataVerified": True, "signedByPySnake": False}))


if __name__ == "__main__":
    main()
