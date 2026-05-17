let peer, conn, wakeLock = null;
let settings = JSON.parse(localStorage.getItem('wpSettings')) || {
    text: '', speed: 2, size: 60, mirrored: false
};
let drafts = JSON.parse(localStorage.getItem('wpDrafts')) || [];
const MAX_DRAFTS = 100;
const NEW_DRAFT_CONFIRM_PREF_KEY = 'wpSkipNewDraftConfirm';
const SECTION_COMPLETION_STORAGE_KEY = 'wpSectionCompletions';
const EMOJI_REGEX = /[\p{Extended_Pictographic}\p{Emoji_Presentation}\uFE0F]/gu;
let markdownSections = [];
let selectedSectionStart = 0;
let hasSelectedSection = false;
let activePrompterText = '';
let outsideClickListenerAttached = false;

const isRemote = new URLSearchParams(window.location.search).has('remote');

// --- COMMON FUNCTIONS ---
const save = () => localStorage.setItem('wpSettings', JSON.stringify(settings));
const saveDrafts = () => localStorage.setItem('wpDrafts', JSON.stringify(drafts));

function createStorageId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function getStoredSectionCompletions() {
    try {
        return JSON.parse(localStorage.getItem(SECTION_COMPLETION_STORAGE_KEY)) || {};
    } catch {
        return {};
    }
}

function saveStoredSectionCompletions(completions) {
    localStorage.setItem(SECTION_COMPLETION_STORAGE_KEY, JSON.stringify(completions));
}

function getScriptInput() {
    return document.getElementById('script-input');
}

function stripEmojis(text) {
    return (text || '').replace(EMOJI_REGEX, '').replace(/\u200D/g, '');
}

