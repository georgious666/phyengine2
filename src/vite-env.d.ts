/// <reference types="vite/client" />
/// <reference types="@webgpu/types" />

declare module "*.wgsl?raw" {
  const shaderSource: string;
  export default shaderSource;
}
