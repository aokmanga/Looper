import WaveSurfer from 'wavesurfer.js';
import { invoke } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';

const wavesurfer = WaveSurfer.create({
  container: '#waveform',
  waveColor: '#3a3a48',
  progressColor: '#007aff',
  height: 'auto',
  normalize: true,
  cursorColor: '#ffffff',
  cursorWidth: 2
});

// --------------------
// STATE
// --------------------
let markers = [];
let loopStart = null;
let loopEnd = null;
let loopActive = false;
let currentAudioPath = null;
let savedMarkersTimes = [];
let currentZoom = 0;
let loopHandler = null;
let loopRegionEl = null;
let waveformScrollEl = null;
let currentAudioUrl = null;

// --------------------
// UI ELEMENTS
// --------------------
const loadBtn = document.getElementById('load');
const playBtn = document.getElementById('play');
const stopBtn = document.getElementById('stop');
const markerBtn = document.getElementById('marker');
const status = document.getElementById('status');
const loopBtn = document.getElementById('loopBtn');
const saveProjectBtn = document.getElementById('saveProject');
const loadProjectBtn = document.getElementById('loadProject');
const timeDisplay = document.getElementById('timeDisplay');
const speedSlider = document.getElementById('speedSlider');
const speedLabel = document.getElementById('speedLabel');

// Zoom
const zoomInBtn = document.getElementById('zoomIn');
const zoomOutBtn = document.getElementById('zoomOut');
const zoomResetBtn = document.getElementById('zoomReset');
const waveformBox = document.getElementById('waveform');

// --------------------
// SPEED CONTROL
// --------------------
speedSlider.addEventListener('input', () => {
  const val = parseFloat(speedSlider.value);
  wavesurfer.setPlaybackRate(val);
  speedLabel.textContent = `${val.toFixed(2)}x`;
});

// --------------------
// TIMELINE / RIGHELLO
// --------------------
function drawTimeline() {
  const canvas = document.getElementById('timeline-canvas');
  if (!canvas) return;
  const duration = wavesurfer.getDuration();
  if (!duration) return;

  const wrapper = wavesurfer.getWrapper();
  const totalWidth = wrapper.scrollWidth || wrapper.clientWidth;
  canvas.width = totalWidth;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  ctx.fillStyle = '#0f0f11';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Pixel per secondo — si aggiorna con lo zoom
  const pxPerSec = totalWidth / duration;

  // Step minimo affinché i tick siano almeno ~50px distanti
  const candidateSteps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
  const step = candidateSteps.find(s => s * pxPerSec >= 50) || 300;

  // Tick major ogni 5 step (o ogni step per intervalli grandi)
  const majorEvery = step >= 60 ? 1 : 5;

  ctx.font = '10px "Courier New", monospace';
  ctx.textAlign = 'center';

  for (let i = 0; ; i++) {
    const t = i * step;
    if (t > duration) break;
    const x = (t / duration) * totalWidth;
    const isMajor = i % majorEvery === 0;

    ctx.strokeStyle = isMajor ? '#525262' : '#2e2e2e';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, isMajor ? 0 : 14);
    ctx.lineTo(x, 28);
    ctx.stroke();

    if (isMajor) {
      const mins = Math.floor(t / 60);
      const secs = Math.floor(t % 60);
      const tenths = Math.round((t % 1) * 10);
      let label;
      if (step < 1) {
        label = `${secs}.${tenths}`;
      } else if (mins > 0) {
        label = `${mins}:${secs < 10 ? '0' : ''}${secs}`;
      } else {
        label = `${secs}s`;
      }
      ctx.fillStyle = '#9a9a9e';
      ctx.fillText(label, x, 22);
    }
  }
}

wavesurfer.on('ready', () => {
  drawTimeline();
  attachWaveformScrollListener();
});
wavesurfer.on('zoom', () => {
  setTimeout(drawTimeline, 50);
  setTimeout(() => {
    markers.forEach(m => positionMarker(m, true));
    updateLoopRegion();
  }, 40);
});

// Sincronizza lo scroll del timeline con la waveform
function syncTimelineScroll() {
  const timelineContainer = document.getElementById('timeline-container');
  // WaveSurfer scorre internamente il suo scroll container, non il wrapper diretto
  const scrollEl = wavesurfer.getWrapper()?.parentElement;
  if (timelineContainer && scrollEl) {
    timelineContainer.scrollLeft = scrollEl.scrollLeft;
  }
}

