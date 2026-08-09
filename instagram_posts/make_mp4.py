import os
import time
import io
import numpy as np
import cv2
from playwright.sync_api import sync_playwright
from PIL import Image

html_path = f"file:///{os.path.abspath('exodus_level.html')}".replace("\\", "/")
output_path = 'exodus_premium.mp4'

FPS = 30
DURATION_SECONDS = 10
TOTAL_FRAMES = FPS * DURATION_SECONDS
FRAME_STEP_MS = 1000 / FPS

print(f"Initializing VideoWriter for {output_path} at {FPS} FPS, 1080x1920")
# Use 'mp4v' for MP4 format
fourcc = cv2.VideoWriter_fourcc(*'mp4v')
out = cv2.VideoWriter(output_path, fourcc, FPS, (1080, 1920))

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 1080, "height": 1920})
    
    print(f"Loading {html_path}")
    page.goto(html_path)
    
    print("Waiting for page to render...")
    time.sleep(2)
    
    print("Syncing animations for perfect frame capture...")
    page.evaluate("""
        document.getAnimations().forEach(anim => {
            anim.pause();
            anim.currentTime = 0;
        });
    """)
    
    print(f"Capturing {TOTAL_FRAMES} frames...")
    for i in range(TOTAL_FRAMES):
        current_time_ms = i * FRAME_STEP_MS
        
        page.evaluate(f"""
            document.getAnimations().forEach(anim => {{
                anim.currentTime = {current_time_ms};
            }});
        """)
        
        screenshot_bytes = page.screenshot(type='jpeg', quality=100)
        
        # Convert bytes to PIL Image, then to numpy array for cv2
        img = Image.open(io.BytesIO(screenshot_bytes))
        frame = np.array(img)
        # Convert RGB (PIL) to BGR (OpenCV)
        frame = cv2.cvtColor(frame, cv2.COLOR_RGB2BGR)
        
        out.write(frame)
        
        if (i + 1) % 30 == 0:
            print(f"Captured {i + 1}/{TOTAL_FRAMES} frames...")

    browser.close()

out.release()
print(f"Done! Saved premium 4K-quality video as {output_path}")
