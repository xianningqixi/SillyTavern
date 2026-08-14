import { requireAdminMiddleware } from './users.js';
import { legacyProviderGuard, sharedModelGuard } from './endpoints/aibar-models.js';

/**
 * AIBAR 对上游路由的权限收紧统一在这里预挂载。Express 对同一路径的中间件按注册
 * 顺序执行，所以只要本函数在上游 router 挂载之前调用，guard 一定先运行。
 *
 * 之前这些 guard 逐行写在 server-startup.js 的上游挂载行里，上游每次调整该区域
 * 都可能"自动合并成功但 guard 被静默丢掉"，造成权限回归。收敛到这里之后，
 * server-startup.js 的上游挂载行保持原样，合并冲突面只剩一行函数调用。
 * 上游新增 provider 路由时，在 AIBAR_LEGACY_PROVIDER_ROUTES 里补一条即可。
 */
export const AIBAR_LEGACY_PROVIDER_ROUTES = Object.freeze([
    '/api/novelai',
    '/api/sd',
    '/api/horde',
    '/api/translate',
    '/api/search',
    '/api/backends/text-completions',
    '/api/openrouter',
    '/api/nanogpt',
    '/api/backends/kobold',
    '/api/speech',
    '/api/azure',
    '/api/volcengine',
    '/api/minimax',
]);

/**
 * @param {import('express').Express} app The Express app to use
 */
export function applyAibarProviderGuards(app) {
    // 密钥管理只允许管理员使用：普通用户走共享模型，不需要接触任何 API Key。
    app.use('/api/secrets', requireAdminMiddleware);
    // 普通用户不允许直连各 provider 路由，避免绕过共享模型的凭据与计费。
    for (const route of AIBAR_LEGACY_PROVIDER_ROUTES) {
        app.use(route, legacyProviderGuard);
    }
    // 普通用户的 /generate、/status 必须走 /api/aibar/models/*，由服务端选择凭据并计费。
    app.use('/api/backends/chat-completions', sharedModelGuard);
}
