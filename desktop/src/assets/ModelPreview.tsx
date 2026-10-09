import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OBJLoader } from "three/addons/loaders/OBJLoader.js";
import { STLLoader } from "three/addons/loaders/STLLoader.js";
import { assetApi, assetError } from "./transport";
import type { Asset } from "./contracts";

export default function ModelPreview({ asset }: { asset: Asset }) {
  const host = useRef<HTMLDivElement>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let cancelled = false;
    let dispose = () => {};
    setError(""); setLoading(true);
    void (async () => {
      const payload = await assetApi<{ base64: string }>("payload", { id: asset.id });
      if (cancelled) return;
      const bytes = Uint8Array.from(atob(payload.base64), char => char.charCodeAt(0));
      const manager = new THREE.LoadingManager();
      // Validation rejects external model references; keep the viewer network-isolated too.
      manager.setURLModifier(url => {
        if (url.startsWith("blob:") || url.startsWith("data:")) return url;
        throw new Error("외부 모델 리소스는 불러오지 않습니다. 자체 포함 GLB를 사용하세요.");
      });
      let object: THREE.Object3D;
      if (asset.format === "glb") {
        object = (await new GLTFLoader(manager).parseAsync(bytes.buffer, "")).scene;
      } else if (asset.format === "obj") {
        object = new OBJLoader(manager).parse(new TextDecoder().decode(bytes));
      } else {
        const geometry = new STLLoader(manager).parse(bytes.buffer);
        geometry.computeVertexNormals();
        object = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: 0x92b8ff, roughness: 0.65, side: THREE.DoubleSide }));
      }
      const releaseObject = () => object.traverse(node => {
        if (node instanceof THREE.Mesh) {
          node.geometry.dispose();
          const materials = Array.isArray(node.material) ? node.material : [node.material];
          for (const material of materials) {
            for (const value of Object.values(material)) if (value instanceof THREE.Texture) value.dispose();
            material.dispose();
          }
        }
      });
      if (cancelled) { releaseObject(); return; }
      let renderer: THREE.WebGLRenderer;
      try { renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false }); }
      catch (e) { releaseObject(); throw e; }
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.setClearColor(0x0e151e);
      renderer.domElement.setAttribute("aria-label", "3D 모델: 드래그 회전, 휠 확대·축소, 방향키 이동");
      renderer.domElement.tabIndex = 0;
      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(40, 1, 0.001, 100000);
      scene.add(new THREE.HemisphereLight(0xffffff, 0x354357, 2.5));
      const key = new THREE.DirectionalLight(0xffffff, 3);
      key.position.set(4, 6, 8); scene.add(key);
      const box = new THREE.Box3().setFromObject(object);
      const center = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());
      const span = Math.max(size.x, size.y, size.z, 0.01);
      object.position.sub(center); scene.add(object);
      camera.near = span / 1000; camera.far = span * 1000;
      camera.position.set(span * 1.7, span * 1.2, span * 2.2);
      const controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = false;
      controls.minDistance = span * 0.1; controls.maxDistance = span * 15;
      controls.listenToKeyEvents(renderer.domElement);
      const render = () => renderer.render(scene, camera);
      controls.addEventListener("change", render);
      const resize = () => {
        const width = element.clientWidth, height = Math.max(element.clientHeight, 280);
        if (!width) return;
        camera.aspect = width / height; camera.updateProjectionMatrix();
        renderer.setSize(width, height, false); controls.update(); render();
      };
      const observer = new ResizeObserver(resize);
      element.appendChild(renderer.domElement); observer.observe(element); resize();
      dispose = () => {
        observer.disconnect(); controls.removeEventListener("change", render);
        controls.dispose(); releaseObject(); renderer.dispose(); renderer.forceContextLoss();
        renderer.domElement.remove();
      };
      setLoading(false);
    })().catch(error => { if (!cancelled) { setError(assetError(error)); setLoading(false); } });
    return () => { cancelled = true; dispose(); };
  }, [asset.id, asset.format]);
  return <div className="asset-model-wrap">
    <div className="asset-model-canvas" ref={host} />
    {loading && <p className="asset-preview-status" role="status">3D 모델을 불러오는 중입니다.</p>}
    {error && <p className="asset-preview-status error" role="alert">미리보기 실패: {error} 파일은 그대로 보존됩니다.</p>}
    {!loading && !error && <p className="asset-model-help">드래그로 회전 · 휠로 확대 · Shift + 드래그로 이동</p>}
  </div>;
}
