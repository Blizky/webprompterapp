let peer, conn, wakeLock = null;
let settings = JSON.parse(localStorage.getItem('wpSettings')) || {
    text: '', speed: 2, size: 60, mirrored: false
};
let drafts = JSON.parse(localStorage.getItem('wpDrafts')) || [];
const MAX_DRAFTS = 100;
let markdownSections = [];
let selectedSectionStart = 0;
let hasSelectedSection = false;
let activePrompterText = '';

const isRemote = new URLSearchParams(window.location.search).has('remote');

// --- COMMON FUNCTIONS ---
const save = () => localStorage.setItem('wpSettings', JSON.stringify(settings));
const saveDrafts = () => localStorage.setItem('wpDrafts', JSON.stringify(drafts));

function getScriptInput() {
    return document.getElementById('script-input');
}

function getDraftTitle(text) {
    const headingMatch = text.match(/^#{1,6}\s+(.+)$/m);
    const source = headingMatch ? headingMatch[1] : text;
    const normalized = source.replace(/\s+/g, ' ').trim();
    if (!normalized) return 'Untitled draft';
    return normalized.length > 25 ? normalized.slice(0, 25) + '...' : normalized;
}

function getMarkdownH2Title(line) {
    const match = line.match(/^##\s+(.+?)\s*#*\s*$/);
    return match ? match[1].trim() : '';
}

function getMarkdownSections(markdown) {
    const headingPattern = /^(#{2,3})\s+(.+)$/gm;
    const matches = [...markdown.matchAll(headingPattern)];
    if (!matches.length) return [];

    const sections = [];
    let hasSeenH2 = false;

    matches.forEach((match, index) => {
        const hashes = match[1];
        const level = hashes.length;
        const title = match[2].trim().replace(/\s*#*\s*$/, '');
        const start = match.index;
        const end = matches[index + 1]?.index ?? markdown.length;

        if (level === 2) {
            hasSeenH2 = true;
            sections.push({ title, start, end, level });
            return;
        }

        // Only show H3s under an existing H2 tree.
        if (level === 3 && hasSeenH2) {
            sections.push({ title, start, end, level });
        }
    });

    return sections;
}

function syncCurrentText() {
    const input = getScriptInput();
    if (!input) return;
    settings.text = input.value;
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

    markdownSections.forEach((section) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'section-link';
        if (section.level === 3) {
            button.classList.add('section-link-h3');
        }
        if (hasSelectedSection && section.start === selectedSectionStart) {
            button.classList.add('section-link-active');
        }
        button.textContent = section.title;
        button.onclick = () => selectMarkdownSection(section.start);
        list.appendChild(button);
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

    const draft = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        title: getDraftTitle(text),
        text: input.value
    };

    drafts.unshift(draft);
    drafts = drafts.slice(0, MAX_DRAFTS);
    settings.text = input.value;
    save();
    saveDrafts();
    renderDraftList();
    toggleDraftList(true);
}

function loadDraft(id) {
    const draft = drafts.find((entry) => entry.id === id);
    const input = getScriptInput();
    if (!draft || !input) return;

    input.value = draft.text;
    settings.text = draft.text;
    selectedSectionStart = 0;
    hasSelectedSection = false;
    updateSectionOutline();
    save();
    toggleDraftList(false);
}

function deleteDraft(id) {
    drafts = drafts.filter((entry) => entry.id !== id);
    saveDrafts();
    if (!drafts.length) {
        toggleDraftList(false);
        updateLoadButtonState();
        return;
    }
    renderDraftList();
}

function createNewDraft() {
    const input = getScriptInput();
    if (!input) return;

    const hasText = input.value.trim().length > 0;
    if (hasText && !confirm('Clear the current script and start a new draft?')) {
        return;
    }

    input.value = '';
    settings.text = '';
    selectedSectionStart = 0;
    hasSelectedSection = false;
    updateSectionOutline();
    save();
    toggleDraftList(false);
}

function initEditor() {
    const input = getScriptInput();
    if (!input) return;

    input.value = settings.text;
    input.addEventListener('input', syncCurrentText);
    renderDraftList();
    updateSectionOutline();
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
