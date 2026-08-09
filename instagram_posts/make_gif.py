import os
import time
from playwright.sync_api import sync_playwright
from PIL import Image
import io

html_path = f"file:///{os.path.abspath('gif_content.html')}".replace("\\", "/")

frames = []

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 1080, "height": 1920})
    
    print(f"Loading {html_path}")
    page.goto(html_path)
    
    # Wait for the page to fully load and render (skipping white flash)
    print("Waiting for page to fully load...")
    time.sleep(1.5)
    
    # Pause all animations and sync them perfectly
    print("Syncing animations for perfect frame capture...")
    page.evaluate("""
        document.getAnimations().forEach(anim => {
            anim.pause();
            anim.currentTime = 0;
        });
    """)
    
    # 12 seconds * 10 fps = 120 frames
    print("Capturing 120 frames (exactly 12 seconds of animation)...")
    for i in range(120):
        current_time_ms = i * 100
        
        # Advance animation by exactly 100ms
        page.evaluate(f"""
            document.getAnimations().forEach(anim => {{
                anim.currentTime = {current_time_ms};
            }});
        """)
        
        # Capture screenshot as bytes (fastest way)
        screenshot_bytes = page.screenshot(type='jpeg', quality=80)
        
        # Convert bytes to PIL Image
        img = Image.open(io.BytesIO(screenshot_bytes))
        
        # Optimize by resizing slightly for GIF file size
        img = img.resize((540, 960), Image.Resampling.LANCZOS)
        
        frames.append(img)
        
        if i % 20 == 0:
            print(f"Captured {i}/120 frames...")

    browser.close()
    
print("Saving as perfectly timed animated GIF... This may take a minute...")
output_path = 'content_loop.gif'
if os.path.exists(output_path):
    os.remove(output_path)

frames[0].save(
    output_path,
    save_all=True,
    append_images=frames[1:],
    optimize=True,
    duration=100, # 100ms per frame = exactly 10 fps
    loop=0 # Loop forever
)

print(f"Done! Saved perfectly synced GIF as {output_path}")
