import * as THREE from 'three';
import type { ICustomRenderer, LngLatAlt } from 'mapillary-js';
import { RenderPass, Viewer } from 'mapillary-js';

interface Stroke {
    points: THREE.Vector3[];
    color: string;
    lineWidth: number;
    line?: THREE.Line;
}

export class DrawingRenderer implements ICustomRenderer {
    id: string = 'drawing-renderer';
    renderPass: RenderPass = RenderPass.Opaque;

    private viewer: Viewer | null = null;
    private scene: THREE.Scene;
    private camera: THREE.PerspectiveCamera;
    private strokeGroup: THREE.Group;
    private strokes: Stroke[] = [];
    private currentStroke: Stroke | null = null;
    private renderer: THREE.WebGLRenderer | null = null;

    constructor() {
        this.scene = new THREE.Scene();
        this.camera = new THREE.PerspectiveCamera();
        this.strokeGroup = new THREE.Group();
        this.strokeGroup.matrixAutoUpdate = false;
        this.scene.add(this.strokeGroup);

        // Add a test sphere to verify Three.js is rendering
        const testGeometry = new THREE.SphereGeometry(0.5, 16, 16);
        const testMaterial = new THREE.MeshBasicMaterial({ color: 0xff0000, depthTest: false });
        const testSphere = new THREE.Mesh(testGeometry, testMaterial);
        testSphere.position.set(0, 0, -2); // In front of camera
        this.scene.add(testSphere);
        console.log('Test sphere added to scene');
    }

    onAdd(viewer: Viewer, _reference: LngLatAlt, context: WebGLRenderingContext): void {
        this.viewer = viewer;
        this.renderer = new THREE.WebGLRenderer({
            canvas: context.canvas,
            context: context,
        });
        this.renderer.autoClear = false;
    }

    onReference(_viewer: Viewer, _reference: LngLatAlt): void { }

    onRemove(_viewer: Viewer, _context: WebGLRenderingContext): void {
        this.strokes.forEach(stroke => {
            if (stroke.line) {
                stroke.line.geometry.dispose();
                (stroke.line.material as THREE.Material).dispose();
            }
        });
        this.strokes = [];
        this.strokeGroup.clear();
        this.viewer = null;
        this.renderer = null;
    }

    render(
        _context: WebGLRenderingContext,
        viewMatrix: number[],
        projectionMatrix: number[]
    ): void {
        if (!this.renderer) {
            console.log('render: no renderer');
            return;
        }

        console.log('render called, strokes:', this.strokes.length, 'strokeGroup children:', this.strokeGroup.children.length);

        const viewMatrixThree = new THREE.Matrix4().fromArray(viewMatrix).transpose();
        const projectionMatrixThree = new THREE.Matrix4().fromArray(projectionMatrix).transpose();

        this.camera.matrixWorldInverse.copy(viewMatrixThree);
        this.camera.projectionMatrix.copy(projectionMatrixThree);

        this.renderer.resetState();
        this.renderer.render(this.scene, this.camera);
    }

    async startStroke(pixelX: number, pixelY: number, color: string, lineWidth: number): Promise<void> {
        console.log('DrawingRenderer.startStroke called', pixelX, pixelY);
        const point = await this.pixelToWorld(pixelX, pixelY);
        console.log('pixelToWorld result:', point);
        if (!point) return;

        this.currentStroke = {
            points: [point],
            color,
            lineWidth,
        };
        this.strokes.push(this.currentStroke);
        console.log('stroke added, total strokes:', this.strokes.length);
        this.updateCurrentStrokeLine();
    }

    async addPoint(pixelX: number, pixelY: number): Promise<void> {
        if (!this.currentStroke) return;

        const point = await this.pixelToWorld(pixelX, pixelY);
        if (!point) return;

        const lastPoint = this.currentStroke.points[this.currentStroke.points.length - 1];
        const distance = point.distanceTo(lastPoint);
        if (distance < 0.01) return;

        this.currentStroke.points.push(point);
        console.log('addPoint: total points in stroke:', this.currentStroke.points.length);
        this.updateCurrentStrokeLine();
    }

    endStroke(): void {
        this.currentStroke = null;
    }

    async eraseAt(pixelX: number, pixelY: number, radius: number = 0.5): Promise<boolean> {
        const point = await this.pixelToWorld(pixelX, pixelY);
        if (!point) return false;

        let erased = false;
        for (let i = this.strokes.length - 1; i >= 0; i--) {
            const stroke = this.strokes[i];
            for (const strokePoint of stroke.points) {
                if (strokePoint.distanceTo(point) < radius) {
                    if (stroke.line) {
                        this.strokeGroup.remove(stroke.line);
                        stroke.line.geometry.dispose();
                        (stroke.line.material as THREE.Material).dispose();
                    }
                    this.strokes.splice(i, 1);
                    erased = true;
                    break;
                }
            }
        }
        return erased;
    }

    clearAll(): void {
        this.strokes.forEach(stroke => {
            if (stroke.line) {
                this.strokeGroup.remove(stroke.line);
                stroke.line.geometry.dispose();
                (stroke.line.material as THREE.Material).dispose();
            }
        });
        this.strokes = [];
        this.viewer?.triggerRerender();
    }

    private async pixelToWorld(pixelX: number, pixelY: number): Promise<THREE.Vector3 | null> {
        if (!this.viewer) {
            console.log('pixelToWorld: no viewer');
            return null;
        }

        try {
            console.log('calling unprojectToBasic with', [pixelX, pixelY]);
            const basicPoint = await this.viewer.unprojectToBasic([pixelX, pixelY]);
            console.log('unprojectToBasic result:', basicPoint);
            if (!basicPoint) return null;

            const direction = this.basicToDirection(basicPoint[0], basicPoint[1]);
            const distance = 5;
            return direction.multiplyScalar(distance);
        } catch {
            return null;
        }
    }

    private basicToDirection(basicX: number, basicY: number): THREE.Vector3 {
        const theta = basicX * 2 * Math.PI;
        const phi = (basicY - 0.5) * Math.PI;

        const x = Math.cos(phi) * Math.sin(theta);
        const y = -Math.sin(phi);
        const z = -Math.cos(phi) * Math.cos(theta);

        return new THREE.Vector3(x, y, z);
    }

    private updateCurrentStrokeLine(): void {
        if (!this.currentStroke || this.currentStroke.points.length < 2) {
            console.log('updateCurrentStrokeLine: not enough points', this.currentStroke?.points.length);
            return;
        }

        console.log('updateCurrentStrokeLine: creating line with', this.currentStroke.points.length, 'points');

        if (this.currentStroke.line) {
            this.strokeGroup.remove(this.currentStroke.line);
            this.currentStroke.line.geometry.dispose();
        }

        const geometry = new THREE.BufferGeometry().setFromPoints(this.currentStroke.points);
        const material = new THREE.LineBasicMaterial({
            color: this.currentStroke.color,
            linewidth: this.currentStroke.lineWidth,
            depthTest: false,
            depthWrite: false,
        });

        this.currentStroke.line = new THREE.Line(geometry, material);
        this.strokeGroup.add(this.currentStroke.line);
        console.log('line added to strokeGroup, children:', this.strokeGroup.children.length);
    }
}
