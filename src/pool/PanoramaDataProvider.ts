import {
  DataProviderBase, S2GeometryProvider,
  type CoreImagesContract, type ImagesContract, type ImageEnt,
  type SpatialImagesContract, type SequenceContract, type ClusterContract,
  type MeshContract, type ImageTilesRequestContract, type ImageTilesContract,
} from 'mapillary-js';
import { PANORAMA_BY_ID, hasCoordinates } from './catalog';
import { getPanoramaImageBuffer } from './panoramaImages';

/** Serve self-hosted spherical photos through the existing viewer/projection/brush APIs. */
export class PanoramaDataProvider extends DataProviderBase {
  constructor() { super(new S2GeometryProvider()); }

  private image(id: string): ImageEnt {
    const panorama = PANORAMA_BY_ID.get(id);
    if (!panorama) throw new Error(`Panorama is not in the current collection: ${id}`);
    // The SDK requires an internal reference for projection, even for ungeolocated photos.
    // These fallback references are never returned as map locations or nearby images.
    const geometry = hasCoordinates(panorama) ? { lat: panorama.latitude, lng: panorama.longitude } : { lat: 0, lng: 0 };
    return {
      id, geometry, sequence: { id },
      camera_type: 'spherical', camera_parameters: [],
      altitude: 0, captured_at: panorama.capturedAt || 0, compass_angle: 0,
      computed_rotation: [Math.PI / 2, 0, 0],
      exif_orientation: 1, width: panorama.width, height: panorama.height,
      cluster: { id, url: '' }, mesh: { id, url: '' }, owner: { id: panorama.provider },
      creator: { id: panorama.author, username: panorama.author },
      thumb: { id, url: panorama.imageUrl },
    };
  }

  getCoreImages(cellId: string): Promise<CoreImagesContract> {
    // Each panorama is an independent destination, not a navigable capture sequence.
    return Promise.resolve({ cell_id: cellId, images: [] });
  }
  getImages(ids: string[]): Promise<ImagesContract> {
    return Promise.resolve(ids.map(id => ({ node_id: id, node: this.image(id) })));
  }
  getSpatialImages(ids: string[]): Promise<SpatialImagesContract> { return this.getImages(ids); }
  getSequence(id: string): Promise<SequenceContract> {
    this.image(id);
    return Promise.resolve({ id, image_ids: [id] });
  }
  getCluster(id: string): Promise<ClusterContract> { return Promise.resolve({ id, points: {}, reference: { lat: 0, lng: 0, alt: 0 } }); }
  getMesh(): Promise<MeshContract> { return Promise.resolve({ vertices: [], faces: [] }); }
  getImageTiles(request: ImageTilesRequestContract): Promise<ImageTilesContract> { return Promise.resolve({ node_id: request.imageId, node: [] }); }
  setAccessToken(): void { /* Local images need no provider token. */ }

  getImageBuffer(url: string, abort?: Promise<void>): Promise<ArrayBuffer> {
    return getPanoramaImageBuffer(url, abort);
  }
}
