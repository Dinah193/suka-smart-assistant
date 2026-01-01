/* eslint-disable no-console */

// Vite/ESM-safe soft import helper
export async function softImport(modulePaths = []) {
  for (const p of modulePaths) {
    try {
      // IMPORTANT: keep paths as literal strings in the call site.
      // @vite-ignore allows trying multiple known paths.
      const mod = await import(/* @vite-ignore */ p);
      return mod?.default ?? mod;
    } catch (e) {
      // keep trying
    }
  }
  return null;
}
