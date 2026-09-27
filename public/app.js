const API_BASE = window.location.origin;
const form = document.getElementById('converterForm');
const urlInput = document.getElementById('url');
const submitBtn = document.getElementById('submitBtn');
const statusDiv = document.getElementById('status');
const uploadFile = document.getElementById('uploadFile');
const uploadHelp = document.getElementById('uploadHelp');
const dropzone = document.getElementById('dropzone');
const fileChip = document.getElementById('fileChip');
const fileName = document.getElementById('fileName');
const fileSize = document.getElementById('fileSize');
const removeBtn = document.getElementById('removeFile');
const taskRadios = Array.from(form.querySelectorAll('input[name="task"]'));
const formatRadios = Array.from(form.querySelectorAll('input[name="format"]'));
let maxUploadBytes;
let currentJobId;
let inflight = false;

const TASK_LABELS = { transcribe: 'Transcribe', mp3: 'Extract MP3', instrumental: 'Create instrumental' };

function showStatus(message, type = 'processing') {
  statusDiv.className = `status ${type}`;
  statusDiv.replaceChildren();
  if (type === 'processing') {
    const spinner = document.createElement('span');
    spinner.className = 'spinner';
    statusDiv.append(spinner);
  }
  statusDiv.append(document.createTextNode(message));
}

function retainJobLink() {
  if (!currentJobId) return;
  const link = document.createElement('a');
  link.href = `${API_BASE}/api/jobs/${encodeURIComponent(currentJobId)}`;
  link.textContent = 'Check saved job status';
  statusDiv.append(document.createElement('br'), link);
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function selectedTask() {
  const checked = taskRadios.find(radio => radio.checked);
  return checked ? checked.value : 'transcribe';
}

function updateSubmitLabel() {
  if (inflight) return;
  document.getElementById('instrumentalHelp').hidden = (uploadFile.files[0] ? selectedTask() : formatRadios.find(radio => radio.checked)?.value) !== 'instrumental';
  if (uploadFile.files[0]) {
    submitBtn.textContent = TASK_LABELS[selectedTask()] || 'Transcribe';
  } else {
    submitBtn.textContent = urlInput.value.trim() ? 'Download' : TASK_LABELS[selectedTask()];
  }
}

function setBusy(busy) {
  inflight = busy;
  submitBtn.disabled = busy;
  uploadFile.disabled = busy;
  dropzone.disabled = busy;
  removeBtn.disabled = busy;
  const fileSelected = Boolean(uploadFile.files[0]);
  urlInput.disabled = busy || fileSelected;
  taskRadios.forEach(radio => { radio.disabled = busy; });
  formatRadios.forEach(radio => { radio.disabled = busy || fileSelected; });
}

function refreshFileUi() {
  const file = uploadFile.files[0];
  if (file) {
    fileName.textContent = file.name;
    fileSize.textContent = formatBytes(file.size);
    fileChip.hidden = false;
    dropzone.hidden = true;
  } else {
    fileChip.hidden = true;
    dropzone.hidden = false;
  }
  setBusy(inflight);
  updateSubmitLabel();
}

async function loadUploadLimit() {
  try {
    const response = await fetch(`${API_BASE}/health`, { signal: AbortSignal.timeout(10000) });
    const data = await response.json();
    if (Number.isSafeInteger(data.maxUploadBytes) && data.maxUploadBytes > 0) {
      maxUploadBytes = data.maxUploadBytes;
      uploadHelp.textContent = `Up to ${Math.floor(maxUploadBytes / 1024 / 1024)} MB per file. Files are processed locally.`;
      return;
    }
  } catch { /* The server still enforces its limit if health is unavailable. */ }
  uploadHelp.textContent = 'Limit unavailable. The server will check your file when you upload it.';
}

async function pollJobStatus(jobId, timeoutSeconds, initialStatus = 'queued') {
  const budget = Number(timeoutSeconds) > 0 ? Number(timeoutSeconds) : 7260;
  let deadline = initialStatus === 'processing' ? Date.now() + budget * 1000 : undefined;
  let failures = 0;
  let interval = 1000;
  for (;;) {
    if (deadline !== undefined && Date.now() >= deadline) throw new Error('Conversion timed out. Your saved job may still finish.');
    const requestBudget = Math.max(1, Math.min(10000, deadline === undefined ? 10000 : deadline - Date.now()));
    let data;
    try {
      const response = await fetch(`${API_BASE}/api/jobs/${encodeURIComponent(jobId)}`, { signal: AbortSignal.timeout(requestBudget) });
      if (response.status === 404) throw Object.assign(new Error('This job has expired or is no longer available.'), { permanent: true });
      if (!response.ok) throw new Error('The server is temporarily unavailable');
      data = await response.json();
      failures = 0;
    } catch (error) {
      if (error.permanent) throw error;
      if (deadline !== undefined && Date.now() >= deadline) throw new Error('Conversion timed out. Your saved job may still finish.');
      if (++failures >= 12) throw new Error('Cannot reach the server. Your job is saved; check its status later.');
      showStatus('Reconnecting to your saved job…');
      await new Promise(resolve => setTimeout(resolve, 1000));
      continue;
    }
    if (data.status === 'completed') return data;
    if (data.status === 'failed') throw new Error(data.error || 'Conversion failed');
    if (data.status === 'queued') {
      showStatus(`Queued — position ${Number(data.position) || 1}`);
    } else {
      if (deadline === undefined) deadline = (Number(data.startedAt) || Date.now()) + budget * 1000;
      showStatus('Processing locally. Your job will remain available if the page is closed.');
    }
    const remaining = deadline === undefined ? interval : Math.max(0, deadline - Date.now());
    await new Promise(resolve => setTimeout(resolve, Math.min(interval, remaining)));
    interval = Math.min(interval * 1.5, 5000);
  }
}

function showDownload(job, jobId, automatic) {
  showStatus(job.format === 'transcript' ? 'Transcript ready!' : 'Conversion complete!', 'success');
  const link = document.createElement('a');
  link.href = `${API_BASE}/downloads/${encodeURIComponent(jobId)}`;
  link.download = job.filename || 'transcript.txt';
  link.className = 'download-link';
  link.textContent = `Download ${job.format === 'transcript' ? 'Transcript' : job.format === 'instrumental' ? 'Instrumental WAV' : job.format.toUpperCase()}`;
  const filename = document.createElement('span');
  filename.className = 'filename';
  filename.textContent = job.filename || '';
  statusDiv.append(document.createElement('br'), link, filename);
  if (automatic) setTimeout(() => link.click(), 500);
}

async function handleSubmit(event) {
  event.preventDefault();
  if (inflight) return;
  currentJobId = undefined;
  const selectedFile = uploadFile.files[0];
  const task = selectedTask();
  const format = document.querySelector('input[name="format"]:checked').value;
  if (selectedFile?.size === 0) { showStatus('Choose a non-empty audio or video file.', 'error'); return; }
  if (selectedFile && maxUploadBytes !== undefined && selectedFile.size > maxUploadBytes) {
    showStatus(`Choose a file no larger than ${Math.floor(maxUploadBytes / 1024 / 1024)} MB.`, 'error'); return;
  }
  if (!selectedFile && !urlInput.value.trim()) { showStatus('Choose a file or enter a video URL.', 'error'); return; }
  setBusy(true);
  try {
    showStatus(selectedFile ? 'Uploading your file…' : 'Submitting your conversion…');
    let response;
    if (selectedFile) {
      const endpoint = task === 'transcribe' ? `${API_BASE}/api/transcribe` : `${API_BASE}/api/transcribe?format=${task}`;
      response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', 'X-Upload-Filename': encodeURIComponent(selectedFile.name) },
        body: selectedFile,
      });
    } else {
      response = await fetch(`${API_BASE}/api/convert`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: urlInput.value.trim(), format }),
      });
    }
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Submission failed');
    currentJobId = data.jobId;
    const job = await pollJobStatus(data.jobId, data.pollTimeoutSeconds, data.status);
    showDownload(job, data.jobId, !selectedFile);
  } catch (error) {
    showStatus(error.message || 'Conversion failed', 'error');
    retainJobLink();
  } finally {
    setBusy(false);
    updateSubmitLabel();
  }
}

