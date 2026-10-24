"use strict";

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const SETTINGS_KEY = "highvol-web-settings-v1";
const DB_NAME = "highvol-web";
const DB_VERSION = 1;
const previewMode = new URLSearchParams(location.search).has("preview");

const defaultSettings = { audio: true, fps: 60, mode: "manual", length: 15, introduced: false, facing: "environment" };
let settings = { ...defaultSettings, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") };
let db;
let stream;
let recorder;
let chunks = [];
let recordingStartedAt = 0;
let timerID;
let autoIntervalID;
let autoChunkStart = 0;
let autoChunkIndex = 0;
let latestClipID = null;
let pendingInstallPrompt = null;
let activeObjectURLs = [];
let cameraDevices = [];
let currentDeviceID = null;

const modeCopy = {
  manual: "Keep a rolling buffer and save only the rally you choose.",
  automatic: "Save consecutive timed chunks for review.",
  full: "Record continuously until Stop, then save the complete match video."
};

document.addEventListener("DOMContentLoaded", init);

async function init() {
  db = await openDatabase();
  bindEvents();
  syncSettingsUI();
  if (settings.introduced || previewMode) {
    $("#tab-bar").classList.remove("hidden");
    showScreen("record");
  } else {
    $("#welcome").classList.remove("hidden");
  }
  await updateStorageCount();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
}

function bindEvents() {
  $("#welcome-continue").addEventListener("click", async () => {
    settings.introduced = true;
    saveSettings();
    $("#welcome").classList.add("hidden");
    $("#tab-bar").classList.remove("hidden");
    showScreen("record");
    await enableCamera();
  });
  $("#enable-camera").addEventListener("click", enableCamera);
  $("#request-permissions").addEventListener("click", enableCamera);
  $("#toggle-recording").addEventListener("click", () => recorder?.state === "recording" ? stopRecording() : startRecording());
  $("#save-highlight").addEventListener("click", saveManualHighlight);
  $("#switch-camera").addEventListener("click", switchCamera);
  $("#review-latest").addEventListener("click", () => latestClipID && openEditor(latestClipID));
  $("#clear-library").addEventListener("click", clearLibrary);
  $("#install-app").addEventListener("click", installApp);
  $$('[data-go="record"]').forEach(button => button.addEventListener("click", () => showScreen("record")));
  $$("#tab-bar button").forEach(button => button.addEventListener("click", () => showScreen(button.dataset.screen)));
  $$("#mode-picker button").forEach(button => button.addEventListener("click", () => setMode(button.dataset.mode)));
  $$("#length-picker button").forEach(button => button.addEventListener("click", () => setLength(Number(button.dataset.length))));
  $("#setting-audio").addEventListener("change", event => updateSetting("audio", event.target.checked, true));
  $("#setting-fps").addEventListener("change", event => updateSetting("fps", Number(event.target.value), true));
  $("#setting-mode").addEventListener("change", event => setMode(event.target.value));
  $("#setting-length").addEventListener("change", event => setLength(Number(event.target.value)));
  window.addEventListener("beforeinstallprompt", event => {
    event.preventDefault();
    pendingInstallPrompt = event;
    $("#install-app").classList.remove("hidden");
  });
  window.addEventListener("pagehide", () => stream?.getTracks().forEach(track => track.stop()));
  navigator.mediaDevices?.addEventListener?.("devicechange", refreshCameraDevices);
}

function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

function updateSetting(key, value, restartCamera = false) {
  settings[key] = value;
  saveSettings();
  syncSettingsUI();
  if (restartCamera && stream && recorder?.state !== "recording") enableCamera();
}

function setMode(mode) {
  if (recorder?.state === "recording") return;
  settings.mode = mode;
  saveSettings();
  syncSettingsUI();
}

function setLength(length) {
  if (recorder?.state === "recording") return;
  settings.length = length;
  saveSettings();
  syncSettingsUI();
}

function syncSettingsUI() {
  $$("#mode-picker button").forEach(button => button.classList.toggle("active", button.dataset.mode === settings.mode));
  $$("#length-picker button").forEach(button => button.classList.toggle("active", Number(button.dataset.length) === settings.length));
  $("#mode-description").textContent = modeCopy[settings.mode];
  $("#length-fieldset").classList.toggle("hidden", settings.mode === "full");
  $("#save-highlight").classList.toggle("hidden", settings.mode !== "manual");
  $("#setting-audio").checked = settings.audio;
  $("#setting-fps").value = String(settings.fps);
  $("#setting-mode").value = settings.mode;
  $("#setting-length").value = String(settings.length);
  updateCameraSwitchButton();
}

function showScreen(name) {
  ["record", "library", "settings"].forEach(screen => $("#" + screen + "-screen").classList.toggle("hidden", screen !== name));
  $$("#tab-bar button").forEach(button => button.classList.toggle("active", button.dataset.screen === name));
  if (name === "library") renderLibrary();
  if (name === "settings") {
    updateStorageCount();
    refreshPermissionSummary();
  }
}

async function enableCamera(options = {}) {
  if (options?.currentTarget) options = {};
  const exactFacing = options.exactFacing === true;
  const requestedDeviceID = options.deviceId || null;
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    toast("This browser does not support camera recording. Try current Safari, Chrome, or Edge.");
    $("#permission-summary").textContent = "Camera recording is not supported in this browser.";
    return false;
  }
  if (!window.isSecureContext && location.hostname !== "localhost") {
    toast("Camera access needs HTTPS.");
    $("#permission-summary").textContent = "Publish this site over HTTPS to enable camera access.";
    return false;
  }
  if (recorder?.state === "recording") return false;
  try {
    stopCameraStream();
    const video = {
      frameRate: { ideal: settings.fps, max: settings.fps },
      width: { ideal: 1920 },
      height: { ideal: 1080 }
    };
    if (requestedDeviceID) video.deviceId = { exact: requestedDeviceID };
    else video.facingMode = exactFacing ? { exact: settings.facing } : { ideal: settings.facing };
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video, audio: settings.audio });
    } catch (error) {
      const fallbackID = exactFacing ? nextCameraDeviceID() : null;
      if (!fallbackID || error.name === "NotAllowedError") throw error;
      stream = await navigator.mediaDevices.getUserMedia({
        video: { ...video, facingMode: undefined, deviceId: { exact: fallbackID } },
        audio: settings.audio
      });
    }
    $("#camera-preview").srcObject = stream;
    await $("#camera-preview").play().catch(() => {});
    $("#camera-placeholder").classList.add("hidden");
    const trackSettings = stream.getVideoTracks()[0]?.getSettings() || {};
    currentDeviceID = trackSettings.deviceId || null;
    updateActiveFacing(trackSettings);
    await refreshCameraDevices();
    $("#fps-badge").textContent = `${Math.round(trackSettings.frameRate || settings.fps)} FPS`;
    $("#status-message").textContent = `${settings.facing === "user" ? "Front" : "Back"} camera ready`;
    $("#toggle-recording").disabled = false;
    $("#permission-summary").textContent = `Camera allowed${settings.audio ? " · Microphone allowed" : " · Audio disabled"}.`;
    return true;
  } catch (error) {
    stopCameraStream();
    $("#camera-placeholder").classList.remove("hidden");
    $("#status-message").textContent = "Camera unavailable";
    $("#toggle-recording").disabled = true;
    $("#permission-summary").textContent = "Camera or microphone access is blocked. Change this site’s permissions in your browser settings.";
    toast(error.name === "NotAllowedError" ? "Camera permission was not allowed." : "Could not open the camera.");
    updateCameraSwitchButton();
    return false;
  }
}

