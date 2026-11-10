import {
  type CustomLayerInterface,
  type Map as MaplibreMap,
  MercatorCoordinate,
} from "maplibre-gl";
import {
  Box3,
  DirectionalLight,
  DynamicDrawUsage,
  type Group,
  HemisphereLight,
  InstancedMesh,
  type Material,
  MathUtils,
  Matrix4,
  type Mesh,
  MeshLambertMaterial,
  type MeshStandardMaterial,
  PerspectiveCamera,
  Scene,
  WebGLRenderer,
} from "three";
import { describeTrainFleet } from "@/lib/trainFleet";
import { loadTrainModel, type TrainModelVariant } from "@/lib/trainModels";
import { isWithinBounds, paddedVisibleBounds } from "../MapView/mapViewport";
import {
  createDestinationMaterial,
  type DestinationMaterial,
  findDisplayMesh,
} from "../SelectionInfoPanel/TrainModelPreview/destinationDisplay";
import { TRAIN_MODELS_LAYER_ID } from "../trainMapLayers";
import {
  type CarExtents,
  type ConsistCar,
  carOffsets,
  consistLayout,
  placeAlongTrain,
} from "./trainConsist";
import { type GetTrainMarkers, showsModel, type TrainMarker } from "./trainMarkers";

export const TRAIN_MODELS_ON_MAP_SETTINGS = {
  minZoom: 16,
  viewportPadding: 0.25,
  displayTextureWidth: 512,
  skyLight: 2.8,
  groundShade: 0x808080,
  sunLight: 1.4,
};

type CarModel = {
  id: string;
  scene: Group;
  extents: CarExtents;
};

type ConsistModels = {
  driving: CarModel;
  intermediate: CarModel;
};

type PlacedCar = {
  spec: ConsistCar;
  model: CarModel;
  // Each driving car's destination screen is its own mesh, since its text differs per train
  display: Mesh | null;
  displayOriginal: MeshStandardMaterial | null;
  displayKey: string | null;
};

// Every car of one model is drawn in a single call per part instead of one call per car
type InstancedPart = { mesh: InstancedMesh; local: Matrix4 };
type ModelBatch = {
  parts: InstancedPart[];
  capacity: number;
  count: number;
  display: { mesh: Mesh; local: Matrix4 } | null;
};

const MIN_BATCH_CAPACITY = 32;

type PlacedTrain = {
  instance: TrainMarker;
  layoutKey: string;
  cars: PlacedCar[];
  offsets: number[];
  heading: number;
};

export type TrainModelsLayer = {
  layer: CustomLayerInterface;
  isDrawn: (key: string) => boolean;
  destroy: () => void;
};

const MODEL_UP_TO_MAP_UP = new Matrix4().makeRotationX(Math.PI / 2);
// three.js only flips face winding for mirrored object matrices, not mirrored instance matrices
const MIRROR_Y = new Matrix4().makeScale(1, -1, 1);

const matteMaterials = new Map<Material, MeshLambertMaterial>();

const toMatte = (material: Material): MeshLambertMaterial => {
  let matte = matteMaterials.get(material);
  if (!matte) {
    const source = material as MeshStandardMaterial;
    matte = new MeshLambertMaterial({
      color: source.color,
      map: source.map,
      emissive: source.emissive,
      emissiveMap: source.emissiveMap,
      side: source.side,
    });
    matteMaterials.set(material, matte);
  }
  return matte;
};

const withMatteMaterials = (model: Group): Group => {
  const matte = model.clone(true);
  const display = findDisplayMesh(matte);
  matte.traverse((child) => {
    const mesh = child as Mesh;
    if (!mesh.isMesh || mesh === display) return;
    mesh.material = Array.isArray(mesh.material)
      ? mesh.material.map(toMatte)
      : toMatte(mesh.material);
  });
  return matte;
};

const carModelsByFile = new Map<string, CarModel>();

const loadCarModel = async (
  fleetCode: string | null,
  variant: TrainModelVariant
): Promise<CarModel> => {
  const { id, scene } = await loadTrainModel(fleetCode, variant);
  const key = `${id}|${variant}`;
  let model = carModelsByFile.get(key);
  if (!model) {
    const box = new Box3().setFromObject(scene);
    model = {
      id,
      scene: withMatteMaterials(scene),
      extents: { front: box.max.x, rear: -box.min.x },
    };
    carModelsByFile.set(key, model);
  }
  return model;
};

const consistModelsByFleet = new Map<string, Promise<ConsistModels>>();

const loadConsistModels = (fleetCode: string | null): Promise<ConsistModels> => {
  const key = fleetCode ?? "";
  const cached = consistModelsByFleet.get(key);
  if (cached) return cached;

  const models = Promise.all([
    loadCarModel(fleetCode, "driving"),
    loadCarModel(fleetCode, "intermediate"),
  ]).then(([driving, intermediate]) => ({ driving, intermediate }));
  consistModelsByFleet.set(key, models);
  models.catch(() => consistModelsByFleet.delete(key));
  return models;
};

const layoutKeyFor = (marker: TrainMarker) => `${marker.fleetCode ?? ""}|${marker.carCount ?? ""}`;

