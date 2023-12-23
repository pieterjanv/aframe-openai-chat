import * as esbuild from 'esbuild'

esbuild.build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  target: 'es2017',
  outfile: './dist/index.js',
});
