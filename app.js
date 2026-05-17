const FPS = 30;
const PATH_FADE_FRAMES = 270;
const MIN_PATH_DURATION = 30;
const MAX_PATH_DURATION = 1800;
const DOT_RADIUS = 9;
const BAR_WIDTH = 34;
const BAR_HEIGHT = 4;
const SPEED_MIN = 1;
const SPEED_MAX = 50;
const COORDINATE_DATA_URL = 'fahero_unit_coordinates.json';
const COMBAT_RADIUS = 38;
const MOVE_PIXELS_PER_SPEED_POINT = 36;
const INACTIVE_GRACE_FRAMES = FPS * 8;
const PROJECTION_RADIUS = 140;
const PROJECTION_GRID_SIZE = 26;
const CITY_DETECTION_MIN_PIXELS = 12;
const CITY_DETECTION_MAX_PIXELS = 260;

const unitStats = {
  infantry: { healthMax: 100, damage: 0.08, speed: 0.5 },
  tanks: { healthMax: 200, damage: 0.16, speed: 0.3 }
};

const palette = [
  '#3500ff',
  '#ff0000',
  '#9c00ba',
  '#ff8c38'
];

const elements = {
  viewerArea: document.querySelector('.viewer-area'),
  canvas: document.getElementById('replayCanvas'),
  fileInput: document.getElementById('fileInput'),
  fitButton: document.getElementById('fitButton'),
  resetButton: document.getElementById('resetButton'),
  playButton: document.getElementById('playButton'),
  playIcon: document.getElementById('playIcon'),
  timeline: document.getElementById('timeline'),
  speedRange: document.getElementById('speedRange'),
  speedValue: document.getElementById('speedValue'),
  currentTime: document.getElementById('currentTime'),
  durationTime: document.getElementById('durationTime'),
  replayTitle: document.getElementById('replayTitle'),
  replaySubtitle: document.getElementById('replaySubtitle'),
  mapValue: document.getElementById('mapValue'),
  versionValue: document.getElementById('versionValue'),
  eventsValue: document.getElementById('eventsValue'),
  resultValue: document.getElementById('resultValue'),
  playersList: document.getElementById('playersList'),
  messageList: document.getElementById('messageList'),
  trailsToggle: document.getElementById('trailsToggle'),
  dotsToggle: document.getElementById('dotsToggle'),
  zonesToggle: document.getElementById('zonesToggle'),
  messagesToggle: document.getElementById('messagesToggle'),
  dropOverlay: document.getElementById('dropOverlay'),
  toast: document.getElementById('toast')
};

const ctx = elements.canvas.getContext('2d');

const state = {
  replay: null,
  frame: 0,
  playing: false,
  speed: 1,
  lastTimestamp: 0,
  view: { scale: 1, offsetX: 0, offsetY: 0 },
  dragging: false,
  dragStart: null,
  toastTimer: 0,
  wasPlayingBeforeScrub: false,
  scrubbing: false,
  dragDepth: 0
};

const mapImageCache = new Map();
const cityDetectionCache = new Map();
const assetImageCache = new Map();
const loadedAssetImages = new Map();
let coordinateDataPromise = null;

const assetPaths = {
  infantry: [
    'game_assets/blue_inf1.png',
    'game_assets/red_inf1.png',
    'game_assets/purple_inf1.png',
    'game_assets/orange_inf1.png'
  ],
  tanks: [
    'game_assets/blue_tank1.png',
    'game_assets/red_tank1.png',
    'game_assets/purple_tank1.png',
    'game_assets/orange_tank1.png'
  ],
  flags: [
    'game_assets/blue_flag.png',
    'game_assets/red_flag.png',
    'game_assets/purple_flag.png',
    'game_assets/orange_flag.png'
  ],
  city: 'game_assets/city_icon.png',
  capital: 'game_assets/capital.png'
};

function isPoint(value) {
  return Array.isArray(value) && value.length >= 2 && Number.isFinite(Number(value[0])) && Number.isFinite(Number(value[1]));
}

function isPath(value) {
  return Array.isArray(value) && value.length > 0 && value.every(isPoint);
}

function flattenName(value) {
  if (Array.isArray(value)) {
    return value.flat(Infinity).join(' / ');
  }
  return String(value ?? 'Unknown');
}

function getPlayerColor(owner, fallback = '#c4ccd2') {
  if (!Number.isFinite(owner)) return fallback;
  return palette[((owner % palette.length) + palette.length) % palette.length] ?? fallback;
}

async function decodeReplayBuffer(buffer, filename) {
  await loadStaticAssets();
  const bytes = new Uint8Array(buffer);
  let text;

  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    if (!('DecompressionStream' in window)) {
      throw new Error('This browser cannot decompress gzip files. Use a Chromium-based browser or provide an uncompressed replay JSON.');
    }
    const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip'));
    text = await new Response(stream).text();
  } else {
    text = new TextDecoder('utf-8').decode(buffer);
  }

  const raw = JSON.parse(text);
  const coordinateData = await loadCoordinateData();
  const replay = normalizeReplay(raw, filename, coordinateData);
  await attachMapImage(replay);
  return replay;
}

async function loadCoordinateData() {
  if (!coordinateDataPromise) {
    coordinateDataPromise = fetch(COORDINATE_DATA_URL)
      .then((response) => {
        if (!response.ok) throw new Error(`Could not load ${COORDINATE_DATA_URL}`);
        return response.json();
      })
      .catch((error) => {
        console.warn(error.message);
        return null;
      });
  }

  return coordinateDataPromise;
}

