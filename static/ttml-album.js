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
  document.getElementById('newProjectBtn')?.addEventListener('click', createNewProject);
  document.getElementById('saveProjectBtn')?.addEventListener('click', (e) => {
    e.preventDefault();
    saveAlbumProjectFile(false);
  });
  document.getElementById('saveProjectAsBtn')?.addEventListener('click', (e) => {
    e.preventDefault();
    saveAlbumProjectFile(true);
  });
  document.getElementById('openProjectBtn')?.addEventListener('click', (e) => {
    e.preventDefault();
    pickAndOpenAlbumProject('projectFileInput');
  });
  document.getElementById('welcomeOpenProjectBtn')?.addEventListener('click', (e) => {
    e.preventDefault();
    pickAndOpenAlbumProject('welcomeProjectFileInput');
  });
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

  // Active Track Status Manual Changer (Header Bar)
  document.getElementById('activeTrackStatusSelect')?.addEventListener('change', async (e) => {
    const track = getActiveTrack();
    if (!track) return;
    const newStatus = e.target.value;
    track.status = newStatus;
    if (typeof autoSetWorkflowModeForTrack === 'function') autoSetWorkflowModeForTrack(track);
    await saveActiveTrackToBackend();
    renderAlbumSidebar();
    toast(`Track status set to "${e.target.options[e.target.selectedIndex].text}".`, 'info');
  });
}

function createNewProject() {
  if (Studio.project && Studio.project.tracks && Studio.project.tracks.length > 0) {
    const ok = confirm('Start a new project?\n\nMake sure you saved your current project ("Save Project") if you want to keep your changes.');
    if (!ok) return;
  }

  // 1. Audio stoppen
  if (Studio.audio) {
    Studio.audio.pause();
    Studio.audio.src = '';
  }

  // 2. Studio State leeren
  Studio.project = null;
  Studio.activeTrackId = null;
  Studio.projectFileHandle = null;
  Studio.projectDiskPath = null;
  Studio.history = [];
  Studio.historyIdx = -1;
  Studio.selectedLineId = null;
  Studio.selectedSylIdx = null;
  Studio.selectedSyllables.clear();

  // 3. Cache & Session leeren
  localStorage.removeItem('lrcgen_active_project');
  localStorage.removeItem('lrcgen_active_track_id');

  // 4. Ingestion Cards & Badges zurücksetzen
  const audioDropCard = document.getElementById('audioDropCard');
  const lyricsDropCard = document.getElementById('lyricsDropCard');
  if (audioDropCard) audioDropCard.classList.remove('uploaded');
  if (lyricsDropCard) lyricsDropCard.classList.remove('uploaded');

  const audioStatusBox = document.getElementById('audioStatusBox');
  const lyricsStatusBox = document.getElementById('lyricsStatusBox');
  if (audioStatusBox) audioStatusBox.classList.add('hidden');
  if (lyricsStatusBox) lyricsStatusBox.classList.add('hidden');

  const audioBadge = document.getElementById('audioBadge');
  if (audioBadge) {
    audioBadge.textContent = 'Step 1';
    audioBadge.style.background = '';
    audioBadge.style.color = '';
  }
  const lyricsBadge = document.getElementById('lyricsBadge');
  if (lyricsBadge) {
    lyricsBadge.textContent = 'Step 2';
    lyricsBadge.style.background = '';
    lyricsBadge.style.color = '';
  }

  const setupBottomBar = document.getElementById('setupBottomBar');
  if (setupBottomBar) setupBottomBar.classList.add('hidden');

  // Input-Felder leeren
  ['audioFolderInput', 'audioFilesInput', 'sidebarAudioInput', 'lyricsFolderInput', 'lyricsFilesInput', 'sidebarLyricsInput', 'projectFileInput', 'welcomeProjectFileInput'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });

  // 5. Zurück zum Setup-Screen wechseln
  const dropZone = document.getElementById('albumDropZone');
  if (dropZone) dropZone.classList.remove('hidden');
  const mainWorkspace = document.getElementById('mainWorkspace');
  if (mainWorkspace) mainWorkspace.classList.add('hidden');

  // 6. Sidebar zurücksetzen und Recent Projects neu laden
  renderAlbumSidebar();
  loadAndRenderRecentProjects();

  toast('New project ready. Upload your audio files now.', 'info');
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
    if (audioStatusText) audioStatusText.textContent = `${Studio.project.tracks.length} songs loaded (${Studio.project.title || 'Album'})`;
    if (audioBadge) {
      audioBadge.textContent = 'Ready';
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
    if (openStudioBtn) openStudioBtn.textContent = `Proceed to Studio (${Studio.project.tracks.length} Tracks)`;

    toast(`${Studio.project.tracks.length} songs loaded. Select lyrics folder or click "Proceed to Studio".`, 'success');
  } catch (err) {
    toast(`Audio upload error: ${err.message}`, 'error');
  } finally {
    if (loader) loader.classList.add('hidden');
  }
}

