import os
import time
from playwright.sync_api import sync_playwright

html_path = f"file:///{os.path.abspath('post_generator.html')}".replace("\\", "/")

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 1080, "height": 1080})
    
    print(f"Loading {html_path}")
    page.goto(html_path)
    
    # Post 1 is the first .ig-post
    # But wait, our HTML scales it down to 0.5. We need to disable the scale first to capture the full 1080x1080 element!
    page.evaluate('''() => {
        document.querySelectorAll('.ig-post').forEach(el => {
            el.style.transform = 'scale(1)';
            el.style.marginBottom = '0px';
            el.style.marginRight = '0px';
            el.style.position = 'absolute';
            el.style.top = '0px';
            el.style.left = '0px';
        });
        
        // Hide posts 2, 3, 4 while capturing 1
        if (document.querySelector('.post3')) document.querySelector('.post3').style.display = 'none';
    }''')
    
    print("Capturing post 1...")
    page.locator('.post1').screenshot(path='post1_final.png')
    
    # Hide post 1, show post 3
    page.evaluate('''() => {
        document.querySelector('.post1').style.display = 'none';
        if (document.querySelector('.post3')) document.querySelector('.post3').style.display = 'flex';
    }''')
    
    print("Capturing post 3...")
    page.locator('.post3').screenshot(path='post3_final.png')
    
    browser.close()
    
print("Done!")
