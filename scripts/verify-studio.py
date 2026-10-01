"""Run after devday:prepare and starting Studio. Requires Python Playwright."""
import json
import os
import urllib.request
import urllib.error
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

base = os.environ.get("TORIS_STUDIO_API_URL", "http://127.0.0.1:3000")
evidence = Path(".toris-studio/devday/evidence")
evidence.mkdir(parents=True, exist_ok=True)
projects = {}
for kind in ["shorts", "vertical", "youtube-landscape"]:
    project = json.loads(Path(f".toris-studio/devday/{kind}.json").read_text())
    req = urllib.request.Request(base + "/api/projects", json.dumps(project).encode(), {"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as response:
        saved = json.load(response)["project"]
    with urllib.request.urlopen(base + "/api/projects/" + saved["id"], timeout=30) as response:
        assert json.load(response)["project"]["scenes"] == saved["scenes"]
    projects[kind] = saved

bad = {**projects["shorts"], "scenes": []}
for suffix, method in [("/api/projects", "POST"), ("/api/projects/" + bad["id"], "PUT")]:
    try:
        urllib.request.urlopen(urllib.request.Request(base + suffix, json.dumps(bad).encode(), {"Content-Type": "application/json"}, method=method), timeout=30)
        raise AssertionError("Empty scenes accepted")
    except urllib.error.HTTPError as error:
        assert error.code == 400

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=os.environ.get("REMOTION_BROWSER_EXECUTABLE", "/usr/bin/chromium"), headless=True)
    page = browser.new_page(viewport={"width": 1600, "height": 1100})
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto(base)
    picker = page.get_by_label("저장된 프로젝트")
    picker.select_option(projects["shorts"]["id"])
    expect(page.get_by_role("button", name="Play video", exact=True)).to_be_visible()
    page.get_by_role("button", name="Play video", exact=True).click()
    expect(page.get_by_role("button", name="Pause video", exact=True)).to_be_visible()
    page.wait_for_timeout(1000)
    page.get_by_role("button", name="Pause video", exact=True).click()
    page.screenshot(path=str(evidence / "shorts-preview.png"), full_page=True)
    page.get_by_role("button", name="저장", exact=True).click()
    expect(page.get_by_text("프로젝트를 저장했습니다.", exact=True)).to_be_visible()
    page.reload()
    expect(picker).to_have_value(projects["shorts"]["id"])
    page.get_by_label("내레이션 파일").set_input_files("public/devday-2026/audio/hook.wav")
    expect(page.get_by_text("음성을 연결하고 장면 길이를 맞췄습니다. 대본과 자막도 확인하세요.", exact=True)).to_be_visible()
    picker.select_option(projects["youtube-landscape"]["id"])
    expect(page.get_by_text("대본은 있지만 음성이 없는 장면 6개", exact=True)).to_be_visible()
    page.screenshot(path=str(evidence / "longform-editor.png"), full_page=True)
    assert not errors, errors
    browser.close()

Path(evidence / "ui-results.json").write_text(json.dumps({"apiRoundTrips": 3, "invalidPostAndPut": 400, "previewPlayback": "passed", "saveReload": "passed", "audioImport": "passed", "missingNarrationWarning": "passed", "pageErrors": errors}, ensure_ascii=False, indent=2))
print("API, editor selection, preview playback, save/reload and audio import passed")
