const videoElement = document.getElementById('video');
const canvasElement = document.getElementById('canvas');
const canvasCtx = canvasElement.getContext('2d');

const angleValueElement = document.getElementById('angle-value');
const statusTextElement = document.getElementById('status-text');
const pathologyTextElement = document.getElementById('pathology-text');
const angleCard = document.getElementById('angle-card');
const scaleMarker = document.getElementById('scale-marker');
const romValueElement = document.getElementById('rom-value');
const maxValueElement = document.getElementById('max-value');
const minValueElement = document.getElementById('min-value');
const legValueElement = document.getElementById('leg-value');
const stageEmpty = document.getElementById('stage-empty');
const stageResolution = document.getElementById('stage-resolution');
const trackingStatus = document.getElementById('tracking-status');
const recordingLabel = document.getElementById('recording-label');
const sourceBadge = document.getElementById('source-badge');
const sourceLabel = document.getElementById('source-label');
const liveChip = document.getElementById('live-chip');
const sessionClock = document.getElementById('session-clock');
const sampleCount = document.getElementById('sample-count');
const chartEmpty = document.getElementById('chart-empty');
const captureNote = document.getElementById('capture-note');

const startCameraButton = document.getElementById('start-camera-btn');
const stopButton = document.getElementById('stop-btn');
const resetButton = document.getElementById('reset-btn');
const uploadInput = document.getElementById('video-upload');
const legSelect = document.getElementById('leg-select');

const state = {
  mode: 'idle', // idle | camera | file
  stream: null,
  fileUrl: null,
  animationFrameId: null,
  processing: false,
  lastVideoTime: -1,
  lastChartUpdate: 0,
  startTime: null,
  clockTimer: null,
  sampleTimes: [],
  angles: [],
  minAngle: Infinity,
  maxAngle: -Infinity,
  smoothedAngle: null,
  lastLeg: '--',
  autoSide: null,
  poseReady: false,
};

const MAX_CHART_POINTS = 180;
const CHART_INTERVAL_MS = 180;

function formatAngle(value, decimals = 1) {
  if (!Number.isFinite(value)) return '--';
  const rounded = Number(value.toFixed(decimals));
  return `${rounded > 0 ? '+' : ''}${rounded}`;
}

function landmarkConfidence(point) {
  if (!point) return 0;
  const visibility = Number.isFinite(point.visibility) ? point.visibility : null;
  const presence = Number.isFinite(point.presence) ? point.presence : null;
  if (visibility === null && presence === null) return 0;
  if (visibility === null) return presence;
  if (presence === null) return visibility;
  return Math.min(visibility, presence);
}

function createLandmarkSet(landmarks, side) {
  const isLeft = side === 'left';
  const set = {
    key: side,
    side: isLeft ? 'Izquierda' : 'Derecha',
    knee: landmarks[isLeft ? 25 : 26],
    ankle: landmarks[isLeft ? 27 : 28],
    heel: landmarks[isLeft ? 29 : 30],
    toe: landmarks[isLeft ? 31 : 32],
  };

  // Para medir el tobillo necesitamos cuatro hitos visibles, no solo la punta del pie.
  const points = [set.knee, set.ankle, set.heel, set.toe];
  const confidences = points.map(landmarkConfidence);
  const average = confidences.reduce((sum, value) => sum + value, 0) / confidences.length;
  const weakest = Math.min(...confidences);
  set.score = (average * 0.65) + (weakest * 0.35);
  set.valid = points.every((point) => landmarkConfidence(point) >= 0.50);
  return set;
}

function getLandmarkSet(landmarks) {
  const left = createLandmarkSet(landmarks, 'left');
  const right = createLandmarkSet(landmarks, 'right');
  const selectedSide = legSelect.value;

  if (selectedSide === 'left') {
    state.autoSide = null;
    return left;
  }
  if (selectedSide === 'right') {
    state.autoSide = null;
    return right;
  }

  // En automático se mantiene la pierna elegida para evitar saltos entre lados
  // cuando la confianza de MediaPipe fluctúa ligeramente entre fotogramas.
  const current = state.autoSide === 'left' ? left : state.autoSide === 'right' ? right : null;
  const alternative = state.autoSide === 'left' ? right : left;

  if (current && current.valid) {
    if (alternative.valid && alternative.score > current.score * 1.25 && alternative.score > 0.72) {
      state.autoSide = alternative.key;
      return alternative;
    }
    return current;
  }

  const best = left.score >= right.score ? left : right;
  const other = best.key === 'left' ? right : left;
  if (best.valid && best.score >= 0.58) {
    state.autoSide = best.key;
    return best;
  }
  if (other.valid && other.score >= 0.58) {
    state.autoSide = other.key;
    return other;
  }
  return best;
}

