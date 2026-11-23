"use strict";

const MODEL_PATH = "model/best.onnx";
const LABELS_PATH = "model/labels.json";
const SPEECH_PATH = "model/speech.json";
const CONFIDENCE_THRESHOLD = 45;

const elements = {
  overlay: document.getElementById("startOverlay"),
  start: document.getElementById("startButton"),
  auto: document.getElementById("autoScanButton"),
  switchCamera: document.getElementById("switchCameraButton"),
  arduino: document.getElementById("arduinoButton"),
  camera: document.getElementById("camera"),
  overlayCanvas: document.getElementById("overlayCanvas"),
  resultPanel: document.getElementById("resultPanel"),
  statusBadge: document.getElementById("statusBadge"),
  denomination: document.getElementById("denomination"),
  confidence: document.getElementById("confidence"),
  confidenceFill: document.getElementById("confidenceFill"),
  scan: document.getElementById("scanButton"),
  repeat: document.getElementById("repeatButton"),
  systemStateText: document.getElementById("systemStateText"),
  cameraPlaceholder: document.getElementById("cameraPlaceholder")
};

let audioContext = null;
let session = null;
let labelList = [];
let speechMap = {};
let inputTensorName = null;
let modelInputWidth = 640;
let modelInputHeight = 640;
let cameraStream = null;
let cameras = [];
let cameraIndex = 0;
let lastAnnouncement = "";
let scanning = false;
let autoScanEnabled = false;
let autoScanTimer = null;
let serialPort = null;
let serialReader = null;
let systemStarting = false;
let cameraPositioningOnly = false;
let isFrontCamera = false;
let cameraSwipeStartX = null;
let cameraSwipeStartY = null;

function ensureAudioContext() {
  if (!audioContext) {
    const AudioContextType = window.AudioContext || window.webkitAudioContext;
    if (AudioContextType) audioContext = new AudioContextType();
  }
  if (audioContext && audioContext.state === "suspended") {
    audioContext.resume();
  }
}

function tone(frequency, durationMs, startDelayMs = 0) {
  ensureAudioContext();
  if (!audioContext) return;
  const start = audioContext.currentTime + startDelayMs / 1000;
  const oscillator = audioContext.createOscillator();
  const gain = audioContext.createGain();
  oscillator.type = "triangle";
  oscillator.frequency.setValueAtTime(frequency, start);
  gain.gain.setValueAtTime(0.14, start);
  gain.gain.exponentialRampToValueAtTime(0.001, start + durationMs / 1000);
  oscillator.connect(gain);
  gain.connect(audioContext.destination);
  oscillator.start(start);
  oscillator.stop(start + durationMs / 1000);
}