function stopCameraStream() {
  stream?.getTracks().forEach(track => track.stop());
  stream = null;
  $("#camera-preview").srcObject = null;
}

async function refreshCameraDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  try {
    cameraDevices = (await navigator.mediaDevices.enumerateDevices()).filter(device => device.kind === "videoinput");
  } catch (_) {
    cameraDevices = [];
  }
  updateCameraSwitchButton();
}

function updateActiveFacing(trackSettings) {
  if (trackSettings.facingMode === "user" || trackSettings.facingMode === "environment") {
    settings.facing = trackSettings.facingMode;
  } else {
    const active = cameraDevices.find(device => device.deviceId === trackSettings.deviceId);
    const label = active?.label?.toLowerCase() || "";
    if (/front|facetime|user/.test(label)) settings.facing = "user";
    if (/back|rear|environment/.test(label)) settings.facing = "environment";
  }
  saveSettings();
}

function nextCameraDeviceID() {
  if (cameraDevices.length < 2) return null;
  const currentIndex = cameraDevices.findIndex(device => device.deviceId === currentDeviceID);
  return cameraDevices[(currentIndex + 1 + cameraDevices.length) % cameraDevices.length]?.deviceId || null;
}

function updateCameraSwitchButton() {
  const button = $("#switch-camera");
  if (!button) return;
  const target = settings.facing === "environment" ? "front" : "back";
  button.textContent = `↻ Use ${target} camera`;
  button.setAttribute("aria-label", `Switch to ${target} camera`);
  button.title = `Switch to ${target} camera`;
  button.disabled = recorder?.state === "recording" || (Boolean(stream) && cameraDevices.length === 1);
}

