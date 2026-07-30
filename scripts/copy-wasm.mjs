/**
 * 将 onnxruntime-web 的 WASM 运行时文件复制到 public/wasm/
 *
 * onnxruntime-web 在浏览器中需要加载 .wasm 文件才能执行 ONNX 模型。
 * 这些文件需要放在 Vite 的 public/ 目录中，以便在开发和生产环境中都能被访问。
 *
 * 通过 postinstall 脚本自动运行，确保每次 npm install 后 WASM 文件都是最新的。
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const ROOT = join(__dirname, '..');
const SRC_DIR = join(ROOT, 'node_modules', 'onnxruntime-web', 'dist');
const DST_DIR = join(ROOT, 'public', 'wasm');

// 需要复制的 WASM 文件模式
const WASM_FILES = [
  'ort-wasm-simd-threaded.wasm',
  'ort-wasm-simd-threaded.asyncify.wasm',
  'ort-wasm-simd-threaded.jsep.wasm',
  'ort-wasm-simd-threaded.jspi.wasm',
];

// 确保目标目录存在
if (!existsSync(DST_DIR)) {
  mkdirSync(DST_DIR, { recursive: true });
}

// 复制文件
let copied = 0;
for (const file of WASM_FILES) {
  const src = join(SRC_DIR, file);
  const dst = join(DST_DIR, file);
  if (existsSync(src)) {
    copyFileSync(src, dst);
    copied++;
    console.log(`  ✓ ${file}`);
  } else {
    console.warn(`  ⚠ 未找到: ${file}`);
  }
}

console.log(`\nWASM 文件复制完成: ${copied}/${WASM_FILES.length}`);