function isLandmarkVisible(point) {
  return landmarkConfidence(point) >= 0.50;
}

function calculateAnkleAngle(knee, ankle, heel, toe) {
  // Se trabaja en píxeles: x e y de MediaPipe están normalizados por separado.
  // Corregir la relación de aspecto evita distorsionar el ángulo en videos 16:9.
  const width = canvasElement.width;
  const height = canvasElement.height;
  const shank = {
    x: (knee.x - ankle.x) * width,
    y: (knee.y - ankle.y) * height,
  };
  // Eje longitudinal del pie: talón -> punta, más estable que tobillo -> punta.
  const foot = {
    x: (toe.x - heel.x) * width,
    y: (toe.y - heel.y) * height,
  };

  const shankLength = Math.hypot(shank.x, shank.y);
  const footLength = Math.hypot(foot.x, foot.y);
  if (shankLength < 18 || footLength < 18) return null;

  const dot = (shank.x * foot.x) + (shank.y * foot.y);
  const cosine = Math.max(-1, Math.min(1, dot / (shankLength * footLength)));
  const includedAngle = Math.acos(cosine) * (180 / Math.PI);

  // Convención: 90° entre tibia y pie = neutro; menor = dorsiflexión (+),
  // mayor = flexión plantar (−). El cálculo es válido con el pie orientado
  // hacia la izquierda o hacia la derecha de la imagen.
  return 90 - includedAngle;
}

function setTrackingState(detected, message) {
  trackingStatus.classList.toggle('detected', detected);
  trackingStatus.innerHTML = `<span class="tracking-dot"></span> ${message}`;
}

function resizeCanvasToImage(image) {
  const width = image.videoWidth || image.width || 640;
  const height = image.videoHeight || image.height || 480;
  if (canvasElement.width !== width || canvasElement.height !== height) {
    canvasElement.width = width;
    canvasElement.height = height;
    stageResolution.textContent = `${width} × ${height}`;
  }
}

function drawSkeleton(knee, ankle, heel, toe) {
  const width = canvasElement.width;
  const height = canvasElement.height;
  const px = (point) => ({ x: point.x * width, y: point.y * height });
  const points = [
    { point: knee, label: 'RODILLA', color: '#55d8a6' },
    { point: ankle, label: 'TOBILLO', color: '#ffbe69' },
    { point: heel, label: 'TALÓN', color: '#77b7ff' },
    { point: toe, label: 'PUNTA', color: '#d6a2ff' },
  ];

  canvasCtx.save();
  canvasCtx.lineCap = 'round';
  canvasCtx.lineJoin = 'round';

  // Segmento de la pierna (rodilla-tobillo).
  canvasCtx.beginPath();
  canvasCtx.moveTo(px(knee).x, px(knee).y);
  canvasCtx.lineTo(px(ankle).x, px(ankle).y);
  canvasCtx.strokeStyle = '#55d8a6';
  canvasCtx.lineWidth = Math.max(3, width * 0.004);
  canvasCtx.shadowColor = 'rgba(74, 218, 201, .45)';
  canvasCtx.shadowBlur = 10;
  canvasCtx.stroke();

  // Eje del pie utilizado en el cálculo (talón-punta).
  canvasCtx.beginPath();
  canvasCtx.moveTo(px(heel).x, px(heel).y);
  canvasCtx.lineTo(px(toe).x, px(toe).y);
  canvasCtx.strokeStyle = '#77b7ff';
  canvasCtx.lineWidth = Math.max(3, width * 0.004);
  canvasCtx.stroke();
  canvasCtx.shadowBlur = 0;

  // Unión visual tobillo-talón para mostrar los cuatro hitos del modelo.
  canvasCtx.beginPath();
  canvasCtx.moveTo(px(ankle).x, px(ankle).y);
  canvasCtx.lineTo(px(heel).x, px(heel).y);
  canvasCtx.strokeStyle = 'rgba(255,255,255,.72)';
  canvasCtx.lineWidth = Math.max(2, width * 0.0025);
  canvasCtx.setLineDash([5, 6]);
  canvasCtx.stroke();
  canvasCtx.setLineDash([]);

  points.forEach(({ point, label, color }) => {
    const position = px(point);
    const radius = Math.max(5, width * 0.0065);
    canvasCtx.beginPath();
    canvasCtx.arc(position.x, position.y, radius, 0, Math.PI * 2);
    canvasCtx.fillStyle = color;
    canvasCtx.fill();
    canvasCtx.lineWidth = 2;
    canvasCtx.strokeStyle = '#071522';
    canvasCtx.stroke();

    // Etiquetas pequeñas para comprobar visualmente que cada hito esté bien ubicado.
    canvasCtx.font = `600 ${Math.max(10, width * 0.012)}px Arial`;
    const textWidth = canvasCtx.measureText(label).width;
    const labelX = Math.min(Math.max(4, position.x + radius + 5), width - textWidth - 10);
    const labelY = Math.max(14, position.y - radius - 7);
    canvasCtx.fillStyle = 'rgba(5, 15, 27, .78)';
    canvasCtx.fillRect(labelX - 4, labelY - 11, textWidth + 8, 16);
    canvasCtx.fillStyle = '#ffffff';
    canvasCtx.fillText(label, labelX, labelY + 1);
  });
  canvasCtx.restore();
}