async function refreshPermissionSummary() {
  if (!navigator.permissions?.query) return;
  try {
    const camera = await navigator.permissions.query({ name: "camera" });
    let summary = `Camera: ${camera.state}`;
    try {
      const microphone = await navigator.permissions.query({ name: "microphone" });
      summary += ` · Microphone: ${microphone.state}`;
    } catch (_) {}
    $("#permission-summary").textContent = summary;
  } catch (_) {}
}

async function switchCamera() {
  if (recorder?.state === "recording") return toast("Stop recording before switching cameras.");
  const hadActiveCamera = Boolean(stream);
  const previousFacing = settings.facing;
  settings.facing = previousFacing === "environment" ? "user" : "environment";
  saveSettings();
  updateCameraSwitchButton();
  const switched = await enableCamera({ exactFacing: true });
  if (switched) {
    toast(`${settings.facing === "user" ? "Front" : "Back"} camera active.`);
  } else {
    settings.facing = previousFacing;
    saveSettings();
    updateCameraSwitchButton();
    if (hadActiveCamera) {
      const restored = await enableCamera();
      if (restored) toast("No alternate camera was found.");
    }
  }
}

function preferredMimeType() {
  const options = ["video/mp4;codecs=h264,aac", "video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm", "video/mp4"];
  return options.find(type => MediaRecorder.isTypeSupported(type)) || "";
}

function startRecording() {
  const matchName = $("#match-name").value.trim();
  if (!stream) return enableCamera();
  if (!matchName) return toast("Enter a match name first.");
  chunks = [];
  autoChunkStart = 0;
  autoChunkIndex = 0;
  const mimeType = preferredMimeType();
  try {
    recorder = new MediaRecorder(stream, mimeType ? { mimeType, videoBitsPerSecond: 8_000_000 } : undefined);
  } catch (_) {
    recorder = new MediaRecorder(stream);
  }
  recorder.addEventListener("dataavailable", event => {
    if (event.data?.size) chunks.push({ blob: event.data, at: performance.now() });
  });
  recorder.addEventListener("stop", finalizeStoppedRecording, { once: true });
  recorder.start(1000);
  recordingStartedAt = performance.now();
  timerID = window.setInterval(updateRecordingUI, 250);
  if (settings.mode === "automatic") autoIntervalID = window.setInterval(saveAutomaticChunk, settings.length * 1000);
  setRecordingUI(true);
}

