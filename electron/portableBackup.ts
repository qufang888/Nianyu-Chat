/**
 * 念语 v3.0.19 可携带备份内核（纯 Node 模块，零 electron import）。
 *
 * 容器 v2 = 112B 明文头 + v1 信封载荷：
 *   MAGIC('NYENC002') | FORMAT_VERSION(u16) | HEADER_BYTES(u16=112) |
 *   APP_VERSION(16B ASCII) | KDF_SALT(16) | WRAP_IV(12) | WRAP_TAG(16) |
 *   WRAPPED_KEY(32, 主密钥的 AES-GCM 封装密文) | PAYLOAD_LEN(u64)
 *   载荷 = NYENC001(8) | IV(12) | TAG(16) | CIPHERTEXT（复用 secureStore 的 v1 信封）
 *
 * 主密钥绝不裸放：头部仅有口令派生 key 封装后的认证密文；还原时先解封出主密钥，
 * 既用它解密载荷，也在原子替换阶段把采纳的新机密钥写回 userData/nianyu-master.key。
 *
 * 本模块刻意不 import electron —— 所有路径由调用方注入，便于 QA 用 esbuild 抠出直接执行。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import AdmZip from 'adm-zip';
import type {
  BackupKind,
  BackupPeekInfo,
  BackupSource,
  BackupSourceKey,
  PortableCreateResult,
} from '../src/types';
import {
  KEY_FILE_NAME,
  decryptBackup,
  encryptBackup,
  isEncrypted,
  loadKeyOrThrow,
  resetKeyCache,
} from './secureStore';

// ===== 固化常量（QA 直接读取断言，禁止漂移）=====
export const MAGIC_V2 = 'NYENC002';
export const MAGIC_V1 = 'NYENC001';
export const FORMAT_VERSION = 2;
export const HEADER_BYTES = 112;
/** Crockford base32 字母表：去掉 I/L/O/U 易混字符。 */
export const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const RAW_KEY_BYTES = 15;
export const PASS_CHARS = 24;
export const PASS_GROUPS = 6;
export const PASS_GROUP_SIZE = 4;
/** scrypt 参数固化；maxmem 显式 64MB，避免 N=2^15,r=8 触发 Node 默认 32MB 边界。 */
export const KDF = {
  N: 1 << 15,
  r: 8,
  p: 1,
  keylen: 32,
  maxmem: 64 * 1024 * 1024,
  saltBytes: 16,
} as const;
export const WRAP_IV_BYTES = 12;
export const WRAP_TAG_BYTES = 16;
export const PAYLOAD_LEN_BYTES = 8;
/** 容器内版本/来源清单置根，还原时剔除。 */
export const META_NAME = '_backup_meta.json';
/** AAD = 头前 44B：MAGIC(8)+VER(2)+HDR(2)+APP_VERSION(16)+SALT(16)。 */
const AAD_BYTES = 44;
const ALG = 'aes-256-gcm';

// ===== 数据结构 =====
export interface WrappedKey {
  salt: Buffer;
  iv: Buffer;
  tag: Buffer;
  ciphertext: Buffer;
}

export interface V2Header {
  magic: string;
  formatVersion: number;
  headerBytes: number;
  appVersion: string;
  salt: Buffer;
  wrapIv: Buffer;
  wrapTag: Buffer;
  wrappedKey: Buffer;
  payloadLen: number;
}

/** 单个还原单元；backupKey 用于 `_restore_old_<ts>_<backupKey>` 安全备份命名。 */
export interface RestoreUnit {
  key: BackupSourceKey;
  backupKey: string;
  srcPath: string;
  targetPath: string;
  isDirectory: boolean;
  isMasterKey?: boolean;
  masterKeyBuffer?: Buffer;
}

export interface PortableCreateOptions {
  dataDir: string;
  userData: string;
  dest: string;
  appVersion: string;
  /** QA / 测试可注入主密钥；生产省略时从 userData/nianyu-master.key 读取。 */
  masterKey?: Buffer;
}

