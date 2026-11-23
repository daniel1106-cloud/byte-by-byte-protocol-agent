// N08: 명세 JSON(web/spec/*.json)을 읽어 요청 프레임을 만들고 응답 프레임을 해석한다.
// 소켓을 모른다. 바이트와 명세만 다루므로 send/recv 경계와 무관하게 검증할 수 있다.
import { readFileSync } from "node:fs";

const KIND_SIZE = { u8: 1, u16: 2, u32: 4 };

export class SpecError extends Error {}

export class InputError extends Error {
  constructor(message) {
    super(message);
    this.name = "InputError";
  }
}

export function loadSpec(path) {
  const spec = JSON.parse(readFileSync(path, "utf8"));
  validateSpec(spec);
  return spec;
}

function need(condition, message) {
  if (!condition) throw new SpecError(`명세 오류: ${message}`);
}

const isHex = (text, bytes) => typeof text === "string" && text.length === bytes * 2 && /^[0-9a-f]+$/.test(text);

export function validateSpec(spec) {
  need(spec && typeof spec === "object", "객체가 아님");
  need(spec.transport?.byte_order === "big", "transport.byte_order는 big만 지원한다");
  const header = spec.header;
  need(Number.isInteger(header?.size) && header.size > 0, "header.size");
  need(Array.isArray(header.fields) && header.fields.length > 0, "header.fields");
  let offset = 0;
  let typeFields = 0;
  let lengthFields = 0;
  for (const field of header.fields) {
    need(field.offset === offset, `header 필드 ${field.name}의 offset이 이어지지 않는다`);
    need(Number.isInteger(field.size) && field.size > 0, `header 필드 ${field.name}의 size`);
    if (field.kind === "const") need(isHex(field.value, field.size), `${field.name}의 const 값`);
    else if (field.kind === "type") typeFields += 1;
    else if (field.kind === "length") lengthFields += 1;
    else need(false, `header 필드 ${field.name}의 kind ${field.kind}`);
    offset += field.size;
  }
  need(offset === header.size, "header 필드 크기의 합이 header.size와 다르다");
  need(typeFields === 1 && lengthFields === 1, "type 필드와 length 필드는 각각 하나여야 한다");
  const typeSize = header.fields.find((f) => f.kind === "type").size;

  need(Array.isArray(spec.messages?.request) && spec.messages.request.length > 0, "messages.request");
  for (const message of spec.messages.request) {
    need(isHex(message.type, typeSize), `요청 type ${message.type}`);
    const payload = message.payload;
    need(payload?.layout === "array" && payload.element in KIND_SIZE, `요청 ${message.name}의 payload`);
    need(Number.isInteger(payload.min_count) && Number.isInteger(payload.max_count) &&
      payload.min_count >= 0 && payload.min_count <= payload.max_count, `요청 ${message.name}의 개수 범위`);
  }
  need(Array.isArray(spec.messages?.response) && spec.messages.response.length > 0, "messages.response");
  for (const message of spec.messages.response) {
    need(isHex(message.type, typeSize), `응답 type ${message.type}`);
    need(message.payload?.layout === "fields" && Array.isArray(message.payload.fields), `응답 ${message.name}의 payload`);
    for (const field of message.payload.fields) need(field.kind in KIND_SIZE, `응답 필드 ${field.name}의 kind`);
  }
  return spec;
}

export const toHex = (buffer) => Buffer.from(buffer).toString("hex");

function readUint(buffer, offset, size) {
  let value = 0;
  for (let i = 0; i < size; i += 1) value = value * 256 + buffer[offset + i];
  return value;
}

function writeUint(buffer, offset, size, value) {
  let rest = value;
  for (let i = size - 1; i >= 0; i -= 1) {
    buffer[offset + i] = rest % 256;
    rest = Math.floor(rest / 256);
  }
}

const headerFields = (spec) => spec.header.fields;
const typeField = (spec) => headerFields(spec).find((f) => f.kind === "type");
const lengthField = (spec) => headerFields(spec).find((f) => f.kind === "length");

export const headerSize = (spec) => spec.header.size;

/**
 * 요청 프레임을 만든다.
 * options.minCount: 웹 입력 규칙이 명세보다 좁을 때(웹은 1개 이상) 쓴다.
 */
