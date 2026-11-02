'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// ttml-app.js — Main Application Bootstrap for TTML Lyrics Studio
// ─────────────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  initAlbumExplorer();
  initStudioEditor();
  initSweepPlayer();

  // Global Ctrl+S / Cmd+S handler: Silent project save to disk & backend, prevent browser file download dialog
  window.addEventListener('keydown', e => {
    if (e.code === 'KeyS' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      e.stopPropagation();
      if (typeof saveAlbumProjectFile === 'function') {
        saveAlbumProjectFile(false);
      }
    }
  }, { capture: true });

  // Global Language & Model Persistence (Project-Wide & LocalStorage)
  const langSel = document.getElementById('langSelect');
  const whisperSel = document.getElementById('whisperModelSelect');
  const alignSel = document.getElementById('alignModeSelect');

  const preferredLang = localStorage.getItem('lrc_preferred_lang') || 'de';
  if (langSel) {
    langSel.value = preferredLang;
    langSel.addEventListener('change', async () => {
      const val = langSel.value || 'de';
      localStorage.setItem('lrc_preferred_lang', val);
      if (Studio.project) {
        Studio.project.language = val;
        try {
          await fetch('/api/project/save_project', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(Studio.project),
          });
        } catch (e) {}
      }
      toast(`Global Project Language: ${langSel.options[langSel.selectedIndex]?.text || val}`, 'success');
    });
  }

  const preferredWhisper = localStorage.getItem('lrc_whisper_model') || 'large-v3-turbo';
  if (whisperSel) {
    whisperSel.value = preferredWhisper;
    whisperSel.addEventListener('change', () => {
      localStorage.setItem('lrc_whisper_model', whisperSel.value);
    });
  }

  const preferredAlign = localStorage.getItem('lrc_align_mode') || 'studio_ai';
  if (alignSel) {
    alignSel.value = preferredAlign;
    alignSel.addEventListener('change', () => {
      localStorage.setItem('lrc_align_mode', alignSel.value);
    });
  }

  // Load and display Recent Projects dashboard on Home Setup screen
  if (typeof loadAndRenderRecentProjects === 'function') {
    loadAndRenderRecentProjects();
  }

  // Auto-load project and track from URL query parameter
  const urlParams = new URLSearchParams(window.location.search);
  const projParam = urlParams.get('project');
  const trackParam = urlParams.get('track');
  if (projParam && typeof openProjectFromRecent === 'function') {
    openProjectFromRecent(encodeURIComponent(projParam)).then(async () => {
      if (trackParam && typeof selectTrack === 'function') {
        await selectTrack(trackParam);
      }
    });
  }
});
