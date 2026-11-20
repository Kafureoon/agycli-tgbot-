#!/usr/bin/env python3
import json
import os
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

import yaml

SUB_FILE = Path("/opt/mihomo/sub.url")
SUB_INFO = Path("/opt/mihomo/sub_info.json")
CONF_PATH = Path("/etc/mihomo/config.yaml")
TMP_CONF = Path("/etc/mihomo/config.yaml.tmp")
MIHOMO_BIN = "/usr/local/bin/mihomo"
CONTROLLER = "http://127.0.0.1:9090"

def parse_userinfo(header_val: str) -> dict:
    out = {}
    for part in (header_val or "").split(";"):
        part = part.strip()
        if "=" in part:
            k, v = part.split("=", 1)
            try:
                out[k.strip()] = int(v.strip())
            except ValueError:
                pass
    return out

def is_dummy_proxy(p: dict) -> bool:
    name = str(p.get("name", ""))
    server = str(p.get("server", ""))
    if server in ("sub.info.node", "127.0.0.1", "0.0.0.0", ""):
        return True
    for marker in ("\u8fc7\u671f\u65f6\u95f4", "\u5269\u4f59\u6d41\u91cf", "\u91cd\u7f6e", "\u5b98\u7f51", "\u7f51\u5740"):
        if marker in name:
            return True
    return False

def main() -> int:
    url = sys.argv[1].strip() if len(sys.argv) > 1 and sys.argv[1].strip() else SUB_FILE.read_text(encoding="utf-8").strip()
    if not url:
        print("Empty subscription URL", file=sys.stderr)
        return 1
    if len(sys.argv) > 1 and sys.argv[1].strip():
        SUB_FILE.write_text(url + "\n", encoding="utf-8")

    req = urllib.request.Request(url, headers={"User-Agent": "clash-verge/v2.0.0"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        raw = resp.read().decode("utf-8")
        userinfo_hdr = resp.headers.get("subscription-userinfo", "")

    data = yaml.safe_load(raw)
    if not isinstance(data, dict) or not data.get("proxies"):
        print("Invalid subscription YAML: no proxies found", file=sys.stderr)
        return 1

    real_proxies = [p for p in data["proxies"] if isinstance(p, dict) and not is_dummy_proxy(p)]
    if not real_proxies:
        print("No valid proxy nodes after filtering", file=sys.stderr)
        return 1

    proxy_names = [p["name"] for p in real_proxies]
    config = {
        "mixed-port": 7897,
        "bind-address": "127.0.0.1",
        "allow-lan": False,
        "mode": "rule",
        "log-level": "warning",
        "unified-delay": True,
        "tcp-concurrent": True,
        "external-controller": "127.0.0.1:9090",
        "profile": {
            "store-selected": True,
            "store-fake-ip": False,
        },
        "dns": {"enable": False},
        "proxies": real_proxies,
        "proxy-groups": [
            {
                "name": "PROXY",
                "type": "select",
                "proxies": ["DIRECT", "AUTO"] + proxy_names,
            },
            {
                "name": "AUTO",
                "type": "url-test",
                "url": "https://www.gstatic.com/generate_204",
                "interval": 300,
                "tolerance": 50,
                "proxies": proxy_names,
            },
        ],
        "rules": [
            "MATCH,PROXY",
        ],
    }

    TMP_CONF.write_text(yaml.safe_dump(config, allow_unicode=True, sort_keys=False), encoding="utf-8")
    subprocess.run([MIHOMO_BIN, "-t", "-d", "/etc/mihomo", "-f", str(TMP_CONF)], check=True)
    os.replace(TMP_CONF, CONF_PATH)

    info = {
        "updated_at": int(time.time()),
        "url": url,
        "node_count": len(proxy_names),
        "nodes": proxy_names,
        "userinfo": parse_userinfo(userinfo_hdr),
    }
    SUB_INFO.write_text(json.dumps(info, ensure_ascii=False, indent=2), encoding="utf-8")

    # Reload running mihomo via REST API if active
    try:
        reload_req = urllib.request.Request(
            f"{CONTROLLER}/configs?force=true",
            data=json.dumps({"path": str(CONF_PATH)}).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="PUT",
        )
        with urllib.request.urlopen(reload_req, timeout=5):
            pass
        print(f"Updated & reloaded {len(proxy_names)} nodes")
    except Exception:
        print(f"Updated config with {len(proxy_names)} nodes (service not yet running)")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
