import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { Box, LoaderCircle, RotateCcw } from 'lucide-react';

export function ModelCanvas({ src, filename }: { src: string; filename: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [resetKey, setResetKey] = useState(0);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let active = true;
    setError('');
    setLoaded(false);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#e9eee8');
    const camera = new THREE.PerspectiveCamera(38, element.clientWidth / Math.max(element.clientHeight, 1), 0.01, 1000);
    camera.position.set(3.1, 2.5, 4.1);
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(element.clientWidth, element.clientHeight);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    element.replaceChildren(renderer.domElement);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    scene.add(new THREE.HemisphereLight('#fffaf0', '#738177', 2.2));
    const keyLight = new THREE.DirectionalLight('#ffffff', 2.5);
    keyLight.position.set(4, 6, 5);
    scene.add(keyLight);
    const grid = new THREE.GridHelper(8, 32, '#9faea2', '#d0d8d0');
    grid.position.y = -1.1;
    scene.add(grid);
    const onResize = () => {
      if (!element.clientWidth || !element.clientHeight) return;
      camera.aspect = element.clientWidth / element.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(element.clientWidth, element.clientHeight);
    };
    const observer = new ResizeObserver(onResize);
    observer.observe(element);
    const frame = () => {
      if (!active) return;
      controls.update();
      renderer.render(scene, camera);
      requestAnimationFrame(frame);
    };
    frame();
    const fitObject = (object: THREE.Object3D) => {
      const bounds = new THREE.Box3().setFromObject(object);
      const size = bounds.getSize(new THREE.Vector3());
      const center = bounds.getCenter(new THREE.Vector3());
      object.position.sub(center);
      const maxDimension = Math.max(size.x, size.y, size.z) || 1;
      object.scale.multiplyScalar(2.4 / maxDimension);
      scene.add(object);
      controls.target.set(0, 0, 0);
      controls.update();
      setLoaded(true);
    };
    const ext = filename.split('.').pop()?.toLowerCase();
    if (ext === 'stl') {
      new STLLoader().load(src, geometry => {
        if (!active) return;
        geometry.computeVertexNormals();
        fitObject(new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: '#557c6b', metalness: 0.18, roughness: 0.42 })));
      }, undefined, () => active && setError('This STL could not be loaded. Replace it with a valid model file.'));
    } else if (ext === 'glb') {
      new GLTFLoader().load(src, gltf => active && fitObject(gltf.scene), undefined, () => active && setError('This GLB could not be loaded. Replace it with a valid model file.'));
    } else setError('Unsupported model format. Use a GLB or STL file.');
    return () => {
      active = false;
      observer.disconnect();
      controls.dispose();
      renderer.dispose();
      scene.traverse(object => {
        const mesh = object as THREE.Mesh;
        mesh.geometry?.dispose?.();
        if (Array.isArray(mesh.material)) mesh.material.forEach(material => material.dispose());
        else mesh.material?.dispose?.();
      });
    };
  }, [src, filename, resetKey]);

  return <div className="model-viewer-wrap">
    <div className="model-viewer" ref={host} aria-label="Interactive 3D model viewer" role="img" />
    {!loaded && !error && <div className="model-loading"><LoaderCircle className="spin" size={18}/><span>Loading model geometry…</span></div>}
    {error && <div className="model-error"><Box size={21}/><strong>Model preview unavailable</strong><span>{error}</span></div>}
    <button type="button" className="model-reset" onClick={() => setResetKey(key => key + 1)} aria-label="Reset 3D model view"><RotateCcw size={14}/><span>Reset view</span></button>
    <span className="model-hint">Drag to orbit · Scroll to zoom</span>
  </div>;
}
