import { DOMPurify, showdown } from '../lib.js';

const markdownConverter = new showdown.Converter({
    literalMidWordUnderscores: true,
    simpleLineBreaks: true,
    strikethrough: true,
    tables: true,
});

const app = document.getElementById('simple-app');
const listEl = document.getElementById('character-list');
const detailEl = document.getElementById('character-detail');
const statusEl = document.getElementById('simple-status');
const searchInput = document.getElementById('search-input');
const sortSelect = document.getElementById('sort-select');
const tagStrip = document.getElementById('tag-strip');
const emptyTemplate = document.getElementById('empty-template');
const imageToggle = document.getElementById('image-toggle');
const backButton = document.getElementById('back-button');
const randomButton = document.getElementById('random-button');
const modButton = document.getElementById('mod-button');
const worldBookButton = document.getElementById('worldbook-button');
const createStoryButton = document.getElementById('create-story-button');
const createCharacterButton = document.getElementById('create-character-button');
const modelSettingsButton = document.getElementById('model-settings-button');
const viewTitle = document.getElementById('view-title');
const viewKicker = document.getElementById('view-kicker');

const providerConfigs = {
    custom: { label: 'OpenAI 兼容 / 本地', secretKey: 'api_key_custom', modelKey: 'custom_model', endpointKey: 'custom_url', defaultModel: 'llama3.1', defaultEndpoint: 'http://127.0.0.1:11434/v1' },
    openai: { label: 'OpenAI 官方', secretKey: 'api_key_openai', modelKey: 'openai_model', endpointKey: 'reverse_proxy', defaultModel: 'gpt-4o-mini' },
    openrouter: { label: 'OpenRouter', secretKey: 'api_key_openrouter', modelKey: 'openrouter_model', defaultModel: 'openai/gpt-4o-mini' },
    claude: { label: 'Claude / Anthropic', secretKey: 'api_key_claude', modelKey: 'claude_model', endpointKey: 'reverse_proxy', defaultModel: 'claude-sonnet-4-5' },
    makersuite: { label: 'Gemini / Google AI Studio', secretKey: 'api_key_makersuite', modelKey: 'google_model', endpointKey: 'reverse_proxy', defaultModel: 'gemini-2.5-pro' },
    deepseek: { label: 'DeepSeek', secretKey: 'api_key_deepseek', modelKey: 'deepseek_model', endpointKey: 'reverse_proxy', defaultModel: 'deepseek-v4-flash' },
    mistralai: { label: 'MistralAI', secretKey: 'api_key_mistralai', modelKey: 'mistralai_model', endpointKey: 'reverse_proxy', defaultModel: 'mistral-large-latest' },
    groq: { label: 'Groq', secretKey: 'api_key_groq', modelKey: 'groq_model', defaultModel: 'llama-3.3-70b-versatile' },
    xai: { label: 'xAI / Grok', secretKey: 'api_key_xai', modelKey: 'xai_model', endpointKey: 'reverse_proxy', defaultModel: 'grok-3-beta' },
    moonshot: { label: 'Moonshot / Kimi', secretKey: 'api_key_moonshot', modelKey: 'moonshot_model', endpointKey: 'reverse_proxy', defaultModel: 'kimi-latest' },
    siliconflow: { label: 'SiliconFlow', secretKey: 'api_key_siliconflow', modelKey: 'siliconflow_model', defaultModel: 'deepseek-ai/DeepSeek-V3' },
    cohere: { label: 'Cohere', secretKey: 'api_key_cohere', modelKey: 'cohere_model', defaultModel: 'command-r-plus' },
    perplexity: { label: 'Perplexity', secretKey: 'api_key_perplexity', modelKey: 'perplexity_model', defaultModel: 'sonar-pro' },
    chutes: { label: 'Chutes', secretKey: 'api_key_chutes', modelKey: 'chutes_model', defaultModel: 'deepseek-ai/DeepSeek-V3-0324' },
    nanogpt: { label: 'NanoGPT', secretKey: 'api_key_nanogpt', modelKey: 'nanogpt_model', defaultModel: 'gpt-4o-mini' },
    aimlapi: { label: 'AI/ML API', secretKey: 'api_key_aimlapi', modelKey: 'aimlapi_model', defaultModel: 'chatgpt-4o-latest' },
    fireworks: { label: 'Fireworks AI', secretKey: 'api_key_fireworks', modelKey: 'fireworks_model', defaultModel: 'accounts/fireworks/models/kimi-k2-instruct' },
    zai: { label: 'Z.AI', secretKey: 'api_key_zai', modelKey: 'zai_model', endpointKey: 'reverse_proxy', defaultModel: 'glm-4.6' },
    pollinations: { label: 'Pollinations', secretKey: 'api_key_pollinations', modelKey: 'pollinations_model', defaultModel: 'openai' },
};

const tabLabels = {
    characters: {
        all: '全部',
        recent: '最近',
        favorite: '收藏',
        withChats: '有聊天',
    },
    stories: {
        all: '全部',
        recent: '最近',
        favorite: '角色故事',
        withChats: '群组',
    },
};

const sortOptions = {
    characters: [
        ['recent', '最近聊天'],
        ['added', '最近添加'],
        ['name', '名称'],
        ['size', '聊天最多'],
    ],
    stories: [
        ['recent', '最近更新'],
        ['name', '名称'],
        ['size', '消息最多'],
        ['added', '文件大小'],
    ],
};

const state = {
    token: '',
    settings: null,
    characters: [],
    groups: [],
    stories: [],
    worldBooks: [],
    selectedId: null,
    selectedStoryKey: '',
    mode: 'stories',
    page: 'browse',
    route: {},
    chatTarget: null,
    chatMessages: [],
    chatMetadata: {},
    chatLoaded: false,
    tab: 'all',
    tag: '',
    query: '',
    sort: 'recent',
    view: localStorage.getItem('simpleViewMode') || 'simple',
    messageLoadKey: '',
    modelNotice: null,
    modNotice: null,
    editingModId: '',
    editingModelProfileId: '',
    selectedWorldBook: '',
    editingWorldEntryUid: null,
    worldNotice: null,
};

app.dataset.view = state.view;

function syncViewMode() {
    const isNoImage = state.view === 'no-image';
    app.dataset.view = state.view;
    imageToggle.classList.toggle('is-active', isNoImage);
    imageToggle.querySelector('span').textContent = isNoImage ? '有图' : '无图';
}

function setStatus(message, tone = '') {
    statusEl.textContent = message;
    statusEl.dataset.tone = tone;
}

function setModelNotice(message, tone = '', detail = '') {
    state.modelNotice = {
        message,
        tone,
        detail,
        time: new Intl.DateTimeFormat('zh-CN', {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
        }).format(new Date()),
    };
    setStatus(message, tone);
}

function setModNotice(message, tone = '', detail = '') {
    state.modNotice = {
        message,
        tone,
        detail,
    };
    setStatus(message, tone);
}

function setWorldNotice(message, tone = '', detail = '') {
    state.worldNotice = {
        message,
        tone,
        detail,
    };
    setStatus(message, tone);
}

function getRequestHeaders() {
    return {
        'Content-Type': 'application/json',
        'X-CSRF-Token': state.token,
    };
}

async function apiPost(url, body = {}) {
    const response = await fetch(url, {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify(body),
    });

    if (!response.ok) {
        throw new Error(`${url} failed with ${response.status}`);
    }

    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
        return response.json();
    }

    const text = await response.text();
    return text ? { ok: true, text } : { ok: true };
}

async function apiPostText(url, body = {}) {
    const response = await fetch(url, {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify(body),
    });

    if (!response.ok) {
        throw new Error(`${url} failed with ${response.status}`);
    }

    return response.text();
}

async function apiPostBlob(url, body = {}) {
    const response = await fetch(url, {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify(body),
    });

    if (!response.ok) {
        throw new Error(`${url} failed with ${response.status}`);
    }

    return response.blob();
}

async function apiUpload(url, formData) {
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'X-CSRF-Token': state.token,
        },
        body: formData,
        cache: 'no-cache',
    });

    if (!response.ok) {
        throw new Error(`${url} failed with ${response.status}`);
    }

    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
        return response.json();
    }

    return response.text();
}

function downloadFile(content, fileName, contentType = 'application/octet-stream') {
    const anchor = document.createElement('a');
    const blob = content instanceof Blob ? content : new Blob([content], { type: contentType });
    anchor.href = URL.createObjectURL(blob);
    anchor.download = fileName;
    document.body.append(anchor);
    anchor.click();
    URL.revokeObjectURL(anchor.href);
    anchor.remove();
}

function normalizeText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeMessageText(value) {
    return String(value || '')
        .replace(/\r\n/g, '\n')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{4,}/g, '\n\n\n')
        .trim();
}

function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function ensureJsonlName(value) {
    const name = normalizeText(value);
    return name.toLowerCase().endsWith('.jsonl') ? name : `${name}.jsonl`;
}

function stripJsonlName(value) {
    return normalizeText(value).replace(/\.jsonl$/i, '');
}

function stripSpeakerPrefix(text, speakerName) {
    const content = normalizeMessageText(text);
    const name = normalizeText(speakerName);
    if (!name) {
        return content;
    }

    const escapedName = escapeRegExp(name);
    return content
        .replace(new RegExp(`^\\s*\\*\\*${escapedName}\\*\\*\\s*[:：\\-—]?\\s*`, 'i'), '')
        .replace(new RegExp(`^\\s*${escapedName}\\s*[:：]\\s*`, 'i'), '')
        .trim();
}

function renderMessageContent(element, content, speakerName = '') {
    const displayText = stripSpeakerPrefix(content, speakerName);
    const html = markdownConverter.makeHtml(displayText);
    element.innerHTML = DOMPurify.sanitize(html, {
        RETURN_DOM: false,
        RETURN_DOM_FRAGMENT: false,
        RETURN_TRUSTED_TYPE: false,
        FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed', 'img', 'video', 'audio'],
        FORBID_ATTR: ['style', 'onerror', 'onclick', 'onload'],
    });
}

function getCharacterTags(character) {
    const primaryTags = Array.isArray(character.tags) ? character.tags : [];
    const dataTags = Array.isArray(character.data?.tags) ? character.data.tags : [];
    return [...new Set([...primaryTags, ...dataTags].map(normalizeText).filter(Boolean))];
}

function getDescription(character) {
    return normalizeText(character.description || character.data?.description || character.data?.creator_notes || character.creatorcomment || '');
}

function getCreator(character) {
    return normalizeText(character.data?.creator || character.creator || '');
}

function getAvatarUrl(character) {
    if (!character?.avatar || character.avatar === 'none') {
        return 'img/ai4.png';
    }

    return `/thumbnail?type=avatar&file=${encodeURIComponent(character.avatar)}`;
}

function getGroupAvatarUrl(group) {
    if (!group?.avatar_url || group.avatar_url === 'none') {
        return 'img/five.png';
    }

    if (/^https?:\/\//i.test(group.avatar_url)) {
        return group.avatar_url;
    }

    return `/thumbnail?type=avatar&file=${encodeURIComponent(group.avatar_url)}`;
}

function getTimestamp(value) {
    if (!value) {
        return 0;
    }

    const number = Number(value);
    if (Number.isFinite(number) && number > 0) {
        return number;
    }

    const parsed = Date.parse(String(value));
    return Number.isFinite(parsed) ? parsed : 0;
}

function formatDate(value) {
    const timestamp = getTimestamp(value);
    if (!timestamp) {
        return '未开始';
    }

    return new Intl.DateTimeFormat('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
    }).format(new Date(timestamp));
}

function formatSize(value) {
    if (typeof value === 'string' && /[a-z]/i.test(value)) {
        return value;
    }

    const bytes = Number(value || 0);
    if (!bytes) {
        return '0 KB';
    }

    if (bytes < 1024 * 1024) {
        return `${Math.max(1, Math.round(bytes / 1024))} KB`;
    }

    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function createMetaPill(text) {
    const span = document.createElement('span');
    span.textContent = text;
    return span;
}

function createIcon(name) {
    const icon = document.createElement('i');
    icon.className = `fa-solid ${name}`;
    return icon;
}

function createButton(label, icon, className = '') {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    if (icon) {
        button.append(createIcon(icon));
    }
    const span = document.createElement('span');
    span.textContent = label;
    button.append(span);
    return button;
}

function createNotice(message, tone = '', detail = '') {
    const notice = document.createElement('div');
    notice.className = 'simple-form-notice';
    notice.dataset.tone = tone;
    notice.setAttribute('role', 'status');
    notice.setAttribute('aria-live', 'polite');

    const title = document.createElement('strong');
    title.textContent = message;
    const meta = document.createElement('span');
    meta.textContent = detail;
    notice.append(title);
    if (detail) {
        notice.append(meta);
    }
    return notice;
}

function updateNotice(container, message, tone = '', detail = '') {
    container.replaceChildren(createNotice(message, tone, detail));
}

function isFavorite(character) {
    return Boolean(character.fav || character.data?.extensions?.fav);
}

function getCharacterByAvatar(avatar) {
    return state.characters.find(character => character.avatar === avatar);
}

function getGroupById(id) {
    return state.groups.find(group => String(group.id) === String(id));
}

function getStoryKey(story) {
    return story.group ? `group:${story.group}:${story.file_id}` : `character:${story.avatar}:${story.file_id}`;
}

function getStoryTitle(story) {
    return normalizeText(story.chat_metadata?.name || story.file_id || story.file_name?.replace(/\.jsonl$/i, '') || '未命名故事');
}

function getStoryOwner(story) {
    if (story.group) {
        return getGroupById(story.group)?.name || '群组故事';
    }

    return getCharacterByAvatar(story.avatar)?.name || story.avatar || '未知角色';
}

function getStoryDescription(story) {
    return normalizeText(story.chat_metadata?.description || story.mes || story.preview_message || '这个故事还没有消息。');
}

function getWorldBookName(book) {
    return normalizeText(book?.name || book?.file_id || '');
}

function getWorldBookNames() {
    return [...new Set(state.worldBooks.map(getWorldBookName).filter(Boolean))];
}

function getCharacterWorldBookName(character) {
    return normalizeText(character?.data?.extensions?.world || character?.extensions?.world || '');
}

function getStoryWorldBookName(story) {
    return normalizeText(story?.chat_metadata?.world_info || '');
}

function getStoryTags(story) {
    const metadataTags = Array.isArray(story.chat_metadata?.tags) ? story.chat_metadata.tags : [];
    const worldBook = getStoryWorldBookName(story);
    const worldTag = worldBook ? [`世界书 ${worldBook}`] : [];
    if (story.group) {
        return [...new Set(['群组', ...worldTag, ...metadataTags.map(normalizeText).filter(Boolean)])];
    }

    return [...new Set([
        ...worldTag,
        ...metadataTags.map(normalizeText).filter(Boolean),
        ...getCharacterTags(getCharacterByAvatar(story.avatar) || {}).slice(0, 8),
    ])];
}

function getStoryAvatarUrl(story) {
    if (story.group) {
        return getGroupAvatarUrl(getGroupById(story.group));
    }

    return getAvatarUrl(getCharacterByAvatar(story.avatar) || { avatar: story.avatar });
}

function getModeItems() {
    return state.mode === 'stories' ? state.stories : state.characters;
}

function getItemTags(item) {
    return state.mode === 'stories' ? getStoryTags(item) : getCharacterTags(item);
}

function getItemSearchText(item) {
    if (state.mode === 'stories') {
        return [
            getStoryTitle(item),
            getStoryOwner(item),
            getStoryDescription(item),
            item.file_name,
            ...getStoryTags(item),
        ].join(' ');
    }

    return [
        item.name,
        getCreator(item),
        getDescription(item),
        item.avatar,
        ...getCharacterTags(item),
    ].join(' ');
}

function getFilteredItems() {
    const query = state.query.toLowerCase();

    return getModeItems()
        .filter((item) => {
            if (state.mode === 'characters') {
                if (state.tab === 'recent') {
                    return Number(item.date_last_chat || 0) > 0;
                }
                if (state.tab === 'favorite') {
                    return isFavorite(item);
                }
                if (state.tab === 'withChats') {
                    return Number(item.chat_size || 0) > 0;
                }
                return true;
            }

            if (state.tab === 'recent') {
                const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
                return getTimestamp(item.last_mes) >= weekAgo;
            }
            if (state.tab === 'favorite') {
                return !item.group;
            }
            if (state.tab === 'withChats') {
                return Boolean(item.group);
            }
            return true;
        })
        .filter((item) => {
            if (!state.tag) {
                return true;
            }
            return getItemTags(item).includes(state.tag);
        })
        .filter((item) => {
            if (!query) {
                return true;
            }
            return getItemSearchText(item).toLowerCase().includes(query);
        })
        .sort((a, b) => {
            if (state.mode === 'stories') {
                switch (state.sort) {
                    case 'name':
                        return getStoryTitle(a).localeCompare(getStoryTitle(b), 'zh-CN');
                    case 'size':
                        return Number(b.chat_items || 0) - Number(a.chat_items || 0);
                    case 'added':
                        return Number.parseFloat(String(b.file_size || 0)) - Number.parseFloat(String(a.file_size || 0));
                    case 'recent':
                    default:
                        return getTimestamp(b.last_mes) - getTimestamp(a.last_mes);
                }
            }

            switch (state.sort) {
                case 'added':
                    return Number(b.date_added || 0) - Number(a.date_added || 0);
                case 'name':
                    return String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN');
                case 'size':
                    return Number(b.chat_size || 0) - Number(a.chat_size || 0);
                case 'recent':
                default:
                    return Number(b.date_last_chat || 0) - Number(a.date_last_chat || 0);
            }
        });
}

function renderMetrics() {
    const total = document.getElementById('metric-total');
    const chats = document.getElementById('metric-chats');
    const favs = document.getElementById('metric-favs');
    const totalLabel = document.getElementById('metric-total-label');
    const chatsLabel = document.getElementById('metric-chats-label');
    const favsLabel = document.getElementById('metric-favs-label');

    if (state.mode === 'stories') {
        total.textContent = state.stories.length;
        chats.textContent = state.stories.reduce((sum, story) => sum + Number(story.chat_items || 0), 0);
        favs.textContent = state.stories.filter(story => !story.group).length;
        totalLabel.textContent = '故事';
        chatsLabel.textContent = '消息';
        favsLabel.textContent = '角色故事';
        return;
    }

    total.textContent = state.characters.length;
    chats.textContent = state.characters.filter(x => Number(x.chat_size || 0) > 0).length;
    favs.textContent = state.characters.filter(isFavorite).length;
    totalLabel.textContent = '角色';
    chatsLabel.textContent = '有聊天';
    favsLabel.textContent = '收藏';
}

function renderTags() {
    const counts = new Map();
    for (const item of getModeItems()) {
        for (const tag of getItemTags(item)) {
            counts.set(tag, (counts.get(tag) || 0) + 1);
        }
    }

    const popularTags = [...counts.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-CN'))
        .slice(0, 18);

    tagStrip.replaceChildren();

    if (!popularTags.length) {
        return;
    }

    const clearButton = document.createElement('button');
    clearButton.className = `simple-tag${state.tag ? '' : ' is-active'}`;
    clearButton.type = 'button';
    clearButton.textContent = '全部标签';
    clearButton.addEventListener('click', () => {
        state.tag = '';
        render();
    });
    tagStrip.append(clearButton);

    for (const [tag, count] of popularTags) {
        const button = document.createElement('button');
        button.className = `simple-tag${state.tag === tag ? ' is-active' : ''}`;
        button.type = 'button';
        button.textContent = `${tag} ${count}`;
        button.addEventListener('click', () => {
            state.tag = state.tag === tag ? '' : tag;
            render();
        });
        tagStrip.append(button);
    }
}

function createCharacterCard(character, index) {
    const card = document.createElement('article');
    card.className = `simple-card${state.selectedId === index ? ' is-selected' : ''}`;
    card.tabIndex = 0;

    const thumb = document.createElement('div');
    thumb.className = 'simple-thumb';
    const img = document.createElement('img');
    img.src = getAvatarUrl(character);
    img.alt = character.name || 'Character';
    img.loading = 'lazy';
    thumb.append(img);

    const info = document.createElement('div');
    info.className = 'simple-info';

    const title = document.createElement('h2');
    title.className = 'simple-title';
    title.textContent = character.name || character.avatar || '未命名角色';

    const desc = document.createElement('p');
    desc.className = 'simple-desc';
    desc.textContent = getDescription(character) || '这个角色还没有简介。';

    const meta = document.createElement('div');
    meta.className = 'simple-meta';
    const creator = getCreator(character);
    meta.append(createMetaPill(creator ? `作者 ${creator}` : '本地角色'));
    meta.append(createMetaPill(`最近 ${formatDate(character.date_last_chat)}`));
    meta.append(createMetaPill(`聊天 ${formatSize(character.chat_size)}`));
    if (isFavorite(character)) {
        meta.append(createMetaPill('收藏'));
    }

    const tags = document.createElement('div');
    tags.className = 'simple-card-tags';
    getCharacterTags(character).slice(0, 5).forEach(tag => tags.append(createMetaPill(tag)));

    info.append(title, desc, meta, tags);

    const actions = document.createElement('div');
    actions.className = 'simple-card-actions';
    const chatButton = document.createElement('button');
    chatButton.className = 'simple-open';
    chatButton.type = 'button';
    chatButton.textContent = '互动';
    chatButton.addEventListener('click', (event) => {
        event.stopPropagation();
        openChatPage(character);
    });
    const openButton = document.createElement('button');
    openButton.className = 'simple-card-secondary';
    openButton.type = 'button';
    openButton.textContent = '详情';
    openButton.addEventListener('click', (event) => {
        event.stopPropagation();
        openCharacterDetail(character);
    });
    actions.append(chatButton, openButton);

    card.append(thumb, info, actions);
    card.addEventListener('click', () => openCharacterDetail(character));
    card.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            openCharacterDetail(character);
        }
    });

    return card;
}

