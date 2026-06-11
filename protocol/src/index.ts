// @pigeon/protocol — the Pigeon API, as a library.
//
// The loft (one `loftd` per node) is a general frame-plane API; a visualizer is
// just a *consumer*. This package is that consumer contract in code: the wire
// types, the header decoder, and two Bridge implementations (live loft + an
// offline sim). Every game — the belt/pigeon factory, the ball pit, anything
// next — builds on exactly this, which is what keeps the API honest.
//
// See docs/pigeon-api.md for the wire protocol this implements.
export type {
  PortInfo,
  FrameToken,
  DropCounters,
  PortStats,
  LoftStats,
  BridgeEvents,
  Bridge,
} from './types';

export type { FrameKind, Decoded } from './decode';
export { decodeFrame, hexDump, KIND_COLORS } from './decode';

export { WsBridge, defaultBridgeUrl } from './wsbridge';
export { SimBridge } from './simbridge';