function validateUrlInput() {
  const url = urlInput.value.trim();
  const format = document.querySelector('input[name="format"]:checked')?.value;
  const youtube = /^(https?:\/\/)?(www\.)?(youtube\.com\/(watch\?v=|shorts\/)|youtu\.be\/)[\w-]+/;
  const invalid = Boolean(url) && format !== 'transcript' && !youtube.test(url);
  urlInput.style.borderColor = invalid ? '#99392b' : '';
  urlInput.setAttribute('aria-invalid', invalid ? 'true' : 'false');
}

dropzone.addEventListener('click', () => { if (!inflight) uploadFile.click(); });
uploadFile.addEventListener('change', refreshFileUi);
removeBtn.addEventListener('click', () => {
  if (inflight) return;
  uploadFile.value = '';
  refreshFileUi();
});
taskRadios.forEach(radio => radio.addEventListener('change', () => {
  const format = radio.value === 'transcribe' ? 'transcript' : radio.value;
  formatRadios.forEach(option => { option.checked = option.value === format; });
  validateUrlInput();
  updateSubmitLabel();
}));
urlInput.addEventListener('input', () => { validateUrlInput(); updateSubmitLabel(); });
formatRadios.forEach(radio => radio.addEventListener('change', () => { validateUrlInput(); updateSubmitLabel(); }));
form.addEventListener('submit', handleSubmit);

['dragenter', 'dragover'].forEach(type => dropzone.addEventListener(type, event => {
  event.preventDefault();
  dropzone.classList.add('dragging');
}));
['dragleave', 'dragend', 'drop'].forEach(type => dropzone.addEventListener(type, event => {
  event.preventDefault();
  if (type === 'dragleave' && dropzone.contains(event.relatedTarget)) return;
  dropzone.classList.remove('dragging');
}));
dropzone.addEventListener('drop', event => {
  if (inflight) return;
  const files = event.dataTransfer && event.dataTransfer.files;
  if (files && files.length > 0) {
    uploadFile.files = files;
    refreshFileUi();
  }
});

void loadUploadLimit();
updateSubmitLabel();
