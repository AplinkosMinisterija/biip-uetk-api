import { parseToJsonIfNeeded } from '../utils';

export type CoordinatesPoint = number[];
export type CoordinatesLine = CoordinatesPoint[];
export type CoordinatesPolygon = CoordinatesLine[];
export type CoordinatesMultiPolygon = CoordinatesPolygon[];
export type GeometryObject = {
  type: string;
  coordinates:
    | CoordinatesPoint
    | CoordinatesLine
    | CoordinatesPolygon
    | CoordinatesMultiPolygon;
};

export type GeomFeatureCollection = {
  type: string;
  features: GeomFeature[];
};

export type GeomFeature = {
  type: string;
  properties?: any;
  geometry: GeometryObject;
};

export const GeometryType = {
  POINT: 'Point',
  MULTI_POINT: 'MultiPoint',
  LINE: 'LineString',
  MULTI_LINE: 'MultiLineString',
  POLYGON: 'Polygon',
  MULTI_POLYGON: 'MultiPolygon',
};

export function geometryToGeom(geometry: GeometryObject) {
  return `ST_AsText(ST_GeomFromGeoJSON('${JSON.stringify(geometry)}'))`;
}

export function geometryFromText(text: string) {
  return `ST_GeomFromText(${text}, 3346)`;
}

export function geometriesToGeomCollection(geometries: GeometryObject[]) {
  const geometriesStr = JSON.stringify(geometries);

  return `ST_AsText(ST_Collect(ARRAY(
    SELECT ST_GeomFromGeoJSON(JSON_ARRAY_ELEMENTS('${geometriesStr}'))
  )))`;
}

export function geometryFilterFn(geom: GeomFeatureCollection) {
  geom = parseToJsonIfNeeded(geom) as GeomFeatureCollection;

  if (!geom?.features?.length) return;

  const geomItems = geom.features
    .map((i: any) => i.geometry)
    .filter((i: any) => !!i);

  if (!geomItems?.length) return;

  const collection = geometriesToGeomCollection(geomItems);

  return {
    $raw: `st_intersects(geom, ${geometryFromText(collection)})`,
  };
}