function createStoryCard(story) {
    const key = getStoryKey(story);
    const card = document.createElement('article');
    card.className = `simple-card${state.selectedStoryKey === key ? ' is-selected' : ''}`;
    card.tabIndex = 0;

    const thumb = document.createElement('div');
    thumb.className = 'simple-thumb';
    const img = document.createElement('img');
    img.src = getStoryAvatarUrl(story);
    img.alt = getStoryOwner(story);
    img.loading = 'lazy';
    thumb.append(img);

    const info = document.createElement('div');
    info.className = 'simple-info';

    const title = document.createElement('h2');
    title.className = 'simple-title';
    title.textContent = getStoryTitle(story);

    const desc = document.createElement('p');
    desc.className = 'simple-desc';
    desc.textContent = getStoryDescription(story);

    const meta = document.createElement('div');
    meta.className = 'simple-meta';
    meta.append(createMetaPill(getStoryOwner(story)));
    meta.append(createMetaPill(`更新 ${formatDate(story.last_mes)}`));
    meta.append(createMetaPill(`${Number(story.chat_items || 0)} 条消息`));
    meta.append(createMetaPill(formatSize(story.file_size)));

    const tags = document.createElement('div');
    tags.className = 'simple-card-tags';
    getStoryTags(story).slice(0, 5).forEach(tag => tags.append(createMetaPill(tag)));

    info.append(title, desc, meta, tags);

    const actions = document.createElement('div');
    actions.className = 'simple-card-actions';
    const openButton = document.createElement('button');
    openButton.className = 'simple-open';
    openButton.type = 'button';
    openButton.textContent = '详情';
    openButton.addEventListener('click', (event) => {
        event.stopPropagation();
        openStoryDetail(story);
    });
    actions.append(openButton);

    card.append(thumb, info, actions);
    card.addEventListener('click', () => openStoryDetail(story));
    card.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            openStoryDetail(story);
        }
    });

    return card;
}

function renderList() {
    const items = getFilteredItems();
    listEl.replaceChildren();

    if (!items.length) {
        listEl.append(emptyTemplate.content.cloneNode(true));
        return;
    }

    const fragment = document.createDocumentFragment();
    if (state.mode === 'stories') {
        items.forEach(story => fragment.append(createStoryCard(story)));
    } else {
        items.forEach(character => {
            const index = state.characters.indexOf(character);
            fragment.append(createCharacterCard(character, index));
        });
    }
    listEl.append(fragment);

    if (state.mode === 'stories') {
        if (!items.some(story => getStoryKey(story) === state.selectedStoryKey)) {
            state.selectedStoryKey = getStoryKey(items[0]);
        }
    } else if (state.selectedId === null || !items.includes(state.characters[state.selectedId])) {
        state.selectedId = state.characters.indexOf(items[0]);
    }
}

function appendDetailActions(container, primaryLabel, onPrimary, extraActions = []) {
    const actions = document.createElement('div');
    actions.className = 'simple-detail-actions';
    const primary = createButton(primaryLabel, 'fa-check', '');
    primary.addEventListener('click', onPrimary);

    actions.append(primary);
    for (const action of extraActions) {
        const button = createButton(action.label, action.icon || 'fa-circle-dot', action.className || '');
        button.addEventListener('click', action.onClick);
        actions.append(button);
    }
    container.append(actions);
}

function renderCharacterSummary(character) {
    const hero = document.createElement('div');
    hero.className = 'simple-detail-hero';
    const img = document.createElement('img');
    img.src = getAvatarUrl(character);
    img.alt = character.name || 'Character';
    const headingBox = document.createElement('div');
    const heading = document.createElement('h2');
    heading.textContent = character.name || '未命名角色';
    const meta = document.createElement('div');
    meta.className = 'simple-meta';
    meta.append(createMetaPill(`最近 ${formatDate(character.date_last_chat)}`));
    meta.append(createMetaPill(`聊天 ${formatSize(character.chat_size)}`));
    const worldBook = getCharacterWorldBookName(character);
    if (worldBook) {
        meta.append(createMetaPill(`世界书 ${worldBook}`));
    }
    headingBox.append(heading, meta);
    hero.append(img, headingBox);
    return hero;
}

function renderStorySummary(story) {
    const hero = document.createElement('div');
    hero.className = 'simple-detail-hero';
    const img = document.createElement('img');
    img.src = getStoryAvatarUrl(story);
    img.alt = getStoryOwner(story);
    const headingBox = document.createElement('div');
    const heading = document.createElement('h2');
    heading.textContent = getStoryTitle(story);
    const meta = document.createElement('div');
    meta.className = 'simple-meta';
    meta.append(createMetaPill(getStoryOwner(story)));
    meta.append(createMetaPill(`${Number(story.chat_items || 0)} 条消息`));
    const worldBook = getStoryWorldBookName(story);
    if (worldBook) {
        meta.append(createMetaPill(`世界书 ${worldBook}`));
    }
    headingBox.append(heading, meta);
    hero.append(img, headingBox);
    return hero;
}

function renderDetail() {
    detailEl.className = 'simple-detail';
    detailEl.replaceChildren();

    if (state.mode === 'stories') {
        const story = state.stories.find(item => getStoryKey(item) === state.selectedStoryKey);
        if (!story) {
            const empty = document.createElement('div');
            empty.className = 'simple-detail-empty';
            empty.textContent = '选择一个故事查看消息预览和快捷操作。';
            detailEl.append(empty);
            return;
        }

        const desc = document.createElement('p');
        desc.textContent = getStoryDescription(story);
        const tags = document.createElement('div');
        tags.className = 'simple-card-tags';
        getStoryTags(story).forEach(tag => tags.append(createMetaPill(tag)));
        appendDetailActions(detailEl, '设为当前故事', () => activateStory(story), story.group ? [] : [{
            label: '继续互动',
            icon: 'fa-comments',
            onClick: () => openChatPage(getCharacterByAvatar(story.avatar), story),
        }]);
        detailEl.prepend(renderStorySummary(story), desc, tags);
        return;
    }

    const character = state.characters[state.selectedId];
    if (!character) {
        const empty = document.createElement('div');
        empty.className = 'simple-detail-empty';
        const text = document.createElement('p');
        text.textContent = '选择一个角色查看简介、标签和快捷操作。';
        const importButton = createButton('导入角色卡', 'fa-file-import', '');
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json,.png,.yaml,.yml,.charx,.byaf';
        input.multiple = true;
        input.hidden = true;
        importButton.addEventListener('click', () => input.click());
        input.addEventListener('change', async () => {
            try {
                await importCharacterCards([...input.files]);
            } catch (error) {
                console.error(error);
                setStatus(`角色导入失败：${error.message || '未知错误'}`, 'error');
            } finally {
                input.value = '';
            }
        });
        empty.append(text, importButton, input);
        detailEl.append(empty);
        return;
    }

    const desc = document.createElement('p');
    desc.textContent = getDescription(character) || '这个角色还没有简介。';
    const tags = document.createElement('div');
    tags.className = 'simple-card-tags';
    getCharacterTags(character).forEach(tag => tags.append(createMetaPill(tag)));
    appendDetailActions(detailEl, '开始互动', () => openChatPage(character), [{
        label: '设为当前角色',
        icon: 'fa-check',
        onClick: () => activateCharacter(character),
    }]);
    detailEl.prepend(renderCharacterSummary(character), desc, tags);
}

function renderTabButtons() {
    const labels = tabLabels[state.mode];
    document.querySelectorAll('.simple-nav [data-tab], .simple-tabs [data-tab]').forEach((button) => {
        const label = labels[button.dataset.tab];
        if (label) {
            const span = button.querySelector('span');
            if (span) {
                span.textContent = label;
            } else {
                button.textContent = label;
            }
        }
    });
    document.querySelectorAll('.simple-tabs [data-tab]').forEach((button) => {
        button.classList.toggle('is-active', state.page === 'browse' && button.dataset.tab === state.tab);
    });
    renderSidebarState();
}

function renderSidebarState() {
    const isBrowse = state.page === 'browse';
    const isSettings = state.route?.type === 'settings';
    const isWorldBooks = state.route?.type === 'worldbooks';
    const isMods = state.route?.type === 'mods';
    document.querySelectorAll('.simple-nav [data-tab]').forEach((button) => {
        button.classList.toggle('is-active', isBrowse && button.dataset.tab === state.tab);
    });
    modelSettingsButton.classList.toggle('is-active', isSettings);
    worldBookButton.classList.toggle('is-active', isWorldBooks);
    modButton.classList.toggle('is-active', isMods);
}

function renderModeButtons() {
    document.querySelectorAll('[data-mode]').forEach((button) => {
        button.classList.toggle('is-active', button.dataset.mode === state.mode);
    });
}

function renderSortOptions() {
    const current = sortOptions[state.mode];
    sortSelect.replaceChildren(...current.map(([value, label]) => {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = label;
        return option;
    }));

    if (!current.some(([value]) => value === state.sort)) {
        state.sort = current[0][0];
    }
    sortSelect.value = state.sort;
}

function renderBrowse() {
    app.dataset.page = 'browse';
    listEl.className = 'simple-list';
    detailEl.className = 'simple-detail';
    viewKicker.textContent = state.mode === 'stories' ? '本地故事库' : '本地角色库';
    viewTitle.textContent = state.mode === 'stories' ? '故事卡' : '角色卡';
    searchInput.placeholder = state.mode === 'stories' ? '搜索故事、角色、标签、最后消息' : '搜索角色、作者、标签、简介';
    backButton.hidden = true;
    randomButton.hidden = false;
    renderModeButtons();
    renderSortOptions();
    renderTabButtons();
    renderMetrics();
    renderTags();
    renderList();
    renderDetail();
    const count = getFilteredItems().length;
    setStatus(`当前筛选 ${count} 个${state.mode === 'stories' ? '故事' : '角色'}`);
}

function createSection(title, body) {
    const section = document.createElement('section');
    section.className = 'simple-detail-section';
    const heading = document.createElement('h3');
    heading.textContent = title;
    section.append(heading, body);
    return section;
}

function createTextBlock(text) {
    const block = document.createElement('p');
    block.textContent = text || '暂无内容。';
    return block;
}

function createFullMeta(items) {
    const meta = document.createElement('div');
    meta.className = 'simple-meta simple-full-meta';
    items.filter(Boolean).forEach(item => meta.append(createMetaPill(item)));
    return meta;
}

function getModelSettings() {
    const oai = state.settings?.oai_settings || {};
    const source = Object.hasOwn(providerConfigs, oai.chat_completion_source)
        ? oai.chat_completion_source
        : 'custom';
    const config = providerConfigs[source];
    const model = oai[config.modelKey];

    return {
        source,
        endpoint: config.endpointKey ? oai[config.endpointKey] || config.defaultEndpoint || '' : '',
        model: model || config.defaultModel,
        temperature: Number.isFinite(Number(oai.temp_openai)) ? Number(oai.temp_openai) : 0.7,
        maxTokens: Number.isFinite(Number(oai.openai_max_tokens)) ? Number(oai.openai_max_tokens) : 512,
    };
}