function stopRecording() {
  if (recorder?.state !== "recording") return;
  clearInterval(timerID);
  clearInterval(autoIntervalID);
  recorder.stop();
  setRecordingUI(false, true);
}

async function finalizeStoppedRecording() {
  const elapsed = (performance.now() - recordingStartedAt) / 1000;
  if (settings.mode === "full" && chunks.length) {
    await storeClip(makeBlob(chunks), elapsed, "Full Match Recording", false);
  } else if (settings.mode === "automatic" && chunks.length > autoChunkStart) {
    await saveAutomaticChunk(true);
  }
  chunks = [];
  $("#status-message").textContent = "Ready to record";
  $("#toggle-recording").textContent = "● START RECORDING";
  $("#toggle-recording").disabled = false;
  updateCameraSwitchButton();
  toast(settings.mode === "manual" ? "Recording stopped." : "Recording saved.");
}

function setRecordingUI(isRecording, saving = false) {
  $("#record-dot").classList.toggle("live", isRecording);
  $("#recording-detail").classList.toggle("hidden", !isRecording);
  $("#toggle-recording").textContent = isRecording ? "■ STOP RECORDING" : saving ? "SAVING…" : "● START RECORDING";
  $("#toggle-recording").disabled = saving;
  $("#save-highlight").disabled = !isRecording;
  $("#match-name").disabled = isRecording;
  $("#match-number").disabled = isRecording;
  $$("#mode-picker button, #length-picker button").forEach(button => button.disabled = isRecording);
  updateCameraSwitchButton();
  if (isRecording) $("#status-message").textContent = "Recording";
}

function updateRecordingUI() {
  const seconds = Math.floor((performance.now() - recordingStartedAt) / 1000);
  $("#recording-timer").textContent = formatTime(seconds);
  if (settings.mode === "manual") $("#recording-state").textContent = `${Math.min(seconds, settings.length)}s buffered`;
  if (settings.mode === "automatic") $("#recording-state").textContent = `${autoChunkIndex} chunks saved`;
  if (settings.mode === "full") $("#recording-state").textContent = "Full match recording";
}

function makeBlob(parts) {
  return new Blob(parts.map(part => part.blob), { type: recorder?.mimeType || parts[0]?.blob.type || "video/webm" });
}

async function saveManualHighlight() {
  if (recorder?.state !== "recording" || !chunks.length) return;
  recorder.requestData();
  await delay(150);
  const cutoff = performance.now() - settings.length * 1000;
  let selected = chunks.filter(part => part.at >= cutoff);
  if (!selected.length) selected = chunks.slice(-1);
  const elapsed = Math.min(settings.length, (performance.now() - recordingStartedAt) / 1000);
  $("#save-highlight").disabled = true;
  await storeClip(makeBlob(selected), elapsed, "Volleyball Highlight", false);
  $("#save-highlight").disabled = false;
  pruneRollingChunks();
  toast("Highlight saved on this device.");
}

function pruneRollingChunks() {
  if (settings.mode !== "manual" || chunks.length < settings.length + 8) return;
  const cutoff = performance.now() - (settings.length + 3) * 1000;
  chunks = chunks.filter((part, index) => index === 0 || part.at >= cutoff);
}

async function saveAutomaticChunk(isPartial = false) {
  if (!chunks.length || autoChunkStart >= chunks.length) return;
  if (recorder?.state === "recording") {
    recorder.requestData();
    await delay(120);
  }
  const selected = chunks.slice(autoChunkStart);
  autoChunkStart = chunks.length;
  autoChunkIndex += 1;
  const duration = isPartial ? Math.max(1, ((performance.now() - recordingStartedAt) / 1000) % settings.length) : settings.length;
  await storeClip(makeBlob(selected), duration, `Chunk ${autoChunkIndex}`, true);
  toast(`Chunk ${autoChunkIndex} saved.`);
}

