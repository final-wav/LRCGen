'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// app-upload.js — File handling, upload, transcription, job polling
// Depends on: shared.js (sleep, uvrAvailable), app-state.js (S, el, $, toast, showPhase, fmt)
// ─────────────────────────────────────────────────────────────────────────────

function handleFile(file) {
  if (!file) return;
  const ext = file.name.split('.').pop().toLowerCase();
  if (!['mp3','flac','wav','m4a','ogg','opus','aac'].includes(ext)) {
    toast('Format not supported.', 'error'); return;
  }
  S.filename = file.name;
  el.fileNameDisplay.textContent = file.name;
  el.fileInfo.classList.remove('hidden');
  el.dropZone.classList.add('hidden');
  el.transcribeBtn.disabled = false;
  S._pendingFile = file;
  updateTapSyncBtn();
}

function updateTapSyncBtn() {
  const ready = !!(S._pendingFile && el.lyricsInput.value.trim().length > 0);
  if (el.tapSyncBtn) el.tapSyncBtn.disabled = !ready;
  const tapVocalsModelWrap = $('tapVocalsModelWrap');
  if (tapVocalsModelWrap) tapVocalsModelWrap.classList.toggle('active', ready);
}

// ─── Transcription ────────────────────────────────────────────────────────────
async function startTranscription(reuseFileId) {
  S.jobCancelled = false;
  const useUVR   = $('uvrToggle')?.checked ?? false;
  const uvrModel = $('uvrModelSelect')?.value ?? 'UVR-MDX-NET-Inst_HQ_3';

  if (!useUVR) {
    S.vocalsJobId = null; S.vocalsAudioBuf = null;
    S.vocalsWavePeaks = null; S.useVocalsWaveform = false;
  }

  showPhase('progress');
  setProgressStep(useUVR ? 'separate' : 'whisper');
  setProgress(8, 'Uploading file…');

  try {
    if (!reuseFileId) {
      const form = new FormData();
      form.append('file', S._pendingFile);
      const r = await fetch('/api/upload', { method: 'POST', body: form });
      if (!r.ok) throw new Error((await r.json()).error || 'Upload failed');
      S.fileId = (await r.json()).file_id;
    }

    setProgress(22, 'Starting job…');

    const tf = new FormData();
    tf.append('file_id',         S.fileId);
    tf.append('model_name',      el.modelSelect.value);
    tf.append('language',        el.langSelect.value);
    tf.append('lyrics',          el.lyricsInput.value);
    tf.append('vocal_isolation', useUVR ? 'true' : 'false');
    tf.append('uvr_model_id',    uvrModel);

    const r2 = await fetch('/api/transcribe', { method: 'POST', body: tf });
    if (!r2.ok) throw new Error((await r2.json()).error);
    const { job_id } = await r2.json();
    await pollJob(job_id, useUVR);
  } catch (e) {
    if (!S.jobCancelled) { showPhase('upload'); toast(e.message, 'error'); }
  }
}

function setProgress(pct, msg) {
  el.progressBar.style.width   = pct + '%';
  el.progressLabel.textContent = msg;
}

function setProgressStep(active) {
  const stepsEl = $('progressSteps');
  if (!stepsEl) return;
  const useUVR = $('uvrToggle')?.checked ?? false;
  stepsEl.style.display = useUVR ? 'flex' : 'none';
  if (!useUVR) return;
  const sep = $('stepSeparate'), whi = $('stepWhisper');
  if (!sep || !whi) return;
  sep.className = 'progress-step' + (active === 'separate' ? ' active' : ' done');
  whi.className = 'progress-step' + (active === 'whisper'  ? ' active' : '');
}

async function pollJob(jobId, useUVR) {
  const delays = [800, 1000, 1500, 2000];
  let i = 0;
  const statusMap = {
    'separating_model': [28, 'separate'],
    'separating':       [40, 'separate'],
    'loading_model':    [55, 'whisper'],
    'transcribing':     [72, 'whisper'],
  };

  while (!S.jobCancelled) {
    await sleep(delays[Math.min(i++, delays.length - 1)]);
    if (S.jobCancelled) break;

    const r = await fetch(`/api/job/${jobId}`);
    if (!r.ok) { toast('Error polling status.', 'error'); return; }
    const job = await r.json();

    el.progressLabel.textContent = job.message || '…';

    if (statusMap[job.status]) {
      const [pct, step] = statusMap[job.status];
      el.progressBar.style.width = pct + '%';
      setProgressStep(step);
    }
    if (typeof job.progress === 'number' && job.progress > 0) {
      el.progressBar.style.width = job.progress + '%';
    }

    if (job.status === 'done') {
      setProgress(100, 'Done!');
      setProgressStep('whisper');
      if (useUVR && job.vocals_path) S.vocalsJobId = jobId;
      await sleep(300);
      initEditor(job.result.segments);
      return;
    }
    if (job.status === 'error') {
      showPhase('upload');
      toast(job.error, 'error');
      return;
    }
  }
}