async function handleLyricsUpload(fileList) {
  if (!fileList || !fileList.length) return;

  if (!Studio.project || !Studio.project.id) {
    toast('Please upload audio tracks first (Step 1)!', 'error');
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
    if (lyricsStatusText) lyricsStatusText.textContent = `${data.matched_count} of ${Studio.project.tracks.length} tracks matched with lyrics`;
    if (lyricsBadge) {
      lyricsBadge.textContent = 'Matched';
      lyricsBadge.style.background = 'rgba(20, 115, 230, 0.15)';
      lyricsBadge.style.color = '#4da3ff';
    }

    // Reload active track in editor if already open
    if (Studio.activeTrackId) {
      const tr = getActiveTrack();
      if (tr) refreshEditorViews();
    }

    toast(`Lyrics assigned: ${data.matched_count} file(s) matched.`, 'success');
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

  if (!Studio.project) {
    if (titleEl) titleEl.textContent = 'No album loaded';
    if (artistEl) artistEl.textContent = 'Drop folder or files';
    if (countEl) countEl.textContent = '0 Tracks';
    if (sidebar) {
      sidebar.innerHTML = '<div class="tracklist-empty-hint">Upload audio files or an album first.</div>';
    }
    return;
  }

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
          <span class="track-title" title="${escHTML(track.title)}">${escHTML(track.title)}</span>
          <select class="track-badge track-badge-select ${badgeClass}" title="Manually set status">
            <option value="line_synced" ${track.status === 'line_synced' ? 'selected' : ''}>Line Synced</option>
            <option value="syllable_synced" ${track.status === 'syllable_synced' ? 'selected' : ''}>TTML Ready</option>
            <option value="raw_lyrics" ${track.status === 'raw_lyrics' ? 'selected' : ''}>Plain Text</option>
            <option value="empty" ${track.status === 'empty' ? 'selected' : ''}>No Lyrics</option>
          </select>
        </div>
        <div class="track-meta-row">
          <span class="track-artist">${escHTML(track.artist || Studio.project.artist)}</span>
          <span class="track-dur">${track.duration ? fmt(track.duration) : '--:--'}</span>
        </div>
      </div>
    `;

    const statusSel = item.querySelector('.track-badge-select');
    if (statusSel) {
      statusSel.addEventListener('click', e => e.stopPropagation());
      statusSel.addEventListener('mousedown', e => e.stopPropagation());
      statusSel.addEventListener('change', async (e) => {
        e.stopPropagation();
        const newStatus = e.target.value;
        track.status = newStatus;
        if (track.id === Studio.activeTrackId) {
          if (typeof autoSetWorkflowModeForTrack === 'function') autoSetWorkflowModeForTrack(track);
          const headerSel = document.getElementById('activeTrackStatusSelect');
          if (headerSel) {
            headerSel.value = newStatus;
            headerSel.className = `track-badge track-badge-select badge-${newStatus === 'line_synced' ? 'line' : (newStatus === 'syllable_synced' ? 'syllable' : (newStatus === 'raw_lyrics' ? 'plain' : 'empty'))}`;
          }
        }
        await saveActiveTrackToBackend();
        renderAlbumSidebar();
        toast(`Marked track "${track.title}" as "${e.target.options[e.target.selectedIndex].text}".`, 'info');
      });
    }

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

  // Auto-migrate untimed plain-text lines with start 0 and end 0 to unplacedLines
  const lines = track.lyrics?.lines || [];
  const allZero = lines.length > 0 && lines.every(l => (l.start || 0) === 0 && (l.end || 0) === 0);
  if (allZero) {
    track.unplacedLines = lines.map((l, idx) => ({
      id: `Q-${idx + 1}`,
      text: l.text || '',
      adlib: l.adlib || null,
      agent: l.agent || 'v1',
    }));
    track.lyrics.lines = [];
    track.status = 'raw_lyrics';
    saveActiveTrackToBackend();
  }

  renderAlbumSidebar();

  // Update Track Header
  const titleInp   = document.getElementById('trackTitleInput');
  const artistInp  = document.getElementById('trackArtistInput');
  const trackNrEl  = document.getElementById('activeTrackNr');
  const headerStat = document.getElementById('activeTrackStatusSelect');
  if (titleInp)   titleInp.value   = track.title || '';
  if (artistInp)  artistInp.value  = track.artist || Studio.project.artist || '';
  if (trackNrEl)  trackNrEl.textContent = `Track ${track.trackNumber}`;
  if (headerStat) {
    headerStat.value = track.status || 'empty';
    headerStat.className = `track-badge track-badge-select badge-${track.status === 'line_synced' ? 'line' : (track.status === 'syllable_synced' ? 'syllable' : (track.status === 'raw_lyrics' ? 'plain' : 'empty'))}`;
  }

  const langSel = document.getElementById('langSelect');
  if (langSel && Studio.project?.language) {
    langSel.value = Studio.project.language;
  }

  // Reset History & tab auto-selection
  Studio.history = [];
  Studio.historyIdx = -1;
  Studio.userSelectedTab = false;
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

  // Auto-adapt workflow mode to track's current status
  if (typeof autoSetWorkflowModeForTrack === 'function') {
    autoSetWorkflowModeForTrack(track);
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
  toast(`Batch alignment complete! (${alignedCount} tracks processed)`, 'success');
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
// ─── Project File Save & Load (.lrcproj) ────────────────────────────────────
async function saveAlbumProjectFile(saveAs = false) {
  if (!Studio.project || !Studio.project.tracks || !Studio.project.tracks.length) {
    toast('No active project to save.', 'error');
    return;
  }

  await saveActiveTrackToBackend();

  const projectData = {
    version: '2.0',
    savedAt: new Date().toISOString(),
    id: Studio.project.id || `proj-${Date.now()}`,
    title: Studio.project.title || 'Album',
    artist: Studio.project.artist || 'Various Artists',
    language: Studio.project.language || document.getElementById('langSelect')?.value || 'de',
    numLanes: Studio.numLanes || 4,
    disk_path: Studio.projectDiskPath || Studio.project.disk_path || null,
    tracks: Studio.project.tracks || [],
  };

  const jsonStr = JSON.stringify(projectData, null, 2);

  // 1. If FileSystemFileHandle is available and NOT saveAs, write directly into the real opened file on disk
  let savedToHandle = false;
  if (!saveAs && Studio.projectFileHandle) {
    try {
      const writable = await Studio.projectFileHandle.createWritable();
      await writable.write(jsonStr);
      await writable.close();
      savedToHandle = true;
    } catch (handleErr) {
      console.warn('FileSystemFileHandle write failed, falling back to backend save:', handleErr);
    }
  }

  // 2. Direct silent save to backend disk & browser localStorage
  try {
    localStorage.setItem('lrcgen_active_project', jsonStr);
    await fetch('/api/project/save_project', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: jsonStr,
    });
    if (typeof updateAutosaveIndicator === 'function') updateAutosaveIndicator();
  } catch (e) {
    console.warn('Backend project persistence warning:', e);
  }

  // 3. Trigger browser file download dialog if user explicitly clicked 'Save As...' or has no direct disk write capability
  if (saveAs === true) {
    // If File System Access API is supported, let user pick destination interactively
    if (typeof window.showSaveFilePicker === 'function') {
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName: `${(projectData.title || 'Album').replace(/[/\\?%*:|"<>]/g, '_')}.lrcproj`,
          types: [{
            description: 'LRCGen Project File',
            accept: { 'application/json': ['.lrcproj', '.json'] }
          }]
        });
        const writable = await handle.createWritable();
        await writable.write(jsonStr);
        await writable.close();
        Studio.projectFileHandle = handle;
        toast(`Saved project directly to "${handle.name}".`, 'success');
        return;
      } catch (pickerErr) {
        if (pickerErr.name === 'AbortError') return;
      }
    }

    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `${(projectData.title || 'Album').replace(/[/\\?%*:|"<>]/g, '_')}.lrcproj`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    toast(`Project downloaded as "${projectData.title}.lrcproj".`, 'success');
  } else {
    if (savedToHandle) {
      toast(`Saved project "${projectData.title}" directly into opened file (Ctrl+S).`, 'success');
    } else {
      toast(`Saved project "${projectData.title}" directly to disk (Ctrl+S).`, 'success');
    }
  }
}

