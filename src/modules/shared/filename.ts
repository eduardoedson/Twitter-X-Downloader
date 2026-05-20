export function sanitizeFilename(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 200);
}

export function extensionFromUrl(url: string, fallback: string): string {
  try {
    const u = new URL(url);
    const fmt = u.searchParams.get('format');
    if (fmt) return fmt;
    const m = u.pathname.match(/\.([a-z0-9]+)$/i);
    if (m) return m[1].toLowerCase();
  } catch {
    // Ignore invalid URLs and use fallback extension.
  }
  return fallback;
}

