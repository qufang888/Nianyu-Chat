/**
 * v3.0.22 日记当前身份解析（只读纯函数，零浏览器 API / 零副作用）。
 *
 * 设置是身份的唯一真源：日记页只展示与绑定当前身份；currentSelfRoleId 无效时
 * 只在内存回落到第一个身份，绝不回写设置，也不触碰 chatSelfRoles 的按会话覆盖。
 */
import type { AppSettings } from '../types';

/** 主进程拒绝无效日记归属时的错误码（throw Error 的 code 属性）。 */
export const DIARY_ERROR_NO_SELF_ROLE = 'E_DIARY_NO_SELF_ROLE';
/** 内部兼容哨兵：只用于迁移/门控，不是任何 UI 文案或新建日记的回退目标。 */
export const DIARY_LEGACY_SENTINEL = 'none';

export interface DiaryIdentity {
  id: string;
  name: string;
}

/** 校验 id 是否属于有效身份列表（空串与内部哨兵一律无效）。 */
export function isValidDiarySelfRole(
  validIds: string[],
  id: string | null | undefined
): boolean {
  if (typeof id !== 'string' || id.length === 0 || id === DIARY_LEGACY_SENTINEL) return false;
  return (Array.isArray(validIds) ? validIds : []).includes(id);
}

/** 迁移 / 新建目标：优先当前身份，无效则内存回落第一个身份；无身份返回 null。 */
export function resolveDiaryTargetSelfRole(
  validIds: string[],
  preferred?: string | null
): string | null {
  const valid = (Array.isArray(validIds) ? validIds : [])
    .filter((x): x is string => typeof x === 'string' && x.length > 0 && x !== DIARY_LEGACY_SENTINEL);
  if (isValidDiarySelfRole(valid, preferred)) return String(preferred);
  return valid[0] || null;
}

/** 日记页顶部展示身份：只读 settings，无身份返回 null；不写设置，不影响按会话覆盖。 */
export function resolveDiaryIdentity(
  settings: Pick<AppSettings, 'selfRoles' | 'currentSelfRoleId'>
): DiaryIdentity | null {
  const roles = Array.isArray(settings?.selfRoles) ? settings.selfRoles : [];
  if (roles.length === 0) return null;
  const id = resolveDiaryTargetSelfRole(
    roles.map((r) => r.id),
    settings?.currentSelfRoleId
  );
  const role = roles.find((r) => r.id === id);
  return role ? { id: role.id, name: role.name } : null;
}
