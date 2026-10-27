export default async function install(app) {
  const searchMount = app.getMount("station-search");
  const resultMount = app.getMount("coverage-results");
  const layer = app.layers[app.config.layerId];
  app.assert(layer, "Police station layer is not available.");
  await layer.load();

  const [serviceArea, networkService, ServiceAreaParameters, FeatureSet, Graphic, Portal] = await Promise.all([
    app.import("esri/rest/serviceArea"),
    app.import("esri/rest/networkService"),
    app.import("esri/rest/support/ServiceAreaParameters"),
    app.import("esri/rest/support/FeatureSet"),
    app.import("esri/Graphic"),
    app.import("esri/portal/Portal"),
  ]);

  const minutes = app.config.minutes ?? 10;
  const desiredMode = String(app.config.travelMode ?? "Driving Time");
  const oidField = layer.objectIdField;
  const nameField = app.config.nameField;
  const addressField = app.config.addressField;
  const detailFields = (app.config.detailFields ?? []).filter(Boolean);

  const areaLayer = await app.createResultLayer({
    id: app.config.resultLayerId ?? "station-service-area-result",
    title: `${minutes}-minute Police Response Coverage`,
    geometryType: "polygon",
    fields: [
      { name: "Station", type: "string" },
      { name: "Minutes", type: "double" },
      { name: "ToBreak", type: "double" }
    ],
    renderer: {
      type: "simple",
      symbol: {
        type: "simple-fill",
        color: [0, 77, 168, 0.22],
        outline: { color: [0, 77, 168, 0.95], width: 2 }
      }
    },
    popupTemplate: {
      title: `${minutes}-minute coverage`,
      content: "{Station}<br/>Travel time: {Minutes} minutes"
    }
  });

  const make = (tag, text, className) => {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  };

  const style = document.createElement("style");
  style.textContent = `
    .station-ui { display:flex; flex-direction:column; gap:8px; font: 13px/1.35 system-ui, sans-serif; }
    .station-row { display:flex; gap:6px; }
    .station-input { flex:1; min-width:0; padding:7px 8px; border:1px solid var(--calcite-color-border-2,#b9c0c7); border-radius:4px; }
    .station-button { padding:7px 10px; border:1px solid var(--calcite-color-brand,#0079c1); border-radius:4px; background:var(--calcite-color-brand,#0079c1); color:white; cursor:pointer; }
    .station-list { display:flex; flex-direction:column; gap:4px; max-height:245px; overflow:auto; }
    .station-item { text-align:left; border:1px solid var(--calcite-color-border-2,#d4d4d4); border-radius:4px; background:var(--calcite-color-foreground-1,#fff); padding:7px; cursor:pointer; }
    .station-name { font-weight:600; }
    .station-meta { color:var(--calcite-color-text-2,#5f6a72); font-size:12px; }
    .coverage-card { font: 13px/1.4 system-ui, sans-serif; display:flex; flex-direction:column; gap:8px; }
    .coverage-title { font-weight:700; font-size:15px; }
    .coverage-note { color:var(--calcite-color-text-2,#5f6a72); }
    .coverage-error { color:#b00020; }
  `;

  const ui = make("div", undefined, "station-ui");
  const hint = make("div", "Search by precinct, address, telephone, type, or ZIP; or click a station on the map.", "station-meta");
  const row = make("div", undefined, "station-row");
  const input = make("input", undefined, "station-input");
  input.type = "search";
  input.placeholder = "Search police station…";
  const button = make("button", "Search", "station-button");
  const list = make("div", undefined, "station-list");
  row.append(input, button);
  ui.append(hint, row, list);
  searchMount.replaceChildren(style, ui);

  const showMessage = (title, message, isError = false) => {
    const box = make("div", undefined, "coverage-card");
    box.append(make("div", title, "coverage-title"));
    box.append(make("div", message, isError ? "coverage-error" : "coverage-note"));
    resultMount.replaceChildren(box);
  };
  showMessage("No station selected yet.", `Choose a station to solve and draw the ${minutes}-minute service area.`);

  const q = layer.createQuery();
  q.where = "1=1";
  q.outFields = [oidField, nameField, addressField, ...detailFields].filter(Boolean);
  q.returnGeometry = false;
  q.orderByFields = nameField ? [nameField] : undefined;
  const stationResult = await layer.queryFeatures(q);
  const stations = stationResult.features.map((f) => ({
    oid: f.attributes[oidField],
    name: String(f.attributes[nameField] ?? "Unnamed station"),
    address: String(f.attributes[addressField] ?? ""),
    details: detailFields.map((field) => f.attributes[field]).filter((value) => value != null && value !== "").map(String)
  }));

  let serviceAreaUrl;
  let travelMode;
  let requestId = 0;
  let highlightHandle;

  const getTravelMode = async () => {
    if (!serviceAreaUrl || !travelMode) {
      const portal = new Portal(app.portalUrl ? { url: app.portalUrl } : {});
      await portal.load();
      serviceAreaUrl = portal.helperServices?.serviceArea?.url;
      app.assert(serviceAreaUrl, "This portal does not advertise a service area helper service.");
      const description = await networkService.fetchServiceDescription(serviceAreaUrl);
      const modes = description.supportedTravelModes ?? [];
      const desiredLower = desiredMode.toLowerCase();
      travelMode = modes.find((m) => String(m.name ?? "").toLowerCase() === desiredLower)
        || modes.find((m) => String(m.name ?? "").toLowerCase().includes(desiredLower))
        || modes.find((m) => m.type === "automobile" && m.impedanceAttributeName === m.timeAttributeName)
        || modes.find((m) => /time/i.test(m.name || ""));
      app.assert(travelMode, "The service area service offers no supported time-based travel mode.");
    }
    return travelMode;
  };

  const solveForGraphic = async (graphic) => {
    const current = ++requestId;
    const oid = graphic.getObjectId ? graphic.getObjectId() : graphic.attributes?.[oidField];
    const query = layer.createQuery();
    query.objectIds = [oid];
    query.outFields = ["*"];
    query.returnGeometry = true;
    const { features } = await layer.queryFeatures(query);
    const station = features[0];
    if (!station?.geometry) {
      showMessage("Station unavailable", "The selected station could not be read with geometry.", true);
      return { ok: false, reason: "missing-station" };
    }

    const stationName = String(station.attributes[nameField] ?? "Selected station");
    showMessage(stationName, `Solving ${minutes}-minute response coverage…`);

    try {
      const mode = await getTravelMode();
      const params = new ServiceAreaParameters({
        facilities: new FeatureSet({ features: [new Graphic({ geometry: station.geometry, attributes: station.attributes })] }),
        travelMode: mode,
        defaultBreaks: [minutes],
        outSpatialReference: app.view.spatialReference,
        trimOuterPolygon: true,
        returnFacilities: false
      });
      const solved = await serviceArea.solve(serviceAreaUrl, params);
      if (current !== requestId) return { ok: false, reason: "superseded" };
      const polygons = solved.serviceAreaPolygons?.features ?? [];
      await areaLayer.replaceFeatures(polygons.map((p) => ({
        geometry: p.geometry,
        attributes: { Station: stationName, Minutes: minutes, ToBreak: p.attributes?.ToBreak ?? minutes }
      })));
      try {
        const layerView = await app.view.whenLayerView(layer);
        if (highlightHandle) highlightHandle.remove();
        highlightHandle = layerView.highlight([oid]);
      } catch (ignore) {}
      if (polygons[0]?.geometry) await app.view.goTo(polygons.map((p) => p.geometry), { duration: 700 }).catch(() => {});

      const box = make("div", undefined, "coverage-card");
      box.append(make("div", stationName, "coverage-title"));
      if (station.attributes[addressField]) box.append(make("div", String(station.attributes[addressField]), "coverage-note"));
      box.append(make("div", `${polygons.length} ${minutes}-minute service-area polygon${polygons.length === 1 ? "" : "s"} drawn using ${mode.name || desiredMode}.`, "coverage-note"));
      resultMount.replaceChildren(box);
      return { ok: true, objectId: oid, stationName, polygonCount: polygons.length, travelMode: mode.name || null };
    } catch (error) {
      if (current === requestId) showMessage("Service area failed", error?.message || String(error), true);
      if (app.reportError) app.reportError(error);
      return { ok: false, reason: error?.message || String(error) };
    }
  };

  const renderList = (rows) => {
    list.replaceChildren();
    if (!rows.length) {
      list.append(make("div", "No matching stations.", "station-meta"));
      return;
    }
    rows.slice(0, 12).forEach((s) => {
      const item = make("button", undefined, "station-item");
      item.append(make("div", s.name, "station-name"));
      item.append(make("div", [s.address, ...s.details].filter(Boolean).join(" • "), "station-meta"));
      const click = async () => {
        const query = layer.createQuery();
        query.objectIds = [s.oid];
        query.outFields = ["*"];
        query.returnGeometry = true;
        const { features } = await layer.queryFeatures(query);
        if (features[0]) await solveForGraphic(features[0]);
      };
      item.addEventListener("click", click);
      app.onCleanup(() => item.removeEventListener("click", click));
      list.append(item);
    });
  };

  const doSearch = () => {
    const term = input.value.trim().toLowerCase();
    const rows = term ? stations.filter((s) => [s.name, s.address, ...s.details].join(" ").toLowerCase().includes(term)) : stations;
    renderList(rows);
  };
  const keyHandler = (event) => { if (event.key === "Enter") doSearch(); };
  button.addEventListener("click", doSearch);
  input.addEventListener("input", doSearch);
  input.addEventListener("keydown", keyHandler);
  app.onCleanup(() => {
    button.removeEventListener("click", doSearch);
    input.removeEventListener("input", doSearch);
    input.removeEventListener("keydown", keyHandler);
    if (highlightHandle) highlightHandle.remove();
    if (areaLayer.clear) areaLayer.clear();
    searchMount.replaceChildren();
    resultMount.replaceChildren();
  });

  renderList(stations.slice(0, 8));
  app.actions.register("select-station", async ({ graphic }) => solveForGraphic(graphic));
}