export interface PortableRestoreOptions {
  backupPath: string;
  passphrase: string;
  dataDir: string;
  userData: string;
  /** QA 注入：第 N 个目标替换时抛错（1-based），用于验证逆序回滚。生产省略。 */
  failAt?: number;
}

/** 统一错误构造器：错误码走 Error.code 与 message 前缀，UI 按码映射 i18n。 */
function makeError(code: string, message: string): Error {
  const e = new Error(`${code}: ${message}`);
  (e as Error & { code?: string }).code = code;
  return e;
}

function u16be(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n, 0);
  return b;
}

/** 15B → 24 字符 Crockford base32（5bit/字符，恰好整除）。 */
function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += CROCKFORD[(value << (5 - bits)) & 31];
  return out;
}

/** 生成 24 位口令，6 组 ×4，组间 '-'，形如 X7KQ-9M2P-3VZT-8WHR-6NJL-4YDC。 */
export function generatePassphrase(): string {
  const chars = base32Encode(randomBytes(RAW_KEY_BYTES));
  const groups: string[] = [];
  for (let g = 0; g < PASS_GROUPS; g++) {
    groups.push(chars.slice(g * PASS_GROUP_SIZE, (g + 1) * PASS_GROUP_SIZE));
  }
  return groups.join('-');
}

/** 输入归一化：去分隔符/空白、转大写、I/L→1、O→0（Crockford 无障碍容错）。 */
export function normalizePassphrase(p: string): string {
  return String(p || '')
    .trim()
    .toUpperCase()
    .replace(/[-_\s]/g, '')
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0');
}

export function isValidPassphrase(p: string): boolean {
  const n = normalizePassphrase(p);
  return n.length === PASS_CHARS && [...n].every((c) => CROCKFORD.includes(c));
}

/** 口令 + salt → 派生 key（口令已归一化，KDF 参数固化）。 */
export function deriveKey(pass: string, salt: Buffer): Buffer {
  return scryptSync(normalizePassphrase(pass), salt, KDF.keylen, {
    N: KDF.N,
    r: KDF.r,
    p: KDF.p,
    maxmem: KDF.maxmem,
  });
}

/** AAD 前 44 字节：MAGIC+VER+HDR_LEN+APP_VERSION(16B)+SALT。 */
function buildAadPrefix(appVersion: string, salt: Buffer): Buffer {
  const app = Buffer.alloc(16);
  Buffer.from(String(appVersion || ''), 'utf-8').subarray(0, 16).copy(app);
  return Buffer.concat([
    Buffer.from(MAGIC_V2, 'ascii'),
    u16be(FORMAT_VERSION),
    u16be(HEADER_BYTES),
    app,
    salt,
  ]);
}

/** 用口令派生 key 封装 32B 主密钥。appVersion 参与 AAD（第 3 参缺省仅为兼容旧签名）。 */
export function wrapMasterKey(masterKey: Buffer, pass: string, appVersion = ''): WrappedKey {
  if (!Buffer.isBuffer(masterKey) || masterKey.length !== KDF.keylen) {
    throw makeError('E_BACKUP_FORMAT', '主密钥长度无效');
  }
  if (!isValidPassphrase(pass)) throw makeError('E_BAD_PASSPHRASE', '口令格式无效');
  const salt = randomBytes(KDF.saltBytes);
  const iv = randomBytes(WRAP_IV_BYTES);
  const cipher = createCipheriv(ALG, deriveKey(pass, salt), iv);
  cipher.setAAD(buildAadPrefix(appVersion, salt));
  const ciphertext = Buffer.concat([cipher.update(masterKey), cipher.final()]);
  return { salt, iv, tag: cipher.getAuthTag(), ciphertext };
}

