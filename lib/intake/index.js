// @zanii/intake — public API.
//
// Universal inbound conveyor. Adapters import these primitives and wire
// them into their bot's ingest route. The package itself holds zero
// tenant-specific knowledge — keys, storage paths, and feature flags are
// passed in per call.
//
// v0.1 surface: voice transcription (OpenAI gpt-4o-transcribe).
// Subsequent versions add image captioning (Haiku Vision), PDF/doc text
// extraction, parsePaymentAll, parseTasks, reaction→complete, quote-reply
// context, @mention name resolution.
export { transcribeAudio } from "./transcribe.js";
export { captionImage } from "./caption-image.js";
export { extractTextFromBuffer } from "./extract-text.js";
//# sourceMappingURL=index.js.map