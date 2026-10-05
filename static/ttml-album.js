'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// ttml-album.js — Album Explorer, Multi-Track Upload, Auto-Pairing & Batch Export
// ─────────────────────────────────────────────────────────────────────────────

function initAlbumExplorer() {
  // ── Audio Upload Inputs
  const audioFolderInp = document.getElementById('audioFolderInput');
  const audioFilesInp  = document.getElementById('audioFilesInput');
  const sidebarAudioInp = document.getElementById('sidebarAudioInput');
  const audioDropCard  = document.getElementById('audioDropCard');

  if (audioFolderInp)  audioFolderInp.addEventListener('change',  e => handleAudioUpload(e.target.files));
  if (audioFilesInp)   audioFilesInp.addEventListener('change',   e => handleAudioUpload(e.target.files));
  if (sidebarAudioInp) sidebarAudioInp.addEventListener('change', e => handleAudioUpload(e.target.files));

  if (audioDropCard) {
    audioDropCard.addEventListener('dragover', e => { e.preventDefault(); audioDropCard.classList.add('drag-over'); });
    audioDropCard.addEventListener('dragleave', () => audioDropCard.classList.remove('drag-over'));
    audioDropCard.addEventListener('drop', e => {
      e.preventDefault();
      audioDropCard.classList.remove('drag-over');
      if (e.dataTransfer.files && e.dataTransfer.files.length) {
        handleAudioUpload(e.dataTransfer.files);
      }
    });
  }

  // ── Lyrics Upload Inputs
  const lyricsFolderInp = document.getElementById('lyricsFolderInput');
  const lyricsFilesInp  = document.getElementById('lyricsFilesInput');
  const sidebarLyricsInp = document.getElementById('sidebarLyricsInput');
  const lyricsDropCard  = document.getElementById('lyricsDropCard');

  if (lyricsFolderInp)  lyricsFolderInp.addEventListener('change',  e => handleLyricsUpload(e.target.files));
  if (lyricsFilesInp)   lyricsFilesInp.addEventListener('change',   e => handleLyricsUpload(e.target.files));
  if (sidebarLyricsInp) sidebarLyricsInp.addEventListener('change', e => handleLyricsUpload(e.target.files));

  if (lyricsDropCard) {
    lyricsDropCard.addEventListener('dragover', e => { e.preventDefault(); lyricsDropCard.classList.add('drag-over'); });
    lyricsDropCard.addEventListener('dragleave', () => lyricsDropCard.classList.remove('drag-over'));
    lyricsDropCard.addEventListener('drop', e => {
      e.preventDefault();
      lyricsDropCard.classList.remove('drag-over');
      if (e.dataTransfer.files && e.dataTransfer.files.length) {
        handleLyricsUpload(e.dataTransfer.files);
      }
    });
  }

  // Batch Align Whole Album
  const batchAlignBtn = document.getElementById('batchAlignBtn');
  if (batchAlignBtn) {
    batchAlignBtn.addEventListener('click', runBatchAlignAlbum);
  }

  // Export Album ZIP
  const exportZipBtn = document.getElementById('exportAlbumZipBtn');
  if (exportZipBtn) {
    exportZipBtn.addEventListener('click', exportAlbumZip);
  }

  // Save / Load Project Files (.lrcproj)
  document.getElementById('saveProjectBtn')?.addEventListener('click', saveAlbumProjectFile);
  document.getElementById('projectFileInput')?.addEventListener('change', e => {
    if (e.target.files && e.target.files[0]) openAlbumProjectFile(e.target.files[0]);
  });
  document.getElementById('welcomeProjectFileInput')?.addEventListener('change', e => {
    if (e.target.files && e.target.files[0]) openAlbumProjectFile(e.target.files[0]);
  });

  // Proceed to Studio Button
  const openStudioBtn = document.getElementById('openStudioBtn');
  if (openStudioBtn) {
    openStudioBtn.addEventListener('click', () => {
      enterStudioWorkspace();
    });
  }
}

function enterStudioWorkspace() {
  const dropZone = document.getElementById('albumDropZone');
  if (dropZone) dropZone.classList.add('hidden');
  const mainWorkspace = document.getElementById('mainWorkspace');
  if (mainWorkspace) mainWorkspace.classList.remove('hidden');

  if (!Studio.activeTrackId && Studio.project?.tracks?.length > 0) {
    selectTrack(Studio.project.tracks[0].id);
  }
}

