export interface WebGpuContextResources {
  device: GPUDevice;
  queue: GPUQueue;
  canvasContext: GPUCanvasContext;
  format: GPUTextureFormat;
}

export async function createWebGpuContext(canvas: HTMLCanvasElement): Promise<WebGpuContextResources> {
  if (!("gpu" in navigator)) {
    throw new Error("WebGPU is not available. Open this app in desktop Chrome or Edge with WebGPU enabled.");
  }
  const gpuNavigator = navigator as Navigator & { gpu: GPU };

  const adapter = await gpuNavigator.gpu.requestAdapter({
    powerPreference: "high-performance"
  });
  if (!adapter) {
    throw new Error("Failed to acquire a WebGPU adapter. Check that hardware acceleration and WebGPU are enabled.");
  }

  const device = await adapter.requestDevice();
  const canvasContext = canvas.getContext("webgpu") as GPUCanvasContext | null;
  if (!canvasContext) {
    throw new Error("Failed to acquire a WebGPU canvas context from the browser.");
  }

  const format = gpuNavigator.gpu.getPreferredCanvasFormat();
  canvasContext.configure({
    device,
    format,
    alphaMode: "premultiplied"
  });

  return {
    device,
    queue: device.queue,
    canvasContext,
    format
  };
}
