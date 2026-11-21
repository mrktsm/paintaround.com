export interface LineSegment {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
    width: number;
    r: number;
    g: number;
    b: number;
    alpha: number;
}

export interface Circle {
    x: number;
    y: number;
    radius: number;
    r: number;
    g: number;
    b: number;
    alpha: number;
}

export interface TexturedQuad {
    texture: WebGLTexture;
    srcX: number;
    srcY: number;
    srcW: number;
    srcH: number;
    dstX0: number;
    dstY0: number;
    dstX1: number;
    dstY1: number;
    dstX2: number;
    dstY2: number;
}

const LINE_VERTEX_SHADER = `#version 300 es
precision highp float;

in vec2 a_position;
in vec2 a_p0;
in vec2 a_p1;
in float a_width;
in vec4 a_color;

out vec2 v_localPos;
out float v_width;
out float v_halfLen;
out vec4 v_color;

uniform vec2 u_resolution;

void main() {
    vec2 dir = a_p1 - a_p0;
    float len = length(dir);
    vec2 unitDir = len > 0.0 ? dir / len : vec2(1.0, 0.0);
    vec2 unitNorm = vec2(-unitDir.y, unitDir.x);
    
    float halfWidth = a_width * 0.5;
    float halfLen = len * 0.5;
    
    vec2 center = (a_p0 + a_p1) * 0.5;
    vec2 localPos = a_position * vec2(halfLen + halfWidth, halfWidth);
    vec2 worldPos = center + localPos.x * unitDir + localPos.y * unitNorm;
    
    vec2 clipPos = (worldPos / u_resolution) * 2.0 - 1.0;
    clipPos.y = -clipPos.y;
    
    gl_Position = vec4(clipPos, 0.0, 1.0);
    v_localPos = localPos;
    v_width = a_width;
    v_halfLen = halfLen;
    v_color = a_color;
}
`;

const LINE_FRAGMENT_SHADER = `#version 300 es
precision highp float;

in vec2 v_localPos;
in float v_width;
in float v_halfLen;
in vec4 v_color;

out vec4 fragColor;

void main() {
    float halfWidth = v_width * 0.5;
    float x = abs(v_localPos.x);
    float y = abs(v_localPos.y);
    
    float dist;
    if (x <= v_halfLen) {
        dist = y;
    } else {
        float dx = x - v_halfLen;
        dist = sqrt(dx * dx + y * y);
    }
    
    float edge = halfWidth - 0.5;
    float alpha = 1.0 - smoothstep(edge, halfWidth, dist);
    
    if (alpha < 0.01) discard;
    fragColor = vec4(v_color.rgb, v_color.a * alpha);
}
`;

const CIRCLE_VERTEX_SHADER = `#version 300 es
precision highp float;

in vec2 a_position;
in vec2 a_center;
in float a_radius;
in vec4 a_color;

out vec2 v_localPos;
out float v_radius;
out vec4 v_color;

uniform vec2 u_resolution;

void main() {
    vec2 worldPos = a_center + a_position * a_radius;
    vec2 clipPos = (worldPos / u_resolution) * 2.0 - 1.0;
    clipPos.y = -clipPos.y;
    
    gl_Position = vec4(clipPos, 0.0, 1.0);
    v_localPos = a_position * a_radius;
    v_radius = a_radius;
    v_color = a_color;
}
`;

const CIRCLE_FRAGMENT_SHADER = `#version 300 es
precision highp float;

in vec2 v_localPos;
in float v_radius;
in vec4 v_color;

out vec4 fragColor;

void main() {
    float dist = length(v_localPos);
    float edge = v_radius - 0.5;
    float alpha = 1.0 - smoothstep(edge, v_radius, dist);
    
    if (alpha < 0.01) discard;
    fragColor = vec4(v_color.rgb, v_color.a * alpha);
}
`;

const TEXTURE_VERTEX_SHADER = `#version 300 es
precision highp float;

in vec2 a_position;
in vec2 a_texCoord;

out vec2 v_texCoord;

uniform vec2 u_resolution;

void main() {
    vec2 clipPos = (a_position / u_resolution) * 2.0 - 1.0;
    clipPos.y = -clipPos.y;
    gl_Position = vec4(clipPos, 0.0, 1.0);
    v_texCoord = a_texCoord;
}
`;

// GPU-projected texture vertex shader: basic coords → clip space on GPU
const GPU_PROJECTED_VERTEX_SHADER = `#version 300 es
precision highp float;

in vec2 a_basic;      // basic coords [0,1]x[0,1]
in vec2 a_texCoord;   // texture UV

out vec2 v_texCoord;

// Image geometry (from mapillary Transform)
uniform mat4 u_cameraToWorld;
uniform float u_focal;
uniform float u_imageWidth;
uniform float u_imageHeight;
uniform float u_ck1;
uniform float u_ck2;
uniform int u_orientation;
uniform int u_cameraType;   // 0=perspective, 1=spherical, 2=fisheye

// Camera matrices (from mapillary RenderCamera)
uniform mat4 u_projMatrix;
uniform mat4 u_viewMatrix;

const float PI = 3.14159265359;

void main() {
    // Step 1: Basic → SfM (apply EXIF orientation)
    vec2 rotated = a_basic;
    if (u_orientation == 3) {
        rotated = vec2(1.0 - a_basic.x, 1.0 - a_basic.y);
    } else if (u_orientation == 6) {
        rotated = vec2(a_basic.y, 1.0 - a_basic.x);
    } else if (u_orientation == 8) {
        rotated = vec2(1.0 - a_basic.y, a_basic.x);
    }

    float s = max(u_imageWidth, u_imageHeight);
    vec2 sfm = vec2(
        rotated.x * u_imageWidth / s - u_imageWidth / (s * 2.0),
        rotated.y * u_imageHeight / s - u_imageHeight / (s * 2.0)
    );

    // Step 2: SfM → bearing (3D unit direction)
    vec3 bearing;
    if (u_cameraType == 1) {
        // Spherical (equirectangular)
        float lng = sfm.x * 2.0 * PI;
        float lat = -sfm.y * 2.0 * PI;
        bearing = vec3(
            cos(lat) * sin(lng),
            -sin(lat),
            cos(lat) * cos(lng)
        );
    } else {
        // Perspective with radial distortion
        vec2 dxn = sfm / u_focal;
        float dr = length(dxn);
        float d = 1.0;
        for (int i = 0; i < 10; i++) {
            float r = dr / d;
            d = 1.0 + u_ck1 * r * r + u_ck2 * r * r * r * r;
        }
        bearing = normalize(vec3(dxn / d, 1.0));
    }

    // Step 3: Bearing → 3D world point
    vec4 worldPoint = u_cameraToWorld * vec4(200.0 * bearing, 1.0);

    // Step 4: 3D world → clip space
    gl_Position = u_projMatrix * u_viewMatrix * worldPoint;
    v_texCoord = a_texCoord;
}
`;

