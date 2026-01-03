/**
 * open-vtt Player
 * 
 * A WebVTT player with W3C standards support for:
 * - <v Speaker> voice spans for dialogue
 * - <v Description> voice spans for audio description
 * - <v Curatorial> voice spans for extended AD
 * - [sound effects] DCMP-style brackets
 * - NOTE blocks for metadata (not displayed)
 * 
 * Features:
 * - Text-to-Speech with dual voices
 * - Interactive transcript with seek-on-click
 * - Automatic pause for extended descriptions
 * 
 * @license MIT
 */

// =============================================================================
// CONFIGURATION
// =============================================================================

// Browser detection for TTS tuning
const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);

const CONFIG = {
    TTS_RATE: isSafari ? 1.2 : 1.4,  // Safari sounds better at 1.2, Chrome needs 1.4
    TTS_FEMALE_VOICES: ['Samantha', 'Microsoft Zira', 'Google US English Female', 'Karen'],
    TTS_MALE_VOICES: ['Alex', 'Daniel', 'Tom', 'Lee', 'Ralph', 'Aaron', 'Microsoft David', 'Google US English Male', 'Fred'],
    DEBUG: true  // Enable for subtitle detection debugging
};

/**
 * Get canonical voice type from a voice name.
 * Uses prefix matching for flexibility.
 */
function getVoiceType(name) {
    const n = name.toLowerCase().trim();
    // Descriptions: visual content narration
    if (n.startsWith('desc') || n.startsWith('visual') || n.startsWith('scene') ||
        n === 'ad') return 'description';
    // Curatorial: extended context, educational notes
    if (n.startsWith('curat') || n.startsWith('extend') || n.startsWith('archiv') ||
        n === 'context' || n === 'historical' || n === 'note') return 'curatorial';
    // Sound effects
    if (n.startsWith('sound') || n === 'sfx' || n === 'fx' || n.startsWith('effect')) return 'sound';
    return null; // Assume it's a speaker name
}

// =============================================================================
// STATE
// =============================================================================

const State = {
    cues: [],
    notes: [],  // NOTE blocks (metadata, not displayed)
    spokenCues: new Set(),   // Track all cues that have been spoken
    lastTime: 0,         // Track previous currentTime to detect skipped cues
    isSpeakingWithPause: false,
    isSpeaking: false,
    speechQueue: [],
    ttsVoiceFemale: null,
    ttsVoiceMale: null,
    ttsEnabled: true,
    hasNativeSubtitles: false,  // True if video has embedded subtitle track
    descDisplayTimeout: null,   // Timeout ID for auto-hiding AD overlay
    descDisplayMaxMs: 5000,     // Max time to show AD overlay (5 seconds)
    overlayShownAt: 0,          // Timestamp when the overlay started showing
    userScrolling: false,       // True if user is manually interacting with transcript
    scrollDebounceTimeout: null // Timeout to reset userScrolling
};

// =============================================================================
// DOM REFERENCES
// =============================================================================

let DOM = {};

function initDOM() {
    DOM = {
        video: document.getElementById('main-video'),
        videoSelect: document.getElementById('video-select'),
        vttSelect: document.getElementById('vtt-select'),
        descDisplay: document.getElementById('desc-display'),
        captionDisplay: document.getElementById('caption-display'),
        transcriptContainer: document.getElementById('transcript-container')
    };
}

// =============================================================================
// LOGGING
// =============================================================================

function log(...args) {
    if (CONFIG.DEBUG) console.log('[open-vtt]', ...args);
}

function warn(...args) {
    console.warn('[open-vtt]', ...args);
}

// =============================================================================
// INITIALIZATION
// =============================================================================

document.addEventListener('DOMContentLoaded', () => {
    initDOM();
    initTTS();
    setupEventListeners();
    fetchFileList();  // Try to load dynamic file list from server
});

/**
 * Fetch file list from config.json
 * Tries local files first (relative paths), falls back to CDN if configured
 */