function classifyAngle(angle) {
  if (angle > 20) {
    return {
      label: 'Dorsiflexión sobre referencia',
      description: 'El valor supera el límite superior configurado (+20°). Interpreta el resultado junto con la evaluación clínica.',
      className: 'warning',
    };
  }
  if (angle < -25) {
    return {
      label: 'Flexión plantar sobre referencia',
      description: 'El valor está por debajo del límite inferior configurado (−25°). Revisa la técnica y la posición de la cámara.',
      className: 'danger',
    };
  }
  if (angle >= 0) {
    return {
      label: 'Dorsiflexión en referencia',
      description: 'La medición está dentro del rango de referencia configurado para dorsiflexión.',
      className: 'normal',
    };
  }
  return {
    label: 'Flexión plantar en referencia',
    description: 'La medición está dentro del rango de referencia configurado para flexión plantar.',
    className: 'normal',
  };
}

function updateAngleUI(angle, legSide) {
  angleValueElement.textContent = formatAngle(angle, 1);
  const classification = classifyAngle(angle);
  statusTextElement.textContent = classification.label;
  pathologyTextElement.textContent = classification.description;
  angleCard.classList.remove('warning', 'danger');
  if (classification.className !== 'normal') angleCard.classList.add(classification.className);
  legValueElement.textContent = legSide;

  // Escala visual limitada a -40° ... +40°.
  const normalized = Math.max(0, Math.min(100, ((angle + 40) / 80) * 100));
  scaleMarker.style.left = `${normalized}%`;
}

function updateMetrics() {
  if (state.angles.length === 0) {
    romValueElement.innerHTML = '--<small>°</small>';
    maxValueElement.innerHTML = '--<small>°</small>';
    minValueElement.innerHTML = '--<small>°</small>';
    sampleCount.textContent = '0 muestras';
    return;
  }
  const rom = state.maxAngle - state.minAngle;
  romValueElement.innerHTML = `${rom.toFixed(1)}<small>°</small>`;
  maxValueElement.innerHTML = `${formatAngle(state.maxAngle, 1)}<small>°</small>`;
  minValueElement.innerHTML = `${formatAngle(state.minAngle, 1)}<small>°</small>`;
  sampleCount.textContent = `${state.angles.length} muestras`;
}

function updateSessionClock() {
  if (!state.startTime) {
    sessionClock.textContent = '00:00';
    return;
  }
  const elapsed = Math.floor((Date.now() - state.startTime) / 1000);
  const minutes = String(Math.floor(elapsed / 60)).padStart(2, '0');
  const seconds = String(elapsed % 60).padStart(2, '0');
  sessionClock.textContent = `${minutes}:${seconds}`;
}

function startClock() {
  if (!state.startTime) state.startTime = Date.now();
  if (state.clockTimer) clearInterval(state.clockTimer);
  state.clockTimer = setInterval(updateSessionClock, 500);
  updateSessionClock();
}

function stopClock() {
  if (state.clockTimer) clearInterval(state.clockTimer);
  state.clockTimer = null;
}