// Aggancia lo scroll nativo del container interno di WaveSurfer
function attachWaveformScrollListener() {
  const scrollEl = wavesurfer.getWrapper()?.parentElement;
  if (scrollEl && scrollEl !== waveformScrollEl) {
    if (waveformScrollEl) {
      waveformScrollEl.removeEventListener('scroll', syncTimelineScroll);
    }
    scrollEl.addEventListener('scroll', syncTimelineScroll, { passive: true });
    waveformScrollEl = scrollEl;
  }
}

// --------------------
// TIME ENGINE
// --------------------
function updateTimeDisplay() {
  const currentTime = wavesurfer.getCurrentTime() || 0;
  const duration = wavesurfer.getDuration() || 0;

  const currentMins = Math.floor(currentTime / 60);
  const currentSecs = Math.floor(currentTime % 60);
  const totalMins = Math.floor(duration / 60);
  const totalSecs = Math.floor(duration % 60);

  const formatCurrent = `${currentMins < 10 ? '0' : ''}${currentMins}.${currentSecs < 10 ? '0' : ''}${currentSecs}`;
  const formatTotal = `${totalMins < 10 ? '0' : ''}${totalMins}.${totalSecs < 10 ? '0' : ''}${totalSecs}`;

  timeDisplay.textContent = `${formatCurrent} / ${formatTotal}`;
  syncTimelineScroll();
}

wavesurfer.on('audioprocess', updateTimeDisplay);
wavesurfer.on('seek', () => { updateTimeDisplay(); syncTimelineScroll(); });
wavesurfer.on('ready', updateTimeDisplay);

// --------------------
// NATIVE AUDIO LOAD
// --------------------
function toFileUrl(filePath) {
  return loadAudioBlobUrl(filePath);
}

function getMimeType(filePath) {
  const ext = filePath.split('.').pop().toLowerCase();
  const map = {
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    ogg: 'audio/ogg',
    flac: 'audio/flac',
    m4a: 'audio/mp4'
  };
  return map[ext] || 'audio/mpeg';
}

async function loadAudioBlobUrl(filePath) {
  if (currentAudioUrl) {
    URL.revokeObjectURL(currentAudioUrl);
    currentAudioUrl = null;
  }

  const bytes = await invoke('read_binary_file', { path: filePath });
  const blob = new Blob([new Uint8Array(bytes)], { type: getMimeType(filePath) });
  currentAudioUrl = URL.createObjectURL(blob);
  return currentAudioUrl;
}

loadBtn.addEventListener('click', async () => {
  const filePath = await open({
    title: 'Seleziona File Audio',
    multiple: false,
    directory: false,
    filters: [{ name: 'File Audio', extensions: ['mp3', 'wav', 'ogg', 'flac', 'm4a'] }]
  });

  if (filePath) {
    const fileName = filePath.split('\\').pop().split('/').pop();

    try {
      // Usa direttamente il path locale, convertito in URL sicuro per spazi e caratteri speciali.
      const fileUrl = await toFileUrl(filePath);

      markers = [];
      loopStart = null;
      loopEnd = null;
      loopActive = false;
      stopLoopEngine();
      savedMarkersTimes = [];
      currentZoom = 0;
      timeDisplay.textContent = '00.00 / 00.00';
      updateLoopBtn();
      removeLoopRegion();
      clearMarkers();

      currentAudioPath = filePath;
      status.textContent = `Caricamento: ${fileName}...`;

      wavesurfer.load(fileUrl);

      // L'evento 'ready' confermerà il caricamento riuscito
      wavesurfer.once('ready', () => {
        status.textContent = `Caricato: ${fileName}`;
        wavesurfer.zoom(0);
      });

      wavesurfer.once('error', (err) => {
        status.textContent = `Errore: impossibile caricare ${fileName}`;
        console.error('WaveSurfer error:', err);
      });

    } catch (err) {
      status.textContent = `Errore durante il caricamento di ${fileName}`;
      console.error('Load error:', err);
    }
  }
});

wavesurfer.on('ready', () => {
  // Ripristina speed al default al caricamento
  speedSlider.value = 1;
  speedLabel.textContent = '1.00x';
  wavesurfer.setPlaybackRate(1);

  if (savedMarkersTimes.length > 0) {
    clearMarkers();
    savedMarkersTimes.forEach(time => {
      createMarker(time);
    });
    savedMarkersTimes = [];

    // Ripristina loop region se esistente
    if (loopStart !== null && loopEnd !== null) {
      restoreLoopMarkers();
    }

    status.textContent = 'Progetto e marker ripristinati!';
  }
});