async function fetchFileList() {
    try {
        const response = await fetch('config.json');
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const config = await response.json();
        const bucket = config['cloud-bucket'];

        if (!bucket) {
            log('No cloud-bucket configured in config.json');
            return;
        }

        // Use localPath for local files, CDN URL for remote
        const baseUrl = bucket.local ? (bucket.localPath || '') : (bucket.url || '');

        if (bucket.video && bucket.video.length > 0) {
            populateDropdown(DOM.videoSelect, bucket.video, baseUrl);
            log(`Loaded ${bucket.video.length} videos (${baseUrl ? 'CDN' : 'local'})`);
        }

        if (bucket.vtt && bucket.vtt.length > 0) {
            populateDropdown(DOM.vttSelect, bucket.vtt, baseUrl);
            log(`Loaded ${bucket.vtt.length} VTT files (${baseUrl ? 'CDN' : 'local'})`);
        }
    } catch (e) {
        console.error('Failed to load config.json:', e);
    }
}

/**
 * Populate a dropdown with file options
 */
function populateDropdown(selectElement, files, baseUrl = '') {
    // Clear existing options except first (placeholder)
    while (selectElement.options.length > 1) {
        selectElement.remove(1);
    }

    files.forEach(file => {
        const option = document.createElement('option');
        const encodedFile = encodeURIComponent(file);
        option.value = baseUrl ? `${baseUrl}/${encodedFile}` : encodedFile;
        option.textContent = file;
        selectElement.appendChild(option);
    });
}

// =============================================================================
// EVENT LISTENERS
// =============================================================================

function setupEventListeners() {
    // Video source change
    DOM.videoSelect.addEventListener('change', (e) => {
        if (!e.target.value) return;
        DOM.video.src = e.target.value;
        DOM.video.load();
        DOM.video.currentTime = 0;
    });

    // VTT file change
    DOM.vttSelect.addEventListener('change', (e) => {
        if (!e.target.value) return;
        State.spokenCues.clear();
        cancelSpeech();
        DOM.video.currentTime = 0;
        loadVTT(e.target.value);
    });

    // Stop TTS when user manually pauses
    DOM.video.addEventListener('pause', () => {
        if (!State.isSpeakingWithPause) {
            cancelSpeech();
        }
    });

    // Detect native subtitle tracks when video loads
    DOM.video.addEventListener('loadedmetadata', detectNativeSubtitles);

    // Reset state when seeking (so cues can replay)
    DOM.video.addEventListener('seeking', () => {
        cancelSpeech();
        State.spokenCues.clear();  // Allow cues to replay after seek
        State.lastTime = DOM.video.currentTime;
    });

    // Sync overlays and TTS
    DOM.video.addEventListener('timeupdate', onTimeUpdate);

    // Transcript interaction listeners (debounced auto-scroll)
    // We listen for direct user inputs to distinguish from automated scrolling
    ['wheel', 'touchmove', 'mousedown', 'keydown'].forEach(evt => {
        DOM.transcriptContainer.addEventListener(evt, () => {
            State.userScrolling = true;
            if (State.scrollDebounceTimeout) {
                clearTimeout(State.scrollDebounceTimeout);
            }
            State.scrollDebounceTimeout = setTimeout(() => {
                State.userScrolling = false;
            }, 2000); // 2 second debounce
        }, { passive: true });
    });
}

/**
 * Detect if the video has embedded subtitle tracks
 * If so, we'll skip VTT subtitle display to avoid duplication
 */
function detectNativeSubtitles() {
    State.hasNativeSubtitles = false;

    const tracks = DOM.video.textTracks;
    if (!tracks || tracks.length === 0) {
        log('No embedded text tracks found');
        return;
    }

    for (let i = 0; i < tracks.length; i++) {
        const track = tracks[i];
        log(`Found track: ${track.kind} - ${track.label} - mode: ${track.mode}`);

        // Detect ANY subtitle/caption track - embedded mov_text may not be 'showing' in textTracks
        // but the browser still renders them natively
        if (track.kind === 'subtitles' || track.kind === 'captions') {
            State.hasNativeSubtitles = true;
            log('Native subtitles detected - disabling VTT subtitle display');
            break;
        }
    }
}