function updateChart(angle, timestamp) {
  const elapsedSeconds = Math.max(0, (timestamp - state.startTime) / 1000);
  const minutes = String(Math.floor(elapsedSeconds / 60)).padStart(2, '0');
  const seconds = String(Math.floor(elapsedSeconds % 60)).padStart(2, '0');
  const label = `${minutes}:${seconds}`;

  romChart.data.labels.push(label);
  romChart.data.datasets[0].data.push(Number(angle.toFixed(2)));
  romChart.data.datasets[1].data.push(0);
  romChart.data.datasets[2].data.push(20);
  romChart.data.datasets[3].data.push(-25);

  if (romChart.data.labels.length > MAX_CHART_POINTS) {
    romChart.data.labels.shift();
    romChart.data.datasets.forEach((dataset) => dataset.data.shift());
  }
  romChart.update('none');
  chartEmpty.classList.add('hidden');
}

function recordAngle(angle, legSide) {
  // Suavizado exponencial ligero para reducir pequeños saltos de los landmarks.
  state.smoothedAngle = state.smoothedAngle === null
    ? angle
    : (state.smoothedAngle * 0.72) + (angle * 0.28);
  const stableAngle = state.smoothedAngle;

  state.angles.push(stableAngle);
  state.minAngle = Math.min(state.minAngle, stableAngle);
  state.maxAngle = Math.max(state.maxAngle, stableAngle);
  state.lastLeg = legSide;

  updateAngleUI(stableAngle, legSide);
  updateMetrics();

  const now = performance.now();
  if (now - state.lastChartUpdate >= CHART_INTERVAL_MS) {
    updateChart(stableAngle, Date.now());
    state.lastChartUpdate = now;
  }
}

function onPoseResults(results) {
  const image = results.image;
  if (!image) return;

  resizeCanvasToImage(image);
  canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);
  canvasCtx.drawImage(image, 0, 0, canvasElement.width, canvasElement.height);
  stageEmpty.hidden = true;

  const landmarks = results.poseLandmarks;
  if (!landmarks) {
    setTrackingState(false, 'No se detecta la pierna');
    angleValueElement.textContent = '--';
    statusTextElement.textContent = 'Esperando puntos de referencia';
    pathologyTextElement.textContent = 'Mantén la rodilla, el tobillo, el talón y la punta del pie visibles en la imagen.';
    return;
  }

  const selected = getLandmarkSet(landmarks);
  const { knee, ankle, heel, toe, side } = selected;
  const requiredLandmarks = [knee, ankle, heel, toe];
  if (!requiredLandmarks.every(isLandmarkVisible)) {
    setTrackingState(false, 'Hitos anatómicos incompletos');
    angleValueElement.textContent = '--';
    statusTextElement.textContent = 'No se reconocen todos los hitos';
    pathologyTextElement.textContent = 'Se necesitan rodilla, tobillo, talón y punta del pie. Usa una vista lateral y evita ocultar el pie.';
    return;
  }

  const clinicalAngle = calculateAnkleAngle(knee, ankle, heel, toe);
  if (clinicalAngle === null || !Number.isFinite(clinicalAngle)) {
    setTrackingState(false, 'Ajusta la posición');
    angleValueElement.textContent = '--';
    statusTextElement.textContent = 'Puntos demasiado próximos';
    pathologyTextElement.textContent = 'Separa ligeramente la pierna del fondo y asegúrate de que la cámara vea el talón y la punta del pie.';
    return;
  }

  drawSkeleton(knee, ankle, heel, toe);
  setTrackingState(true, `Hitos detectados · Pierna ${side.toLowerCase()}`);
  recordAngle(clinicalAngle, side);
}

function setCaptureUI(mode) {
  const active = mode !== 'idle';
  state.mode = mode;
  stopButton.disabled = !active;
  startCameraButton.disabled = mode === 'camera';
  liveChip.classList.toggle('active', active);
  liveChip.textContent = active ? 'ANALIZANDO' : 'INACTIVO';
  recordingLabel.classList.toggle('active', active);
  recordingLabel.innerHTML = active
    ? '<span class="recording-dot"></span> ANALIZANDO'
    : '<span class="recording-dot"></span> EN ESPERA';
  sourceBadge.classList.toggle('active', active);
  sourceLabel.textContent = mode === 'camera' ? 'Webcam' : mode === 'file' ? 'Video cargado' : 'Sin señal';
}