// --------------------
// ZOOM SYSTEM
// --------------------
zoomInBtn.addEventListener('click', () => adjustZoom(30));
zoomOutBtn.addEventListener('click', () => adjustZoom(-30));
zoomResetBtn.addEventListener('click', () => {
  currentZoom = 0;
  wavesurfer.zoom(0);
});

function adjustZoom(delta) {
  if (currentZoom === 0 && delta > 0) {
    currentZoom = 40;
  } else {
    currentZoom += delta;
  }
  if (currentZoom < 0) currentZoom = 0;
  if (currentZoom > 1000) currentZoom = 1000;
  wavesurfer.zoom(currentZoom);
}

waveformBox.addEventListener('wheel', (e) => {
  const wrapper = wavesurfer.getWrapper();
  if (!wrapper) return;

  if (e.ctrlKey) {
    e.preventDefault();
    adjustZoom(e.deltaY < 0 ? 20 : -20);
  } else if (currentZoom > 0) {
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      e.preventDefault();
      wrapper.scrollLeft += e.deltaY * 1.2;
      syncTimelineScroll();
    }
  }
}, { passive: false });

// --------------------
// PLAY / STOP / MARKER ACTIONS
// --------------------
playBtn.addEventListener('click', () => wavesurfer.playPause());

stopBtn.addEventListener('click', () => {
  wavesurfer.stop();
  loopActive = false;
  stopLoopEngine();
  updateLoopBtn();
  updateTimeDisplay();
});

markerBtn.addEventListener('click', () => createMarker());

document.addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
  if (k === 'p') wavesurfer.playPause();
  if (k === 'o') {
    wavesurfer.stop();
    loopActive = false;
    stopLoopEngine();
    updateLoopBtn();
    updateTimeDisplay();
  }
  if (k === 'm') createMarker();
  if (k === 'l') toggleLoop();
  if (e.key === '+' || e.key === '=') adjustZoom(20);
  if (e.key === '-') adjustZoom(-20);
});

loopBtn.addEventListener('click', toggleLoop);

// --------------------
// PROJECT MANAGEMENT
// --------------------
saveProjectBtn.addEventListener('click', async () => {
  if (!currentAudioPath) {
    status.textContent = 'Impossibile salvare: nessun file audio inserito nel player.';
    return;
  }

  const projectData = {
    audioPath: currentAudioPath,
    markerTimes: markers.map(m => m.time),
    loopStart,
    loopEnd,
    loopActive
  };

  const filePath = await save({
    title: 'Salva Progetto Audio',
    filters: [{ name: 'File di Progetto (*.json)', extensions: ['json'] }]
  });

  if (filePath) {
    try {
      await invoke('write_text_file', {
        path: filePath,
        contents: JSON.stringify(projectData, null, 2)
      });
      status.textContent = 'Progetto salvato con successo!';
    } catch (err) {
      status.textContent = 'Errore durante il salvataggio.';
    }
  }
});

loadProjectBtn.addEventListener('click', async () => {
  const filePath = await open({
    title: 'Apri Progetto Audio',
    multiple: false,
    directory: false,
    filters: [{ name: 'File di Progetto (*.json)', extensions: ['json'] }]
  });

  if (filePath) {
    try {
      const fileContent = await invoke('read_text_file', { path: filePath });
      const projectData = JSON.parse(fileContent);

      if (projectData.audioPath) {
        savedMarkersTimes = projectData.markerTimes || [];
        loopStart = projectData.loopStart !== undefined ? projectData.loopStart : null;
        loopEnd = projectData.loopEnd !== undefined ? projectData.loopEnd : null;
        loopActive = projectData.loopActive !== undefined ? projectData.loopActive : false;

        const audioExists = await invoke('path_exists', { path: projectData.audioPath });
        if (!audioExists) {
          status.textContent = 'Errore: il file audio del progetto non esiste più.';
          return;
        }

        const fileUrl = await toFileUrl(projectData.audioPath);
        wavesurfer.load(fileUrl);
        currentAudioPath = projectData.audioPath;
        currentZoom = 0;

        const fileName = projectData.audioPath.split('\\').pop().split('/').pop();
        status.textContent = `Caricamento file audio: ${fileName}...`;

        updateLoopBtn();
        if (loopActive) startLoopEngine();
      }
    } catch (err) {
      status.textContent = 'Errore: File di progetto corrotto o audio rimosso.';
    }
  }
});

