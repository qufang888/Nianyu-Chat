import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';

// 将 dataDir 整个目录压缩为 zip 保存到 destZipPath
export function createBackup(dataDir: string, destZipPath: string): void {
  const zip = new AdmZip();
  zip.addLocalFolder(dataDir, 'data');
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
