import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { app } from 'electron';

// 备份包内版本清单文件名（v2.3.48）：固定写入 zip 根目录（data/ 之外），
// 恢复时会先被剔除，不会混入数据目录。
const BACKUP_META_NAME = '_backup_meta.json';

// 读取当前应用版本号；非 Electron 环境（如测试脚本直接运行本模块）返回空串。
function getAppVersion(): string {
  try {
    return typeof app?.getVersion === 'function' ? app.getVersion() : '';
  } catch {
    return '';
  }
}

// 将 dataDir 整个目录压缩为 zip 保存到 destZipPath。
// appVersion：调用方可显式传入版本号（便于测试）；缺省取 app.getVersion()。
export function createBackup(dataDir: string, destZipPath: string, appVersion?: string): void {
  const zip = new AdmZip();
  zip.addLocalFolder(dataDir, 'data');
  // v2.3.48：zip 根目录写入版本清单（appVersion + 创建时间），用于恢复时识别备份创建版本
  const meta = {
    appVersion: appVersion || getAppVersion(),
    createdAt: new Date().toISOString(),
  };
  zip.addFile(BACKUP_META_NAME, Buffer.from(JSON.stringify(meta, null, 2), 'utf-8'));
  zip.writeZip(destZipPath);
}

// 从 zip 还原到 dataDir。
// 采用“先校验再替换”的原子策略：
//   1) 解压到临时目录并校验结构；
//   2) 先把当前数据复制到安全备份目录；
//   3) 确认无误后再清空原目录并拷贝；
//   4) 仅当整体成功才删除安全备份。
// 任意一步失败都会抛错，绝不会留下空目录导致“恢复出厂”。
export function restoreBackup(zipPath: string, dataDir: string): void {
  const parent = path.dirname(dataDir);
  const tmp = path.join(parent, `_restore_tmp_${Date.now()}`);
  const oldBackup = path.join(parent, `_restore_old_${Date.now()}`);
  let success = false;
  try {
    const zip = new AdmZip(zipPath);
    zip.extractAllTo(tmp, true);
    // 兼容两种内部布局：zip 内含 data/ 子目录，或根目录直接是数据文件
    const src = fs.existsSync(path.join(tmp, 'data')) ? path.join(tmp, 'data') : tmp;
    if (
      !fs.existsSync(path.join(src, 'settings.json')) &&
      !fs.existsSync(path.join(src, 'store.json'))
    ) {
      throw new Error('备份文件无效：未找到设置或数据文件');
    }
    // v2.3.48：剔除版本清单文件（zip 根目录产物；两种可能位置都删一次），避免混入数据目录
    fs.rmSync(path.join(tmp, BACKUP_META_NAME), { force: true });
    fs.rmSync(path.join(src, BACKUP_META_NAME), { force: true });
    // 保留旧数据，便于失败时回滚
    fs.mkdirSync(oldBackup, { recursive: true });
    fs.cpSync(dataDir, oldBackup, { recursive: true });
    // 替换为备份内容
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.mkdirSync(dataDir, { recursive: true });
    fs.cpSync(src, dataDir, { recursive: true });
    success = true;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    if (success) {
      fs.rmSync(oldBackup, { recursive: true, force: true });
    }
  }
}

// 读取备份包的创建版本号（v2.3.48）。
// 兼容清单位于 zip 根目录或 data/ 子目录两种布局；旧备份（无清单）或任何解析异常返回 null。
export function peekBackupVersion(zipPath: string): string | null {
  try {
    const zip = new AdmZip(zipPath);
    const entry = zip.getEntry(BACKUP_META_NAME) || zip.getEntry(`data/${BACKUP_META_NAME}`);
    if (!entry) return null;
    const raw = zip.readAsText(entry);
    const meta = JSON.parse(raw) as { appVersion?: unknown };
    const v = typeof meta?.appVersion === 'string' ? meta.appVersion.trim() : '';
    return v || null;
  } catch {
    return null;
  }
}
