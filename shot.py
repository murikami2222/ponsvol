import sys, time
from playwright.sync_api import sync_playwright

url = "http://127.0.0.1:8577"
out = sys.argv[1]
wait_s = float(sys.argv[2]) if len(sys.argv) > 2 else 2

with sync_playwright() as p:
    b = p.chromium.launch(channel="chrome", headless=True)
    pg = b.new_page(viewport={"width": 1440, "height": 900})
    pg.goto(url, wait_until="load")  # networkidle never settles: UI polls /api/state every 2s
    pg.wait_for_timeout(int(wait_s * 1000))
    pg.screenshot(path=out, full_page=True)
    b.close()
print("saved", out)
