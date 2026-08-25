import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';

const rootDir = process.cwd();
const pkgPath = path.join(rootDir, 'package.json');
const releaseDir = path.join(rootDir, 'release');
const changelogPath = path.join(rootDir, 'CHANGELOG.md');

// Parse CLI arguments: [node, script, typeOrVersion, note]
const args = process.argv.slice(2);
const bumpType = args[0] || 'current';
const updateNotes = args[1] || '';

function computeSha256(filePath) {
  if (!fs.existsSync(filePath)) return '';
  const buffer = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function bumpVersion(current, type) {
  const parts = current.split('.').map(Number);
  if (parts.length !== 3 || parts.some(isNaN)) throw new Error(`Invalid semver version: ${current}`);
  let [major, minor, patch] = parts;
  if (type === 'major') {
    major += 1; minor = 0; patch = 0;
  } else if (type === 'minor') {
    minor += 1; patch = 0;
  } else if (type === 'patch') {
    patch += 1;
  } else if (/^\d+\.\d+\.\d+$/.test(type)) {
    return type;
  } else if (type === 'current') {
    return current;
  } else {
    throw new Error(`Unknown bump type: ${type}`);
  }
  return `${major}.${minor}.${patch}`;
}

async function main() {
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const oldVersion = pkg.version;
  const newVersion = bumpVersion(oldVersion, bumpType);

  console.log(`\n📦 [Release Workflow] Target Version: v${newVersion} (from v${oldVersion})`);

  // 1. Update package.json version
  if (newVersion !== oldVersion) {
    pkg.version = newVersion;
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
    console.log(`✓ Updated package.json version to ${newVersion}`);
  }

  // 2. Build with electron-builder if not just reorganizing
  console.log(`\n🚀 Building installer with electron-builder...`);
  const builderCli = path.join(rootDir, 'node_modules', 'electron-builder', 'cli.js');
  execSync(`"${process.execPath}" "${builderCli}" --win`, {
    stdio: 'inherit',
    windowsHide: true,
    cwd: rootDir,
  });

  // 3. Create version-specific folder in release/
  const versionFolderName = `v${newVersion}`;
  const versionFolder = path.join(releaseDir, versionFolderName);
  if (!fs.existsSync(versionFolder)) {
    fs.mkdirSync(versionFolder, { recursive: true });
  }
  console.log(`\n📂 Created version archive folder: release/${versionFolderName}`);

  // 4. Move generated installer and blockmap into version folder
  const installerName = `DSH Desktop Setup ${newVersion}.exe`;
  const blockmapName = `${installerName}.blockmap`;

  const srcInstaller = path.join(releaseDir, installerName);
  const srcBlockmap = path.join(releaseDir, blockmapName);

  const destInstaller = path.join(versionFolder, installerName);
  const destBlockmap = path.join(versionFolder, blockmapName);

  if (fs.existsSync(srcInstaller)) {
    fs.renameSync(srcInstaller, destInstaller);
    console.log(`✓ Moved installer to: release/${versionFolderName}/${installerName}`);
  }
  if (fs.existsSync(srcBlockmap)) {
    fs.renameSync(srcBlockmap, destBlockmap);
    console.log(`✓ Moved blockmap to: release/${versionFolderName}/${blockmapName}`);
  }

  // 5. Generate RELEASE_NOTES.md
  const now = new Date();
  const dateStr = now.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }).replace(/\//g, '-');
  const timeStr = now.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });

  const fileSize = fs.existsSync(destInstaller) ? formatBytes(fs.statSync(destInstaller).size) : 'N/A';
  const sha256 = computeSha256(destInstaller);

  const defaultNotes = [
    '- 🎨 官方质感白底圆角矩形 + 经典墨黑 DeepSeek 鲸鱼品牌图标',
    '- 🖼️ 客户端原生剪贴板图片与拖拽图片拦截（自动转换为本地路径，彻底解决模型不支持图片附件报错）',
    '- 🤫 后台子进程与命令行调用静默化改造（彻底消除对话过程中弹出的黑色终端控制台）',
    '- 🧩 完整接入 @liustack/modlens 视觉插件与 dshmarket 可视化插件市场',
    '- ⚡ 内置 35 个工业级全流程 AI 编程技能（Matt Pocock Skills）'
  ].join('\n');

  const notesBody = updateNotes ? updateNotes : defaultNotes;

  const releaseNotesContent = `# DSH Desktop v${newVersion} 发布说明

- **版本号**：\`v${newVersion}\`
- **发布日期**：${dateStr} ${timeStr}
- **安装包名称**：\`${installerName}\`
- **文件大小**：${fileSize}
- **SHA-256 哈希**：\`${sha256}\`

---

## 🌟 更新内容 (Changelog)

${notesBody}

---

## 🚀 安装与使用指南

1. 双击运行 \`${installerName}\` 完成安装或覆盖升级；
2. 安装后自动在桌面与开始菜单生成【DSH Desktop】快捷方式；
3. 打开后即可自动拉起 DeepSeek Harness 本地服务并开始高效对话与编程！
`;

  const releaseNotesPath = path.join(versionFolder, 'RELEASE_NOTES.md');
  fs.writeFileSync(releaseNotesPath, releaseNotesContent, 'utf8');
  console.log(`✓ Generated: release/${versionFolderName}/RELEASE_NOTES.md`);

  // 6. Update global CHANGELOG.md
  let changelogContent = '';
  if (fs.existsSync(changelogPath)) {
    changelogContent = fs.readFileSync(changelogPath, 'utf8');
  } else {
    changelogContent = '# DSH Desktop 版本更新日志\n\n';
  }

  const newEntry = `## [v${newVersion}] - ${dateStr}\n\n${notesBody}\n\n`;
  if (!changelogContent.includes(`## [v${newVersion}]`)) {
    changelogContent = changelogContent.replace('# DSH Desktop 版本更新日志\n\n', `# DSH Desktop 版本更新日志\n\n${newEntry}`);
    fs.writeFileSync(changelogPath, changelogContent, 'utf8');
    console.log(`✓ Updated: CHANGELOG.md`);
  }
  // 7. Clean up older release archives, keep only the latest 2 versions
  const MAX_RETAIN_VERSIONS = 2;
  const versionDirs = fs.readdirSync(releaseDir, { withFileTypes: true })
    .filter(dirent => dirent.isDirectory() && /^v\d+\.\d+\.\d+$/.test(dirent.name))
    .map(dirent => dirent.name)
    .sort((a, b) => {
      const semverA = a.replace(/^v/, '').split('.').map(Number);
      const semverB = b.replace(/^v/, '').split('.').map(Number);
      for (let i = 0; i < 3; i++) {
        if (semverA[i] !== semverB[i]) return semverB[i] - semverA[i]; // descending
      }
      return 0;
    });

  if (versionDirs.length > MAX_RETAIN_VERSIONS) {
    const toRemove = versionDirs.slice(MAX_RETAIN_VERSIONS);
    for (const oldDirName of toRemove) {
      const oldDirPath = path.join(releaseDir, oldDirName);
      try {
        fs.rmSync(oldDirPath, { recursive: true, force: true });
        console.log(`🧹 Cleaned up old release archive: release/${oldDirName} (only keeping latest ${MAX_RETAIN_VERSIONS})`);
      } catch (err) {
        console.warn(`Failed to remove old archive release/${oldDirName}:`, err.message);
      }
    }
  }

  console.log(`\n🎉 [Release Done] Release v${newVersion} packaged and archived successfully!`);
}

main().catch((err) => {
  console.error('Release failed:', err);
  process.exit(1);
});