// =============================================================================
// CUE DETECTION HELPERS
// =============================================================================

/**
 * Check if a cue is active at the given time
 */
function isCueActive(cue, time) {
    return time >= cue.start && time <= cue.end;
}

/**
 * Check if we just crossed a cue's start time (for short cues that might be skipped)
 */
function justCrossedCue(cue, lastTime, currentTime) {
    return lastTime < cue.start && currentTime >= cue.start && currentTime < cue.start + 0.5;
}

/**
 * Find active description/curatorial cues (with catchup for short cues)
 */
function findActiveDescCues(currentTime, lastTime) {
    return State.cues.filter(c =>
        (c.type === 'description' || c.type === 'curatorial') &&
        (isCueActive(c, currentTime) || justCrossedCue(c, lastTime, currentTime))
    );
}

/**
 * Check if TTS would collide with any subtitle (active or upcoming)
 */
function hasSubtitleCollision(time) {
    return State.cues.some(c =>
        c.type === 'subtitle' && (
            isCueActive(c, time) ||
            (c.start > time && c.start < time + 0.5)
        )
    );
}

/**
 * Update the description overlay visibility and styling
 */
function updateOverlay(cue, visible) {
    if (visible && cue) {
        DOM.descDisplay.innerText = cue.text;
        DOM.descDisplay.classList.add('visible');
        DOM.descDisplay.classList.toggle('curatorial', cue.type === 'curatorial');
    } else {
        DOM.descDisplay.classList.remove('visible', 'curatorial');
    }
}

// =============================================================================
// TIME UPDATE HANDLER
// =============================================================================

function onTimeUpdate() {
    const currentTime = DOM.video.currentTime;
    const lastTime = State.lastTime;
    State.lastTime = currentTime;

    // Find active cues
    const activeDescs = findActiveDescCues(currentTime, lastTime);

    // Prioritize curatorial cues for display (they pause video)
    const curatorialCue = activeDescs.find(c => c.type === 'curatorial');
    const displayCue = curatorialCue || activeDescs[0] || State.cues.find(c =>
        c.type === 'sound' && isCueActive(c, currentTime)
    );

    // Handle display cue
    if (displayCue) {
        updateOverlay(displayCue, true);
    }

    // Trigger TTS for ALL active desc/curatorial cues (not just the displayed one)
    for (const cue of activeDescs) {
        triggerTTSIfNeeded(cue);
    }

    // Collision detection: pause if TTS speaking and subtitle active/upcoming
    if (State.isSpeaking && !State.isSpeakingWithPause && hasSubtitleCollision(currentTime)) {
        log('Subtitle collision - pausing for TTS');
        pauseVideo();
        State.isSpeakingWithPause = true;
    }

    // Hide overlay only if no cue AND not speaking at all
    if (!displayCue && !State.isSpeaking) {
        updateOverlay(null, false);
        clearDescTimeout();
    }

    // Update subtitle overlay
    const activeCaption = State.cues.find(c => c.type === 'subtitle' && isCueActive(c, currentTime));
    if (!State.hasNativeSubtitles && activeCaption) {
        DOM.captionDisplay.innerText = activeCaption.text;
        DOM.captionDisplay.classList.add('visible');
    } else {
        DOM.captionDisplay.classList.remove('visible');
    }

    highlightActiveCue(currentTime);
}

/**
 * Trigger TTS for a cue if not already spoken
 */
function triggerTTSIfNeeded(cue) {
    if (State.spokenCues.has(cue) || !State.ttsEnabled || State.isSpeakingWithPause) return;

    State.spokenCues.add(cue);
    resetDescTimeout();

    // Start TTS: description = female, curatorial = male
    if (cue.type === 'description') {
        speakDescription(cue.text);
    } else if (cue.type === 'curatorial') {
        queueSpeech(cue.text, false);
    }
}

/**
 * Reset the overlay auto-hide timeout
 */