function createModelProfileId() {
    return `profile-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function getStoredModelProfiles() {
    const profiles = state.settings?.simple_ui_model_profiles?.profiles;
    return Array.isArray(profiles) ? profiles : [];
}

function normalizeModelProfile(profile = {}, fallback = getModelSettings()) {
    const source = Object.hasOwn(providerConfigs, profile.source) ? profile.source : fallback.source;
    const provider = providerConfigs[source];
    const sameSourceAsFallback = source === fallback.source;
    const temperature = Number(profile.temperature);
    const maxTokens = Number(profile.maxTokens);

    return {
        id: normalizeText(profile.id) || createModelProfileId(),
        name: normalizeText(profile.name) || provider.label,
        source,
        endpoint: provider.endpointKey ? normalizeText(profile.endpoint || (sameSourceAsFallback ? fallback.endpoint : '') || provider.defaultEndpoint || '') : '',
        model: normalizeText(profile.model || (sameSourceAsFallback ? fallback.model : '') || provider.defaultModel),
        temperature: Number.isFinite(temperature) ? temperature : fallback.temperature,
        maxTokens: Number.isFinite(maxTokens) ? maxTokens : fallback.maxTokens,
    };
}

function createDefaultModelProfile() {
    return normalizeModelProfile({
        id: 'default',
        name: '默认配置',
        ...getModelSettings(),
    });
}

function getModelProfiles() {
    const stored = getStoredModelProfiles();
    if (!stored.length) {
        return [createDefaultModelProfile()];
    }
    return stored.map(profile => normalizeModelProfile(profile));
}

function getDefaultModelProfileId() {
    const profiles = getModelProfiles();
    const configured = normalizeText(state.settings?.simple_ui_model_profiles?.defaultProfileId);
    return profiles.some(profile => profile.id === configured) ? configured : profiles[0]?.id;
}

function getModelProfileById(id) {
    const profiles = getModelProfiles();
    return profiles.find(profile => profile.id === id) || profiles.find(profile => profile.id === getDefaultModelProfileId()) || profiles[0] || createDefaultModelProfile();
}

function createModelProfileSelect(selectedId = getDefaultModelProfileId()) {
    const select = document.createElement('select');
    for (const profile of getModelProfiles()) {
        const option = document.createElement('option');
        option.value = profile.id;
        option.textContent = `${profile.name} · ${providerConfigs[profile.source].label} / ${profile.model}`;
        select.append(option);
    }
    select.value = selectedId;
    return select;
}

function createWorldBookSelect(selectedName = '') {
    const select = document.createElement('select');
    const empty = document.createElement('option');
    empty.value = '';
    empty.textContent = '不绑定世界书';
    select.append(empty);
    for (const name of getWorldBookNames()) {
        const option = document.createElement('option');
        option.value = name;
        option.textContent = name;
        select.append(option);
    }
    select.value = selectedName && getWorldBookNames().includes(selectedName) ? selectedName : '';
    return select;
}

function getUniqueModelProfileName(name, profiles) {
    const existingNames = new Set(profiles.map(profile => normalizeText(profile.name)));
    if (!existingNames.has(name)) {
        return name;
    }

    for (let index = 2; index < 100; index += 1) {
        const candidate = `${name} ${index}`;
        if (!existingNames.has(candidate)) {
            return candidate;
        }
    }

    return `${name} ${Date.now().toString(36)}`;
}

function applyModelProfileToSettings(settings, profile) {
    const provider = providerConfigs[profile.source];
    const oai = {
        ...(settings.oai_settings || {}),
        chat_completion_source: profile.source,
        temp_openai: Number.isFinite(profile.temperature) ? profile.temperature : 0.7,
        openai_max_tokens: Number.isFinite(profile.maxTokens) ? profile.maxTokens : 512,
        stream_openai: false,
    };

    oai[provider.modelKey] = profile.model;
    if (provider.endpointKey) {
        oai[provider.endpointKey] = profile.endpoint;
    }

    return {
        ...settings,
        main_api: 'openai',
        oai_settings: oai,
    };
}

function getChatModelSettings() {
    const profileId = normalizeText(state.chatMetadata?.model_profile_id);
    const profile = getModelProfileById(profileId || getDefaultModelProfileId());
    return {
        ...profile,
        isOverride: Boolean(profileId),
    };
}

function getCharacterChatName(character) {
    const routeChat = state.route?.type === 'chat' && state.route.avatar === character.avatar
        ? normalizeText(state.route.story)
        : '';
    if (routeChat) {
        return stripJsonlName(routeChat);
    }

    const existing = normalizeText(character.chat);
    if (existing) {
        return stripJsonlName(existing);
    }

    const base = normalizeText(character.name || character.avatar || 'Simple Chat').replace(/[\\/:*?"<>|]/g, ' ');
    return `${base} - Simple`;
}

function mapServerMessage(message) {
    return {
        role: message.is_user ? 'user' : 'assistant',
        content: normalizeMessageText(message.mes || ''),
        date: message.send_date || new Date().toISOString(),
    };
}

function mapClientMessage(character, message) {
    return {
        name: message.role === 'user' ? 'User' : character.name || 'Character',
        is_user: message.role === 'user',
        send_date: message.date || new Date().toISOString(),
        mes: message.content,
        extra: {},
    };
}

function getChatTitle(chatInfo) {
    return normalizeText(chatInfo?.chat_metadata?.name || chatInfo?.file_id || chatInfo?.file_name?.replace(/\.jsonl$/i, '') || '未命名聊天');
}

function getChatFileId(chatInfo) {
    return stripJsonlName(chatInfo?.file_id || chatInfo?.file_name || '');
}

async function loadCharacterChats(character) {
    const result = await apiPost('/api/characters/chats', {
        avatar_url: character.avatar,
        metadata: true,
    });
    return Array.isArray(result)
        ? result
            .filter(item => item && item.file_name)
            .map(item => ({
                ...item,
                file_id: getChatFileId(item),
            }))
        : [];
}

async function setCharacterChat(character, fileName) {
    const chatName = stripJsonlName(fileName);
    character.chat = chatName;
    await apiPost('/api/characters/merge-attributes', {
        avatar: character.avatar,
        chat: chatName,
    });
    return chatName;
}

function replaceChatRoute(character, chatName) {
    const normalized = stripJsonlName(chatName);
    const route = { page: 'detail', type: 'chat', avatar: character.avatar, story: normalized };
    const storyQuery = normalized ? `&story=${encodeURIComponent(normalized)}` : '';
    history.replaceState(route, '', `/simple?type=chat&avatar=${encodeURIComponent(character.avatar)}${storyQuery}`);
    state.route = route;
}

async function ensureCharacterChat(character) {
    const fileName = getCharacterChatName(character);
    if (character.chat !== fileName) {
        await setCharacterChat(character, fileName);
    }
    return fileName;
}

async function loadServerChat(character) {
    const fileName = await ensureCharacterChat(character);
    const data = await apiPost('/api/chats/get', {
        ch_name: character.name,
        file_name: fileName,
        avatar_url: character.avatar,
    });
    const header = Array.isArray(data) ? data.find(message => message?.chat_metadata) : null;
    const metadata = {
        simple_ui: true,
        ...(header?.chat_metadata || {}),
    };
    const messages = Array.isArray(data)
        ? data.filter(message => message && !message.chat_metadata && message.mes).map(mapServerMessage)
        : [];

    return { metadata, messages };
}

async function saveServerChat(character, messages) {
    const fileName = await ensureCharacterChat(character);
    const chatHeader = {
        chat_metadata: {
            simple_ui: true,
            ...(state.chatMetadata || {}),
        },
        user_name: 'unused',
        character_name: 'unused',
    };
    await apiPost('/api/chats/save', {
        ch_name: character.name,
        file_name: fileName,
        avatar_url: character.avatar,
        chat: [chatHeader, ...messages.map(message => mapClientMessage(character, message))],
        force: true,
    });
}

function getSimpleSystemPrompt(character, worldInfoText = '', modInfoText = '') {
    const personality = normalizeText(character.data?.personality || character.personality);
    const scenario = normalizeText(character.data?.scenario || character.scenario);
    const pieces = [
        `你正在扮演角色：${character.name || '未命名角色'}。`,
        getDescription(character),
        personality ? `性格：${personality}` : '',
        scenario ? `场景：${scenario}` : '',
        worldInfoText ? `世界书：\n${worldInfoText}` : '',
        modInfoText ? `已启用MOD：\n${modInfoText}` : '',
        '保持角色口吻，直接回应用户，不要解释你是模型。',
    ].filter(Boolean);

    return pieces.join('\n\n');
}

function getReplyText(data) {
    return normalizeMessageText(
        data?.choices?.[0]?.message?.content
        || data?.choices?.[0]?.text
        || data?.content
        || data?.response
        || '',
    );
}

function buildChatCompletionPayload(config, messages, character) {
    const payload = {
        type: 'normal',
        messages,
        model: config.model,
        temperature: config.temperature,
        max_tokens: config.maxTokens,
        stream: false,
        top_p: 1,
        chat_completion_source: config.source,
        user_name: 'User',
        char_name: character.name || 'Character',
    };

    const provider = providerConfigs[config.source];
    if (config.source === 'custom') {
        payload.custom_url = config.endpoint;
        payload.custom_include_body = state.settings?.oai_settings?.custom_include_body || '';
        payload.custom_exclude_body = state.settings?.oai_settings?.custom_exclude_body || '';
        payload.custom_include_headers = state.settings?.oai_settings?.custom_include_headers || '';
    } else if (provider?.endpointKey === 'reverse_proxy' && config.endpoint) {
        payload.reverse_proxy = config.endpoint;
    }

    return payload;
}

async function buildGeneratePayload(character, sourceMessages = state.chatMessages) {
    const config = getChatModelSettings();
    const recentMessages = sourceMessages.slice(-24).map(message => ({
        role: message.role === 'assistant' ? 'assistant' : 'user',
        content: message.content,
    }));
    const scanText = recentMessages.map(message => message.content).join('\n');
    const worldInfoText = await getWorldInfoText(getActiveWorldBookName(character), scanText);
    const modInfoText = getActiveModsText();
    const messages = [
        { role: 'system', content: getSimpleSystemPrompt(character, worldInfoText, modInfoText) },
        ...recentMessages,
    ];
    return buildChatCompletionPayload(config, messages, character);
}

async function buildTestGeneratePayload({ profileId, character, worldBookName, messages, scanText, modInfoText = '' }) {
    const config = getModelProfileById(profileId || getDefaultModelProfileId());
    const worldInfoText = await getWorldInfoText(worldBookName, scanText);
    return buildChatCompletionPayload(config, [
        { role: 'system', content: getSimpleSystemPrompt(character, worldInfoText, modInfoText) },
        ...messages,
    ], character);
}

async function saveChatModelOverride(character, profileId, worldBookName = '') {
    const profile = getModelProfileById(profileId);
    if (!profile || profile.id !== profileId) {
        throw new Error('请选择已保存的模型配置');
    }
    const worldName = normalizeText(worldBookName);
    state.chatMetadata = {
        ...(state.chatMetadata || {}),
        simple_ui: true,
        model_profile_id: profile.id,
    };
    if (worldName) {
        state.chatMetadata.world_info = worldName;
    } else {
        delete state.chatMetadata.world_info;
    }
    delete state.chatMetadata.model_settings;
    await saveServerChat(character, state.chatMessages);
}

async function clearChatModelOverride(character) {
    state.chatMetadata = {
        ...(state.chatMetadata || {}),
        simple_ui: true,
    };
    delete state.chatMetadata.model_profile_id;
    delete state.chatMetadata.model_settings;
    delete state.chatMetadata.world_info;
    await saveServerChat(character, state.chatMessages);
}

async function saveChatModOverride(character, modIds) {
    const validIds = new Set(getMods().map(mod => mod.id));
    state.chatMetadata = {
        ...(state.chatMetadata || {}),
        simple_ui: true,
        simple_ui_mod_ids: modIds.filter(id => validIds.has(id)),
    };
    await saveServerChat(character, state.chatMessages);
}

async function clearChatModOverride(character) {
    state.chatMetadata = {
        ...(state.chatMetadata || {}),
        simple_ui: true,
    };
    delete state.chatMetadata.simple_ui_mod_ids;
    await saveServerChat(character, state.chatMessages);
}

async function toggleCharacterFavorite(character) {
    const next = !isFavorite(character);
    await apiPost('/api/characters/merge-attributes', {
        avatar: character.avatar,
        fav: String(next),
        data: {
            extensions: {
                ...(character.data?.extensions || {}),
                fav: next,
            },
        },
    });
    await loadAll();
    const updated = getCharacterByAvatar(character.avatar);
    if (updated) {
        openCharacterDetail(updated);
    }
    setStatus(next ? '角色已加入收藏' : '角色已取消收藏');
}

async function saveCharacterTags(character, tagsValue) {
    const tags = parseTags(tagsValue);
    await apiPost('/api/characters/merge-attributes', {
        avatar: character.avatar,
        tags,
        data: { tags },
    });
    await loadAll();
    const updated = getCharacterByAvatar(character.avatar);
    if (updated) {
        openCharacterDetail(updated);
    }
    setStatus('角色标签已保存');
}

async function duplicateCharacterCard(character) {
    const result = await apiPost('/api/characters/duplicate', {
        avatar_url: character.avatar,
    });
    await loadAll();
    const avatar = result?.path;
    const duplicated = avatar ? getCharacterByAvatar(avatar) : null;
    if (duplicated) {
        openCharacterDetail(duplicated);
    } else {
        navigateBrowse('characters');
    }
    setStatus('角色卡已复制');
}

async function exportCharacterCard(character, format) {
    const blob = await apiPostBlob('/api/characters/export', {
        avatar_url: character.avatar,
        format,
    });
    const fileName = character.avatar.replace(/\.png$/i, `.${format}`);
    downloadFile(blob, fileName, format === 'json' ? 'application/json' : 'image/png');
    setStatus(`角色卡已导出：${fileName}`);
}

async function importCharacterCards(files) {
    let importedAvatar = '';
    let count = 0;
    for (const file of files) {
        const format = file.name.split('.').pop()?.toLowerCase();
        if (!['json', 'png', 'yaml', 'yml', 'charx', 'byaf'].includes(format)) {
            setStatus('角色导入只支持 JSON / PNG / YAML / CHARX / BYAF', 'error');
            continue;
        }
        const formData = new FormData();
        formData.append('avatar', file);
        formData.append('file_type', format);
        formData.append('user_name', 'User');
        const result = await apiUpload('/api/characters/import', formData);
        if (result?.error) {
            throw new Error(`导入失败：${file.name}`);
        }
        if (result?.file_name) {
            importedAvatar = `${result.file_name}.png`;
            count += 1;
        }
    }
    await loadAll();
    const imported = importedAvatar ? getCharacterByAvatar(importedAvatar) : null;
    if (imported) {
        openCharacterDetail(imported);
    } else {
        navigateBrowse('characters');
    }
    setStatus(`已导入 ${count} 张角色卡`);
}

async function deleteCharacterCard(character) {
    if (!window.confirm(`删除角色“${character.name || character.avatar}”？`)) {
        return;
    }
    const deleteChats = window.confirm('是否同时删除这个角色的所有聊天文件？');
    await apiPost('/api/characters/delete', {
        avatar_url: character.avatar,
        delete_chats: deleteChats,
    });
    await loadAll();
    navigateBrowse('characters', { replace: true });
    setStatus('角色卡已删除');
}

function createCharacterManagementPanel(character) {
    const form = document.createElement('form');
    form.className = 'simple-chat-model-form simple-management-panel';
    const tags = createInput('text', getCharacterTags(character).join(', '));
    tags.placeholder = '标签用逗号分隔';
    appendField(form, '角色标签', tags, '保存到角色卡 tags 字段，首页筛选会立即使用。');

    const actions = document.createElement('div');
    actions.className = 'simple-profile-actions';
    const saveTags = createButton('保存标签', 'fa-tags', 'simple-primary');
    const favorite = createButton(isFavorite(character) ? '取消收藏' : '收藏', isFavorite(character) ? 'fa-star-half-stroke' : 'fa-star', '');
    const duplicate = createButton('复制角色', 'fa-clone', '');
    const exportJson = createButton('导出 JSON', 'fa-file-code', '');
    const exportPng = createButton('导出 PNG', 'fa-image', '');
    const importButton = createButton('导入角色', 'fa-file-import', '');
    const remove = createButton('删除角色', 'fa-trash', 'simple-danger');
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,.png,.yaml,.yml,.charx,.byaf';
    input.multiple = true;
    input.hidden = true;

    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        saveTags.disabled = true;
        try {
            await saveCharacterTags(character, tags.value);
        } catch (error) {
            console.error(error);
            setStatus(`角色标签保存失败：${error.message || '未知错误'}`, 'error');
        } finally {
            saveTags.disabled = false;
        }
    });
    favorite.addEventListener('click', () => toggleCharacterFavorite(character).catch((error) => {
        console.error(error);
        setStatus(`收藏状态保存失败：${error.message || '未知错误'}`, 'error');
    }));
    duplicate.addEventListener('click', () => duplicateCharacterCard(character).catch((error) => {
        console.error(error);
        setStatus(`角色复制失败：${error.message || '未知错误'}`, 'error');
    }));
    exportJson.addEventListener('click', () => exportCharacterCard(character, 'json').catch((error) => {
        console.error(error);
        setStatus(`角色导出失败：${error.message || '未知错误'}`, 'error');
    }));
    exportPng.addEventListener('click', () => exportCharacterCard(character, 'png').catch((error) => {
        console.error(error);
        setStatus(`角色导出失败：${error.message || '未知错误'}`, 'error');
    }));
    importButton.addEventListener('click', () => input.click());
    input.addEventListener('change', async () => {
        try {
            await importCharacterCards([...input.files]);
        } catch (error) {
            console.error(error);
            setStatus(`角色导入失败：${error.message || '未知错误'}`, 'error');
        } finally {
            input.value = '';
        }
    });
    remove.addEventListener('click', () => deleteCharacterCard(character).catch((error) => {
        console.error(error);
        setStatus(`角色删除失败：${error.message || '未知错误'}`, 'error');
    }));

    actions.append(saveTags, favorite, duplicate, exportJson, exportPng, importButton, remove, input);
    form.append(actions);
    return form;
}

async function writeSecret(key, value) {
    const trimmed = String(value || '').trim();
    if (!trimmed) {
        return;
    }

    await apiPost('/api/secrets/write', {
        key,
        value: trimmed,
        label: 'Simple UI',
    });
}

async function loadWorldBook(name) {
    const worldName = normalizeText(name);
    if (!worldName) {
        return null;
    }
    return apiPost('/api/worldinfo/get', { name: worldName });
}

async function saveWorldBookData(name, data) {
    const worldName = normalizeText(name);
    if (!worldName) {
        throw new Error('世界书名称不能为空');
    }
    await apiPost('/api/worldinfo/edit', {
        name: worldName,
        data: {
            name: data?.name || worldName,
            entries: data?.entries || {},
            extensions: data?.extensions || {},
        },
    });
    await loadWorldBooks();
}

function getWorldBookEntries(data) {
    return Object.values(data?.entries || {})
        .filter(entry => entry && !entry.disable)
        .sort((a, b) => Number(a.order || 100) - Number(b.order || 100) || Number(a.uid || 0) - Number(b.uid || 0));
}

function findWorldBookEntry(data, uid) {
    const entries = data?.entries || {};
    return entries[String(uid)] || Object.values(entries).find(entry => Number(entry?.uid) === Number(uid));
}

function getNextWorldEntryUid(data) {
    const ids = Object.keys(data?.entries || {}).map(Number).filter(Number.isFinite);
    return ids.length ? Math.max(...ids) + 1 : 0;
}

function createSimpleWorldEntry(data, values) {
    const uid = getNextWorldEntryUid(data);
    return {
        uid,
        key: parseTags(values.keywords),
        keysecondary: [],
        comment: normalizeText(values.comment) || normalizeText(values.keywords) || `条目 ${uid + 1}`,
        content: String(values.content || '').trim(),
        constant: Boolean(values.constant),
        vectorized: false,
        selective: true,
        selectiveLogic: 0,
        addMemo: false,
        order: 100,
        position: 0,
        disable: false,
        ignoreBudget: false,
        excludeRecursion: false,
        preventRecursion: false,
        matchPersonaDescription: false,
        matchCharacterDescription: false,
        matchCharacterPersonality: false,
        matchCharacterDepthPrompt: false,
        matchScenario: false,
        matchCreatorNotes: false,
        delayUntilRecursion: 0,
        probability: 100,
        useProbability: true,
        depth: 4,
        outletName: '',
        group: '',
        groupOverride: false,
        groupWeight: 100,
        scanDepth: null,
        caseSensitive: null,
        matchWholeWords: null,
        useGroupScoring: null,
        automationId: '',
        role: 0,
        sticky: null,
        cooldown: null,
        delay: null,
        triggers: [],
    };
}

function updateSimpleWorldEntry(existing, values) {
    return {
        ...existing,
        key: parseTags(values.keywords),
        comment: normalizeText(values.comment) || normalizeText(values.keywords) || existing.comment || `条目 ${existing.uid}`,
        content: String(values.content || '').trim(),
        constant: Boolean(values.constant),
        disable: false,
    };
}

function getMatchedWorldInfo(entries, scanText) {
    const lowerScan = normalizeText(scanText).toLowerCase();
    return entries
        .filter((entry) => {
            if (entry.constant) {
                return true;
            }
            const keys = Array.isArray(entry.key) ? entry.key.map(normalizeText).filter(Boolean) : [];
            return keys.length > 0 && keys.some(key => lowerScan.includes(key.toLowerCase()));
        })
        .map(entry => String(entry.content || '').trim())
        .filter(Boolean)
        .slice(0, 12)
        .join('\n\n');
}

async function getWorldInfoText(worldName, scanText) {
    const data = await loadWorldBook(worldName);
    if (!data) {
        return '';
    }
    return getMatchedWorldInfo(getWorldBookEntries(data), scanText);
}

function getActiveWorldBookName(character) {
    return normalizeText(state.chatMetadata?.world_info) || getCharacterWorldBookName(character);
}

function renderCharacterDetailPage(character) {
    listEl.replaceChildren();
    detailEl.replaceChildren();
    listEl.className = 'simple-page-detail';
    detailEl.className = 'simple-detail simple-side-panel';
    viewKicker.textContent = '角色卡详情';
    viewTitle.textContent = character.name || '未命名角色';

    const hero = document.createElement('section');
    hero.className = 'simple-full-hero';
    const img = document.createElement('img');
    img.src = getAvatarUrl(character);
    img.alt = character.name || 'Character';
    const copy = document.createElement('div');
    const title = document.createElement('h2');
    title.textContent = character.name || '未命名角色';
    copy.append(title, createFullMeta([
        getCreator(character) ? `作者 ${getCreator(character)}` : '本地角色',
        `最近 ${formatDate(character.date_last_chat)}`,
        `聊天 ${formatSize(character.chat_size)}`,
        isFavorite(character) ? '收藏' : '',
    ]));
    hero.append(img, copy);

    const tags = document.createElement('div');
    tags.className = 'simple-card-tags simple-large-tags';
    getCharacterTags(character).forEach(tag => tags.append(createMetaPill(tag)));

    const desc = createSection('简介', createTextBlock(getDescription(character) || '这个角色还没有简介。'));
    listEl.append(hero, tags, desc);

    const relatedStories = state.stories.filter(story => story.avatar === character.avatar).slice(0, 8);
    const relatedList = document.createElement('div');
    relatedList.className = 'simple-related-list';
    if (relatedStories.length) {
        relatedStories.forEach((story) => {
            const item = document.createElement('button');
            item.type = 'button';
            item.className = 'simple-related-item';
            item.innerHTML = '<strong></strong><span></span>';
            item.querySelector('strong').textContent = getStoryTitle(story);
            item.querySelector('span').textContent = `${Number(story.chat_items || 0)} 条消息 · ${formatDate(story.last_mes)}`;
            item.addEventListener('click', () => openStoryDetail(story));
            relatedList.append(item);
        });
    } else {
        relatedList.append(createTextBlock('还没有故事记录。'));
    }

    detailEl.append(renderCharacterSummary(character));
    appendDetailActions(detailEl, '开始互动', () => openChatPage(character), [{
        label: '设为当前角色',
        icon: 'fa-check',
        onClick: () => activateCharacter(character),
    }]);
    detailEl.append(createSection('角色管理', createCharacterManagementPanel(character)));
    detailEl.append(createSection('故事记录', relatedList));
}

async function renderStoryMessages(story, container) {
    const key = getStoryKey(story);
    state.messageLoadKey = key;
    container.replaceChildren(createTextBlock('正在载入消息预览...'));

    try {
        const body = story.group
            ? { id: story.file_id }
            : { ch_name: getStoryOwner(story), file_name: story.file_id, avatar_url: story.avatar };
        const endpoint = story.group ? '/api/chats/group/get' : '/api/chats/get';
        const data = await apiPost(endpoint, body);

        if (state.messageLoadKey !== key) {
            return;
        }

        const messages = Array.isArray(data) ? data.filter(message => message && !message.chat_metadata).slice(-12) : [];
        container.replaceChildren();

        if (!messages.length) {
            container.append(createTextBlock('这个故事还没有可预览的消息。'));
            return;
        }

        for (const message of messages) {
            const row = document.createElement('article');
            row.className = `simple-message${message.is_user ? ' is-user' : ''}`;
            const name = document.createElement('strong');
            name.textContent = message.name || (message.is_user ? '你' : getStoryOwner(story));
            const text = document.createElement('p');
            text.textContent = normalizeText(message.mes || '[空消息]');
            row.append(name, text);
            container.append(row);
        }
    } catch (error) {
        console.error(error);
        container.replaceChildren(createTextBlock('消息预览载入失败。'));
    }
}

function renderStoryDetailPage(story) {
    listEl.replaceChildren();
    detailEl.replaceChildren();
    listEl.className = 'simple-page-detail';
    detailEl.className = 'simple-detail simple-side-panel';
    viewKicker.textContent = story.group ? '群组故事详情' : '故事卡详情';
    viewTitle.textContent = getStoryTitle(story);

    const hero = document.createElement('section');
    hero.className = 'simple-full-hero';
    const img = document.createElement('img');
    img.src = getStoryAvatarUrl(story);
    img.alt = getStoryOwner(story);
    const copy = document.createElement('div');
    const title = document.createElement('h2');
    title.textContent = getStoryTitle(story);
    copy.append(title, createFullMeta([
        getStoryOwner(story),
        `更新 ${formatDate(story.last_mes)}`,
        `${Number(story.chat_items || 0)} 条消息`,
        formatSize(story.file_size),
    ]));
    hero.append(img, copy);

    const tags = document.createElement('div');
    tags.className = 'simple-card-tags simple-large-tags';
    getStoryTags(story).forEach(tag => tags.append(createMetaPill(tag)));

    const preview = createSection('最后消息', createTextBlock(getStoryDescription(story)));
    const messages = document.createElement('div');
    messages.className = 'simple-message-list';
    listEl.append(hero, tags, preview, createSection('消息预览', messages));
    renderStoryMessages(story, messages);

    detailEl.append(renderStorySummary(story));
    appendDetailActions(detailEl, '设为当前故事', () => activateStory(story), story.group ? [] : [{
        label: '继续互动',
        icon: 'fa-comments',
        onClick: () => openChatPage(getCharacterByAvatar(story.avatar), story),
    }]);
}

function appendField(form, labelText, control, hint = '') {
    const label = document.createElement('label');
    label.className = 'simple-field';
    const span = document.createElement('span');
    span.textContent = labelText;
    label.append(span, control);
    if (hint) {
        const small = document.createElement('small');
        small.textContent = hint;
        label.append(small);
    }
    form.append(label);
}

function createInput(type, value = '') {
    const input = document.createElement('input');
    input.type = type;
    input.value = value;
    return input;
}

function renderModelNotice() {
    if (!state.modelNotice) {
        return null;
    }

    const notice = document.createElement('div');
    notice.className = 'simple-form-notice';
    notice.dataset.tone = state.modelNotice.tone || '';
    notice.setAttribute('role', 'status');
    notice.setAttribute('aria-live', 'polite');

    const title = document.createElement('strong');
    title.textContent = state.modelNotice.message;
    const meta = document.createElement('span');
    meta.textContent = state.modelNotice.detail
        ? `${state.modelNotice.detail} · ${state.modelNotice.time}`
        : state.modelNotice.time;
    notice.append(title, meta);

    return notice;
}

function createTextarea(value = '', rows = 4) {
    const textarea = document.createElement('textarea');
    textarea.value = value;
    textarea.rows = rows;
    return textarea;
}

function parseTags(value) {
    return String(value || '')
        .split(/[,，、\n]/)
        .map(normalizeText)
        .filter(Boolean);
}

function createSafeFileBase(value, fallback) {
    return normalizeText(value)
        .replace(/[\\/:*?"<>|]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 80) || fallback;
}

function createStoryFileName(title) {
    const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
    return `${createSafeFileBase(title, 'Simple Story')} - ${stamp}`;
}

function createModId() {
    return `mod-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function getStoredMods() {
    const mods = state.settings?.simple_ui_mods?.mods;
    return Array.isArray(mods) ? mods : [];
}

function normalizeMod(mod = {}) {
    return {
        id: normalizeText(mod.id) || createModId(),
        name: normalizeText(mod.name) || '新MOD',
        description: normalizeText(mod.description),
        tags: Array.isArray(mod.tags) ? mod.tags.map(normalizeText).filter(Boolean) : parseTags(mod.tags),
        prompt: String(mod.prompt || '').trim(),
        enabledDefault: Boolean(mod.enabledDefault),
    };
}

function getMods() {
    return getStoredMods().map(mod => normalizeMod(mod));
}

function getModById(id) {
    const mods = getMods();
    return mods.find(mod => mod.id === id) || mods[0] || normalizeMod({ id: '', name: '新MOD' });
}

function getUniqueModName(name, mods) {
    const existingNames = new Set(mods.map(mod => normalizeText(mod.name)));
    if (!existingNames.has(name)) {
        return name;
    }

    for (let index = 2; index < 100; index += 1) {
        const candidate = `${name} ${index}`;
        if (!existingNames.has(candidate)) {
            return candidate;
        }
    }

    return `${name} ${Date.now().toString(36)}`;
}

function getDefaultModIds() {
    return getMods().filter(mod => mod.enabledDefault).map(mod => mod.id);
}

function getChatModIds() {
    const savedIds = state.chatMetadata?.simple_ui_mod_ids;
    if (Array.isArray(savedIds)) {
        return savedIds.map(normalizeText).filter(Boolean);
    }

    return getDefaultModIds();
}

function getActiveMods() {
    const selectedIds = new Set(getChatModIds());
    return getMods().filter(mod => selectedIds.has(mod.id) && mod.prompt);
}

function getActiveModsText() {
    return getActiveMods()
        .map((mod, index) => `MOD ${index + 1} - ${mod.name}\n${mod.prompt}`)
        .join('\n\n');
}

function renderModNotice() {
    if (!state.modNotice) {
        return null;
    }

    return createNotice(state.modNotice.message, state.modNotice.tone, state.modNotice.detail);
}

function renderCharacterCreatePage() {
    listEl.replaceChildren();
    detailEl.replaceChildren();
    listEl.className = 'simple-page-detail simple-editor-page';
    detailEl.className = 'simple-detail simple-side-panel';
    viewKicker.textContent = '创建本地角色卡';
    viewTitle.textContent = '写角色卡';

    const form = document.createElement('form');
    form.className = 'simple-settings-form simple-card-editor';

    const name = createInput('text');
    name.required = true;
    name.maxLength = 80;
    name.placeholder = '角色名称';

    const description = createTextarea('', 5);
    description.placeholder = '角色身份、外貌、背景、关系等';

    const personality = createTextarea('', 4);
    personality.placeholder = '性格、说话方式、行为边界';

    const scenario = createTextarea('', 4);
    scenario.placeholder = '故事发生的地点、关系和当前局面';

    const firstMessage = createTextarea('', 4);
    firstMessage.placeholder = '角色第一次出现时说的话';

    const examples = createTextarea('', 5);
    examples.placeholder = '<START>\n{{user}}: ...\n{{char}}: ...';

    const tags = createInput('text');
    tags.placeholder = '奇幻，日常，助手';

    const creator = createInput('text');
    creator.placeholder = '可选';

    const notes = createTextarea('', 3);
    notes.placeholder = '给自己看的创作备注';

    const worldBook = createWorldBookSelect();
    const testProfile = createModelProfileSelect();
    const testPrompt = createTextarea('我们第一次见面，你会怎么开场？', 3);
    const testNotice = document.createElement('div');

    appendField(form, '角色名', name);
    appendField(form, '简介', description);
    appendField(form, '性格', personality);
    appendField(form, '场景', scenario);
    appendField(form, '开场白', firstMessage);
    appendField(form, '对话示例', examples);
    appendField(form, '标签', tags, '用逗号或换行分隔。');
    appendField(form, '绑定世界书', worldBook, '复用 ST 世界书；保存后会写入角色卡的 world 字段。');
    appendField(form, '作者', creator);
    appendField(form, '备注', notes);
    appendField(form, '测试模型', testProfile, '只选择已保存的模型配置，不在这里修改渠道。');
    appendField(form, '测试输入', testPrompt);

    const actions = document.createElement('div');
    actions.className = 'simple-form-actions';
    const save = createButton('保存角色卡', 'fa-floppy-disk', 'simple-primary');
    const test = createButton('测试角色', 'fa-vial', '');
    const cancel = createButton('取消', 'fa-xmark', '');
    save.type = 'submit';
    test.type = 'button';
    cancel.type = 'button';
    actions.append(save, test, cancel);
    form.append(actions, testNotice);

    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        save.disabled = true;
        await createCharacterFromForm({
            name: name.value,
            description: description.value,
            personality: personality.value,
            scenario: scenario.value,
            firstMessage: firstMessage.value,
            examples: examples.value,
            tags: tags.value,
            worldBook: worldBook.value,
            creator: creator.value,
            notes: notes.value,
        });
        save.disabled = false;
    });
    test.addEventListener('click', async () => {
        test.disabled = true;
        try {
            await testCharacterDraft({
                name: name.value,
                description: description.value,
                personality: personality.value,
                scenario: scenario.value,
                firstMessage: firstMessage.value,
                examples: examples.value,
                worldBook: worldBook.value,
                profileId: testProfile.value,
                prompt: testPrompt.value,
            }, testNotice);
        } finally {
            test.disabled = false;
        }
    });
    cancel.addEventListener('click', () => navigateBrowse('characters'));

    listEl.append(form);
    detailEl.append(createSection('保存内容', createTextBlock('会创建一张本地兼容的角色卡，使用默认头像。世界书会绑定到角色卡，测试不会保存任何内容。')));
}

