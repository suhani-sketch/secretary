// A tiny Node ESM resolve hook, used ONLY by weekplan.test.ts, for one narrow reason: core/weekplan.ts is the first
// core module that imports ANOTHER core module by a bare relative specifier ("./schedule", no extension) — the same
// convention every core/*.ts file already uses (matches core/plans.ts → "./recurrence", core/calendar/aggregate.ts →
// "./occurrences") and the only style the real app's build (tsc "Bundler" resolution, Vite/esbuild) accepts cleanly.
// Node's own type-stripping runtime, unlike a bundler, does not append ".ts" for an unresolved relative specifier, so
// running this one file directly needs this hook; every other test file is a leaf module (only imports "luxon") and
// never hits this, which is why only this one file needs it.
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context)
  } catch (err) {
    if (specifier.startsWith('.') && !specifier.endsWith('.ts') && err?.code === 'ERR_MODULE_NOT_FOUND') {
      return nextResolve(`${specifier}.ts`, context)
    }
    throw err
  }
}