function startProcessingLoop() {
  cancelAnimationFrame(state.animationFrameId);
  state.lastVideoTime = -1;

  const process = async () => {
    if (state.mode === 'idle') return;
    if (videoElement.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
        videoElement.videoWidth > 0 &&
        videoElement.currentTime !== state.lastVideoTime &&
        !state.processing) {
      state.processing = true;
      state.lastVideoTime = videoElement.currentTime;
      try {
        await pose.send({ image: videoElement });
      } catch (error) {
        console.error('Error procesando el cuadro con MediaPipe:', error);
        captureNote.textContent = 'No se pudo procesar un cuadro. Comprueba que el video tenga un formato compatible.';
      } finally {
        state.processing = false;
      }
    }
    if (state.mode !== 'idle') state.animationFrameId = requestAnimationFrame(process);
  };

  state.animationFrameId = requestAnimationFrame(process);
}

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    alert('Tu navegador no permite acceder a la cámara. Abre la aplicación mediante HTTPS o desde localhost.');
    return;
  }

  stopCapture(false);
  resetMeasurements();
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: 'user',
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
    });
    videoElement.srcObject = state.stream;
    videoElement.loop = true;
    await videoElement.play();
    canvasElement.classList.add('mirrored');
    setCaptureUI('camera');
    startClock();
    setTrackingState(false, 'Buscando pierna');
    captureNote.textContent = 'Webcam activa. Coloca la pierna de perfil y mantén rodilla, tobillo y pie dentro del encuadre.';
    startProcessingLoop();
  } catch (error) {
    console.error('No se pudo iniciar la webcam:', error);
    stopCapture(false);
    let message = 'No se pudo iniciar la cámara.';
    if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') {
      message = 'Permite el acceso a la cámara desde los permisos del navegador y vuelve a intentarlo.';
    } else if (error.name === 'NotFoundError' || error.name === 'DevicesNotFoundError') {
      message = 'No se encontró una cámara conectada al dispositivo.';
    }
    captureNote.textContent = message;
    alert(message);
  }
}

async function loadVideo(file) {
  if (!file) return;
  if (!file.type.startsWith('video/')) {
    alert('Selecciona un archivo de video válido.');
    uploadInput.value = '';
    return;
  }

  stopCapture(false);
  resetMeasurements();
  if (state.fileUrl) URL.revokeObjectURL(state.fileUrl);
  state.fileUrl = URL.createObjectURL(file);
  videoElement.srcObject = null;
  videoElement.src = state.fileUrl;
  videoElement.loop = true;
  videoElement.muted = true;
  canvasElement.classList.remove('mirrored');

  try {
    await new Promise((resolve, reject) => {
      videoElement.onloadedmetadata = resolve;
      videoElement.onerror = () => reject(new Error('No se pudo abrir el archivo de video.'));
    });
    await videoElement.play();
    setCaptureUI('file');
    startClock();
    setTrackingState(false, 'Procesando video');
    captureNote.textContent = `Analizando: ${file.name}. El video se reproduce en bucle para facilitar la observación.`;
    startProcessingLoop();
  } catch (error) {
    console.error('Error al cargar el video:', error);
    stopCapture(false);
    captureNote.textContent = 'No fue posible reproducir este video. Prueba con MP4, WebM o MOV.';
    alert('No fue posible reproducir este video. Prueba con un archivo MP4 o WebM.');
  }
}

function stopCapture(clearSource = true) {
  state.mode = 'idle';
  cancelAnimationFrame(state.animationFrameId);
  state.animationFrameId = null;
  state.lastVideoTime = -1;
  state.processing = false;

  if (state.stream) {
    state.stream.getTracks().forEach((track) => track.stop());
    state.stream = null;
  }
  videoElement.pause();
  if (clearSource) {
    videoElement.srcObject = null;
    videoElement.removeAttribute('src');
    videoElement.load();
    canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);
    canvasElement.width = 640;
    canvasElement.height = 360;
    stageResolution.textContent = '-- × --';
    stageEmpty.hidden = false;
    canvasElement.classList.remove('mirrored');
  }

  setCaptureUI('idle');
  stopClock();
  setTrackingState(false, 'Captura detenida');
  updateSessionClock();
}