/** 头字节 → 结构化字段；长度/魔数/版本自校验。 */
export function parseHeader(buf: Buffer): V2Header {
  if (!Buffer.isBuffer(buf) || buf.length < HEADER_BYTES) {
    throw makeError('E_BACKUP_FORMAT', '容器头长度不足');
  }
  const magic = buf.subarray(0, 8).toString('ascii');
  if (magic !== MAGIC_V2) throw makeError('E_BACKUP_FORMAT', '容器魔数不符');
  const formatVersion = buf.readUInt16BE(8);
  const headerBytes = buf.readUInt16BE(10);
  if (formatVersion !== FORMAT_VERSION || headerBytes !== HEADER_BYTES) {
    throw makeError('E_BACKUP_FORMAT', '容器版本或头长度不符');
  }
  return {
    magic,
    formatVersion,
    headerBytes,
    appVersion: buf.subarray(12, 28).toString('utf-8').replace(/\0+$/, ''),
    salt: Buffer.from(buf.subarray(28, 44)),
    wrapIv: Buffer.from(buf.subarray(44, 56)),
    wrapTag: Buffer.from(buf.subarray(56, 72)),
    wrappedKey: Buffer.from(buf.subarray(72, 104)),
    payloadLen: Number(buf.readBigUInt64BE(104)),
  };
}

/** 112B 明文头：明文只含版本元信息与被封装的主密钥密文，无用户内容。 */
export function buildHeader(
  appVersion: string,
  salt: Buffer,
  wrap: WrappedKey,
  payloadLen: number
): Buffer {
  const app = Buffer.alloc(16);
  Buffer.from(String(appVersion || ''), 'utf-8').subarray(0, 16).copy(app);
  const len = Buffer.alloc(PAYLOAD_LEN_BYTES);
  len.writeBigUInt64BE(BigInt(payloadLen), 0);
  const header = Buffer.concat([
    Buffer.from(MAGIC_V2, 'ascii'),
    u16be(FORMAT_VERSION),
    u16be(HEADER_BYTES),
    app,
    salt,
    wrap.iv,
    wrap.tag,
    wrap.ciphertext,
    len,
  ]);
  if (header.length !== HEADER_BYTES) throw makeError('E_BACKUP_FORMAT', '容器头长度构造异常');
  return header;
}

/** 解封主密钥：错口令 / 篡改头任一字段都会让 AAD 认证失败 → E_BAD_PASSPHRASE。 */
export function unwrapMasterKey(header: Buffer, pass: string): Buffer {
  const h = parseHeader(header);
  if (!isValidPassphrase(pass)) throw makeError('E_BAD_PASSPHRASE', '口令格式无效');
  try {
    const decipher = createDecipheriv(ALG, deriveKey(pass, h.salt), h.wrapIv);
    decipher.setAAD(header.subarray(0, AAD_BYTES));
    decipher.setAuthTag(h.wrapTag);
    const key = Buffer.concat([decipher.update(h.wrappedKey), decipher.final()]);
    if (key.length !== KDF.keylen) throw makeError('E_BAD_PASSPHRASE', '解封主密钥长度无效');
    return key;
  } catch (e) {
    if ((e as Error & { code?: string }).code === 'E_BAD_PASSPHRASE') throw e;
    throw makeError('E_BAD_PASSPHRASE', '口令错误或备份头已被篡改');
  }
}

/** 三态识别真源：只按魔数/首字节，绝不看扩展名。 */
export function detectBackupKind(buf: Buffer): BackupKind {
  if (!Buffer.isBuffer(buf) || buf.length < 8) return 'unknown';
  const head = buf.subarray(0, 8).toString('ascii');
  if (head === MAGIC_V2) return 'v2';
  if (head === MAGIC_V1) return 'v1';
  if (buf[0] === 0x50 && buf[1] === 0x4b) return 'zip'; // 'PK'
  return 'unknown';
}

/** 拖放 / 还原门控：仅 .ny（大小写不敏感）由新流程接管。 */
export function isPortableBackupFile(name: string): boolean {
  return /\.ny$/i.test(String(name || ''));
}

/** 备份排除门控：S1 递归收集时命中即跳过。 */
export function isExcludedFromBackup(relPath: string): boolean {
  const n = String(relPath || '').toLowerCase();
  return (
    n === 'path-config.json' ||
    n === 'custom-data-path.txt' ||
    n === 'nianyu-master.key' ||
    n.endsWith('.nyenc.tmp') ||
    n.split(/[\\/]/).includes('tts-cache')
  );
}

