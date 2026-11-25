/**
 * 念语 v3.0.18 本地透明加密内核（纯 Node 模块，零 electron import）。
 *
 * 信封格式：MAGIC(8B "NYENC001") | IV(12B) | TAG(16B) | CIPHERTEXT
 *   - 魔数判定明文/密文，天然幂等；无魔数一律按旧明文读取。
 *   - AES-256-GCM 认证加密，篡改 / 错密钥抛 E_DECRYPT_FAILED，绝不降级回明文。
 *   - 所有写盘先写同目录 .nyenc.tmp 再 renameSync，避免半密文。
 *
 * 密钥独立于数据目录：app.getPath('userData')/nianyu-master.key，不进备份。
 * 本模块刻意不 import electron —— app.getPath 由调用方（db.ts）注入。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { EncryptionStatus } from '../src/types';

/** 信封魔数（8 字节 ASCII）；也是「是否密文」的唯一判据。 */
export const MAGIC = 'NYENC001';
export const MAGIC_BYTES: Buffer = Buffer.from(MAGIC, 'ascii');
/** 魔数 8 + IV 12 + TAG 16 = 36 字节固定头。 */
export const HEADER_BYTES = 36;
/** 主密钥文件名（同步登记 硬编码清单.md）。 */
export const KEY_FILE_NAME = 'nianyu-master.key';

const IV_BYTES = 12;
const KEY_BYTES = 32;
const ALG = 'aes-256-gcm';

export interface MigrationResult {
  encrypted: string[];
  skipped: string[];
  failed: string[];
  error?: string;
}

let keyPath = '';
let cachePath = '';
let cachedKey: Buffer | null = null;
let lastMigration: MigrationResult | null = null;

/** 由主进程注入密钥文件路径（userData/nianyu-master.key）。 */
export function initSecureStore(filePath: string): void {
  if (!filePath || filePath === keyPath) return;
  keyPath = filePath;
  cachedKey = null;
  cachePath = '';
  lastMigration = null;
}

export function getKeyPath(): string {
  return keyPath;
}

function makeError(code: string, message: string): Error {
  const e = new Error(`${code}: ${message}`);
  (e as Error & { code?: string }).code = code;
  return e;
}

/** 密钥 JSON 结构：v / alg / key(base64 32B) / created_at。 */
function parseKeyFile(raw: string): Buffer {
  const obj = JSON.parse(raw) as { v?: number; alg?: string; key?: string; created_at?: string };
  if (obj.v !== 1 || obj.alg !== ALG || typeof obj.key !== 'string') {
    throw makeError('E_KEY_CORRUPT', '密钥文件格式无效');
  }
  const key = Buffer.from(obj.key, 'base64');
  if (key.length !== KEY_BYTES) {
    throw makeError('E_KEY_CORRUPT', '密钥长度无效');
  }
  return key;
}

function writeAtomic(filePath: string, data: Buffer): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.nyenc.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, filePath);
}

/** 读取已有密钥；不存在抛 E_KEY_MISSING（恢复备份时绝不隐式造新密钥）。 */
export function loadKeyOrThrow(filePath: string = keyPath): Buffer {
  if (!filePath) throw makeError('E_KEY_MISSING', '尚未初始化主密钥路径');
  if (cachedKey && cachePath === filePath) return cachedKey;
  if (!fs.existsSync(filePath)) {
    throw makeError('E_KEY_MISSING', '缺少本机主密钥文件，请拷贝 userData/nianyu-master.key');
  }
  let key: Buffer;
  try {
    key = parseKeyFile(fs.readFileSync(filePath, 'utf-8'));
  } catch (e) {
    if ((e as Error & { code?: string }).code === 'E_KEY_CORRUPT') throw e;
    throw makeError('E_KEY_CORRUPT', `主密钥文件损坏：${(e as Error).message}`);
  }
  cachedKey = key;
  cachePath = filePath;
  return key;
}