// --------------------
// MARKER SYSTEM
// --------------------
function createMarker(specificTime) {
  if (!wavesurfer.getDuration()) {
    status.textContent = 'Carica un file audio prima di aggiungere marker.';
    return null;
  }

  const time = specificTime !== undefined ? specificTime : wavesurfer.getCurrentTime();

  const marker = {
    time,
    isLoopPoint: false,
    el: document.createElement('div')
  };

  marker.el.className = 'marker';
  marker.el.style.position = 'absolute';
  marker.el.style.top = '0';
  marker.el.style.bottom = '0';
  marker.el.style.width = '3px';
  marker.el.style.background = '#ff3b30';
  marker.el.style.cursor = 'ew-resize';
  marker.el.style.zIndex = '10';
  marker.el.style.transition = 'background 0.2s';
  marker.el.style.borderRadius = '1px';

  // Etichetta col numero
  const label = document.createElement('span');
  label.style.cssText = `
    position: absolute;
    top: 4px;
    left: 5px;
    font-size: 9px;
    font-family: 'Courier New', monospace;
    color: #fff;
    background: rgba(0,0,0,0.5);
    padding: 1px 3px;
    border-radius: 3px;
    pointer-events: none;
    white-space: nowrap;
  `;
  label.textContent = `M${markers.length + 1}`;
  marker.label = label;
  marker.el.appendChild(label);
  marker.el.title = `Marker ${markers.length + 1} — ${time.toFixed(2)}s\nClicca per impostare come punto loop`;

  let isDragging = false;

  marker.el.addEventListener('mousedown', (e) => {
    e.stopPropagation();
    e.preventDefault();
    isDragging = false;

    const wrapper = wavesurfer.getWrapper();
    const rect = wrapper.getBoundingClientRect();
    const duration = wavesurfer.getDuration();

    function onMouseMove(moveEvent) {
      isDragging = true;
      let x = moveEvent.clientX - rect.left + wrapper.scrollLeft;
      const totalWidth = wrapper.scrollWidth || wrapper.clientWidth;
      if (x < 0) x = 0;
      if (x > totalWidth) x = totalWidth;

      if (duration) {
        marker.time = (x / totalWidth) * duration;
        positionMarker(marker, true);

        // Se il marker è un loop point, aggiorna loopStart/loopEnd in tempo reale
        if (marker.isLoopPoint) {
          const loopMarkers = markers
            .filter(m => m.isLoopPoint)
            .sort((a, b) => a.time - b.time);
          if (loopMarkers.length === 2) {
            loopStart = loopMarkers[0].time;
            loopEnd = loopMarkers[1].time;
          }
        }

        updateLoopRegion();
      }
    }

    function onMouseUp() {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    }

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  });

  marker.el.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!isDragging) {
      setLoopPoint(marker);
    }
  });

  wavesurfer.getWrapper().appendChild(marker.el);
  markers.push(marker);
  positionMarker(marker);
  updateMarkerLabels();
  return marker;
}

function positionMarker(marker, immediateOnly = false) {
  const duration = wavesurfer.getDuration();
  if (!duration) return;

  const update = () => {
    const wrapper = wavesurfer.getWrapper();
    const width = wrapper.scrollWidth || wrapper.clientWidth;
    const percent = marker.time / duration;
    marker.el.style.left = `${percent * width}px`;
  };

  update();
  if (!immediateOnly) {
    setTimeout(update, 50);
    setTimeout(update, 200);
  }
}

function updateMarkerColors() {
  markers.forEach(m => {
    if (m.isLoopPoint) {
      m.el.style.background = '#30d158'; // verde per i loop point
      m.el.style.boxShadow = '0 0 6px rgba(48, 209, 88, 0.5)';
    } else {
      m.el.style.background = '#ff3b30';
      m.el.style.boxShadow = 'none';
    }
  });
}

function updateMarkerLabels() {
  markers
    .slice()
    .sort((a, b) => a.time - b.time)
    .forEach((marker, index) => {
      const label = `M${index + 1}`;
      marker.label.textContent = label;
      marker.el.title = `${label} — ${marker.time.toFixed(2)}s\nClicca per impostare come punto loop`;
    });
}

function findMarkerNear(time, excludedMarker = null, tolerance = 0.05) {
  const closest = markers.reduce((best, marker) => {
    if (marker === excludedMarker) return best;
    const distance = Math.abs(marker.time - time);
    if (!best || distance < best.distance) {
      return { marker, distance };
    }
    return best;
  }, null);

  return closest && closest.distance <= tolerance ? closest.marker : null;
}

function restoreLoopMarkers() {
  markers.forEach(m => { m.isLoopPoint = false; });

  if (loopStart === null || loopEnd === null) {
    updateMarkerColors();
    return;
  }

  const startMarker = findMarkerNear(loopStart) || createMarker(loopStart);
  const endMarker = findMarkerNear(loopEnd, startMarker) || createMarker(loopEnd);

  if (startMarker) startMarker.isLoopPoint = true;
  if (endMarker && endMarker !== startMarker) endMarker.isLoopPoint = true;

  updateMarkerColors();
  updateLoopRegion();
}

