const root = document.documentElement;
root.classList.add('js');

const liveStatus = document.querySelector('[data-live-status]');

function copyText(text) {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text);
  }

  const field = document.createElement('textarea');
  field.value = text;
  field.setAttribute('readonly', '');
  field.style.position = 'fixed';
  field.style.opacity = '0';
  document.body.append(field);
  field.select();
  const copied = document.execCommand('copy');
  field.remove();
  return copied ? Promise.resolve() : Promise.reject(new Error('copy failed'));
}

for (const button of document.querySelectorAll('[data-copy]')) {
  button.addEventListener('click', async () => {
    const host = button.closest('[data-command]');
    const text = host?.querySelector('code')?.textContent?.trim();
    if (!text) return;

    const label = button.querySelector('[data-copy-label]');
    try {
      await copyText(text);
      if (label) label.textContent = '已复制';
      if (liveStatus) liveStatus.textContent = '命令已复制';
    } catch {
      if (label) label.textContent = '复制失败';
      if (liveStatus) liveStatus.textContent = '复制失败，请手动选择命令';
    }

    window.setTimeout(() => {
      if (label) label.textContent = '复制';
    }, 1600);
  });
}

const revealItems = document.querySelectorAll('[data-reveal]');
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

if (revealItems.length > 0 && !reduceMotion && 'IntersectionObserver' in window) {
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add('is-visible');
      observer.unobserve(entry.target);
    }
  }, { threshold: 0.16 });

  for (const item of revealItems) observer.observe(item);
} else {
  for (const item of revealItems) item.classList.add('is-visible');
}