async function testCharacterDraft(values, notice) {
    try {
        const name = normalizeText(values.name) || '未命名角色';
        updateNotice(notice, '正在测试角色回复...', 'pending', '不会保存角色卡或聊天记录');
        const character = {
            name,
            description: values.description,
            data: {
                description: values.description,
                personality: values.personality,
                scenario: values.scenario,
            },
        };
        const userPrompt = normalizeText(values.prompt) || '我们第一次见面，你会怎么开场？';
        const payload = await buildTestGeneratePayload({
            profileId: values.profileId,
            character,
            worldBookName: values.worldBook,
            scanText: [
                values.description,
                values.personality,
                values.scenario,
                userPrompt,
            ].join('\n'),
            messages: [
                ...(normalizeText(values.firstMessage) ? [{ role: 'assistant', content: normalizeText(values.firstMessage) }] : []),
                { role: 'user', content: userPrompt },
            ],
        });
        const data = await apiPost('/api/backends/chat-completions/generate', payload);
        const reply = stripSpeakerPrefix(getReplyText(data), name);
        if (!reply) {
            throw new Error(data?.error?.message || '模型没有返回文本');
        }
        updateNotice(notice, '测试回复', 'success', reply);
    } catch (error) {
        console.error(error);
        updateNotice(notice, `测试失败：${error.message || '请检查模型配置'}`, 'error');
    }
}

async function createCharacterFromForm(values) {
    try {
        const name = normalizeText(values.name);
        if (!name) {
            throw new Error('角色名不能为空');
        }

        const avatar = await apiPostText('/api/characters/create', {
            ch_name: name,
            description: values.description.trim(),
            personality: values.personality.trim(),
            scenario: values.scenario.trim(),
            first_mes: values.firstMessage.trim() || `你好，我是${name}。`,
            mes_example: values.examples.trim(),
            creator_notes: values.notes.trim(),
            system_prompt: '',
            post_history_instructions: '',
            creator: values.creator.trim(),
            character_version: 'simple-ui',
            tags: parseTags(values.tags),
            talkativeness: '0.5',
            world: normalizeText(values.worldBook),
            depth_prompt_prompt: '',
            depth_prompt_depth: '4',
            depth_prompt_role: 'system',
            fav: 'false',
            alternate_greetings: [],
            extensions: '{}',
        });

        await loadAll();
        const character = getCharacterByAvatar(avatar);
        setStatus(`角色卡已保存：${name}`);
        if (character) {
            openCharacterDetail(character);
        } else {
            navigateBrowse('characters');
        }
    } catch (error) {
        console.error(error);
        setStatus(`角色卡保存失败：${error.message || '未知错误'}`, 'error');
    }
}

function renderStoryCreatePage() {
    listEl.replaceChildren();
    detailEl.replaceChildren();
    listEl.className = 'simple-page-detail simple-editor-page';
    detailEl.className = 'simple-detail simple-side-panel';
    viewKicker.textContent = '创建本地故事卡';
    viewTitle.textContent = '写故事卡';

    const form = document.createElement('form');
    form.className = 'simple-settings-form simple-card-editor';

    const title = createInput('text');
    title.required = true;
    title.maxLength = 100;
    title.placeholder = '故事标题';

    const characterSelect = document.createElement('select');
    characterSelect.required = true;
    for (const character of state.characters) {
        const option = document.createElement('option');
        option.value = character.avatar;
        option.textContent = character.name || character.avatar;
        characterSelect.append(option);
    }
    const selectedCharacter = state.characters[state.selectedId];
    if (selectedCharacter) {
        characterSelect.value = selectedCharacter.avatar;
    }

    const description = createTextarea('', 5);
    description.placeholder = '故事背景、任务、关系、地点和冲突';

    const firstUser = createTextarea('', 3);
    firstUser.placeholder = '可选：用户进入故事时的第一句话';

    const firstAssistant = createTextarea('', 3);
    firstAssistant.placeholder = '可选：角色或旁白的第一句回应';

    const tags = createInput('text');
    tags.placeholder = '冒险，校园，悬疑';

    const worldBook = createWorldBookSelect(getCharacterWorldBookName(selectedCharacter));
    const testProfile = createModelProfileSelect();
    const testPrompt = createTextarea('我进入这个故事后，下一幕会发生什么？', 3);
    const testNotice = document.createElement('div');

    appendField(form, '标题', title);
    appendField(form, '所属角色', characterSelect, '故事会保存到这个角色的本地聊天目录。');
    appendField(form, '故事设定', description);
    appendField(form, '你的开场', firstUser);
    appendField(form, '角色开场', firstAssistant);
    appendField(form, '标签', tags, '用逗号或换行分隔。');
    appendField(form, '绑定世界书', worldBook, '复用 ST chat metadata 的 world_info；留空则使用角色卡绑定的世界书。');
    appendField(form, '测试模型', testProfile, '只选择已保存的模型配置，不在这里修改渠道。');
    appendField(form, '测试输入', testPrompt);

    const actions = document.createElement('div');
    actions.className = 'simple-form-actions';
    const save = createButton('保存故事卡', 'fa-floppy-disk', 'simple-primary');
    const test = createButton('测试故事', 'fa-vial', '');
    const cancel = createButton('取消', 'fa-xmark', '');
    save.type = 'submit';
    test.type = 'button';
    cancel.type = 'button';
    save.disabled = !state.characters.length;
    test.disabled = !state.characters.length;
    actions.append(save, test, cancel);
    form.append(actions, testNotice);

    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        save.disabled = true;
        await createStoryFromForm({
            title: title.value,
            avatar: characterSelect.value,
            description: description.value,
            firstUser: firstUser.value,
            firstAssistant: firstAssistant.value,
            tags: tags.value,
            worldBook: worldBook.value,
        });
        save.disabled = false;
    });
    test.addEventListener('click', async () => {
        test.disabled = true;
        try {
            await testStoryDraft({
                title: title.value,
                avatar: characterSelect.value,
                description: description.value,
                firstUser: firstUser.value,
                firstAssistant: firstAssistant.value,
                worldBook: worldBook.value,
                profileId: testProfile.value,
                prompt: testPrompt.value,
            }, testNotice);
        } finally {
            test.disabled = !state.characters.length;
        }
    });
    cancel.addEventListener('click', () => navigateBrowse('stories'));

    listEl.append(form);

    if (!state.characters.length) {
        detailEl.append(createSection('需要角色', createTextBlock('故事卡需要绑定一个角色。请先创建角色卡，再回来写故事。')));
        return;
    }

    const selected = getCharacterByAvatar(characterSelect.value) || state.characters[0];
    const summary = document.createElement('div');
    summary.className = 'simple-config-summary';
    summary.append(renderCharacterSummary(selected));
    detailEl.append(createSection('绑定角色', summary));
    characterSelect.addEventListener('change', () => {
        const character = getCharacterByAvatar(characterSelect.value);
        if (character) {
            summary.replaceChildren(renderCharacterSummary(character));
            worldBook.value = getCharacterWorldBookName(character);
        }
    });
}

