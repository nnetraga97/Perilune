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
  failAllocationAt: number | null = null;
  disjointReads = 0;
  private active: FakeQuery | null = null;

  getExtension(name: string): typeof this.extension | null {
    expect(name).toBe('EXT_disjoint_timer_query_webgl2');
    return this.extensionAvailable ? this.extension : null;
  }

  createQuery(): FakeQuery | null {
    if (this.queries.length === this.failAllocationAt) return null;
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
    this.disjointReads++;
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

function timer(gl: FakeWebGl2, size = 6): GpuTimerRing {
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
    for (let index = 1; index < 6; index++) {
      expect(ring.begin(`pending-${index}`)).toBe(true);
      ring.end();
    }
    expect(ring.begin('saturated')).toBe(false);
    ring.end();
    expect(ring.snapshot()).toMatchObject({ pending: 6, saturatedBegins: 1 });
  });

  it('reads only available results and preserves labels', () => {
    const gl = new FakeWebGl2();
    const ring = timer(gl);
    ring.begin('combined-frame');
    ring.end();
    expect(ring.poll()).toEqual([]);
    expect(gl.resultReads).toBe(0);
    gl.complete(0, 7_250_000);
    expect(ring.poll()).toEqual([{ label: 'combined-frame', status: 'valid', milliseconds: 7.25 }]);
    expect(gl.resultReads).toBe(1);
    expect(ring.snapshot()).toMatchObject({ pending: 0, validSamples: 1 });
  });

  it('returns labeled disjoint events for the entire pending set as results become available', () => {
    const gl = new FakeWebGl2();
    const ring = timer(gl);
    ring.begin('first-disjoint-frame');
    ring.end();
    ring.begin('second-disjoint-frame');
    ring.end();
    gl.complete(0, 4_000_000);
    gl.disjoint = true;
    expect(ring.poll()).toEqual([{ label: 'first-disjoint-frame', status: 'disjoint' }]);
    expect(gl.resultReads).toBe(0);
    expect(gl.disjointReads).toBe(1);
    expect(ring.snapshot()).toMatchObject({ pending: 1, validSamples: 0, disjointSamples: 1 });

    gl.disjoint = false;
    gl.complete(1, 5_000_000);
    expect(ring.poll()).toEqual([{ label: 'second-disjoint-frame', status: 'disjoint' }]);
    expect(gl.disjointReads).toBe(2);
    expect(ring.snapshot()).toMatchObject({ pending: 0, validSamples: 0, disjointSamples: 2 });
  });

  it('returns a labeled invalid event for a non-finite query result', () => {
    const gl = new FakeWebGl2();
    const ring = timer(gl);
    ring.begin('invalid-frame');
    ring.end();
    gl.complete(0, Number.NaN);
    expect(ring.poll()).toEqual([{ label: 'invalid-frame', status: 'invalid' }]);
    expect(ring.snapshot()).toMatchObject({ pending: 0, invalidSamples: 1 });
  });

  it('samples the disjoint flag once per poll', () => {
    const gl = new FakeWebGl2();
    const ring = timer(gl);
    ring.begin('first'); ring.end();
    ring.begin('second'); ring.end();
    gl.complete(0, 1_000_000);
    gl.complete(1, 2_000_000);
    expect(ring.poll()).toEqual([
      { label: 'first', status: 'valid', milliseconds: 1 },
      { label: 'second', status: 'valid', milliseconds: 2 },
    ]);
    expect(gl.disjointReads).toBe(1);
  });

  it('abandons unavailable queries with labels and leaves their slots reusable', () => {
    const gl = new FakeWebGl2();
    const ring = timer(gl);
    ring.begin('unfinished-frame');
    ring.end();
    expect(ring.poll()).toEqual([]);

    expect(ring.abandonPending()).toEqual([
      { label: 'unfinished-frame', status: 'unavailable' },
    ]);
    expect(ring.snapshot().pending).toBe(0);
    expect(ring.begin('replacement-frame')).toBe(true);
    ring.end();
  });

  it('preserves disjoint status and counting when a marked query is abandoned', () => {
    const gl = new FakeWebGl2();
    const ring = timer(gl);
    ring.begin('unfinished-disjoint-frame');
    ring.end();
    gl.disjoint = true;

    expect(ring.poll()).toEqual([]);
    expect(ring.snapshot()).toMatchObject({ pending: 1, disjointSamples: 0 });
    expect(ring.abandonPending()).toEqual([
      { label: 'unfinished-disjoint-frame', status: 'disjoint' },
    ]);
    expect(ring.snapshot()).toMatchObject({ pending: 0, disjointSamples: 1 });
    expect(ring.abandonPending()).toEqual([]);
    expect(ring.snapshot().disjointSamples).toBe(1);
  });

  it('rejects rings smaller than the production-safe minimum', () => {
    const gl = new FakeWebGl2();
    expect(() => timer(gl, 5)).toThrow(/at least 6/i);
    expect(gl.queries).toHaveLength(0);
  });

  it('deletes partially allocated queries before an allocation failure escapes', () => {
    const gl = new FakeWebGl2();
    gl.failAllocationAt = 3;
    expect(() => timer(gl, 6)).toThrow(/allocate/i);
    expect(gl.deleted).toEqual(gl.queries);
  });

  it('deletes every allocated query on disposal', () => {
    const gl = new FakeWebGl2();
    const ring = timer(gl, 6);
    ring.dispose();
    expect(gl.deleted).toEqual(gl.queries);
    expect(() => ring.begin('after-dispose')).toThrow(/disposed/i);
  });
});
