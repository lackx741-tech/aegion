import os
import time
from playwright.sync_api import sync_playwright

html_path = f"file:///{os.path.abspath('gif_generator.html')}".replace("\\", "/")

with sync_playwright() as p:
    browser = p.chromium.launch()
    # Setting up the context to record a video (9:16 aspect ratio)
    context = browser.new_context(
        viewport={"width": 1080, "height": 1920},
        record_video_dir=".",
        record_video_size={"width": 1080, "height": 1920}
    )
    
    page = context.new_page()
    print(f"Loading {html_path}")
    page.goto(html_path)
    
    print("Recording animation... waiting 3.1 seconds...")
    time.sleep(3.1) # Wait for CSS animations to finish a full loop
    
    print("Saving video...")
    video_path = page.video.path()
    context.close()
    browser.close()
    
    # Rename the video to a nice name
    if os.path.exists('short_loop.webm'):
        os.remove('short_loop.webm')
    os.rename(video_path, 'short_loop.webm')
    
print("Done! Video saved as short_loop.webm")
