const DEFAULT_CENTER = {
  longitude: 110.0,
  latitude: -3.0,
  height: 6_500_000,
};

const REFRESH_OPTIONS_MS = [15_000, 30_000, 60_000, 120_000];
const MAX_RENDERED_FLIGHTS = 500;
const MAX_LISTED_FLIGHTS = 200;
const MAX_TRAIL_POINTS = 5;
const FLIGHT_ENTITY_IDS = new Set();

class FlightTrackerApp {
  constructor(config) {
    this.config = config || {};
    this.viewer = null;
    this.entities = new Map();
    this.flightIndex = new Map();
    this.abortController = null;
    this.refreshTimer = null;
    this.isRefreshing = false;
    this.lastPayload = null;

    this.state = {
      autoRefresh: true,
      showGrounded: false,
      showLabels: false,
      showTrails: true,
      followSelected: false,
      search: '',
      fetchMode: this.config.defaultFetchMode || 'camera',
      refreshMs: this.config.defaultRefreshMs || 30_000,
      selectedIcao24: null,
    };

    this.ui = {};
  }

  async init() {
    if (!window.Cesium) {
      this.showFatalError(
        'CesiumJS failed to load. Check your internet connection or replace the CDN references with a locally hosted build.',
      );
      return;
    }

    this.cacheUi();
    this.populateRefreshOptions();
    this.bindUiEvents();
    this.initViewer();
    this.attachMapEvents();
    this.renderSelectedFlight();
    this.renderFlightList([]);
    this.renderStats([]);

    await this.refreshFlights({ reason: 'initial-load', flyHome: false });
    this.scheduleRefresh();
  }

  cacheUi() {
    this.ui.searchInput = document.getElementById('searchInput');
    this.ui.autoRefresh = document.getElementById('autoRefreshToggle');
    this.ui.showGrounded = document.getElementById('showGroundedToggle');
    this.ui.showLabels = document.getElementById('showLabelsToggle');
    this.ui.showTrails = document.getElementById('showTrailsToggle');
    this.ui.followSelected = document.getElementById('followSelectedToggle');
    this.ui.refreshInterval = document.getElementById('refreshIntervalSelect');
    this.ui.fetchMode = document.getElementById('fetchModeSelect');
    this.ui.refreshBtn = document.getElementById('refreshBtn');
    this.ui.resetViewBtn = document.getElementById('resetViewBtn');
    this.ui.zoomSelectedBtn = document.getElementById('zoomSelectedBtn');
    this.ui.statusBadge = document.getElementById('statusBadge');
    this.ui.legendBadge = document.getElementById('legendBadge');
    this.ui.flightList = document.getElementById('flightList');
    this.ui.listSummary = document.getElementById('listSummary');
    this.ui.selectedCard = document.getElementById('selectedFlightCard');
    this.ui.selectedFlightState = document.getElementById('selectedFlightState');
    this.ui.selectedFlightEmpty = document.getElementById('selectedFlightEmpty');
    this.ui.selectedCallsign = document.getElementById('selectedCallsign');
    this.ui.selectedIcao24 = document.getElementById('selectedIcao24');
    this.ui.selectedCountry = document.getElementById('selectedCountry');
    this.ui.selectedAltitude = document.getElementById('selectedAltitude');
    this.ui.selectedSpeed = document.getElementById('selectedSpeed');
    this.ui.selectedHeading = document.getElementById('selectedHeading');
    this.ui.selectedVerticalRate = document.getElementById('selectedVerticalRate');
    this.ui.selectedPosition = document.getElementById('selectedPosition');
    this.ui.selectedLastSeen = document.getElementById('selectedLastSeen');
    this.ui.statTracked = document.getElementById('statTracked');
    this.ui.statRendered = document.getElementById('statRendered');
    this.ui.statAirborne = document.getElementById('statAirborne');
    this.ui.statUpdated = document.getElementById('statUpdated');
    this.ui.bannerToken = document.getElementById('tokenBanner');

    this.ui.autoRefresh.checked = this.state.autoRefresh;
    this.ui.showGrounded.checked = this.state.showGrounded;
    this.ui.showLabels.checked = this.state.showLabels;
    this.ui.showTrails.checked = this.state.showTrails;
    this.ui.followSelected.checked = this.state.followSelected;
    this.ui.fetchMode.value = this.state.fetchMode;

    if (!this.config.hasCesiumToken) {
      this.ui.bannerToken.hidden = false;
    }
  }

