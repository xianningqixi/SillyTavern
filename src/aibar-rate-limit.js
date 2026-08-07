import { RateLimiterMemory, RateLimiterRes } from 'rate-limiter-flexible';

import { retryAfter } from './express-common.js';

/**
 * 创建按登录用户（request.user.profile.handle）限流的 Express 中间件。
 * 超出限额时返回 429 和中文提示，不影响其他用户。
 * @param {object} options 限流配置
 * @param {number} options.points 时间窗口内允许的请求次数
 * @param {number} options.duration 时间窗口（秒）
 * @param {string} [options.message] 触发限流时返回的中文提示
 * @returns {import('express').RequestHandler} Express 中间件
 */
export function createUserRateLimiter({ points, duration, message = '操作过于频繁，请稍后再试' }) {
    const limiter = new RateLimiterMemory({ points, duration });
    return async function userRateLimit(request, response, next) {
        try {
            await limiter.consume(String(request.user?.profile?.handle || 'anonymous'));
            return next();
        } catch (error) {
            if (error instanceof RateLimiterRes) {
                return retryAfter(response, error).status(429).json({ error: message });
            }
            return next(error);
        }
    };
}