async function storeClip(blob, duration, title, automatic) {
  const clip = {
    id: crypto.randomUUID(), blob, createdAt: Date.now(), duration: Math.max(1, duration), title,
    isBest: false, crop: "original", trimStart: 0, trimEnd: Math.max(1, duration),
    matchName: $("#match-name").value.trim() || "Match", matchNumber: Number($("#match-number").value) || 1,
    automatic, mimeType: blob.type
  };
  await dbPut(clip);
  latestClipID = clip.id;
  $("#review-latest").classList.remove("hidden");
  await updateStorageCount();
  return clip;
}

async function renderLibrary() {
  releaseObjectURLs();
  const clips = (await dbGetAll()).sort((a, b) => Number(b.isBest) - Number(a.isBest) || b.createdAt - a.createdAt);
  $("#library-empty").classList.toggle("hidden", clips.length > 0);
  $("#clear-library").classList.toggle("hidden", clips.length === 0);
  const grid = $("#clip-grid");
  grid.replaceChildren();
  clips.forEach(clip => {
    const url = URL.createObjectURL(clip.blob);
    activeObjectURLs.push(url);
    const card = document.createElement("article");
    card.className = "clip-card";
    card.innerHTML = `<div class="clip-thumb"><video src="${url}#t=0.1" muted playsinline preload="metadata"></video>${clip.isBest ? '<span class="clip-badge">★ BEST</span>' : ""}<span class="clip-duration">${formatTime(clip.duration)}</span></div><div class="clip-info"><h3>${escapeHTML(clip.title)}</h3><div class="clip-meta"><span>Match ${clip.matchNumber} · ${escapeHTML(clip.matchName)}</span><span>${formatDate(clip.createdAt)}</span></div></div>`;
    card.addEventListener("click", () => openEditor(clip.id));
    grid.append(card);
  });
}

async function openEditor(id) {
  const clip = await dbGet(id);
  if (!clip) return;
  const url = URL.createObjectURL(clip.blob);
  activeObjectURLs.push(url);
  const content = $("#editor-content");
  content.innerHTML = `<div id="editor-preview" class="editor-video-wrap crop-preview-${clip.crop}"><video id="editor-video" src="${url}" controls playsinline></video></div><div class="editor-body"><h2>Edit highlight</h2><p class="editor-subtitle">Match ${clip.matchNumber} · ${escapeHTML(clip.matchName)}</p><div class="editor-field"><label for="editor-title">HIGHLIGHT TITLE</label><input id="editor-title" type="text" maxlength="80" value="${escapeAttribute(clip.title)}"></div><div class="trim-row"><div class="editor-field"><label for="trim-start">TRIM START (SECONDS)</label><input id="trim-start" type="number" min="0" max="${clip.duration}" step="0.1" value="${clip.trimStart || 0}"></div><div class="editor-field"><label for="trim-end">TRIM END (SECONDS)</label><input id="trim-end" type="number" min="0.1" max="${clip.duration}" step="0.1" value="${clip.trimEnd || clip.duration}"></div></div><div class="editor-field"><label for="crop-ratio">CROP FOR SOCIAL MEDIA</label><select id="crop-ratio"><option value="original">Original</option><option value="story">9:16 Story / Reel</option><option value="square">1:1 Square</option><option value="portrait">4:5 Post</option></select></div><div class="editor-actions"><button id="best-clip" class="button secondary">${clip.isBest ? "★ BEST HIGHLIGHT" : "☆ MARK AS BEST"}</button><button id="save-metadata" class="button primary">SAVE CHANGES</button><button id="download-clip" class="button secondary">↓ DOWNLOAD ORIGINAL</button><button id="export-edited" class="button secondary">✂ EXPORT EDITED COPY</button><button id="delete-clip" class="button secondary danger">DELETE HIGHLIGHT</button></div></div>`;
  $("#crop-ratio").value = clip.crop;
  $("#crop-ratio").addEventListener("change", event => {
    $("#editor-preview").className = `editor-video-wrap crop-preview-${event.target.value}`;
  });
  $("#best-clip").addEventListener("click", async () => {
    clip.isBest = !clip.isBest;
    await dbPut(clip);
    $("#best-clip").textContent = clip.isBest ? "★ BEST HIGHLIGHT" : "☆ MARK AS BEST";
  });
  $("#save-metadata").addEventListener("click", async () => {
    applyEditorValues(clip);
    await dbPut(clip);
    toast("Highlight updated.");
  });
  $("#download-clip").addEventListener("click", () => downloadBlob(clip.blob, clipFileName(clip)));
  $("#export-edited").addEventListener("click", () => exportEditedClip(clip));
  $("#delete-clip").addEventListener("click", async () => {
    if (!confirm("Delete this highlight from this browser?")) return;
    await dbDelete(clip.id);
    $("#editor-dialog").close();
    await renderLibrary();
    await updateStorageCount();
    toast("Highlight deleted.");
  });
  $("#editor-dialog").showModal();
}