function resetMeasurements() {
  state.sampleTimes = [];
  state.angles = [];
  state.minAngle = Infinity;
  state.maxAngle = -Infinity;
  state.smoothedAngle = null;
  state.lastLeg = '--';
  state.autoSide = null;
  state.lastChartUpdate = 0;
  state.startTime = state.mode === 'idle' ? null : Date.now();

  romChart.data.labels = [];
  romChart.data.datasets.forEach((dataset) => { dataset.data = []; });
  romChart.update('none');
  chartEmpty.classList.remove('hidden');

  angleValueElement.textContent = '--';
  statusTextElement.textContent = 'Esperando medición';
  pathologyTextElement.textContent = 'Inicia la captura y coloca la pierna de perfil frente a la cámara.';
  angleCard.classList.remove('warning', 'danger');
  legValueElement.textContent = '--';
  scaleMarker.style.left = '55.5%';
  updateMetrics();
  updateSessionClock();
  if (state.mode !== 'idle') startClock();
}

// Gráfico de ROM: línea de ángulo y referencias clínicas horizontales.
const chartContext = document.getElementById('rom-chart').getContext('2d');
const chartGradient = chartContext.createLinearGradient(0, 0, 0, 250);
chartGradient.addColorStop(0, 'rgba(85, 198, 235, .22)');
chartGradient.addColorStop(1, 'rgba(85, 198, 235, 0)');

const romChart = new Chart(chartContext, {
  type: 'line',
  data: {
    labels: [],
    datasets: [
      {
        label: 'Ángulo medido', data: [], borderColor: '#55c6eb', backgroundColor: chartGradient,
        borderWidth: 2.2, fill: true, tension: 0.28, pointRadius: 0, pointHitRadius: 8,
      },
      {
        label: 'Neutro (0°)', data: [], borderColor: 'rgba(173, 192, 213, .65)',
        borderWidth: 1, borderDash: [5, 5], pointRadius: 0, fill: false,
      },
      {
        label: 'Límite +20°', data: [], borderColor: 'rgba(224, 177, 107, .8)',
        borderWidth: 1, borderDash: [2, 5], pointRadius: 0, fill: false,
      },
      {
        label: 'Límite −25°', data: [], borderColor: 'rgba(224, 177, 107, .8)',
        borderWidth: 1, borderDash: [2, 5], pointRadius: 0, fill: false,
      },
    ],
  },
  options: {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    interaction: { intersect: false, mode: 'index' },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: '#0b1727',
        borderColor: 'rgba(144, 177, 211, .2)',
        borderWidth: 1,
        titleColor: '#dceafa',
        bodyColor: '#9db4ce',
        padding: 10,
        callbacks: {
          label: (context) => `${context.dataset.label}: ${Number(context.parsed.y).toFixed(1)}°`,
        },
      },
    },
    scales: {
      x: {
        grid: { color: 'rgba(145, 169, 197, .07)', drawTicks: false },
        border: { display: false },
        ticks: { color: '#748ba6', maxTicksLimit: 7, maxRotation: 0, font: { family: 'DM Sans', size: 9 } },
      },
      y: {
        min: -45,
        max: 45,
        grid: { color: 'rgba(145, 169, 197, .09)', drawTicks: false },
        border: { display: false },
        ticks: { stepSize: 15, color: '#748ba6', padding: 8, font: { family: 'DM Sans', size: 9 }, callback: (value) => `${value}°` },
      },
    },
  },
});

// Inicializa MediaPipe una sola vez.
const pose = new Pose({
  locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/pose/${file}`,
});
pose.setOptions({
  // El modelo 2 prioriza precisión de landmarks sobre velocidad de procesamiento.
  modelComplexity: 2,
  smoothLandmarks: true,
  enableSegmentation: false,
  minDetectionConfidence: 0.60,
  minTrackingConfidence: 0.60,
});
pose.onResults(onPoseResults);

startCameraButton.addEventListener('click', startCamera);
stopButton.addEventListener('click', () => stopCapture(true));
resetButton.addEventListener('click', resetMeasurements);
uploadInput.addEventListener('change', (event) => {
  const file = event.target.files?.[0];
  loadVideo(file);
  // Permite volver a seleccionar el mismo archivo más adelante.
  uploadInput.value = '';
});
legSelect.addEventListener('change', () => {
  resetMeasurements();
  if (state.mode !== 'idle') {
    captureNote.textContent = `Extremidad seleccionada: ${legSelect.options[legSelect.selectedIndex].text}. Se reinició el registro para no mezclar mediciones de ambas piernas.`;
  }
});

window.addEventListener('beforeunload', () => {
  stopCapture(false);
  resetMeasurements();
  if (state.fileUrl) URL.revokeObjectURL(state.fileUrl);
});

// Estado inicial del panel.
setCaptureUI('idle');
setTrackingState(false, 'Esperando sujeto');
updateMetrics();