function resetDescTimeout() {
    if (State.descDisplayTimeout) clearTimeout(State.descDisplayTimeout);
    State.overlayShownAt = Date.now();
    State.descDisplayTimeout = setTimeout(() => {
        // Only hide if NOT speaking (give TTS priority)
        if (!State.isSpeaking) {
            updateOverlay(null, false);
        }
    }, State.descDisplayMaxMs);
}

/**
 * Clear the overlay timeout
 */
function clearDescTimeout() {
    if (State.descDisplayTimeout) {
        clearTimeout(State.descDisplayTimeout);
        State.descDisplayTimeout = null;
    }
}

function highlightActiveCue(currentTime) {
    let firstActiveScrolled = false;

    document.querySelectorAll('.transcript-cue').forEach((el, index) => {
        const cue = State.cues[index];
        const isActive = cue && currentTime >= cue.start && currentTime <= cue.end;

        if (isActive) {
            if (!el.classList.contains('active')) {
                el.classList.add('active');
            }
            // Only auto-scroll if user is not manually interacting
            if (!firstActiveScrolled && !State.userScrolling) {
                el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                firstActiveScrolled = true;
            }
        } else {
            el.classList.remove('active');
        }
    });
}

// =============================================================================
// TEXT-TO-SPEECH
// =============================================================================

function initTTS() {
    if (!window.speechSynthesis) {
        warn('Speech Synthesis not supported');
        State.ttsEnabled = false;
        return;
    }

    loadVoices();
    window.speechSynthesis.onvoiceschanged = loadVoices;
}

function loadVoices() {
    const voices = window.speechSynthesis.getVoices();
    if (voices.length === 0) return;

    log('Available voices:', voices.map(v => v.name).join(', '));

    State.ttsVoiceFemale = findVoice(voices, CONFIG.TTS_FEMALE_VOICES) ||
        voices.find(v => v.lang.startsWith('en'));

    State.ttsVoiceMale = findVoice(voices, CONFIG.TTS_MALE_VOICES) ||
        voices.find(v => v.lang.startsWith('en') && v !== State.ttsVoiceFemale) ||
        State.ttsVoiceFemale;

    log('Female voice:', State.ttsVoiceFemale?.name || 'none');
    log('Male voice:', State.ttsVoiceMale?.name || 'none');
}

function findVoice(voices, preferredNames) {
    for (const name of preferredNames) {
        const voice = voices.find(v => v.name.includes(name));
        if (voice) return voice;
    }
    return null;
}

function cancelSpeech() {
    window.speechSynthesis?.cancel();
    State.speechQueue = [];
    State.isSpeaking = false;
    State.isSpeakingWithPause = false;
}

function queueSpeech(text, useFemaleVoice = true) {
    if (!window.speechSynthesis || !State.ttsEnabled || !text) return;

    if (State.isSpeaking) {
        pauseVideo();
        State.isSpeakingWithPause = true;
        State.speechQueue.push({ text, useFemaleVoice });
    } else {
        startSpeech(text, useFemaleVoice);
    }
}

function startSpeech(text, useFemaleVoice) {
    State.isSpeaking = true;

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.voice = useFemaleVoice ? State.ttsVoiceFemale : State.ttsVoiceMale;
    utterance.rate = CONFIG.TTS_RATE;

    const timeoutMs = Math.max(5000, text.length * 50);
    let completed = false;
    let timeoutId = null;

    const onSpeechComplete = () => {
        if (completed) return;
        completed = true;
        if (timeoutId) clearTimeout(timeoutId);

        State.isSpeaking = false;

        if (State.speechQueue.length > 0) {
            const next = State.speechQueue.shift();
            startSpeech(next.text, next.useFemaleVoice);
        } else {
            State.isSpeakingWithPause = false;

            // Fade out overlay ONLY if the minimum display time has passed
            // If it hasn't, the existing timeout from resetDescTimeout will handle it
            if (State.overlayShownAt && (Date.now() - State.overlayShownAt >= State.descDisplayMaxMs)) {
                DOM.descDisplay.classList.remove('visible');
                DOM.descDisplay.classList.remove('curatorial');
            }

            playVideo();
        }
    };

    utterance.onend = onSpeechComplete;
    utterance.onerror = (e) => {
        warn('TTS error:', e);
        onSpeechComplete();
    };

    timeoutId = setTimeout(() => {
        warn('TTS timeout');
        onSpeechComplete();
    }, timeoutMs);

    window.speechSynthesis.speak(utterance);
}