function applyEditorValues(clip) {
  clip.title = $("#editor-title").value.trim() || "Volleyball Highlight";
  clip.crop = $("#crop-ratio").value;
  clip.trimStart = Math.max(0, Math.min(Number($("#trim-start").value) || 0, clip.duration - .1));
  clip.trimEnd = Math.max(clip.trimStart + .1, Math.min(Number($("#trim-end").value) || clip.duration, clip.duration));
}

async function exportEditedClip(clip) {
  applyEditorValues(clip);
  await dbPut(clip);
  const button = $("#export-edited");
  const video = $("#editor-video");
  if (!HTMLCanvasElement.prototype.captureStream || !window.MediaRecorder) {
    toast("Edited video export is not supported here; downloading the original instead.");
    return downloadBlob(clip.blob, clipFileName(clip));
  }
  button.disabled = true;
  button.textContent = "EXPORTING IN REAL TIME…";
  try {
    const dimensions = cropDimensions(video.videoWidth || 1280, video.videoHeight || 720, clip.crop);
    const canvas = document.createElement("canvas");
    canvas.width = dimensions.width;
    canvas.height = dimensions.height;
    const context = canvas.getContext("2d");
    const outputStream = canvas.captureStream(30);
    const outputType = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"].find(type => MediaRecorder.isTypeSupported(type)) || "";
    const outputRecorder = new MediaRecorder(outputStream, outputType ? { mimeType: outputType, videoBitsPerSecond: 5_000_000 } : undefined);
    const output = [];
    outputRecorder.ondataavailable = event => event.data.size && output.push(event.data);
    const completed = new Promise(resolve => outputRecorder.onstop = resolve);
    video.currentTime = clip.trimStart;
    await once(video, "seeked");
    video.muted = true;
    outputRecorder.start(500);
    await video.play();
    await new Promise(resolve => {
      const draw = () => {
        drawCroppedFrame(context, video, canvas, clip.crop);
        drawWatermark(context, canvas);
        if (video.currentTime >= clip.trimEnd || video.ended) return resolve();
        requestAnimationFrame(draw);
      };
      draw();
    });
    video.pause();
    outputRecorder.stop();
    await completed;
    downloadBlob(new Blob(output, { type: outputRecorder.mimeType || "video/webm" }), `HighVol-Edited-${safeName(clip.title)}.webm`);
    toast("Edited copy is ready to download.");
  } catch (error) {
    console.error(error);
    toast("Edited export failed in this browser. You can still download the original.");
  } finally {
    button.disabled = false;
    button.textContent = "✂ EXPORT EDITED COPY";
  }
}

function cropDimensions(width, height, crop) {
  if (crop === "story") return { width: 720, height: 1280 };
  if (crop === "square") return { width: 900, height: 900 };
  if (crop === "portrait") return { width: 800, height: 1000 };
  return { width: Math.min(width, 1920), height: Math.min(height, 1080) };
}

