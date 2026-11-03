#!/usr/bin/env python3
"""Send JS to the running dev app and print the JSON result.

  ./drive.py 'return t.text("#root").length'
  ./drive.py -f script.js          # whole file as one async body
  ./drive.py --shot out.png        # grim screenshot of the dev Kansei window

The code runs as an async function body with `t` bound to the helpers in
src/app/driver.ts (t.tabs, t.store, t.q, t.byText, t.sleep, t.text, t.toasts...).
"""
import json, os, socket, subprocess, sys

SOCK = "/tmp/kansei-driver.sock"

def run(code: str):
    s = socket.socket(socket.AF_UNIX)
    s.settimeout(40)
    s.connect(SOCK)
    s.sendall((code.replace("\n", " ") + "\n").encode())
    line = s.makefile("r").readline().strip()
    s.close()
    try:
        return json.loads(line)
    except json.JSONDecodeError:
        return {"__raw": line}

def is_dev(pid: int) -> bool:
    """True for the dev build (target/debug/kansei), not the packaged /usr/bin/kansei."""
    try:
        return "/target/" in os.readlink(f"/proc/{pid}/exe")
    except OSError:
        return False

def shot(path: str):
    clients = json.loads(subprocess.check_output(["hyprctl", "clients", "-j"]))
    mine = [c for c in clients if c["class"] == "kansei"]
    win = next((c for c in mine if is_dev(c["pid"])), None) or mine[0]
    x, y = win["at"]; w, h = win["size"]
    subprocess.check_call(["grim", "-g", f"{x},{y} {w}x{h}", path])
    return path

if __name__ == "__main__":
    a = sys.argv[1:]
    if not a:
        print(__doc__); sys.exit(1)
    if a[0] == "--shot":
        print(shot(a[1]))
    elif a[0] == "-f":
        print(json.dumps(run(open(a[1]).read()), indent=1))
    else:
        print(json.dumps(run(" ".join(a)), indent=1))