const createBatch = (model: CarModel, capacity: number): ModelBatch => {
  model.scene.updateMatrixWorld(true);
  const toModel = new Matrix4().copy(model.scene.matrixWorld).invert();
  const display = findDisplayMesh(model.scene);
  const parts: InstancedPart[] = [];
  let displayPart: ModelBatch["display"] = null;
  model.scene.traverse((child) => {
    const mesh = child as Mesh;
    if (!mesh.isMesh) return;
    const local = new Matrix4().multiplyMatrices(toModel, mesh.matrixWorld);
    if (mesh === display) {
      displayPart = { mesh, local };
      return;
    }
    const instanced = new InstancedMesh(mesh.geometry, mesh.material, capacity);
    instanced.instanceMatrix.setUsage(DynamicDrawUsage);
    instanced.frustumCulled = false;
    instanced.matrixAutoUpdate = false;
    instanced.matrix.copy(MIRROR_Y);
    instanced.matrixWorldNeedsUpdate = true;
    instanced.count = 0;
    parts.push({ mesh: instanced, local });
  });
  return { parts, capacity, count: 0, display: displayPart };
};

export const createTrainModelsLayer = (
  map: MaplibreMap,
  getMarkers: GetTrainMarkers
): TrainModelsLayer => {
  const scene = new Scene();
  const camera = new PerspectiveCamera();
  const sun = new DirectionalLight(0xffffff, TRAIN_MODELS_ON_MAP_SETTINGS.sunLight);
  sun.position.set(0.5, -0.6, 1);
  const sky = new HemisphereLight(
    0xffffff,
    TRAIN_MODELS_ON_MAP_SETTINGS.groundShade,
    TRAIN_MODELS_ON_MAP_SETTINGS.skyLight
  );
  sky.position.set(0, 0, 1);
  scene.add(sky, sun);

  const trains = new Map<string, PlacedTrain>();
  const displayMaterials = new Map<string, DestinationMaterial>();
  const batches = new Map<CarModel, ModelBatch>();
  const centreOffset = new Matrix4();
  const scale = new Matrix4();
  const heading = new Matrix4();
  const carMatrix = new Matrix4();
  const partMatrix = new Matrix4();

  const removeBatch = (batch: ModelBatch) => {
    for (const part of batch.parts) {
      scene.remove(part.mesh);
      part.mesh.dispose();
    }
  };

  const batchFor = (model: CarModel, needed = 0): ModelBatch => {
    let batch = batches.get(model);
    if (!batch || batch.capacity < needed) {
      if (batch) removeBatch(batch);
      let capacity = batch?.capacity ?? MIN_BATCH_CAPACITY;
      while (capacity < needed) capacity *= 2;
      batch = createBatch(model, capacity);
      for (const part of batch.parts) scene.add(part.mesh);
      batches.set(model, batch);
    }
    return batch;
  };
  let renderer: WebGLRenderer | null = null;
  let destroyed = false;

  const applyDestination = (train: PlacedTrain, car: PlacedCar) => {
    if (!car.display || !car.displayOriginal) return;
    const { primary, secondary } = train.instance.destination;
    const key = `${car.model.id}|${primary}|${secondary ?? ""}`;
    if (car.displayKey === key) return;

    let shared = displayMaterials.get(key);
    if (!shared) {
      shared = createDestinationMaterial(
        car.displayOriginal,
        TRAIN_MODELS_ON_MAP_SETTINGS.displayTextureWidth
      );
      shared.update(train.instance.destination);
      displayMaterials.set(key, shared);
    }
    car.display.material = shared.material;
    car.displayKey = key;
  };

  const removeCars = (train: PlacedTrain) => {
    for (const car of train.cars) if (car.display) scene.remove(car.display);
    train.cars = [];
    train.offsets = [];
  };

  const buildCars = (train: PlacedTrain, models: ConsistModels) => {
    const layout = consistLayout(train.instance.fleetCode, train.instance.carCount);
    const extents: CarExtents[] = [];
    train.cars = layout.map((spec): PlacedCar => {
      const model = spec.kind === "driving" ? models.driving : models.intermediate;
      extents.push(
        spec.reversed ? { front: model.extents.rear, rear: model.extents.front } : model.extents
      );

      const template = batchFor(model).display?.mesh;
      const display = template ? template.clone() : null;
      if (display) {
        display.matrixAutoUpdate = false;
        display.frustumCulled = false;
        scene.add(display);
      }
      const displayMaterial = display?.material;
      const car: PlacedCar = {
        spec,
        model,
        display,
        displayOriginal:
          displayMaterial && !Array.isArray(displayMaterial)
            ? (displayMaterial as MeshStandardMaterial)
            : null,
        displayKey: null,
      };
      applyDestination(train, car);
      return car;
    });
    train.offsets = carOffsets(extents);
  };

  const loadCars = (train: PlacedTrain) => {
    const { layoutKey } = train;
    loadConsistModels(train.instance.fleetCode)
      .then((models) => {
        if (destroyed || trains.get(train.instance.key) !== train) return;
        if (train.layoutKey !== layoutKey) return;
        buildCars(train, models);
        map.triggerRepaint();
      })
      .catch(() => {});
  };

  const seen = new Set<string>();
  const syncVisibleTrains = () => {
    const bounds = paddedVisibleBounds(map, TRAIN_MODELS_ON_MAP_SETTINGS.viewportPadding);
    seen.clear();
    for (const instance of getMarkers()) {
      if (!instance.isNearView || !showsModel(instance)) continue;
      if (describeTrainFleet(instance).kind === "cargo") continue;
      if (!isWithinBounds(bounds, instance.longitude, instance.latitude)) continue;
      seen.add(instance.key);

      const layoutKey = layoutKeyFor(instance);
      let train = trains.get(instance.key);
      if (!train) {
        train = { instance, layoutKey, cars: [], offsets: [], heading: instance.bearing ?? 0 };
        trains.set(instance.key, train);
        loadCars(train);
      }
      train.instance = instance;
      if (instance.bearing != null) train.heading = instance.bearing;
      if (train.layoutKey !== layoutKey) {
        train.layoutKey = layoutKey;
        removeCars(train);
        loadCars(train);
      }
      for (const car of train.cars) applyDestination(train, car);
    }

    for (const [key, train] of trains) {
      if (seen.has(key)) continue;
      removeCars(train);
      trains.delete(key);
    }
  };

  const placeTrains = (centre: MercatorCoordinate) => {
    const hasTerrain = map.getTerrain() != null;
    const needed = new Map<CarModel, number>();
    for (const train of trains.values()) {
      for (const car of train.cars) needed.set(car.model, (needed.get(car.model) ?? 0) + 1);
    }
    for (const [model, count] of needed) batchFor(model, count);
    for (const batch of batches.values()) batch.count = 0;

    for (const train of trains.values()) {
      const { instance } = train;
      const trainCentre = {
        longitude: instance.longitude,
        latitude: instance.latitude,
        bearing: train.heading,
      };
      train.cars.forEach((car, index) => {
        const placed = placeAlongTrain(trainCentre, instance.track, train.offsets[index]);
        const elevation = hasTerrain
          ? (map.queryTerrainElevation([placed.longitude, placed.latitude]) ?? 0)
          : 0;
        const position = MercatorCoordinate.fromLngLat(
          [placed.longitude, placed.latitude],
          elevation
        );
        const metres = position.meterInMercatorCoordinateUnits();
        const carHeading = placed.bearing + (car.spec.reversed ? 180 : 0);

        carMatrix
          .makeTranslation(position.x - centre.x, position.y - centre.y, position.z)
          .multiply(scale.makeScale(metres, -metres, metres))
          .multiply(MODEL_UP_TO_MAP_UP)
          .multiply(heading.makeRotationY(MathUtils.degToRad(90 - carHeading)));

        const batch = batchFor(car.model);
        const slot = batch.count++;
        for (const part of batch.parts) {
          partMatrix.multiplyMatrices(carMatrix, part.local).premultiply(MIRROR_Y);
          part.mesh.setMatrixAt(slot, partMatrix);
        }
        if (car.display && batch.display) {
          car.display.matrix.multiplyMatrices(carMatrix, batch.display.local);
          car.display.matrixWorldNeedsUpdate = true;
        }
      });
    }

    for (const batch of batches.values()) {
      for (const part of batch.parts) {
        part.mesh.count = batch.count;
        part.mesh.instanceMatrix.needsUpdate = true;
      }
    }
  };

  const layer: CustomLayerInterface = {
    id: TRAIN_MODELS_LAYER_ID,
    type: "custom",
    renderingMode: "3d",
    onAdd: (_map, gl) => {
      renderer = new WebGLRenderer({ canvas: map.getCanvas(), context: gl, antialias: true });
      renderer.autoClear = false;
    },
    render: (gl, options) => {
      if (!renderer) return;
      if (map.getZoom() < TRAIN_MODELS_ON_MAP_SETTINGS.minZoom) return;
      syncVisibleTrains();
      if (trains.size === 0) return;

      // Positions are kept relative to the map centre so float32 precision holds at high zoom
      const centre = MercatorCoordinate.fromLngLat(map.getCenter());
      camera.projectionMatrix
        .fromArray(options.defaultProjectionData.mainMatrix)
        .multiply(centreOffset.makeTranslation(centre.x, centre.y, 0));
      placeTrains(centre);

      renderer.resetState();
      renderer.setViewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
      renderer.render(scene, camera);
    },
    onRemove: () => {
      renderer?.dispose();
      renderer = null;
    },
  };

  const destroy = () => {
    destroyed = true;
    for (const train of trains.values()) removeCars(train);
    trains.clear();
    for (const batch of batches.values()) removeBatch(batch);
    batches.clear();
    for (const material of displayMaterials.values()) material.dispose();
    displayMaterials.clear();
  };

  const isDrawn = (key: string) =>
    renderer != null &&
    map.getZoom() >= TRAIN_MODELS_ON_MAP_SETTINGS.minZoom &&
    (trains.get(key)?.cars.length ?? 0) > 0;

  return { layer, isDrawn, destroy };
};
