/**
 * Every hashed asset the emitted shell links — the entry script and its
 * stylesheet — read off the built `index.html`. This is what the build stamps
 * into the service worker's precache list (`vite.mobile.config.ts`), kept as
 * its own dependency-free module so the stamp can be tested without loading
 * the vite config, which drags Rolldown and Lightning CSS into a jsdom test.
 */
export function shellAssets(indexHtml: string): string[] {
  return [...new Set([...indexHtml.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((match) => match[1]))];
}
