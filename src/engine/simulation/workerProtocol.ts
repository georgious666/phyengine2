import type {
  EngineConfig,
  EngineFrameState,
  FieldClusterSpec,
  ScenePreset
} from "../types";

export type SimulationWorkerRequest =
  | {
      type: "init";
      config: Partial<EngineConfig> | undefined;
      preset: ScenePreset;
    }
  | {
      type: "loadPreset";
      preset: ScenePreset;
    }
  | {
      type: "updateConfig";
      config: Partial<EngineConfig>;
    }
  | {
      type: "step";
      dt: number;
    }
  | {
      type: "dispose";
    };

export type SimulationWorkerResponse =
  | {
      type: "frame";
      clusters: FieldClusterSpec[];
      packedPoints: ArrayBuffer;
      pointCount: number;
      frameState: EngineFrameState;
    }
  | {
      type: "error";
      message: string;
    };
