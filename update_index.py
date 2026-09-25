import re

with open('index.html', 'r', encoding='utf-8') as f:
    content = f.read()

# 1. Fonts
content = content.replace(
    'href="https://fonts.googleapis.com/css2?family=Oi&family=Ultra&family=Bebas+Neue&family=Inter:wght@400;500;600&display=swap"',
    'href="https://fonts.googleapis.com/css2?family=Oi&family=Ultra&family=Bebas+Neue&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@500;600&family=Outfit:wght@400;500;600;700&display=swap"'
)

# 2. Add --red-accent to :root
content = content.replace(
    '--coral: #ff4747;',
    '--coral: #ff4747;\n      --red-accent: #ff4747;'
)

# 3. .store-cards -> .store-grid
content = content.replace('.store-cards {', '.store-grid {')

# 4. Remove inline styles style="width:100%; display:block;"
content = content.replace('style="width:100%; display:block;"', '')
content = content.replace('style="width: 100%; display: block;"', '')

# add .figure img { width: 100%; display: block; }
figure_img_css = """
    .figure img {
      width: 100%;
      display: block;
    }
"""
if '.figure img {' not in content:
    content = content.replace('img {', figure_img_css + '\n    img {')

# 5. Remove mix-blend-mode and add will-change
content = content.replace('mix-blend-mode: screen;', '')
content = content.replace(
    'opacity: 0.6;\n    }',
    'opacity: 0.6;\n      will-change: transform;\n    }'
)
# For meteors specifically, if needed, will-change: transform is already there.

# Remove drop-shadow from biggest
content = re.sub(r'filter: drop-shadow\(.*?rgba\(255, 107, 107, 0\.2\)\);', '', content) # octo
content = re.sub(r'filter: drop-shadow\(.*?rgba\(57, 255, 20, 0\.2\)\);', '', content) # earth
content = re.sub(r'filter: drop-shadow\(.*?rgba\(255, 69, 0, 0\.6\)\);', '', content) # meteor

# 6. Videos: replace autoplay with preload="metadata"
# find <video ... autoplay loop muted playsinline>
content = re.sub(r'<video(.*?)autoplay', r'<video\1preload="metadata"', content)

# 7. Replace mousemove
old_mouse = """      // Playful hover repulsion for all .word elements
      const words = document.querySelectorAll('.word');
      document.addEventListener('mousemove', (e) => {
        words.forEach(word => {
          // Skip repulsion while letters are still flying in
          const parent = word.closest('.fly-letters');
          if (parent && parent.dataset.flown === '1' && !parent.classList.contains('fly-done')) return;
          if (parent && parent.dataset.flown !== '1') return;

          const rect = word.getBoundingClientRect();
          const x = rect.left + rect.width / 2;
          const y = rect.top + rect.height / 2;
          const dx = x - e.clientX;
          const dy = y - e.clientY;
          const dist = Math.sqrt(dx * dx + dy * dy);

          if (dist < 180) {
            const push = (180 - dist) / 2.5;
            const moveX = (dx / dist) * push;
            const moveY = (dy / dist) * push;
            const rotate = (dx / 180) * 15;
            word.style.transform = `translate(${moveX}px, ${moveY}px) rotate(${rotate}deg) scale(1.1)`;
          } else {
            word.style.transform = `translate(0px, 0px) rotate(0deg) scale(1)`;
          }
        });
      });"""

new_mouse = """      // Playful hover repulsion just for SLCM
      const words = document.querySelectorAll('.hero-title .word');
      let wordRects = [];
      
      function calcRects() {
        wordRects = Array.from(words).map(word => {
          const rect = word.getBoundingClientRect();
          return {
            word: word,
            x: rect.left + rect.width / 2,
            baseY: rect.top + window.scrollY + rect.height / 2
          };
        });
      }
      
      window.addEventListener('load', calcRects);
      window.addEventListener('resize', calcRects);
      setTimeout(calcRects, 3000);

      let mouseX = 0, mouseY = 0;
      let hoverRequested = false;
      
      document.addEventListener('mousemove', (e) => {
        mouseX = e.clientX;
        mouseY = e.clientY;
        if (!hoverRequested) {
          hoverRequested = true;
          requestAnimationFrame(updateHover);
        }
      });
      
      function updateHover() {
        const scrollY = window.scrollY;
        wordRects.forEach(({word, x, baseY}) => {
          const y = baseY - scrollY;
          const parent = word.closest('.fly-letters');
          if (parent && parent.dataset.flown === '1' && !parent.classList.contains('fly-done')) return;
          if (parent && parent.dataset.flown !== '1') return;

          const dx = x - mouseX;
          const dy = y - mouseY;
          const dist = Math.sqrt(dx * dx + dy * dy);

          if (dist < 180) {
            const push = (180 - dist) / 2.5;
            const moveX = (dx / dist) * push;
            const moveY = (dy / dist) * push;
            const rotate = (dx / 180) * 15;
            word.style.transform = `translate(${moveX}px, ${moveY}px) rotate(${rotate}deg) scale(1.1)`;
          } else {
            word.style.transform = `translate(0px, 0px) rotate(0deg) scale(1)`;
          }
        });
        hoverRequested = false;
      }
      
      // Intersection Observer for videos
      const videoObserver = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
          if (entry.isIntersecting) {
            entry.target.play().catch(e => {});
          } else {
            entry.target.pause();
          }
        });
      }, { rootMargin: '200px' });
      document.querySelectorAll('video').forEach(vid => videoObserver.observe(vid));"""

if old_mouse in content:
    content = content.replace(old_mouse, new_mouse)
else:
    print("Could not find old mouse script!")

with open('index.html', 'w', encoding='utf-8') as f:
    f.write(content)

print("Done")