async function testStoryDraft(values, notice) {
    try {
        const character = getCharacterByAvatar(values.avatar);
        if (!character) {
            throw new Error('请选择所属角色');
        }
        updateNotice(notice, '正在测试故事回复...', 'pending', '不会保存故事卡或聊天记录');
        const title = normalizeText(values.title) || '未命名故事';
        const userOpening = normalizeText(values.firstUser);
        const assistantOpening = normalizeText(values.firstAssistant);
        const userPrompt = normalizeText(values.prompt) || userOpening || '我进入这个故事后，下一幕会发生什么？';
        const worldName = normalizeText(values.worldBook) || getCharacterWorldBookName(character);
        const testCharacter = {
            ...character,
            data: {
                ...(character.data || {}),
                scenario: [
                    normalizeText(character.data?.scenario || character.scenario),
                    `故事标题：${title}`,
                    normalizeText(values.description),
                ].filter(Boolean).join('\n\n'),
            },
        };
        const payload = await buildTestGeneratePayload({
            profileId: values.profileId,
            character: testCharacter,
            worldBookName: worldName,
            scanText: [
                title,
                values.description,
                userOpening,
                assistantOpening,
                userPrompt,
            ].join('\n'),
            messages: [
                ...(userOpening ? [{ role: 'user', content: userOpening }] : []),
                ...(assistantOpening ? [{ role: 'assistant', content: assistantOpening }] : []),
                { role: 'user', content: userPrompt },
            ],
        });
        const data = await apiPost('/api/backends/chat-completions/generate', payload);
        const reply = stripSpeakerPrefix(getReplyText(data), character.name);
        if (!reply) {
            throw new Error(data?.error?.message || '模型没有返回文本');
        }
        updateNotice(notice, '测试回复', 'success', reply);
    } catch (error) {
        console.error(error);
        updateNotice(notice, `测试失败：${error.message || '请检查模型配置'}`, 'error');
    }
}

async function createStoryFromForm(values) {
    try {
        const title = normalizeText(values.title);
        const character = getCharacterByAvatar(values.avatar);
        if (!title) {
            throw new Error('故事标题不能为空');
        }
        if (!character) {
            throw new Error('请选择所属角色');
        }

        const fileName = createStoryFileName(title);
        const now = new Date().toISOString();
        const description = values.description.trim();
        const storyTags = parseTags(values.tags);
        const worldBookName = normalizeText(values.worldBook);
        const messages = [{
            chat_metadata: {
                simple_ui: true,
                name: title,
                description,
                tags: storyTags,
                created_at: now,
                ...(worldBookName ? { world_info: worldBookName } : {}),
            },
            user_name: 'unused',
            character_name: character.name || 'Character',
        }];

        const userOpening = values.firstUser.trim();
        const assistantOpening = values.firstAssistant.trim();
        if (userOpening) {
            messages.push({
                name: 'User',
                is_user: true,
                send_date: now,
                mes: userOpening,
                extra: {},
            });
        }
        if (assistantOpening || (!userOpening && description)) {
            messages.push({
                name: character.name || 'Character',
                is_user: false,
                send_date: now,
                mes: assistantOpening || description,
                extra: {},
            });
        }

        await apiPost('/api/chats/save', {
            ch_name: character.name,
            file_name: fileName,
            avatar_url: character.avatar,
            chat: messages,
            force: true,
        });
        await apiPost('/api/characters/merge-attributes', {
            avatar: character.avatar,
            chat: fileName,
        });
        character.chat = fileName;

        await loadAll();
        const story = state.stories.find(item => (
            item.avatar === character.avatar
            && (item.file_id === fileName || item.chat_metadata?.created_at === now)
        ));
        setStatus(`故事卡已保存：${title}`);
        if (story) {
            openStoryDetail(story);
        } else {
            navigateBrowse('stories');
        }
    } catch (error) {
        console.error(error);
        setStatus(`故事卡保存失败：${error.message || '未知错误'}`, 'error');
    }
}

function renderWorldBookPage() {
    listEl.replaceChildren();
    detailEl.replaceChildren();
    listEl.className = 'simple-page-detail simple-editor-page';
    detailEl.className = 'simple-detail simple-side-panel';
    viewKicker.textContent = 'ST 世界书';
    viewTitle.textContent = '世界书';
    if (!state.worldNotice) {
        setStatus(`已载入 ${getWorldBookNames().length} 个世界书`);
    }

    const form = document.createElement('form');
    form.className = 'simple-settings-form simple-card-editor';

    const worldSelect = createWorldBookSelect(state.selectedWorldBook);
    const name = createInput('text', worldSelect.value);
    name.maxLength = 80;
    name.placeholder = '新世界书名称，或选择已有世界书';

    const comment = createInput('text');
    comment.placeholder = '条目标题，例如：王都、魔法学院、公司设定';

    const keywords = createTextarea('', 3);
    keywords.placeholder = '触发关键词，用逗号或换行分隔';

    const content = createTextarea('', 7);
    content.placeholder = '世界书内容，会在关键词命中或设为常驻时加入生成提示';

    const constant = createInput('checkbox');

    appendField(form, '选择世界书', worldSelect);
    appendField(form, '世界书名称', name);
    appendField(form, '条目标题', comment);
    appendField(form, '关键词', keywords);
    appendField(form, '内容', content);
    appendField(form, '常驻条目', constant, '勾选后不需要关键词命中也会加入提示。');

    const actions = document.createElement('div');
    actions.className = 'simple-form-actions';
    const save = createButton('保存世界书条目', 'fa-floppy-disk', 'simple-primary');
    const createEmpty = createButton('新建空世界书', 'fa-plus', '');
    const cancelEdit = createButton('取消编辑', 'fa-xmark', '');
    const exportWorld = createButton('导出世界书', 'fa-file-export', '');
    const importWorld = createButton('导入世界书', 'fa-file-import', '');
    const deleteWorld = createButton('删除世界书', 'fa-trash', 'simple-danger');
    const refresh = createButton('刷新列表', 'fa-rotate', '');
    const importInput = document.createElement('input');
    importInput.type = 'file';
    importInput.accept = '.json,.lorebook';
    importInput.multiple = true;
    importInput.hidden = true;
    save.type = 'submit';
    createEmpty.type = 'button';
    cancelEdit.type = 'button';
    exportWorld.type = 'button';
    importWorld.type = 'button';
    deleteWorld.type = 'button';
    refresh.type = 'button';
    cancelEdit.hidden = state.editingWorldEntryUid === null;
    actions.append(save, createEmpty, cancelEdit, exportWorld, importWorld, deleteWorld, refresh, importInput);
    form.append(actions);
    const controls = { name, comment, keywords, content, constant, save, cancelEdit };

    if (state.worldNotice) {
        form.append(createNotice(state.worldNotice.message, state.worldNotice.tone, state.worldNotice.detail));
    }

    const preview = document.createElement('div');
    preview.className = 'simple-profile-list';

    worldSelect.addEventListener('change', () => {
        state.selectedWorldBook = worldSelect.value;
        state.editingWorldEntryUid = null;
        name.value = worldSelect.value;
        state.worldNotice = null;
        clearWorldEntryControls(controls);
        renderWorldBookPreview(worldSelect.value, preview, controls);
    });

    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        save.disabled = true;
        try {
            await saveSimpleWorldBookEntry({
                name: name.value || worldSelect.value,
                comment: comment.value,
                keywords: keywords.value,
                content: content.value,
                constant: constant.checked,
                uid: state.editingWorldEntryUid,
            });
        } finally {
            save.disabled = false;
        }
    });

    createEmpty.addEventListener('click', async () => {
        createEmpty.disabled = true;
        try {
            state.editingWorldEntryUid = null;
            await saveSimpleWorldBookEntry({
                name: name.value || worldSelect.value,
                comment: '',
                keywords: '',
                content: '',
                constant: false,
            });
        } finally {
            createEmpty.disabled = false;
        }
    });

    cancelEdit.addEventListener('click', () => {
        state.editingWorldEntryUid = null;
        clearWorldEntryControls(controls);
        setWorldNotice('已退出条目编辑', 'success');
        renderWorldBookPage();
    });

    exportWorld.addEventListener('click', () => exportSelectedWorldBook(name.value || worldSelect.value).catch((error) => {
        console.error(error);
        setWorldNotice(`世界书导出失败：${error.message || '未知错误'}`, 'error');
        renderWorldBookPage();
    }));

    importWorld.addEventListener('click', () => importInput.click());
    importInput.addEventListener('change', async () => {
        try {
            await importWorldBookFiles([...importInput.files]);
        } catch (error) {
            console.error(error);
            setWorldNotice(`世界书导入失败：${error.message || '未知错误'}`, 'error');
            renderWorldBookPage();
        } finally {
            importInput.value = '';
        }
    });

    deleteWorld.addEventListener('click', () => deleteSelectedWorldBook(name.value || worldSelect.value).catch((error) => {
        console.error(error);
        setWorldNotice(`世界书删除失败：${error.message || '未知错误'}`, 'error');
        renderWorldBookPage();
    }));

    refresh.addEventListener('click', async () => {
        await loadWorldBooks();
        setWorldNotice('世界书列表已刷新', 'success');
        renderWorldBookPage();
    });

    listEl.append(form);
    detailEl.append(createSection('已有世界书', createWorldBookSummary()));
    detailEl.append(createSection('条目预览', preview));
    renderWorldBookPreview(worldSelect.value, preview, controls);
}

function createWorldBookSummary() {
    const list = document.createElement('div');
    list.className = 'simple-profile-list';
    const names = getWorldBookNames();
    if (!names.length) {
        list.append(createTextBlock('还没有世界书。填写名称后可以新建一个。'));
        return list;
    }
    for (const name of names) {
        const item = document.createElement('article');
        item.className = `simple-profile-card${name === state.selectedWorldBook ? ' is-selected' : ''}`;
        const heading = document.createElement('strong');
        heading.textContent = name;
        const meta = createFullMeta([name === state.selectedWorldBook ? '当前' : '可绑定']);
        item.append(heading, meta);
        item.addEventListener('click', () => {
            state.selectedWorldBook = name;
            state.editingWorldEntryUid = null;
            state.worldNotice = null;
            renderWorldBookPage();
        });
        list.append(item);
    }
    return list;
}

function setWorldEntryControls(entry, controls) {
    controls.comment.value = normalizeText(entry.comment);
    controls.keywords.value = Array.isArray(entry.key) ? entry.key.join('\n') : '';
    controls.content.value = String(entry.content || '');
    controls.constant.checked = Boolean(entry.constant);
    controls.save.querySelector('span').textContent = '保存条目修改';
    controls.cancelEdit.hidden = false;
}

function clearWorldEntryControls(controls) {
    controls.comment.value = '';
    controls.keywords.value = '';
    controls.content.value = '';
    controls.constant.checked = false;
    controls.save.querySelector('span').textContent = '保存世界书条目';
    controls.cancelEdit.hidden = true;
}

async function renderWorldBookPreview(name, container, controls = null) {
    container.replaceChildren(createTextBlock(name ? '正在读取世界书...' : '选择一个世界书查看条目。'));
    if (!name) {
        return;
    }
    try {
        const data = await loadWorldBook(name);
        const entries = getWorldBookEntries(data);
        container.replaceChildren();
        if (!entries.length) {
            container.append(createTextBlock('这个世界书还没有条目。'));
            return;
        }
        for (const entry of entries.slice(0, 24)) {
            const item = document.createElement('article');
            item.className = 'simple-profile-card';
            const heading = document.createElement('strong');
            heading.textContent = normalizeText(entry.comment) || `条目 ${entry.uid}`;
            const meta = createFullMeta([
                entry.constant ? '常驻' : '关键词触发',
                ...(Array.isArray(entry.key) ? entry.key.slice(0, 4) : []),
            ]);
            const body = createTextBlock(String(entry.content || '').slice(0, 260));
            const actions = document.createElement('div');
            actions.className = 'simple-profile-actions';
            const edit = createButton('编辑', 'fa-pen', '');
            const remove = createButton('删除', 'fa-trash', 'simple-danger');
            edit.addEventListener('click', () => {
                state.editingWorldEntryUid = Number(entry.uid);
                if (controls) {
                    setWorldEntryControls(entry, controls);
                }
                setWorldNotice('正在编辑世界书条目', 'pending', normalizeText(entry.comment) || `条目 ${entry.uid}`);
            });
            remove.addEventListener('click', () => deleteWorldBookEntry(name, entry.uid).catch((error) => {
                console.error(error);
                setWorldNotice(`条目删除失败：${error.message || '未知错误'}`, 'error');
                renderWorldBookPage();
            }));
            actions.append(edit, remove);
            item.append(heading, meta, body, actions);
            container.append(item);
        }
    } catch (error) {
        console.error(error);
        container.replaceChildren(createTextBlock('世界书读取失败。'));
    }
}

async function saveSimpleWorldBookEntry(values) {
    try {
        const name = normalizeText(values.name);
        if (!name) {
            throw new Error('世界书名称不能为空');
        }
        const existing = getWorldBookNames().includes(name);
        const data = existing ? await loadWorldBook(name) : { name, entries: {}, extensions: {} };
        data.name = data.name || name;
        data.entries = data.entries || {};

        const content = String(values.content || '').trim();
        const isEditingEntry = values.uid !== null && values.uid !== undefined;
        if (isEditingEntry) {
            const existingEntry = findWorldBookEntry(data, values.uid);
            if (!existingEntry) {
                throw new Error('找不到要编辑的世界书条目');
            }
            data.entries[String(existingEntry.uid)] = updateSimpleWorldEntry(existingEntry, values);
        } else if (content) {
            const entry = createSimpleWorldEntry(data, values);
            data.entries[entry.uid] = entry;
        }

        await saveWorldBookData(name, data);
        state.selectedWorldBook = name;
        state.editingWorldEntryUid = null;
        setWorldNotice(isEditingEntry || content ? '世界书条目已保存' : '空世界书已创建', 'success', name);
        renderWorldBookPage();
    } catch (error) {
        console.error(error);
        setWorldNotice(`世界书保存失败：${error.message || '未知错误'}`, 'error');
        renderWorldBookPage();
    }
}

async function deleteWorldBookEntry(name, uid) {
    const worldName = normalizeText(name);
    if (!worldName || !window.confirm('删除这个世界书条目？')) {
        return;
    }
    const data = await loadWorldBook(worldName);
    const entry = findWorldBookEntry(data, uid);
    if (!entry) {
        throw new Error('找不到世界书条目');
    }
    delete data.entries[String(entry.uid)];
    await saveWorldBookData(worldName, data);
    if (Number(state.editingWorldEntryUid) === Number(uid)) {
        state.editingWorldEntryUid = null;
    }
    setWorldNotice('世界书条目已删除', 'success', worldName);
    renderWorldBookPage();
}

async function exportSelectedWorldBook(name) {
    const worldName = normalizeText(name);
    if (!worldName) {
        throw new Error('请选择要导出的世界书');
    }
    const data = await loadWorldBook(worldName);
    downloadFile(JSON.stringify(data, null, 4), `${createSafeFileBase(worldName, 'worldbook')}.json`, 'application/json');
    setWorldNotice('世界书已导出', 'success', worldName);
}

async function importWorldBookFiles(files) {
    let importedName = '';
    let count = 0;
    for (const file of files) {
        const format = file.name.split('.').pop()?.toLowerCase();
        if (!['json', 'lorebook'].includes(format)) {
            setWorldNotice('世界书导入只支持 JSON / Lorebook 文件', 'error');
            continue;
        }
        const formData = new FormData();
        formData.append('avatar', file);
        const result = await apiUpload('/api/worldinfo/import', formData);
        if (typeof result === 'string') {
            throw new Error(result || `导入失败：${file.name}`);
        }
        importedName = result?.name || importedName;
        count += 1;
    }
    await loadWorldBooks();
    state.selectedWorldBook = importedName || state.selectedWorldBook;
    state.editingWorldEntryUid = null;
    setWorldNotice(`已导入 ${count} 个世界书`, 'success', importedName);
    renderWorldBookPage();
}

async function deleteSelectedWorldBook(name) {
    const worldName = normalizeText(name);
    if (!worldName || !window.confirm(`删除世界书“${worldName}”？`)) {
        return;
    }
    await apiPost('/api/worldinfo/delete', { name: worldName });
    state.selectedWorldBook = '';
    state.editingWorldEntryUid = null;
    await loadWorldBooks();
    setWorldNotice('世界书已删除', 'success', worldName);
    renderWorldBookPage();
}

