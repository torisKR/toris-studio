"""Run against a built/running Studio after prepare-devday-30.ts."""
import json, urllib.request, os
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
base=os.environ.get('TORIS_STUDIO_API_URL','http://127.0.0.1:3000')
out=Path('.toris-studio/devday-30/evidence')
out.mkdir(parents=True,exist_ok=True)
with sync_playwright() as p:
    browser=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True)
    page=browser.new_page(viewport={'width':1600,'height':1100})
    errors=[]
    page.on('pageerror',lambda error:errors.append(str(error)))
    page.goto(base)
    for variant in ['instagram','youtube']:
        project=json.loads(Path(f'.toris-studio/devday-30/{variant}.json').read_text())
        req=urllib.request.Request(base+'/api/projects',json.dumps(project).encode(),{'Content-Type':'application/json'})
        with urllib.request.urlopen(req) as response:
            saved=json.load(response)['project']
        with urllib.request.urlopen(base+'/api/projects/'+saved['id']) as response:
            assert json.load(response)['project']['scenes']==project['scenes']
        picker=page.get_by_label('저장된 프로젝트')
        page.reload()
        picker.select_option(project['id'])
        expect(page.locator('[data-social-safe-content]')).to_be_visible()
        page.get_by_role('button',name='저장',exact=True).click()
        expect(page.get_by_text('프로젝트를 저장했습니다.',exact=True)).to_be_visible()
        page.reload()
        expect(picker).to_have_value(project['id'])
        page.screenshot(path=str(out/f'{variant}-editor.png'),full_page=True)
        page.get_by_role('button',name='Play video',exact=True).click()
        expect(page.get_by_role('button',name='Pause video',exact=True)).to_be_visible()
        page.get_by_role('button',name='Pause video',exact=True).click()
    assert not errors,errors
    browser.close()
(out/'ui-results.json').write_text(json.dumps({'variants':2,'apiRoundTrips':'passed','saveReload':'passed','previewPlayback':'passed','pageErrors':errors},indent=2))
print('Both 30-second projects: API, preview and save/reload passed')
