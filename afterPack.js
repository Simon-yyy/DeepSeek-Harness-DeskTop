// electron-builder afterPack hook: apply the custom icon to the packaged exe
// after the app is assembled but before the installer is built. This is the
// only reliable place to inject the icon, since signAndEditExecutable=false
// (needed to skip the broken winCodeSign symlink extraction on this machine).
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

exports.default = async function afterPack(context) {
  const { appOutDir, packager } = context;
  const productName = packager.appInfo.productFilename;
  const exePath = path.join(appOutDir, `${productName}.exe`);

  // Locate rcedit-x64 from the manually-extracted winCodeSign cache, or the
  // packaged copy under node_modules if present.
  const candidates = [
    path.join(__dirname, "node_modules", "rcedit", "bin", "rcedit-x64.exe"),
    path.join(__dirname, "node_modules", "rcedit", "bin", "rcedit.exe"),
    path.join(process.env.LOCALAPPDATA || "", "electron-builder", "Cache", "winCodeSign", "winCodeSign-2.6.0", "rcedit-x64.exe"),
    path.join(process.env.LOCALAPPDATA || "", "electron-builder", "Cache", "winCodeSign", "winCodeSign-2.6.0", "rcedit-ia32.exe"),
    path.join(process.env.ELECTRON_BUILDER_CACHE || "", "winCodeSign", "winCodeSign-2.6.0", "rcedit-x64.exe"),
  ];
  const rcedit = candidates.find((p) => fs.existsSync(p));
  if (!rcedit) {
    console.warn("afterPack: rcedit binary not found, skipping manual icon injection");
    return;
  }
  const iconPath = path.join(__dirname, "build", "icon.ico");
  if (!fs.existsSync(iconPath)) {
    console.warn("afterPack: icon.ico not found, skipping icon injection");
    return;
  }

  console.log(`afterPack: applying icon via ${rcedit} to ${exePath}`);
  try {
    execFileSync(rcedit, [exePath, "--set-icon", iconPath], { stdio: "inherit" });
    console.log("afterPack: icon applied successfully");
  } catch (err) {
    console.warn("afterPack: rcedit failed (icon might already be injected by electron-builder):", err.message);
  }
};
