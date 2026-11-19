import json
import os
import pathlib
import shutil
import tarfile

lock = json.load(open("/tmp/tools.lock.json", encoding="utf-8"))
root = pathlib.Path("/tmp/tools")
bindir = pathlib.Path("/usr/local/bin")
limit = 400 * 1024 * 1024


def safe_parts(rel: str) -> list[str]:
    parts = [p for p in rel.split("/") if p and p != "."]
    if not parts or any(p == ".." for p in parts) or rel.startswith("/"):
        raise SystemExit(f"caminho recusado: {rel}")
    return parts


for tool in lock["tools"]:
    src = root / tool["file"]
    kind = tool["kind"]
    if kind == "bin":
        dest = bindir / tool["name"]
        shutil.copyfile(src, dest)
        os.chmod(dest, 0o555)
    elif kind == "tar.gz":
        dest = bindir / tool["name"]
        with tarfile.open(src, "r:gz") as tar:
            member = tar.getmember(tool["member"])
            if not member.isfile() or member.name != tool["member"] or ".." in member.name.split("/"):
                raise SystemExit("arquivo recusado")
            extracted = tar.extractfile(member)
            if extracted is None:
                raise SystemExit("arquivo recusado")
            data = extracted.read()
            if len(data) > limit:
                raise SystemExit("arquivo recusado")
            dest.write_bytes(data)
            os.chmod(dest, 0o555)
    elif kind == "tar.gz-dir":
        prefix = tool["prefix"].rstrip("/") + "/"
        dest_dir = pathlib.Path(tool["destDir"])
        dest_dir.mkdir(parents=True, exist_ok=True)
        os.chmod(dest_dir, 0o755)
        with tarfile.open(src, "r:gz") as tar:
            for member in tar.getmembers():
                if not member.name.startswith(prefix):
                    continue
                rel = member.name[len(prefix):]
                if not rel:
                    continue
                parts = safe_parts(rel)
                # Instala apenas testssl.sh, etc/ e bin/openssl.Linux.x86_64
                top = parts[0]
                if top not in (tool["entrypoint"], "etc", "bin", "LICENSE"):
                    continue
                if top == "bin" and len(parts) > 1 and parts[1] not in ("openssl.Linux.x86_64", "OPENSSL-LICENSE.txt", "Readme.md"):
                    continue
                target = dest_dir.joinpath(*parts)
                if member.isdir():
                    target.mkdir(parents=True, exist_ok=True)
                    os.chmod(target, 0o755)
                elif member.isfile():
                    extracted = tar.extractfile(member)
                    if extracted is None:
                        raise SystemExit("arquivo recusado")
                    data = extracted.read()
                    if len(data) > limit:
                        raise SystemExit("arquivo recusado")
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(data)
                    is_exec = rel == tool["entrypoint"] or rel == "bin/openssl.Linux.x86_64"
                    os.chmod(target, 0o555 if is_exec else 0o444)
                else:
                    raise SystemExit(f"tipo de membro recusado: {member.name}")
        link_path = bindir / tool["name"]
        if link_path.exists() or link_path.is_symlink():
            link_path.unlink()
        link_path.symlink_to(dest_dir / tool["entrypoint"])
    else:
        raise SystemExit(f"tipo recusado: {kind}")
    print(f"instalado {tool['name']} {tool['version']}", flush=True)