const TEXTURE_FRAGMENT_SHADER = `#version 300 es
precision highp float;

in vec2 v_texCoord;
out vec4 fragColor;

uniform sampler2D u_texture;
uniform float u_opacity;
uniform int u_highlight; // 0=normal, 1=white outline pass
uniform float u_hueShift; // 0.0 = no shift, otherwise 0..1 maps to 0..360 degrees

// RGB -> HSL conversion
vec3 rgb2hsl(vec3 c) {
    float maxC = max(c.r, max(c.g, c.b));
    float minC = min(c.r, min(c.g, c.b));
    float l = (maxC + minC) * 0.5;
    if (maxC == minC) return vec3(0.0, 0.0, l);
    float d = maxC - minC;
    float s = l > 0.5 ? d / (2.0 - maxC - minC) : d / (maxC + minC);
    float h;
    if (maxC == c.r) h = (c.g - c.b) / d + (c.g < c.b ? 6.0 : 0.0);
    else if (maxC == c.g) h = (c.b - c.r) / d + 2.0;
    else h = (c.r - c.g) / d + 4.0;
    h /= 6.0;
    return vec3(h, s, l);
}

float hue2rgb(float p, float q, float t) {
    if (t < 0.0) t += 1.0;
    if (t > 1.0) t -= 1.0;
    if (t < 1.0/6.0) return p + (q - p) * 6.0 * t;
    if (t < 1.0/2.0) return q;
    if (t < 2.0/3.0) return p + (q - p) * (2.0/3.0 - t) * 6.0;
    return p;
}

vec3 hsl2rgb(vec3 hsl) {
    if (hsl.y == 0.0) return vec3(hsl.z);
    float q = hsl.z < 0.5 ? hsl.z * (1.0 + hsl.y) : hsl.z + hsl.y - hsl.z * hsl.y;
    float p = 2.0 * hsl.z - q;
    return vec3(
        hue2rgb(p, q, hsl.x + 1.0/3.0),
        hue2rgb(p, q, hsl.x),
        hue2rgb(p, q, hsl.x - 1.0/3.0)
    );
}

void main() {
    vec4 color = texture(u_texture, v_texCoord);
    if (u_highlight == 1) {
        // Sample neighbors to create expanded white silhouette
        vec2 texelSize = 1.0 / vec2(textureSize(u_texture, 0));
        float spread = 4.0;
        vec2 ts = spread * texelSize;
        float a = color.a;
        a = max(a, texture(u_texture, v_texCoord + vec2(ts.x, 0.0)).a);
        a = max(a, texture(u_texture, v_texCoord - vec2(ts.x, 0.0)).a);
        a = max(a, texture(u_texture, v_texCoord + vec2(0.0, ts.y)).a);
        a = max(a, texture(u_texture, v_texCoord - vec2(0.0, ts.y)).a);
        a = max(a, texture(u_texture, v_texCoord + ts).a);
        a = max(a, texture(u_texture, v_texCoord - ts).a);
        a = max(a, texture(u_texture, v_texCoord + vec2(ts.x, -ts.y)).a);
        a = max(a, texture(u_texture, v_texCoord + vec2(-ts.x, ts.y)).a);
        // White with premultiplied alpha
        fragColor = vec4(a, a, a, a) * u_opacity;
    } else {
        // Apply hue replacement for rainbow textures
        if (u_hueShift > 0.0 && color.a > 0.01) {
            // Un-premultiply alpha for correct color manipulation
            vec3 rgb = color.rgb / color.a;
            vec3 hsl = rgb2hsl(rgb);
            hsl.x = u_hueShift; // Replace hue entirely so all rainbow strokes sync
            hsl.y = max(hsl.y, 0.85); // Ensure vivid saturation
            vec3 shifted = hsl2rgb(hsl);
            // Re-premultiply alpha
            fragColor = vec4(shifted * color.a, color.a) * u_opacity;
        } else {
            fragColor = color * u_opacity;
        }
    }
}
`;

/**
 * Deep (3D surface) stroke: for each panorama pixel covered, look up where it sits on the stroke's
 * unfolded surface sheet (geodesic unwrap texture), sample the tool's drawing there, and multiply in
 * the panorama's shadows/texture. Output is premultiplied alpha.
 */
const DEEP_FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp sampler2D;

in vec2 v_texCoord;          // region-local [0,1]
out vec4 fragColor;

uniform sampler2D u_dem;     // RGBA32F: decal x, decal y, placed, -
uniform sampler2D u_tool;    // tool drawing (decal space crop), premultiplied
uniform sampler2D u_surface; // RGB16F full panorama, LINEAR, wraps in u: paint multiplier (coloured shadows + texture)
uniform vec4 u_toolRect;     // crop rect in decal px: x0, y0, w, h
uniform vec2 u_regionSize;   // region size in panorama px
uniform vec2 u_regionOrigin; // region origin (col j0 unwrapped, row i0)
uniform vec2 u_panoSize;

vec3 paintToLinear(vec3 rgb) {
    return mix(pow((rgb + 0.055) / 1.055, vec3(2.4)), rgb / 12.92,
        lessThanEqual(rgb, vec3(0.04045)));
}

vec3 paintToSrgb(vec3 linearRgb) {
    return mix(1.055 * pow(linearRgb, vec3(1.0 / 2.4)) - 0.055, linearRgb * 12.92,
        lessThanEqual(linearRgb, vec3(0.0031308)));
}

