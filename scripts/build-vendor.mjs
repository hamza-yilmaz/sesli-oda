// Harici kütüphaneleri vendor/ klasörüne paketler. Site derleme gerektirmez;
// bu betik yalnızca kütüphane sürümü güncellenirken çalıştırılır: `npm i && npm run vendor`
import {build} from 'esbuild';
import {copyFileSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';

// .map dosyaları dağıtılmadığı için kaynak haritası yorumlarını kaldır
const copyJs = (from, to) =>
  writeFileSync(to, readFileSync(from, 'utf8').replace(/\n?\/\/# sourceMappingURL=.*$/m, '\n'));

const nm = 'node_modules';
mkdirSync('vendor/noise', {recursive: true});

await build({
  entryPoints: [`${nm}/trystero/dist/index.mjs`],
  bundle: true,
  format: 'esm',
  minify: true,
  target: 'es2020',
  legalComments: 'eof',
  outfile: 'vendor/trystero.mjs',
});

const ns = `${nm}/@sapphi-red/web-noise-suppressor/dist`;
copyJs(`${ns}/index.js`, 'vendor/noise/index.js');
copyJs(`${ns}/rnnoise/workletProcessor.js`, 'vendor/noise/rnnoiseWorklet.js');
copyFileSync(`${ns}/rnnoise.wasm`, 'vendor/noise/rnnoise.wasm');
copyFileSync(`${ns}/rnnoise_simd.wasm`, 'vendor/noise/rnnoise_simd.wasm');
copyFileSync(`${nm}/trystero/LICENSE`, 'vendor/LICENSE.trystero');
copyFileSync(`${nm}/@sapphi-red/web-noise-suppressor/LICENSE`, 'vendor/LICENSE.web-noise-suppressor');
console.log('vendor/ güncellendi');