// Interactive file open with File System Access API if available
async function pickAndOpenAlbumProject(fallbackInputId = 'projectFileInput') {
  if (typeof window.showOpenFilePicker === 'function') {
    try {
      const [handle] = await window.showOpenFilePicker({
        types: [{
          description: 'LRCGen Project File (*.lrcproj, *.json)',
          accept: { 'application/json': ['.lrcproj', '.json'] }
        }],
        multiple: false
      });
      if (handle) {
        const file = await handle.getFile();
        await openAlbumProjectFile(file, handle);
        return;
      }
    } catch (e) {
      if (e.name === 'AbortError') return;
      console.warn('showOpenFilePicker error, falling back to input:', e);
    }
  }

  // Fallback: trigger standard hidden input
  const inp = document.getElementById(fallbackInputId) || document.getElementById('projectFileInput');
  if (inp) {
    inp.value = '';
    inp.click();
  }
}

async function openAlbumProjectFile(file, handle = null) {
  if (!file) return;

  const loader = document.getElementById('albumLoadingOverlay');
  if (loader) loader.classList.remove('hidden');

  try {
    const text = await file.text();
    let data = JSON.parse(text);

    if (!data.tracks || !Array.isArray(data.tracks)) {
      throw new Error('Invalid project file: No tracks found.');
    }

    // Retain persistent file handle and path
    if (handle) {
      Studio.projectFileHandle = handle;
    }
    const detectedPath = data.disk_path || file.name;
    if (detectedPath) {
      Studio.projectDiskPath = detectedPath;
      data.disk_path = detectedPath;
    }

    // Check if there is a newer autosave available on disk for this project (checking its folder-bound .autosave)
    const projId = data.id;
    if (projId) {
      try {
        const qPath = detectedPath ? `?disk_path=${encodeURIComponent(detectedPath)}` : '';
        const statusRes = await fetch(`/api/project/${projId}/autosave_status${qPath}`);
        if (statusRes.ok) {
          const autoStatus = await statusRes.json();
          if (autoStatus && autoStatus.has_newer) {
            const baseTime = data.savedAt ? new Date(data.savedAt).getTime() : 0;
            const autoTime = autoStatus.saved_at ? new Date(autoStatus.saved_at).getTime() : (autoStatus.mtime * 1000);
            
            // If autosave is newer than file timestamp by at least 2 seconds
            if (autoTime > baseTime + 2000) {
              const autoRes = await fetch(`/api/project/${projId}/latest_autosave${qPath}`);
              if (autoRes.ok) {
                const newerData = await autoRes.json();
                if (newerData && newerData.tracks && newerData.tracks.length) {
                  data = newerData;
                  // Preserve disk path & handle on restored data
                  if (handle) Studio.projectFileHandle = handle;
                  data.disk_path = detectedPath;
                  const timeFormatted = autoStatus.saved_at ? new Date(autoStatus.saved_at).toLocaleTimeString() : 'vor kurzem';
                  toast(`Neuerer Autosave-Stand (${timeFormatted}) wurde automatisch wiederhergestellt.`, 'info');
                }
              }
            }
          }
        }
      } catch (checkErr) {
        console.warn('Autosave check warning:', checkErr);
      }
    }

    Studio.project = data;
    if (data.language) {
      const langSel = document.getElementById('langSelect');
      if (langSel) langSel.value = data.language;
      localStorage.setItem('lrc_preferred_lang', data.language);
    }
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
    localStorage.setItem('lrcgen_active_project', JSON.stringify(data));

    // Switch to workspace
    enterStudioWorkspace();
    renderAlbumSidebar();

    if (Studio.project.tracks.length > 0) {
      await selectTrack(Studio.project.tracks[0].id);
    }

    toast(`Project "${data.title || 'Album'}" loaded (${data.tracks.length} tracks).`, 'success');
  } catch (err) {
    toast(`Error opening project: ${err.message}`, 'error');
  } finally {
    if (loader) loader.classList.add('hidden');
  }
}