async function handleAudioUpload(fileList) {
  if (!fileList || !fileList.length) return;

  const form = new FormData();
  for (let i = 0; i < fileList.length; i++) {
    form.append('files', fileList[i]);
  }

  const loader = document.getElementById('albumLoadingOverlay');
  if (loader) loader.classList.remove('hidden');

  try {
    const resp = await fetch('/api/project/upload_audio', {
      method: 'POST',
      body: form,
    });
    if (!resp.ok) throw new Error(`Audio upload failed: ${resp.statusText}`);
    const data = await resp.json();

    Studio.project = data.project;
    renderAlbumSidebar();

    // Update Card 1 Status
    const audioStatusBox = document.getElementById('audioStatusBox');
    const audioStatusText = document.getElementById('audioStatusText');
    const audioBadge = document.getElementById('audioBadge');
    if (audioStatusBox) audioStatusBox.classList.remove('hidden');
    if (audioStatusText) audioStatusText.textContent = `${Studio.project.tracks.length} Songs geladen (${Studio.project.title || 'Album'})`;
    if (audioBadge) {
      audioBadge.textContent = 'Bereit';
      audioBadge.style.background = 'rgba(20, 115, 230, 0.15)';
      audioBadge.style.color = '#4da3ff';
    }

    // Highlight Card 2 (Lyrics)
    const lyricsCard = document.getElementById('lyricsDropCard');
    if (lyricsCard) {
      lyricsCard.style.borderColor = 'var(--accent)';
    }

    // Show Proceed to Studio Bar
    const setupBar = document.getElementById('setupBottomBar');
    const openStudioBtn = document.getElementById('openStudioBtn');
    if (setupBar) setupBar.classList.remove('hidden');
    if (openStudioBtn) openStudioBtn.textContent = `Weiter zum Studio (${Studio.project.tracks.length} Tracks)`;

    toast(`${Studio.project.tracks.length} Songs geladen. Lyrics-Ordner auswählen oder auf "Weiter zum Studio" klicken.`, 'success');
  } catch (err) {
    toast(`Audio upload error: ${err.message}`, 'error');
  } finally {
    if (loader) loader.classList.add('hidden');
  }
}

async function handleLyricsUpload(fileList) {
  if (!fileList || !fileList.length) return;

  if (!Studio.project || !Studio.project.id) {
    toast('Bitte lade zuerst Audio-Tracks hoch (Schritt 1)!', 'error');
    return;
  }

  const form = new FormData();
  for (let i = 0; i < fileList.length; i++) {
    form.append('files', fileList[i]);
  }

  const loader = document.getElementById('albumLoadingOverlay');
  if (loader) loader.classList.remove('hidden');

  try {
    const resp = await fetch(`/api/project/${Studio.project.id}/upload_lyrics`, {
      method: 'POST',
      body: form,
    });
    if (!resp.ok) throw new Error(`Lyrics upload failed: ${resp.statusText}`);
    const data = await resp.json();

    Studio.project = data.project;
    renderAlbumSidebar();

    // Update Card 2 Status
    const lyricsStatusBox = document.getElementById('lyricsStatusBox');
    const lyricsStatusText = document.getElementById('lyricsStatusText');
    const lyricsBadge = document.getElementById('lyricsBadge');
    if (lyricsStatusBox) lyricsStatusBox.classList.remove('hidden');
    if (lyricsStatusText) lyricsStatusText.textContent = `${data.matched_count} von ${Studio.project.tracks.length} Tracks mit Lyrics verknüpft`;
    if (lyricsBadge) {
      lyricsBadge.textContent = 'Verknüpft';
      lyricsBadge.style.background = 'rgba(20, 115, 230, 0.15)';
      lyricsBadge.style.color = '#4da3ff';
    }

    // Reload active track in editor if already open
    if (Studio.activeTrackId) {
      const tr = getActiveTrack();
      if (tr) refreshEditorViews();
    }

    toast(`Lyrics zugewiesen: ${data.matched_count} Datei(en) verknüpft.`, 'success');
  } catch (err) {
    toast(`Lyrics upload error: ${err.message}`, 'error');
  } finally {
    if (loader) loader.classList.add('hidden');
  }
}