void main() {
    vec2 p = v_texCoord * u_regionSize - 0.5;
    ivec2 b = ivec2(floor(p));
    vec2 f = p - vec2(b);
    ivec2 lim = ivec2(u_regionSize) - 1;
    vec2 acc = vec2(0.0);
    float wsum = 0.0;
    for (int dy = 0; dy < 2; dy++) {
        for (int dx = 0; dx < 2; dx++) {
            ivec2 q = clamp(b + ivec2(dx, dy), ivec2(0), lim);
            vec4 t = texelFetch(u_dem, q, 0);
            float w = (dx == 0 ? 1.0 - f.x : f.x) * (dy == 0 ? 1.0 - f.y : f.y);
            if (t.z > 0.5) { acc += t.xy * w; wsum += w; }
        }
    }
    if (wsum < 0.5) discard;
    vec2 decal = acc / wsum;
    vec2 tuv = (decal - u_toolRect.xy) / u_toolRect.zw;
    if (tuv.x < 0.0 || tuv.y < 0.0 || tuv.x > 1.0 || tuv.y > 1.0) discard;
    vec4 c = texture(u_tool, tuv);
    if (c.a < 0.003) discard;
    vec2 pp = v_texCoord * u_regionSize + u_regionOrigin;
    vec3 s = texture(u_surface, pp / u_panoSize).rgb; // bilinear, same as CPU sampleSurface
    vec3 rgb = c.rgb / c.a;
    vec3 lin = paintToLinear(rgb) * s;
    rgb = paintToSrgb(clamp(lin, 0.0, 1.0));
    float a = c.a * smoothstep(0.5, 1.0, wsum);
    fragColor = vec4(rgb * a, a);
}
`;

export interface DeepStrokeDraw {
    /** stable key for this stroke's unwrap texture (re-uploaded only where dirty) */
    key: object;
    dem: Float32Array;           // RGBA32F, regionW x regionH
    regionW: number;
    regionH: number;
    regionOrigin: [number, number]; // [j0 (unwrapped col), i0]
    dirty: { r0: number; c0: number; r1: number; c1: number } | null;
    basicCoords: Float32Array;   // triangles covering the reached area
    texCoords: Float32Array;     // region-local [0,1]
    tool: TexImageSource;        // decal-space crop of the tool's drawing
    toolVersion: number;         // bump when the tool drawing changed (re-upload only then)
    toolRect: [number, number, number, number];
    surface: Float32Array;       // full panorama paint multiplier, interleaved RGB
    panoW: number;
    panoH: number;
}

function createShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader | null {
    const shader = gl.createShader(type);
    if (!shader) return null;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        console.error('Shader compile error:', gl.getShaderInfoLog(shader));
        gl.deleteShader(shader);
        return null;
    }
    return shader;
}

function createProgram(gl: WebGL2RenderingContext, vertexShader: WebGLShader, fragmentShader: WebGLShader): WebGLProgram | null {
    const program = gl.createProgram();
    if (!program) return null;
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        console.error('Program link error:', gl.getProgramInfoLog(program));
        gl.deleteProgram(program);
        return null;
    }
    return program;
}

export interface GPUProjectionUniforms {
    cameraToWorld: Float32Array;     // 16 elements (mat4)
    projectionMatrix: Float32Array;  // 16 elements (mat4)
    viewMatrix: Float32Array;        // 16 elements (mat4)
    focal: number;
    imageWidth: number;
    imageHeight: number;
    ck1: number;
    ck2: number;
    orientation: number;
    cameraType: number;  // 0=perspective, 1=spherical, 2=fisheye
}

export class WebGLDrawingRenderer {
    private gl: WebGL2RenderingContext;
    private canvas: HTMLCanvasElement;

    private lineProgram: WebGLProgram | null = null;
    private circleProgram: WebGLProgram | null = null;
    private textureProgram: WebGLProgram | null = null;
    private gpuProjectedProgram: WebGLProgram | null = null;

    private lineVAO: WebGLVertexArrayObject | null = null;
    private circleVAO: WebGLVertexArrayObject | null = null;
    private textureVAO: WebGLVertexArrayObject | null = null;
    private gpuProjectedVAO: WebGLVertexArrayObject | null = null;

    private linePositionBuffer: WebGLBuffer | null = null;
    private lineInstanceBuffer: WebGLBuffer | null = null;
    private circlePositionBuffer: WebGLBuffer | null = null;
    private circleInstanceBuffer: WebGLBuffer | null = null;
    private texturePositionBuffer: WebGLBuffer | null = null;
    private textureTexCoordBuffer: WebGLBuffer | null = null;
    private gpuBasicBuffer: WebGLBuffer | null = null;
    private gpuTexCoordBuffer: WebGLBuffer | null = null;

    private lineResolutionLoc: WebGLUniformLocation | null = null;
    private circleResolutionLoc: WebGLUniformLocation | null = null;
    private textureResolutionLoc: WebGLUniformLocation | null = null;
    private textureSamplerLoc: WebGLUniformLocation | null = null;
    private textureOpacityLoc: WebGLUniformLocation | null = null;
    private textureHighlightLoc: WebGLUniformLocation | null = null;
    private textureHueShiftLoc: WebGLUniformLocation | null = null;

    // GPU projection uniform locations
    private gpuCameraToWorldLoc: WebGLUniformLocation | null = null;
    private gpuFocalLoc: WebGLUniformLocation | null = null;
    private gpuImageWidthLoc: WebGLUniformLocation | null = null;
    private gpuImageHeightLoc: WebGLUniformLocation | null = null;
    private gpuCk1Loc: WebGLUniformLocation | null = null;
    private gpuCk2Loc: WebGLUniformLocation | null = null;
    private gpuOrientationLoc: WebGLUniformLocation | null = null;
    private gpuCameraTypeLoc: WebGLUniformLocation | null = null;
    private gpuProjMatrixLoc: WebGLUniformLocation | null = null;
    private gpuViewMatrixLoc: WebGLUniformLocation | null = null;
    private gpuTextureLoc: WebGLUniformLocation | null = null;
    private gpuOpacityLoc: WebGLUniformLocation | null = null;
    private gpuHighlightLoc: WebGLUniformLocation | null = null;
    private gpuHueShiftLoc: WebGLUniformLocation | null = null;
    // deep (3D surface) strokes
    private deepProgram: WebGLProgram | null = null;
    private deepVAO: WebGLVertexArrayObject | null = null;
    private deepBasicBuffer: WebGLBuffer | null = null;
    private deepTexCoordBuffer: WebGLBuffer | null = null;
    private deepLocs: Record<string, WebGLUniformLocation | null> = {};
    private demTextures = new WeakMap<object, WebGLTexture>();
    private surfaceTextures = new WeakMap<Float32Array, WebGLTexture>();
    private toolTextures = new WeakMap<object, { tex: WebGLTexture; w: number; h: number; version: number }>();
    private lastProjection: GPUProjectionUniforms | null = null;

    private textureCache: Map<TexImageSource, WebGLTexture> = new Map();
    private _boundResize: (() => void) | null = null;
    private _contextLost: boolean = false;

    constructor(container: HTMLElement) {
        this.canvas = document.createElement('canvas');
        this.canvas.style.position = 'absolute';
        this.canvas.style.top = '0';
        this.canvas.style.left = '0';
        this.canvas.style.width = '100%';
        this.canvas.style.height = '100%';
        this.canvas.style.pointerEvents = 'none';
        this.canvas.style.zIndex = '10';
        container.appendChild(this.canvas);

        const gl = this.canvas.getContext('webgl2', {
            alpha: true,
            // Everything is blended premultiplied (ONE, ONE_MINUS_SRC_ALPHA), so the canvas must be
            // composited as premultiplied too — with false, the page multiplied colour by alpha a
            // second time and every semi-transparent pixel (pencil grain, soft edges) went grey.
            premultipliedAlpha: true,
            antialias: true,
        });

        if (!gl) {
            throw new Error('WebGL2 not supported');
        }

        this.gl = gl;
        this.resizeCanvas();
        this._boundResize = () => this.resizeCanvas();
        window.addEventListener('resize', this._boundResize);

        // Handle WebGL context loss (common on mobile under memory pressure)
        this.canvas.addEventListener('webglcontextlost', (e) => {
            e.preventDefault();
            console.warn('[WebGLDrawingRenderer] Context lost');
            this._contextLost = true;
        });
        this.canvas.addEventListener('webglcontextrestored', () => {
            console.warn('[WebGLDrawingRenderer] Context restored');
            this._contextLost = false;
            this.textureCache.clear();
            this.initShaders();
            this.initBuffers();
        });

        this.initShaders();
        this.initBuffers();
    }

    private resizeCanvas(): void {
        const rect = this.canvas.parentElement?.getBoundingClientRect();
        if (rect) {
            this.canvas.width = rect.width;
            this.canvas.height = rect.height;
            this.gl.viewport(0, 0, rect.width, rect.height);
        }
    }

    private initShaders(): void {
        const gl = this.gl;

        const lineVS = createShader(gl, gl.VERTEX_SHADER, LINE_VERTEX_SHADER);
        const lineFS = createShader(gl, gl.FRAGMENT_SHADER, LINE_FRAGMENT_SHADER);
        if (lineVS && lineFS) {
            this.lineProgram = createProgram(gl, lineVS, lineFS);
            if (this.lineProgram) {
                this.lineResolutionLoc = gl.getUniformLocation(this.lineProgram, 'u_resolution');
            }
        }

        const circleVS = createShader(gl, gl.VERTEX_SHADER, CIRCLE_VERTEX_SHADER);
        const circleFS = createShader(gl, gl.FRAGMENT_SHADER, CIRCLE_FRAGMENT_SHADER);
        if (circleVS && circleFS) {
            this.circleProgram = createProgram(gl, circleVS, circleFS);
            if (this.circleProgram) {
                this.circleResolutionLoc = gl.getUniformLocation(this.circleProgram, 'u_resolution');
            }
        }

        const textureVS = createShader(gl, gl.VERTEX_SHADER, TEXTURE_VERTEX_SHADER);
        const textureFS = createShader(gl, gl.FRAGMENT_SHADER, TEXTURE_FRAGMENT_SHADER);
        if (textureVS && textureFS) {
            this.textureProgram = createProgram(gl, textureVS, textureFS);
            if (this.textureProgram) {
                this.textureResolutionLoc = gl.getUniformLocation(this.textureProgram, 'u_resolution');
                this.textureSamplerLoc = gl.getUniformLocation(this.textureProgram, 'u_texture');
                this.textureOpacityLoc = gl.getUniformLocation(this.textureProgram, 'u_opacity');
                this.textureHighlightLoc = gl.getUniformLocation(this.textureProgram, 'u_highlight');
                this.textureHueShiftLoc = gl.getUniformLocation(this.textureProgram, 'u_hueShift');
            }
        }

        // GPU projected texture program (reuses texture fragment shader)
        const gpuVS = createShader(gl, gl.VERTEX_SHADER, GPU_PROJECTED_VERTEX_SHADER);
        const gpuFS = createShader(gl, gl.FRAGMENT_SHADER, TEXTURE_FRAGMENT_SHADER);
        if (gpuVS && gpuFS) {
            this.gpuProjectedProgram = createProgram(gl, gpuVS, gpuFS);
            if (this.gpuProjectedProgram) {
                this.gpuCameraToWorldLoc = gl.getUniformLocation(this.gpuProjectedProgram, 'u_cameraToWorld');
                this.gpuFocalLoc = gl.getUniformLocation(this.gpuProjectedProgram, 'u_focal');
                this.gpuImageWidthLoc = gl.getUniformLocation(this.gpuProjectedProgram, 'u_imageWidth');
                this.gpuImageHeightLoc = gl.getUniformLocation(this.gpuProjectedProgram, 'u_imageHeight');
                this.gpuCk1Loc = gl.getUniformLocation(this.gpuProjectedProgram, 'u_ck1');
                this.gpuCk2Loc = gl.getUniformLocation(this.gpuProjectedProgram, 'u_ck2');
                this.gpuOrientationLoc = gl.getUniformLocation(this.gpuProjectedProgram, 'u_orientation');
                this.gpuCameraTypeLoc = gl.getUniformLocation(this.gpuProjectedProgram, 'u_cameraType');
                this.gpuProjMatrixLoc = gl.getUniformLocation(this.gpuProjectedProgram, 'u_projMatrix');
                this.gpuViewMatrixLoc = gl.getUniformLocation(this.gpuProjectedProgram, 'u_viewMatrix');
                this.gpuTextureLoc = gl.getUniformLocation(this.gpuProjectedProgram, 'u_texture');
                this.gpuOpacityLoc = gl.getUniformLocation(this.gpuProjectedProgram, 'u_opacity');
                this.gpuHighlightLoc = gl.getUniformLocation(this.gpuProjectedProgram, 'u_highlight');
                this.gpuHueShiftLoc = gl.getUniformLocation(this.gpuProjectedProgram, 'u_hueShift');
            }
        }
    }

    private initBuffers(): void {
        const gl = this.gl;

        const quadPositions = new Float32Array([
            -1, -1,
            1, -1,
            -1, 1,
            1, 1,
        ]);

        this.lineVAO = gl.createVertexArray();
        gl.bindVertexArray(this.lineVAO);

        this.linePositionBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.linePositionBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, quadPositions, gl.STATIC_DRAW);

        const posLoc = gl.getAttribLocation(this.lineProgram!, 'a_position');
        gl.enableVertexAttribArray(posLoc);
        gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

        this.lineInstanceBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.lineInstanceBuffer);

        const p0Loc = gl.getAttribLocation(this.lineProgram!, 'a_p0');
        const p1Loc = gl.getAttribLocation(this.lineProgram!, 'a_p1');
        const widthLoc = gl.getAttribLocation(this.lineProgram!, 'a_width');
        const colorLoc = gl.getAttribLocation(this.lineProgram!, 'a_color');

        const stride = 9 * 4;
        gl.enableVertexAttribArray(p0Loc);
        gl.vertexAttribPointer(p0Loc, 2, gl.FLOAT, false, stride, 0);
        gl.vertexAttribDivisor(p0Loc, 1);

        gl.enableVertexAttribArray(p1Loc);
        gl.vertexAttribPointer(p1Loc, 2, gl.FLOAT, false, stride, 8);
        gl.vertexAttribDivisor(p1Loc, 1);

        gl.enableVertexAttribArray(widthLoc);
        gl.vertexAttribPointer(widthLoc, 1, gl.FLOAT, false, stride, 16);
        gl.vertexAttribDivisor(widthLoc, 1);

        gl.enableVertexAttribArray(colorLoc);
        gl.vertexAttribPointer(colorLoc, 4, gl.FLOAT, false, stride, 20);
        gl.vertexAttribDivisor(colorLoc, 1);

        gl.bindVertexArray(null);

        this.circleVAO = gl.createVertexArray();
        gl.bindVertexArray(this.circleVAO);

        this.circlePositionBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.circlePositionBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, quadPositions, gl.STATIC_DRAW);

        const circlePosLoc = gl.getAttribLocation(this.circleProgram!, 'a_position');
        gl.enableVertexAttribArray(circlePosLoc);
        gl.vertexAttribPointer(circlePosLoc, 2, gl.FLOAT, false, 0, 0);

        this.circleInstanceBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.circleInstanceBuffer);

        const centerLoc = gl.getAttribLocation(this.circleProgram!, 'a_center');
        const radiusLoc = gl.getAttribLocation(this.circleProgram!, 'a_radius');
        const circleColorLoc = gl.getAttribLocation(this.circleProgram!, 'a_color');

        const circleStride = 7 * 4;
        gl.enableVertexAttribArray(centerLoc);
        gl.vertexAttribPointer(centerLoc, 2, gl.FLOAT, false, circleStride, 0);
        gl.vertexAttribDivisor(centerLoc, 1);

        gl.enableVertexAttribArray(radiusLoc);
        gl.vertexAttribPointer(radiusLoc, 1, gl.FLOAT, false, circleStride, 8);
        gl.vertexAttribDivisor(radiusLoc, 1);

        gl.enableVertexAttribArray(circleColorLoc);
        gl.vertexAttribPointer(circleColorLoc, 4, gl.FLOAT, false, circleStride, 12);
        gl.vertexAttribDivisor(circleColorLoc, 1);

        gl.bindVertexArray(null);

        this.textureVAO = gl.createVertexArray();
        gl.bindVertexArray(this.textureVAO);

        this.texturePositionBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.texturePositionBuffer);
        const texPosLoc = gl.getAttribLocation(this.textureProgram!, 'a_position');
        gl.enableVertexAttribArray(texPosLoc);
        gl.vertexAttribPointer(texPosLoc, 2, gl.FLOAT, false, 0, 0);

        this.textureTexCoordBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.textureTexCoordBuffer);
        const texCoordLoc = gl.getAttribLocation(this.textureProgram!, 'a_texCoord');
        gl.enableVertexAttribArray(texCoordLoc);
        gl.vertexAttribPointer(texCoordLoc, 2, gl.FLOAT, false, 0, 0);

        gl.bindVertexArray(null);

        // GPU projected texture VAO
        if (this.gpuProjectedProgram) {
            this.gpuProjectedVAO = gl.createVertexArray();
            gl.bindVertexArray(this.gpuProjectedVAO);

            this.gpuBasicBuffer = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, this.gpuBasicBuffer);
            const basicLoc = gl.getAttribLocation(this.gpuProjectedProgram, 'a_basic');
            gl.enableVertexAttribArray(basicLoc);
            gl.vertexAttribPointer(basicLoc, 2, gl.FLOAT, false, 0, 0);

            this.gpuTexCoordBuffer = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, this.gpuTexCoordBuffer);
            const gpuTexCoordLoc = gl.getAttribLocation(this.gpuProjectedProgram, 'a_texCoord');
            gl.enableVertexAttribArray(gpuTexCoordLoc);
            gl.vertexAttribPointer(gpuTexCoordLoc, 2, gl.FLOAT, false, 0, 0);

            gl.bindVertexArray(null);
        }

        // Deep stroke program: same projection vertex shader, deep fragment shader
        const deepVS = createShader(gl, gl.VERTEX_SHADER, GPU_PROJECTED_VERTEX_SHADER);
        const deepFS = createShader(gl, gl.FRAGMENT_SHADER, DEEP_FRAGMENT_SHADER);
        if (deepVS && deepFS) {
            this.deepProgram = createProgram(gl, deepVS, deepFS);
            if (this.deepProgram) {
                const prog = this.deepProgram;
                for (const name of ['u_cameraToWorld', 'u_focal', 'u_imageWidth', 'u_imageHeight', 'u_ck1', 'u_ck2', 'u_orientation', 'u_cameraType', 'u_projMatrix', 'u_viewMatrix', 'u_dem', 'u_tool', 'u_surface', 'u_toolRect', 'u_regionSize', 'u_regionOrigin', 'u_panoSize']) {
                    this.deepLocs[name] = gl.getUniformLocation(prog, name);
                }
                this.deepVAO = gl.createVertexArray();
                gl.bindVertexArray(this.deepVAO);
                this.deepBasicBuffer = gl.createBuffer();
                gl.bindBuffer(gl.ARRAY_BUFFER, this.deepBasicBuffer);
                const bl = gl.getAttribLocation(prog, 'a_basic');
                gl.enableVertexAttribArray(bl);
                gl.vertexAttribPointer(bl, 2, gl.FLOAT, false, 0, 0);
                this.deepTexCoordBuffer = gl.createBuffer();
                gl.bindBuffer(gl.ARRAY_BUFFER, this.deepTexCoordBuffer);
                const tl = gl.getAttribLocation(prog, 'a_texCoord');
                gl.enableVertexAttribArray(tl);
                gl.vertexAttribPointer(tl, 2, gl.FLOAT, false, 0, 0);
                gl.bindVertexArray(null);
            }
        }
    }

    isContextLost(): boolean {
        return this._contextLost;
    }

    clear(): void {
        if (this._contextLost) return;
        const gl = this.gl;
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
    }

    drawLines(segments: LineSegment[]): void {
        if (segments.length === 0 || !this.lineProgram) return;

        const gl = this.gl;

        const instanceData = new Float32Array(segments.length * 9);
        for (let i = 0; i < segments.length; i++) {
            const s = segments[i];
            const offset = i * 9;
            instanceData[offset] = s.x0;
            instanceData[offset + 1] = s.y0;
            instanceData[offset + 2] = s.x1;
            instanceData[offset + 3] = s.y1;
            instanceData[offset + 4] = s.width;
            instanceData[offset + 5] = s.r;
            instanceData[offset + 6] = s.g;
            instanceData[offset + 7] = s.b;
            instanceData[offset + 8] = s.alpha;
        }

        gl.useProgram(this.lineProgram);
        gl.bindVertexArray(this.lineVAO);

        gl.bindBuffer(gl.ARRAY_BUFFER, this.lineInstanceBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, instanceData, gl.DYNAMIC_DRAW);

        gl.uniform2f(this.lineResolutionLoc, this.canvas.width, this.canvas.height);

        gl.enable(gl.BLEND);
        gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA); // straight colour in, premultiplied out

        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, segments.length);

        gl.bindVertexArray(null);
    }

    drawCircles(circles: Circle[]): void {
        if (circles.length === 0 || !this.circleProgram) return;

        const gl = this.gl;

        const instanceData = new Float32Array(circles.length * 7);
        for (let i = 0; i < circles.length; i++) {
            const c = circles[i];
            const offset = i * 7;
            instanceData[offset] = c.x;
            instanceData[offset + 1] = c.y;
            instanceData[offset + 2] = c.radius;
            instanceData[offset + 3] = c.r;
            instanceData[offset + 4] = c.g;
            instanceData[offset + 5] = c.b;
            instanceData[offset + 6] = c.alpha;
        }

        gl.useProgram(this.circleProgram);
        gl.bindVertexArray(this.circleVAO);

        gl.bindBuffer(gl.ARRAY_BUFFER, this.circleInstanceBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, instanceData, gl.DYNAMIC_DRAW);

        gl.uniform2f(this.circleResolutionLoc, this.canvas.width, this.canvas.height);

        gl.enable(gl.BLEND);
        gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA); // straight colour in, premultiplied out

        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, circles.length);

        gl.bindVertexArray(null);
    }

    getOrCreateTexture(source: TexImageSource): WebGLTexture | null {
        if (this.textureCache.has(source)) {
            return this.textureCache.get(source)!;
        }

        const gl = this.gl;
        const texture = gl.createTexture();
        if (!texture) return null;

        gl.bindTexture(gl.TEXTURE_2D, texture);
        // Canvas 2D produces premultiplied alpha — tell WebGL so blending works correctly.
        // For HTMLImageElement sources the flag is harmless (images aren't premultiplied,
        // but the GPU will handle it — minor alpha-edge difference is invisible for strokes).
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

        this.textureCache.set(source, texture);
        return texture;
    }

    drawTexturedTriangle(
        source: TexImageSource,
        sx0: number, sy0: number,
        sx1: number, sy1: number,
        sx2: number, sy2: number,
        dx0: number, dy0: number,
        dx1: number, dy1: number,
        dx2: number, dy2: number
    ): void {
        if (!this.textureProgram) return;

        const gl = this.gl;
        const texture = this.getOrCreateTexture(source);
        if (!texture) return;

        const positions = new Float32Array([dx0, dy0, dx1, dy1, dx2, dy2]);
        const texWidth = (source as HTMLCanvasElement).width || (source as HTMLImageElement).naturalWidth;
        const texHeight = (source as HTMLCanvasElement).height || (source as HTMLImageElement).naturalHeight;
        const texCoords = new Float32Array([
            sx0 / texWidth, sy0 / texHeight,
            sx1 / texWidth, sy1 / texHeight,
            sx2 / texWidth, sy2 / texHeight,
        ]);

        gl.useProgram(this.textureProgram);
        gl.bindVertexArray(this.textureVAO);

        gl.bindBuffer(gl.ARRAY_BUFFER, this.texturePositionBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, positions, gl.DYNAMIC_DRAW);

        gl.bindBuffer(gl.ARRAY_BUFFER, this.textureTexCoordBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, texCoords, gl.DYNAMIC_DRAW);

        gl.uniform2f(this.textureResolutionLoc, this.canvas.width, this.canvas.height);

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.uniform1i(this.textureSamplerLoc, 0);

        gl.enable(gl.BLEND);
        // Premultiplied alpha blending — matches canvas 2D's premultiplied output
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

        gl.drawArrays(gl.TRIANGLES, 0, 3);

        gl.bindVertexArray(null);
    }

    /**
     * Batch-draw all triangles for a single source canvas in one GL call.
     * Dramatically reduces draw calls (e.g. 288 → 1 per texture).
     */
    drawTexturedTriangleBatch(
        source: TexImageSource,
        triangles: Float32Array,  // [dx0,dy0, dx1,dy1, dx2,dy2, ...] — 6 floats per tri
        texCoords: Float32Array,  // [sx0,sy0, sx1,sy1, sx2,sy2, ...] — 6 floats per tri (already normalized)
        opacity: number = 1,
        highlight: boolean = false,
        hueShift: number = 0
    ): void {
        if (!this.textureProgram || triangles.length === 0) return;

        const gl = this.gl;
        const texture = this.getOrCreateTexture(source);
        if (!texture) return;

        gl.useProgram(this.textureProgram);
        gl.bindVertexArray(this.textureVAO);

        gl.bindBuffer(gl.ARRAY_BUFFER, this.texturePositionBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, triangles, gl.DYNAMIC_DRAW);

        gl.bindBuffer(gl.ARRAY_BUFFER, this.textureTexCoordBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, texCoords, gl.DYNAMIC_DRAW);

        gl.uniform2f(this.textureResolutionLoc, this.canvas.width, this.canvas.height);

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.uniform1i(this.textureSamplerLoc, 0);
        gl.uniform1f(this.textureOpacityLoc, opacity);
        gl.uniform1i(this.textureHighlightLoc, highlight ? 1 : 0);
        gl.uniform1f(this.textureHueShiftLoc, hueShift);

        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

        const vertexCount = triangles.length / 2; // 2 floats per vertex
        gl.drawArrays(gl.TRIANGLES, 0, vertexCount);

        gl.bindVertexArray(null);
    }

    /**
     * Check if GPU projection is available (shader compiled successfully).
     */
    hasGPUProjection(): boolean {
        return this.gpuProjectedProgram !== null && this.gpuProjectedVAO !== null;
    }

    /**
     * Set projection uniforms once per frame. Call before drawGPUProjectedBatch().
     */
    setGPUProjectionUniforms(uniforms: GPUProjectionUniforms): void {
        this.lastProjection = uniforms;
        if (!this.gpuProjectedProgram) return;
        const gl = this.gl;

        gl.useProgram(this.gpuProjectedProgram);
        gl.uniformMatrix4fv(this.gpuCameraToWorldLoc, false, uniforms.cameraToWorld);
        gl.uniformMatrix4fv(this.gpuProjMatrixLoc, false, uniforms.projectionMatrix);
        gl.uniformMatrix4fv(this.gpuViewMatrixLoc, false, uniforms.viewMatrix);
        gl.uniform1f(this.gpuFocalLoc, uniforms.focal);
        gl.uniform1f(this.gpuImageWidthLoc, uniforms.imageWidth);
        gl.uniform1f(this.gpuImageHeightLoc, uniforms.imageHeight);
        gl.uniform1f(this.gpuCk1Loc, uniforms.ck1);
        gl.uniform1f(this.gpuCk2Loc, uniforms.ck2);
        gl.uniform1i(this.gpuOrientationLoc, uniforms.orientation);
        gl.uniform1i(this.gpuCameraTypeLoc, uniforms.cameraType);
    }

    /**
     * Draw a textured triangle batch using GPU projection from basic coords.
     * Uniforms must be set via setGPUProjectionUniforms() first.
     */
    drawGPUProjectedBatch(
        source: TexImageSource,
        basicCoords: Float32Array,   // [bx0,by0, bx1,by1, bx2,by2, ...] — 6 floats per tri
        texCoords: Float32Array,     // [u0,v0, u1,v1, u2,v2, ...] — 6 floats per tri
        opacity: number = 1,
        highlight: boolean = false,
        hueShift: number = 0
    ): void {
        if (!this.gpuProjectedProgram || basicCoords.length === 0) return;

        const gl = this.gl;
        const texture = this.getOrCreateTexture(source);
        if (!texture) return;

        gl.useProgram(this.gpuProjectedProgram);
        gl.bindVertexArray(this.gpuProjectedVAO);

        gl.bindBuffer(gl.ARRAY_BUFFER, this.gpuBasicBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, basicCoords, gl.DYNAMIC_DRAW);

        gl.bindBuffer(gl.ARRAY_BUFFER, this.gpuTexCoordBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, texCoords, gl.DYNAMIC_DRAW);

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.uniform1i(this.gpuTextureLoc, 0);
        gl.uniform1f(this.gpuOpacityLoc, opacity);
        gl.uniform1i(this.gpuHighlightLoc, highlight ? 1 : 0);
        gl.uniform1f(this.gpuHueShiftLoc, hueShift);

        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

        const vertexCount = basicCoords.length / 2;
        gl.drawArrays(gl.TRIANGLES, 0, vertexCount);

        gl.bindVertexArray(null);
    }

    hasDeepStrokes(): boolean {
        return this.deepProgram !== null && this.deepVAO !== null;
    }

    /** Draw a live 3D-surface stroke (projection uniforms must have been set this frame). */
    drawDeepStroke(d: DeepStrokeDraw): void {
        const gl = this.gl;
        const prog = this.deepProgram, u = this.lastProjection;
        if (!prog || !this.deepVAO || !u || d.basicCoords.length === 0) return;
        const L = this.deepLocs;

        // unwrap texture: create once, then upload only the changed rectangle
        let dem = this.demTextures.get(d.key);
        gl.activeTexture(gl.TEXTURE1);
        if (!dem) {
            dem = gl.createTexture()!;
            gl.bindTexture(gl.TEXTURE_2D, dem);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, d.regionW, d.regionH, 0, gl.RGBA, gl.FLOAT, d.dem);
            this.demTextures.set(d.key, dem);
        } else {
            gl.bindTexture(gl.TEXTURE_2D, dem);
            if (d.dirty) {
                const { r0, c0, r1, c1 } = d.dirty;
                gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
                gl.pixelStorei(gl.UNPACK_ROW_LENGTH, d.regionW);
                gl.texSubImage2D(gl.TEXTURE_2D, 0, c0, r0, c1 - c0 + 1, r1 - r0 + 1, gl.RGBA, gl.FLOAT, d.dem, (r0 * d.regionW + c0) * 4);
                gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
            }
        }

        // surface map: once per panorama
        let surf = this.surfaceTextures.get(d.surface);
        gl.activeTexture(gl.TEXTURE2);
        if (!surf) {
            surf = gl.createTexture()!;
            gl.bindTexture(gl.TEXTURE_2D, surf);
            // RGB16F is filterable in core WebGL2 (32F needs an extension); values stay below 2.5.
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB16F, d.panoW, d.panoH, 0, gl.RGB, gl.FLOAT, d.surface);
            this.surfaceTextures.set(d.surface, surf);
        } else {
            gl.bindTexture(gl.TEXTURE_2D, surf);
        }

        // tool drawing: one texture per stroke, updated in place only when it changed
        gl.activeTexture(gl.TEXTURE0);
        let tt = this.toolTextures.get(d.key);
        const src = d.tool as HTMLCanvasElement;
        if (!tt) {
            const tex = gl.createTexture()!;
            gl.bindTexture(gl.TEXTURE_2D, tex);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            tt = { tex, w: 0, h: 0, version: -1 };
            this.toolTextures.set(d.key, tt);
        }
        gl.bindTexture(gl.TEXTURE_2D, tt.tex);
        if (tt.version !== d.toolVersion) {
            gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
            if (tt.w === src.width && tt.h === src.height) {
                gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, src);
            } else {
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
                tt.w = src.width;
                tt.h = src.height;
            }
            gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
            tt.version = d.toolVersion;
        }

        gl.useProgram(prog);
        gl.uniformMatrix4fv(L.u_cameraToWorld, false, u.cameraToWorld);
        gl.uniformMatrix4fv(L.u_projMatrix, false, u.projectionMatrix);
        gl.uniformMatrix4fv(L.u_viewMatrix, false, u.viewMatrix);
        gl.uniform1f(L.u_focal, u.focal);
        gl.uniform1f(L.u_imageWidth, u.imageWidth);
        gl.uniform1f(L.u_imageHeight, u.imageHeight);
        gl.uniform1f(L.u_ck1, u.ck1);
        gl.uniform1f(L.u_ck2, u.ck2);
        gl.uniform1i(L.u_orientation, u.orientation);
        gl.uniform1i(L.u_cameraType, u.cameraType);
        gl.uniform1i(L.u_tool, 0);
        gl.uniform1i(L.u_dem, 1);
        gl.uniform1i(L.u_surface, 2);
        gl.uniform4f(L.u_toolRect, d.toolRect[0], d.toolRect[1], d.toolRect[2], d.toolRect[3]);
        gl.uniform2f(L.u_regionSize, d.regionW, d.regionH);
        gl.uniform2f(L.u_regionOrigin, d.regionOrigin[0], d.regionOrigin[1]);
        gl.uniform2f(L.u_panoSize, d.panoW, d.panoH);

        gl.bindVertexArray(this.deepVAO);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.deepBasicBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, d.basicCoords, gl.DYNAMIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.deepTexCoordBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, d.texCoords, gl.DYNAMIC_DRAW);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        gl.drawArrays(gl.TRIANGLES, 0, d.basicCoords.length / 2);
        gl.bindVertexArray(null);
        gl.activeTexture(gl.TEXTURE0);
    }

    /** Free a deep stroke's unwrap texture. */
    releaseDeepStroke(key: object): void {
        const t = this.demTextures.get(key);
        if (t) {
            this.gl.deleteTexture(t);
            this.demTextures.delete(key);
        }
        const tt = this.toolTextures.get(key);
        if (tt) {
            this.gl.deleteTexture(tt.tex);
            this.toolTextures.delete(key);
        }
    }

    invalidateTexture(source: TexImageSource): void {
        const texture = this.textureCache.get(source);
        if (texture) {
            this.gl.deleteTexture(texture);
            this.textureCache.delete(source);
        }
    }

    clearTextureCache(): void {
        for (const texture of this.textureCache.values()) {
            this.gl.deleteTexture(texture);
        }
        this.textureCache.clear();
    }

    getCanvas(): HTMLCanvasElement {
        return this.canvas;
    }

    dispose(): void {
        this.clearTextureCache();
        if (this._boundResize) {
            window.removeEventListener('resize', this._boundResize);
        }
        this.canvas.remove();
    }
}

export function parseColor(color: string): { r: number; g: number; b: number } {
    if (color.startsWith('#')) {
        const hex = color.slice(1);
        if (hex.length === 3) {
            return {
                r: parseInt(hex[0] + hex[0], 16) / 255,
                g: parseInt(hex[1] + hex[1], 16) / 255,
                b: parseInt(hex[2] + hex[2], 16) / 255,
            };
        } else if (hex.length === 6) {
            return {
                r: parseInt(hex.slice(0, 2), 16) / 255,
                g: parseInt(hex.slice(2, 4), 16) / 255,
                b: parseInt(hex.slice(4, 6), 16) / 255,
            };
        }
    }

    if (color.startsWith('rgb')) {
        const match = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
        if (match) {
            return {
                r: parseInt(match[1]) / 255,
                g: parseInt(match[2]) / 255,
                b: parseInt(match[3]) / 255,
            };
        }
    }

    return { r: 0, g: 0, b: 0 };
}
