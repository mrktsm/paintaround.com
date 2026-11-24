import { useMemo } from 'react';
import { Card } from './placeCards';
import { aroundTheWorld, placesIn, type Place } from './places';

/** A city's places, then some from elsewhere. `row`: the small cards in rows (phones) or a grid. */
export default function CityPlaces({ city, row, onOpen }: { city: string; row: string; onOpen(place: Place): void }) {
  const [hero, ...more] = useMemo(() => placesIn(city), [city]);
  const elsewhere = useMemo(() => aroundTheWorld(city), [city]);
  const popular = more.slice(0, 4);
  return (
    <>
      {hero && <Card size="hero" place={hero} overline={city} onOpen={onOpen} />}
      {popular.length > 0 && (
        <>
          <h2 className="ex-sec">Popular Spots</h2>
          <div className={row}>{popular.map(p => <Card key={p.id} size="tile" place={p} overline={p.area ?? city} onOpen={onOpen} />)}</div>
        </>
      )}
      {elsewhere.length > 0 && (
        <>
          <h2 className="ex-sec">Around the World</h2>
          <div className={row}>{elsewhere.map(p => <Card key={p.id} size="tile" place={p} overline={p.city} onOpen={onOpen} />)}</div>
        </>
      )}
    </>
  );
}