// ─── Recent Projects Dashboard (Photoshop / Ableton Home Screen) ────────────
async function loadAndRenderRecentProjects() {
  const container = document.getElementById('recentProjectsGrid');
  const countBadge = document.getElementById('recentProjectsCount');
  if (!container) return;

  try {
    const res = await fetch('/api/projects/recent');
    if (!res.ok) throw new Error('Failed to load recent projects');
    const projects = await res.json();

    if (countBadge) {
      countBadge.textContent = `${projects.length} Project${projects.length === 1 ? '' : 's'}`;
    }

    if (!projects || projects.length === 0) {
      container.innerHTML = `
        <div style="grid-column: 1 / -1; padding: 24px; text-align: center; color: var(--text-muted); background: rgba(255,255,255,0.02); border: 1px dashed var(--border2); border-radius: 8px;">
          No recent projects found. Drop audio tracks above or click "Open Project File" to begin.
        </div>
      `;
      return;
    }

    container.innerHTML = projects.map(p => {
      const timeStr = p.saved_at ? new Date(p.saved_at).toLocaleDateString(undefined, {
        day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'
      }) : (p.mtime ? new Date(p.mtime * 1000).toLocaleDateString() : '');

      return `
        <div class="recent-proj-card" onclick="openProjectFromRecent('${encodeURIComponent(p.disk_path)}')" style="
          display: flex;
          flex-direction: column;
          padding: 14px 16px;
          background: rgba(255,255,255,0.03);
          border: 1px solid var(--border2);
          border-radius: 8px;
          cursor: pointer;
          transition: all 0.15s ease;
          position: relative;
        " onmouseover="this.style.borderColor='var(--accent)'; this.style.background='rgba(255,255,255,0.06)'"
           onmouseout="this.style.borderColor='var(--border2)'; this.style.background='rgba(255,255,255,0.03)'">
          <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom: 6px;">
            <div style="font-weight: 600; font-size: 14px; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 190px;" title="${p.title || 'Untitled'}">
              ${p.title || 'Untitled'}
            </div>
            <span style="font-size: 10px; background: rgba(77, 163, 255, 0.15); color: #4da3ff; padding: 2px 6px; border-radius: 4px; font-weight: 600;">
              ${p.tracks_count} Trk
            </span>
          </div>

          <div style="font-size: 12px; color: var(--text-muted); margin-bottom: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
            ${p.artist || 'Various Artists'}
          </div>

          <div style="display:flex; justify-content:space-between; align-items:center; margin-top: auto; font-size: 10px; color: var(--text-muted); opacity: 0.8;">
            <span title="${p.disk_path}">${(p.disk_path || '').split('/').pop()}</span>
            <span>${timeStr}</span>
          </div>
        </div>
      `;
    }).join('');
  } catch (err) {
    console.warn('Recent projects load error:', err);
    if (countBadge) countBadge.textContent = 'Error';
  }
}

