/** Atlas and validate the rigid animated pad. Never flatten, join or simplify. */
import { NodeIO, type Document } from '@gltf-transform/core';
import { prune } from '@gltf-transform/functions';
import sharp from 'sharp';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import recipe from '../assets/launch-site/recipe.json';
const root = fileURLToPath(new URL('..', import.meta.url));
export function validateLaunchDocument(doc: Document) {
  if (recipe.animationPolicy !== 'clips') throw new Error('Launch site must preserve clips');
  const nodes = doc.getRoot().listNodes();
  for (const name of recipe.joints) if (!nodes.some(n => n.getName() === name)) throw new Error(`Missing joint ${name}`);
  const animations = doc.getRoot().listAnimations();
  if (animations.length !== recipe.clips.length) throw new Error('Unexpected clip count');
  for (const name of recipe.clips) {
    const clip = animations.find(a => a.getName() === name);
    if (!clip || !clip.listChannels().length) throw new Error(`Missing clip ${name}`);
    for (const channel of clip.listChannels()) {
      if (channel.getTargetNode()?.getName() !== name) throw new Error(`Incorrect joint for ${name}`);
      const times = channel.getSampler()!.getInput()!;
      if (times.getScalar(0) !== 0 || Math.abs(times.getScalar(times.getCount()-1)-1) > 1e-5) throw new Error(`Clip ${name} must span 0..1`);
    }
  }
  let triangles=0, geometryBytes=0;
  for (const mesh of doc.getRoot().listMeshes()) for (const p of mesh.listPrimitives()) {
    if (p.getMode() !== 4) throw new Error('Non-triangle geometry');
    triangles += (p.getIndices()?.getCount() ?? p.getAttribute('POSITION')!.getCount()) / 3;
  }
  for (const a of doc.getRoot().listAccessors()) geometryBytes += a.getArray()?.byteLength ?? 0;
  if (triangles > recipe.triangleLimit) throw new Error(`Triangle budget exceeded: ${triangles}`);
  return {triangles,geometryBytes};
}
export async function compileLaunchSite() {
  const io=new NodeIO();
  const doc=await io.read(resolve(root,'assets/launch-site/authoring/launch-pad.glb'));
  validateLaunchDocument(doc);
  const tiles = new Map<number, [number,number,number]>([[0,[0,0,896]],[1,[896,0,896]],[2,[0,896,896]],[3,[896,896,512]],[5,[1408,896,256]],[6,[1664,896,256]],[13,[1408,1152,256]]]);
  [4,7,8,9,10,11,12,14].forEach((id,i)=>tiles.set(id,[i*128,1792,128]));
  const materials=doc.getRoot().listMaterials();
  const atlases=[];
  for (const channel of ['base','normal','orm'] as const) {
    const composites=[];
    for (const material of materials) {
      const id=Number(material.getName().match(/part_(\d+)_/)![1]);
      const [left,top,size]=tiles.get(id)!;
      const texture=channel==='base'?material.getBaseColorTexture():channel==='normal'?material.getNormalTexture():material.getMetallicRoughnessTexture();
      if (!texture?.getImage()) throw new Error(`Missing ${channel} texture for ${id}`);
      const input=await sharp(Buffer.from(texture.getImage()!)).resize(size-8,size-8).removeAlpha().extend({top:4,bottom:4,left:4,right:4,extendWith:'copy'}).png().toBuffer();
      composites.push({input,left,top});
    }
    const data=await sharp({create:{width:2048,height:2048,channels:3,background:channel==='normal'?{r:128,g:128,b:255}:channel==='orm'?{r:255,g:255,b:0}:{r:128,g:128,b:128}}}).composite(composites).png().toBuffer();
    const encoded=channel==='base'?await sharp(data).jpeg({quality:90,mozjpeg:true}).toBuffer():data;
    atlases.push(doc.createTexture(`pad-${channel}`).setImage(encoded).setMimeType(channel==='base'?'image/jpeg':'image/png'));
  }
  const material=doc.createMaterial('launch-pad-pbr').setBaseColorTexture(atlases[0]).setNormalTexture(atlases[1]).setMetallicRoughnessTexture(atlases[2]).setMetallicFactor(1).setRoughnessFactor(1);
  for (const mesh of doc.getRoot().listMeshes()) for (const p of mesh.listPrimitives()) {
    const id=Number(p.getMaterial()!.getName().match(/part_(\d+)_/)![1]);
    const [x,y,size]=tiles.get(id)!;
    const uv=p.getAttribute('TEXCOORD_0')!;
    const point:number[]=[];
    for(let i=0;i<uv.getCount();i++) {
      uv.getElement(i,point);
      if(point.some(v=>v < -0.001 || v > 1.001)) throw new Error(`Tiled UVs on part ${id}`);
      uv.setElement(i,[(x+4+point[0]*(size-8))/2048,(y+4+point[1]*(size-8))/2048]);
    }
    p.setMaterial(material);
  }
  await doc.transform(prune());
  const stats=validateLaunchDocument(doc);
  let textureGpuBytes=0;
  for(const texture of doc.getRoot().listTextures()) {
    const meta=await sharp(Buffer.from(texture.getImage()!)).metadata();
    if(!meta.width || !meta.height || Math.max(meta.width,meta.height)>recipe.textureMaxDimension) throw new Error('Texture size budget exceeded');
    textureGpuBytes+=Math.ceil(meta.width*meta.height*4*4/3);
  }
  const bytes=await io.writeBinary(doc);
  const gpuBytes=textureGpuBytes+stats.geometryBytes;
  if(bytes.length>recipe.transferByteLimit || gpuBytes>recipe.gpuByteLimit) throw new Error(`Launch pad byte budget exceeded: transfer=${bytes.length} gpu=${gpuBytes}`);
  // Read the actual export back: hierarchy and clips must survive the round trip.
  validateLaunchDocument(await io.readBinary(bytes));
  const manifest={schemaVersion:1,assetId:recipe.assetId,url:'/launch-site/launch-pad.glb',sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length,triangles:stats.triangles,textureBytes:doc.getRoot().listTextures().reduce((n,t)=>n+t.getImage()!.byteLength,0),gpuBytes,clips:recipe.clips,joints:recipe.joints};
  await mkdir(resolve(root,'public/launch-site'),{recursive:true});
  await writeFile(resolve(root,'public/launch-site/launch-pad.glb'),bytes);
  await writeFile(resolve(root,'src/generated/launch-site-manifest.json'),JSON.stringify(manifest,null,2)+'\n');
  await writeFile(resolve(root,'assets/launch-site/manifest.json'),JSON.stringify(manifest,null,2)+'\n');
  console.log(JSON.stringify(manifest,null,2));
  return manifest;
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) await compileLaunchSite();