/** 读取或首次生成主密钥（启动时调用；非 Windows 平台 chmod 0600）。 */
export function loadOrCreateKey(filePath: string = keyPath): Buffer {
  if (!filePath) throw makeError('E_KEY_MISSING', '尚未初始化主密钥路径');
  try {
    return loadKeyOrThrow(filePath);
  } catch (e) {
    if ((e as Error & { code?: string }).code !== 'E_KEY_MISSING') throw e;
  }
  const key = randomBytes(KEY_BYTES);
  const payload = JSON.stringify(
    { v: 1, alg: ALG, key: key.toString('base64'), created_at: new Date().toISOString() },
    null,
    2
  );
  writeAtomic(filePath, Buffer.from(payload, 'utf-8'));
  try {
    if (process.platform !== 'win32') fs.chmodSync(filePath, 0o600);
  } catch {
    /* chmod 失败不阻断（Windows 无该语义） */
  }
  cachedKey = key;
  cachePath = filePath;
  return key;
}

export function isEncrypted(buf: Buffer): boolean {
  return !!buf && buf.length >= MAGIC_BYTES.length && buf.subarray(0, MAGIC_BYTES.length).equals(MAGIC_BYTES);
}

/** 明文 + 密钥 → NYENC001 信封。每次 IV 随机，同明文两次加密字节不同。 */
export function encryptBuffer(buf: Buffer, key?: Buffer): Buffer {
  const k = key || loadOrCreateKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALG, k, iv);
  const body = Buffer.concat([cipher.update(buf), cipher.final()]);
  return Buffer.concat([MAGIC_BYTES, iv, cipher.getAuthTag(), body]);
}

/** 信封 → 明文；魔数不符或认证失败一律抛 E_DECRYPT_FAILED，不回退明文。 */
export function decryptBuffer(buf: Buffer, key?: Buffer): Buffer {
  if (!isEncrypted(buf) || buf.length < HEADER_BYTES + 1) {
    throw makeError('E_DECRYPT_FAILED', '数据不是有效的念语加密信封');
  }
  const k = key || loadKeyOrThrow();
  const iv = buf.subarray(MAGIC_BYTES.length, MAGIC_BYTES.length + IV_BYTES);
  const tag = buf.subarray(MAGIC_BYTES.length + IV_BYTES, HEADER_BYTES);
  const body = buf.subarray(HEADER_BYTES);
  try {
    const decipher = createDecipheriv(ALG, k, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    throw makeError('E_DECRYPT_FAILED', '解密失败：数据已损坏或密钥不匹配');
  }
}

/** 读取文本：自动识别明文 / 密文；密文缺密钥抛 E_KEY_MISSING。 */
export function readText(filePath: string, key?: Buffer): string {
  const buf = fs.readFileSync(filePath);
  if (!isEncrypted(buf)) return buf.toString('utf-8');
  return decryptBuffer(buf, key).toString('utf-8');
}

/** 写文本：始终以密文落盘（.nyenc.tmp + rename 原子替换）。 */
export function writeText(filePath: string, text: string, key?: Buffer): void {
  const k = key || loadOrCreateKey();
  writeAtomic(filePath, encryptBuffer(Buffer.from(text, 'utf-8'), k));
}

/**
 * 读取任意二进制（图片 / 视频 / 头像 / 角色素材）。
 * 魔数命中则解密；外部明文源文件按原字节返回，保证导入链路兼容。
 * 文件不存在返回 null；密文缺密钥抛 E_KEY_MISSING。
 */
export function readBinary(filePath: string, key?: Buffer): Buffer | null {
  if (!fs.existsSync(filePath)) return null;
  const buf = fs.readFileSync(filePath);
  if (!isEncrypted(buf)) return buf;
  return decryptBuffer(buf, key);
}

/** 写任意二进制：与文本共用同一 NYENC001 信封，原子落盘。 */
export function writeBinary(filePath: string, data: Buffer, key?: Buffer): void {
  const k = key || loadOrCreateKey();
  writeAtomic(filePath, encryptBuffer(data, k));
}

/** 备份整包加密（外层信封；内部 zip 布局只在加密前存在）。 */
export function encryptBackup(zipBuf: Buffer, key?: Buffer): Buffer {
  return encryptBuffer(zipBuf, key);
}

/** 备份整包解密。缺密钥抛 E_KEY_MISSING，绝不创建新密钥。 */
export function decryptBackup(buf: Buffer, key?: Buffer): Buffer {
  return decryptBuffer(buf, key);
}

/**
 * 敏感文件扩展名白名单：结构化文本 + 二进制媒体 + 角色素材。
 * v3.0.18 用户口径：本地保存的敏感信息一律加密，不再把二进制媒体排除在外。
 * 明确不加密的例外（见 使用说明.md §45）：tts-cache/* （纯派生缓存，可随时重合成）、
 * userData/custom-sounds/*（用户自备音效，不属于隐私数据）、character-runtime/*（运行库）。
 */
const SENSITIVE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.json',
  // 聊天 / 头像 / 朋友圈 / 生图媒体
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.apng', '.avif', '.svg',
  '.mp4', '.webm', '.mov', '.avi', '.m4v',
  // 角色素材包展开后的模型 / 贴图 / 着色器 / 音频
  '.vrm', '.glb', '.gltf', '.moc3', '.moc', '.bin', '.dds', '.ktx2',
  '.wav', '.ogg', '.mp3', '.ttf', '.woff', '.woff2', '.frag', '.vert', '.js', '.css',
]);

