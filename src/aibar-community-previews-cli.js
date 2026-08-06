#!/usr/bin/env node

import path from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
    options: {
        'data-root': { type: 'string' },
    },
});

globalThis.DATA_ROOT = path.resolve(values['data-root'] || path.join(process.cwd(), 'data'));

await import('./fetch-patch.js');
const [{ getCommunityDb }, { backfillCommunityCoverPreviews }] = await Promise.all([
    import('./aibar-community-db.js'),
    import('./aibar-community-previews.js'),
]);

try {
    const result = await backfillCommunityCoverPreviews({
        onProgress: ({ versionId, status, error }) => {
            if (status === 'failed') console.error(`[AIBAR previews] ${versionId}: ${error?.message || error}`);
        },
    });
    console.log(JSON.stringify(result));
    if (result.failed) process.exitCode = 1;
} finally {
    getCommunityDb().close();
}