function renderModsPage() {
    listEl.replaceChildren();
    detailEl.replaceChildren();
    listEl.className = 'simple-page-detail simple-config-page';
    detailEl.className = 'simple-detail simple-side-panel';
    viewKicker.textContent = '提示词 MOD 管理';
    viewTitle.textContent = 'MOD';

    const mods = getMods();
    if (!state.modNotice) {
        setStatus(`已载入 ${mods.length} 个 MOD`);
    }
    if (!state.editingModId) {
        state.editingModId = mods[0]?.id || '__new__';
    }
    if (state.editingModId !== '__new__' && !mods.some(mod => mod.id === state.editingModId)) {
        state.editingModId = mods[0]?.id || '__new__';
    }

    const isCreating = state.editingModId === '__new__' || !mods.length;
    const mod = isCreating ? normalizeMod({ id: '', name: '新MOD' }) : getModById(state.editingModId);
    const form = document.createElement('form');
    form.className = 'simple-settings-form simple-card-editor';

    const name = createInput('text', mod.name);
    name.required = true;
    name.maxLength = 60;
    const description = createTextarea(mod.description, 3);
    const tags = createInput('text', mod.tags.join('，'));
    const prompt = createTextarea(mod.prompt, 9);
    prompt.required = true;
    prompt.placeholder = '写入要追加到系统提示词里的规则，例如叙事风格、回复格式、互动限制、玩法规则。';
    const enabledDefault = document.createElement('input');
    enabledDefault.type = 'checkbox';
    enabledDefault.checked = mod.enabledDefault;

    appendField(form, 'MOD 名称', name);
    appendField(form, '说明', description, '只用于管理列表，不会发送给模型。');
    appendField(form, '标签', tags, '用中文逗号、英文逗号或换行分隔。');
    appendField(form, '提示词规则', prompt, '会在当前聊天启用后注入 system prompt，可和世界书、角色卡一起生效。');
    appendField(form, '默认启用', enabledDefault, '新聊天或未指定 MOD 的聊天会自动使用默认启用项。');

    const actions = document.createElement('div');
    actions.className = 'simple-form-actions';
    const save = createButton('保存MOD', 'fa-floppy-disk', 'simple-primary');
    const saveAs = createButton('另存为新MOD', 'fa-copy', '');
    const create = createButton('新建MOD', 'fa-plus', '');
    const importButton = createButton('导入MOD', 'fa-file-import', '');
    const exportButton = createButton('导出全部', 'fa-file-export', '');
    const importInput = document.createElement('input');
    importInput.type = 'file';
    importInput.accept = '.json,application/json';
    importInput.multiple = true;
    importInput.hidden = true;
    save.type = 'submit';
    saveAs.type = 'submit';
    create.type = 'button';
    importButton.type = 'button';
    exportButton.type = 'button';
    actions.append(save, saveAs, create, importButton, exportButton, importInput);
    form.append(actions);

    const notice = renderModNotice();
    if (notice) {
        form.append(notice);
    }

    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        await saveModSettings({
            id: isCreating || event.submitter === saveAs ? '' : mod.id,
            name: name.value,
            description: description.value,
            tags: tags.value,
            prompt: prompt.value,
            enabledDefault: enabledDefault.checked,
        }, isCreating || event.submitter === saveAs);
    });

    create.addEventListener('click', () => {
        state.editingModId = '__new__';
        state.modNotice = null;
        renderModsPage();
    });
    importButton.addEventListener('click', () => importInput.click());
    importInput.addEventListener('change', async () => {
        try {
            await importMods([...importInput.files]);
        } catch (error) {
            console.error(error);
            setModNotice(`MOD 导入失败：${error.message || '未知错误'}`, 'error');
            renderModsPage();
        } finally {
            importInput.value = '';
        }
    });
    exportButton.disabled = !mods.length;
    exportButton.addEventListener('click', exportMods);
    listEl.append(form);

    const modList = document.createElement('div');
    modList.className = 'simple-profile-list';
    if (!mods.length) {
        modList.append(createTextBlock('还没有 MOD。左侧保存一个规则包后，就可以在聊天页选择启用。'));
    }
    for (const item of mods) {
        const card = document.createElement('article');
        card.className = `simple-profile-card${item.id === mod.id && !isCreating ? ' is-selected' : ''}`;
        const heading = document.createElement('strong');
        heading.textContent = item.name;
        const meta = createFullMeta([
            item.enabledDefault ? '默认启用' : '',
            item.tags.length ? item.tags.join(' / ') : '',
            item.description || '无说明',
        ]);
        const preview = document.createElement('p');
        preview.className = 'simple-mod-preview';
        preview.textContent = item.prompt || '没有提示词规则。';
        const buttons = document.createElement('div');
        buttons.className = 'simple-profile-actions';
        const edit = createButton('编辑', 'fa-pen', '');
        const toggleDefault = createButton(item.enabledDefault ? '取消默认' : '默认启用', 'fa-star', '');
        const duplicate = createButton('复制', 'fa-copy', '');
        const remove = createButton('删除', 'fa-trash', 'simple-danger');
        edit.addEventListener('click', () => {
            state.editingModId = item.id;
            state.modNotice = null;
            renderModsPage();
        });
        toggleDefault.addEventListener('click', () => saveModSettings({ ...item, enabledDefault: !item.enabledDefault }, false));
        duplicate.addEventListener('click', () => saveModSettings({ ...item, id: '', name: `${item.name} 副本` }, true));
        remove.addEventListener('click', () => deleteMod(item.id));
        buttons.append(edit, toggleDefault, duplicate, remove);
        card.append(heading, meta, preview, buttons);
        modList.append(card);
    }
    detailEl.append(createSection('已保存 MOD', modList));
}

async function saveModSettings(config, shouldCreateNew = false) {
    try {
        const name = normalizeText(config.name);
        const prompt = String(config.prompt || '').trim();
        if (!name) {
            throw new Error('MOD 名称不能为空');
        }
        if (!prompt) {
            throw new Error('提示词规则不能为空');
        }
        if (!state.settings) {
            await loadSettings();
        }

        const currentMods = getMods();
        const existing = shouldCreateNew ? null : currentMods.find(mod => mod.id === config.id);
        const mod = normalizeMod({
            ...config,
            id: existing?.id || config.id || createModId(),
            name: existing ? name : getUniqueModName(name, currentMods),
            prompt,
        });
        const mods = existing
            ? currentMods.map(item => item.id === existing.id ? mod : item)
            : [...currentMods, mod];

        await saveSettings({
            ...state.settings,
            simple_ui_mods: { mods },
        });
        state.editingModId = mod.id;
        setModNotice('MOD 已保存', 'success', mod.name);
        renderModsPage();
    } catch (error) {
        console.error(error);
        setModNotice(`MOD 保存失败：${error.message || '未知错误'}`, 'error');
        renderModsPage();
    }
}

async function deleteMod(modId) {
    const mod = getModById(modId);
    if (!mod || !window.confirm(`删除 MOD“${mod.name}”？`)) {
        return;
    }
    const mods = getMods().filter(item => item.id !== modId);
    await saveSettings({
        ...state.settings,
        simple_ui_mods: { mods },
    });
    state.editingModId = mods[0]?.id || '__new__';
    setModNotice('MOD 已删除', 'success', mod.name);
    renderModsPage();
}

function exportMods() {
    const mods = getMods();
    downloadFile(JSON.stringify({ mods }, null, 4), 'aibar-mods.json', 'application/json');
    setModNotice('MOD 已导出', 'success', `${mods.length} 个规则包`);
    renderModsPage();
}

async function importMods(files) {
    if (!files.length) {
        return;
    }
    let nextMods = getMods();
    let count = 0;
    for (const file of files) {
        const json = JSON.parse(await file.text());
        const imported = Array.isArray(json)
            ? json
            : Array.isArray(json.mods)
                ? json.mods
                : Array.isArray(json.simple_ui_mods?.mods)
                    ? json.simple_ui_mods.mods
                    : [];
        if (!imported.length) {
            throw new Error(`${file.name} 里没有 mods 数组`);
        }
        for (const item of imported) {
            const mod = normalizeMod({
                ...item,
                id: createModId(),
                name: getUniqueModName(normalizeText(item.name) || '导入MOD', nextMods),
            });
            if (!mod.prompt) {
                continue;
            }
            nextMods = [...nextMods, mod];
            count += 1;
        }
    }
    await saveSettings({
        ...state.settings,
        simple_ui_mods: { mods: nextMods },
    });
    state.editingModId = nextMods.at(-1)?.id || state.editingModId;
    setModNotice(`已导入 ${count} 个 MOD`, count ? 'success' : 'pending');
    renderModsPage();
}

function renderModelSettingsPage() {
    listEl.replaceChildren();
    detailEl.replaceChildren();
    listEl.className = 'simple-page-detail simple-config-page';
    detailEl.className = 'simple-detail simple-side-panel';
    viewKicker.textContent = '模型配置管理';
    viewTitle.textContent = '模型配置';

    const profiles = getModelProfiles();
    const defaultProfileId = getDefaultModelProfileId();
    const isCreatingProfile = state.editingModelProfileId === '__new__';
    const config = isCreatingProfile
        ? normalizeModelProfile({ id: '', name: '新模型配置', ...getModelSettings() })
        : getModelProfileById(state.editingModelProfileId || defaultProfileId);
    const form = document.createElement('form');
    form.className = 'simple-settings-form';

    const profileName = createInput('text', config.name);
    profileName.required = true;
    profileName.maxLength = 60;

    const provider = document.createElement('select');
    for (const [value, optionConfig] of Object.entries(providerConfigs)) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = optionConfig.label;
        provider.append(option);
    }
    provider.value = config.source;

    const endpoint = createInput('url', config.endpoint);
    const model = createInput('text', config.model);
    const apiKey = createInput('password', '');
    apiKey.autocomplete = 'off';
    apiKey.placeholder = '留空则沿用已保存密钥';

    const temperature = createInput('number', String(config.temperature));
    temperature.step = '0.1';
    temperature.min = '0';
    temperature.max = '2';

    const maxTokens = createInput('number', String(config.maxTokens));
    maxTokens.step = '64';
    maxTokens.min = '64';

    appendField(form, '配置名称', profileName, '每个配置对应一个渠道和一个模型，例如：OpenRouter GPT-4o、OpenRouter Claude。');
    appendField(form, '服务类型', provider);
    appendField(form, '接口地址', endpoint, '只有 OpenAI 兼容、本地服务或支持代理的来源需要填写；Ollama 常用 http://127.0.0.1:11434/v1。');
    appendField(form, '模型名称', model);
    appendField(form, 'API Key', apiKey, '只在填写时更新到 ST 的密钥库。');
    appendField(form, '温度', temperature);
    appendField(form, '最大回复长度', maxTokens);

    const actions = document.createElement('div');
    actions.className = 'simple-form-actions';
    const saveButton = createButton('保存配置', 'fa-floppy-disk', 'simple-primary');
    const saveAsButton = createButton('另存为新配置', 'fa-copy', '');
    const testButton = createButton('保存并测试', 'fa-plug', '');
    const newButton = createButton('新建配置', 'fa-plus', '');
    saveButton.type = 'submit';
    saveAsButton.type = 'submit';
    testButton.type = 'submit';
    newButton.type = 'button';
    actions.append(saveButton, saveAsButton, testButton, newButton);
    form.append(actions);

    const notice = renderModelNotice();
    if (notice) {
        form.append(notice);
    }

    let previousProvider = provider.value;
    provider.addEventListener('change', () => {
        const value = provider.value;
        const selected = providerConfigs[value];
        const changedProvider = value !== previousProvider;
        endpoint.disabled = !selected.endpointKey;
        endpoint.value = selected.endpointKey
            ? changedProvider ? selected.defaultEndpoint || '' : endpoint.value || selected.defaultEndpoint || ''
            : '';
        if (changedProvider || !model.value || Object.values(providerConfigs).some(config => config.defaultModel === model.value)) {
            model.value = selected.defaultModel;
        }
        previousProvider = value;
    });
    provider.dispatchEvent(new Event('change'));

    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const submitter = event.submitter;
        const shouldTest = submitter === testButton;
        const shouldCreateNew = isCreatingProfile || submitter === saveAsButton;
        await saveModelSettings({
            id: shouldCreateNew || (config.id === 'default' && getStoredModelProfiles().length === 0) ? '' : config.id,
            name: profileName.value.trim(),
            source: provider.value,
            endpoint: endpoint.value.trim(),
            model: model.value.trim(),
            apiKey: apiKey.value,
            temperature: Number(temperature.value),
            maxTokens: Number(maxTokens.value),
        }, shouldTest);
        apiKey.value = '';
    });

    newButton.addEventListener('click', () => {
        state.editingModelProfileId = '__new__';
        state.modelNotice = null;
        renderModelSettingsPage();
    });

    listEl.append(form);

    const profileList = document.createElement('div');
    profileList.className = 'simple-profile-list';
    for (const profile of profiles) {
        const item = document.createElement('article');
        item.className = `simple-profile-card${profile.id === config.id ? ' is-selected' : ''}`;
        const heading = document.createElement('strong');
        heading.textContent = profile.name;
        const meta = createFullMeta([
            profile.id === defaultProfileId ? '默认' : '',
            providerConfigs[profile.source].label,
            profile.model,
            profile.endpoint || '官方默认地址',
        ]);
        const buttons = document.createElement('div');
        buttons.className = 'simple-profile-actions';
        const edit = createButton('编辑', 'fa-pen', '');
        const makeDefault = createButton('设为默认', 'fa-star', '');
        const test = createButton('测试', 'fa-plug', '');
        const remove = createButton('删除', 'fa-trash', '');
        edit.addEventListener('click', () => {
            state.editingModelProfileId = profile.id;
            state.modelNotice = null;
            renderModelSettingsPage();
        });
        makeDefault.disabled = profile.id === defaultProfileId;
        makeDefault.addEventListener('click', () => setDefaultModelProfile(profile.id));
        test.addEventListener('click', async () => {
            setModelNotice('正在测试模型连接...', 'pending', `${profile.name} / ${profile.model}`);
            renderModelSettingsPage();
            try {
                await testModelSettings(profile);
            } catch (error) {
                console.error(error);
                setModelNotice(`测试失败：${error.message || '未知错误'}`, 'error', `${profile.name} / ${profile.model}`);
            }
            renderModelSettingsPage();
        });
        remove.disabled = profiles.length <= 1;
        remove.addEventListener('click', () => deleteModelProfile(profile.id));
        buttons.append(edit, makeDefault, test, remove);
        item.append(heading, meta, buttons);
        profileList.append(item);
    }
    detailEl.append(createSection('已保存配置', profileList));
}

async function saveModelSettings(config, shouldTest = false) {
    try {
        setModelNotice(shouldTest ? '正在保存配置并准备测试...' : '正在保存模型配置...', 'pending');
        const name = normalizeText(config.name);
        if (!name) {
            throw new Error('配置名称不能为空');
        }
        if (!config.model) {
            throw new Error('Model is required');
        }
        const provider = providerConfigs[config.source];
        if (!provider) {
            throw new Error('Unsupported provider');
        }
        if (config.source === 'custom' && !config.endpoint) {
            throw new Error('Custom endpoint is required');
        }
        if (!state.settings) {
            await loadSettings();
        }

        const currentProfiles = getStoredModelProfiles().length ? getModelProfiles() : [];
        const existing = currentProfiles.find(profile => profile.id === config.id);
        const profile = normalizeModelProfile({
            ...config,
            id: existing?.id || config.id || createModelProfileId(),
            name: existing ? name : getUniqueModelProfileName(name, currentProfiles),
        });
        const profiles = existing
            ? currentProfiles.map(item => item.id === existing.id ? profile : item)
            : [...currentProfiles, profile];
        const previousDefault = getDefaultModelProfileId();
        const defaultProfileId = profiles.some(item => item.id === previousDefault) ? previousDefault : profile.id;
        let nextSettings = {
            ...state.settings,
            simple_ui_model_profiles: {
                profiles,
                defaultProfileId,
            },
        };
        if (profile.id === defaultProfileId) {
            nextSettings = applyModelProfileToSettings(nextSettings, profile);
        }

        await writeSecret(provider.secretKey, config.apiKey);
        await saveSettings(nextSettings);
        state.editingModelProfileId = profile.id;

        if (shouldTest) {
            setModelNotice('配置已保存，正在测试模型连接...', 'pending', `${profile.name} / ${profile.model}`);
            renderModelSettingsPage();
            try {
                await testModelSettings(profile);
            } catch (error) {
                console.error(error);
                setModelNotice(`配置已保存，但测试失败：${error.message || '未知错误'}`, 'error', `${profile.name} / ${profile.model}`);
            }
            renderModelSettingsPage();
            return;
        }

        setModelNotice('模型配置已保存', 'success', `${profile.name} / ${profile.model}`);
        renderModelSettingsPage();
    } catch (error) {
        console.error(error);
        setModelNotice(`模型配置保存失败：${error.message || '未知错误'}`, 'error');
        renderModelSettingsPage();
    }
}

async function setDefaultModelProfile(profileId) {
    try {
        const profile = getModelProfileById(profileId);
        let nextSettings = {
            ...state.settings,
            simple_ui_model_profiles: {
                profiles: getModelProfiles(),
                defaultProfileId: profile.id,
            },
        };
        nextSettings = applyModelProfileToSettings(nextSettings, profile);
        await saveSettings(nextSettings);
        state.editingModelProfileId = profile.id;
        setModelNotice('默认模型配置已更新', 'success', `${profile.name} / ${profile.model}`);
        renderModelSettingsPage();
    } catch (error) {
        console.error(error);
        setModelNotice(`设置默认配置失败：${error.message || '未知错误'}`, 'error');
        renderModelSettingsPage();
    }
}

async function deleteModelProfile(profileId) {
    try {
        const profiles = getModelProfiles();
        if (profiles.length <= 1) {
            throw new Error('至少保留一个模型配置');
        }
        const nextProfiles = profiles.filter(profile => profile.id !== profileId);
        const defaultProfileId = profileId === getDefaultModelProfileId() ? nextProfiles[0].id : getDefaultModelProfileId();
        let nextSettings = {
            ...state.settings,
            simple_ui_model_profiles: {
                profiles: nextProfiles,
                defaultProfileId,
            },
        };
        nextSettings = applyModelProfileToSettings(nextSettings, getModelProfileById(defaultProfileId));
        await saveSettings(nextSettings);
        state.editingModelProfileId = defaultProfileId;
        setModelNotice('模型配置已删除', 'success');
        renderModelSettingsPage();
    } catch (error) {
        console.error(error);
        setModelNotice(`删除模型配置失败：${error.message || '未知错误'}`, 'error');
        renderModelSettingsPage();
    }
}