  populateRefreshOptions() {
    this.ui.refreshInterval.innerHTML = '';
    for (const refreshMs of REFRESH_OPTIONS_MS) {
      const option = document.createElement('option');
      option.value = String(refreshMs);
      option.textContent = `${refreshMs / 1000}s`;
      if (refreshMs === this.state.refreshMs) {
        option.selected = true;
      }
      this.ui.refreshInterval.append(option);
    }
  }

  bindUiEvents() {
    this.ui.searchInput.addEventListener('input', () => {
      this.state.search = this.ui.searchInput.value.trim().toLowerCase();
      this.renderFromCurrentIndex();
    });

    this.ui.autoRefresh.addEventListener('change', () => {
      this.state.autoRefresh = this.ui.autoRefresh.checked;
      this.scheduleRefresh();
    });

    this.ui.showGrounded.addEventListener('change', () => {
      this.state.showGrounded = this.ui.showGrounded.checked;
      this.renderFromCurrentIndex();
    });

    this.ui.showLabels.addEventListener('change', () => {
      this.state.showLabels = this.ui.showLabels.checked;
      this.renderFromCurrentIndex();
    });

    this.ui.showTrails.addEventListener('change', () => {
      this.state.showTrails = this.ui.showTrails.checked;
      this.renderFromCurrentIndex();
    });

    this.ui.followSelected.addEventListener('change', () => {
      this.state.followSelected = this.ui.followSelected.checked;
      this.applyTrackedEntity();
    });

    this.ui.refreshInterval.addEventListener('change', () => {
      this.state.refreshMs = Number.parseInt(this.ui.refreshInterval.value, 10) || 30_000;
      this.scheduleRefresh();
      this.renderFromCurrentIndex();
    });

    this.ui.fetchMode.addEventListener('change', async () => {
      this.state.fetchMode = this.ui.fetchMode.value === 'global' ? 'global' : 'camera';
      await this.refreshFlights({ reason: 'mode-change' });
      this.scheduleRefresh();
    });

    this.ui.refreshBtn.addEventListener('click', async () => {
      await this.refreshFlights({ reason: 'manual-refresh' });
    });

    this.ui.resetViewBtn.addEventListener('click', () => {
      this.flyHome();
    });

    this.ui.zoomSelectedBtn.addEventListener('click', () => {
      this.zoomToSelected();
    });

    document.addEventListener('visibilitychange', () => {
      this.scheduleRefresh();
    });

    window.addEventListener('resize', () => {
      if (this.viewer) {
        this.viewer.resize();
      }
    });
  }