export function needsPassphrase(kind: BackupKind): boolean {
  return kind === 'v2';
}

/** 版本号比较（a>b 返回正数）；格式异常按 0 处理，不阻断 UI。 */
function compareVersionsSimple(a: string, b: string): number {
  const pa = String(a || '').replace(/^v/i, '').split(/[.\-+]/).map((s) => parseInt(s, 10) || 0);
  const pb = String(b || '').replace(/^v/i, '').split(/[.\-+]/).map((s) => parseInt(s, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

export function isBackupNewer(backupVer: string | null, currentVer: string): boolean {
  if (!backupVer || !currentVer) return false;
  try {
    return compareVersionsSimple(backupVer, currentVer) > 0;
  } catch {
    return false;
  }
}

/**
 * 全量状态清单：dataDir 全部 + 5 类 userData（显式白名单，不整拷 userData）。
 * 排除项由 isExcludedFromBackup 门控在收集阶段过滤。
 */
export function collectFullStateSources(dataDir: string, userData: string): BackupSource[] {
  const sources: BackupSource[] = [
    { key: 'data', srcPath: dataDir, prefix: 'data', targetPath: dataDir, isDirectory: true },
  ];
  const userItems: Array<{ key: BackupSourceKey; name: string; isDirectory: boolean }> = [
    { key: 'skills', name: 'skills.json', isDirectory: false },
    { key: 'skills', name: 'skills', isDirectory: true },
    { key: 'proactive', name: 'proactive-nhpp.json', isDirectory: false },
    { key: 'sounds', name: 'custom-sounds', isDirectory: true },
    { key: 'runtime', name: 'character-runtime', isDirectory: true },
  ];
  for (const item of userItems) {
    const p = path.join(userData, item.name);
    if (fs.existsSync(p)) {
      sources.push({
        key: item.key,
        srcPath: p,
        prefix: `userdata/${item.name}`,
        targetPath: p,
        isDirectory: item.isDirectory,
      });
    }
  }
  return sources;
}

/** 递归把目录加入 zip；exclude 按相对路径门控。 */
function addTree(
  zip: AdmZip,
  root: string,
  prefix: string,
  exclude?: (rel: string) => boolean
): void {
  if (!fs.existsSync(root)) return;
  const walk = (dir: string, relBase: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
      if (exclude && exclude(rel)) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs, rel);
      else if (entry.isFile()) zip.addFile(`${prefix}/${rel}`, fs.readFileSync(abs));
    }
  };
  walk(root, '');
}

/** 原子写盘：同目录 .nyenc.tmp + renameSync，杜绝半容器。 */
function writeAtomic(filePath: string, data: Buffer): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.nyenc.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, filePath);
}

/**
 * 创建 v2 可携带备份：生成一次性口令 → 封装主密钥 → 全量收集打包 → 整包加密 → 写盘。
 * 口令只在返回值的 passphrase 字段出现一次，绝不落盘 / 写日志 / 进 meta。
 */
export function createPortableBackup(opts: PortableCreateOptions): PortableCreateResult {
  const { dataDir, userData, dest, appVersion } = opts;
  if (!dest) throw makeError('E_BACKUP_FORMAT', '备份保存路径为空');
  const passphrase = generatePassphrase();
  const masterKey = opts.masterKey || loadKeyOrThrow(path.join(userData, KEY_FILE_NAME));
  const sources = collectFullStateSources(dataDir, userData);
  const wrap = wrapMasterKey(masterKey, passphrase, appVersion);

  const zip = new AdmZip();
  addTree(zip, dataDir, 'data', isExcludedFromBackup);
  for (const s of sources) {
    if (s.key === 'data') continue;
    if (s.isDirectory) addTree(zip, s.srcPath, s.prefix);
    else zip.addFile(s.prefix, fs.readFileSync(s.srcPath));
  }
  const meta = {
    appVersion: String(appVersion || ''),
    createdAt: new Date().toISOString(),
    format: FORMAT_VERSION,
    sources: sources.map((s) => ({
      key: s.key,
      prefix: s.prefix,
      target: s.key === 'data' ? 'dataDir' : 'userData',
      rel: s.key === 'data' ? 'data' : path.basename(s.srcPath),
    })),
  };
  zip.addFile(META_NAME, Buffer.from(JSON.stringify(meta, null, 2), 'utf-8'));

  const payload = encryptBackup(zip.toBuffer(), masterKey);
  const header = buildHeader(appVersion, wrap.salt, wrap, payload.length);
  writeAtomic(dest, Buffer.concat([header, payload]));
  return { path: dest, passphrase };
}

