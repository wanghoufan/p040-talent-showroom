from pathlib import Path
from playwright.sync_api import sync_playwright
import json
root=Path(__file__).resolve().parents[1]
issues=[]
with sync_playwright() as p:
    browser=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
    page=browser.new_page(viewport={"width":390,"height":844},device_scale_factor=1,is_mobile=True)
    page.set_default_timeout(2500)
    page.on('pageerror',lambda x:issues.append(str(x)))
    page.set_content((root/'prototype.html').read_text(encoding='utf-8'))
    assert page.get_by_text('歌曲地图').count()==1
    assert page.locator('#code').inner_text()=='A1'
    page.locator('#segments button').nth(3).click()
    assert page.locator('#code').inner_text()=='B1'
    page.locator('#loop').click()
    assert '已设本段循环' in page.locator('#loop').inner_text()
    page.locator('#lyrics button').nth(0).click()
    page.locator('#split').click()
    # 0:53 is the section start; shouldn't split
    assert '请先点选本段中间' in page.locator('#status').inner_text()
    page.locator('#lyrics button').nth(1).click()
    page.locator('#split').click()
    assert page.locator('#code').inner_text()=='B2'
    assert page.locator('#segments button').count()==10
    page.locator('#reset').click()
    assert page.locator('#segments button').count()==9
    page.locator('#theme').click()
    assert page.locator('html').get_attribute('data-theme')=='dark'
    page.screenshot(path=str(root/'tests'/'mobile-dark.png'),full_page=True)
    page.locator('#theme').click()
    assert page.locator('html').get_attribute('data-theme')=='light'
    page.screenshot(path=str(root/'tests'/'mobile-light.png'),full_page=True)
    nav=page.locator('.nav').bounding_box()
    assert nav is not None and nav['y']>= 0 and nav['y']+nav['height']<= 844+1
    assert not issues,issues
    browser.close()
print(json.dumps({'result':'PASS','viewport':'390x844','scenarios':['section selection','loop selection','edge split guard','split at lyric','reset','theme switch','bottom navigation visible','no page error']} ,ensure_ascii=False))
