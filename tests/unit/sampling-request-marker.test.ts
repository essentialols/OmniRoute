import test from "node:test";
import assert from "node:assert/strict";

const { normalizeSamplingRequest } = await import("../../src/shared/sampling/requestMarker.ts");

test("sampling marker is parsed and stripped from the model id", () => {
  const out = normalizeSamplingRequest({
    model:
      "h1/pym-q2-abliterated@sampling(temperature=1.0,top_p=0.95,top_k=20,min_p=0,presence_penalty=1.5)",
    messages: [{ role: "user", content: "hi" }],
  }) as Record<string, unknown>;

  assert.equal(out.model, "h1/pym-q2-abliterated");
  assert.equal(out.temperature, 1);
  assert.equal(out.top_p, 0.95);
  assert.equal(out.top_k, 20);
  assert.equal(out.min_p, 0);
  assert.equal(out.presence_penalty, 1.5);
});

test("explicit client sampling values are not overwritten by marker values", () => {
  const out = normalizeSamplingRequest({
    model: "h1/model@sampling(temperature=1.8,top_p=0.2,presence_penalty=1.5)",
    temperature: 0.4,
    top_p: 0.8,
    presence_penalty: 0,
  }) as Record<string, unknown>;

  assert.equal(out.model, "h1/model");
  assert.equal(out.temperature, 0.4);
  assert.equal(out.top_p, 0.8);
  assert.equal(out.presence_penalty, 0);
});

test("unknown keys are ignored and malformed numeric values are dropped", () => {
  const out = normalizeSamplingRequest({
    model: "h1/model@sampling(temperature=abc,unknown=1,seed=42,frequency_penalty=0.5)",
  }) as Record<string, unknown>;

  assert.equal(out.model, "h1/model");
  assert.equal(out.temperature, undefined);
  assert.equal(out.unknown, undefined);
  assert.equal(out.seed, 42);
  assert.equal(out.frequency_penalty, 0.5);
});

test("sampling values are clamped to safe per-key ranges", () => {
  const out = normalizeSamplingRequest({
    model:
      "h1/model@sampling(temperature=99,top_p=-1,top_k=20.9,min_p=2,presence_penalty=-9,frequency_penalty=9,repeat_penalty=9,seed=123.9)",
  }) as Record<string, unknown>;

  assert.equal(out.temperature, 2);
  assert.equal(out.top_p, 0);
  assert.equal(out.top_k, 20);
  assert.equal(out.min_p, 1);
  assert.equal(out.presence_penalty, -2);
  assert.equal(out.frequency_penalty, 2);
  assert.equal(out.repeat_penalty, 2);
  assert.equal(out.seed, 123);
});

test("malformed sampling markers do not throw or mutate", () => {
  const body = { model: "h1/model@sampling(temperature=1.0" };
  const out = normalizeSamplingRequest(body);

  assert.equal(out, body);
});

test("non-string model values do not throw or mutate", () => {
  const body = { model: 123, temperature: 0.4 };
  const out = normalizeSamplingRequest(body);

  assert.equal(out, body);
});

test("body without sampling marker returns the same reference", () => {
  const body = { model: "h1/model", temperature: 0.4 };
  const out = normalizeSamplingRequest(body);

  assert.equal(out, body);
});