function speakDescription(text) {
    queueSpeech(text, true);
}

function speakWithPause(text, useFemaleVoice = false) {
    if (!window.speechSynthesis || !State.ttsEnabled) {
        State.isSpeakingWithPause = true;
        pauseVideo();
        setTimeout(() => {
            State.isSpeakingWithPause = false;
            playVideo();
        }, 2000);
        return;
    }

    pauseVideo();
    State.isSpeakingWithPause = true;

    if (State.isSpeaking) {
        State.speechQueue.push({ text, useFemaleVoice });
    } else {
        startSpeech(text, useFemaleVoice);
    }
}

// =============================================================================
// VIDEO CONTROLS
// =============================================================================

function playVideo() {
    const promise = DOM.video.play();
    if (promise) {
        promise.catch(err => warn('Play blocked:', err.message));
    }
}

function pauseVideo() {
    try {
        DOM.video.pause();
    } catch (err) {
        warn('Pause error:', err);
    }
}

function seekTo(time) {
    return new Promise(resolve => {
        const onSeeked = () => {
            DOM.video.removeEventListener('seeked', onSeeked);
            resolve();
        };
        DOM.video.addEventListener('seeked', onSeeked);
        DOM.video.currentTime = time;
    });
}

// =============================================================================
// VTT LOADING & PARSING (W3C WebVTT Standards)
// =============================================================================

function loadVTT(filename) {
    DOM.transcriptContainer.innerHTML = '<div class="empty-state">Loading...</div>';

    fetch(filename)
        .then(r => r.text())
        .then(vttText => {
            const parsed = parseVTT(vttText);
            State.cues = parsed.cues;
            State.notes = parsed.notes;

            const counts = {};
            State.cues.forEach(c => counts[c.type] = (counts[c.type] || 0) + 1);
            log('Loaded cues:', counts);
            log('Notes:', State.notes.length);

            renderTranscript();
        })
        .catch(err => {
            warn('Failed to load VTT:', err);
            DOM.transcriptContainer.innerHTML = '<div class="empty-state">Failed to load annotations.</div>';
        });
}

/**
 * Parse W3C WebVTT format with support for:
 * - <v VoiceType>text</v> voice spans
 * - [sound effects] DCMP brackets
 * - NOTE blocks (metadata)
 * - Plain text (defaults to subtitle)
 */
function parseVTT(vttText) {
    const lines = vttText.split('\n');
    const cues = [];
    const notes = [];
    const timeRegex = /(\d{1,2}:\d{2}(?::\d{2})?(?:\.\d{1,3})?) --> (\d{1,2}:\d{2}(?::\d{2})?(?:\.\d{1,3})?)/;

    let i = 0;
    let currentNote = null;

    // Skip WEBVTT header
    while (i < lines.length && !lines[i].includes('-->')) {
        if (lines[i].trim().startsWith('NOTE')) {
            currentNote = { text: '', confidence: null };
            // Extract confidence if present: NOTE confidence=0.8
            const confMatch = lines[i].match(/confidence=(\d+\.?\d*)/);
            if (confMatch) {
                currentNote.confidence = parseFloat(confMatch[1]);
            }
        } else if (currentNote && lines[i].trim()) {
            currentNote.text += (currentNote.text ? '\n' : '') + lines[i].trim();
        } else if (currentNote && !lines[i].trim()) {
            notes.push(currentNote);
            currentNote = null;
        }
        i++;
    }

    // Parse cue blocks
    while (i < lines.length) {
        const line = lines[i].trim();

        // Handle NOTE blocks
        if (line.startsWith('NOTE')) {
            currentNote = { text: '', confidence: null };
            const confMatch = line.match(/confidence=(\d+\.?\d*)/);
            if (confMatch) {
                currentNote.confidence = parseFloat(confMatch[1]);
            }
            i++;
            // Collect NOTE content until blank line
            while (i < lines.length && lines[i].trim()) {
                currentNote.text += (currentNote.text ? '\n' : '') + lines[i].trim();
                i++;
            }
            notes.push(currentNote);
            currentNote = null;
            continue;
        }

        // Check for timestamp line
        const timeMatch = timeRegex.exec(line);
        if (!timeMatch) {
            i++;
            continue;
        }

        const start = parseTimeStr(timeMatch[1]);
        const end = parseTimeStr(timeMatch[2]);
        i++;

        // Collect cue content lines until blank line or next timestamp
        const contentLines = [];
        while (i < lines.length && lines[i].trim() && !timeRegex.test(lines[i]) && !lines[i].startsWith('NOTE')) {
            contentLines.push(lines[i]);
            i++;
        }

        // Parse joined content to handle multiline tags
        const fullContent = contentLines.join('\n');
        const parsed = parseVoiceSpans(fullContent);

        for (const item of parsed) {
            if (item.text) {
                cues.push({ start, end, text: item.text, type: item.type, speaker: item.speaker });
            }
        }
    }

    // Sort cues by start time
    cues.sort((a, b) => a.start - b.start);

    return { cues, notes };
}

