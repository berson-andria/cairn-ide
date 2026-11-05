export async function loadIconSprite(): Promise<void> {
  if (document.getElementById('icon-sprite')) return;

  const res = await fetch('assets/icons-sprite.svg', { cache: 'no-cache' });
  const text = await res.text();
  if (!res.ok || !text.trimStart().startsWith('<svg')) {
    throw new Error(`icon sprite: unexpected response (${res.status}) from ${res.url}`);
  }

  const host = document.createElement('div');
  host.id = 'icon-sprite';
  host.setAttribute('aria-hidden', 'true');
  host.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none';
  host.innerHTML = text;
  document.body.prepend(host);
}
