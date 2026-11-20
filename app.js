"use strict";

const MODEL_PATH = "model/best.onnx";
const LABELS_PATH = "model/labels.json";
const SPEECH_PATH = "model/speech.json";

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
  repeat: document.getElementById("repeatButton")
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

  const videoW = elements.camera.videoWidth || modelInputWidth;
  const videoH = elements.camera.videoHeight || modelInputHeight;
  const coverScale = Math.max(canvas.width / videoW, canvas.height / videoH);
  const renderedW = videoW * coverScale;
  const renderedH = videoH * coverScale;
  const offsetX = (canvas.width - renderedW) / 2;
  const offsetY = (canvas.height - renderedH) / 2;

  let cx = offsetX + obb.cx * renderedW;
  const cy = offsetY + obb.cy * renderedH;
  const boxW = Math.max(16, obb.w * renderedW);
  const boxH = Math.max(16, obb.h * renderedH);
  let angle = obb.angle || 0;

  if (elements.camera.style.transform === "scaleX(-1)") {
    cx = canvas.width - cx;
    angle = -angle;
  }

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

  session = await ort.InferenceSession.create(MODEL_PATH, {
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

function updateUtilityLayout() {
  const visibleControls = Array.from(document.querySelectorAll(".utility-button"))
    .filter(button => !button.hidden).length;
  document.querySelector(".utility-bar").style.gridTemplateColumns =
    `repeat(${Math.max(visibleControls, 1)}, minmax(0, 1fr))`;
}

async function startCamera(deviceId) {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("Camera unavailable. Open over HTTPS or localhost.");
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
  await startCamera(cameras[cameraIndex].deviceId);
  speak("Camera switched.");
}

function drawFrameTensor() {
  const targetW = modelInputWidth;
  const targetH = modelInputHeight;
  const canvas = document.createElement("canvas");
  canvas.width = targetW;
  canvas.height = targetH;
  const context = canvas.getContext("2d", { willReadFrequently: true });

  // Standard Ultralytics YOLO neutral gray letterbox padding
  context.fillStyle = "rgb(114, 114, 114)";
  context.fillRect(0, 0, targetW, targetH);

  const sourceWidth = elements.camera.videoWidth || targetW;
  const sourceHeight = elements.camera.videoHeight || targetH;
  const scale = Math.min(targetW / sourceWidth, targetH / sourceHeight);
  const width = sourceWidth * scale;
  const height = sourceHeight * scale;
  const left = (targetW - width) / 2;
  const top = (targetH - height) / 2;

  context.drawImage(elements.camera, left, top, width, height);

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
  const normalized = String(key || "").trim();
  const names = {
    "coin_005": "₱0.05 — Five Centavos",
    "coin_025": "₱0.25 — Twenty-Five Centavos",
    "coin_1": "₱1 — One Peso",
    "coin_5": "₱5 — Five Pesos",
    "coin_10": "₱10 — Ten Pesos",
    "20": "₱20 — Twenty Pesos",
    "bill_20": "₱20 — Twenty Pesos",
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
  return names[normalized] || normalized.replace(/_/g, " ");
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
  const numClasses = labelList.length || 11;

  // 1. YOLO26 / End-to-End OBB format: [1, 300, 7] -> [cx, cy, w, h, score, class_id, angle]
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
        best = { index, score, obb };
      }
    }
    return best || { index: -1, score: 0, obb: null };
  }

  // 2. Standard End-to-End Detection format: [1, 300, 6] -> [x1, y1, x2, y2, score, class_id]
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
        best = { index, score, obb };
      }
    }
    return best || { index: -1, score: 0, obb: null };
  }

  // 3. Raw YOLO OBB [1, 4+C+1, anchors] or Detect [1, 4+C, anchors]
  if (shape.length === 3) {
    const first = shape[1];
    const second = shape[2];
    const channelsFirst = first < second;
    const detections = channelsFirst ? second : first;
    const stride = channelsFirst ? first : second;
    const isObb = stride === 4 + numClasses + 1;
    const activeClasses = isObb ? numClasses : Math.max(1, stride - 4);
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
          best = { index: topClass, score: topScore, obb };
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
          best = { index: topClass, score: topScore, obb };
        }
      }
    }

    return best || { index: -1, score: 0, obb: null };
  }

  return { index: -1, score: 0, obb: null };
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
        confidenceText: "Check model/moneyphpbest.onnx",
        percent: 0
      });
      speak("Model unavailable. Please check the model files.");
      return;
    }
  }

  scanning = true;
  scanStartedFeedback();

  try {
    const best = await runInferenceWithAutoResize();
    const percent = Math.round(best.score * 100);
    const key = best.index >= 0 ? (labelList[best.index] || "") : "";
    const displayText = denominationText(key);

    if (percent >= 50 && key) {
      const speechText = speechMap[key] || displayText;
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
  elements.auto.textContent = "Auto-Scan: ON";
  startAutoScan();
  speak("Camera ready. Auto-scan on.");
}

function toggleAutoScan() {
  autoScanEnabled = !autoScanEnabled;
  elements.auto.setAttribute("aria-pressed", String(autoScanEnabled));
  elements.auto.setAttribute("aria-label", `Auto-scan ${autoScanEnabled ? "on" : "off"}`);
  elements.auto.textContent = `Auto-Scan: ${autoScanEnabled ? "ON" : "OFF"}`;
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
    elements.arduino.textContent = "Arduino: Connected";
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
      confidenceText: "Check model/moneyphpbest.onnx",
      percent: 0
    });
    speak("Model unavailable. Please check the model files.");
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

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(error => console.error(error));
  });
}