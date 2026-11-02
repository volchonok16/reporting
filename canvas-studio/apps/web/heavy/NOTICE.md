# Heavy files (not in the release; deploy.sh puts them once into /opt/canvas-studio/heavy)

The one exception to «everything our own»: the neural network for «Удалить фон» (decided 1 November 2026).
Names carry a version or a content hash, so a file never changes under its name (cached for a year).

- `ort-1.20.1/` — ONNX Runtime Web 1.20.1 (Microsoft), MIT license: https://github.com/microsoft/onnxruntime/blob/v1.20.1/LICENSE
  `ort.webgpu.min.mjs`, `ort-wasm-simd-threaded.jsep.mjs`, `ort-wasm-simd-threaded.jsep.wasm` from the npm package `onnxruntime-web@1.20.1`, unchanged.
- `isnet-u8-<hash>.onnx` — IS-Net «general use» (Highly Accurate Dichotomous Image Segmentation, Xuebin Qin et al.), Apache-2.0: https://github.com/xuebinqin/DIS
  Taken as `isnet-general-use.onnx` (sha256 60920e99c45464f2ba57bee2ad08c919a52bbf852739e96947fbb4358c0d964a, from rembg's releases);
  its convolution weights stored as uint8 per output channel with DequantizeLinear (178 → 47 MB; masks agree with the original at IoU ≥ 0.995 on test photos),
  only the main output kept. Input 1×3×1024×1024, RGB/255 − 0.5; output 1×1×1024×1024.
