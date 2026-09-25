/**
 * DSH Desktop - Bundled Backend Pruning Script
 * 深度剥离离线内核中的非运行时文件，极大缩减安装包碎文件数量，加速 Windows 安装与解压
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const backendDir = path.join(rootDir, 'bundled-backend');

if (!fs.existsSync(backendDir)) {
  console.log(`[prune-backend] bundled-backend directory does not exist, skipping.`);
  process.exit(0);
}

// 绝对受保护扩展名与文件名白名单（严禁误删）
const PROTECTED_EXTS = new Set([
  '.js', '.cjs', '.mjs',
  '.json',
  '.node',
  '.wasm',
  '.html', '.css',
  '.png', '.jpg', '.jpeg', '.svg', '.gif', '.ico',
  '.ttf', '.woff', '.woff2', '.eot',
  '.lm', // 某些语言分词模型文件
]);

// 绝对安全剔除的扩展名
const DROP_EXTS = new Set([
  '.ts', '.tsx', '.mts', '.cts',
  '.map',
  '.md', '.markdown',
  '.npmignore',
  '.eslintignore',
  '.prettierignore',
  '.editorconfig',
]);

// 绝对安全剔除的目录名称
const DROP_DIR_NAMES = new Set([
  'test', 'tests', '__tests__', 'spec', 'specs',
  'example', 'examples',
  'docs', 'documentation',
  '.github', '.vscode', '.idea',
]);

// 绝对安全剔除的精确文件名（大小写不敏感）
const DROP_EXACT_FILES = new Set([
  'readme', 'readme.txt', 'readme.md', 'readme.markdown',
  'changelog', 'changelog.txt', 'changelog.md',
  'history.md', 'authors', 'contributors',
  '.eslintrc', '.eslintrc.js', '.eslintrc.json', '.eslintrc.yml',
  '.prettierrc', '.prettierrc.js', '.prettierrc.json',
  'tsconfig.json', 'tsconfig.build.json', 'tsdoc.json',
  '.travis.yml', 'appveyor.yml', '.gitlab-ci.yml',
]);

let removedFiles = 0;
let removedDirs = 0;
let removedBytes = 0;

function pruneDirectory(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const lowerName = entry.name.toLowerCase();

    if (entry.isDirectory()) {
      // 检查目录是否命中删除规则
      if (DROP_DIR_NAMES.has(lowerName)) {
        try {
          const stats = getDirStats(fullPath);
          fs.rmSync(fullPath, { recursive: true, force: true });
          removedDirs += 1 + stats.dirCount;
          removedFiles += stats.fileCount;
          removedBytes += stats.totalBytes;
        } catch (err) {
          console.warn(`[prune-backend] Failed to remove dir ${fullPath}:`, err.message);
        }
      } else {
        pruneDirectory(fullPath);
      }
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();

      let shouldDelete = false;

      if (DROP_EXTS.has(ext)) {
        shouldDelete = true;
      } else if (DROP_EXACT_FILES.has(lowerName)) {
        shouldDelete = true;
      } else if (lowerName.startsWith('readme.') || lowerName.startsWith('changelog.')) {
        shouldDelete = true;
      }

      // 白名单强制豁免
      if (PROTECTED_EXTS.has(ext) && !shouldDelete) {
        shouldDelete = false;
      }

      if (shouldDelete) {
        try {
          const st = fs.statSync(fullPath);
          fs.unlinkSync(fullPath);
          removedFiles++;
          removedBytes += st.size;
        } catch (err) {
          console.warn(`[prune-backend] Failed to unlink file ${fullPath}:`, err.message);
        }
      }
    }
  }

  // 检查是否变为空目录，若为空则物理清除
  try {
    const remaining = fs.readdirSync(dir);
    if (remaining.length === 0 && dir !== backendDir) {
      fs.rmdirSync(dir);
      removedDirs++;
    }
  } catch {
    // 忽略目录非空或已删除
  }
}

function getDirStats(dir) {
  let fileCount = 0;
  let dirCount = 0;
  let totalBytes = 0;

  function walk(d) {
    try {
      const items = fs.readdirSync(d, { withFileTypes: true });
      for (const it of items) {
        const fp = path.join(d, it.name);
        if (it.isDirectory()) {
          dirCount++;
          walk(fp);
        } else if (it.isFile()) {
          fileCount++;
          const st = fs.statSync(fp);
          totalBytes += st.size;
        }
      }
    } catch {
      // 忽略
    }
  }

  walk(dir);
  return { fileCount, dirCount, totalBytes };
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

console.log(`[prune-backend] Starting deep pruning on: ${backendDir}...`);
const startTime = Date.now();
pruneDirectory(backendDir);
// 二次扫尾清理可能残留的空目录
pruneDirectory(backendDir);
const duration = Date.now() - startTime;

console.log(`\n======================================================`);
console.log(`✓ [prune-backend] 离线内核瘦身大扫除完毕！`);
console.log(`  - 成功剥离无用碎文件: ${removedFiles.toLocaleString()} 个`);
console.log(`  - 成功清理废弃目录:   ${removedDirs.toLocaleString()} 个`);
console.log(`  - 释放磁盘空间:       ${formatBytes(removedBytes)}`);
console.log(`  - 执行耗时:           ${duration} ms`);
console.log(`======================================================\n`);