function getDraftTitle(text) {
    const firstLine = text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || '';
    const source = firstLine.replace(/^#{1,6}\s+/, '');
    const normalized = source.replace(/\s+/g, ' ').trim();
    if (!normalized) return 'Untitled draft';
    return normalized.length > 25 ? normalized.slice(0, 25) + '...' : normalized;
}

function getMarkdownH2Title(line) {
    const match = line.match(/^##\s+(.+?)\s*#*\s*$/);
    return match ? match[1].trim() : '';
}

function getMarkdownSections(markdown) {
    const headingPattern = /^(#{1,3})\s+(.+)$/gm;
    const matches = [...markdown.matchAll(headingPattern)];
    if (!matches.length) return [];

    const sections = [];
    let hasSeenH1 = false;
    let hasSeenH2 = false;
    let activeH1Title = '';
    let activeH2Title = '';
    const sectionKeyCounts = {};

    const buildSectionKey = (level, path) => {
        const baseKey = `${level}:${path.join('>')}`;
        const count = (sectionKeyCounts[baseKey] || 0) + 1;
        sectionKeyCounts[baseKey] = count;
        return `${baseKey}#${count}`;
    };

    matches.forEach((match, index) => {
        const hashes = match[1];
        const level = hashes.length;
        const title = match[2].trim().replace(/\s*#*\s*$/, '');
        const start = match.index;
        const end = matches[index + 1]?.index ?? markdown.length;

        if (level === 1) {
            hasSeenH1 = true;
            hasSeenH2 = false;
            activeH1Title = title;
            activeH2Title = '';
            sections.push({ title, start, end, level, key: buildSectionKey(level, [title]) });
            return;
        }

        if (level === 2) {
            hasSeenH2 = true;
            activeH2Title = title;
            const path = hasSeenH1 ? [activeH1Title, title] : [title];
            sections.push({ title, start, end, level, key: buildSectionKey(level, path) });
            return;
        }

        // Show H3s under the nearest H2, or under H1 if the document skips H2.
        if (level === 3 && hasSeenH2) {
            const path = hasSeenH1 ? [activeH1Title, activeH2Title, title] : [activeH2Title, title];
            sections.push({ title, start, end, level, key: buildSectionKey(level, path) });
            return;
        }

        if (level === 3 && hasSeenH1) {
            sections.push({ title, start, end, level, key: buildSectionKey(level, [activeH1Title, title]) });
        }
    });

    return sections;
}

function htmlToMarkdown(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const { body } = doc;

    function normalizeInlineText(text) {
        return stripEmojis(text)
            .replace(/\u00a0/g, ' ')
            .replace(/\s+/g, ' ');
    }

    function textFrom(node, options = {}) {
        if (node.nodeType === Node.TEXT_NODE) return normalizeInlineText(node.textContent || '');
        if (node.nodeType !== Node.ELEMENT_NODE) return '';
        const tag = node.tagName.toLowerCase();
        const wordHeadingLevel = getWordHeadingLevel(node);
        if (tag === 'br') return '\n';
        if (tag === 'strong' || tag === 'b') {
            const inner = childrenText(node, options);
            const trimmed = inner.trim();
            if (!trimmed) return inner;
            if (options.stripBold) return inner;
            if (trimmed.startsWith('**') && trimmed.endsWith('**')) return inner;
            return `**${inner}**`;
        }
        if (tag === 'em' || tag === 'i') {
            const inner = childrenText(node, options);
            if (!inner.trim()) return inner;
            return `*${inner}*`;
        }
        if (tag === 'code') return `\`${childrenText(node, options)}\``;
        if (tag === 'a') {
            const href = node.getAttribute('href') || '';
            const label = childrenText(node, options) || href;
            return href ? `[${label}](${href})` : label;
        }
        if (tag === 'h1') return `## ${childrenText(node, { ...options, stripBold: true })}\n\n`;
        if (tag === 'h2') return `## ${childrenText(node, { ...options, stripBold: true })}\n\n`;
        if (tag === 'h3') return `### ${childrenText(node, { ...options, stripBold: true })}\n\n`;
        if (tag === 'h4') return `#### ${childrenText(node, { ...options, stripBold: true })}\n\n`;
        if (tag === 'h5') return `##### ${childrenText(node, { ...options, stripBold: true })}\n\n`;
        if (tag === 'h6') return `###### ${childrenText(node, { ...options, stripBold: true })}\n\n`;
        if (wordHeadingLevel) {
            const markdownLevel = Math.max(2, wordHeadingLevel);
            return `${'#'.repeat(markdownLevel)} ${childrenText(node, { ...options, stripBold: true })}\n\n`;
        }
        if (tag === 'p') return `${childrenText(node, options)}\n\n`;
        if (tag === 'blockquote') return `> ${childrenText(node, options).replace(/\n/g, '\n> ')}\n\n`;
        if (tag === 'ul') return `${listText(node, '- ')}\n`;
        if (tag === 'ol') return `${listText(node, '1. ')}\n`;
        return childrenText(node, options);
    }

    function getWordHeadingLevel(node) {
        const className = node.getAttribute('class') || '';
        const style = node.getAttribute('style') || '';
        const classMatch = className.match(/\b(?:Mso(?:Heading|Title)|Heading)\s*([1-6])?\b/i);
        const outlineMatch = style.match(/mso-outline-level:\s*([1-6])/i);
        const styleNameMatch = style.match(/mso-style-name:\s*['"]?(?:Heading|heading)\s*([1-6])/i);
        if (styleNameMatch) return Number(styleNameMatch[1]);
        if (outlineMatch) return Number(outlineMatch[1]);
        if (!classMatch) return 0;
        return classMatch[1] ? Number(classMatch[1]) : 1;
    }

    function childrenText(node, options = {}) {
        let result = '';
        node.childNodes.forEach((child) => {
            result += textFrom(child, options);
        });
        return result;
    }

    function listText(listNode, prefix) {
        let result = '';
        const items = Array.from(listNode.children).filter((element) => element.tagName.toLowerCase() === 'li');
        items.forEach((item, index) => {
            const actualPrefix = prefix === '1. ' ? `${index + 1}. ` : prefix;
            const text = childrenText(item).trim();
            result += `${actualPrefix}${text}\n`;
        });
        return result;
    }

    return childrenText(body)
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n[ \t]+/g, '\n')
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function normalizePlainPaste(text) {
    if (!text) return '';
    return stripEmojis(text)
        .replace(/\r\n?/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .split('\n\n')
        .map((block) => block.replace(/\n+/g, ' ').replace(/[ \t]{2,}/g, ' ').trim())
        .filter(Boolean)
        .join('\n\n')
        .trim();
}

function htmlToRenderedParagraphText(html) {
    if (!html) return '';
    try {
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const blockTags = new Set([
            'p', 'div', 'article', 'section', 'main', 'aside', 'header', 'footer',
            'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'ul', 'ol', 'blockquote',
            'pre', 'table', 'tr'
        ]);

        function walk(node) {
            if (!node) return '';
            if (node.nodeType === Node.TEXT_NODE) {
                return (node.textContent || '').replace(/\s+/g, ' ');
            }
            if (node.nodeType !== Node.ELEMENT_NODE) return '';

            const tag = node.tagName.toLowerCase();
            if (tag === 'br') return '\n';

            let chunk = '';
            node.childNodes.forEach((child) => {
                chunk += walk(child);
            });

            if (blockTags.has(tag)) {
                const trimmed = chunk.trim();
                return trimmed ? `${trimmed}\n\n` : '';
            }
            return chunk;
        }

        const rendered = walk(doc.body) || doc.body?.innerText || doc.body?.textContent || '';
        return normalizePlainPaste(rendered);
    } catch {
        return '';
    }
}

function getPreferredMarkdownPaste(html, plain) {
    const markdown = htmlToMarkdown(html);
    const normalizedPlain = normalizePlainPaste(plain || '');
    const htmlParagraphText = htmlToRenderedParagraphText(html);
    let preferred = markdown;

    if (normalizedPlain) {
        const plainBlocks = normalizedPlain.split(/\n\n/).length;
        const markdownBlocks = markdown.split(/\n\n/).length;
        if (plainBlocks > 1 && markdownBlocks <= 1) {
            preferred = normalizedPlain;
        }
    }

    if (htmlParagraphText) {
        const htmlBlocks = htmlParagraphText.split(/\n\n/).length;
        const markdownBlocks = markdown.split(/\n\n/).length;
        if (htmlBlocks > 1 && markdownBlocks <= 1) {
            preferred = htmlParagraphText;
        }
    }

    return preferred || htmlParagraphText || normalizedPlain || plain || '';
}

function looksLikeWordHtml(html) {
    return /class="?Mso|mso-|xmlns:o=|urn:schemas-microsoft-com:office|WordSection|name="?Generator"?\s+content="?Microsoft Word/i.test(html || '');
}

function insertTextAtCursor(input, text) {
    const safeText = stripEmojis(text);
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? input.value.length;
    input.setRangeText(safeText, start, end, 'end');
    input.dispatchEvent(new Event('input', { bubbles: true }));
}

function ensureCurrentScriptId() {
    if (!settings.currentScriptId) {
        settings.currentScriptId = createStorageId();
    }
    return settings.currentScriptId;
}

function getActiveSectionCompletionKey() {
    if (settings.activeDraftId && drafts.some((draft) => draft.id === settings.activeDraftId)) {
        return `draft:${settings.activeDraftId}`;
    }
    return `current:${ensureCurrentScriptId()}`;
}

function isSectionCompleted(sectionKey) {
    const completions = getStoredSectionCompletions();
    return !!completions[getActiveSectionCompletionKey()]?.[sectionKey];
}

function setSectionCompleted(sectionKey, isCompleted) {
    const fileKey = getActiveSectionCompletionKey();
    const completions = getStoredSectionCompletions();
    completions[fileKey] = completions[fileKey] || {};

    if (isCompleted) {
        completions[fileKey][sectionKey] = true;
    } else {
        delete completions[fileKey][sectionKey];
        if (!Object.keys(completions[fileKey]).length) {
            delete completions[fileKey];
        }
    }

    saveStoredSectionCompletions(completions);
}

function migrateSectionCompletions(fromKey, toKey, shouldRemoveSource = true) {
    if (!fromKey || !toKey || fromKey === toKey) return;

    const completions = getStoredSectionCompletions();
    if (!completions[fromKey]) return;

    completions[toKey] = {
        ...(completions[toKey] || {}),
        ...completions[fromKey]
    };
    if (shouldRemoveSource) {
        delete completions[fromKey];
    }
    saveStoredSectionCompletions(completions);
}

function syncCurrentText() {
    const input = getScriptInput();
    if (!input) return;
    settings.text = input.value;
    updateSaveButtonState();
    updateSectionOutline();
    save();
}

function updateSectionOutline() {
    const input = getScriptInput();
    const panel = document.getElementById('section-panel');
    const list = document.getElementById('markdown-section-list');
    const button = document.getElementById('section-menu-btn');
    if (!input || !panel || !list || !button) return;

    markdownSections = getMarkdownSections(input.value);
    list.innerHTML = '';

    if (!markdownSections.length) {
        panel.style.display = 'none';
        button.disabled = true;
        button.style.opacity = '0.45';
        selectedSectionStart = 0;
        hasSelectedSection = false;
        return;
    }

    button.disabled = false;
    button.style.opacity = '1';

    if (hasSelectedSection && !markdownSections.some((section) => section.start === selectedSectionStart)) {
        selectedSectionStart = 0;
        hasSelectedSection = false;
    }

    const hasH1Sections = markdownSections.some((section) => section.level === 1);
    markdownSections.forEach((section) => {
        const row = document.createElement('div');
        row.className = 'section-link';
        if (section.level === 2 && hasH1Sections) {
            row.classList.add('section-link-h2');
        }
        if (section.level === 3) {
            row.classList.add('section-link-h3');
        }
        if (hasSelectedSection && section.start === selectedSectionStart) {
            row.classList.add('section-link-active');
        }
        row.onclick = () => selectMarkdownSection(section.start);

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'section-complete-checkbox';
        checkbox.checked = isSectionCompleted(section.key);
        row.classList.toggle('section-link-complete', checkbox.checked);
        checkbox.setAttribute('aria-label', `Mark ${section.title} as recorded`);
        checkbox.onclick = (event) => {
            event.stopPropagation();
            setSectionCompleted(section.key, checkbox.checked);
            row.classList.toggle('section-link-complete', checkbox.checked);
        };

        const titleButton = document.createElement('button');
        titleButton.type = 'button';
        titleButton.className = 'section-title-button';
        titleButton.textContent = section.title;
        titleButton.onclick = (event) => {
            event.stopPropagation();
            selectMarkdownSection(section.start);
        };

        row.appendChild(checkbox);
        row.appendChild(titleButton);
        list.appendChild(row);
    });
}

function toggleSectionMenu(forceOpen = null) {
    const panel = document.getElementById('section-panel');
    const button = document.getElementById('section-menu-btn');
    if (!panel || !button || button.disabled) return;

    const shouldOpen = forceOpen === null ? panel.style.display === 'none' : forceOpen;
    panel.style.display = shouldOpen ? 'block' : 'none';

    if (shouldOpen) updateSectionOutline();
}

function eventTargetsNode(event, node) {
    return !!(node && (event.target === node || node.contains(event.target)));
}

function handleDocumentPointerDown(event) {
    const loadPanel = document.getElementById('draft-list-panel');
    const loadButton = document.getElementById('load-draft-btn');
    const sectionPanel = document.getElementById('section-panel');
    const sectionButton = document.getElementById('section-menu-btn');

    if (
        loadPanel &&
        loadPanel.style.display === 'block' &&
        !eventTargetsNode(event, loadPanel) &&
        !eventTargetsNode(event, loadButton)
    ) {
        toggleDraftList(false);
    }

    if (
        sectionPanel &&
        sectionPanel.style.display === 'block' &&
        !eventTargetsNode(event, sectionPanel) &&
        !eventTargetsNode(event, sectionButton)
    ) {
        toggleSectionMenu(false);
    }
}

function selectMarkdownSection(start) {
    const input = getScriptInput();
    if (!input) return;

    selectedSectionStart = start;
    hasSelectedSection = true;
    input.focus();
    input.setSelectionRange(start, start);

    const textBeforeSection = input.value.slice(0, start);
    const lineCount = textBeforeSection.split('\n').length - 1;
    const styles = window.getComputedStyle(input);
    const lineHeight = parseFloat(styles.lineHeight) || parseFloat(styles.fontSize) * 1.5;
    input.scrollTop = Math.max(0, lineCount * lineHeight - 20);
    updateSectionOutline();
    toggleSectionMenu(false);
}

function updateLoadButtonState() {
    const button = document.getElementById('load-draft-btn');
    if (!button) return;
    button.disabled = drafts.length === 0;
    button.style.opacity = drafts.length === 0 ? '0.45' : '1';
}

function updateSaveButtonState() {
    const input = getScriptInput();
    const button = document.getElementById('save-draft-btn');
    if (!input || !button) return;

    const hasText = input.value.trim().length > 0;
    button.disabled = !hasText;
    button.style.opacity = hasText ? '1' : '0.45';
}

function renderDraftList() {
    const list = document.getElementById('draft-list');
    if (!list) return;

    list.innerHTML = '';

    if (!drafts.length) {
        const empty = document.createElement('div');
        empty.className = 'draft-empty';
        empty.textContent = 'No saved drafts yet.';
        list.appendChild(empty);
        updateLoadButtonState();
        return;
    }

    drafts.forEach((draft) => {
        const row = document.createElement('div');
        row.className = 'draft-row';

        const loadButton = document.createElement('button');
        loadButton.type = 'button';
        loadButton.className = 'draft-load';
        loadButton.textContent = draft.title;
        loadButton.onclick = () => loadDraft(draft.id);

        const deleteButton = document.createElement('button');
        deleteButton.type = 'button';
        deleteButton.className = 'draft-delete';
        deleteButton.setAttribute('aria-label', 'Delete draft');
        const deleteIcon = document.createElement('img');
        deleteIcon.src = 'assets/icons/delete_2_line.svg';
        deleteIcon.alt = '';
        deleteButton.appendChild(deleteIcon);
        deleteButton.onclick = () => deleteDraft(draft.id);

        row.appendChild(loadButton);
        row.appendChild(deleteButton);
        list.appendChild(row);
    });

    updateLoadButtonState();
}

function toggleDraftList(forceOpen = null) {
    const panel = document.getElementById('draft-list-panel');
    if (!panel) return;

    const shouldOpen = forceOpen === null ? panel.style.display === 'none' : forceOpen;
    panel.style.display = shouldOpen ? 'block' : 'none';

    if (shouldOpen) renderDraftList();
}

function saveDraft() {
    const input = getScriptInput();
    if (!input) return;

    const text = input.value.trim();
    if (!text) {
        alert('Write or paste some text before saving a draft.');
        return;
    }

    saveCurrentDraft(input.value);
    settings.text = input.value;
    save();
    updateSaveButtonState();
    renderDraftList();
    toggleDraftList(true);
}

function saveCurrentDraft(text) {
    const trimmed = text.trim();
    if (!trimmed) return false;

    const previousCompletionKey = getActiveSectionCompletionKey();
    const draftId = createStorageId();
    drafts.unshift({
        id: draftId,
        title: getDraftTitle(trimmed),
        text
    });
    settings.activeDraftId = draftId;
    migrateSectionCompletions(
        previousCompletionKey,
        `draft:${draftId}`,
        previousCompletionKey.startsWith('current:')
    );
    drafts = drafts.slice(0, MAX_DRAFTS);
    saveDrafts();
    updateLoadButtonState();
    return true;
}

function removeSectionCompletionForDraft(id) {
    const completions = getStoredSectionCompletions();
    delete completions[`draft:${id}`];
    saveStoredSectionCompletions(completions);
}

function removeSectionCompletionForCurrentScript() {
    if (!settings.currentScriptId) return;

    const completions = getStoredSectionCompletions();
    delete completions[`current:${settings.currentScriptId}`];
    saveStoredSectionCompletions(completions);
}

function showSaveBeforeLoadDialog() {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';

        const dialog = document.createElement('div');
        dialog.className = 'modal-card';
        dialog.setAttribute('role', 'dialog');
        dialog.setAttribute('aria-modal', 'true');

        const message = document.createElement('p');
        message.className = 'modal-message';
        message.textContent = 'Do you want to save current script?';

        const actions = document.createElement('div');
        actions.className = 'modal-actions';

        const cancelButton = document.createElement('button');
        cancelButton.type = 'button';
        cancelButton.className = 'btn modal-btn modal-btn-cancel';
        cancelButton.textContent = 'Cancel';

        const saveButton = document.createElement('button');
        saveButton.type = 'button';
        saveButton.className = 'btn modal-btn modal-btn-ok';
        saveButton.textContent = 'Save';

        const close = (shouldSave) => {
            document.body.removeChild(overlay);
            resolve(shouldSave);
        };

        cancelButton.onclick = () => close(false);
        saveButton.onclick = () => close(true);
        overlay.onclick = (event) => {
            if (event.target === overlay) close(false);
        };

        actions.appendChild(cancelButton);
        actions.appendChild(saveButton);
        dialog.appendChild(message);
        dialog.appendChild(actions);
        overlay.appendChild(dialog);
        document.body.appendChild(overlay);
        cancelButton.focus();
    });
}

function showWordPasteDialog() {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';

        const dialog = document.createElement('div');
        dialog.className = 'modal-card';
        dialog.setAttribute('role', 'dialog');
        dialog.setAttribute('aria-modal', 'true');

        const message = document.createElement('p');
        message.className = 'modal-message';
        message.textContent = 'Would you like to convert this to Markdown or paste it as plain text?';

        const actions = document.createElement('div');
        actions.className = 'modal-actions';

        const plainButton = document.createElement('button');
        plainButton.type = 'button';
        plainButton.className = 'btn modal-btn modal-btn-cancel modal-btn-wide';
        plainButton.textContent = 'Plain text';

        const markdownButton = document.createElement('button');
        markdownButton.type = 'button';
        markdownButton.className = 'btn modal-btn modal-btn-ok modal-btn-wide';
        markdownButton.textContent = 'Markdown';

        const close = (mode) => {
            document.body.removeChild(overlay);
            resolve(mode);
        };

        plainButton.onclick = () => close('plain');
        markdownButton.onclick = () => close('markdown');
        overlay.onclick = (event) => {
            if (event.target === overlay) close('plain');
        };

        actions.appendChild(plainButton);
        actions.appendChild(markdownButton);
        dialog.appendChild(message);
        dialog.appendChild(actions);
        overlay.appendChild(dialog);
        document.body.appendChild(overlay);
    });
}

async function handleScriptPaste(event) {
    const input = getScriptInput();
    const html = event.clipboardData?.getData('text/html') || '';
    const plain = event.clipboardData?.getData('text/plain') || '';
    if (!input || !html || !looksLikeWordHtml(html)) return;

    event.preventDefault();
    const mode = await showWordPasteDialog();
    const text = mode === 'markdown'
        ? getPreferredMarkdownPaste(html, plain)
        : normalizePlainPaste(plain) || htmlToRenderedParagraphText(html) || plain;
    insertTextAtCursor(input, text);
}

async function loadDraft(id) {
    const draft = drafts.find((entry) => entry.id === id);
    const input = getScriptInput();
    if (!draft || !input) return;

    const currentText = input.value;
    const hasCurrentScript = currentText.trim().length > 0;
    const isDifferentDraft = currentText !== draft.text;
    if (hasCurrentScript && isDifferentDraft) {
        const shouldSave = await showSaveBeforeLoadDialog();
        if (!shouldSave) return;
        saveCurrentDraft(currentText);
    }

    input.value = draft.text;
    settings.text = draft.text;
    settings.activeDraftId = draft.id;
    selectedSectionStart = 0;
    hasSelectedSection = false;
    updateSaveButtonState();
    updateSectionOutline();
    save();
    toggleDraftList(false);
}

function deleteDraft(id) {
    drafts = drafts.filter((entry) => entry.id !== id);
    removeSectionCompletionForDraft(id);
    if (settings.activeDraftId === id) {
        delete settings.activeDraftId;
        save();
    }
    saveDrafts();
    if (!drafts.length) {
        toggleDraftList(false);
        updateLoadButtonState();
        return;
    }
    renderDraftList();
}

function shouldSkipNewDraftConfirm() {
    return localStorage.getItem(NEW_DRAFT_CONFIRM_PREF_KEY) === 'true';
}

function setSkipNewDraftConfirm(value) {
    localStorage.setItem(NEW_DRAFT_CONFIRM_PREF_KEY, value ? 'true' : 'false');
}

function showNewDraftConfirmDialog() {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';

        const dialog = document.createElement('div');
        dialog.className = 'modal-card';
        dialog.setAttribute('role', 'dialog');
        dialog.setAttribute('aria-modal', 'true');

        const message = document.createElement('p');
        message.className = 'modal-message';
        message.textContent = 'Clear the current script and start a new draft?';

        const checkboxRow = document.createElement('label');
        checkboxRow.className = 'modal-checkbox';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.id = 'new-draft-confirm-skip';

        const checkboxText = document.createElement('span');
        checkboxText.textContent = "Don't ask me again";

        checkboxRow.appendChild(checkbox);
        checkboxRow.appendChild(checkboxText);

        const actions = document.createElement('div');
        actions.className = 'modal-actions';

        const cancelButton = document.createElement('button');
        cancelButton.type = 'button';
        cancelButton.className = 'btn modal-btn modal-btn-cancel';
        cancelButton.textContent = 'Cancel';

        const okButton = document.createElement('button');
        okButton.type = 'button';
        okButton.className = 'btn modal-btn modal-btn-ok';
        okButton.textContent = 'OK';

        const close = (confirmed) => {
            const skip = checkbox.checked;
            document.body.removeChild(overlay);
            resolve({ confirmed, skip });
        };

        cancelButton.onclick = () => close(false);
        okButton.onclick = () => close(true);
        overlay.onclick = (event) => {
            if (event.target === overlay) close(false);
        };

        actions.appendChild(cancelButton);
        actions.appendChild(okButton);
        dialog.appendChild(message);
        dialog.appendChild(checkboxRow);
        dialog.appendChild(actions);
        overlay.appendChild(dialog);
        document.body.appendChild(overlay);
        cancelButton.focus();
    });
}

async function createNewDraft() {
    const input = getScriptInput();
    if (!input) return;

    const hasText = input.value.trim().length > 0;
    if (hasText && !shouldSkipNewDraftConfirm()) {
        const result = await showNewDraftConfirmDialog();
        if (!result.confirmed) return;
        if (result.skip) setSkipNewDraftConfirm(true);
    }

    if (!settings.activeDraftId) {
        removeSectionCompletionForCurrentScript();
    }
    input.value = '';
    settings.text = '';
    delete settings.activeDraftId;
    settings.currentScriptId = createStorageId();
    selectedSectionStart = 0;
    hasSelectedSection = false;
    updateSaveButtonState();
    updateSectionOutline();
    save();
    toggleDraftList(false);
}

function initEditor() {
    const input = getScriptInput();
    if (!input) return;

    input.value = settings.text;
    ensureCurrentScriptId();
    save();
    input.addEventListener('input', syncCurrentText);
    input.addEventListener('paste', handleScriptPaste);
    updateSaveButtonState();
    renderDraftList();
    updateSectionOutline();
    if (!outsideClickListenerAttached) {
        document.addEventListener('pointerdown', handleDocumentPointerDown);
        outsideClickListenerAttached = true;
    }
}

async function lockWake() {
    try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch {}
}

// --- IPAD (HOST) LOGIC ---
function startHost() {
    const scriptText = document.getElementById('script-input').value;
    settings.text = scriptText;
    activePrompterText = hasSelectedSection ? scriptText.slice(selectedSectionStart) : scriptText;
    save();
    document.getElementById('edit-mode').style.display = 'none';
    document.getElementById('prompter-mode').style.display = 'block';
    updateDisplay();
    updateHUD(); 
    initP2P();
    if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen();
}

function initP2P() {
    const id = 'bliz-' + Math.random().toString(36).substr(2, 5);
    peer = new Peer(id);
    peer.on('open', () => {
        const url = `${window.location.origin}${window.location.pathname}?remote=${id}`;
        new QRCode(document.getElementById("qrcode"), { text: url, width: 256, height: 256 });
        document.getElementById('qr-overlay').style.display = 'flex';
    });
    
    // Listen for incoming connections
    peer.on('connection', c => {
        conn = c;
        setupHostHandlers();
    });
}

function setupHostHandlers() {
    let scrollInterval; // Keep this variable here so we can clear it on disconnect

    conn.on('open', () => {
        // 1. CHANGE TO DOT
        const sb = document.getElementById('status-bar');
        sb.classList.add('status-dot');
        sb.innerText = ''; // Clear text
        
        // Hide QR Overlay
        document.getElementById('qr-overlay').style.display = 'none';
        lockWake();
        
        // Send initial HUD data to remote immediately
        updateHUD();
    });
    
    // 2. DETECT DISCONNECTION
    conn.on('close', () => {
        // Stop scrolling if it was running
        if(scrollInterval) clearInterval(scrollInterval);
        
        // Reset UI: Remove Dot, Show Text
        const sb = document.getElementById('status-bar');
        sb.classList.remove('status-dot');
        sb.innerText = 'WAITING FOR REMOTE...';
        sb.style.background = 'var(--red)'; // Reset to red
        
        // Show QR Code again for reconnection
        document.getElementById('qr-overlay').style.display = 'flex';
    });
    
    conn.on('data', data => {
        /* scroll up logic */
        const container = document.getElementById('scroll-container');
        if (data.action === 'page-up') {
            const scrollAmount = container.clientHeight * 0.8;
            container.scrollBy({ top: -scrollAmount, behavior: 'smooth' });
            // Update HUD after manual scroll to refresh time
            setTimeout(updateHUD, 500);
        }

        /* Toggle Play/Pause */
        if (data.action === 'toggle') {
            if (data.state) {
                let pixelBank = 0; 
                scrollInterval = setInterval(() => {
                    pixelBank += settings.speed;
                    if (pixelBank >= 1) {
                        const pixelsToMove = Math.floor(pixelBank); 
                        document.getElementById('scroll-container').scrollTop += pixelsToMove;
                        pixelBank -= pixelsToMove;
                    }
                    updateHUD();
                }, 20); 
            } else {
                clearInterval(scrollInterval);
            }
        }

        /* Settings Updates */
        if (data.action === 'speed-up') settings.speed += 0.25;
        if (data.action === 'speed-down') settings.speed = Math.max(0.25, settings.speed - 0.25);
        if (data.action === 'size-up') settings.size += 5;
        if (data.action === 'size-down') settings.size = Math.max(20, settings.size - 5);
        if (data.action === 'mirror') settings.mirrored = !settings.mirrored;
        
        updateDisplay();
        updateHUD();
        save();
    });
}

function updateDisplay() {
    const display = document.getElementById('text-display');
    const container = document.getElementById('scroll-container');
    
    // FIX: Add 4 blank lines to the top ONLY when mirrored
    // This pushes the text into view so the first lines aren't cut off
    const prefix = settings.mirrored ? '\n\n\n\n' : '';
    
    display.innerText = prefix + (activePrompterText || settings.text);
    display.style.fontSize = settings.size + 'px';
    
    container.className = settings.mirrored ? 'mirrored' : '';
}

function updateHUD() {
    // We now send data to the remote instead of updating local DOM
    if (!conn || !conn.open) return;

    const container = document.getElementById('scroll-container');
    let timeStr = "00:00";

    if(container) {
        const pixelsRemaining = container.scrollHeight - container.scrollTop - container.clientHeight;
        
        if (pixelsRemaining > 0) {
            const pixelsPerSecond = settings.speed * 50;
            const secondsLeft = pixelsRemaining / pixelsPerSecond;

            const m = Math.floor(secondsLeft / 60);
            const s = Math.floor(secondsLeft % 60);
            timeStr = `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
        }
    }

    conn.send({
        action: 'hud-update',
        speed: settings.speed.toFixed(2),
        time: timeStr
    });
}

function closePrompter() {
    // 1. Tell the remote we are closing
    if (conn && conn.open) {
        conn.send({ action: 'close' });
    }
    
    // 2. Short delay to ensure message sends, then reload
    setTimeout(() => {
        window.location.reload();
    }, 100);
}