function drawCroppedFrame(context, video, canvas, crop) {
  if (crop === "original") return context.drawImage(video, 0, 0, canvas.width, canvas.height);
  const sourceRatio = video.videoWidth / video.videoHeight;
  const targetRatio = canvas.width / canvas.height;
  let sx = 0, sy = 0, sw = video.videoWidth, sh = video.videoHeight;
  if (sourceRatio > targetRatio) { sw = video.videoHeight * targetRatio; sx = (video.videoWidth - sw) / 2; }
  else { sh = video.videoWidth / targetRatio; sy = (video.videoHeight - sh) / 2; }
  context.drawImage(video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
}

function drawWatermark(context, canvas) {
  context.save();
  context.font = `900 ${Math.max(18, canvas.width * .025)}px system-ui`;
  context.textAlign = "right";
  context.fillStyle = "rgba(255,255,255,.75)";
  context.fillText("HighVol", canvas.width - 20, canvas.height - 22);
  context.restore();
}

async function clearLibrary() {
  if (!confirm("Delete every saved highlight from this browser? This cannot be undone.")) return;
  await new Promise((resolve, reject) => {
    const request = db.transaction("clips", "readwrite").objectStore("clips").clear();
    request.onsuccess = resolve;
    request.onerror = () => reject(request.error);
  });
  latestClipID = null;
  $("#review-latest").classList.add("hidden");
  await renderLibrary();
  await updateStorageCount();
  toast("All highlights deleted.");
}

async function updateStorageCount() {
  if (!db) return;
  const clips = await dbGetAll();
  const bytes = clips.reduce((total, clip) => total + (clip.blob?.size || 0), 0);
  $("#storage-used").textContent = `${clips.length} clip${clips.length === 1 ? "" : "s"} · ${formatBytes(bytes)}`;
}

async function installApp() {
  if (!pendingInstallPrompt) return;
  pendingInstallPrompt.prompt();
  await pendingInstallPrompt.userChoice;
  pendingInstallPrompt = null;
  $("#install-app").classList.add("hidden");
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => request.result.createObjectStore("clips", { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function dbPut(value) { return dbRequest("readwrite", store => store.put(value)); }
function dbGet(id) { return dbRequest("readonly", store => store.get(id)); }
function dbGetAll() { return dbRequest("readonly", store => store.getAll()); }
function dbDelete(id) { return dbRequest("readwrite", store => store.delete(id)); }
function dbRequest(mode, operation) {
  return new Promise((resolve, reject) => {
    const request = operation(db.transaction("clips", mode).objectStore("clips"));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function clipFileName(clip) {
  const extension = clip.mimeType?.includes("mp4") ? "mp4" : "webm";
  return `HighVol-${safeName(clip.matchName)}-${safeName(clip.title)}.${extension}`;
}

function safeName(value) { return value.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").slice(0, 60) || "Highlight"; }
function formatTime(value) { const seconds = Math.max(0, Math.round(value)); return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`; }
function formatDate(timestamp) { return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(timestamp); }
function formatBytes(bytes) { if (!bytes) return "0 MB"; return bytes > 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${(bytes / 1e6).toFixed(1)} MB`; }
function escapeHTML(value) { const node = document.createElement("div"); node.textContent = value; return node.innerHTML; }
function escapeAttribute(value) { return escapeHTML(value).replaceAll('"', "&quot;"); }
function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function once(target, event) { return new Promise(resolve => target.addEventListener(event, resolve, { once: true })); }
function releaseObjectURLs() { activeObjectURLs.forEach(url => URL.revokeObjectURL(url)); activeObjectURLs = []; }
function toast(message) { const element = $("#toast"); element.textContent = message; element.classList.add("show"); clearTimeout(toast.timer); toast.timer = setTimeout(() => element.classList.remove("show"), 3000); }
