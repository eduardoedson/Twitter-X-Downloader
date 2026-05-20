const SVG_DOWNLOAD = `
<svg viewBox="0 0 24 24" aria-hidden="true" width="18" height="18" fill="currentColor">
  <g><path d="M12 17.59 6.7 12.3l1.4-1.42 2.9 2.9V3h2v10.78l2.9-2.9 1.4 1.42L12 17.59zM4 20h16v-2H4v2z"></path></g>
</svg>
`.trim();

const SVG_SPINNER = `
<svg viewBox="0 0 24 24" aria-hidden="true" width="18" height="18" fill="currentColor">
  <g><path d="M12 4V2a10 10 0 0 1 10 10h-2a8 8 0 0 0-8-8z"><animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="0.9s" repeatCount="indefinite"/></path></g>
</svg>
`.trim();

export type ButtonState = 'idle' | 'loading' | 'ok' | 'error';

export function createDownloadButton(label = 'Download media') {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'twx-btn';
  btn.setAttribute('aria-label', label);
  btn.title = label;
  setButtonState(btn, 'idle');
  return btn;
}

export function setButtonState(btn: HTMLButtonElement, state: ButtonState) {
  btn.classList.remove('twx-btn--loading', 'twx-btn--ok', 'twx-btn--error');
  if (state === 'loading') {
    btn.classList.add('twx-btn--loading');
    btn.innerHTML = SVG_SPINNER;
    return;
  }
  if (state === 'ok') {
    btn.classList.add('twx-btn--ok');
    btn.innerHTML = SVG_DOWNLOAD;
    return;
  }
  if (state === 'error') {
    btn.classList.add('twx-btn--error');
    btn.innerHTML = SVG_DOWNLOAD;
    return;
  }
  btn.innerHTML = SVG_DOWNLOAD;
}

