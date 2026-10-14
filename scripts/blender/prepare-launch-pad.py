"""Run against the preserved Tripo bridge .blend. Exports only cleaned pad objects.
Blender --background <raw.blend> --python scripts/blender/prepare-launch-pad.py
"""
import bpy, math, os
from mathutils import Vector, Matrix, Quaternion
ROOT=os.path.abspath(os.path.join(os.path.dirname(__file__),'../..'))
OUT=os.path.join(ROOT,'assets/launch-site/authoring')
os.makedirs(OUT,exist_ok=True)
source=[o for o in bpy.context.scene.objects if o.type=='MESH' and o.name.startswith('tripo_part_')]
assert len(source)==17, 'Expected the inspected 17-part bridge import'
scene=bpy.data.scenes.new('Perilune Launch Pad')
bpy.context.window.scene=scene
scene.unit_settings.system='METRIC';scene.unit_settings.scale_length=1
scene.render.fps=24;scene.frame_start=0;scene.frame_end=24
col=bpy.data.collections.new('COL_LaunchPad');scene.collection.children.link(col)
base=bpy.data.objects.new('launch-pad-asset',None);col.objects.link(base)
xy=19.6/0.4998169541358948
deck=0.0737
top=max((o.matrix_world@v.co).z for o in source for v in o.data.vertices)
zscale=52/(top-deck)
names={0:'foundation-shell',1:'tower-lower',2:'tower-upper',3:'crew-arm',4:'clamp-ne',5:'umbilical-upper',6:'umbilical-lower',7:'access-stairs',8:'clamp-nw',9:'clamp-sw',10:'clamp-se',11:'tower-foot-a',12:'tower-foot-b',13:'flame-deflector',14:'tower-foot-c'}
movers={3,4,5,6,8,9,10}
objects={}
for src in source:
 i=int(src.name.rsplit('_',1)[-1])
 if i not in names:continue # two isolated single-triangle generation scraps
 o=src.copy();o.data=src.data.copy();o.parent=None;o.matrix_world=Matrix.Identity(4)
 o.name='SM_'+names[i];col.objects.link(o);o.parent=base
 center=(min((src.matrix_world@v.co).z for v in src.data.vertices)+max((src.matrix_world@v.co).z for v in src.data.vertices))/2
 for v in o.data.vertices:
  p=src.matrix_world@v.co
  z=(p.z-deck)*(2/deck) if p.z<deck else (p.z-deck)*zscale
  if i in movers:z=(center-deck)*zscale+(p.z-center)*xy
  v.co=(p.x*xy,p.y*xy,z)
 o['tripo_part_index']=i
 objects[i]=o
# Rigid pivot parents; clips are separate actions/NLA tracks, normalized to 1 second.
def rig(indices,name,pivot,axis,angle):
 joint=bpy.data.objects.new(name,None);col.objects.link(joint);joint.parent=base;joint.location=pivot
 for i in indices:
  o=objects[i];o.parent=joint;o.location=-Vector(pivot)
 joint.rotation_mode='QUATERNION'
 joint.rotation_quaternion=Quaternion(axis,0);joint.keyframe_insert('rotation_quaternion',frame=0)
 joint.rotation_quaternion=Quaternion(axis,angle);joint.keyframe_insert('rotation_quaternion',frame=24)
 action=joint.animation_data.action;action.name=name
 track=joint.animation_data.nla_tracks.new();track.name=name;track.strips.new(name,0,action)
 joint.animation_data.action=None
 return joint
crew_z=(0.8653-deck)*zscale
rig([3],'crew-access',(-.1129*xy,.065*xy,crew_z),(0,0,1),math.radians(105))
for i,name,z in [(5,'umbilical-upper',.56),(6,'umbilical-lower',.323)]:
 rig([i],name,(-.113*xy,.075*xy,(z-deck)*zscale),(0,0,1),math.radians(110))
for i,name in [(4,'clamp-ne'),(8,'clamp-nw'),(9,'clamp-sw'),(10,'clamp-se')]:
 o=objects[i];xs=[v.co.x for v in o.data.vertices];ys=[v.co.y for v in o.data.vertices]
 x=(min(xs)+max(xs))/2;y=(min(ys)+max(ys))/2
 radial=Vector((x,y,0)).normalized();pivot=Vector((x,y,0))+radial*.45
 axis=Vector((-radial.y,radial.x,0))
 rig([i],name,pivot,axis,math.radians(75))
scene.frame_set(0)
for o in bpy.context.view_layer.objects:o.select_set(True)
bpy.context.view_layer.objects.active=objects[0]
path=os.path.join(OUT,'launch-pad.glb')
bpy.ops.export_scene.gltf(filepath=path,export_format='GLB',use_selection=True,export_yup=True,export_animations=True,export_animation_mode='NLA_TRACKS',export_force_sampling=True)
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(OUT,'launch-pad.blend'))
print('PERILUNE_PAD',path,'tower_z',max(v.co.z for o in objects.values() for v in o.data.vertices))
