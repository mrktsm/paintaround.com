export interface View { u: number; v: number; horizontalFov: number; width: number; height: number; projection?: string }
export function thumbnailViewFor(id: string): View;
export function loadingViewFor(id: string, center?: { u?: number; v?: number }): View;
export function projectRaw(data: Buffer, info: { width: number; height: number; channels?: number }, view: View): Buffer;
export function renderPanoramaThumbnail(input: string, output: string, id: string): Promise<View>;
export function renderPanoramaLoadingPreview(input: string, output: string, id: string, center?: { u?: number; v?: number }): Promise<View>;
