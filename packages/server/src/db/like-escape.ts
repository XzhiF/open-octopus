/**
 * LIKE 通配符转义单源（aa-fix 票·Standards 收口：task-dao / wiki-article-dao /
 * assist-workflow-service 三处同口径实现收敛至此，配 SQL `ESCAPE '\'` 使用）。
 *
 * 口径逐字节与三处旧现场同形（等价性钉= db/__tests__/like-escape.test.ts）：
 * 对 `\` `%` `_` 三字符各自前置一个反斜杠，其余字节原样——先转义反斜杠本身
 * 的集合式替换保证用户串里的通配符不误命中、既有转义位不双花。
 */
export function escapeLikeParam(raw: string): string {
  return raw.replace(/[\\%_]/g, (ch) => `\\${ch}`)
}
