/**
 * fingerprint-spoof.js — ปลอม browser fingerprint เพื่อหลบ bot detection
 *
 * inject ก่อน page scripts โหลด (document_start, MAIN world)
 * ใช้ seed จาก sessionStorage เพื่อให้ fingerprint คงที่ต่อ session
 * แต่ต่างกันระหว่าง Chrome profile/session
 *
 * override เฉพาะ API ที่ใช้ทำ fingerprint ทั่วไป:
 *   • Canvas (toDataURL / getImageData)
 *   • WebGL (RENDERER / VENDOR)
 *   • AudioContext (OfflineAudioContext)
 *   • Navigator properties
 *   • Screen dimensions
 *   • WebRTC IP leak prevention
 */

(function () {
  'use strict';

  // ╔═══════════════════════════════════════════════════════════╗
  // ║  Seed Generation — deterministic ต่อ session              ║
  // ╚═══════════════════════════════════════════════════════════╝

  const STORAGE_KEY = '__clipforge_fp_seed';
  let seed;
  try {
    seed = parseInt(sessionStorage.getItem(STORAGE_KEY), 10);
    if (!Number.isFinite(seed)) {
      seed = (Date.now() ^ (Math.random() * 0x7fffffff)) & 0x7fffffff;
      sessionStorage.setItem(STORAGE_KEY, String(seed));
    }
  } catch (_) {
    // sessionStorage ไม่พร้อม → สุ่มใหม่ทุกครั้ง (ยังดีกว่าไม่ spoof)
    seed = (Date.now() ^ (Math.random() * 0x7fffffff)) & 0x7fffffff;
  }

  /** Pseudo-random number generator (Mulberry32) — deterministic จาก seed */
  function mulberry32(s) {
    return function () {
      s |= 0; s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const rng = mulberry32(seed);

  /** เลือกค่าจาก array ตาม seed */
  function pick(arr) {
    return arr[Math.floor(rng() * arr.length)];
  }

  // ╔═══════════════════════════════════════════════════════════╗
  // ║  Canvas Fingerprint Noise                                 ║
  // ╚═══════════════════════════════════════════════════════════╝

  const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
  const origToBlob = HTMLCanvasElement.prototype.toBlob;
  const origGetImageData = CanvasRenderingContext2D.prototype.getImageData;

  /** เพิ่ม noise เล็กน้อยลง ImageData — ±1-2 RGB ใน ~0.5% ของ pixel */
  function addCanvasNoise(imageData) {
    const data = imageData.data;
    const len = data.length;
    // สุ่ม seed สำหรับ noise pattern ของ canvas นี้
    const localRng = mulberry32(seed ^ (len * 7));
    for (let i = 0; i < len; i += 4) {
      if (localRng() < 0.005) { // ~0.5% ของ pixel
        const noise = Math.floor(localRng() * 5) - 2; // -2 ถึง +2
        data[i]     = Math.max(0, Math.min(255, data[i] + noise));     // R
        data[i + 1] = Math.max(0, Math.min(255, data[i + 1] + noise)); // G
        data[i + 2] = Math.max(0, Math.min(255, data[i + 2] + noise)); // B
        // Alpha ไม่แตะ — เปลี่ยนอาจทำให้ UI พัง
      }
    }
    return imageData;
  }

  HTMLCanvasElement.prototype.toDataURL = function (...args) {
    try {
      const ctx = this.getContext('2d');
      if (ctx && this.width > 0 && this.height > 0) {
        const imageData = origGetImageData.call(ctx, 0, 0, this.width, this.height);
        addCanvasNoise(imageData);
        ctx.putImageData(imageData, 0, 0);
      }
    } catch (_) { /* canvas อาจเป็น WebGL context — ข้ามไป */ }
    return origToDataURL.apply(this, args);
  };

  HTMLCanvasElement.prototype.toBlob = function (callback, ...args) {
    try {
      const ctx = this.getContext('2d');
      if (ctx && this.width > 0 && this.height > 0) {
        const imageData = origGetImageData.call(ctx, 0, 0, this.width, this.height);
        addCanvasNoise(imageData);
        ctx.putImageData(imageData, 0, 0);
      }
    } catch (_) {}
    return origToBlob.call(this, callback, ...args);
  };

  CanvasRenderingContext2D.prototype.getImageData = function (...args) {
    const imageData = origGetImageData.apply(this, args);
    addCanvasNoise(imageData);
    return imageData;
  };

  // ╔═══════════════════════════════════════════════════════════╗
  // ║  WebGL Spoofing                                           ║
  // ╚═══════════════════════════════════════════════════════════╝

  const GPU_POOL = [
    { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
    { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 Ti Direct3D11 vs_5_0 ps_5_0, D3D11)' },
    { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
    { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
    { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon RX 580 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
    { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon RX 5700 XT Direct3D11 vs_5_0 ps_5_0, D3D11)' },
    { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
    { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  ];
  const chosenGpu = pick(GPU_POOL);

  // WEBGL_debug_renderer_info extension constants
  const UNMASKED_VENDOR_WEBGL = 0x9245;
  const UNMASKED_RENDERER_WEBGL = 0x9246;

  function patchWebGLGetParameter(proto) {
    const origGetParameter = proto.getParameter;
    proto.getParameter = function (pname) {
      if (pname === UNMASKED_VENDOR_WEBGL) return chosenGpu.vendor;
      if (pname === UNMASKED_RENDERER_WEBGL) return chosenGpu.renderer;
      return origGetParameter.call(this, pname);
    };
  }

  if (typeof WebGLRenderingContext !== 'undefined') {
    patchWebGLGetParameter(WebGLRenderingContext.prototype);
  }
  if (typeof WebGL2RenderingContext !== 'undefined') {
    patchWebGLGetParameter(WebGL2RenderingContext.prototype);
  }

  // ╔═══════════════════════════════════════════════════════════╗
  // ║  AudioContext Fingerprint Noise                           ║
  // ╚═══════════════════════════════════════════════════════════╝

  if (typeof OfflineAudioContext !== 'undefined') {
    const origStartRendering = OfflineAudioContext.prototype.startRendering;
    OfflineAudioContext.prototype.startRendering = function () {
      return origStartRendering.call(this).then((renderedBuffer) => {
        // เพิ่ม noise เล็กๆ ลง audio buffer — แทบไม่ได้ยิน แต่ hash ต่างกัน
        try {
          const channel = renderedBuffer.getChannelData(0);
          const noiseRng = mulberry32(seed ^ 0xA0D10);
          for (let i = 0; i < channel.length; i += 100) {
            channel[i] += (noiseRng() - 0.5) * 0.0001; // ±0.00005 — ไม่ได้ยิน
          }
        } catch (_) {}
        return renderedBuffer;
      });
    };
  }

  // ╔═══════════════════════════════════════════════════════════╗
  // ║  Navigator Properties                                     ║
  // ╚═══════════════════════════════════════════════════════════╝

  const spoofedConcurrency = pick([4, 6, 8, 12]);
  const spoofedMemory = pick([4, 8, 16]);
  const spoofedLanguages = pick([
    ['th', 'en-US', 'en'],
    ['th-TH', 'en-US', 'en'],
    ['th-TH', 'en'],
    ['en-US', 'th', 'en'],
  ]);

  const navOverrides = {
    hardwareConcurrency: { value: spoofedConcurrency, writable: false, configurable: true },
    deviceMemory: { value: spoofedMemory, writable: false, configurable: true },
    languages: { get: () => Object.freeze([...spoofedLanguages]), configurable: true },
    language: { get: () => spoofedLanguages[0], configurable: true },
  };

  try {
    Object.defineProperties(Navigator.prototype, navOverrides);
  } catch (_) {
    // บาง property อาจ override ไม่ได้ — ปล่อยไป
  }

  // ╔═══════════════════════════════════════════════════════════╗
  // ║  Screen Dimensions                                        ║
  // ╚═══════════════════════════════════════════════════════════╝

  const SCREEN_POOL = [
    { w: 1920, h: 1080 },
    { w: 2560, h: 1440 },
    { w: 1366, h: 768  },
    { w: 1536, h: 864  },
    { w: 1680, h: 1050 },
  ];
  const chosenScreen = pick(SCREEN_POOL);

  const screenOverrides = {
    width:       { get: () => chosenScreen.w, configurable: true },
    height:      { get: () => chosenScreen.h, configurable: true },
    availWidth:  { get: () => chosenScreen.w, configurable: true },
    availHeight: { get: () => chosenScreen.h - 40, configurable: true }, // หัก taskbar
    colorDepth:  { get: () => 24, configurable: true },
    pixelDepth:  { get: () => 24, configurable: true },
  };

  try {
    Object.defineProperties(Screen.prototype, screenOverrides);
  } catch (_) {}

  // ╔═══════════════════════════════════════════════════════════╗
  // ║  WebRTC IP Leak Prevention                                ║
  // ╚═══════════════════════════════════════════════════════════╝

  if (typeof RTCPeerConnection !== 'undefined') {
    const OrigRTC = RTCPeerConnection;
    const privateIpRegex = /\b(?:10\.\d|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.|fd[0-9a-f]{2}:)/;

    // eslint-disable-next-line no-global-assign
    window.RTCPeerConnection = function (config, constraints) {
      // บังคับใช้ mDNS candidates เท่านั้น (ป้องกัน local IP leak)
      if (config && config.iceServers) {
        // ปล่อย iceServers ตามเดิม — แค่ filter candidate ที่ leak IP
      }
      const pc = new OrigRTC(config, constraints);

      // Override onicecandidate เพื่อ filter private IPs
      const origAddEventListener = pc.addEventListener.bind(pc);
      pc.addEventListener = function (type, listener, options) {
        if (type === 'icecandidate') {
          const wrappedListener = function (event) {
            if (event.candidate && event.candidate.candidate) {
              const candidateStr = event.candidate.candidate;
              // ตัด candidate ที่มี private IP — เหลือแค่ mDNS (.local)
              if (privateIpRegex.test(candidateStr)) return;
            }
            listener.call(this, event);
          };
          return origAddEventListener(type, wrappedListener, options);
        }
        return origAddEventListener(type, listener, options);
      };

      return pc;
    };
    window.RTCPeerConnection.prototype = OrigRTC.prototype;
    Object.defineProperty(window, 'RTCPeerConnection', {
      writable: true, configurable: true,
    });
  }

  // ╔═══════════════════════════════════════════════════════════╗
  // ║  Debug Log (development only)                             ║
  // ╚═══════════════════════════════════════════════════════════╝

  // console.debug('[ClipForge FP] spoofed:', {
  //   seed, gpu: chosenGpu.renderer, screen: chosenScreen,
  //   cores: spoofedConcurrency, memory: spoofedMemory, languages: spoofedLanguages,
  // });
})();
