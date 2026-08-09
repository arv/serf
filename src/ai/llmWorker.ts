/// <reference lib="webworker" />
import { WebWorkerMLCEngineHandler } from '@mlc-ai/web-llm';

/**
 * The inference worker: WebLLM's engine runs here, on WebGPU, so a model
 * chewing on a prompt never touches the main thread's frame budget — let
 * alone the sim worker's tick. The handler speaks WebLLM's own message
 * protocol with CreateWebWorkerMLCEngine on the main thread (strategist.ts);
 * nothing of the game's exists on this side.
 *
 * A static import is fine here: Vite gives a worker entry its own chunk
 * graph, fetched only when the strategist actually constructs the worker.
 */
const handler = new WebWorkerMLCEngineHandler();
self.onmessage = (msg: MessageEvent) => handler.onmessage(msg);