/** 只读头、免口令的元信息探测；v1/zip 读清单（无本机密钥时 appVersion=null）。 */
export function peekBackupInfo(backupPath: string): BackupPeekInfo {
  const raw = fs.readFileSync(backupPath);
  const size = raw.length;
  const kind = detectBackupKind(raw);
  if (kind === 'v2') {
    try {
      const h = parseHeader(raw);
      return { kind, appVersion: h.appVersion || null, format: h.formatVersion, size };
    } catch {
      return { kind, appVersion: null, format: null, size };
    }
  }
  let appVersion: string | null = null;
  try {
    const payload = isEncrypted(raw) ? decryptBackup(raw) : raw;
    const zip = new AdmZip(payload);
    const entry = zip.getEntry(META_NAME) || zip.getEntry(`data/${META_NAME}`);
    if (entry) {
      const meta = JSON.parse(zip.readAsText(entry)) as { appVersion?: unknown };
      if (typeof meta?.appVersion === 'string' && meta.appVersion.trim()) {
        appVersion = meta.appVersion.trim();
      }
    }
  } catch {
    // v1 跨机无密钥：kind 保留，appVersion=null，与 3.0.18 peekBackupVersion 语义一致
  }
  return { kind, appVersion, format: null, size };
}

/** 解包临时目录 → 还原单元（6 类源 + 1 个采纳主密钥）。 */
function buildRestoreUnits(
  tmp: string,
  dataDir: string,
  userData: string,
  masterKey: Buffer,
  metaSources: Array<{ key: string; prefix?: string }>
): RestoreUnit[] {
  const units: RestoreUnit[] = [];
  const fromMeta = (
    key: BackupSourceKey,
    fallbackPrefix: string,
    target: string,
    isDirectory: boolean
  ): void => {
    const entry = metaSources.find((s) => s.key === key);
    const prefix = entry?.prefix || fallbackPrefix;
    units.push({
      key,
      backupKey: key,
      srcPath: path.join(tmp, prefix),
      targetPath: target,
      isDirectory,
    });
  };
  fromMeta('data', 'data', dataDir, true);
  fromMeta('skills', 'userdata/skills.json', path.join(userData, 'skills.json'), false);
  const skillsDirSrc = path.join(tmp, 'userdata', 'skills');
  if (fs.existsSync(skillsDirSrc)) {
    units.push({
      key: 'skills',
      backupKey: 'skills-dir',
      srcPath: skillsDirSrc,
      targetPath: path.join(userData, 'skills'),
      isDirectory: true,
    });
  }
  fromMeta(
    'proactive',
    'userdata/proactive-nhpp.json',
    path.join(userData, 'proactive-nhpp.json'),
    false
  );
  fromMeta('sounds', 'userdata/custom-sounds', path.join(userData, 'custom-sounds'), true);
  fromMeta(
    'runtime',
    'userdata/character-runtime',
    path.join(userData, 'character-runtime'),
    true
  );
  units.push({
    key: 'master-key',
    backupKey: 'master-key',
    srcPath: path.join(userData, KEY_FILE_NAME),
    targetPath: path.join(userData, KEY_FILE_NAME),
    isDirectory: false,
    isMasterKey: true,
    masterKeyBuffer: masterKey,
  });
  return units;
}

interface BackupRecord {
  unit: RestoreUnit;
  backupPath: string;
  hadOld: boolean;
}

