import json, os, pathlib, shutil, tarfile, zipfile
lock = json.load(open("/tmp/verify-tools.lock.json"))
root = pathlib.Path("/tmp/tools")
bindir = pathlib.Path("/usr/local/bin")
limit = 400 * 1024 * 1024
for tool in lock["tools"]:
    src = root / tool["file"]
    dest = bindir / tool["name"]
    kind = tool["kind"]
    if kind == "bin":
        shutil.copyfile(src, dest)
    elif kind == "tar.gz":
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
    elif kind == "zip":
        with zipfile.ZipFile(src) as archive:
            data = archive.read(tool["member"])
            if len(data) > limit:
                raise SystemExit("arquivo recusado")
            dest.write_bytes(data)
    else:
        raise SystemExit("arquivo recusado")
    os.chmod(dest, 0o555)
    print("instalado " + tool["name"] + " " + tool["version"], flush=True)
