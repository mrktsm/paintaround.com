import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Clusters, type Spot } from '../../src/explore/clusters.ts';

// a few cities' worth of places, some of them across the antimeridian
let seed = 7;
const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const spots: Spot[] = [[41.9, 12.5], [48.86, 2.35], [35.7, 139.7], [-17.7, 179.9], [-17.5, -179.9]].flatMap(([lat, lng], city) =>
  Array.from({ length: 30 }, (_, i) => ({ id: `${city}-${i}`, lat: lat + (random() - 0.5) * 0.3, lng: lng + (random() - 0.5) * 0.3 })));
const levels = Array.from({ length: 30 }, (_, i) => i / 2);

test('every place belongs to exactly one circle, at every zoom', () => {
  const clusters = new Clusters(spots, 1);
  for (const level of levels) {
    const ids = clusters.at(level).flatMap(c => c.group.map(s => s.id));
    assert.deepEqual([...ids].sort(), spots.map(s => s.id).sort(), `zoom ${level}`);
    for (const c of clusters.at(level)) assert.ok(c.group.includes(c.rep));
  }
});

test('zooming in only adds circles', () => {
  const clusters = new Clusters(spots, 1);
  for (const level of levels.slice(1)) {
    const closer = new Set(clusters.at(level).map(c => c.rep.id));
    for (const c of clusters.at(level - 0.5)) assert.ok(closer.has(c.rep.id), `zoom ${level}`);
  }
});

test('the whole world has few circles, close up every place has its own', () => {
  const clusters = new Clusters(spots, 1);
  assert.ok(clusters.at(0).length <= 5);
  assert.equal(clusters.at(22).length, spots.length);
});

test('places on both sides of the antimeridian share a circle', () => {
  const fiji = new Clusters(spots.filter(s => s.lat < 0), 1).at(2);
  assert.equal(fiji.length, 1);
});

test('the order changes between visits but not within one', () => {
  const reps = (s: number) => new Clusters(spots, s).at(4).map(c => c.rep.id).join();
  assert.equal(reps(1), reps(1));
  assert.ok(new Set([1, 2, 3, 4, 5, 6].map(reps)).size > 1);
});