/** 明确排除的目录名（派生缓存，非用户隐私；重合成即可恢复）。 */
const PLAINTEXT_DIRS: ReadonlySet<string> = new Set(['tts-cache']);

/**
 * 递归收集 dataDir 下所有敏感持久化文件（文本 + 二进制媒体）。
 * 魔数判定保证幂等；密钥文件与 .nyenc.tmp 永不纳入。
 */
export function collectEncryptableFiles(dir: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(dir)) return out;
  const walk = (d: string): void => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      if (entry.name === KEY_FILE_NAME || entry.name.endsWith('.nyenc.tmp')) continue;
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) {
        if (!PLAINTEXT_DIRS.has(entry.name.toLowerCase())) walk(p);
      } else if (entry.isFile() && SENSITIVE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        out.push(p);
      }
    }
  };
  walk(dir);
  return out.sort();
}

/**
 * 启动时把存量明文原子加密落盘；按魔数判定，重复调用幂等。
 * 失败保留原文件并记录 failed，不抛出（不阻断启动）。
 */
export function migratePlaintextFiles(files: string[], key?: Buffer): MigrationResult {
  const result: MigrationResult = { encrypted: [], skipped: [], failed: [] };
  let k: Buffer;
  try {
    k = key || loadOrCreateKey();
  } catch (e) {
    result.error = (e as Error).message;
    result.failed = files.filter((f) => fs.existsSync(f));
    lastMigration = result;
    return result;
  }
  for (const file of files) {
    try {
      if (!fs.existsSync(file)) {
        result.skipped.push(file);
        continue;
      }
      const buf = fs.readFileSync(file);
      if (isEncrypted(buf)) {
        result.skipped.push(file);
        continue;
      }
      if (path.extname(file).toLowerCase() === '.json') writeText(file, buf.toString('utf-8'), k);
      else writeBinary(file, buf, k);
      result.encrypted.push(file);
    } catch (e) {
      result.failed.push(file);
      result.error = result.error || (e as Error).message;
    }
  }
  lastMigration = result;
  return result;
}

/** 加密状态只读摘要（不暴露密钥本身，只给文件名）。 */
export function getEncryptionStatus(): EncryptionStatus {
  if (!lastMigration) return { status: 'unknown', fileCount: 0, plainFiles: [] };
  if (lastMigration.failed.length > 0 || lastMigration.error) {
    return {
      status: 'failed',
      fileCount: lastMigration.encrypted.length,
      plainFiles: lastMigration.failed.map((f) => path.basename(f)),
      error: lastMigration.error,
    };
  }
  return {
    status: 'encrypted',
    fileCount: lastMigration.encrypted.length + lastMigration.skipped.length,
    plainFiles: [],
  };
}

/** 供自检脚本读取最近一次迁移结果（复制返回，避免外部改内存态）。 */
export function getLastMigration(): MigrationResult {
  return {
    encrypted: [...(lastMigration?.encrypted || [])],
    skipped: [...(lastMigration?.skipped || [])],
    failed: [...(lastMigration?.failed || [])],
    error: lastMigration?.error,
  };
}
