import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { app } from 'electron';
// v3.0.18：整包信封加密（容器首字节 N 而非 PK，通用解压工具打不开）。
import { decryptBackup, encryptBackup, isEncrypted } from './secureStore';
// v3.0.19：可携带备份 v2 内核转发（既有 v1 / 转换器路径逐字不动）。
import {
  createPortableBackup as createPortableBackupFile,
  restorePortableBackup as restorePortableBackupFile,
  peekBackupInfo as peekBackupInfoFile,
} from './portableBackup';
import type { BackupPeekInfo, PortableCreateResult } from '../src/types';
// 门控纯函数的唯一真源再导出，供 IPC / QA 共用（不另写魔数判断）。
export {
  detectBackupKind,
  isBackupNewer,
  isExcludedFromBackup,
  isPortableBackupFile,
  needsPassphrase,
} from './portableBackup';

// 备份包内版本清单文件名（v2.3.48）：固定写入 zip 根目录（data/ 之外），
// 恢复时会先被剔除，不会混入数据目录。
const BACKUP_META_NAME = '_backup_meta.json';
/** v3.0.18：念语备份统一后缀（磁盘小写；UI 展示 .NY）。 */
export const BACKUP_EXTENSION = '.ny';
export const LEGACY_BACKUP_EXTENSION = '.zip';

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
  // v3.0.18：_backup_meta.json 只是**加密前载荷**的一部分；成品是自有二进制容器。
  // 密钥文件在 userData 而不在 dataDir，天然不进包。扩展名沿用 .zip 仅为兼容文件选择器过滤器。
  const plain = zip.toBuffer();
  fs.writeFileSync(destZipPath, encryptBackup(plain));
}

/**
 * v3.0.18 旧备份格式转换器：旧明文 zip → 念语自有 .ny 容器。
 * 只读取原包字节并整体加密，绝不解密 / 改写内部条目（媒体保持原有字节，含已加密媒体）；
 * 原 zip 永远不被修改。已是新容器时抛 E_ALREADY_CONVERTED。
 */
export function convertLegacyBackup(zipPath: string, destPath?: string): string {
  const raw = fs.readFileSync(zipPath);
  if (isEncrypted(raw)) throw new Error('E_ALREADY_CONVERTED');
  const zip = new AdmZip(raw);
  const entries = zip.getEntries();
  const hasMarker =
    zip.getEntry(BACKUP_META_NAME) ||
    zip.getEntry(`data/${BACKUP_META_NAME}`) ||
    zip.getEntry('store.json') ||
    zip.getEntry('data/store.json');
  if (!hasMarker || !entries.length) throw new Error('备份文件无效：不是可识别的旧版 zip');
  const base = destPath || path.join(
    path.dirname(zipPath),
    `${path.basename(zipPath, path.extname(zipPath))}_converted${BACKUP_EXTENSION}`
  );
  let target = base;
  if (fs.existsSync(target)) {
    const ext = path.extname(base) || BACKUP_EXTENSION;
    const stem = path.basename(base, ext);
    for (let i = 1; fs.existsSync(target); i++) {
      target = path.join(path.dirname(base), `${stem}_${i}${ext}`);
    }
  }
  fs.writeFileSync(target, encryptBackup(raw));
  return target;
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
  let decryptedZipPath: string | null = null;
  let sourcePath = zipPath;
  try {
    // v3.0.18：按魔数识别自有容器；无密钥抛 E_KEY_MISSING，绝不降级、不清空 dataDir。
    const raw = fs.readFileSync(zipPath);
    if (isEncrypted(raw)) {
      const plain = decryptBackup(raw);
      decryptedZipPath = path.join(parent, `_decrypted_${Date.now()}.zip`);
      fs.writeFileSync(decryptedZipPath, plain);
      sourcePath = decryptedZipPath;
    }
    const zip = new AdmZip(sourcePath);
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
    if (decryptedZipPath) fs.rmSync(decryptedZipPath, { force: true });
  }
}

// 读取备份包的创建版本号（v2.3.48）。
// 兼容清单位于 zip 根目录或 data/ 子目录两种布局；旧备份（无清单）或任何解析异常返回 null。
export function peekBackupVersion(zipPath: string): string | null {
  try {
    const raw = fs.readFileSync(zipPath);
    const payload = isEncrypted(raw) ? decryptBackup(raw) : raw;
    const zip = new AdmZip(payload);
    const entry = zip.getEntry(BACKUP_META_NAME) || zip.getEntry(`data/${BACKUP_META_NAME}`);
    if (!entry) return null;
    const metaText = zip.readAsText(entry);
    const meta = JSON.parse(metaText) as { appVersion?: unknown };
    const v = typeof meta?.appVersion === 'string' ? meta.appVersion.trim() : '';
    return v || null;
  } catch {
    return null;
  }
}

// ===== v3.0.19 可携带备份 v2 转发（追加；上面 v1 / 转换器 / peek 实现逐字未动）=====

/** 创建 v2 备份：路径由主进程注入，口令只随返回值回传一次。 */
export function createPortableBackup(
  dataDir: string,
  dest: string,
  appVersion?: string
): PortableCreateResult {
  return createPortableBackupFile({
    dataDir,
    userData: app.getPath('userData'),
    dest,
    appVersion: appVersion || getAppVersion(),
  });
}

/** 还原 v2 备份：全量原子替换 + 主密钥采纳；失败在替换前抛出，不重启。 */
export function restorePortableBackup(
  backupPath: string,
  dataDir: string,
  passphrase: string
): void {
  restorePortableBackupFile({
    backupPath,
    passphrase,
    dataDir,
    userData: app.getPath('userData'),
  });
}

/** 只读头 / 清单的免口令探测。 */
export function peekBackupInfo(backupPath: string): BackupPeekInfo {
  return peekBackupInfoFile(backupPath);
}