// --------------------
// LOOP REGION (zona colorata tra i marker)
// --------------------
function updateLoopRegion() {
  if (loopStart === null || loopEnd === null) {
    removeLoopRegion();
    return;
  }

  const duration = wavesurfer.getDuration();
  if (!duration) return;

  const wrapper = wavesurfer.getWrapper();
  const totalWidth = wrapper.scrollWidth || wrapper.clientWidth;

  const startX = (loopStart / duration) * totalWidth;
  const endX = (loopEnd / duration) * totalWidth;

  if (!loopRegionEl) {
    loopRegionEl = document.createElement('div');
    loopRegionEl.className = 'loop-region';
    loopRegionEl.style.cssText = `
      position: absolute;
      top: 0;
      bottom: 0;
      background: rgba(48, 209, 88, 0.08);
      border-top: 2px solid rgba(48, 209, 88, 0.3);
      border-bottom: 2px solid rgba(48, 209, 88, 0.3);
      pointer-events: none;
      z-index: 5;
      transition: opacity 0.2s;
    `;
    wrapper.appendChild(loopRegionEl);
  }

  loopRegionEl.style.left = `${startX}px`;
  loopRegionEl.style.width = `${endX - startX}px`;
  loopRegionEl.style.opacity = loopActive ? '1' : '0.5';
}

function removeLoopRegion() {
  if (loopRegionEl) {
    loopRegionEl.remove();
    loopRegionEl = null;
  }
}

// --------------------
// LOOP LOGIC
// --------------------
function setLoopPoint(marker) {
  const time = marker.time;

  // Reset se si clicca un marker già loop point
  if (marker.isLoopPoint) {
    // Deseleziona tutto e ricomincia
    markers.forEach(m => { m.isLoopPoint = false; });
    loopStart = null;
    loopEnd = null;
    removeLoopRegion();
    updateMarkerColors();
    status.textContent = 'Punti loop resettati. Clicca un marker per impostare il punto A.';
    return;
  }

  if (loopStart === null) {
    loopStart = time;
    marker.isLoopPoint = true;
    updateMarkerColors();
    status.textContent = `Punto A: ${time.toFixed(2)}s — Clicca un altro marker per il punto B.`;
    return;
  }

  // Secondo punto
  const startMarker = findMarkerNear(loopStart, marker, Number.POSITIVE_INFINITY);
  markers.forEach(m => { m.isLoopPoint = false; });
  if (startMarker) startMarker.isLoopPoint = true;
  marker.isLoopPoint = true;
  loopEnd = time;

  if (loopEnd < loopStart) {
    [loopStart, loopEnd] = [loopEnd, loopStart];
  }

  updateMarkerColors();
  updateLoopRegion();
  status.textContent = `Loop A→B: ${loopStart.toFixed(2)}s — ${loopEnd.toFixed(2)}s · Premi L per attivare`;

  if (loopActive) startLoopEngine();
}

function toggleLoop() {
  if (loopStart === null || loopEnd === null) {
    status.textContent = 'Clicca due marker per definire i punti A e B del loop.';
    return;
  }

  loopActive = !loopActive;
  status.textContent = loopActive
    ? `Loop ATTIVO · ${loopStart.toFixed(2)}s → ${loopEnd.toFixed(2)}s`
    : 'Loop disattivato';

  updateLoopBtn();
  updateLoopRegion();

  if (loopActive) {
    startLoopEngine();
  } else {
    stopLoopEngine();
  }
}

function updateLoopBtn() {
  if (loopActive) {
    loopBtn.classList.add('active');
  } else {
    loopBtn.classList.remove('active');
  }
}

function startLoopEngine() {
  stopLoopEngine();

  loopHandler = () => {
    if (!loopActive) {
      stopLoopEngine();
      return;
    }
    const t = wavesurfer.getCurrentTime();
    if (t >= loopEnd || t < loopStart) {
      wavesurfer.setTime(loopStart);
    }
  };

  wavesurfer.on('audioprocess', loopHandler);
}

function stopLoopEngine() {
  if (loopHandler) {
    wavesurfer.un('audioprocess', loopHandler);
    loopHandler = null;
  }
}

function clearMarkers() {
  document.querySelectorAll('.marker').forEach(m => m.remove());
  markers = [];
  removeLoopRegion();
}
