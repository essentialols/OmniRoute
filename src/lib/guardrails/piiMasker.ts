import { BaseGuardrail, type GuardrailContext, type GuardrailResult } from "./base";
import { processPII } from "@/shared/utils/inputSanitizer";
import { sanitizePII, sanitizePIIResponse } from "@/lib/piiSanitizer";
import { hasExplicitPiiOverride, shouldRedactPiiForProvider } from "./piiTrust";

type PiiDetection = {
  count: number;
  type: string;
};

type JsonRecord = Record<string, unknown>;

/**
 * Request-side masking decision for a destination provider.
 * - Explicit global override on PII_REDACTION_ENABLED preserves legacy behavior
 *   (flag on AND INPUT_SANITIZER_MODE=redact).
 * - Otherwise the trust-tiered default applies: redact untrusted providers.
 */
function isRequestPiiMaskingEnabled(provider?: string | null): boolean {
  if (hasExplicitPiiOverride("PII_REDACTION_ENABLED")) {
    return (
      process.env.PII_REDACTION_ENABLED === "true" && process.env.INPUT_SANITIZER_MODE === "redact"
    );
  }
  return shouldRedactPiiForProvider(provider ?? null, "PII_REDACTION_ENABLED");
}

function sanitizeStringValue(text: string, enabled: boolean) {
  const result = processPII(text, enabled);
  return {
    detections: result.detections,
    modified: result.text !== text,
    text: result.text,
  };
}

function applyToContentValue(
  value: unknown,
  detections: PiiDetection[],
  enabled: boolean
): { modified: boolean; value: unknown } {
  if (typeof value === "string") {
    const result = sanitizeStringValue(value, enabled);
    detections.push(...result.detections);
    return {
      modified: result.modified,
      value: result.text,
    };
  }

  if (Array.isArray(value)) {
    let modified = false;
    const nextValue = value.map((entry) => {
      if (typeof entry === "string") {
        const result = sanitizeStringValue(entry, enabled);
        detections.push(...result.detections);
        modified ||= result.modified;
        return result.text;
      }

      if (entry && typeof entry === "object") {
        const record = { ...(entry as JsonRecord) };
        if (typeof record.text === "string") {
          const result = sanitizeStringValue(record.text, enabled);
          detections.push(...result.detections);
          modified ||= result.modified;
          record.text = result.text;
        }
        if (typeof record.content === "string") {
          const result = sanitizeStringValue(record.content, enabled);
          detections.push(...result.detections);
          modified ||= result.modified;
          record.content = result.text;
        }
        return record;
      }

      return entry;
    });
    return { modified, value: nextValue };
  }

  return { modified: false, value };
}

function cloneAndMaskRequestPayload(payload: unknown, enabled: boolean) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { detections: [] as PiiDetection[], modified: false, payload };
  }

  const clonedPayload: JsonRecord = JSON.parse(JSON.stringify(payload));
  const detections: PiiDetection[] = [];
  let modified = false;

  const sanitizeMessageLikeList = (list: unknown) => {
    if (!Array.isArray(list)) return list;
    return list.map((entry) => {
      if (!entry || typeof entry !== "object") return entry;
      const record = { ...(entry as JsonRecord) };
      if ("content" in record) {
        const result = applyToContentValue(record.content, detections, enabled);
        modified ||= result.modified;
        record.content = result.value;
      }
      if (typeof record.text === "string") {
        const result = sanitizeStringValue(record.text, enabled);
        detections.push(...result.detections);
        modified ||= result.modified;
        record.text = result.text;
      }
      return record;
    });
  };

  if (typeof clonedPayload.system === "string") {
    const result = sanitizeStringValue(clonedPayload.system, enabled);
    detections.push(...result.detections);
    modified ||= result.modified;
    clonedPayload.system = result.text;
  } else if (Array.isArray(clonedPayload.system)) {
    clonedPayload.system = sanitizeMessageLikeList(clonedPayload.system);
  }

  if (Array.isArray(clonedPayload.messages)) {
    clonedPayload.messages = sanitizeMessageLikeList(clonedPayload.messages);
  }

  if (Array.isArray(clonedPayload.input)) {
    clonedPayload.input = sanitizeMessageLikeList(clonedPayload.input);
  }

  return {
    detections,
    modified,
    payload: modified ? clonedPayload : payload,
  };
}

function maskResponsesOutput(response: JsonRecord, forceEnabled?: boolean) {
  let modified = false;

  if (typeof response.output_text === "string") {
    const result = sanitizePII(response.output_text, false, forceEnabled);
    if (result.redacted) {
      response.output_text = result.text;
      modified = true;
    }
  }

  if (Array.isArray(response.output)) {
    response.output = response.output.map((item) => {
      if (!item || typeof item !== "object") return item;
      const nextItem = { ...(item as JsonRecord) };
      if (Array.isArray(nextItem.content)) {
        nextItem.content = nextItem.content.map((part) => {
          if (!part || typeof part !== "object") return part;
          const nextPart = { ...(part as JsonRecord) };
          if (typeof nextPart.text === "string") {
            const result = sanitizePII(nextPart.text, false, forceEnabled);
            if (result.redacted) {
              nextPart.text = result.text;
              modified = true;
            }
          }
          return nextPart;
        });
      }
      return nextItem;
    });
  }

  return modified;
}

export class PIIMaskerGuardrail extends BaseGuardrail {
  constructor(options: { enabled?: boolean; priority?: number } = {}) {
    super("pii-masker", {
      enabled: options.enabled,
      priority: options.priority ?? 10,
    });
  }

  async preCall(payload: unknown, context?: GuardrailContext): Promise<GuardrailResult<unknown>> {
    const enabled = isRequestPiiMaskingEnabled(context?.provider ?? null);
    const result = cloneAndMaskRequestPayload(payload, enabled);
    if (!result.modified) {
      return {
        block: false,
        meta: result.detections.length > 0 ? { detections: result.detections.length } : null,
      };
    }

    return {
      block: false,
      meta: { detections: result.detections.length, redacted: true },
      modifiedPayload: result.payload,
    };
  }

  async postCall(response: unknown, context?: GuardrailContext): Promise<GuardrailResult<unknown>> {
    if (!response || typeof response !== "object" || Array.isArray(response)) {
      return { block: false };
    }

    const responseEnabled = shouldRedactPiiForProvider(
      context?.provider ?? null,
      "PII_RESPONSE_SANITIZATION"
    );
    const clonedResponse = JSON.parse(JSON.stringify(response)) as JsonRecord;
    const before = JSON.stringify(clonedResponse);
    const sanitized = sanitizePIIResponse(clonedResponse, responseEnabled) as JsonRecord;
    const modifiedResponsesShape = maskResponsesOutput(sanitized, responseEnabled);
    const after = JSON.stringify(sanitized);
    const modified = before !== after || modifiedResponsesShape;

    if (!modified) return { block: false };

    return {
      block: false,
      meta: { redacted: true },
      modifiedResponse: sanitized,
    };
  }
}
