#!/usr/bin/env python3
"""Live engine contract/SSRF smoke test; never prints credentials or page bodies.

The desktop application itself runs extraction and indexing in Rust. This
standard-library-only harness is an optional developer verification tool.
"""

import argparse
import json
import os
from pathlib import Path
import re
import stat
import time
from urllib.error import HTTPError
from urllib.request import build_opener, ProxyHandler, Request


BASE = "http://127.0.0.1:11235"
MAX_RESPONSE = 2 * 1024 * 1024
OPENER = build_opener(ProxyHandler({}))


def request(path, payload=None, token=None):
    headers = {"Accept": "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    data = None
    if payload is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(payload).encode()
    started = time.monotonic()
    try:
        response = OPENER.open(Request(BASE + path, data=data, headers=headers), timeout=45)
    except HTTPError as error:
        response = error
    with response:
        body = response.read(MAX_RESPONSE + 1)
        if len(body) > MAX_RESPONSE:
            raise ValueError("Engine response exceeded 2 MiB")
        return response.status, json.loads(body), round(time.monotonic() - started, 3)


def crawl_payload(url):
    return {
        "urls": [url],
        "browser_config": {
            "type": "BrowserConfig",
            "params": {"headless": True, "text_mode": True},
        },
        "crawler_config": {
            "type": "CrawlerRunConfig",
            "params": {
                "page_timeout": 30000,
                "check_robots_txt": True,
                "exclude_external_links": True,
            },
        },
    }


def blocked(code, body):
    if code in (400, 403):
        return isinstance(body, dict) and "URL blocked" in str(body.get("detail", ""))
    if code != 200 or not isinstance(body, dict):
        return False  # Timeout/5xx/network failure is not SSRF protection proof.
    results = body.get("results")
    if not isinstance(results, list) or not results:
        return False
    return all(
        isinstance(result, dict)
        and result.get("success") is False
        and ("URL blocked" in str(result.get("error_message", ""))
             or "ERR_TUNNEL_CONNECTION_FAILED" in str(result.get("error_message", ""))
             or (result.get("redirected_status_code") == 403
                 and isinstance(result.get("markdown"), dict)
                 and result["markdown"].get("raw_markdown", "").strip("`\n ") == "URL blocked"))
        for result in results
    )


def private_write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    # Refuse overwriting or following a symlink in an existing evidence path.
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w") as output:
        output.write(json.dumps(data, ensure_ascii=False, indent=2) + "\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--credential-file", type=Path, required=True)
    parser.add_argument("--evidence-dir", type=Path)
    arguments = parser.parse_args()
    credential = arguments.credential_file
    info = credential.lstat()
    if not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) & 0o077:
        raise ValueError("Credential must be a private regular file (0600)")
    match = re.fullmatch(r"CRAWL4AI_API_TOKEN=([a-f0-9]{64})\n?", credential.read_text())
    if not match:
        raise ValueError("Credential format mismatch")
    token = match.group(1)
    report = {"engine": "crawl4ai", "expectedVersion": "0.9.4", "checks": []}

    def record(name, passed, code, seconds, **safe_fields):
        item = {"name": name, "passed": passed, "httpStatus": code,
                "seconds": seconds, **safe_fields}
        report["checks"].append(item)
        print(json.dumps(item, ensure_ascii=False), flush=True)

    code, health, duration = request("/health")
    record("health-version", code == 200 and health.get("version") == "0.9.4",
           code, duration, actualVersion=health.get("version"))
    payload = crawl_payload("https://example.com/")
    code, body, duration = request("/crawl", payload)
    record("auth-required", code == 401, code, duration)
    code, body, duration = request("/crawl", payload, "invalid-token")
    record("invalid-token-rejected", code == 401, code, duration)

    code, body, duration = request("/crawl", payload, token)
    results = body.get("results", []) if isinstance(body, dict) else []
    result = results[0] if results and isinstance(results[0], dict) else {}
    markdown = result.get("markdown", {})
    markdown = markdown.get("raw_markdown", "") if isinstance(markdown, dict) else ""
    metadata = result.get("metadata", {})
    title = metadata.get("title", "") if isinstance(metadata, dict) else ""
    passed = (code == 200 and result.get("success") is True
              and result.get("status_code") == 200
              and result.get("url") == "https://example.com/"
              and "documentation examples" in markdown and title == "Example Domain")
    record("public-page-markdown", passed, code, duration,
           resultCount=len(results), markdownBytes=len(markdown.encode()),
           resultUrlMatches=result.get("url") == "https://example.com/", titleMatches=title == "Example Domain")
    if arguments.evidence_dir:
        private_write(arguments.evidence_dir / "public-page.json", body)

    cases = [
        ("loopback-rejected", "http://127.0.0.1:11235/health"),
        ("rfc1918-rejected", "http://10.0.0.1/"),
        ("metadata-ip-rejected", "http://169.254.169.254/latest/meta-data/"),
        ("docker-host-rejected", "http://host.docker.internal:11235/health"),
        ("ipv6-loopback-rejected", "http://[::1]:11235/health"),
        ("nat64-loopback-rejected", "http://[64:ff9b::7f00:1]:11235/health"),
        ("private-dns-rejected", "http://127.0.0.1.nip.io:11235/health"),
        ("redirect-to-private-rejected", "https://httpbin.org/redirect-to?url=http%3A%2F%2F127.0.0.1%3A11235%2Fhealth"),
    ]
    for name, url in cases:
        code, body, duration = request("/crawl", crawl_payload(url), token)
        record(name, blocked(code, body), code, duration)
        if arguments.evidence_dir:
            private_write(arguments.evidence_dir / (name + ".json"), body)
    report["passed"] = all(item["passed"] for item in report["checks"])
    if arguments.evidence_dir:
        private_write(arguments.evidence_dir / "summary.json", report)
    raise SystemExit(0 if report["passed"] else 1)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError) as error:
        # No exception repr, HTTP payload, token or raw crawl output in stdout.
        print("Crawler smoke check failed (local runtime/response contract)", flush=True)
        raise SystemExit(1) from None
