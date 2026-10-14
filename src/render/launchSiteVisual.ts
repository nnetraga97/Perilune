import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import manifest from '../generated/launch-site-manifest.json';
import { LAUNCH_PAD_CONTACT_RADIUS, LAUNCH_PAD_FOOTPRINT_RADIUS } from '../sim/launchSite';
import { padDeployFractions, type PadLaunchSequence } from '../sim/launchSequence';

export type LaunchSiteAssetLoader = () => Promise<GLTF>;
export async function loadCheckedLaunchSite(): Promise<GLTF> {
  const response=await fetch(`${import.meta.env.BASE_URL}${manifest.url.slice(1)}`);
  if(!response.ok) throw new Error(`Launch site HTTP ${response.status}`);
  const bytes=await response.arrayBuffer();
  if(bytes.byteLength!==manifest.bytes) throw new Error('Launch site byte length mismatch');
  const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join('');
  if(hash!==manifest.sha256) throw new Error('Launch site checksum mismatch');
  return new GLTFLoader().parseAsync(bytes,'');
}
function disposeTree(root: THREE.Object3D) {
  const geometries=new Set<THREE.BufferGeometry>(),materials=new Set<THREE.Material>(),textures=new Set<THREE.Texture>();
  root.traverse(o=>{
    if(!(o instanceof THREE.Mesh)) return;
    geometries.add(o.geometry);
    for(const m of Array.isArray(o.material)?o.material:[o.material]) {
      materials.add(m);
      for(const value of Object.values(m)) if(value instanceof THREE.Texture) textures.add(value);
    }
  });
  geometries.forEach(g=>g.dispose());materials.forEach(m=>m.dispose());
  textures.forEach(t=>{ if(typeof ImageBitmap!=='undefined' && t.image instanceof ImageBitmap)t.image.close();t.dispose(); });
  root.clear();
}
/** Owns one pad and its resources. Loading failure preserves the procedural pad. */
export class LaunchSiteVisual {
  readonly root=new THREE.Group();
  readonly foundation: THREE.Mesh<THREE.CylinderGeometry,THREE.MeshStandardMaterial>;
  readonly ready: Promise<void>;
  status: 'loading'|'ready'|'fallback'='loading';
  error: string|null=null;
  private mixer?: THREE.AnimationMixer;
  private asset?: THREE.Object3D;
  private actions=new Map<string,THREE.AnimationAction>();
  private disposed=false;
  private readonly deck: THREE.Mesh<THREE.CylinderGeometry,THREE.MeshStandardMaterial>;
  constructor(bindMaterial:(material:THREE.MeshStandardMaterial)=>void=()=>{},load:LaunchSiteAssetLoader=loadCheckedLaunchSite) {
    this.root.name='launch-site';
    const concrete=new THREE.MeshStandardMaterial({color:'#68717a',roughness:.92,metalness:.05});
    const steel=new THREE.MeshStandardMaterial({color:'#c7d0d5',roughness:.65,metalness:.35});
    bindMaterial(concrete);bindMaterial(steel);
    this.foundation=new THREE.Mesh(new THREE.CylinderGeometry(LAUNCH_PAD_CONTACT_RADIUS,LAUNCH_PAD_FOOTPRINT_RADIUS,1,32),concrete);
    this.foundation.name='launch-pad-foundation';this.foundation.position.y=-.5;
    this.deck=new THREE.Mesh(new THREE.CylinderGeometry(4.2,4.2,.12,32),steel);this.deck.position.y=.06;
    for(const o of [this.foundation,this.deck]){o.castShadow=true;o.receiveShadow=true;this.root.add(o);}
    this.root.visible=false;
    this.ready=load().then(gltf=>{
      if(this.disposed){disposeTree(gltf.scene);return;}
      try {
        for(const name of manifest.joints) if(!gltf.scene.getObjectByName(name)) throw new Error(`Missing pad joint ${name}`);
        for(const name of manifest.clips) if(!gltf.animations.some(a=>a.name===name && Math.abs(a.duration-1)<1e-5)) throw new Error(`Missing pad clip ${name}`);
        this.asset=clone(gltf.scene);this.asset.name='ksc-launch-pad-model';
        this.asset.traverse(o=>{
          if(!(o instanceof THREE.Mesh))return;
          o.castShadow=true;o.receiveShadow=true;
          for(const m of Array.isArray(o.material)?o.material:[o.material])if(m instanceof THREE.MeshStandardMaterial)bindMaterial(m);
        });
        this.mixer=new THREE.AnimationMixer(this.asset);
        for(const clip of gltf.animations){const action=this.mixer.clipAction(clip);action.play();action.paused=true;this.actions.set(clip.name,action);}
        this.root.add(this.asset);
        this.deck.visible=false;
        // Retain the terrain-envelope skirt and its semantic name, but open its
        // cap so it cannot fill the authored flame trench/exhaust aperture.
        this.foundation.geometry.dispose();
        this.foundation.geometry=new THREE.CylinderGeometry(LAUNCH_PAD_CONTACT_RADIUS,LAUNCH_PAD_FOOTPRINT_RADIUS,1,64,1,true);
        this.foundation.material.side=THREE.DoubleSide;
        this.status='ready';
        this.update(undefined,0);
      } catch(error) {disposeTree(gltf.scene);throw error;}
    }).catch(error=>{this.status='fallback';this.error=String(error);});
  }
  setDeployFraction(clip:string,fraction:number) {
    if(!Number.isFinite(fraction)) throw new Error('Pad deploy fraction must be finite');
    const action=this.actions.get(clip);
    if(!action)return;
    action.time=THREE.MathUtils.clamp(fraction,0,1)*action.getClip().duration;
    this.mixer!.update(0);
  }
  update(sequence:PadLaunchSequence|undefined,time:number) {
    const fractions=padDeployFractions(sequence,time);
    for(const [clip,fraction] of Object.entries(fractions))this.setDeployFraction(clip,fraction);
    this.root.userData.launchPad={status:this.status,error:this.error,fractions};
  }
  dispose() {
    this.disposed=true;this.mixer?.stopAllAction();
    if(this.asset)this.mixer?.uncacheRoot(this.asset);
    this.actions.clear();disposeTree(this.root);
  }
}
