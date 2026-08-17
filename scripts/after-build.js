/**
 * electron-builder afterAllArtifactBuild 钩子
 * 打包完成后自动将安装包归档到 release/v{version}/ 子目录
 */
const fs = require("node:fs");
const path = require("node:path");

exports.default = async function afterAllArtifactBuild(buildResult) {
  const pkg = require("../package.json");
  const version = pkg.version;
  const releaseDir = path.join(__dirname, "..", "release");
  const versionDir = path.join(releaseDir, "v" + version);

  if (!fs.existsSync(versionDir)) fs.mkdirSync(versionDir, { recursive: true });

  const filesToArchive = buildResult.artifactPaths || [];
  for (const src of filesToArchive) {
    if (src.includes("win-unpacked") || !fs.existsSync(src)) continue;
    const basename = path.basename(src);
    const dest = path.join(versionDir, basename);
    fs.copyFileSync(src, dest);
    console.log("[after-build] 已归档: " + basename + " -> release/v" + version + "/");
    const rootFile = path.join(releaseDir, basename);
    if (fs.existsSync(rootFile) && rootFile !== dest) fs.rmSync(rootFile, { force: true });
  }

  for (const f of ["builder-debug.yml", "latest.yml"]) {
    const fp = path.join(releaseDir, f);
    if (fs.existsSync(fp)) fs.rmSync(fp, { force: true });
  }
  console.log("[after-build] 安装包已归档至 release/v" + version + "/");
};