export function encodeRequest(spec, numbers, options = {}) {
  const message = spec.messages.request[0];
  const { element, min_count: specMin, max_count: maxCount } = message.payload;
  const minCount = Math.max(specMin, options.minCount ?? specMin);
  const elementSize = KIND_SIZE[element];
  const maxValue = 2 ** (8 * elementSize) - 1;

  if (!Array.isArray(numbers)) throw new InputError("numbers는 숫자 배열이어야 합니다.");
  if (numbers.length < minCount || numbers.length > maxCount) {
    throw new InputError(`숫자는 ${minCount}~${maxCount}개여야 합니다. (받은 개수: ${numbers.length})`);
  }
  numbers.forEach((value, index) => {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > maxValue) {
      throw new InputError(`${index + 1}번째 값은 0~${maxValue} 범위의 정수여야 합니다.`);
    }
  });

  const payloadLength = numbers.length * elementSize;
  const bytes = Buffer.alloc(headerSize(spec) + payloadLength);
  const fields = [];
  for (const field of headerFields(spec)) {
    if (field.kind === "const") {
      Buffer.from(field.value, "hex").copy(bytes, field.offset);
      fields.push({ name: field.name, offset: field.offset, size: field.size, hex: field.value, value: field.value });
    } else if (field.kind === "type") {
      Buffer.from(message.type, "hex").copy(bytes, field.offset);
      fields.push({ name: field.name, offset: field.offset, size: field.size, hex: message.type, value: message.name });
    } else {
      writeUint(bytes, field.offset, field.size, payloadLength);
      fields.push({
        name: field.name, offset: field.offset, size: field.size,
        hex: toHex(bytes.subarray(field.offset, field.offset + field.size)), value: payloadLength,
      });
    }
  }
  numbers.forEach((value, index) => {
    const offset = headerSize(spec) + index * elementSize;
    writeUint(bytes, offset, elementSize, value);
    fields.push({ name: `value[${index}]`, offset, size: elementSize, hex: toHex(bytes.subarray(offset, offset + elementSize)), value });
  });
  return { message: message.name, bytes, hex: toHex(bytes), fields };
}

export function responsePayloadSize(message) {
  return message.payload.fields.reduce((sum, field) => sum + KIND_SIZE[field.kind], 0);
}

/**
 * 헤더만 보고 이 응답이 명세에 맞는지, payload가 몇 바이트인지 알려 준다.
 * 호출자는 헤더 크기만큼 모은 뒤 이 함수를 쓴다(조각이 어디서 나뉘든 상관없다).
 */
export function parseResponseHeader(spec, header) {
  if (header.length < headerSize(spec)) throw new RangeError("헤더를 다 모으기 전에 호출했다");
  for (const field of headerFields(spec)) {
    if (field.kind !== "const") continue;
    const actual = toHex(header.subarray(field.offset, field.offset + field.size));
    if (actual !== field.value) {
      return { ok: false, reason: `응답의 ${field.name}이 ${field.value}가 아니라 ${actual}입니다.`, field: field.name };
    }
  }
  const tf = typeField(spec);
  const typeHex = toHex(header.subarray(tf.offset, tf.offset + tf.size));
  const message = spec.messages.response.find((m) => m.type === typeHex);
  if (!message) return { ok: false, reason: `명세에 없는 응답 type ${typeHex}입니다.`, field: tf.name };
  const lf = lengthField(spec);
  const length = readUint(header, lf.offset, lf.size);
  const expected = responsePayloadSize(message);
  if (length !== expected) {
    return { ok: false, reason: `${message.name}의 length가 ${expected}여야 하는데 ${length}입니다.`, field: lf.name };
  }
  return { ok: true, message, typeHex, payloadLength: length, totalLength: headerSize(spec) + length };
}

/** 완전한 응답 프레임 하나를 해석한다. frame은 정확히 header+payload 길이여야 한다. */
export function decodeResponse(spec, frame) {
  const parsed = parseResponseHeader(spec, frame);
  if (!parsed.ok) return { ok: false, reason: parsed.reason, field: parsed.field, hex: toHex(frame) };
  if (frame.length !== parsed.totalLength) {
    return { ok: false, reason: `프레임 길이가 ${parsed.totalLength}바이트여야 하는데 ${frame.length}바이트입니다.`, field: "length", hex: toHex(frame) };
  }
  const { message } = parsed;
  const fields = headerFields(spec).map((field) => {
    const hex = toHex(frame.subarray(field.offset, field.offset + field.size));
    let value = hex;
    if (field.kind === "type") value = message.name;
    if (field.kind === "length") value = readUint(frame, field.offset, field.size);
    return { name: field.name, offset: field.offset, size: field.size, hex, value };
  });
  const values = {};
  const meanings = {};
  let offset = headerSize(spec);
  for (const field of message.payload.fields) {
    const size = KIND_SIZE[field.kind];
    const value = readUint(frame, offset, size);
    const hex = toHex(frame.subarray(offset, offset + size));
    const entry = { name: field.name, offset, size, hex, value };
    if (field.values) {
      const meaning = field.values[hex] ?? null;
      entry.meaning = meaning;
      meanings[field.name] = meaning;
    }
    fields.push(entry);
    values[field.name] = value;
    offset += size;
  }
  const text = `${message.name}: ` + message.payload.fields
    .map((f) => `${f.name}=${values[f.name]}${meanings[f.name] ? ` (${meanings[f.name]})` : f.values ? " (명세에 없는 코드)" : ""}`)
    .join(", ");
  return { ok: true, message: message.name, type: parsed.typeHex, values, meanings, fields, text, hex: toHex(frame) };
}
