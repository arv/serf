// Code-split doorway for this map (see ../missionMaps.ts): the JSON rides
// a STATIC import because the attribute must be visible to plain node,
// while Vite's dev server can only strip attributes from static edges —
// a dynamic `import(json, { with })` reaches the browser's strict JSON
// MIME check and fails. Dynamic-importing this wrapper instead keeps
// every runtime happy and splits the chunk at the same boundary.
import map from './holdTheValley.json' with { type: 'json' };
export default map;
