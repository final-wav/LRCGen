'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// ttml-app.js — Main Application Bootstrap for TTML Lyrics Studio
// ─────────────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  initAlbumExplorer();
  initStudioEditor();
  initSweepPlayer();

  // Model & Language Selection Change Handlers
  const langSel = document.getElementById('langSelect');
  if (langSel) {
    langSel.addEventListener('change', () => {
      toast(`Language set to ${langSel.value || 'Auto'}`, '');
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
        if (proj.numLanes) Studio.numLanes = Math.max(4, proj.numLanes);
        enterStudioWorkspace();
        renderAlbumSidebar();
        const lastTrackId = localStorage.getItem('lrcgen_active_track_id') || proj.tracks[0].id;
        selectTrack(lastTrackId);
        toast(`Projekt wiederhergestellt: ${proj.title || 'Projekt'}`, 'success');
      }
    } catch (e) {
      console.warn('Session restore error:', e);
    }
  })();
});