async function testModelSettings(config) {
    setModelNotice('正在测试模型连接...', 'pending', `${providerConfigs[config.source].label} / ${config.model}`);
    const payload = {
        chat_completion_source: config.source,
        model: config.model,
    };
    const provider = providerConfigs[config.source];
    if (config.source === 'custom') {
        payload.custom_url = config.endpoint;
    } else if (provider?.endpointKey === 'reverse_proxy' && config.endpoint) {
        payload.reverse_proxy = config.endpoint;
    }
    const result = await apiPost('/api/backends/chat-completions/status', payload);
    if (result?.error) {
        throw new Error('模型连接测试失败');
    }
    const models = Array.isArray(result?.data) ? result.data.length : 0;
    setModelNotice(
        models ? `连接成功，发现 ${models} 个模型` : '连接成功',
        'success',
        `${providerConfigs[config.source].label} / ${config.model}`,
    );
}

function renderChatMessages(container, character = state.chatTarget) {
    container.replaceChildren();
    if (!state.chatMessages.length) {
        container.append(createTextBlock('发送第一条消息开始互动。'));
        return;
    }

    state.chatMessages.forEach((message, index) => {
        const row = document.createElement('article');
        row.className = `simple-message${message.role === 'user' ? ' is-user' : ''}`;
        const head = document.createElement('div');
        head.className = 'simple-message-head';
        const name = document.createElement('strong');
        name.textContent = message.role === 'user' ? '你' : state.chatTarget?.name || '角色';
        const actions = document.createElement('div');
        actions.className = 'simple-message-actions';
        const edit = createButton('编辑', 'fa-pen', 'simple-mini-button');
        const remove = createButton('删除', 'fa-trash', 'simple-mini-button simple-danger');
        edit.addEventListener('click', () => editChatMessage(character, container, index));
        remove.addEventListener('click', () => deleteChatMessage(character, container, index));
        actions.append(edit, remove);
        head.append(name, actions);
        const text = document.createElement('div');
        text.className = 'simple-message-content';
        renderMessageContent(text, message.content, message.role === 'assistant' ? state.chatTarget?.name || '' : '');
        row.append(head, text);
        container.append(row);
    });
    container.scrollTop = container.scrollHeight;
}

async function editChatMessage(character, container, index) {
    const message = state.chatMessages[index];
    if (!message) {
        return;
    }
    const next = window.prompt('编辑消息内容', message.content);
    if (next === null) {
        return;
    }
    const content = normalizeMessageText(next);
    if (!content) {
        setStatus('消息不能为空，如需移除请使用删除', 'error');
        return;
    }
    state.chatMessages[index] = {
        ...message,
        content,
        date: message.date || new Date().toISOString(),
    };
    await saveServerChat(character, state.chatMessages);
    renderChatMessages(container, character);
    setStatus('消息已保存到服务器聊天文件');
}

async function deleteChatMessage(character, container, index) {
    const message = state.chatMessages[index];
    if (!message || !window.confirm('删除这条消息？')) {
        return;
    }
    state.chatMessages.splice(index, 1);
    await saveServerChat(character, state.chatMessages);
    renderChatMessages(container, character);
    setStatus('消息已删除');
}

function renderChatModelPanel(character, container) {
    container.replaceChildren();
    const config = getChatModelSettings();
    const isWorldOverride = Boolean(normalizeText(state.chatMetadata?.world_info));
    const activeWorldName = normalizeText(state.chatMetadata?.world_info) || getCharacterWorldBookName(character);
    const form = document.createElement('form');
    form.className = 'simple-chat-model-form';

    const profileSelect = createModelProfileSelect(config.id);
    const worldSelect = createWorldBookSelect(activeWorldName);

    appendField(form, '模型配置', profileSelect);
    appendField(form, '世界书', worldSelect, '会写入当前聊天的 ST chat metadata；留空则使用角色卡绑定的世界书。');

    const actions = document.createElement('div');
    actions.className = 'simple-form-actions simple-stacked-actions';
    const apply = createButton('应用到当前聊天', 'fa-check', 'simple-primary');
    const reset = createButton('使用默认配置', 'fa-rotate-left', '');
    apply.type = 'submit';
    reset.type = 'button';
    apply.disabled = !state.chatLoaded;
    reset.disabled = !state.chatLoaded || (!config.isOverride && !isWorldOverride);
    actions.append(apply, reset);
    form.append(actions);

    const status = document.createElement('div');
    status.className = 'simple-form-notice';
    status.dataset.tone = config.isOverride || isWorldOverride ? 'success' : 'pending';
    const statusTitle = document.createElement('strong');
    statusTitle.textContent = config.isOverride || isWorldOverride ? '当前聊天使用指定配置' : '当前聊天使用默认配置';
    const statusMeta = document.createElement('span');
    statusMeta.textContent = `${config.name} · ${providerConfigs[config.source].label} / ${config.model} · 世界书 ${activeWorldName || '未绑定'}`;
    status.append(statusTitle, statusMeta);
    form.append(status);

    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        apply.disabled = true;
        try {
            const profile = getModelProfileById(profileSelect.value);
            await saveChatModelOverride(character, profile.id, worldSelect.value);
            setStatus(`当前聊天配置已设置为：${profile.name}`);
        } catch (error) {
            console.error(error);
            setStatus(`当前聊天模型配置保存失败：${error.message || '未知错误'}`, 'error');
        } finally {
            renderChatModelPanel(character, container);
        }
    });

    reset.addEventListener('click', async () => {
        reset.disabled = true;
        try {
            await clearChatModelOverride(character);
            setStatus('当前聊天已恢复使用默认模型配置');
        } catch (error) {
            console.error(error);
            setStatus(`恢复默认配置失败：${error.message || '未知错误'}`, 'error');
        } finally {
            renderChatModelPanel(character, container);
        }
    });

    container.append(form);
}

function renderChatModPanel(character, container) {
    container.replaceChildren();
    const mods = getMods();
    const selectedIds = new Set(getChatModIds());
    const isOverride = Array.isArray(state.chatMetadata?.simple_ui_mod_ids);
    const form = document.createElement('form');
    form.className = 'simple-chat-model-form';

    if (!mods.length) {
        form.append(createNotice('还没有可用 MOD', 'pending', '先在 MOD 页面创建规则包，然后回到聊天里选择启用。'));
        const create = createButton('创建MOD', 'fa-plus', 'simple-primary');
        create.addEventListener('click', navigateMods);
        const actions = document.createElement('div');
        actions.className = 'simple-form-actions simple-stacked-actions';
        actions.append(create);
        form.append(actions);
        container.append(form);
        return;
    }

    const list = document.createElement('div');
    list.className = 'simple-check-list';
    for (const mod of mods) {
        const row = document.createElement('label');
        row.className = 'simple-check-row';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.value = mod.id;
        checkbox.checked = selectedIds.has(mod.id);
        const text = document.createElement('span');
        const title = document.createElement('strong');
        title.textContent = mod.name;
        const meta = document.createElement('span');
        meta.textContent = [
            mod.enabledDefault ? '默认启用' : '',
            mod.tags.length ? mod.tags.join(' / ') : '',
            mod.description,
        ].filter(Boolean).join(' · ') || '无描述';
        text.append(title, meta);
        row.append(checkbox, text);
        list.append(row);
    }
    form.append(list);

    const actions = document.createElement('div');
    actions.className = 'simple-form-actions simple-stacked-actions';
    const apply = createButton('应用到当前聊天', 'fa-check', 'simple-primary');
    const reset = createButton('使用默认MOD', 'fa-rotate-left', '');
    const manage = createButton('管理MOD', 'fa-sliders', '');
    apply.type = 'submit';
    reset.type = 'button';
    manage.type = 'button';
    apply.disabled = !state.chatLoaded;
    reset.disabled = !state.chatLoaded || !isOverride;
    actions.append(apply, reset, manage);
    form.append(actions);

    const status = createNotice(
        isOverride ? '当前聊天使用指定 MOD' : '当前聊天使用默认 MOD',
        selectedIds.size ? 'success' : 'pending',
        selectedIds.size ? `已启用 ${selectedIds.size} 个 MOD` : '未启用 MOD',
    );
    form.append(status);

    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        apply.disabled = true;
        try {
            const nextIds = [...form.querySelectorAll('input[type="checkbox"]:checked')].map(input => input.value);
            await saveChatModOverride(character, nextIds);
            setStatus(`当前聊天已启用 ${nextIds.length} 个 MOD`);
        } catch (error) {
            console.error(error);
            setStatus(`当前聊天 MOD 保存失败：${error.message || '未知错误'}`, 'error');
        } finally {
            renderChatModPanel(character, container);
        }
    });

    reset.addEventListener('click', async () => {
        reset.disabled = true;
        try {
            await clearChatModOverride(character);
            setStatus('当前聊天已恢复默认 MOD');
        } catch (error) {
            console.error(error);
            setStatus(`恢复默认 MOD 失败：${error.message || '未知错误'}`, 'error');
        } finally {
            renderChatModPanel(character, container);
        }
    });

    manage.addEventListener('click', navigateMods);
    container.append(form);
}

async function createNewChat(character) {
    const title = normalizeText(window.prompt('新聊天名称', `${character.name || '角色'} - 新聊天`));
    if (!title) {
        return;
    }
    const fileName = createStoryFileName(title);
    const now = new Date().toISOString();
    state.chatMetadata = {
        simple_ui: true,
        name: title,
        created_at: now,
    };
    state.chatMessages = [];
    await setCharacterChat(character, fileName);
    await saveServerChat(character, state.chatMessages);
    await loadStories();
    replaceChatRoute(character, fileName);
    renderChatPage(character);
    setStatus(`已创建新聊天：${title}`);
}

async function renameCurrentChat(character) {
    const current = getCharacterChatName(character);
    const next = normalizeText(window.prompt('重命名当前聊天', current));
    if (!next || stripJsonlName(next) === current) {
        return;
    }
    const renamed = stripJsonlName(next);
    const result = await apiPost('/api/chats/rename', {
        is_group: false,
        avatar_url: character.avatar,
        original_file: ensureJsonlName(current),
        renamed_file: ensureJsonlName(renamed),
    });
    const savedName = stripJsonlName(result?.sanitizedFileName || renamed);
    state.chatMetadata = {
        ...(state.chatMetadata || {}),
        simple_ui: true,
        name: savedName,
    };
    await setCharacterChat(character, savedName);
    await saveServerChat(character, state.chatMessages);
    await loadStories();
    replaceChatRoute(character, savedName);
    renderChatPage(character);
    setStatus(`聊天已重命名：${savedName}`);
}

async function deleteCurrentChat(character) {
    const current = getCharacterChatName(character);
    if (!current || !window.confirm(`删除当前聊天“${current}”？`)) {
        return;
    }
    await apiPost('/api/chats/delete', {
        avatar_url: character.avatar,
        chatfile: ensureJsonlName(current),
    });
    character.chat = '';
    await apiPost('/api/characters/merge-attributes', {
        avatar: character.avatar,
        chat: '',
    });
    state.chatMessages = [];
    state.chatMetadata = { simple_ui: true };
    await loadStories();
    history.replaceState({ page: 'detail', type: 'chat', avatar: character.avatar, story: '' }, '', `/simple?type=chat&avatar=${encodeURIComponent(character.avatar)}`);
    state.route = { page: 'detail', type: 'chat', avatar: character.avatar, story: '' };
    renderChatPage(character);
    setStatus('聊天文件已删除');
}

async function exportCurrentChat(character) {
    const current = getCharacterChatName(character);
    const exportFileName = `${createSafeFileBase(current, 'chat')}.jsonl`;
    const data = await apiPost('/api/chats/export', {
        file: ensureJsonlName(current),
        avatar_url: character.avatar,
        is_group: false,
        exportfilename: exportFileName,
        format: 'jsonl',
    });
    downloadFile(data.result || '', exportFileName, 'application/json');
    setStatus(`聊天已导出：${exportFileName}`);
}

async function importChatFiles(character, files) {
    const imported = [];
    for (const file of files) {
        const format = file.name.split('.').pop()?.toLowerCase();
        if (!['json', 'jsonl'].includes(format)) {
            setStatus('聊天导入只支持 JSON / JSONL', 'error');
            continue;
        }
        const formData = new FormData();
        formData.append('avatar', file);
        formData.append('file_type', format);
        formData.append('avatar_url', character.avatar);
        formData.append('character_name', character.name || 'Character');
        formData.append('user_name', 'User');
        const result = await apiUpload('/api/chats/import', formData);
        if (result?.error) {
            throw new Error(`导入失败：${file.name}`);
        }
        imported.push(...(result?.fileNames || []));
    }
    await loadStories();
    setStatus(`已导入 ${imported.length} 个聊天文件`);
    if (imported[0]) {
        await setCharacterChat(character, stripJsonlName(imported[0]));
        replaceChatRoute(character, stripJsonlName(imported[0]));
        renderChatPage(character);
    }
}

function renderChatManagerPanel(character, container, messagesContainer, sendButton) {
    container.replaceChildren(createTextBlock('正在读取聊天文件...'));
    loadCharacterChats(character)
        .then((chats) => {
            if (state.route.type !== 'chat' || state.route.avatar !== character.avatar) {
                return;
            }
            const current = getCharacterChatName(character);
            const wrapper = document.createElement('div');
            wrapper.className = 'simple-chat-manager';
            const actions = document.createElement('div');
            actions.className = 'simple-profile-actions';
            const newChat = createButton('新聊天', 'fa-plus', '');
            const rename = createButton('重命名', 'fa-pen', '');
            const exportChat = createButton('导出', 'fa-file-export', '');
            const importChat = createButton('导入', 'fa-file-import', '');
            const regenerate = createButton('重新生成', 'fa-rotate-right', '');
            const continueButton = createButton('续写', 'fa-arrow-right', '');
            const remove = createButton('删除聊天', 'fa-trash', 'simple-danger');
            const fileInput = document.createElement('input');
            fileInput.type = 'file';
            fileInput.accept = '.json,.jsonl';
            fileInput.multiple = true;
            fileInput.hidden = true;

            newChat.addEventListener('click', () => createNewChat(character).catch((error) => {
                console.error(error);
                setStatus(`新聊天创建失败：${error.message || '未知错误'}`, 'error');
            }));
            rename.addEventListener('click', () => renameCurrentChat(character).catch((error) => {
                console.error(error);
                setStatus(`聊天重命名失败：${error.message || '未知错误'}`, 'error');
            }));
            exportChat.addEventListener('click', () => exportCurrentChat(character).catch((error) => {
                console.error(error);
                setStatus(`聊天导出失败：${error.message || '未知错误'}`, 'error');
            }));
            importChat.addEventListener('click', () => fileInput.click());
            fileInput.addEventListener('change', async () => {
                try {
                    await importChatFiles(character, [...fileInput.files]);
                } catch (error) {
                    console.error(error);
                    setStatus(`聊天导入失败：${error.message || '未知错误'}`, 'error');
                } finally {
                    fileInput.value = '';
                }
            });
            regenerate.addEventListener('click', async () => {
                await regenerateLastReply(character, messagesContainer, regenerate);
                renderChatManagerPanel(character, container, messagesContainer, sendButton);
            });
            continueButton.addEventListener('click', async () => {
                await continueLastReply(character, messagesContainer, continueButton);
                renderChatManagerPanel(character, container, messagesContainer, sendButton);
            });
            remove.addEventListener('click', () => deleteCurrentChat(character).catch((error) => {
                console.error(error);
                setStatus(`聊天删除失败：${error.message || '未知错误'}`, 'error');
            }));
            const hasCurrentFile = chats.some(chat => chat.file_id === current);
            rename.disabled = !state.chatLoaded || !hasCurrentFile;
            exportChat.disabled = !state.chatLoaded || !hasCurrentFile;
            regenerate.disabled = !state.chatLoaded || !state.chatMessages.some(message => message.role === 'assistant');
            continueButton.disabled = !state.chatLoaded || state.chatMessages.at(-1)?.role !== 'assistant';
            remove.disabled = !hasCurrentFile;
            actions.append(newChat, rename, exportChat, importChat, regenerate, continueButton, remove, fileInput);

            const list = document.createElement('div');
            list.className = 'simple-profile-list';
            if (!chats.length) {
                list.append(createTextBlock('这个角色还没有聊天文件。'));
            } else {
                for (const chat of chats.slice(0, 10)) {
                    const item = document.createElement('button');
                    item.type = 'button';
                    item.className = `simple-related-item${chat.file_id === current ? ' is-selected' : ''}`;
                    item.innerHTML = '<strong></strong><span></span>';
                    item.querySelector('strong').textContent = getChatTitle(chat);
                    item.querySelector('span').textContent = `${Number(chat.chat_items || 0)} 条消息 · ${formatDate(chat.last_mes)}`;
                    item.addEventListener('click', () => openChatPage(character, { file_id: chat.file_id }));
                    list.append(item);
                }
            }

            wrapper.append(actions, list);
            container.replaceChildren(wrapper);
            sendButton.disabled = !state.chatLoaded;
        })
        .catch((error) => {
            console.error(error);
            container.replaceChildren(createTextBlock('聊天文件读取失败。'));
        });
}

