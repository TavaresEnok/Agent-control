import json, pathlib, urllib.request
lock = json.load(open("/tmp/verify-tools.lock.json"))
root = pathlib.Path("/tmp/tools")
root.mkdir(parents=True, exist_ok=True)
lines = []
for tool in lock["tools"]:
    dest = root / tool["file"]
    print("baixando " + tool["name"] + " " + tool["version"], flush=True)
    last = None
    for _attempt in range(3):
        try:
            urllib.request.urlretrieve(tool["url"], dest)
            last = None
            break
        except Exception as exc:
            last = exc
    if last is not None:
        raise SystemExit(last)
    lines.append(tool["sha256"] + "  " + tool["file"])
(root / "checksums.txt").write_text("\n".join(lines) + "\n")
