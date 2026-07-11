import { describe, expect, it } from 'vitest';
import { GpuTimerRing } from '../src/render/gpuTimer';

interface FakeQuery {
  id: number;
  available: boolean;
  nanoseconds: number;
}

class FakeWebGl2 {
  readonly QUERY_RESULT_AVAILABLE = 0x8867;
  readonly QUERY_RESULT = 0x8866;
  readonly extension = { TIME_ELAPSED_EXT: 0x88bf, GPU_DISJOINT_EXT: 0x8fbb };
  readonly queries: FakeQuery[] = [];
  readonly issued: FakeQuery[] = [];
  readonly deleted: FakeQuery[] = [];
  resultReads = 0;
  availabilityReads = 0;
  disjoint = false;
  extensionAvailable = true;
  private active: FakeQuery | null = null;

  getExtension(name: string): typeof this.extension | null {
    expect(name).toBe('EXT_disjoint_timer_query_webgl2');
    return this.extensionAvailable ? this.extension : null;
  }

  createQuery(): FakeQuery {
    const query = { id: this.queries.length, available: false, nanoseconds: 0 };
    this.queries.push(query);
    return query;
  }

  beginQuery(target: number, query: FakeQuery): void {
    expect(target).toBe(this.extension.TIME_ELAPSED_EXT);
    expect(this.active).toBeNull();
    this.active = query;
    query.available = false;
  }

  endQuery(target: number): void {
    expect(target).toBe(this.extension.TIME_ELAPSED_EXT);
    if (!this.active) throw new Error('No active fake query');
    this.issued.push(this.active);
    this.active = null;
  }

  getQueryParameter(query: FakeQuery, parameter: number): boolean | number {
    if (parameter === this.QUERY_RESULT_AVAILABLE) {
      this.availabilityReads++;
      return query.available;
    }
    if (parameter === this.QUERY_RESULT) {
      if (!query.available) throw new Error('Query result read before availability');
      this.resultReads++;
      return query.nanoseconds;
    }
    throw new Error(`Unknown fake query parameter ${parameter}`);
  }

  getParameter(parameter: number): boolean {
    expect(parameter).toBe(this.extension.GPU_DISJOINT_EXT);
    return this.disjoint;
  }

  deleteQuery(query: FakeQuery): void {
    this.deleted.push(query);
  }

  complete(index: number, nanoseconds: number): void {
    this.issued[index].nanoseconds = nanoseconds;
    this.issued[index].available = true;
  }
}

function timer(gl: FakeWebGl2, size = 2): GpuTimerRing {
  return new GpuTimerRing(gl as unknown as WebGL2RenderingContext, size);
}

describe('GpuTimerRing', () => {
  it('reports an unavailable extension without issuing queries', () => {
    const gl = new FakeWebGl2();
    gl.extensionAvailable = false;
    const ring = timer(gl);
    expect(ring.begin('frame')).toBe(false);
    ring.end();
    expect(ring.poll()).toEqual([]);
    expect(ring.snapshot()).toMatchObject({ supported: false, pending: 0, validSamples: 0 });
    expect(gl.queries).toHaveLength(0);
  });

  it('does not block or overwrite pending queries when the ring is full', () => {
    const gl = new FakeWebGl2();
    const ring = timer(gl);
    expect(ring.begin('first')).toBe(true);
    ring.end();
    expect(ring.begin('second')).toBe(true);
    ring.end();
    expect(ring.begin('third')).toBe(false);
    ring.end();
    expect(ring.snapshot()).toMatchObject({ pending: 2, saturatedBegins: 1 });
  });

  it('reads only available results and preserves labels', () => {
    const gl = new FakeWebGl2();
    const ring = timer(gl);
    ring.begin('combined-frame');
    ring.end();
    expect(ring.poll()).toEqual([]);
    expect(gl.resultReads).toBe(0);
    gl.complete(0, 7_250_000);
    expect(ring.poll()).toEqual([{ label: 'combined-frame', milliseconds: 7.25 }]);
    expect(gl.resultReads).toBe(1);
    expect(ring.snapshot()).toMatchObject({ pending: 0, validSamples: 1 });
  });

  it('discards available results while the GPU disjoint flag is set', () => {
    const gl = new FakeWebGl2();
    const ring = timer(gl);
    ring.begin('invalid-frame');
    ring.end();
    gl.complete(0, 4_000_000);
    gl.disjoint = true;
    expect(ring.poll()).toEqual([]);
    expect(gl.resultReads).toBe(0);
    expect(ring.snapshot()).toMatchObject({ pending: 0, validSamples: 0, disjointSamples: 1 });
  });

  it('deletes every allocated query on disposal', () => {
    const gl = new FakeWebGl2();
    const ring = timer(gl, 3);
    ring.dispose();
    expect(gl.deleted).toEqual(gl.queries);
    expect(() => ring.begin('after-dispose')).toThrow(/disposed/i);
  });
});
