import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Dev: proxy API to the running Go server (:8090 launchd dev copy)
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 8095,
    proxy: {
      '/api': 'http://localhost:8090',
    },
  },
  build: {
    rollupOptions: {
      output: {
        // Two named vendor chunks, on top of the per-tab chunks that
        // `lazy(() => import(...))` in src/App.jsx already produces.
        //
        // THIS IS `codeSplitting`, NOT `manualChunks`, AND THAT IS NOT A STYLE
        // CHOICE. Vite 8 bundles with Rolldown, not Rollup, and Rolldown has
        // three spellings of this option with two of them deprecated:
        //   manualChunks    Rollup-compat shim. Function form only (no object
        //                   form), and silently IGNORED when either of the
        //                   others is set. Deprecated.
        //   advancedChunks  deprecated in this version too — it builds clean
        //                   but prints "advancedChunks option is deprecated"
        //                   on every single build.
        //   codeSplitting   the current one, and the only one that is silent.
        // Since the entire point of this change was to stop a build printing a
        // warning, shipping a different warning would be a strange trade.
        //
        // ORDER IS LOAD-BEARING, AND IT IS THE OPPOSITE OF WHAT IT LOOKS LIKE.
        // A group does not claim only the modules its `test` matches — it also
        // pulls in their dependencies. recharts depends on react, so with
        // `charts` listed first the charts chunk swallowed react and react-dom
        // whole. The entry chunk then had to import `charts` statically just to
        // get React, Vite emitted a <link rel="modulepreload"> for it, and all
        // 403 kB of recharts was downloaded on every route including the ones
        // with no chart on them — measured at 726 KB on #provision, i.e. the
        // split bought nothing. Listing `vendor-react` first lets it claim react
        // before charts can, and #provision drops to 331 KB.
        //
        // The reason for the original order does not actually exist: the worry
        // was that the react pattern would catch react-redux (recharts 3's
        // store), but both alternations require a path separator immediately
        // after the package name, so `react-redux/` cannot match `react/`.
        codeSplitting: {
          groups: [
            {
              // React itself. Separated from the app code so a UI change does
              // not invalidate the framework's cache entry too. Downloaded on
              // every route, which is correct — every route needs it.
              name: 'vendor-react',
              test: /[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/,
            },
            {
              // recharts and everything it drags in. 7 of the 15 tabs import
              // it, so Rolldown would hoist it into a shared chunk anyway —
              // naming it is what makes the number legible in the build table
              // and what keeps it cacheable across releases, since tab code
              // changes most weeks and recharts does not.
              //
              // victory-vendor is recharts' d3 re-export shim; redux,
              // react-redux, immer and reselect are recharts 3's internal
              // store; es-toolkit and clsx are its utility deps. None of them
              // are app dependencies and none appear in ui/package.json — the
              // app's only chart import is `recharts` itself, in 7 tab files.
              name: 'charts',
              test: /[\\/]node_modules[\\/](recharts|victory-vendor|d3-[^\\/]+|internmap|delaunator|robust-predicates|redux|react-redux|immer|reselect|use-sync-external-store|es-toolkit|clsx)[\\/]/,
            },
          ],
        },
      },
    },
  },
})
