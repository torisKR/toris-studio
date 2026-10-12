import * as THREE from "three";

/** GLTFLoader's ImageBitmaps are not released by Texture.dispose(). */
export function disposePreviewObject(object: THREE.Object3D) {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  const bitmaps = new Set<ImageBitmap>();
  const skeletons = new Set<THREE.Skeleton>();
  object.traverse(node => {
    if (!(node instanceof THREE.Mesh || node instanceof THREE.Line || node instanceof THREE.Points)) return;
    if (node instanceof THREE.SkinnedMesh && node.skeleton) skeletons.add(node.skeleton);
    geometries.add(node.geometry);
    for (const material of Array.isArray(node.material) ? node.material : [node.material]) materials.add(material);
  });
  for (const material of materials) {
    for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value);
  }
  for (const texture of textures) {
    const images = Array.isArray(texture.image) ? texture.image : [texture.image];
    for (const image of images) if (typeof ImageBitmap !== "undefined" && image instanceof ImageBitmap) bitmaps.add(image);
    texture.dispose();
  }
  for (const bitmap of bitmaps) bitmap.close();
  for (const skeleton of skeletons) skeleton.dispose();
  for (const material of materials) material.dispose();
  for (const geometry of geometries) geometry.dispose();
}
