import type { ProfileEntry } from '../core/profiler';
import { RingBuffer } from '../core/stats';

export interface OverlaySnapshot {
  fps: number;
  frameMsAvg: number;
  frameMsMax: number;
  cpuMsAvg: number;
  drawCalls: number;
  triangles: number;
  geometries: number;
  textures: number;
  programs: number;
  entities: number;
  bodies: number;
  colliders: number;
  awakeBodies: number;
  heapMB: number | null;
  tick: number;
  simTime: number;
  paused: boolean;
  timeScale: number;
  preset: string;
  gpu: string;
  seed: number;
  resolution: string;
  systems: readonly ProfileEntry[];
}

const GRAPH_WIDTH = 240;
const GRAPH_HEIGHT = 56;
const GRAPH_MAX_MS = 50;
const TEXT_REFRESH_SECONDS = 0.25;

/**
 * Developer overlay (F3). Frame-time graph redraws every frame; the text block refreshes at
 * 4 Hz from a snapshot pulled from the game, so the overlay costs almost nothing.
 */
export class DebugOverlay {
  readonly element: HTMLDivElement;
  private readonly text: HTMLPreElement;
  private readonly graph: HTMLCanvasElement;
  private readonly graphContext: CanvasRenderingContext2D | null;
  private readonly frameTimes = new RingBuffer(GRAPH_WIDTH);
  private sinceRefresh = 0;
  private visibleFlag: boolean;

  constructor(
    parent: HTMLElement,
    private readonly source: () => OverlaySnapshot,
    visible: boolean,
  ) {
    this.element = document.createElement('div');
    this.element.className = 'hc-debug-overlay';
    this.element.dataset['testid'] = 'debug-overlay';
    this.graph = document.createElement('canvas');
    this.graph.width = GRAPH_WIDTH;
    this.graph.height = GRAPH_HEIGHT;
    this.graph.className = 'hc-debug-graph';
    this.graphContext = this.graph.getContext('2d');
    this.text = document.createElement('pre');
    this.element.append(this.graph, this.text);
    parent.appendChild(this.element);
    this.visibleFlag = visible;
    this.element.hidden = !visible;
  }

  get visible(): boolean {
    return this.visibleFlag;
  }

  setVisible(visible: boolean): void {
    this.visibleFlag = visible;
    this.element.hidden = !visible;
    if (visible) this.refreshText();
  }

  /** Call once per rendered frame. */
  frame(frameMs: number, frameSeconds: number): void {
    this.frameTimes.push(frameMs);
    if (!this.visibleFlag) return;
    this.drawGraph();
    this.sinceRefresh += frameSeconds;
    if (this.sinceRefresh >= TEXT_REFRESH_SECONDS) {
      this.sinceRefresh = 0;
      this.refreshText();
    }
  }

  private refreshText(): void {
    const s = this.source();
    const heap = s.heapMB === null ? 'n/a' : `${s.heapMB.toFixed(1)} MB`;
    const lines = [
      `HARBOR CITY  dev overlay (F3)  physics lines (F4)  console (\`)`,
      `FPS ${s.fps.toFixed(0).padStart(4)}   frame ${s.frameMsAvg.toFixed(2)} ms (max ${s.frameMsMax.toFixed(1)})   cpu ${s.cpuMsAvg.toFixed(2)} ms`,
      `draws ${s.drawCalls}   tris ${formatCount(s.triangles)}   geo ${s.geometries}   tex ${s.textures}   progs ${s.programs}`,
      `entities ${s.entities}   bodies ${s.bodies} (awake ${s.awakeBodies})   colliders ${s.colliders}   heap ${heap}`,
      `tick ${s.tick}   sim ${s.simTime.toFixed(1)} s   x${s.timeScale}${s.paused ? '   PAUSED' : ''}   seed ${s.seed}`,
      `preset ${s.preset}   ${s.resolution}   gpu ${s.gpu}`,
      'systems (avg / max ms):',
      ...s.systems
        .slice(0, 10)
        .map((e) => `  ${e.name.padEnd(20)} ${e.avgMs.toFixed(3)} / ${e.maxMs.toFixed(2)}`),
    ];
    this.text.textContent = lines.join('\n');
  }

  private drawGraph(): void {
    const ctx = this.graphContext;
    if (!ctx) return;
    ctx.clearRect(0, 0, GRAPH_WIDTH, GRAPH_HEIGHT);
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(0, 0, GRAPH_WIDTH, GRAPH_HEIGHT);
    const n = this.frameTimes.size;
    for (let i = 0; i < n; i++) {
      const ms = this.frameTimes.at(i);
      const h = Math.min(GRAPH_HEIGHT, (ms / GRAPH_MAX_MS) * GRAPH_HEIGHT);
      ctx.fillStyle = ms <= 17.5 ? '#5fd38d' : ms <= 34 ? '#f2c94c' : '#eb5757';
      ctx.fillRect(GRAPH_WIDTH - n + i, GRAPH_HEIGHT - h, 1, h);
    }
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    for (const target of [16.67, 33.33]) {
      const y = GRAPH_HEIGHT - (target / GRAPH_MAX_MS) * GRAPH_HEIGHT;
      ctx.fillRect(0, Math.round(y), GRAPH_WIDTH, 1);
    }
  }
}

function formatCount(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}