  initViewer() {
    const Cesium = window.Cesium;
    const baseOptions = {
      animation: false,
      baseLayerPicker: false,
      fullscreenButton: false,
      geocoder: false,
      homeButton: false,
      infoBox: false,
      navigationHelpButton: false,
      sceneModePicker: false,
      selectionIndicator: false,
      timeline: false,
      shouldAnimate: true,
      requestRenderMode: false,
    };

    if (this.config.cesiumToken) {
      Cesium.Ion.defaultAccessToken = this.config.cesiumToken;
      this.viewer = new Cesium.Viewer('viewer', {
        ...baseOptions,
        terrain: Cesium.Terrain.fromWorldTerrain(),
      });

      Cesium.createOsmBuildingsAsync()
        .then((buildingsTileset) => {
          this.viewer.scene.primitives.add(buildingsTileset);
          this.setLegend('Terrain + Cesium OSM Buildings enabled');
        })
        .catch(() => {
          this.setLegend('Terrain enabled. 3D building layer could not be loaded.');
        });
    } else {
      this.viewer = new Cesium.Viewer('viewer', {
        ...baseOptions,
        baseLayer: false,
        terrainProvider: new Cesium.EllipsoidTerrainProvider(),
      });

      this.viewer.imageryLayers.add(
        new Cesium.ImageryLayer(
          new Cesium.OpenStreetMapImageryProvider({
            url: 'https://tile.openstreetmap.org/',
          }),
        ),
      );

      this.setLegend('OpenStreetMap imagery + ellipsoid terrain');
    }

    this.viewer.clock.shouldAnimate = true;

    const scene = this.viewer.scene;
    const globe = scene.globe;
    globe.enableLighting = true;
    globe.depthTestAgainstTerrain = false;
    globe.baseColor = Cesium.Color.fromCssColorString('#0a1628');
    globe.showGroundAtmosphere = true;
    globe.lightingFadeOutDistance = 18_000_000;
    globe.lightingFadeInDistance = 9_000_000;
    globe.nightFadeOutDistance = 18_000_000;
    globe.nightFadeInDistance = 9_000_000;

    scene.highDynamicRange = true;
    scene.skyAtmosphere.hueShift = -0.02;
    scene.skyAtmosphere.saturationShift = 0.1;
    scene.skyAtmosphere.brightnessShift = -0.05;
    scene.fog.enabled = true;
    scene.fog.density = 2.0e-4;
    scene.fog.minimumBrightness = 0.03;
    scene.screenSpaceCameraController.minimumZoomDistance = 800;

    this.viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(
        DEFAULT_CENTER.longitude,
        DEFAULT_CENTER.latitude,
        DEFAULT_CENTER.height,
      ),
      duration: 0,
    });
  }

  attachMapEvents() {
    const Cesium = window.Cesium;
    const handler = new Cesium.ScreenSpaceEventHandler(this.viewer.scene.canvas);

    handler.setInputAction((movement) => {
      const picked = this.viewer.scene.pick(movement.position);
      if (picked && picked.id && FLIGHT_ENTITY_IDS.has(picked.id.id)) {
        this.selectFlight(picked.id.id, { flyTo: true });
      }
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

    const debouncedRefresh = debounce(async () => {
      if (this.state.fetchMode === 'camera' && !this.isRefreshing) {
        await this.refreshFlights({ reason: 'camera-move' });
      }
    }, 900);

    this.viewer.camera.moveEnd.addEventListener(() => {
      debouncedRefresh();
    });
  }

  async refreshFlights({ reason = 'refresh' } = {}) {
    if (this.isRefreshing) {
      return;
    }

    this.isRefreshing = true;
    this.setStatus(`Refreshing flights… (${reason})`, 'loading');

    if (this.abortController) {
      this.abortController.abort();
    }

    this.abortController = new AbortController();

    try {
      const payload = await this.fetchFlights({ signal: this.abortController.signal });
      this.lastPayload = payload;
      this.applyPayload(payload);
    } catch (error) {
      if (error.name === 'AbortError') {
        return;
      }

      const message = error instanceof Error ? error.message : 'Failed to refresh flights.';
      this.setStatus(message, 'error');
    } finally {
      this.isRefreshing = false;
      this.scheduleRefresh();
    }
  }

  async fetchFlights({ signal }) {
    const query = new URLSearchParams();
    query.set('mode', this.state.fetchMode);
    query.set('extended', '1');

    if (this.state.fetchMode === 'camera') {
      const bounds = this.getCameraBounds();
      if (bounds) {
        query.set('lamin', bounds.lamin.toFixed(4));
        query.set('lomin', bounds.lomin.toFixed(4));
        query.set('lamax', bounds.lamax.toFixed(4));
        query.set('lomax', bounds.lomax.toFixed(4));
      }
    }

    const response = await fetch(`/api/flights?${query.toString()}`, {
      signal,
      headers: {
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to load flights (${response.status}).`);
    }

    return await response.json();
  }

  applyPayload(payload) {
    const rawFlights = Array.isArray(payload?.data?.states)
      ? payload.data.states.map((row) => normalizeFlightRow(row, payload.data.time)).filter(Boolean)
      : [];

    const flightsByIcao = new Map();
    for (const flight of rawFlights) {
      if (flight && flight.icao24) {
        flightsByIcao.set(flight.icao24, flight);
      }
    }
    const flights = Array.from(flightsByIcao.values());
    this.flightIndex = new Map(flights.map((f) => [f.icao24, f]));

    const filteredFlights = this.filterFlights(flights);
    const renderableFlights = filteredFlights
      .slice()
      .sort((left, right) => compareFlights(left, right, this.state.selectedIcao24))
      .slice(0, MAX_RENDERED_FLIGHTS);

    this.upsertEntities(renderableFlights);
    this.pruneEntities(renderableFlights);
    this.renderFlightList(renderableFlights);
    this.renderStats(renderableFlights);
    this.renderSelectedFlight();
    this.updateStatusFromPayload(payload, renderableFlights.length, flights.length);
    this.applyTrackedEntity();
  }

  filterFlights(flights) {
    const search = this.state.search;
    return flights.filter((flight) => {
      if (!this.state.showGrounded && flight.onGround) {
        return false;
      }

      if (!search) {
        return true;
      }

      const haystack = `${flight.callsign || ''} ${flight.icao24} ${flight.originCountry || ''}`.toLowerCase();
      return haystack.includes(search);
    });
  }

  upsertEntities(flights) {
    const Cesium = window.Cesium;
    const now = Cesium.JulianDate.now();
    const future = Cesium.JulianDate.addSeconds(
      now,
      this.state.refreshMs / 1000,
      new Cesium.JulianDate(),
    );

    for (const flight of flights) {
      let entity = this.entities.get(flight.icao24);
      const currentPosition = Cesium.Cartesian3.fromDegrees(
        flight.longitude,
        flight.latitude,
        flight.altitudeMeters,
      );
      const projected = projectPosition({
        latitude: flight.latitude,
        longitude: flight.longitude,
        altitudeMeters: flight.altitudeMeters,
        verticalRate: flight.verticalRate,
        velocity: flight.velocity,
        trueTrack: flight.trueTrack,
        seconds: this.state.refreshMs / 1000,
        onGround: flight.onGround,
      });
      const projectedPosition = flight.onGround
        ? currentPosition
        : Cesium.Cartesian3.fromDegrees(
            projected.longitude,
            projected.latitude,
            projected.altitudeMeters,
          );

      const positionProperty = new Cesium.SampledPositionProperty();
      positionProperty.addSample(now, currentPosition);
      positionProperty.addSample(future, projectedPosition);
      positionProperty.setInterpolationOptions({
        interpolationAlgorithm: Cesium.LinearApproximation,
        interpolationDegree: 1,
      });
      positionProperty.forwardExtrapolationType = Cesium.ExtrapolationType.HOLD;
      positionProperty.forwardExtrapolationDuration = 0;

      const trailPositions = (entity?.trailPositions || []).concat([currentPosition]).slice(-MAX_TRAIL_POINTS);
      const baseColor = this.getFlightColor(flight);
      const selected = flight.icao24 === this.state.selectedIcao24;

      if (!entity) {
        entity = this.viewer.entities.add({
          id: flight.icao24,
          position: positionProperty,
          billboard: {
            image: '/plane-marker.svg',
            width: selected ? 28 : 22,
            height: selected ? 28 : 22,
            rotation: flight.trueTrack == null ? 0 : Cesium.Math.toRadians(-flight.trueTrack),
            color: baseColor,
            verticalOrigin: Cesium.VerticalOrigin.CENTER,
            horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
            scaleByDistance: new Cesium.NearFarScalar(50_000, 1.4, 4_000_000, 0.5),
            translucencyByDistance: new Cesium.NearFarScalar(100_000, 1.0, 12_000_000, 0.6),
          },
          label: {
            text: this.getLabelText(flight),
            font: '11px Inter, system-ui, sans-serif',
            show: this.state.showLabels || selected,
            fillColor: Cesium.Color.WHITE,
            outlineColor: Cesium.Color.BLACK,
            outlineWidth: 3,
            style: Cesium.LabelStyle.FILL_AND_OUTLINE,
            backgroundColor: Cesium.Color.fromCssColorString('#07111de6'),
            showBackground: true,
            pixelOffset: new Cesium.Cartesian2(0, -20),
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
            distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 2_500_000),
            scaleByDistance: new Cesium.NearFarScalar(50_000, 1.0, 2_500_000, 0.7),
          },
          polyline: {
            positions: trailPositions,
            width: selected ? 2.4 : 1.4,
            show: this.state.showTrails && trailPositions.length > 1,
            material: baseColor.withAlpha(selected ? 0.7 : 0.3),
          },
        });

        FLIGHT_ENTITY_IDS.add(flight.icao24);
        this.entities.set(flight.icao24, entity);
      } else {
        entity.position = positionProperty;
        entity.billboard.rotation = flight.trueTrack == null ? 0 : Cesium.Math.toRadians(-flight.trueTrack);
        entity.billboard.color = baseColor;
        entity.billboard.width = selected ? 28 : 22;
        entity.billboard.height = selected ? 28 : 22;
        entity.label.text = this.getLabelText(flight);
        entity.label.show = this.state.showLabels || selected;
        entity.polyline.positions = trailPositions;
        entity.polyline.show = this.state.showTrails && trailPositions.length > 1;
        entity.polyline.width = selected ? 2.4 : 1.4;
        entity.polyline.material = baseColor.withAlpha(selected ? 0.7 : 0.3);
      }

      entity.flightData = flight;
      entity.trailPositions = trailPositions;
    }
  }

  pruneEntities(flights) {
    const activeIds = new Set(flights.map((flight) => flight.icao24));
    for (const [icao24, entity] of this.entities.entries()) {
      if (activeIds.has(icao24)) {
        continue;
      }

      this.viewer.entities.remove(entity);
      this.entities.delete(icao24);
      FLIGHT_ENTITY_IDS.delete(icao24);
      if (this.state.selectedIcao24 === icao24) {
        this.state.selectedIcao24 = null;
      }
    }
  }

  renderFromCurrentIndex() {
    if (!this.lastPayload) {
      return;
    }

    this.applyPayload(this.lastPayload);
  }

  renderFlightList(flights) {
    this.ui.flightList.innerHTML = '';
    const listedFlights = flights.slice(0, MAX_LISTED_FLIGHTS);

    if (listedFlights.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'flight-list-empty';
      empty.textContent = 'No flights match the current filters.';
      this.ui.flightList.append(empty);
      this.ui.listSummary.textContent = '0 visible';
      return;
    }

    this.ui.listSummary.textContent =
      flights.length > MAX_LISTED_FLIGHTS
        ? `${MAX_LISTED_FLIGHTS.toLocaleString()} of ${flights.length.toLocaleString()} visible`
        : `${flights.length.toLocaleString()} visible`;

    for (const flight of listedFlights) {
      const item = document.createElement('li');
      const button = document.createElement('button');
      const selected = flight.icao24 === this.state.selectedIcao24;
      button.type = 'button';
      button.className = `flight-row${selected ? ' selected' : ''}`;
      button.innerHTML = `
        <span class="flight-row-main">
          <span class="flight-row-callsign">${escapeHtml(flight.callsign || flight.icao24.toUpperCase())}</span>
          <span class="flight-row-country">${escapeHtml(flight.originCountry || 'Unknown')}</span>
        </span>
        <span class="flight-row-sub">
          <span>${escapeHtml(flight.icao24.toUpperCase())}</span>
          <span>${formatAltitudeFeetShort(flight.altitudeMeters)}</span>
          <span>${formatSpeedKnotsShort(flight.velocity)}</span>
        </span>
      `;
      button.addEventListener('click', () => {
        this.selectFlight(flight.icao24, { flyTo: true });
      });
      item.append(button);
      this.ui.flightList.append(item);
    }
  }

  renderStats(flights) {
    const allFlights = Array.from(this.flightIndex.values());
    const airborne = flights.filter((flight) => !flight.onGround).length;

    this.ui.statTracked.textContent = allFlights.length.toLocaleString();
    this.ui.statRendered.textContent = flights.length.toLocaleString();
    this.ui.statAirborne.textContent = airborne.toLocaleString();

    if (this.lastPayload?.meta?.retrievedAt) {
      this.ui.statUpdated.textContent = formatTime(this.lastPayload.meta.retrievedAt);
    } else {
      this.ui.statUpdated.textContent = '—';
    }
  }

  renderSelectedFlight() {
    const selected = this.state.selectedIcao24 ? this.flightIndex.get(this.state.selectedIcao24) : null;
    this.ui.zoomSelectedBtn.disabled = !selected;

    if (!selected) {
      this.ui.selectedFlightState.hidden = true;
      this.ui.selectedFlightEmpty.hidden = false;
      return;
    }

    this.ui.selectedFlightState.hidden = false;
    this.ui.selectedFlightEmpty.hidden = true;
    this.ui.selectedCallsign.textContent = selected.callsign || 'Unknown callsign';
    this.ui.selectedIcao24.textContent = selected.icao24.toUpperCase();
    this.ui.selectedCountry.textContent = selected.originCountry || 'Unknown';
    this.ui.selectedAltitude.textContent = formatAltitudeFeet(selected.altitudeMeters);
    this.ui.selectedSpeed.textContent = formatSpeedKnots(selected.velocity);
    this.ui.selectedHeading.textContent = selected.trueTrack == null ? '—' : `${Math.round(selected.trueTrack)}°`;
    this.ui.selectedVerticalRate.textContent = formatVerticalRate(selected.verticalRate);
    this.ui.selectedPosition.textContent = `${selected.latitude.toFixed(4)}, ${selected.longitude.toFixed(4)}`;
    this.ui.selectedLastSeen.textContent = formatRelativeAgeSeconds(selected.lastContactAgeSeconds);
  }

  updateStatusFromPayload(payload, renderedCount, totalCount) {
    const meta = payload?.meta || {};
    const sourceLabel = {
      opensky: meta.authenticated ? 'OpenSky • OAuth2' : 'OpenSky • Anonymous',
      demo: 'Demo sample data',
      'sample-fallback': 'Sample fallback',
    }[meta.source] || 'Flight feed';

    const statusBits = [sourceLabel, `${renderedCount.toLocaleString()} rendered`, `${totalCount.toLocaleString()} tracked`];
    if (meta.rateLimitRemaining) {
      statusBits.push(`${meta.rateLimitRemaining} credits left`);
    }

    const statusText = statusBits.join(' • ');
    const statusTone = meta.degraded ? 'warn' : 'ready';
    this.setStatus(statusText, statusTone);

    const detailBits = [meta.message].filter(Boolean);
    if (meta.mode === 'camera') {
      detailBits.push('Camera-bounds mode');
    } else {
      detailBits.push('Global mode');
    }
    this.setLegend(detailBits.join(' • '));
  }

  setStatus(message, tone = 'ready') {
    this.ui.statusBadge.textContent = message;
    this.ui.statusBadge.dataset.tone = tone;
  }

  setLegend(message) {
    this.ui.legendBadge.textContent = message;
  }

  getCameraBounds() {
    const Cesium = window.Cesium;
    const rect = this.viewer.camera.computeViewRectangle(this.viewer.scene.globe.ellipsoid);
    if (!rect) {
      return null;
    }

    let west = Cesium.Math.toDegrees(rect.west);
    let south = Cesium.Math.toDegrees(rect.south);
    let east = Cesium.Math.toDegrees(rect.east);
    let north = Cesium.Math.toDegrees(rect.north);

    west = normalizeLongitude(west - 2);
    east = normalizeLongitude(east + 2);
    south = clampNumber(south - 1, -85, 85);
    north = clampNumber(north + 1, -85, 85);

    if (east < west) {
      return null;
    }

    return {
      lomin: west,
      lamin: south,
      lomax: east,
      lamax: north,
    };
  }

  selectFlight(icao24, { flyTo = false } = {}) {
    this.state.selectedIcao24 = icao24;

    for (const [entityId, entity] of this.entities.entries()) {
      const flight = entity.flightData;
      const isSelected = entityId === icao24;
      entity.billboard.width = isSelected ? 28 : 22;
      entity.billboard.height = isSelected ? 28 : 22;
      entity.billboard.color = this.getFlightColor(flight, isSelected);
      entity.label.show = this.state.showLabels || isSelected;
      entity.polyline.width = isSelected ? 2.4 : 1.4;
      entity.polyline.material = this.getFlightColor(flight, isSelected).withAlpha(isSelected ? 0.7 : 0.3);
    }

    if (flyTo) {
      this.zoomToSelected();
    }

    this.renderFromCurrentIndex();
    this.renderSelectedFlight();
    this.applyTrackedEntity();
  }

  zoomToSelected() {
    const entity = this.state.selectedIcao24 ? this.entities.get(this.state.selectedIcao24) : null;
    if (!entity) {
      return;
    }

    this.viewer.flyTo(entity, {
      duration: 1.4,
      offset: new window.Cesium.HeadingPitchRange(0, -0.55, 90_000),
    });
  }

  applyTrackedEntity() {
    const entity = this.state.selectedIcao24 ? this.entities.get(this.state.selectedIcao24) : null;
    this.viewer.trackedEntity = this.state.followSelected && entity ? entity : undefined;
  }

  flyHome() {
    this.viewer.trackedEntity = undefined;
    this.state.followSelected = false;
    this.ui.followSelected.checked = false;
    this.viewer.camera.flyTo({
      destination: window.Cesium.Cartesian3.fromDegrees(
        DEFAULT_CENTER.longitude,
        DEFAULT_CENTER.latitude,
        DEFAULT_CENTER.height,
      ),
      duration: 1.6,
    });
  }

  getFlightColor(flight, selected = false) {
    const Cesium = window.Cesium;
    if (selected) {
      return Cesium.Color.fromCssColorString('#fcd34d');
    }

    if (flight.onGround) {
      return Cesium.Color.fromCssColorString('#fb923c');
    }

    if (flight.altitudeMeters >= 10_000) {
      return Cesium.Color.fromCssColorString('#60a5fa');
    }

    if (flight.verticalRate > 1) {
      return Cesium.Color.fromCssColorString('#34d399');
    }

    if (flight.verticalRate < -1) {
      return Cesium.Color.fromCssColorString('#f87171');
    }

    return Cesium.Color.fromCssColorString('#22d3ee');
  }

  getLabelText(flight) {
    const name = flight.callsign || flight.icao24.toUpperCase();
    return `${name}\n${formatAltitudeFeetShort(flight.altitudeMeters)}`;
  }

  scheduleRefresh() {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }

    if (!this.state.autoRefresh || document.hidden) {
      return;
    }

    this.refreshTimer = window.setTimeout(() => {
      this.refreshFlights({ reason: 'interval' });
    }, this.state.refreshMs);
  }

  showFatalError(message) {
    const viewer = document.getElementById('viewer');
    viewer.innerHTML = `<div class="fatal-error">${escapeHtml(message)}</div>`;
  }
}

function normalizeFlightRow(row, snapshotUnixTime) {
  if (!Array.isArray(row)) {
    return null;
  }

  const icao24 = String(row[0] || '').trim().toLowerCase();
  const longitude = numberOrNull(row[5]);
  const latitude = numberOrNull(row[6]);
  const baroAltitude = numberOrNull(row[7]);
  const onGround = Boolean(row[8]);
  const velocity = numberOrNull(row[9]);
  const trueTrack = numberOrNull(row[10]);
  const verticalRate = numberOrNull(row[11]);
  const geoAltitude = numberOrNull(row[13]);
  const lastContact = numberOrNull(row[4]);

  if (!icao24 || !Number.isFinite(longitude) || !Number.isFinite(latitude)) {
    return null;
  }

  const altitudeMeters = geoAltitude ?? baroAltitude ?? 0;

  return {
    icao24,
    callsign: String(row[1] || '').trim(),
    originCountry: String(row[2] || '').trim(),
    timePosition: numberOrNull(row[3]),
    lastContact,
    longitude,
    latitude,
    altitudeMeters,
    onGround,
    velocity,
    trueTrack,
    verticalRate,
    sensors: Array.isArray(row[12]) ? row[12] : null,
    geoAltitude,
    squawk: row[14] ? String(row[14]) : null,
    spi: Boolean(row[15]),
    positionSource: numberOrNull(row[16]),
    category: numberOrNull(row[17]),
    snapshotUnixTime: numberOrNull(snapshotUnixTime),
    lastContactAgeSeconds:
      lastContact == null ? null : Math.max(0, Math.floor(Date.now() / 1000) - lastContact),
  };
}

function projectPosition({ latitude, longitude, altitudeMeters, verticalRate, velocity, trueTrack, seconds, onGround }) {
  if (
    onGround ||
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    !Number.isFinite(velocity) ||
    !Number.isFinite(trueTrack) ||
    velocity <= 0
  ) {
    return {
      latitude,
      longitude,
      altitudeMeters,
    };
  }

  const earthRadiusMeters = 6_371_000;
  const angularDistance = (velocity * seconds) / earthRadiusMeters;
  const bearing = degreesToRadians(trueTrack);
  const lat1 = degreesToRadians(latitude);
  const lon1 = degreesToRadians(longitude);

  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(angularDistance) +
      Math.cos(lat1) * Math.sin(angularDistance) * Math.cos(bearing),
  );

  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(lat1),
      Math.cos(angularDistance) - Math.sin(lat1) * Math.sin(lat2),
    );

  return {
    latitude: radiansToDegrees(lat2),
    longitude: normalizeLongitude(radiansToDegrees(lon2)),
    altitudeMeters: Math.max(0, altitudeMeters + (Number(verticalRate) || 0) * seconds),
  };
}

function compareFlights(left, right, selectedIcao24) {
  if (left.icao24 === selectedIcao24) {
    return -1;
  }
  if (right.icao24 === selectedIcao24) {
    return 1;
  }

  if (left.onGround !== right.onGround) {
    return left.onGround ? 1 : -1;
  }

  return (right.altitudeMeters || 0) - (left.altitudeMeters || 0);
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function formatAltitudeFeet(meters) {
  if (!Number.isFinite(meters)) {
    return '—';
  }
  const feet = meters * 3.28084;
  return `${Math.round(feet).toLocaleString()} ft`;
}

function formatAltitudeFeetShort(meters) {
  if (!Number.isFinite(meters)) {
    return '—';
  }
  const feet = meters * 3.28084;
  return `${Math.round(feet / 100) * 100} ft`;
}

function formatSpeedKnots(speedMetersPerSecond) {
  if (!Number.isFinite(speedMetersPerSecond)) {
    return '—';
  }
  const knots = speedMetersPerSecond * 1.94384;
  return `${Math.round(knots).toLocaleString()} kn`;
}

function formatSpeedKnotsShort(speedMetersPerSecond) {
  if (!Number.isFinite(speedMetersPerSecond)) {
    return '—';
  }
  const knots = speedMetersPerSecond * 1.94384;
  return `${Math.round(knots)} kn`;
}

function formatVerticalRate(verticalRateMetersPerSecond) {
  if (!Number.isFinite(verticalRateMetersPerSecond)) {
    return '—';
  }
  const feetPerMinute = verticalRateMetersPerSecond * 196.8504;
  const prefix = feetPerMinute > 0 ? '+' : '';
  return `${prefix}${Math.round(feetPerMinute).toLocaleString()} fpm`;
}

function formatRelativeAgeSeconds(ageSeconds) {
  if (!Number.isFinite(ageSeconds)) {
    return '—';
  }

  if (ageSeconds < 5) {
    return 'Just now';
  }
  if (ageSeconds < 60) {
    return `${ageSeconds}s ago`;
  }

  const minutes = Math.floor(ageSeconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }

  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

function formatTime(isoString) {
  const date = new Date(isoString);
  if (Number.isNaN(date.valueOf())) {
    return '—';
  }
  return date.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function debounce(callback, waitMs) {
  let timeoutId = null;
  return (...args) => {
    if (timeoutId) {
      window.clearTimeout(timeoutId);
    }
    timeoutId = window.setTimeout(() => callback(...args), waitMs);
  };
}

function clampNumber(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normalizeLongitude(value) {
  let normalized = value;
  while (normalized < -180) {
    normalized += 360;
  }
  while (normalized > 180) {
    normalized -= 360;
  }
  return normalized;
}

function degreesToRadians(value) {
  return (value * Math.PI) / 180;
}

function radiansToDegrees(value) {
  return (value * 180) / Math.PI;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

async function bootstrap() {
  try {
    const response = await fetch('/api/config', {
      headers: {
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`Config request failed (${response.status})`);
    }

    const config = await response.json();
    const app = new FlightTrackerApp(config);
    await app.init();
    window.flightTrackerApp = app;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to start the app.';
    const viewer = document.getElementById('viewer');
    viewer.innerHTML = `<div class="fatal-error">${escapeHtml(message)}</div>`;
  }
}

bootstrap();