function speak(text) {
  if (!("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = "en-PH";
  utterance.rate = 0.94;
  window.speechSynthesis.speak(utterance);
}

function isSpeechActive() {
  return "speechSynthesis" in window &&
    (window.speechSynthesis.speaking || window.speechSynthesis.pending);
}

function vibrate(pattern) {
  if ("vibrate" in navigator) navigator.vibrate(pattern);
}

function scanStartedFeedback() {
  tone(440, 90);
  vibrate(40);
}

function successFeedback() {
  tone(523.25, 110);
  tone(783.99, 170, 130);
  vibrate([90, 50, 90]);
}

function failFeedback() {
  tone(220, 260);
  vibrate(250);
}

function updateResultUI({ state = "idle", badge = "SYSTEM READY", title = "Ready to Scan", confidenceText = "Confidence: --", percent = 0 }) {
  elements.resultPanel.dataset.state = state;
  elements.statusBadge.textContent = badge;
  elements.denomination.textContent = title;
  elements.confidence.textContent = confidenceText;
  elements.confidence.setAttribute("aria-label", confidenceText);
  elements.confidenceFill.style.width = `${Math.max(0, Math.min(100, percent))}%`;
  if (elements.systemStateText) {
    elements.systemStateText.textContent =
      state === "success" ? "Result found" :
      state === "warn" ? "Needs attention" :
      percent > 0 ? "Scanning" : "Ready";
  }
}

function clearBoundingBox() {
  const canvas = elements.overlayCanvas;
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

function drawOrientedBox(obb, labelText) {
  const canvas = elements.overlayCanvas;
  if (!canvas || !obb) {
    clearBoundingBox();
    return;
  }

  const rect = elements.camera.getBoundingClientRect();
  if (!rect.width || !rect.height) return;

  canvas.width = Math.round(rect.width);
  canvas.height = Math.round(rect.height);
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const cx = obb.cx * canvas.width;
  const cy = obb.cy * canvas.height;
  const boxW = Math.max(16, obb.w * canvas.width);
  const boxH = Math.max(16, obb.h * canvas.height);
  const angle = obb.angle || 0;

  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(angle);
  ctx.strokeStyle = "#10b981";
  ctx.lineWidth = 4;
  ctx.strokeRect(-boxW / 2, -boxH / 2, boxW, boxH);
  ctx.restore();

  if (labelText) {
    ctx.font = "800 16px system-ui, -apple-system, sans-serif";
    const metrics = ctx.measureText(labelText);
    const padX = 12;
    const tagH = 30;
    const tagW = metrics.width + padX * 2;
    const tagX = Math.max(8, Math.min(canvas.width - tagW - 8, cx - tagW / 2));
    const tagY = Math.max(8, cy - Math.max(boxW, boxH) / 2 - tagH - 8);

    ctx.fillStyle = "#090d16";
    ctx.fillRect(tagX, tagY, tagW, tagH);
    ctx.strokeStyle = "#10b981";
    ctx.lineWidth = 2;
    ctx.strokeRect(tagX, tagY, tagW, tagH);

    ctx.fillStyle = "#10b981";
    ctx.fillText(labelText, tagX + padX, tagY + 20);
  }
}

function normalizeLabels(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map(String);
  if (Array.isArray(raw.labels)) return raw.labels.map(String);
  if (Array.isArray(raw.names)) return raw.names.map(String);
  if (Array.isArray(raw.classes)) return raw.classes.map(String);

  const source =
    (raw.names && typeof raw.names === "object" && raw.names) ||
    (raw.labels && typeof raw.labels === "object" && raw.labels) ||
    raw;

  const entries = Object.entries(source);
  if (entries.every(([k]) => !Number.isNaN(Number(k)))) {
    return entries.sort((a, b) => Number(a[0]) - Number(b[0])).map(([, v]) => String(v));
  }
  if (entries.every(([, v]) => !Number.isNaN(Number(v)))) {
    return entries.sort((a, b) => Number(a[1]) - Number(b[1])).map(([k]) => String(k));
  }
  return entries.map(([, v]) => String(v));
}

/* Extracts Ultralytics embedded class names directly from the ONNX binary metadata */
function extractEmbeddedOnnxNames(arrayBuffer) {
  try {
    const text = new TextDecoder("latin1").decode(new Uint8Array(arrayBuffer));
    const match = text.match(/names\x12[\s\S]{1,4}(\{[^}]+\})/);
    if (!match) return null;
    const jsonLike = match[1].replace(/'/g, '"').replace(/(\d+)\s*:/g, '"$1":');
    const parsed = JSON.parse(jsonLike);
    const list = normalizeLabels(parsed);
    return list.length > 0 ? list : null;
  } catch (_) {
    return null;
  }
}

async function loadJson(path) {
  const response = await fetch(`${path}?v=${Date.now()}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`Unable to load ${path}`);
  return response.json();
}

async function initializeModel() {
  const rawLabels = await loadJson(LABELS_PATH);
  labelList = normalizeLabels(rawLabels);
  speechMap = await loadJson(SPEECH_PATH);

  if (!window.ort) throw new Error("ONNX Runtime failed to load");
  ort.env.wasm.wasmPaths = "https://cdn.jsdelivr.net/npm/onnxruntime-web/dist/";
  ort.env.wasm.numThreads = 1;

  const modelResponse = await fetch(`${MODEL_PATH}?v=${Date.now()}`, { cache: "no-store" });
  if (!modelResponse.ok) throw new Error(`Unable to load ${MODEL_PATH}`);
  const modelBuffer = await modelResponse.arrayBuffer();

  const embeddedNames = extractEmbeddedOnnxNames(modelBuffer);
  if (embeddedNames) {
    labelList = embeddedNames;
  }

  session = await ort.InferenceSession.create(modelBuffer, {
    executionProviders: ["wasm"],
    graphOptimizationLevel: "all"
  });
  inputTensorName = session.inputNames[0];

  const meta = session.inputMetadata?.[inputTensorName];
  const dims = meta?.dimensions || meta?.shape;
  if (dims?.length === 4) {
    const h = Number(dims[2]);
    const w = Number(dims[3]);
    if (h > 0 && w > 0) {
      modelInputHeight = h;
      modelInputWidth = w;
    }
  }

  console.log("Model loaded:", {
    modelPath: MODEL_PATH,
    embeddedNamesUsed: Boolean(embeddedNames),
    inputTensorName,
    inputSize: `${modelInputWidth}x${modelInputHeight}`,
    outputNames: session.outputNames,
    labelList
  });

  if (cameraStream) {
    updateResultUI({
      state: "idle",
      badge: "CAMERA READY",
      title: "Tap Scan Money",
      confidenceText: "Confidence: --",
      percent: 0
    });
  }
}

async function refreshCameras() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  const devices = await navigator.mediaDevices.enumerateDevices();
  cameras = devices.filter(device => device.kind === "videoinput");
  elements.switchCamera.hidden = cameras.length < 2;
  updateUtilityLayout();
}

function updateUtilityLayout() {}

async function startCamera(deviceId) {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("Camera unavailable. Open over HTTPS or localhost.");
  }
  elements.camera.classList.remove("is-ready");
  if (elements.cameraPlaceholder) {
    elements.cameraPlaceholder.classList.remove("is-hidden");
  }

  if (cameraStream) {
    cameraStream.getTracks().forEach(track => track.stop());
  }

  const constraints = {
    audio: false,
    video: deviceId
      ? { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } }
      : {
          facingMode: { ideal: "environment" },
          width: { ideal: 1280 },
          height: { ideal: 720 }
        }
  };

  try {
    cameraStream = await navigator.mediaDevices.getUserMedia(constraints);
  } catch (error) {
    if (!deviceId && error.name !== "NotAllowedError") {
      cameraStream = await navigator.mediaDevices.getUserMedia({ audio: false, video: true });
    } else {
      throw error;
    }
  }

  elements.camera.srcObject = cameraStream;
  const videoTrack = cameraStream.getVideoTracks()[0];
  const settings = videoTrack?.getSettings?.() || {};
  const labelLower = (videoTrack?.label || "").toLowerCase();

  isFrontCamera = settings.facingMode
    ? settings.facingMode === "user"
    : labelLower.includes("front") || labelLower.includes("integrated");

  elements.camera.style.transform = isFrontCamera ? "scaleX(-1)" : "none";
  await elements.camera.play();
  elements.camera.classList.add("is-ready");
  if (elements.cameraPlaceholder) elements.cameraPlaceholder.classList.add("is-hidden");
  await refreshCameras();

  updateResultUI({
    state: "idle",
    badge: "CAMERA READY",
    title: "Tap Scan Money",
    confidenceText: "Confidence: --",
    percent: 0
  });
  enableAutoScan();
}

async function switchCamera() {
  if (cameras.length < 2) return;
  cameraIndex = (cameraIndex + 1) % cameras.length;
  clearBoundingBox();
  const cameraStage = elements.camera.closest(".camera-stage");
  cameraStage.classList.remove("camera-swipe-in");
  void cameraStage.offsetWidth;
  cameraStage.classList.add("camera-swipe-in");
  await startCamera(cameras[cameraIndex].deviceId);
  speak("Camera switched.");
}

function getVisibleCrop() {
  const video = elements.camera;
  const vw = video.videoWidth || modelInputWidth;
  const vh = video.videoHeight || modelInputHeight;
  const rect = video.getBoundingClientRect();
  if (!rect.width || !rect.height) return { sx: 0, sy: 0, sw: vw, sh: vh };

  const scale = Math.max(rect.width / vw, rect.height / vh);
  const sw = Math.min(vw, rect.width / scale);
  const sh = Math.min(vh, rect.height / scale);
  return { sx: (vw - sw) / 2, sy: (vh - sh) / 2, sw, sh };
}

function drawFrameTensor() {
  const targetW = modelInputWidth;
  const targetH = modelInputHeight;
  const canvas = document.createElement("canvas");
  canvas.width = targetW;
  canvas.height = targetH;
  const context = canvas.getContext("2d", { willReadFrequently: true });

  context.fillStyle = "rgb(114, 114, 114)";
  context.fillRect(0, 0, targetW, targetH);

  const { sx, sy, sw, sh } = getVisibleCrop();
  const scale = Math.min(targetW / sw, targetH / sh);
  const width = sw * scale;
  const height = sh * scale;
  const left = (targetW - width) / 2;
  const top = (targetH - height) / 2;

  context.save();
  if (isFrontCamera) {
    context.translate(targetW, 0);
    context.scale(-1, 1);
  }
  context.drawImage(elements.camera, sx, sy, sw, sh, left, top, width, height);
  context.restore();

  const pixels = context.getImageData(0, 0, targetW, targetH).data;
  const planeSize = targetW * targetH;
  const floatData = new Float32Array(3 * planeSize);
  for (let i = 0; i < planeSize; i++) {
    floatData[i] = pixels[i * 4] / 255;
    floatData[planeSize + i] = pixels[i * 4 + 1] / 255;
    floatData[planeSize * 2 + i] = pixels[i * 4 + 2] / 255;
  }

  return {
    floatData,
    letterbox: { left, top, width, height, targetW, targetH }
  };
}

function denominationText(key) {
  const normalized = String(key || "").trim().toLowerCase();
  const names = {
    "coin_005": "₱0.05 — Five Centavos",
    "0.05": "₱0.05 — Five Centavos",
    "coin_025": "₱0.25 — Twenty-Five Centavos",
    "0.25": "₱0.25 — Twenty-Five Centavos",
    "coin_1": "₱1 — One Peso",
    "1": "₱1 — One Peso",
    "coin_5": "₱5 — Five Pesos",
    "5": "₱5 — Five Pesos",
    "coin_10": "₱10 — Ten Pesos",
    "10": "₱10 — Ten Pesos",
    "20": "₱20 — Twenty Pesos",
    "bill_20": "₱20 — Twenty Pesos",
    "coin_20": "₱20 — Twenty Pesos",
    "50": "₱50 — Fifty Pesos",
    "bill_50": "₱50 — Fifty Pesos",
    "100": "₱100 — One Hundred Pesos",
    "bill_100": "₱100 — One Hundred Pesos",
    "200": "₱200 — Two Hundred Pesos",
    "bill_200": "₱200 — Two Hundred Pesos",
    "500": "₱500 — Five Hundred Pesos",
    "bill_500": "₱500 — Five Hundred Pesos",
    "1000": "₱1,000 — One Thousand Pesos",
    "bill_1000": "₱1,000 — One Thousand Pesos"
  };
  return names[normalized] || String(key || "").replace(/_/g, " ");
}

function sigmoid(value) {
  return 1 / (1 + Math.exp(-value));
}

function mapObbToVideo(cxRaw, cyRaw, wRaw, hRaw, angle, letterbox) {
  const { left, top, width, height, targetW, targetH } = letterbox;
  const isPixel = Math.abs(cxRaw) > 2 || Math.abs(cyRaw) > 2 || Math.abs(wRaw) > 2;
  const px = isPixel ? cxRaw : cxRaw * targetW;
  const py = isPixel ? cyRaw : cyRaw * targetH;
  const pw = isPixel ? wRaw : wRaw * targetW;
  const ph = isPixel ? hRaw : hRaw * targetH;

  return {
    cx: Math.max(0, Math.min(1, (px - left) / width)),
    cy: Math.max(0, Math.min(1, (py - top) / height)),
    w: Math.max(0.01, Math.min(1, pw / width)),
    h: Math.max(0.01, Math.min(1, ph / height)),
    angle
  };
}

function postprocess(output, letterbox) {
  const data = output.data;
  const shape = Array.from(output.dims);
  const prob = value => (value >= 0 && value <= 1 ? value : sigmoid(value));
  const numClasses = labelList.length;

  // 1. End-to-End OBB format: [1, 300, 7] -> [cx, cy, w, h, score, class_id, angle]
  if (shape.length === 3 && shape[2] === 7) {
    const detections = shape[1];
    let best = null;
    for (let d = 0; d < detections; d++) {
      const base = d * 7;
      const score = prob(data[base + 4]);
      if (score <= 0) continue;
      const index = Math.round(data[base + 5]);
      const obb = mapObbToVideo(
        data[base],
        data[base + 1],
        data[base + 2],
        data[base + 3],
        data[base + 6],
        letterbox
      );
      if (!best || score > best.score) {
        best = { index, score, obb, shape };
      }
    }
    return best || { index: -1, score: 0, obb: null, shape };
  }

  // 2. End-to-End Detection format: [1, 300, 6] -> [x1, y1, x2, y2, score, class_id]
  if (shape.length === 3 && shape[2] === 6) {
    const detections = shape[1];
    let best = null;
    for (let d = 0; d < detections; d++) {
      const base = d * 6;
      const score = prob(data[base + 4]);
      if (score <= 0) continue;
      const index = Math.round(data[base + 5]);
      const cxRaw = (data[base] + data[base + 2]) / 2;
      const cyRaw = (data[base + 1] + data[base + 3]) / 2;
      const wRaw = Math.abs(data[base + 2] - data[base]);
      const hRaw = Math.abs(data[base + 3] - data[base + 1]);
      const obb = mapObbToVideo(cxRaw, cyRaw, wRaw, hRaw, 0, letterbox);
      if (!best || score > best.score) {
        best = { index, score, obb, shape };
      }
    }
    return best || { index: -1, score: 0, obb: null, shape };
  }

  // 3. Raw YOLO OBB [1, 4+C+1, anchors] or Detect [1, 4+C, anchors]
  if (shape.length === 3) {
    const first = shape[1];
    const second = shape[2];
    const channelsFirst = first < second;
    const detections = channelsFirst ? second : first;
    const stride = channelsFirst ? first : second;
    const isObb = numClasses > 0
      ? stride === 4 + numClasses + 1
      : stride > 5;
    const activeClasses = numClasses > 0
      ? Math.min(numClasses, stride - 4)
      : Math.max(1, stride - (isObb ? 5 : 4));
    let best = null;

    if (channelsFirst) {
      for (let d = 0; d < detections; d++) {
        let topClass = 0;
        let topScore = 0;
        for (let c = 0; c < activeClasses; c++) {
          const s = prob(data[(4 + c) * detections + d]);
          if (s > topScore) {
            topScore = s;
            topClass = c;
          }
        }
        if (!best || topScore > best.score) {
          const angle = isObb ? data[(4 + activeClasses) * detections + d] : 0;
          const obb = mapObbToVideo(
            data[d],
            data[detections + d],
            data[2 * detections + d],
            data[3 * detections + d],
            angle,
            letterbox
          );
          best = { index: topClass, score: topScore, obb, shape };
        }
      }
    } else {
      for (let d = 0; d < detections; d++) {
        const base = d * stride;
        let topClass = 0;
        let topScore = 0;
        for (let c = 0; c < activeClasses; c++) {
          const s = prob(data[base + 4 + c]);
          if (s > topScore) {
            topScore = s;
            topClass = c;
          }
        }
        if (!best || topScore > best.score) {
          const angle = isObb ? data[base + 4 + activeClasses] : 0;
          const obb = mapObbToVideo(
            data[base],
            data[base + 1],
            data[base + 2],
            data[base + 3],
            angle,
            letterbox
          );
          best = { index: topClass, score: topScore, obb, shape };
        }
      }
    }

    return best || { index: -1, score: 0, obb: null, shape };
  }

  return { index: -1, score: 0, obb: null, shape };
}

async function runInferenceWithAutoResize() {
  try {
    const { floatData, letterbox } = drawFrameTensor();
    const input = new ort.Tensor("float32", floatData, [1, 3, modelInputHeight, modelInputWidth]);
    const results = await session.run({ [inputTensorName]: input });
    const firstOutput = results[Object.keys(results)[0]];
    return postprocess(firstOutput, letterbox);
  } catch (error) {
    const match = String(error.message).match(/Expected:\s*(\d+)/i);
    if (match) {
      const expectedSize = Number(match[1]);
      if (expectedSize > 0 && expectedSize !== modelInputWidth) {
        modelInputWidth = expectedSize;
        modelInputHeight = expectedSize;
        const { floatData, letterbox } = drawFrameTensor();
        const input = new ort.Tensor("float32", floatData, [1, 3, modelInputHeight, modelInputWidth]);
        const results = await session.run({ [inputTensorName]: input });
        const firstOutput = results[Object.keys(results)[0]];
        return postprocess(firstOutput, letterbox);
      }
    }
    throw error;
  }
}

async function scanMoney() {
  if (scanning) return;

  if (!cameraStream || elements.camera.readyState < 2) {
    if (cameraPositioningOnly) return;
    cameraPositioningOnly = true;
    updateResultUI({
      state: "idle",
      badge: "STARTING CAMERA",
      title: "Opening Camera...",
      confidenceText: "Please allow camera permission",
      percent: 0
    });
    scanStartedFeedback();
    speak("Opening camera. You can place your money anywhere in the camera view.");

    try {
      await startCamera();
      cameraPositioningOnly = false;
      speak("Camera ready. Tap Scan Money when your money is visible.");
    } catch (error) {
      console.error(error);
      cameraPositioningOnly = false;
      const message = error.name === "NotAllowedError"
        ? "Camera permission denied. Allow camera access, then tap Scan again."
        : "Camera unavailable. Close other apps using the camera, then tap Scan again.";
      updateResultUI({
        state: "warn",
        badge: "CAMERA ERROR",
        title: "Camera Unavailable",
        confidenceText: message,
        percent: 0
      });
      speak(message);
    }
    return;
  }

  if (!session) {
    try {
      await initializeModel();
    } catch (error) {
      console.error(error);
      updateResultUI({
        state: "warn",
        badge: "MODEL ERROR",
        title: "Model Unavailable",
        confidenceText: "Check model/best.onnx",
        percent: 0
      });
      speak("Model unavailable. Please check the model files.");
      return;
    }
  }

  scanning = true;
  document.body.classList.add("is-scanning");
  const scanSub = elements.scan.querySelector(".btn-sub");
  if (scanSub) scanSub.textContent = "Analyzing...";
  scanStartedFeedback();

  try {
    const best = await runInferenceWithAutoResize();
    const percent = Math.round(best.score * 100);
    const key = best.index >= 0 ? (labelList[best.index] || `class_${best.index}`) : "";
    const displayText = denominationText(key);

    console.log("Scan debug:", {
      shape: best.shape,
      index: best.index,
      score: best.score,
      percent,
      matchedKey: key,
      labelList
    });

    if (percent >= CONFIDENCE_THRESHOLD && best.index >= 0) {
      const speechText = speechMap[key] || speechMap[String(key).toLowerCase()] || displayText;
      drawOrientedBox(best.obb, `${displayText} (${percent}%)`);
      updateResultUI({
        state: "success",
        badge: "CURRENCY IDENTIFIED",
        title: displayText,
        confidenceText: `Confidence: ${percent}%`,
        percent
      });
      successFeedback();
      speak(speechText);
      lastAnnouncement = speechText;
      if (serialPort) writeSerial("SUCCESS\n");
    } else {
      clearBoundingBox();
      updateResultUI({
        state: "warn",
        badge: "TRY AGAIN",
        title: "No Money Detected",
        confidenceText: `Confidence: ${percent}%`,
        percent
      });
      const message = "No money detected. Please try scanning again.";
      failFeedback();
      speak(message);
      lastAnnouncement = message;
      if (serialPort) writeSerial("FAIL\n");
    }
  } catch (error) {
    console.error(error);
    clearBoundingBox();
    updateResultUI({
      state: "warn",
      badge: "SCAN ERROR",
      title: "Scan Failed",
      confidenceText: "Please try scanning again",
      percent: 0
    });
    failFeedback();
    speak("Scan failed. Please try again.");
  } finally {
    scanning = false;
    document.body.classList.remove("is-scanning");
    const scanSub = elements.scan.querySelector(".btn-sub");
    if (scanSub) scanSub.textContent = "Press Space";
  }
}

function repeatAudio() {
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
  if (lastAnnouncement) {
    speak(lastAnnouncement);
  } else {
    speak("No result yet. Tap Scan Money or press Spacebar to scan.");
  }
}

function startAutoScan() {
  if (autoScanTimer) window.clearInterval(autoScanTimer);
  autoScanTimer = window.setInterval(() => {
    if (autoScanEnabled && !isSpeechActive() && !scanning) scanMoney();
  }, 3500);
}

function enableAutoScan() {
  autoScanEnabled = true;
  elements.auto.setAttribute("aria-pressed", "true");
  elements.auto.setAttribute("aria-label", "Auto-scan on");
  const state = elements.auto.querySelector("strong");
  if (state) state.textContent = "ON";
  startAutoScan();
  speak("Camera ready. Auto-scan on.");
}

function toggleAutoScan() {
  autoScanEnabled = !autoScanEnabled;
  elements.auto.setAttribute("aria-pressed", String(autoScanEnabled));
  elements.auto.setAttribute("aria-label", `Auto-scan ${autoScanEnabled ? "on" : "off"}`);
  const state = elements.auto.querySelector("strong");
  if (state) state.textContent = autoScanEnabled ? "ON" : "OFF";
  if (autoScanEnabled) {
    startAutoScan();
    speak("Auto-scan on.");
  } else {
    if (autoScanTimer) window.clearInterval(autoScanTimer);
    autoScanTimer = null;
    speak("Auto-scan off.");
  }
}

async function connectArduino() {
  if (!("serial" in navigator)) {
    speak("Web Serial is not supported in this browser.");
    return;
  }

  try {
    serialPort = await navigator.serial.requestPort();
    await serialPort.open({ baudRate: 9600 });
    const label = elements.arduino.querySelector("span:not(.control-icon)");
    if (label) label.textContent = "Arduino connected";
    elements.arduino.setAttribute("aria-pressed", "true");
    elements.arduino.setAttribute("aria-label", "Arduino connected");
    speak("Arduino connected.");
    readSerial();
  } catch (error) {
    if (error.name !== "NotFoundError") console.error(error);
  }
}

async function readSerial() {
  const textDecoder = new TextDecoderStream();
  serialPort.readable.pipeTo(textDecoder.writable);
  serialReader = textDecoder.readable.getReader();
  let buffer = "";

  try {
    while (true) {
      const { value, done } = await serialReader.read();
      if (done) break;
      buffer += value;
      let newlineIndex;
      while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
        const command = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (command === "SCAN") scanMoney();
        if (command === "REPEAT") repeatAudio();
      }
    }
  } catch (error) {
    console.error(error);
  }
}

async function writeSerial(text) {
  if (!serialPort?.writable) return;
  const writer = serialPort.writable.getWriter();
  await writer.write(new TextEncoder().encode(text));
  writer.releaseLock();
}

async function startSystem() {
  if (systemStarting) return;
  systemStarting = true;
  ensureAudioContext();
  document.body.classList.add("is-started");
  elements.overlay.hidden = true;
  speak("System ready. Tap Scan Money or press Spacebar to identify currency. Tap Repeat Audio or press R to repeat.");

  try {
    await initializeModel();
  } catch (error) {
    console.error(error);
    updateResultUI({
      state: "warn",
      badge: "MODEL ERROR",
      title: "Model Unavailable",
      confidenceText: "Check model/best.onnx",
      percent: 0
    });
    speak("Model unavailable. Please check the model files.");
  }

  try {
    await startCamera();
  } catch (error) {
    console.error(error);
    const message = error.name === "NotAllowedError"
      ? "Camera permission denied. Allow camera access, then tap Scan."
      : "Camera unavailable. Tap Scan to try again.";
    updateResultUI({
      state: "warn",
      badge: "CAMERA NEEDED",
      title: "Camera Unavailable",
      confidenceText: message,
      percent: 0
    });
  }

  systemStarting = false;
}

elements.start.addEventListener("click", startSystem);
elements.overlay.addEventListener("pointerdown", event => {
  if (event.target !== elements.start) startSystem();
});
elements.scan.addEventListener("click", scanMoney);
elements.repeat.addEventListener("click", repeatAudio);
elements.auto.addEventListener("click", toggleAutoScan);
elements.switchCamera.addEventListener("click", switchCamera);
elements.arduino.addEventListener("click", connectArduino);

function addPressRipple(button) {
  button.addEventListener("pointerdown", event => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const rect = button.getBoundingClientRect();
    const ripple = document.createElement("span");
    ripple.className = "press-ripple";
    ripple.style.left = `${event.clientX - rect.left}px`;
    ripple.style.top = `${event.clientY - rect.top}px`;
    button.appendChild(ripple);
    window.setTimeout(() => ripple.remove(), 650);
  });
}

addPressRipple(elements.scan);
addPressRipple(elements.repeat);
addPressRipple(elements.start);

document.addEventListener("keydown", event => {
  if (event.repeat) return;
  if (event.code === "Space") {
    event.preventDefault();
    scanMoney();
  }
  if (event.key.toLowerCase() === "r") {
    event.preventDefault();
    repeatAudio();
  }
});

if ("serial" in navigator) {
  elements.arduino.hidden = false;
}
updateUtilityLayout();
window.addEventListener("resize", clearBoundingBox);

elements.camera.addEventListener("pointerdown", event => {
  cameraSwipeStartX = event.clientX;
  cameraSwipeStartY = event.clientY;
});

elements.camera.addEventListener("pointerup", event => {
  if (cameraSwipeStartX === null) return;
  const deltaX = event.clientX - cameraSwipeStartX;
  const deltaY = event.clientY - cameraSwipeStartY;
  cameraSwipeStartX = null;
  cameraSwipeStartY = null;

  if (Math.abs(deltaX) > 56 && Math.abs(deltaX) > Math.abs(deltaY) * 1.35) {
    if (cameras.length > 1) {
      switchCamera();
    }
  }
});

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(error => console.error(error));
  });
}

function updateConnectionState() {
  if (!elements.systemStateText) return;
  elements.systemStateText.textContent = navigator.onLine ? "Ready" : "Offline";
  if (!navigator.onLine) {
    elements.systemStateText.closest(".system-state")?.setAttribute("aria-label", "App is offline");
  } else {
    elements.systemStateText.closest(".system-state")?.setAttribute("aria-label", "App is ready");
  }
}

window.addEventListener("online", updateConnectionState);
window.addEventListener("offline", updateConnectionState);
updateConnectionState();