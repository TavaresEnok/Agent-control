import hashlib
import json
import pathlib
import shutil
import sys
import tarfile
import urllib.request

LOCK_PATH = pathlib.Path("/tmp/desempenho-tools.lock.json")
TOOLS_DIR = pathlib.Path("/tmp/tools")
BIN_DIR = pathlib.Path("/usr/local/bin")


def verify_sha256(path: pathlib.Path, expected: str) -> None:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(65536), b""):
            digest.update(chunk)
    actual = digest.hexdigest().lower()
    if actual != expected.lower():
        raise SystemExit(f"SHA256 mismatch for {path.name}: expected {expected}, got {actual}")


def fetch() -> None:
    lock = json.loads(LOCK_PATH.read_text(encoding="utf-8"))
    TOOLS_DIR.mkdir(parents=True, exist_ok=True)
    checksum_lines = []
    for tool in lock["tools"]:
        dest = TOOLS_DIR / tool["file"]
        print(f"baixando {tool['name']} {tool['version']}", flush=True)
        last_err = None
        for _attempt in range(3):
            try:
                urllib.request.urlretrieve(tool["url"], dest)
                last_err = None
                break
            except Exception as exc:  # noqa: BLE001
                last_err = exc
        if last_err is not None:
            raise SystemExit(last_err)
        verify_sha256(dest, tool["sha256"])
        checksum_lines.append(f"{tool['sha256']}  {tool['file']}")
    (TOOLS_DIR / "checksums.txt").write_text("\n".join(checksum_lines) + "\n", encoding="utf-8")


def install() -> None:
    lock = json.loads(LOCK_PATH.read_text(encoding="utf-8"))
    for tool in lock["tools"]:
        archive = TOOLS_DIR / tool["file"]
        verify_sha256(archive, tool["sha256"])
        if tool["kind"] != "tar.gz":
            raise SystemExit(f"Unsupported tool kind: {tool['kind']}")
        with tarfile.open(archive, "r:gz") as tar:
            expected_member = tool.get("member", "")
            chosen = None
            for member in tar.getmembers():
                if not member.isfile():
                    continue
                if member.name == expected_member or member.name.endswith(f"/{tool['name']}") or member.name == tool["name"]:
                    chosen = member
                    break
            if chosen is None:
                raise SystemExit(f"Binary {tool['name']} not found in {archive.name}")
            src = tar.extractfile(chosen)
            if src is None:
                raise SystemExit(f"Cannot read member {chosen.name} from {archive.name}")
            target = BIN_DIR / tool["name"]
            with src, target.open("wb") as out:
                shutil.copyfileobj(src, out)
            target.chmod(0o555)


if __name__ == "__main__":
    if "--install" in sys.argv[1:]:
        install()
    else:
        fetch()