/**
 * 多源原子还原器：阶段 0 预检（零写入）→ 阶段 1 逐目标安全备份 →
 * 阶段 2 逐目标替换（含主密钥采纳）→ 全成功才提交删除备份；失败逆序回滚。
 */
export class AtomicRestorer {
  readonly units: RestoreUnit[];
  readonly tmpDir: string;
  private readonly failAt: number;
  private readonly backups: BackupRecord[] = [];
  private readonly replaced: RestoreUnit[] = [];
  private replaceCounter = 0;

  constructor(opts: { units: RestoreUnit[]; tmpDir: string; failAt?: number }) {
    this.units = opts.units;
    this.tmpDir = opts.tmpDir;
    this.failAt = opts.failAt || 0;
  }

  /** 阶段 0：逐项确认源可读且未越出临时目录（不产生任何写入）。 */
  plan(): void {
    for (const u of this.units) {
      if (u.isMasterKey) continue;
      // 清单里的 prefix 来自备份文件，必须限制在解包根目录内，杜绝 ../ 路径穿越
      const rel = path.relative(this.tmpDir, u.srcPath);
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
        throw makeError('E_BACKUP_FORMAT', `备份来源路径非法：${u.key}`);
      }
      if (!fs.existsSync(u.srcPath)) {
        throw makeError('E_BACKUP_FORMAT', `备份缺少来源：${u.key}（${u.srcPath}）`);
      }
    }
  }

  /** 阶段 1：存在则 cpSync 到 _restore_old_<ts>_<backupKey>。 */
  backupOlds(): void {
    for (const u of this.units) {
      const backupPath = path.join(this.tmpDir, '_old', u.backupKey);
      const hadOld = fs.existsSync(u.targetPath);
      if (hadOld) {
        fs.mkdirSync(path.dirname(backupPath), { recursive: true });
        fs.cpSync(u.targetPath, backupPath, { recursive: true });
      }
      this.backups.push({ unit: u, backupPath, hadOld });
    }
  }

  /** 阶段 2：逐目标替换；failAt 注入点在触碰目标之前抛出，保证可预测回滚。 */
  replaceAll(): void {
    for (const u of this.units) {
      this.replaceCounter++;
      if (this.failAt === this.replaceCounter) {
        throw makeError('E_RESTORE_FAILED', `注入失败：目标 ${u.backupKey}`);
      }
      // 先登记再动手：cpSync 中途失败也能被 rollback 覆盖
      this.replaced.push(u);
      if (u.isMasterKey) {
        const payload = JSON.stringify(
          {
            v: 1,
            alg: ALG,
            key: (u.masterKeyBuffer as Buffer).toString('base64'),
            created_at: new Date().toISOString(),
          },
          null,
          2
        );
        writeAtomic(u.targetPath, Buffer.from(payload, 'utf-8'));
      } else {
        fs.rmSync(u.targetPath, { recursive: true, force: true });
        fs.mkdirSync(path.dirname(u.targetPath), { recursive: true });
        fs.cpSync(u.srcPath, u.targetPath, { recursive: true });
      }
    }
  }

  /** 失败回滚：逆序还原已替换目标（原本不存在则删除），再清安全备份与临时目录。 */
  rollback(): void {
    for (const u of [...this.replaced].reverse()) {
      const rec = this.backups.find((b) => b.unit === u);
      try {
        fs.rmSync(u.targetPath, { recursive: true, force: true });
      } catch {
        /* 目标本就不存在时忽略 */
      }
      if (rec?.hadOld) {
        try {
          fs.cpSync(rec.backupPath, u.targetPath, { recursive: true });
        } catch {
          /* 回滚失败不覆盖原始错误，交由上层抛出 */
        }
      }
    }
    fs.rmSync(this.tmpDir, { recursive: true, force: true });
  }

  /** 阶段 3：全部成功 → 删除临时目录（内含全部 _old 安全备份）。 */
  commit(): void {
    fs.rmSync(this.tmpDir, { recursive: true, force: true });
  }

  execute(): void {
    this.plan();
    try {
      this.backupOlds();
      this.replaceAll();
      this.commit();
    } catch (e) {
      this.rollback();
      throw e;
    }
  }
}

