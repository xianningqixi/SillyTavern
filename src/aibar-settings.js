import fs from 'node:fs';

/**
 * 读取账号设置。展示时容忍历史空值，合并写入时拒绝损坏文件，保留原文供恢复。
 * @param {string} filePath 设置文件路径
 * @param {object} [options] 读取选项
 * @param {boolean} [options.strict] 是否拒绝损坏或非对象的设置
 * @returns {object} 设置对象
 */
export function readSettingsFile(filePath, { strict = false } = {}) {
    let raw;
    try {
        raw = fs.readFileSync(filePath, 'utf8');
    } catch (error) {
        if (error.code === 'ENOENT') return {};
        throw error;
    }
    try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
        // JSON 无效时与非对象格式一样处理，不把原始设置内容暴露给客户端。
    }
    if (strict) {
        const error = new Error('现有设置文件损坏，已保留原文件，请先恢复设置后再保存');
        error.statusCode = 409;
        throw error;
    }
    return {};
}