function loadImage(src) {
  if (mapImageCache.has(src)) return mapImageCache.get(src);

  const promise = new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Could not load ${src}`));
    image.src = src;
  });

  mapImageCache.set(src, promise);
  return promise;
}

function loadAssetImage(src) {
  if (assetImageCache.has(src)) return assetImageCache.get(src);

  const promise = new Promise((resolve) => {
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => {
      loadedAssetImages.set(src, image);
      resolve(image);
    };
    image.onerror = () => resolve(null);
    image.src = src;
  });

  assetImageCache.set(src, promise);
  return promise;
}

async function loadStaticAssets() {
  const sources = [
    ...assetPaths.infantry,
    ...assetPaths.tanks,
    ...assetPaths.flags,
    assetPaths.city,
    assetPaths.capital
  ];
  await Promise.all(sources.map(loadAssetImage));
}

async function attachMapImage(replay) {
  if (replay.customMap) return;

  const mapId = String(replay.map ?? '').trim();
  if (!mapId || mapId === '-') return;

  const src = `maps/map${mapId}.png`;
  replay.mapSrc = src;

  try {
    const image = await loadImage(src);
    replay.mapImage = image;
    replay.bounds = { minX: 0, minY: 0, maxX: image.naturalWidth, maxY: image.naturalHeight };
    if (replay.cities.length === 0) replay.cities = await detectCities(image, src);
  } catch (error) {
    replay.mapError = error.message;
    if (replay.cities.length === 0) replay.cities = [];
  }
}

async function detectCities(image, cacheKey) {
  if (cityDetectionCache.has(cacheKey)) return cityDetectionCache.get(cacheKey);

  const promise = new Promise((resolve) => {
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(image, 0, 0);
    const { data, width, height } = context.getImageData(0, 0, canvas.width, canvas.height);
    const visited = new Uint8Array(width * height);
    const cities = [];

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const startIndex = y * width + x;
        if (visited[startIndex] || !isCityPixel(data, startIndex * 4)) continue;

        const queue = [startIndex];
        visited[startIndex] = 1;
        let pixelCount = 0;
        let sumX = 0;
        let sumY = 0;
        let minX = x;
        let minY = y;
        let maxX = x;
        let maxY = y;

        while (queue.length > 0) {
          const current = queue.pop();
          const cx = current % width;
          const cy = Math.floor(current / width);
          pixelCount += 1;
          sumX += cx;
          sumY += cy;
          minX = Math.min(minX, cx);
          minY = Math.min(minY, cy);
          maxX = Math.max(maxX, cx);
          maxY = Math.max(maxY, cy);

          const neighbors = [current - 1, current + 1, current - width, current + width];
          for (const neighbor of neighbors) {
            if (neighbor < 0 || neighbor >= visited.length || visited[neighbor]) continue;
            const nx = neighbor % width;
            const ny = Math.floor(neighbor / width);
            if (Math.abs(nx - cx) + Math.abs(ny - cy) !== 1) continue;
            if (!isCityPixel(data, neighbor * 4)) continue;
            visited[neighbor] = 1;
            queue.push(neighbor);
          }
        }

        if (pixelCount < CITY_DETECTION_MIN_PIXELS || pixelCount > CITY_DETECTION_MAX_PIXELS) continue;
        const centerX = sumX / pixelCount;
        const centerY = sumY / pixelCount;
        const radius = Math.max(maxX - minX, maxY - minY) / 2;
        cities.push({ id: `city-${cities.length}`, x: centerX, y: centerY, radius });
      }
    }

    resolve(cities);
  });

  cityDetectionCache.set(cacheKey, promise);
  return promise;
}

function isCityPixel(data, offset) {
  const r = data[offset];
  const g = data[offset + 1];
  const b = data[offset + 2];
  const a = data[offset + 3];
  return a > 100 && r > 165 && g > 130 && b < 120 && r >= g && (r - b) > 70;
}

function normalizeReplay(raw, filename, coordinateData = null) {
  const frameKeys = Object.keys(raw)
    .filter((key) => /^\d+$/.test(key))
    .map(Number)
    .sort((a, b) => a - b);
  const replayStart = frameKeys[0] ?? 0;

  const players = (raw.player_usernames || []).map((name, index) => ({
    id: index,
    key: `production${index}`,
    name: flattenName(name),
    color: getPlayerColor(index),
    rate: null,
    ratio: null,
    zones: new Set()
  }));

  const events = [];
  const paths = [];
  const messages = [];
  const productionEvents = [];
  const dotSeeds = new Map();
  const initialUnits = buildInitialUnits(raw, coordinateData);
  const initialCities = buildInitialCities(raw, coordinateData, initialUnits);
  const knownOwners = new Map();
  const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };

  for (const unit of initialUnits) {
    dotSeeds.set(unit.id, unit);
    extendBounds(bounds, unit.x, unit.y);
  }
  for (const city of initialCities) {
    extendBounds(bounds, city.x, city.y);
  }

  for (const frame of frameKeys) {
    const frameEvents = raw[String(frame)] || {};

    for (const [key, value] of Object.entries(frameEvents)) {
      if (isPath(value)) {
        const points = value.map((point) => ({ x: Number(point[0]), y: Number(point[1]) }));
        const dotId = String(key);
        if (!dotSeeds.has(dotId)) {
          dotSeeds.set(dotId, createSpawnedUnit(dotId, points[0], frame, dotSeeds, players.length));
        }
        const seed = dotSeeds.get(dotId);
        const length = pathLength(points);
        const duration = getMovementDuration(length, seed.type);
        const path = { type: 'path', frame, dotId, unitType: seed.type, points, length, duration, ownerId: seed.owner ?? knownOwners.get(dotId) ?? null };
        paths.push(path);
        events.push(path);
        for (const point of points) extendBounds(bounds, point.x, point.y);
      } else if (/^production\d+$/.test(key) && value && typeof value === 'object') {
        const playerId = Number(key.replace('production', ''));
        const event = {
          type: Array.isArray(value.zone) ? 'zone' : 'production',
          frame,
          playerId,
          colorId: Number(value.color ?? playerId),
          rate: Number.isFinite(Number(value.rate)) ? Number(value.rate) : null,
          ratio: Number.isFinite(Number(value.ratio)) ? Number(value.ratio) : null,
          zone: Array.isArray(value.zone) ? value.zone.map(String) : null
        };
        productionEvents.push(event);
        events.push(event);
        if (event.type === 'zone' && event.zone) {
          for (const [dotId, ownerId] of knownOwners.entries()) {
            if (ownerId === event.playerId) knownOwners.delete(dotId);
          }
          for (const dotId of event.zone) knownOwners.set(dotId, event.playerId);
        }
      } else if (/^message\d+$/.test(key) && typeof value === 'string' && value.trim()) {
        const playerId = Number(key.replace('message', ''));
        const message = { type: 'message', frame, playerId, text: value.trim() };
        messages.push(message);
        events.push(message);
      } else if (Array.isArray(value) && value.length === 0) {
        events.push({ type: 'empty', frame, dotId: String(key) });
      }
    }
  }

  setPathDurations(paths);
  const pathInfo = buildPathInfo(paths);
  const fallbackOwners = inferFallbackOwners(dotSeeds, productionEvents, players.length);
  const hasInitialCoordinates = initialUnits.length > 0;

  for (const dot of dotSeeds.values()) {
    if (dot.owner == null) dot.owner = fallbackOwners.get(dot.id) ?? null;
    if (!hasInitialCoordinates) dot.spawnFrame = replayStart;
  }

  const dots = Array.from(dotSeeds.values()).sort((a, b) => Number(a.id) - Number(b.id));
  for (const path of paths) {
    const dot = dotSeeds.get(path.dotId);
    if (path.ownerId == null) path.ownerId = dot?.owner ?? null;
  }

  for (const dot of dots) extendBounds(bounds, dot.x, dot.y);
  if (!Number.isFinite(bounds.minX)) {
    bounds.minX = 0;
    bounds.minY = 0;
    bounds.maxX = 1400;
    bounds.maxY = 900;
  }

  events.sort((a, b) => a.frame - b.frame);

  return {
    filename,
    raw,
    map: raw.map ?? '-',
    customMap: raw.custom_map ?? null,
    version: raw.version ?? '-',
    result: raw.result ?? '-',
    end: Number(raw.end ?? frameKeys.at(-1) ?? 0),
    start: replayStart,
    frameKeys,
    players,
    events,
    paths,
    pathInfo,
    productionEvents,
    messages,
    dots,
    initialUnits,
    coordinateFallback: !hasInitialCoordinates,
    cities: initialCities,
    bounds: padBounds(bounds, 120),
    mapSrc: null,
    mapImage: null,
    mapError: null
  };
}

function setPathDurations(paths) {
  const byDot = new Map();
  for (const path of paths) {
    if (!byDot.has(path.dotId)) byDot.set(path.dotId, []);
    byDot.get(path.dotId).push(path);
  }

  for (const dotPaths of byDot.values()) {
    dotPaths.sort((a, b) => a.frame - b.frame);
    for (let index = 0; index < dotPaths.length; index++) {
      const path = dotPaths[index];
      path.duration = getMovementDuration(path.length, path.unitType);
    }
  }
}

function getMovementDuration(length, unitType) {
  const stats = unitStats[unitType] || unitStats.infantry;
  const pixelsPerSecond = stats.speed * MOVE_PIXELS_PER_SPEED_POINT;
  return clamp(Math.round((length / pixelsPerSecond) * FPS), MIN_PATH_DURATION, MAX_PATH_DURATION);
}

function buildPathInfo(paths) {
  const info = new Map();
  for (const path of paths) {
    const existing = info.get(path.dotId) || { firstFrame: path.frame, lastFrame: path.frame, lastEnd: path.frame + path.duration, count: 0 };
    existing.firstFrame = Math.min(existing.firstFrame, path.frame);
    existing.lastFrame = Math.max(existing.lastFrame, path.frame);
    existing.lastEnd = Math.max(existing.lastEnd, path.frame + path.duration);
    existing.count += 1;
    info.set(path.dotId, existing);
  }
  return info;
}

function inferFallbackOwners(dotSeeds, productionEvents, playerCount) {
  const dots = Array.from(dotSeeds.values());
  const inferredOwners = new Map();
  if (dots.length === 0 || playerCount <= 0) return inferredOwners;

  const explicitOwners = new Map();
  for (const event of productionEvents) {
    if (event.type !== 'zone' || !event.zone) continue;
    for (const dotId of event.zone) {
      if (!explicitOwners.has(dotId)) explicitOwners.set(dotId, event.playerId);
    }
  }

  if (dots.length <= playerCount) {
    for (const dot of dots) inferredOwners.set(dot.id, dot.owner ?? explicitOwners.get(dot.id) ?? 0);
    return inferredOwners;
  }

  const clusters = clusterDots(dots, Math.min(playerCount, dots.length));
  const votes = new Map();
  for (const dot of dots) {
    const explicitOwner = dot.owner ?? explicitOwners.get(dot.id);
    if (explicitOwner == null) continue;
    const clusterIndex = clusters.assignments.get(dot.id);
    if (!votes.has(clusterIndex)) votes.set(clusterIndex, new Map());
    const clusterVotes = votes.get(clusterIndex);
    clusterVotes.set(explicitOwner, (clusterVotes.get(explicitOwner) || 0) + 1);
  }

  const clusterToPlayer = assignClustersToPlayers(clusters.centers, votes, playerCount);
  for (const dot of dots) {
    inferredOwners.set(dot.id, dot.owner ?? explicitOwners.get(dot.id) ?? clusterToPlayer.get(clusters.assignments.get(dot.id)) ?? 0);
  }

  return inferredOwners;
}

function clusterDots(dots, clusterCount) {
  const points = dots.map((dot) => ({ id: dot.id, x: dot.x, y: dot.y }));
  const centers = [];

  centers.push({ x: points[0].x, y: points[0].y });
  while (centers.length < clusterCount) {
    let bestPoint = points[0];
    let bestDistance = -1;
    for (const point of points) {
      const nearest = Math.min(...centers.map((center) => distance(point, center)));
      if (nearest > bestDistance) {
        bestDistance = nearest;
        bestPoint = point;
      }
    }
    centers.push({ x: bestPoint.x, y: bestPoint.y });
  }

  const assignments = new Map();
  for (let iteration = 0; iteration < 8; iteration++) {
    for (const point of points) {
      let bestIndex = 0;
      let bestDistance = Infinity;
      for (let index = 0; index < centers.length; index++) {
        const value = distance(point, centers[index]);
        if (value < bestDistance) {
          bestDistance = value;
          bestIndex = index;
        }
      }
      assignments.set(point.id, bestIndex);
    }

    const sums = Array.from({ length: centers.length }, () => ({ x: 0, y: 0, count: 0 }));
    for (const point of points) {
      const index = assignments.get(point.id);
      sums[index].x += point.x;
      sums[index].y += point.y;
      sums[index].count += 1;
    }

    for (let index = 0; index < centers.length; index++) {
      if (sums[index].count === 0) continue;
      centers[index] = {
        x: sums[index].x / sums[index].count,
        y: sums[index].y / sums[index].count
      };
    }
  }

  return { centers, assignments };
}

function assignClustersToPlayers(centers, votes, playerCount) {
  const mapping = new Map();
  const usedPlayers = new Set();
  const usedClusters = new Set();
  const rankedVotes = [];

  for (const [clusterIndex, clusterVotes] of votes.entries()) {
    for (const [playerId, count] of clusterVotes.entries()) {
      rankedVotes.push({ clusterIndex, playerId, count });
    }
  }

  rankedVotes.sort((a, b) => b.count - a.count);
  for (const vote of rankedVotes) {
    if (usedClusters.has(vote.clusterIndex) || usedPlayers.has(vote.playerId)) continue;
    mapping.set(vote.clusterIndex, vote.playerId);
    usedClusters.add(vote.clusterIndex);
    usedPlayers.add(vote.playerId);
  }

  const centerX = centers.reduce((sum, center) => sum + center.x, 0) / centers.length;
  const centerY = centers.reduce((sum, center) => sum + center.y, 0) / centers.length;
  const remainingPlayers = [];
  for (let playerId = 0; playerId < playerCount; playerId++) {
    if (!usedPlayers.has(playerId)) remainingPlayers.push(playerId);
  }

  const remainingClusters = centers
    .map((center, index) => ({ index, angle: Math.atan2(center.y - centerY, center.x - centerX) }))
    .filter((entry) => !usedClusters.has(entry.index))
    .sort((a, b) => a.angle - b.angle);

  remainingClusters.forEach((entry, index) => {
    mapping.set(entry.index, remainingPlayers[index] ?? 0);
  });

  return mapping;
}

function buildInitialUnits(raw, coordinateData) {
  const mapKey = `map${String(raw.map ?? '').trim()}.png`;
  const mapConfig = coordinateData?.maps?.[mapKey];
  if (!mapConfig?.players) return [];

  const units = [];
  const playerEntries = Object.entries(mapConfig.players)
    .sort((a, b) => playerKeyToId(a[0]) - playerKeyToId(b[0]));

  for (const [playerKey, groups] of playerEntries) {
    const owner = playerKeyToId(playerKey);
    for (const unitType of ['infantry', 'tanks']) {
      for (const point of groups[unitType] || []) {
        if (!isPoint(point)) continue;
        units.push(createUnitSeed(String(units.length), Number(point[0]), Number(point[1]), owner, unitType, 0, false));
      }
    }
  }

  return units;
}

function buildInitialCities(raw, coordinateData, initialUnits) {
  const mapKey = `map${String(raw.map ?? '').trim()}.png`;
  const mapConfig = coordinateData?.maps?.[mapKey];
  if (!mapConfig) return [];

  const cityPoints = Array.isArray(mapConfig.cities) ? mapConfig.cities : [];
  const capitalPoints = Array.isArray(mapConfig.capitals) ? mapConfig.capitals : [];
  const capitalIndices = new Set(Array.isArray(mapConfig.capital_indices) ? mapConfig.capital_indices.map(Number) : []);
  const cities = [];

  for (let index = 0; index < cityPoints.length; index++) {
    const point = cityPoints[index];
    if (!isPoint(point)) continue;
    cities.push(createCitySeed(`city-${index}`, Number(point[0]), Number(point[1]), capitalIndices.has(index), initialUnits));
  }

  for (let index = 0; index < capitalPoints.length; index++) {
    const point = capitalPoints[index];
    if (!isPoint(point)) continue;
    const id = `capital-${index}`;
    if (cities.some((city) => city.id === id || (city.x === Number(point[0]) && city.y === Number(point[1])))) continue;
    cities.push(createCitySeed(id, Number(point[0]), Number(point[1]), true, initialUnits));
  }

  return cities;
}

function createCitySeed(id, x, y, capital, initialUnits) {
  return {
    id,
    x,
    y,
    radius: capital ? 13 : 10,
    capital,
    owner: guessInitialCityOwner({ x, y }, initialUnits),
    influence: 0
  };
}

function guessInitialCityOwner(point, initialUnits) {
  let bestOwner = null;
  let bestDistance = Infinity;

  for (const unit of initialUnits) {
    if (unit.owner == null) continue;
    const value = distance(point, unit);
    if (value < bestDistance) {
      bestDistance = value;
      bestOwner = unit.owner;
    }
  }

  return bestOwner;
}

function createSpawnedUnit(id, point, frame, dotSeeds, playerCount) {
  const owner = guessSpawnOwner(point, dotSeeds, playerCount);
  return createUnitSeed(id, point.x, point.y, owner, 'infantry', frame, true);
}

function createUnitSeed(id, x, y, owner, type, spawnFrame, produced) {
  const unitType = type === 'tanks' ? 'tanks' : 'infantry';
  const stats = unitStats[unitType];
  return {
    id,
    x,
    y,
    owner: Number.isFinite(owner) ? owner : null,
    type: unitType,
    spawnFrame,
    produced,
    healthMax: stats.healthMax
  };
}

function playerKeyToId(key) {
  const value = Number(String(key).replace(/^P/i, ''));
  return Number.isFinite(value) ? value : 0;
}

function guessSpawnOwner(point, dotSeeds, playerCount) {
  if (dotSeeds.size === 0 || playerCount <= 0) return null;

  let bestOwner = null;
  let bestDistance = Infinity;
  for (const dot of dotSeeds.values()) {
    if (dot.owner == null || dot.spawnFrame > 0) continue;
    const value = distance(point, dot);
    if (value < bestDistance) {
      bestDistance = value;
      bestOwner = dot.owner;
    }
  }

  return bestOwner;
}

function extendBounds(bounds, x, y) {
  bounds.minX = Math.min(bounds.minX, x);
  bounds.minY = Math.min(bounds.minY, y);
  bounds.maxX = Math.max(bounds.maxX, x);
  bounds.maxY = Math.max(bounds.maxY, y);
}

function padBounds(bounds, padding) {
  return {
    minX: bounds.minX - padding,
    minY: bounds.minY - padding,
    maxX: bounds.maxX + padding,
    maxY: bounds.maxY + padding
  };
}

function pathLength(points) {
  let length = 0;
  for (let index = 1; index < points.length; index++) {
    length += distance(points[index - 1], points[index]);
  }
  return length;
}

function distance(a, b) {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function speedFromSlider(value) {
  const amount = clamp(Number(value), 0, 1);
  return SPEED_MIN * Math.pow(SPEED_MAX / SPEED_MIN, amount);
}

function updateSpeedLabel() {
  elements.speedValue.textContent = `${state.speed < 10 ? state.speed.toFixed(1) : Math.round(state.speed)}x`;
}

function setReplay(replay) {
  state.replay = replay;
  state.frame = replay.start;
  state.playing = false;
  state.lastTimestamp = 0;

  elements.playButton.disabled = false;
  elements.timeline.disabled = false;
  elements.timeline.min = String(replay.start);
  elements.timeline.max = String(replay.end);
  elements.timeline.value = String(state.frame);
  elements.durationTime.textContent = formatTime(replay.end);
  elements.playIcon.textContent = 'Play';
  updateSpeedLabel();

  updateMetadata();
  fitToReplay();
  render();
  showToast(`Loaded ${replay.filename}`);
}

function updateMetadata() {
  const replay = state.replay;
  elements.replayTitle.textContent = replay.filename;
  elements.replaySubtitle.textContent = `${replay.players.length} players, ${replay.frameKeys.length} timeline frames${replay.mapImage ? ', map image loaded' : ''}`;
  elements.mapValue.textContent = String(replay.map);
  elements.versionValue.textContent = String(replay.version);
  elements.eventsValue.textContent = String(replay.events.length);
  elements.resultValue.textContent = String(replay.result);
  renderPlayers();
  renderMessagesList();
  updateTransport();
}

function renderPlayers() {
  const replay = state.replay;
  if (!replay || replay.players.length === 0) {
    elements.playersList.innerHTML = '<div class="empty-state">No player metadata found.</div>';
    return;
  }

  elements.playersList.innerHTML = replay.players.map((player) => `
    <div class="player-row" data-player="${player.id}">
      <div class="player-top">
        <span class="swatch" style="background:${getPlayerColor(player.id)}"></span>
        <span class="player-name" title="${escapeHtml(player.name)}">${escapeHtml(player.name)}</span>
      </div>
      <div class="player-stats" id="playerStats${player.id}">rate -, ratio -</div>
    </div>
  `).join('');
}

function renderMessagesList() {
  const replay = state.replay;
  if (!replay || replay.messages.length === 0) {
    elements.messageList.innerHTML = '<div class="empty-state">No chat messages in this replay.</div>';
    return;
  }

  elements.messageList.innerHTML = replay.messages.map((message) => {
    const player = replay.players[message.playerId];
    const name = player ? player.name : `Player ${message.playerId}`;
    return `
      <div class="message-row">
        <span class="message-time">${formatTime(message.frame)} - ${escapeHtml(name)}</span>
        <p>${escapeHtml(message.text)}</p>
      </div>
    `;
  }).join('');
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function updateTransport() {
  const replay = state.replay;
  if (!replay) return;
  elements.currentTime.textContent = formatTime(state.frame);
  elements.durationTime.textContent = formatTime(replay.end);
  elements.timeline.value = String(Math.round(state.frame));
}

function formatTime(frame) {
  const totalSeconds = Math.max(0, Math.floor(Number(frame) / FPS));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function fitToReplay() {
  const replay = state.replay;
  if (!replay) return;
  resizeCanvas();
  const bounds = replay.bounds;
  const width = bounds.maxX - bounds.minX;
  const height = bounds.maxY - bounds.minY;
  const scale = Math.min(elements.canvas.width / width, elements.canvas.height / height) * 0.96;
  state.view.scale = scale;
  state.view.offsetX = (elements.canvas.width - width * scale) / 2 - bounds.minX * scale;
  state.view.offsetY = (elements.canvas.height - height * scale) / 2 - bounds.minY * scale;
}

function resizeCanvas() {
  const rect = elements.canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(rect.width * ratio));
  const height = Math.max(1, Math.round(rect.height * ratio));
  if (elements.canvas.width !== width || elements.canvas.height !== height) {
    elements.canvas.width = width;
    elements.canvas.height = height;
  }
}

function worldToScreen(point) {
  return {
    x: point.x * state.view.scale + state.view.offsetX,
    y: point.y * state.view.scale + state.view.offsetY
  };
}

function screenToWorld(x, y) {
  return {
    x: (x - state.view.offsetX) / state.view.scale,
    y: (y - state.view.offsetY) / state.view.scale
  };
}

function getReplaySnapshot(frame) {
  const replay = state.replay;
  const ownership = new Map();
  const production = new Map();
  const activeMessages = [];
  const dots = new Map(replay.dots
    .filter((dot) => dot.spawnFrame <= frame)
    .map((dot) => [dot.id, {
    id: dot.id,
    x: dot.x,
    y: dot.y,
    owner: dot.owner ?? null,
    type: dot.type,
    healthMax: dot.healthMax,
    moving: false,
    moveAge: 0,
    moveProgress: 1,
    lastMoveEnd: replay.start
  }]));

  for (const event of replay.events) {
    if (event.frame > frame) break;
    if (event.type === 'path') {
      const existing = dots.get(event.dotId) || {
        id: event.dotId,
        x: event.points[0].x,
        y: event.points[0].y,
        owner: event.ownerId ?? null,
        type: 'infantry',
        healthMax: unitStats.infantry.healthMax,
        moving: false,
        moveAge: 0,
        moveProgress: 1,
        lastMoveEnd: replay.start
      };
      const age = frame - event.frame;
      const progress = clamp(age / event.duration, 0, 1);
      const position = getPointAlongPath(event.points, progress);
      dots.set(event.dotId, {
        ...existing,
        x: position.x,
        y: position.y,
        owner: event.ownerId ?? existing.owner ?? null,
        moving: progress < 1,
        moveAge: Math.max(0, Math.min(age, event.duration)),
        moveProgress: progress,
        lastMoveEnd: event.frame + event.duration
      });
    } else if (event.type === 'zone' && event.zone) {
      for (const [dotId, ownerId] of ownership.entries()) {
        if (ownerId === event.playerId) ownership.delete(dotId);
      }
      for (const dotId of event.zone) ownership.set(dotId, event.playerId);
    } else if (event.type === 'production') {
      production.set(event.playerId, { rate: event.rate, ratio: event.ratio });
    } else if (event.type === 'message' && frame - event.frame < FPS * 12) {
      activeMessages.push(event);
    }
  }

  const visibleDots = Array.from(dots.values());
  applyGuideSimulation(visibleDots, frame);
  applyInactiveUnits(visibleDots, replay, frame);
  for (const dot of visibleDots) ownership.set(dot.id, dot.owner);

  const cities = getCitySnapshot(replay, visibleDots);

  return { ownership, production, activeMessages, dots: visibleDots, cities };
}

function getCitySnapshot(replay, dots) {
  const cities = replay.cities || [];
  return cities.map((city) => {
    const influence = new Map();
    for (const dot of dots) {
      if (dot.owner == null || dot.inactive) continue;
      const range = PROJECTION_RADIUS + city.radius;
      const separation = distance(city, dot);
      if (separation > range) continue;
      const weight = (1 - separation / range) * (dot.type === 'tanks' ? 1.25 : 1);
      influence.set(dot.owner, (influence.get(dot.owner) || 0) + weight);
    }

    let owner = city.owner ?? null;
    let bestWeight = 0;
    for (const [playerId, weight] of influence.entries()) {
      if (weight > bestWeight) {
        bestWeight = weight;
        owner = playerId;
      }
    }

    return {
      ...city,
      owner,
      influence: bestWeight
    };
  });
}

function applyInactiveUnits(dots, replay, frame) {
  for (const dot of dots) {
    const info = replay.pathInfo.get(dot.id);
    dot.hasFutureMove = Boolean(info && info.lastFrame > frame);
    dot.inactive = Boolean(info && !dot.moving && !dot.hasFutureMove && frame > dot.lastMoveEnd + INACTIVE_GRACE_FRAMES);
    dot.opacity = dot.inactive ? 0.28 : 1;
    if (dot.inactive) {
      dot.health = Math.min(dot.health, 0.04);
      dot.morale = 0;
    }
  }
}

function applyGuideSimulation(dots, frame) {
  for (const dot of dots) {
    dot.inCombat = false;
    dot.incomingStrength = 0;
  }

  for (let leftIndex = 0; leftIndex < dots.length; leftIndex++) {
    const left = dots[leftIndex];
    if (left.owner == null) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < dots.length; rightIndex++) {
      const right = dots[rightIndex];
      if (right.owner == null || right.owner === left.owner) continue;
      const separation = distance(left, right);
      if (separation > COMBAT_RADIUS) continue;
      const pressure = 1 - separation / COMBAT_RADIUS;
      left.inCombat = true;
      right.inCombat = true;
      left.incomingStrength += battleStrength(right) * pressure;
      right.incomingStrength += battleStrength(left) * pressure;
    }
  }

  for (const dot of dots) {
    const movingMoraleLoss = dot.moving ? dot.moveAge * 0.002 : 0;
    const combatMoraleLoss = dot.inCombat ? (dot.moving ? 0.24 : 0.12) : 0;
    const recovery = dot.moving ? 0 : clamp((frame - dot.lastMoveEnd) / (FPS * 83), 0, 1);
    const morale = dot.inCombat ? clamp(1 - movingMoraleLoss - combatMoraleLoss, 0.04, 1) : clamp(0.55 + recovery * 0.45, 0.55, 1);
    const healthLoss = dot.inCombat ? dot.incomingStrength * 2.8 : 0;
    const idleHealing = dot.inCombat || dot.moving ? 0 : clamp((frame - dot.lastMoveEnd) / (FPS * 333), 0, 0.2);

    dot.morale = morale;
    dot.health = clamp(1 - healthLoss + idleHealing, 0.08, 1);
  }
}

function battleStrength(dot) {
  const stats = unitStats[dot.type] || unitStats.infantry;
  const morale = dot.morale ?? 1;
  const health = dot.health ?? 1;
  return stats.damage * (0.8 * morale + 0.2) * health;
}

function render() {
  resizeCanvas();
  ctx.clearRect(0, 0, elements.canvas.width, elements.canvas.height);
  drawBackground();

  if (!state.replay) {
    drawEmptyCanvas();
    return;
  }

  const snapshot = getReplaySnapshot(state.frame);

  drawMap();
  if (elements.zonesToggle.checked) drawPowerProjection(snapshot);
  if (elements.trailsToggle.checked) drawPaths(snapshot);
  drawCities(snapshot);
  if (elements.dotsToggle.checked) drawDots(snapshot);
  if (elements.messagesToggle.checked) drawActiveMessages(snapshot);
  updatePlayerStats(snapshot);
  updateTransport();
}

function drawBackground() {
  const width = elements.canvas.width;
  const height = elements.canvas.height;
  const gradient = ctx.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, '#111719');
  gradient.addColorStop(0.48, '#151a1d');
  gradient.addColorStop(1, '#101315');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  const spacing = Math.max(42, 100 * state.view.scale);
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.045)';
  ctx.lineWidth = 1;
  const startX = ((state.view.offsetX % spacing) + spacing) % spacing;
  const startY = ((state.view.offsetY % spacing) + spacing) % spacing;
  for (let x = startX; x < width; x += spacing) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }
  for (let y = startY; y < height; y += spacing) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }
  ctx.restore();
}

function drawEmptyCanvas() {
  ctx.save();
  ctx.textAlign = 'center';
  ctx.fillStyle = '#edf2f4';
  ctx.font = '700 22px system-ui, sans-serif';
  ctx.fillText('Load a War of Dots replay', elements.canvas.width / 2, elements.canvas.height / 2 - 10);
  ctx.fillStyle = '#9aa8b2';
  ctx.font = '14px system-ui, sans-serif';
  ctx.fillText('Open or drop a .rep file to begin.', elements.canvas.width / 2, elements.canvas.height / 2 + 18);
  ctx.restore();
}

function drawMap() {
  const replay = state.replay;
  if (!replay?.mapImage) return;

  const topLeft = worldToScreen({ x: 0, y: 0 });
  const width = replay.mapImage.naturalWidth * state.view.scale;
  const height = replay.mapImage.naturalHeight * state.view.scale;

  ctx.save();
  ctx.globalAlpha = 0.94;
  ctx.drawImage(replay.mapImage, topLeft.x, topLeft.y, width, height);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.18)';
  ctx.lineWidth = 1;
  ctx.strokeRect(topLeft.x, topLeft.y, width, height);
  ctx.restore();
}

function drawPaths(snapshot) {
  const replay = state.replay;
  for (const path of replay.paths) {
    const age = state.frame - path.frame;
    if (age < 0 || age > path.duration + PATH_FADE_FRAMES) continue;

    const owner = path.ownerId ?? snapshot.ownership.get(path.dotId);
    const color = getPlayerColor(owner);
    const progress = clamp(age / path.duration, 0, 1);
    const alpha = age <= path.duration ? 0.75 : 0.75 * (1 - clamp((age - path.duration) / PATH_FADE_FRAMES, 0, 1));

    drawPolyline(path.points, color, Math.max(0.14, alpha), 3.5, progress);
    if (progress < 1) drawPathHead(path.points, color, progress);
  }
}

function drawPolyline(points, color, alpha, lineWidth, progress = 1) {
  if (points.length < 2 || progress <= 0) return;

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1.2, lineWidth * Math.sqrt(state.view.scale));
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();

  const visible = getPartialPolyline(points, progress);
  const start = worldToScreen(visible[0]);
  ctx.moveTo(start.x, start.y);
  for (let index = 1; index < visible.length; index++) {
    const point = worldToScreen(visible[index]);
    ctx.lineTo(point.x, point.y);
  }

  ctx.stroke();
  ctx.restore();
}

function getPartialPolyline(points, progress) {
  if (progress >= 1) return points;
  const targetLength = pathLength(points) * progress;
  const output = [points[0]];
  let travelled = 0;

  for (let index = 1; index < points.length; index++) {
    const previous = points[index - 1];
    const current = points[index];
    const segmentLength = distance(previous, current);
    if (travelled + segmentLength >= targetLength) {
      const amount = segmentLength === 0 ? 0 : (targetLength - travelled) / segmentLength;
      output.push({
        x: previous.x + (current.x - previous.x) * amount,
        y: previous.y + (current.y - previous.y) * amount
      });
      break;
    }
    output.push(current);
    travelled += segmentLength;
  }

  return output;
}

function getPointAlongPath(points, progress) {
  if (points.length === 1 || progress <= 0) return points[0];
  if (progress >= 1) return points.at(-1);

  const targetLength = pathLength(points) * progress;
  let travelled = 0;

  for (let index = 1; index < points.length; index++) {
    const previous = points[index - 1];
    const current = points[index];
    const segmentLength = distance(previous, current);
    if (travelled + segmentLength >= targetLength) {
      const amount = segmentLength === 0 ? 0 : (targetLength - travelled) / segmentLength;
      return {
        x: previous.x + (current.x - previous.x) * amount,
        y: previous.y + (current.y - previous.y) * amount
      };
    }
    travelled += segmentLength;
  }

  return points.at(-1);
}

function drawPathHead(points, color, progress) {
  const visible = getPartialPolyline(points, progress);
  const head = worldToScreen(visible.at(-1));
  ctx.save();
  ctx.fillStyle = color;
  ctx.shadowColor = color;
  ctx.shadowBlur = 12;
  ctx.beginPath();
  ctx.arc(head.x, head.y, Math.max(3, 6 * Math.sqrt(state.view.scale)), 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawPowerProjection(snapshot) {
  const replay = state.replay;
  if (!replay) return;

  const sites = getProjectionSites(snapshot);
  if (sites.length < 2) return;

  const bounds = replay.mapImage
    ? { minX: 0, minY: 0, maxX: replay.mapImage.naturalWidth, maxY: replay.mapImage.naturalHeight }
    : replay.bounds;
  const width = Math.max(1, bounds.maxX - bounds.minX);
  const height = Math.max(1, bounds.maxY - bounds.minY);
  const cellSize = clamp(Math.max(width, height) / 76, 18, PROJECTION_GRID_SIZE);
  const cols = Math.max(2, Math.ceil(width / cellSize));
  const rows = Math.max(2, Math.ceil(height / cellSize));
  const owners = new Int16Array(cols * rows);
  owners.fill(-1);

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const x = bounds.minX + (col + 0.5) * cellSize;
      const y = bounds.minY + (row + 0.5) * cellSize;
      owners[row * cols + col] = getProjectionOwnerAt(sites, x, y);
    }
  }

  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  ctx.strokeStyle = 'rgba(0, 0, 0, 0.92)';
  ctx.lineWidth = clamp(3.4 * Math.sqrt(state.view.scale), 2.5, 6);

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const owner = owners[row * cols + col];
      if (owner < 0) continue;

      if (col + 1 < cols) {
        const rightOwner = owners[row * cols + col + 1];
        if (rightOwner >= 0 && rightOwner !== owner) {
          const start = worldToScreen({ x: bounds.minX + (col + 1) * cellSize, y: bounds.minY + row * cellSize });
          const end = worldToScreen({ x: bounds.minX + (col + 1) * cellSize, y: bounds.minY + (row + 1) * cellSize });
          ctx.beginPath();
          ctx.moveTo(start.x, start.y);
          ctx.lineTo(end.x, end.y);
          ctx.stroke();
        }
      }

      if (row + 1 < rows) {
        const bottomOwner = owners[(row + 1) * cols + col];
        if (bottomOwner >= 0 && bottomOwner !== owner) {
          const start = worldToScreen({ x: bounds.minX + col * cellSize, y: bounds.minY + (row + 1) * cellSize });
          const end = worldToScreen({ x: bounds.minX + (col + 1) * cellSize, y: bounds.minY + (row + 1) * cellSize });
          ctx.beginPath();
          ctx.moveTo(start.x, start.y);
          ctx.lineTo(end.x, end.y);
          ctx.stroke();
        }
      }
    }
  }

  ctx.restore();
}

function getProjectionSites(snapshot) {
  const sites = [];

  for (const city of snapshot.cities) {
    if (city.owner == null) continue;
    sites.push({
      x: city.x,
      y: city.y,
      owner: city.owner,
      weight: city.capital ? 2.9 : 2.3
    });
  }

  for (const dot of snapshot.dots) {
    if (dot.owner == null || dot.inactive) continue;
    sites.push({
      x: dot.x,
      y: dot.y,
      owner: dot.owner,
      weight: dot.type === 'tanks' ? 1.15 : 1
    });
  }

  return sites;
}

function getProjectionOwnerAt(sites, x, y) {
  let bestOwner = -1;
  let bestScore = Infinity;

  for (const site of sites) {
    const dx = site.x - x;
    const dy = site.y - y;
    const score = (dx * dx + dy * dy) / (site.weight * site.weight);
    if (score < bestScore) {
      bestScore = score;
      bestOwner = site.owner;
    }
  }

  return bestOwner;
}

function drawCities(snapshot) {
  const cityIcon = getStaticAsset('city');
  const capitalIcon = getStaticAsset('capital');
  for (const city of snapshot.cities) {
    const screen = worldToScreen(city);
    const iconSize = city.capital
      ? Math.max(24, 30 * Math.sqrt(state.view.scale))
      : Math.max(18, 23 * Math.sqrt(state.view.scale));
    const icon = city.capital ? (capitalIcon || cityIcon) : cityIcon;

    ctx.save();
    ctx.fillStyle = 'rgba(0, 0, 0, 0.78)';
    ctx.beginPath();
    ctx.arc(screen.x, screen.y, iconSize * 0.6, 0, Math.PI * 2);
    ctx.fill();
    if (city.owner != null) {
      ctx.strokeStyle = withAlpha(getPlayerColor(city.owner), 0.9);
      ctx.lineWidth = Math.max(1.5, 2.5 * Math.sqrt(state.view.scale));
      ctx.stroke();
    }
    ctx.restore();

    if (icon) {
      ctx.save();
      ctx.globalAlpha = 0.98;
      ctx.drawImage(icon, screen.x - iconSize / 2, screen.y - iconSize / 2, iconSize, iconSize);
      ctx.restore();
    } else {
      ctx.save();
      ctx.fillStyle = city.capital ? '#ffd76f' : '#f2c14e';
      ctx.beginPath();
      ctx.arc(screen.x, screen.y, Math.max(4, city.radius * Math.sqrt(state.view.scale)), 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    if (city.owner != null) drawCityFlag(city, screen, iconSize);
  }
}

function drawCityFlag(city, screen, iconSize) {
  const flag = getOwnerAsset(city.owner, 'flags');
  const flagSize = Math.max(16, 21 * Math.sqrt(state.view.scale));
  const flagX = screen.x + iconSize * 0.42;
  const flagY = screen.y - iconSize * 0.72;
  if (flag) {
    ctx.save();
    ctx.globalAlpha = city.influence > 0.2 ? 1 : 0.82;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.8)';
    ctx.beginPath();
    ctx.arc(flagX, flagY, flagSize * 0.42, 0, Math.PI * 2);
    ctx.fill();
    ctx.drawImage(flag, flagX - flagSize / 2, flagY - flagSize / 2, flagSize, flagSize);
    ctx.restore();
    return;
  }

  ctx.save();
  ctx.fillStyle = getPlayerColor(city.owner);
  ctx.fillRect(flagX - 5, flagY - 6, 10, 12);
  ctx.restore();
}

function drawDots(snapshot) {
  ctx.save();

  for (const dot of snapshot.dots) {
    const owner = dot.owner;
    const color = getPlayerColor(owner);
    const screen = worldToScreen(dot);
    const radius = Math.max(6, DOT_RADIUS * Math.sqrt(state.view.scale));
    const spriteSize = Math.max(14, DOT_RADIUS * 2.9 * Math.sqrt(state.view.scale));
    const icon = getOwnerAsset(owner, dot.type);
    ctx.globalAlpha = dot.opacity ?? 1;

    ctx.shadowColor = dot.moving ? color : 'transparent';
    ctx.shadowBlur = dot.moving ? 14 : 0;
    if (icon) {
      ctx.drawImage(icon, screen.x - spriteSize / 2, screen.y - spriteSize / 2, spriteSize, spriteSize);
    } else {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(screen.x, screen.y, radius, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.shadowBlur = 0;

    drawDotBars(screen, radius, dot.health, dot.morale);
  }
  ctx.restore();
}

function drawDotBars(screen, radius, health, morale) {
  const scale = clamp(Math.sqrt(state.view.scale), 0.72, 1.35);
  const width = BAR_WIDTH * scale;
  const height = Math.max(3, BAR_HEIGHT * scale);
  const x = screen.x - width / 2;
  const y = screen.y - radius - height * 3.2;

  drawMeter(x, y, width, height, health, '#44d17d');
  drawMeter(x, y + height + 2, width, height, morale, '#48b8ff');
}

function drawMeter(x, y, width, height, amount, color) {
  ctx.save();
  ctx.fillStyle = 'rgba(7, 10, 12, 0.78)';
  ctx.fillRect(x, y, width, height);
  ctx.fillStyle = color;
  ctx.fillRect(x, y, width * clamp(amount, 0, 1), height);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.28)';
  ctx.lineWidth = 1;
  ctx.strokeRect(x, y, width, height);
  ctx.restore();
}

function drawActiveMessages(snapshot) {
  if (snapshot.activeMessages.length === 0) return;

  ctx.save();
  const lines = snapshot.activeMessages.slice(-5).map((message) => {
    const player = state.replay.players[message.playerId];
    const name = player ? player.name : `Player ${message.playerId}`;
    return `${name}: ${message.text}`;
  });

  const x = 22;
  const y = elements.canvas.height - 28 - lines.length * 28;
  const width = Math.min(560, elements.canvas.width - 44);
  const height = lines.length * 28 + 18;
  drawRoundRect(x, y, width, height, 8, 'rgba(16, 19, 22, 0.82)', 'rgba(255, 255, 255, 0.11)');

  ctx.font = '14px system-ui, sans-serif';
  ctx.fillStyle = '#edf2f4';
  lines.forEach((line, index) => {
    ctx.fillText(clipText(line, 72), x + 12, y + 27 + index * 28);
  });
  ctx.restore();
}

function drawRoundRect(x, y, width, height, radius, fill, stroke) {
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, radius);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.strokeStyle = stroke;
  ctx.stroke();
}

function clipText(value, maxLength) {
  return value.length > maxLength ? `${value.slice(0, maxLength - 3)}...` : value;
}

function updatePlayerStats(snapshot) {
  if (!state.replay) return;
  for (const player of state.replay.players) {
    const target = document.getElementById(`playerStats${player.id}`);
    if (!target) continue;
    const stats = snapshot.production.get(player.id);
    const playerDots = snapshot.dots.filter((dot) => dot.owner === player.id);
    const owned = playerDots.length;
    const troops = playerDots.reduce((sum, dot) => sum + dot.health * dot.healthMax, 0);
    const rate = stats && stats.rate != null ? stats.rate.toFixed(2) : '-';
    const ratio = stats && stats.ratio != null ? stats.ratio.toFixed(2) : '-';
    target.textContent = `rate ${rate}, ratio ${ratio}, units ${owned}, troops ${Math.round(troops)}`;
  }
}

function getOwnerAsset(owner, assetType) {
  if (!Number.isFinite(owner)) return null;
  const source = assetPaths[assetType];
  if (!Array.isArray(source)) return null;
  const index = ((owner % source.length) + source.length) % source.length;
  const key = source[index];
  return loadedAssetImages.get(key) ?? null;
}

function getStaticAsset(assetType) {
  const key = assetPaths[assetType];
  return loadedAssetImages.get(key) ?? null;
}

function withAlpha(hex, alpha) {
  const value = hex.replace('#', '');
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function tick(timestamp) {
  if (!state.lastTimestamp) state.lastTimestamp = timestamp;
  const delta = timestamp - state.lastTimestamp;
  state.lastTimestamp = timestamp;

  if (state.playing && state.replay) {
    state.frame += (delta / 1000) * FPS * state.speed;
    if (state.frame >= state.replay.end) {
      state.frame = state.replay.end;
      state.playing = false;
      elements.playIcon.textContent = 'Play';
    }
  }

  render();
  requestAnimationFrame(tick);
}

async function loadFile(file) {
  const buffer = await file.arrayBuffer();
  setReplay(await decodeReplayBuffer(buffer, file.name));
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add('visible');
  window.clearTimeout(state.toastTimer);
  state.toastTimer = window.setTimeout(() => elements.toast.classList.remove('visible'), 2600);
}

function hideDropOverlay() {
  state.dragDepth = 0;
  elements.dropOverlay.hidden = true;
}

elements.fileInput.addEventListener('change', async () => {
  const file = elements.fileInput.files[0];
  if (!file) return;
  try {
    await loadFile(file);
  } catch (error) {
    showToast(error.message);
  } finally {
    elements.fileInput.value = '';
  }
});

elements.playButton.addEventListener('click', () => {
  if (!state.replay) return;
  if (state.frame >= state.replay.end) state.frame = state.replay.start;
  state.playing = !state.playing;
  state.lastTimestamp = 0;
  elements.playIcon.textContent = state.playing ? 'Pause' : 'Play';
});

elements.timeline.addEventListener('input', () => {
  state.frame = Number(elements.timeline.value);
  state.playing = false;
  elements.playIcon.textContent = 'Play';
  render();
});

elements.timeline.addEventListener('pointerdown', () => {
  state.wasPlayingBeforeScrub = state.playing;
  state.scrubbing = true;
});

function finishScrub() {
  if (!state.scrubbing) return;
  if (state.wasPlayingBeforeScrub && state.replay && state.frame < state.replay.end) {
    state.playing = true;
    state.lastTimestamp = 0;
    elements.playIcon.textContent = 'Pause';
  }
  state.wasPlayingBeforeScrub = false;
  state.scrubbing = false;
}

elements.timeline.addEventListener('pointerup', finishScrub);
window.addEventListener('pointerup', finishScrub);

elements.timeline.addEventListener('change', () => {
  finishScrub();
});

elements.speedRange.addEventListener('input', () => {
  state.speed = speedFromSlider(elements.speedRange.value);
  updateSpeedLabel();
});

elements.fitButton.addEventListener('click', () => {
  fitToReplay();
  render();
});

elements.resetButton.addEventListener('click', () => {
  if (!state.replay) return;
  state.frame = state.replay.start;
  state.playing = false;
  elements.playIcon.textContent = 'Play';
  render();
});

for (const toggle of [elements.trailsToggle, elements.dotsToggle, elements.zonesToggle, elements.messagesToggle]) {
  toggle.addEventListener('change', render);
}

function zoomAtClientPoint(event) {
  event.preventDefault();
  const rect = elements.canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  const mouseX = (event.clientX - rect.left) * ratio;
  const mouseY = (event.clientY - rect.top) * ratio;
  const before = screenToWorld(mouseX, mouseY);
  const factor = Math.exp(-event.deltaY * 0.0016);
  state.view.scale = clamp(state.view.scale * factor, 0.08, 5);
  state.view.offsetX = mouseX - before.x * state.view.scale;
  state.view.offsetY = mouseY - before.y * state.view.scale;
  render();
}

elements.viewerArea.addEventListener('wheel', (event) => {
  if (event.target.closest('input, button, select, label')) return;
  zoomAtClientPoint(event);
}, { passive: false });

elements.canvas.addEventListener('pointerdown', (event) => {
  elements.canvas.setPointerCapture(event.pointerId);
  elements.canvas.classList.add('dragging');
  state.dragging = true;
  state.dragStart = { x: event.clientX, y: event.clientY, offsetX: state.view.offsetX, offsetY: state.view.offsetY };
});

elements.canvas.addEventListener('pointermove', (event) => {
  if (!state.dragging || !state.dragStart) return;
  const ratio = window.devicePixelRatio || 1;
  state.view.offsetX = state.dragStart.offsetX + (event.clientX - state.dragStart.x) * ratio;
  state.view.offsetY = state.dragStart.offsetY + (event.clientY - state.dragStart.y) * ratio;
  render();
});

elements.canvas.addEventListener('pointerup', (event) => {
  elements.canvas.releasePointerCapture(event.pointerId);
  elements.canvas.classList.remove('dragging');
  state.dragging = false;
  state.dragStart = null;
});

window.addEventListener('resize', () => {
  fitToReplay();
  render();
});

function hasDraggedFiles(event) {
  return Array.from(event.dataTransfer?.types || []).includes('Files');
}

document.addEventListener('dragenter', (event) => {
  if (!hasDraggedFiles(event)) return;
  event.preventDefault();
  state.dragDepth += 1;
  elements.dropOverlay.hidden = false;
});

document.addEventListener('dragover', (event) => {
  if (!hasDraggedFiles(event)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'copy';
  elements.dropOverlay.hidden = false;
});

document.addEventListener('dragleave', (event) => {
  if (!hasDraggedFiles(event)) return;
  state.dragDepth = Math.max(0, state.dragDepth - 1);
  if (state.dragDepth === 0) hideDropOverlay();
});

document.addEventListener('drop', async (event) => {
  event.preventDefault();
  event.stopPropagation();
  hideDropOverlay();
  const file = event.dataTransfer.files[0];
  if (!file) {
    hideDropOverlay();
    return;
  }
  try {
    await loadFile(file);
  } catch (error) {
    showToast(error.message);
  } finally {
    hideDropOverlay();
  }
});

document.addEventListener('dragend', () => {
  hideDropOverlay();
});

window.addEventListener('blur', hideDropOverlay);
window.addEventListener('focus', hideDropOverlay);

resizeCanvas();
hideDropOverlay();
requestAnimationFrame(tick);