/**
 * v2 全量原子还原。所有失败点（解封/解密/结构/源可读）都在替换前抛出，
 * 数据目录与 userData 一字节未动、不重启；重启由调用方（main.ts）在成功返回后执行。
 */
export function restorePortableBackup(opts: PortableRestoreOptions): void {
  const { backupPath, passphrase, dataDir, userData } = opts;
  const raw = fs.readFileSync(backupPath);
  if (detectBackupKind(raw) !== 'v2') {
    throw makeError('E_BACKUP_FORMAT', '不是 v2 可携带备份（v1 / 旧 zip 请走既有还原）');
  }
  const header = parseHeader(raw);
  if (raw.length !== HEADER_BYTES + header.payloadLen) {
    throw makeError('E_BACKUP_FORMAT', '容器总长度与载荷长度不符（可能被追加或截断）');
  }
  // —— 阶段 0：以下全部零写入 ——
  const masterKey = unwrapMasterKey(raw.subarray(0, HEADER_BYTES), passphrase);
  const plain = decryptBackup(raw.subarray(HEADER_BYTES), masterKey);
  const zip = new AdmZip(plain);
  const ts = Date.now();
  const parent = path.dirname(dataDir);
  const tmp = path.join(parent, `_restore_tmp_${ts}`);
  try {
    zip.extractAllTo(tmp, true);
    const metaEntry = zip.getEntry(META_NAME);
    if (!metaEntry) throw makeError('E_BACKUP_FORMAT', '备份缺少版本清单');
    const meta = JSON.parse(zip.readAsText(metaEntry)) as {
      format?: number;
      sources?: Array<{ key: string; prefix?: string }>;
    };
    if (meta.format !== undefined && meta.format !== FORMAT_VERSION) {
      throw makeError('E_BACKUP_FORMAT', '备份容器格式版本不符');
    }
    const metaSources = Array.isArray(meta.sources) ? meta.sources : [];
    const declared = new Set(metaSources.map((s) => s.key));
    const allowed = new Set(['data', 'skills', 'proactive', 'sounds', 'runtime']);
    if (!declared.has('data')) throw makeError('E_BACKUP_FORMAT', '清单缺少 data 源');
    for (const k of declared) {
      if (!allowed.has(k)) throw makeError('E_BACKUP_FORMAT', `清单含未知来源：${k}`);
    }
    if (
      !fs.existsSync(path.join(tmp, 'data', 'store.json')) &&
      !fs.existsSync(path.join(tmp, 'data', 'settings.json'))
    ) {
      throw makeError('E_ZIP_INVALID', '备份缺少 store.json / settings.json');
    }
    fs.rmSync(path.join(tmp, META_NAME), { force: true });
    const units = buildRestoreUnits(tmp, dataDir, userData, masterKey, metaSources);
    new AtomicRestorer({ units, tmpDir: tmp, failAt: opts.failAt }).execute();
    // 采纳备份机主密钥：清掉本进程缓存，确保 reloadAll 后读到新密钥
    resetKeyCache();
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
}

/** 服务门面：路径注入一次后，方法签名与架构类图一致。 */
export class PortableBackupService {
  constructor(
    readonly dataDir: string,
    readonly userData: string
  ) {}

  createPortableBackup(dest: string, appVersion: string, masterKey?: Buffer): PortableCreateResult {
    return createPortableBackup({
      dataDir: this.dataDir,
      userData: this.userData,
      dest,
      appVersion,
      masterKey,
    });
  }

  restorePortableBackup(backupPath: string, passphrase: string, failAt?: number): void {
    restorePortableBackup({
      backupPath,
      passphrase,
      dataDir: this.dataDir,
      userData: this.userData,
      failAt,
    });
  }

  peekBackupInfo(backupPath: string): BackupPeekInfo {
    return peekBackupInfo(backupPath);
  }

  collectFullStateSources(): BackupSource[] {
    return collectFullStateSources(this.dataDir, this.userData);
  }

  detectBackupKind(buf: Buffer): BackupKind {
    return detectBackupKind(buf);
  }
}
