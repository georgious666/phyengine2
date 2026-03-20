/// <reference lib="webworker" />

import { SimulationCore } from "./SimulationCore";
import type {
  SimulationWorkerRequest,
  SimulationWorkerResponse
} from "./workerProtocol";

let simulation: SimulationCore | null = null;

function postFrame(snapshot: ReturnType<SimulationCore["getSnapshot"]>): void {
  const packedPoints = snapshot.packedPoints.buffer as ArrayBuffer;
  const message: SimulationWorkerResponse = {
    type: "frame",
    clusters: snapshot.clusters,
    packedPoints,
    pointCount: snapshot.pointCount,
    frameState: snapshot.frameState
  };

  self.postMessage(message, [packedPoints]);
}

self.onmessage = (event: MessageEvent<SimulationWorkerRequest>) => {
  try {
    const message = event.data;
    switch (message.type) {
      case "init": {
        simulation = new SimulationCore(message.config, message.preset);
        postFrame(simulation.getSnapshot());
        break;
      }
      case "loadPreset": {
        if (!simulation) {
          throw new Error("Simulation worker is not initialized.");
        }
        postFrame(simulation.loadPreset(message.preset));
        break;
      }
      case "updateConfig": {
        if (!simulation) {
          throw new Error("Simulation worker is not initialized.");
        }
        postFrame(simulation.updateConfig(message.config));
        break;
      }
      case "step": {
        if (!simulation) {
          throw new Error("Simulation worker is not initialized.");
        }
        postFrame(simulation.step(message.dt));
        break;
      }
      case "dispose": {
        simulation = null;
        self.close();
        break;
      }
    }
  } catch (error) {
    const response: SimulationWorkerResponse = {
      type: "error",
      message: error instanceof Error ? error.message : "Simulation worker failed."
    };
    self.postMessage(response);
  }
};
