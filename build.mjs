// 构建：把 src/ 打包成一个可直接安装的 Tampermonkey 脚本 dist/course-fetch.user.js。
// 用法：node build.mjs（或 npm run build）。也可 import { build } 在测试中生成产物而不写文件。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
export const OUTFILE = path.join(ROOT, 'dist', 'course-fetch.user.js');

export async function build({ write = true } = {}) {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const header = fs.readFileSync(path.join(ROOT, 'src', 'userscript.meta.js'), 'utf8').replaceAll('{{version}}', pkg.version);
  const result = await esbuild.build({
    entryPoints: [path.join(ROOT, 'src', 'main.js')],
    outfile: OUTFILE,
    bundle: true,
    loader: { '.css': 'text' },
    format: 'iife',
    target: 'es2020',
    charset: 'utf8',
    legalComments: 'none',
    banner: { js: header.trimEnd() },
    define: { __CF_VERSION__: JSON.stringify(pkg.version) },
    write,
    logLevel: write ? 'info' : 'silent',
  });
  return write ? OUTFILE : result.outputFiles[0].text;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  build().catch(() => process.exit(1));
}
