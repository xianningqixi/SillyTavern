/**
 * 判断一个错误是否属于不应回显给客户端的内部错误：
 * 文件系统错误（会泄露绝对路径）、SQLite 错误、JSON.parse 等运行时错误。
 * 带有显式 statusCode/status（400-599）或 publicMessage 的错误视为刻意面向用户的提示。
 * @param {any} error 捕获到的错误
 * @returns {boolean} 是否为内部错误
 */
function isInternalError(error) {
    if (!error || typeof error !== 'object') return false;
    if (error.publicMessage) return false;
    const status = Number(error.statusCode ?? error.status);
    if (Number.isInteger(status) && status >= 400 && status <= 599) return false;
    const code = String(error.code || '');
    if (code.startsWith('SQLITE_')) return true;
    if (error.syscall || ['ENOENT', 'EACCES', 'EPERM', 'EEXIST', 'EISDIR', 'ENOTDIR', 'EMFILE', 'EBUSY', 'ENOSPC'].includes(code)) return true;
    if (error instanceof SyntaxError || error instanceof TypeError || error instanceof RangeError || error instanceof ReferenceError) return true;
    return false;
}

/**
 * 返回可以安全回显给客户端的错误文案。
 * 刻意抛出的校验错误（带 statusCode/status/publicMessage 或普通中文校验消息）原样返回；
 * 真正的内部错误（文件系统、SQLite、JSON.parse、上游异常）记录完整日志后只返回通用文案。
 * @param {any} error 捕获到的错误
 * @param {string} fallback 内部错误时返回的通用中文文案
 * @returns {string} 客户端可见的错误文案
 */
export function publicError(error, fallback) {
    if (error?.publicMessage) return String(error.publicMessage);
    if (!isInternalError(error) && error?.message) return String(error.message);
    console.error('AIBAR internal error hidden from client:', error);
    return String(fallback);
}
