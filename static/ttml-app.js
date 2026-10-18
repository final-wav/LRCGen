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

  // Auto-Restore Active Session upon Page Reload
  (async function restoreSession() {
    try {
      let proj = null;
      const saved = localStorage.getItem('lrcgen_active_project');
      if (saved) {
        proj = JSON.parse(saved);
      } else {
        // Fallback: fetch latest project stored in backend
        const res = await fetch('/api/project_latest');
        if (res.ok) {
          proj = await res.json();
          if (proj) localStorage.setItem('lrcgen_active_project', JSON.stringify(proj));
        }
      }

      if (proj && proj.tracks && proj.tracks.length > 0) {
        Studio.project = proj;
        if (proj.language) {
          if (langSel) langSel.value = proj.language;
          localStorage.setItem('lrc_preferred_lang', proj.language);
        } else {
          proj.language = langSel?.value || 'de';
        }
        if (proj.numLanes) Studio.numLanes = Math.max(4, proj.numLanes);
        enterStudioWorkspace();
        renderAlbumSidebar();
        const lastTrackId = localStorage.getItem('lrcgen_active_track_id') || proj.tracks[0].id;
        selectTrack(lastTrackId);
        toast(`Project restored: ${proj.title || 'Project'} [${proj.language?.toUpperCase() || 'DE'}]`, 'success');
      }
    } catch (e) {
      console.warn('Session restore error:', e);
    }
  })();
});