function renderChatPage(character) {
    listEl.replaceChildren();
    detailEl.replaceChildren();
    listEl.className = 'simple-chat-panel';
    detailEl.className = 'simple-detail simple-side-panel';
    viewKicker.textContent = '简易互动';
    viewTitle.textContent = character.name || '角色';
    state.chatLoaded = false;
    state.chatMetadata = { simple_ui: true };

    const messages = document.createElement('div');
    messages.className = 'simple-live-messages';
    const modelPanel = document.createElement('div');
    renderChatModelPanel(character, modelPanel);
    const modPanel = document.createElement('div');
    renderChatModPanel(character, modPanel);
    const chatManagerPanel = document.createElement('div');

    const form = document.createElement('form');
    form.className = 'simple-chat-form';
    const textarea = document.createElement('textarea');
    textarea.placeholder = `和 ${character.name || '角色'} 说点什么`;
    textarea.rows = 3;
    const send = createButton('发送', 'fa-paper-plane', 'simple-primary');
    const clear = createButton('清空', 'fa-trash', '');
    send.type = 'submit';
    send.disabled = true;
    clear.type = 'button';
    const formActions = document.createElement('div');
    formActions.className = 'simple-chat-actions';
    formActions.append(send, clear);
    form.append(textarea, formActions);

    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const text = textarea.value.trim();
        if (!text) {
            return;
        }
        textarea.value = '';
        await sendSimpleMessage(character, text, messages, send);
        renderChatManagerPanel(character, chatManagerPanel, messages, send);
    });

    textarea.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            form.requestSubmit(send);
        }
    });

    clear.addEventListener('click', async () => {
        if (!window.confirm('清空当前聊天里的全部消息？聊天文件会保留。')) {
            return;
        }
        state.chatMessages = [];
        await saveServerChat(character, state.chatMessages);
        renderChatMessages(messages, character);
        renderChatManagerPanel(character, chatManagerPanel, messages, send);
        setStatus('服务器聊天记录已清空');
    });

    listEl.append(messages, form);
    messages.replaceChildren(createTextBlock('正在读取服务器聊天记录...'));
    loadServerChat(character)
        .then((loadedChat) => {
            if (state.route.type !== 'chat' || state.route.avatar !== character.avatar) {
                return;
            }
            state.chatMetadata = loadedChat.metadata;
            state.chatMessages = loadedChat.messages;
            renderChatMessages(messages, character);
            state.chatLoaded = true;
            renderChatModelPanel(character, modelPanel);
            renderChatModPanel(character, modPanel);
            renderChatManagerPanel(character, chatManagerPanel, messages, send);
            setStatus(`已载入服务器聊天：${getCharacterChatName(character)}`);
        })
        .catch((error) => {
            console.error(error);
            state.chatMessages = [];
            state.chatLoaded = true;
            renderChatMessages(messages, character);
            renderChatModelPanel(character, modelPanel);
            renderChatModPanel(character, modPanel);
            renderChatManagerPanel(character, chatManagerPanel, messages, send);
            setStatus('服务器聊天读取失败，已打开空聊天', 'error');
        })
        .finally(() => {
            send.disabled = false;
        });

    detailEl.append(renderCharacterSummary(character));
    detailEl.append(createSection('当前聊天模型', modelPanel));
    detailEl.append(createSection('当前聊天MOD', modPanel));
    detailEl.append(createSection('聊天管理', chatManagerPanel));
    appendDetailActions(detailEl, '模型配置', () => navigateSettings(), [{
        label: '设为当前角色',
        icon: 'fa-check',
        onClick: () => activateCharacter(character),
    }]);
}

async function sendSimpleMessage(character, text, container, sendButton) {
    try {
        setStatus('正在生成回复...');
        sendButton.disabled = true;
        state.chatMessages.push({ role: 'user', content: text, date: new Date().toISOString() });
        renderChatMessages(container, character);
        await saveServerChat(character, state.chatMessages);
        await generateAssistantReply(character, container);
    } catch (error) {
        console.error(error);
        state.chatMessages.push({ role: 'assistant', content: `生成失败：${error.message || '请检查模型配置'}` });
        renderChatMessages(container, character);
        setStatus('生成失败：请检查模型配置', 'error');
    } finally {
        sendButton.disabled = false;
    }
}

async function generateAssistantReply(character, container, sourceMessages = state.chatMessages, { appendToLast = false } = {}) {
    const data = await apiPost('/api/backends/chat-completions/generate', await buildGeneratePayload(character, sourceMessages));
    const reply = stripSpeakerPrefix(getReplyText(data), character.name);
    if (!reply) {
        throw new Error(data?.error?.message || '模型没有返回文本');
    }

    if (appendToLast) {
        const last = state.chatMessages[state.chatMessages.length - 1];
        if (last?.role === 'assistant') {
            last.content = `${normalizeMessageText(last.content)}\n\n${reply}`.trim();
            last.date = new Date().toISOString();
        } else {
            state.chatMessages.push({ role: 'assistant', content: reply, date: new Date().toISOString() });
        }
    } else {
        state.chatMessages.push({ role: 'assistant', content: reply, date: new Date().toISOString() });
    }

    await saveServerChat(character, state.chatMessages);
    renderChatMessages(container, character);
    setStatus('回复完成');
}

async function regenerateLastReply(character, container, triggerButton) {
    const assistantIndex = state.chatMessages.map(message => message.role).lastIndexOf('assistant');
    if (assistantIndex === -1) {
        setStatus('没有可重新生成的角色回复', 'error');
        return;
    }
    triggerButton.disabled = true;
    try {
        state.chatMessages.splice(assistantIndex, 1);
        renderChatMessages(container, character);
        await saveServerChat(character, state.chatMessages);
        setStatus('正在重新生成最后一条回复...');
        await generateAssistantReply(character, container);
    } catch (error) {
        console.error(error);
        setStatus(`重新生成失败：${error.message || '请检查模型配置'}`, 'error');
        renderChatMessages(container, character);
    } finally {
        triggerButton.disabled = false;
    }
}

async function continueLastReply(character, container, triggerButton) {
    const last = state.chatMessages[state.chatMessages.length - 1];
    if (last?.role !== 'assistant') {
        setStatus('最后一条消息不是角色回复，无法续写', 'error');
        return;
    }
    triggerButton.disabled = true;
    try {
        setStatus('正在续写最后一条回复...');
        const continuationPrompt = {
            role: 'user',
            content: '请从上一条回复的结尾自然续写，不要重复已经说过的内容。',
            date: new Date().toISOString(),
        };
        await generateAssistantReply(character, container, [...state.chatMessages, continuationPrompt], { appendToLast: true });
    } catch (error) {
        console.error(error);
        setStatus(`续写失败：${error.message || '请检查模型配置'}`, 'error');
        renderChatMessages(container, character);
    } finally {
        triggerButton.disabled = false;
    }
}

function renderPage() {
    let pageType = 'detail';
    if (state.route.type === 'settings' || state.route.type === 'worldbooks' || state.route.type === 'mods') {
        pageType = 'settings';
    } else if (state.route.type === 'chat') {
        pageType = 'chat';
    } else if (state.route.type === 'create-character' || state.route.type === 'create-story') {
        pageType = 'editor';
    }
    app.dataset.page = pageType;
    backButton.hidden = false;
    randomButton.hidden = true;
    renderModeButtons();
    renderSidebarState();

    if (state.route.type === 'create-character') {
        renderCharacterCreatePage();
        return;
    }

    if (state.route.type === 'create-story') {
        renderStoryCreatePage();
        return;
    }

    if (state.route.type === 'settings') {
        renderModelSettingsPage();
        return;
    }

    if (state.route.type === 'worldbooks') {
        renderWorldBookPage();
        return;
    }

    if (state.route.type === 'mods') {
        renderModsPage();
        return;
    }

    if (state.route.type === 'chat') {
        const character = getCharacterByAvatar(state.route.avatar);
        if (character) {
            state.chatTarget = character;
            if (state.route.story) {
                character.chat = state.route.story;
            }
            renderChatPage(character);
            return;
        }
    }

    if (state.route.type === 'story') {
        const story = findStoryFromRoute(state.route);
        if (story) {
            renderStoryDetailPage(story);
            return;
        }
    }

    if (state.route.type === 'character') {
        const character = getCharacterByAvatar(state.route.avatar);
        if (character) {
            renderCharacterDetailPage(character);
            return;
        }
    }

    navigateBrowse(state.mode, { replace: true });
}

function render() {
    if (state.page === 'detail') {
        renderPage();
    } else {
        renderBrowse();
    }
}

function findStoryFromRoute(route) {
    return state.stories.find((story) => {
        if (route.group) {
            return String(story.group) === String(route.group) && story.file_id === route.chat;
        }
        return story.avatar === route.avatar && story.file_id === route.chat;
    });
}

function getRouteFromLocation() {
    const params = new URLSearchParams(window.location.search);
    const type = params.get('type');
    if (type === 'story') {
        return {
            page: 'detail',
            type,
            avatar: params.get('avatar') || '',
            group: params.get('group') || '',
            chat: params.get('chat') || '',
        };
    }
    if (type === 'character') {
        return {
            page: 'detail',
            type,
            avatar: params.get('avatar') || '',
        };
    }
    if (type === 'chat') {
        return {
            page: 'detail',
            type,
            avatar: params.get('avatar') || '',
            story: params.get('story') || '',
        };
    }
    if (type === 'settings') {
        return {
            page: 'detail',
            type,
        };
    }
    if (type === 'worldbooks') {
        return {
            page: 'detail',
            type,
        };
    }
    if (type === 'mods') {
        return {
            page: 'detail',
            type,
        };
    }
    if (type === 'create-character' || type === 'create-story') {
        return {
            page: 'detail',
            type,
        };
    }
    return {
        page: 'browse',
        mode: params.get('mode') === 'characters' ? 'characters' : 'stories',
    };
}

function applyRoute() {
    const route = getRouteFromLocation();
    state.page = route.page;
    state.route = route;
    if (route.mode) {
        state.mode = route.mode;
    }
    if (route.type === 'character') {
        state.mode = 'characters';
        state.selectedId = state.characters.findIndex(character => character.avatar === route.avatar);
    }
    if (route.type === 'chat') {
        state.mode = 'characters';
        state.selectedId = state.characters.findIndex(character => character.avatar === route.avatar);
    }
    if (route.type === 'story') {
        state.mode = 'stories';
        const story = findStoryFromRoute(route);
        state.selectedStoryKey = story ? getStoryKey(story) : '';
    }
    if (route.type === 'create-character') {
        state.mode = 'characters';
    }
    if (route.type === 'create-story') {
        state.mode = 'stories';
    }
    render();
}

function navigateBrowse(mode = state.mode, { replace = false } = {}) {
    state.mode = mode;
    state.page = 'browse';
    state.route = { page: 'browse', mode };
    const url = `/simple?mode=${encodeURIComponent(mode)}`;
    history[replace ? 'replaceState' : 'pushState'](state.route, '', url);
    render();
}

function openCharacterDetail(character) {
    const route = { page: 'detail', type: 'character', avatar: character.avatar };
    history.pushState(route, '', `/simple?type=character&avatar=${encodeURIComponent(character.avatar)}`);
    state.page = 'detail';
    state.route = route;
    state.mode = 'characters';
    state.selectedId = state.characters.indexOf(character);
    render();
}

function openStoryDetail(story) {
    const route = { page: 'detail', type: 'story', avatar: story.avatar || '', group: story.group || '', chat: story.file_id };
    const ownerParam = story.group ? `group=${encodeURIComponent(story.group)}` : `avatar=${encodeURIComponent(story.avatar)}`;
    history.pushState(route, '', `/simple?type=story&${ownerParam}&chat=${encodeURIComponent(story.file_id)}`);
    state.page = 'detail';
    state.route = route;
    state.mode = 'stories';
    state.selectedStoryKey = getStoryKey(story);
    render();
}

function openChatPage(character, story = null) {
    if (!character) {
        setStatus('找不到角色，无法开始互动', 'error');
        return;
    }
    const route = { page: 'detail', type: 'chat', avatar: character.avatar, story: story?.file_id || '' };
    const storyQuery = story ? `&story=${encodeURIComponent(story.file_id)}` : '';
    history.pushState(route, '', `/simple?type=chat&avatar=${encodeURIComponent(character.avatar)}${storyQuery}`);
    state.page = 'detail';
    state.route = route;
    state.mode = 'characters';
    state.selectedId = state.characters.indexOf(character);
    state.chatTarget = character;
    render();
}

function navigateSettings() {
    const route = { page: 'detail', type: 'settings' };
    history.pushState(route, '', '/simple?type=settings');
    state.page = 'detail';
    state.route = route;
    render();
}

function navigateWorldBooks() {
    const route = { page: 'detail', type: 'worldbooks' };
    history.pushState(route, '', '/simple?type=worldbooks');
    state.page = 'detail';
    state.route = route;
    render();
}

function navigateMods() {
    const route = { page: 'detail', type: 'mods' };
    history.pushState(route, '', '/simple?type=mods');
    state.page = 'detail';
    state.route = route;
    render();
}

function navigateCreateCharacter() {
    const route = { page: 'detail', type: 'create-character' };
    history.pushState(route, '', '/simple?type=create-character');
    state.page = 'detail';
    state.route = route;
    state.mode = 'characters';
    render();
}

function navigateCreateStory() {
    const route = { page: 'detail', type: 'create-story' };
    history.pushState(route, '', '/simple?type=create-story');
    state.page = 'detail';
    state.route = route;
    state.mode = 'stories';
    render();
}

async function loadSettings() {
    const data = await apiPost('/api/settings/get');
    state.settings = JSON.parse(data.settings || '{}');
}

async function saveSettings(nextSettings) {
    await apiPost('/api/settings/save', nextSettings);
    state.settings = nextSettings;
}

async function activateCharacter(character) {
    try {
        if (!state.settings) {
            await loadSettings();
        }

        await saveSettings({
            ...state.settings,
            active_character: character.avatar,
            active_group: null,
            power_user: {
                ...(state.settings.power_user || {}),
                auto_load_chat: true,
            },
        });
        setStatus(`已设为当前角色：${character.name || character.avatar}`);
    } catch (error) {
        console.error(error);
        setStatus('设置当前角色失败', 'error');
    }
}

async function activateStory(story) {
    try {
        if (!state.settings) {
            await loadSettings();
        }

        if (story.group) {
            await saveSettings({
                ...state.settings,
                active_character: null,
                active_group: story.group,
                power_user: {
                    ...(state.settings.power_user || {}),
                    auto_load_chat: true,
                },
            });
            setStatus(`已设为当前群组故事：${getStoryTitle(story)}`);
            return;
        }

        const character = getCharacterByAvatar(story.avatar);
        if (!character) {
            throw new Error(`Character not found for ${story.avatar}`);
        }

        await apiPost('/api/characters/merge-attributes', {
            avatar: story.avatar,
            chat: story.file_id,
        });
        character.chat = story.file_id;
        await activateCharacter(character);
        setStatus(`已设为当前故事：${getStoryTitle(story)}`);
    } catch (error) {
        console.error(error);
        setStatus('设置当前故事失败', 'error');
    }
}

async function loadCharacters() {
    const characters = await apiPost('/api/characters/all');
    state.characters = Array.isArray(characters) ? characters.filter(x => x && x.name) : [];
    state.selectedId = state.characters.length ? 0 : null;
}

async function loadGroups() {
    try {
        const groups = await apiPost('/api/groups/all');
        state.groups = Array.isArray(groups) ? groups : [];
    } catch (error) {
        console.warn('Failed to load groups', error);
        state.groups = [];
    }
}

async function loadWorldBooks() {
    try {
        const books = await apiPost('/api/worldinfo/list');
        state.worldBooks = Array.isArray(books) ? books : [];
        if (state.selectedWorldBook && !getWorldBookNames().includes(state.selectedWorldBook)) {
            state.selectedWorldBook = '';
        }
    } catch (error) {
        console.warn('Failed to load world books', error);
        state.worldBooks = [];
        state.selectedWorldBook = '';
    }
}

async function loadStories() {
    try {
        const stories = await apiPost('/api/chats/recent', { max: 500, metadata: true, pinned: [] });
        state.stories = Array.isArray(stories)
            ? stories
                .filter(story => story && story.file_name)
                .map(story => ({
                    ...story,
                    file_id: story.file_id || String(story.file_name).replace(/\.jsonl$/i, ''),
                }))
            : [];
        state.selectedStoryKey = state.stories.length ? getStoryKey(state.stories[0]) : '';
    } catch (error) {
        console.warn('Failed to load stories', error);
        state.stories = [];
        state.selectedStoryKey = '';
    }
}

async function loadAll() {
    setStatus('正在载入本地故事和角色');
    await Promise.all([loadCharacters(), loadGroups(), loadWorldBooks()]);
    await loadStories();
}

async function boot() {
    try {
        const tokenResponse = await fetch('/csrf-token');
        const tokenData = await tokenResponse.json();
        state.token = tokenData.token;
        await Promise.all([loadSettings(), loadAll()]);
        applyRoute();
    } catch (error) {
        console.error(error);
        setStatus('载入失败：请确认已登录并刷新页面', 'error');
        listEl.replaceChildren(emptyTemplate.content.cloneNode(true));
    }
}

document.querySelectorAll('[data-mode]').forEach((button) => {
    button.addEventListener('click', () => {
        state.tab = 'all';
        state.tag = '';
        state.query = '';
        searchInput.value = '';
        navigateBrowse(button.dataset.mode || 'stories');
    });
});

document.querySelectorAll('[data-tab]').forEach((button) => {
    button.addEventListener('click', () => {
        state.tab = button.dataset.tab || 'all';
        navigateBrowse(state.mode, { replace: state.page === 'browse' });
    });
});

searchInput.addEventListener('input', () => {
    state.query = searchInput.value.trim();
    if (state.page === 'browse') {
        render();
    }
});

sortSelect.addEventListener('change', () => {
    state.sort = sortSelect.value;
    if (state.page === 'browse') {
        render();
    }
});

document.getElementById('refresh-button').addEventListener('click', async () => {
    await loadAll();
    render();
});

modelSettingsButton.addEventListener('click', navigateSettings);
modButton.addEventListener('click', navigateMods);
worldBookButton.addEventListener('click', navigateWorldBooks);
createStoryButton.addEventListener('click', navigateCreateStory);
createCharacterButton.addEventListener('click', navigateCreateCharacter);

randomButton.addEventListener('click', () => {
    const items = getFilteredItems();
    if (!items.length) {
        return;
    }
    const item = items[Math.floor(Math.random() * items.length)];
    if (state.mode === 'stories') {
        openStoryDetail(item);
    } else {
        openCharacterDetail(item);
    }
});

backButton.addEventListener('click', () => navigateBrowse(state.mode));

imageToggle.addEventListener('click', () => {
    state.view = state.view === 'no-image' ? 'simple' : 'no-image';
    localStorage.setItem('simpleViewMode', state.view);
    syncViewMode();
});

window.addEventListener('popstate', applyRoute);

syncViewMode();
boot();