/**
 * Parse a line for W3C voice spans and DCMP brackets
 * Supports: <v Description>text</v>, <v Speaker Name>text</v>, [sound effect]
 */
function parseVoiceSpans(line) {
    const results = [];

    // Regex for <v VoiceName>content</v> - handles multiline content
    const voiceSpanRegex = /<v\s+([^>]+)>([\s\S]*?)<\/v>/gi;

    let lastIndex = 0;
    let match;

    // First, extract all voice spans
    while ((match = voiceSpanRegex.exec(line)) !== null) {
        // Add any text before this span
        if (match.index > lastIndex) {
            const beforeText = line.slice(lastIndex, match.index).trim();
            if (beforeText) {
                results.push(...parsePlainContent(beforeText));
            }
        }

        const voiceName = match[1].trim();
        const content = match[2].trim();
        const mappedType = getVoiceType(voiceName);

        if (mappedType) {
            // Known type: Description, Curatorial, Sound
            results.push({
                type: mappedType,
                text: content,
                speaker: null
            });
        } else {
            // Assume it's a speaker name
            results.push({
                type: 'subtitle',
                text: content,
                speaker: voiceName
            });
        }

        lastIndex = match.index + match[0].length;
    }

    // Process remaining text after last voice span
    if (lastIndex < line.length) {
        const remaining = line.slice(lastIndex).trim();
        if (remaining) {
            results.push(...parsePlainContent(remaining));
        }
    }

    // If no voice spans found and we haven't processed anything yet, parse entire text
    if (results.length === 0 && line.trim()) {
        results.push(...parsePlainContent(line));
    }

    return results;
}

/**
 * Parse plain content for DCMP brackets and legacy [label] format
 */
/**
 * Parse plain content handling multiline text, brackets, and legacy formats
 */
