import { readFile, writeFile, rename } from 'node:fs/promises';
import { renderPanoramaThumbnail } from '../shared/panoramaProjection.mjs';

const root=new URL('../',import.meta.url);
const path=new URL('src/data/panorama-pool.json',root);
const pool=JSON.parse(await readFile(path,'utf8'));
for (const [index,item] of pool.items.entries()) {
  item.thumbnailUrl=`/panorama-pool/${item.id}-card.jpg`;
  item.thumbnailView=await renderPanoramaThumbnail(new URL(`public${item.imageUrl}`,root).pathname,new URL(`public${item.thumbnailUrl}`,root).pathname,item.id);
  if ((index+1)%20===0) console.log(`Rendered ${index+1}/${pool.items.length} perspective thumbnails`);
}
const temporary=new URL('src/data/panorama-pool.json.tmp',root);
await writeFile(temporary,JSON.stringify(pool,null,2)+'\n');
await rename(temporary,path);
console.log('Updated thumbnail URLs; full 360° images preserved.');
