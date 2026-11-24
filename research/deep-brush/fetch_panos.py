"""Download a few curated panoramas (2048x1024 equirect) + their Mapillary SfM mesh URL.

Usage: python fetch_panos.py OUT_DIR [N]
Picks the default test image plus N-1 spread-out curated locations.
"""
import json, sys, os, urllib.request

TOKEN = os.environ["MAPILLARY_TOKEN"]
HERE = os.path.dirname(os.path.abspath(__file__))
out = sys.argv[1]
n = int(sys.argv[2]) if len(sys.argv) > 2 else 5
os.makedirs(out, exist_ok=True)

locs = json.load(open(os.path.join(HERE, '../../src/data/locations.json')))['locations']
seen_cities, picks = set(), ['287647329615048']
for loc in locs[:: max(1, len(locs) // 200)]:
    if len(picks) >= n:
        break
    if loc['city'] in seen_cities:
        continue
    seen_cities.add(loc['city'])
    picks.append(loc['id'])

def get(url):
    req = urllib.request.Request(url, headers={'Authorization': 'OAuth ' + TOKEN})
    return urllib.request.urlopen(req, timeout=60).read()

for pid in picks:
    meta = json.loads(get(f'https://graph.mapillary.com/{pid}?fields=thumb_2048_url,camera_type,width,height,mesh'))
    if meta.get('camera_type') != 'spherical':
        print('skip (not spherical)', pid); continue
    open(os.path.join(out, f'{pid}.jpg'), 'wb').write(get(meta['thumb_2048_url']))
    print('saved', pid, meta['width'], 'x', meta['height'])