function parsePlainContent(text) {
    const lines = text.split('\n');
    const results = [];

    // Buffer for assembling multi-line subtitle cues
    let currentSubtitle = { text: [], speaker: null };

    const flushSubtitle = () => {
        if (currentSubtitle.text.length > 0) {
            results.push({
                type: 'subtitle',
                text: currentSubtitle.text.join('\n'),
                speaker: currentSubtitle.speaker
            });
            currentSubtitle = { text: [], speaker: null };
        }
    };

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        // 1. Check for [Sound] full line - simple heuristic: lowercase bracket content = sound
        const bracketMatch = trimmed.match(/^\[([^\]]+)\]$/);
        if (bracketMatch) {
            const content = bracketMatch[1].trim();
            // Sound heuristic: all lowercase or contains common markers
            const isSound = content === content.toLowerCase() ||
                content.toLowerCase().startsWith('sound:') ||
                content.toLowerCase().startsWith('sfx:');

            if (isSound) {
                flushSubtitle();
                results.push({ type: 'sound', text: content, speaker: null });
                continue;
            } else if (content.length > 3 && content[0] === content[0].toUpperCase()) {
                // Heuristic: Capitalized bracket content is likely a description (e.g. [A close-up...])
                flushSubtitle();
                results.push({ type: 'description', text: content, speaker: null });
                continue;
            }
        }

        // 2. Check for legacy [Label] Content format
        const legacyMatch = trimmed.match(/^\[([^\]]+)\]\s*(.*)$/);
        if (legacyMatch) {
            const label = legacyMatch[1].trim();
            const content = legacyMatch[2].trim();
            const labelType = getVoiceType(label);

            if (labelType && labelType !== 'sound') {
                flushSubtitle();
                results.push({ type: labelType, text: content || label, speaker: null });
                continue;
            }
        }

        // 3. Check for SPEAKER: format
        const speakerMatch = trimmed.match(/^([A-Z][A-Z\s]+):\s*(.+)$/);
        if (speakerMatch) {
            if (currentSubtitle.text.length > 0) {
                flushSubtitle();
            }
            currentSubtitle.speaker = speakerMatch[1].trim();
            currentSubtitle.text.push(speakerMatch[2].trim());
            continue;
        }

        // 4. Default: Append line to current subtitle buffer
        currentSubtitle.text.push(trimmed);
    }

    flushSubtitle();
    return results;
}

// =============================================================================
// TIME UTILITIES
// =============================================================================

function parseTimeStr(str) {
    const parts = str.split(':').map(parseFloat);
    if (parts.length === 2) {
        return parts[0] * 60 + parts[1];
    }
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
}

function formatTime(secs) {
    const hrs = Math.floor(secs / 3600);
    const mins = Math.floor((secs % 3600) / 60);
    const s = Math.floor(secs % 60);

    if (hrs > 0) {
        return `${hrs}:${mins.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    }
    return `${mins.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

// =============================================================================
// TRANSCRIPT RENDERING
// =============================================================================

function renderTranscript() {
    DOM.transcriptContainer.innerHTML = '';

    if (State.cues.length === 0) {
        DOM.transcriptContainer.innerHTML = '<div class="empty-state">No cues found.</div>';
        return;
    }

    // Use DocumentFragment for fast batch insertion (fixes Chrome lag)
    const fragment = document.createDocumentFragment();

    State.cues.forEach(cue => {
        const el = document.createElement('div');
        el.className = 'transcript-cue';

        // Format speaker if present
        const speakerPrefix = cue.speaker ? `<span class="cue-speaker">${cue.speaker}:</span> ` : '';

        el.innerHTML = `
            <div class="cue-time">${formatTime(cue.start)}</div>
            <div class="cue-text ${cue.type}">${speakerPrefix}<span class="cue-content"></span></div>
        `;
        el.querySelector('.cue-content').textContent = cue.text;

        el.addEventListener('click', () => onCueClick(cue));
        fragment.appendChild(el);
    });

    DOM.transcriptContainer.appendChild(fragment);
}

async function onCueClick(cue) {
    if (cue.type === 'curatorial') {
        State.isSpeakingWithPause = true;
    }

    pauseVideo();
    await seekTo(cue.start);

    if (cue.type === 'curatorial') {
        State.spokenCues.add(cue);
        speakWithPause(cue.text);
    } else {
        State.isSpeakingWithPause = false;
        playVideo();
    }
}

// =============================================================================
// PUBLIC API (for external use)
// =============================================================================

window.OpenVTT = {
    loadVideo: (src) => {
        DOM.video.src = src;
        DOM.video.load();
    },
    loadVTT: loadVTT,
    play: playVideo,
    pause: pauseVideo,
    seekTo: seekTo,
    getCues: () => State.cues,
    getNotes: () => State.notes,
    setTTSEnabled: (enabled) => { State.ttsEnabled = enabled; },
    setTTSRate: (rate) => { CONFIG.TTS_RATE = rate; }
};