async function openProjectFromRecent(encodedPath) {
  const diskPath = decodeURIComponent(encodedPath);
  const loader = document.getElementById('albumLoadingOverlay');
  if (loader) loader.classList.remove('hidden');

  try {
    const res = await fetch(`/api/project_load_by_path?path=${encodeURIComponent(diskPath)}`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `Failed to load project: ${res.statusText}`);
    }

    const data = await res.json();
    Studio.project = data;
    Studio.projectDiskPath = diskPath;

    if (data.language) {
      const langSel = document.getElementById('langSelect');
      if (langSel) langSel.value = data.language;
      localStorage.setItem('lrc_preferred_lang', data.language);
    }
    if (data.numLanes) Studio.numLanes = Math.max(4, data.numLanes);

    localStorage.setItem('lrcgen_active_project', JSON.stringify(data));

    enterStudioWorkspace();
    renderAlbumSidebar();

    if (Studio.project.tracks && Studio.project.tracks.length > 0) {
      await selectTrack(Studio.project.tracks[0].id);
    }

    if (data._restored_from_autosave) {
      toast(`Project "${data.title}" loaded (Restored from newer autosave).`, 'info');
    } else {
      toast(`Project "${data.title}" loaded (${data.tracks.length} tracks).`, 'success');
    }
  } catch (e) {
    toast(`Error opening recent project: ${e.message}`, 'error');
  } finally {
    if (loader) loader.classList.add('hidden');
  }
}