function renderAlbumSidebar() {
  const sidebar = document.getElementById('albumTracklist');
  const titleEl = document.getElementById('albumTitleDisplay');
  const artistEl = document.getElementById('albumArtistDisplay');
  const countEl = document.getElementById('albumTrackCount');

  if (titleEl) titleEl.textContent = Studio.project.title || 'Untitled Album';
  if (artistEl) artistEl.textContent = Studio.project.artist || 'Various Artists';
  if (countEl) countEl.textContent = `${Studio.project.tracks?.length || 0} tracks`;

  if (!sidebar) return;
  sidebar.innerHTML = '';

  (Studio.project.tracks || []).forEach(track => {
    const item = document.createElement('div');
    item.className = 'album-track-item' + (track.id === Studio.activeTrackId ? ' active' : '');
    item.dataset.id = track.id;

    let badgeClass = 'badge-empty';
    let badgeText  = 'No Lyrics';

    if (track.status === 'syllable_synced') {
      badgeClass = 'badge-syllable';
      badgeText  = 'TTML Ready';
    } else if (track.status === 'line_synced') {
      badgeClass = 'badge-line';
      badgeText  = 'Line Synced';
    } else if (track.status === 'raw_lyrics') {
      badgeClass = 'badge-plain';
      badgeText  = 'Plain Text';
    }

    item.innerHTML = `
      <div class="track-nr">${String(track.trackNumber).padStart(2, '0')}</div>
      <div class="track-info-col">
        <div class="track-title-row">
          <span class="track-title">${escHTML(track.title)}</span>
          <span class="track-badge ${badgeClass}">${badgeText}</span>
        </div>
        <div class="track-meta-row">
          <span class="track-artist">${escHTML(track.artist || Studio.project.artist)}</span>
          <span class="track-dur">${track.duration ? fmt(track.duration) : '--:--'}</span>
        </div>
      </div>
    `;

    item.addEventListener('click', () => selectTrack(track.id));
    sidebar.appendChild(item);
  });
}

async function selectTrack(trackId) {
  if (Studio.activeTrackId === trackId && Studio.audio) return;

  // Save changes on previous track
  if (Studio.activeTrackId) {
    await saveActiveTrackToBackend();
  }

  Studio.activeTrackId = trackId;
  const track = getActiveTrack();
  if (!track) return;

  renderAlbumSidebar();

  // Update Track Header
  const titleInp  = document.getElementById('trackTitleInput');
  const artistInp = document.getElementById('trackArtistInput');
  const trackNrEl = document.getElementById('activeTrackNr');
  if (titleInp)  titleInp.value  = track.title || '';
  if (artistInp) artistInp.value = track.artist || Studio.project.artist || '';
  if (trackNrEl) trackNrEl.textContent = `Track ${track.trackNumber}`;

  // Reset History
  Studio.history = [];
  Studio.historyIdx = -1;
  pushHistory();

  // Reset & update track vocals state
  Studio.vocalsUrl = track.vocalsUrl || null;
  Studio.vocalsWavePeaks = null;
  Studio.vocalsAudioBuf = null;
  Studio.useVocalsAudio = false;
  Studio.useVocalsWave = false;
  document.getElementById('vocalsAudioBtn')?.classList.remove('active');
  document.getElementById('waveVocalsBtn')?.classList.remove('active');

  // Load Audio
  if (typeof initStudioAudio === 'function') {
    initStudioAudio(track.audioUrl);
  }

  // Render Views
  refreshEditorViews();
}

async function runBatchAlignAlbum() {
  if (!Studio.project || !Studio.project.tracks) return;
  const btn = document.getElementById('batchAlignBtn');
  const mode = document.getElementById('alignModeSelect')?.value || 'studio_ai';
  const lang = document.getElementById('langSelect')?.value || 'en';
  const whisperModel = document.getElementById('whisperModelSelect')?.value || 'base';

  if (btn) {
    btn.disabled = true;
    btn.textContent = mode === 'studio_ai' ? 'KI Aligning Album…' : 'Fast Aligning Album…';
  }

  let alignedCount = 0;
  for (let i = 0; i < Studio.project.tracks.length; i++) {
    const track = Studio.project.tracks[i];
    if (btn) btn.textContent = `[${i+1}/${Studio.project.tracks.length}] ${track.title}…`;

    try {
      const resp = await fetch(`/api/project/${Studio.project.id}/align_track`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          track_id: track.id,
          mode: mode,
          language: lang,
          use_whisper: mode === 'studio_ai',
          whisper_model: whisperModel,
        }),
      });
      if (resp.ok) {
        const data = await resp.json();
        track.lyrics = data.track.lyrics;
        track.status = data.track.status;
        if (data.vocalsUrl) track.vocalsUrl = data.vocalsUrl;
        alignedCount++;
        renderAlbumSidebar();
      }
    } catch (e) {
      console.warn(`Track ${track.id} alignment error:`, e);
    }
  }

  if (btn) {
    btn.disabled = false;
    btn.textContent = 'Batch Align Album';
  }
  toast(`Batch-Ausrichtung abgeschlossen! (${alignedCount} Tracks verarbeitet)`, 'success');
  refreshEditorViews();
}

