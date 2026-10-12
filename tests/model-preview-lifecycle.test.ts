import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { createDisposalScope } from "../desktop/src/native-lifecycle";
import { disposePreviewObject } from "../desktop/src/assets/model-preview-lifecycle";

test("preview releases shared mesh, line and point resources once and closes decoded bitmap images", () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "ImageBitmap");
  let closes = 0;
  class Bitmap { close() { ++closes; } }
  Object.defineProperty(globalThis, "ImageBitmap", { configurable: true, value: Bitmap });
  try {
    const bitmap = new Bitmap() as unknown as ImageBitmap;
    const map = new THREE.Texture(bitmap);
    const normal = new THREE.Texture(bitmap);
    const material = new THREE.MeshStandardMaterial({ map, normalMap: normal });
    const geometry = new THREE.BoxGeometry();
    const lineMaterial = new THREE.LineBasicMaterial();
    const lineGeometry = new THREE.BufferGeometry();
    const pointsMaterial = new THREE.PointsMaterial({ map });
    const pointsGeometry = new THREE.BufferGeometry();
    const object = new THREE.Group();
    object.add(new THREE.Mesh(geometry, [material, material]), new THREE.Mesh(geometry, material));
    object.add(new THREE.Line(lineGeometry, lineMaterial), new THREE.Points(pointsGeometry, pointsMaterial));
    const counts = new Map<object, number>();
    for (const resource of [map, normal, material, geometry, lineMaterial, lineGeometry, pointsMaterial, pointsGeometry]) {
      resource.addEventListener("dispose", () => counts.set(resource, (counts.get(resource) ?? 0) + 1));
    }
    disposePreviewObject(object);
    assert.equal(closes, 1, "two textures sharing one ImageBitmap must close it once");
    assert.equal(counts.size, 8);
    for (const count of counts.values()) assert.equal(count, 1);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "ImageBitmap", descriptor);
    else Reflect.deleteProperty(globalThis, "ImageBitmap");
  }
});

test("a skinned preview releases its shared skeleton bone texture", () => {
  const geometry = new THREE.BoxGeometry();
  const material = new THREE.MeshStandardMaterial();
  const skeleton = new THREE.Skeleton([new THREE.Bone()]);
  skeleton.computeBoneTexture();
  let disposals = 0;
  skeleton.boneTexture!.addEventListener("dispose", () => { ++disposals; });
  const one = new THREE.SkinnedMesh(geometry, material);
  const two = new THREE.SkinnedMesh(geometry, material);
  one.bind(skeleton); two.bind(skeleton);
  const object = new THREE.Group(); object.add(one, two);
  disposePreviewObject(object);
  assert.equal(disposals, 1);
  assert.equal(skeleton.boneTexture, null);
});

test("a GLB finishing after view closure is disposed without starting a renderer", async () => {
  const scope = createDisposalScope();
  const geometry = new THREE.BoxGeometry();
  const material = new THREE.MeshStandardMaterial();
  const model = new THREE.Mesh(geometry, material);
  let disposals = 0;
  geometry.addEventListener("dispose", () => { ++disposals; });
  let rendererStarts = 0;
  const parse = Promise.resolve(model);
  scope.dispose();
  const object = await parse;
  scope.add(() => disposePreviewObject(object));
  if (scope.active()) ++rendererStarts;
  assert.equal(disposals, 1);
  assert.equal(rendererStarts, 0);
});

test("initialization failure releases acquired resources before a preview retry", () => {
  const scope = createDisposalScope();
  const calls: string[] = [];
  const geometry = new THREE.BoxGeometry();
  geometry.addEventListener("dispose", () => calls.push("model"));
  scope.add(() => disposePreviewObject(new THREE.Mesh(geometry, new THREE.MeshBasicMaterial())));
  scope.add(() => { calls.push("canvas"); });
  scope.add(() => { calls.push("context"); });
  scope.add(() => { calls.push("renderer"); });
  scope.add(() => { calls.push("controls"); });
  scope.add(() => { calls.push("observer"); });
  scope.dispose();
  assert.deepEqual(calls, ["observer", "controls", "renderer", "context", "canvas", "model"]);
  assert.equal(createDisposalScope().active(), true);
});