async function exportAlbumZip() {
  if (!Studio.project || !Studio.project.tracks || !Studio.project.tracks.length) {
    toast('No tracks to export.', 'error');
    return;
  }

  await saveActiveTrackToBackend();

  try {
    toast('Building Album TTML ZIP…', '');
    const resp = await fetch('/api/export_album_zip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project_id: Studio.project.id,
        tracks: Studio.project.tracks,
        album_name: Studio.project.title || 'Album_TTML',
      }),
    });

    if (!resp.ok) throw new Error('ZIP generation failed.');
    const blob = await resp.blob();
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `${Studio.project.title || 'Album'}_TTML.zip`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    toast('Album TTML ZIP Downloaded!', 'success');
  } catch (err) {
    toast(`Export error: ${err.message}`, 'error');
  }
}

async function exportSingleTrackTTML() {
  const track = getActiveTrack();
  if (!track) return;

  try {
    const resp = await fetch('/api/export_ttml', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lyrics: track.lyrics,
        title:  track.title,
        artist: track.artist || Studio.project.artist,
        album:  Studio.project.title,
      }),
    });
    if (!resp.ok) throw new Error('Export failed');
    const blob = await resp.blob();
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `${track.artist || Studio.project.artist} - ${track.title}.ttml`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    toast('Track TTML Downloaded!', 'success');
  } catch (e) {
    toast(`Export error: ${e.message}`, 'error');
  }
}

// ─── Project File Save & Load (.lrcproj) ────────────────────────────────────
async function saveAlbumProjectFile() {
  if (!Studio.project || !Studio.project.tracks || !Studio.project.tracks.length) {
    toast('Kein aktives Projekt zum Speichern vorhanden.', 'error');
    return;
  }

  await saveActiveTrackToBackend();

  const projectData = {
    version: '2.0',
    savedAt: new Date().toISOString(),
    id: Studio.project.id || `proj-${Date.now()}`,
    title: Studio.project.title || 'Album',
    artist: Studio.project.artist || 'Various Artists',
    numLanes: Studio.numLanes || 4,
    tracks: Studio.project.tracks || [],
  };

  // 1. Download .lrcproj JSON file
  const jsonStr = JSON.stringify(projectData, null, 2);
  const blob = new Blob([jsonStr], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `${(projectData.title || 'Album').replace(/[/\\?%*:|"<>]/g, '_')}.lrcproj`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);

  // 2. Persist to backend and localStorage
  try {
    localStorage.setItem('lrcgen_active_project', jsonStr);
    await fetch('/api/project/save_project', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: jsonStr,
    });
  } catch (e) {
    console.warn('Backend project persistence warning:', e);
  }

  toast(`Projekt "${projectData.title}" als .lrcproj gespeichert (Ctrl+S).`, 'success');
}

async function openAlbumProjectFile(file) {
  if (!file) return;

  const loader = document.getElementById('albumLoadingOverlay');
  if (loader) loader.classList.remove('hidden');

  try {
    const text = await file.text();
    const data = JSON.parse(text);

    if (!data.tracks || !Array.isArray(data.tracks)) {
      throw new Error('Ungültige Projektdatei: Keine Tracks gefunden.');
    }

    Studio.project = data;
    if (data.numLanes) Studio.numLanes = Math.max(4, data.numLanes);

    // Persist to backend so backend knows about this project
    try {
      await fetch('/api/project/save_project', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
    } catch (e) {}

    // Save to localStorage
    localStorage.setItem('lrcgen_active_project', text);

    // Switch to workspace
    enterStudioWorkspace();
    renderAlbumSidebar();

    if (Studio.project.tracks.length > 0) {
      await selectTrack(Studio.project.tracks[0].id);
    }

    toast(`Projekt "${data.title || 'Album'}" geladen (${data.tracks.length} Tracks).`, 'success');
  } catch (err) {
    toast(`Fehler beim Öffnen des Projekts: ${err.message}`, 'error');
  } finally {
    if (loader) loader.classList.add('hidden');
  }
}
