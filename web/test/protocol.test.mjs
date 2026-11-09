import assert from "node:assert/strict";
import test from "node:test";
import { InputError, SpecError, decodeResponse, encodeRequest, parseResponseHeader, toHex, validateSpec } from "../lib/protocol.mjs";
import { spec } from "./helpers.mjs";

// README의 정상 세션 5개 (practice/n06/README.md)
const README_SESSIONS = [
  { input: [1, 2, 3], request: "424201010006000100020003", response: "42420181000400000006", sum: 6 },
  { input: [10, 20], request: "424201010004000a0014", response: "4242018100040000001e", sum: 30 },
  { input: [65535, 65535], request: "424201010004ffffffff", response: "4242018100040001fffe", sum: 131070 },
  { input: [1000], request: "42420101000203e8", response: "424201810004000003e8", sum: 1000 },
  { input: [7, 7, 7, 7, 7], request: "42420101000a00070007000700070007", response: "42420181000400000023", sum: 35 },
];

test("encodeRequest: README 정상 세션 5개의 요청 hex와 같다", () => {
  for (const session of README_SESSIONS) {
    assert.equal(encodeRequest(spec, session.input, { minCount: 1 }).hex, session.request, session.input.join(" "));
  }
});

test("decodeResponse: README 정상 세션 5개의 합계를 해석한다", () => {
  for (const session of README_SESSIONS) {
    const decoded = decodeResponse(spec, Buffer.from(session.response, "hex"));
    assert.equal(decoded.ok, true);
    assert.equal(decoded.message, "SUM_RESPONSE");
    assert.equal(decoded.values.sum, session.sum);
  }
});

test("encodeRequest: 32개(최대)는 length 0x0040, 33개는 거절", () => {
  const max = encodeRequest(spec, Array(32).fill(65535), { minCount: 1 });
  assert.equal(max.hex.slice(0, 12), "424201010040");
  assert.equal(max.bytes.length, 6 + 64);
  assert.throws(() => encodeRequest(spec, Array(33).fill(1), { minCount: 1 }), InputError);
});

test("encodeRequest: 입력 검증 (개수·범위·정수·타입)", () => {
  const bad = [
    [], [-1], [65536], [1.5], ["1"], [null], [NaN], [Infinity], [true], [[1]], [{}], [1, 2, "3"],
    "1 2 3", null, undefined, 5, { 0: 1, length: 1 },
  ];
  for (const value of bad) {
    assert.throws(() => encodeRequest(spec, value, { minCount: 1 }), InputError, JSON.stringify(value));
  }
  // 명세는 0개를 허용하므로 minCount 없이는 빈 payload 요청이 만들어진다(웹은 minCount 1로 막는다).
  assert.equal(encodeRequest(spec, []).hex, "424201010000");
  assert.equal(encodeRequest(spec, [0, 65535], { minCount: 1 }).hex, "424201010004" + "0000ffff");
});

test("encodeRequest: 필드 주석이 바이트와 일치한다", () => {
  const request = encodeRequest(spec, [1, 2, 3], { minCount: 1 });
  assert.deepEqual(request.fields.map((f) => f.name), ["magic", "version", "type", "length", "value[0]", "value[1]", "value[2]"]);
  assert.equal(request.fields.map((f) => f.hex).join(""), request.hex);
  assert.equal(request.fields.find((f) => f.name === "length").value, 6);
});

test("decodeResponse: 오류 프레임 4종과 명세에 없는 코드", () => {
  for (const [code, text] of [["01", "bad magic"], ["02", "bad version"], ["03", "bad type"], ["04", "bad length"]]) {
    const decoded = decodeResponse(spec, Buffer.from(`424201ff0001${code}`, "hex"));
    assert.equal(decoded.ok, true);
    assert.equal(decoded.message, "ERROR");
    assert.equal(decoded.values.code, Number(code));
    assert.match(decoded.meanings.code, new RegExp(text));
  }
  const unknown = decodeResponse(spec, Buffer.from("424201ff000199", "hex"));
  assert.equal(unknown.ok, true);
  assert.equal(unknown.meanings.code, null);
  assert.match(unknown.text, /명세에 없는 코드/);
});

test("parseResponseHeader: 명세와 다른 응답을 가려낸다", () => {
  const header = (hex) => parseResponseHeader(spec, Buffer.from(hex, "hex"));
  assert.equal(header("424201810004").ok, true);
  assert.equal(header("424201810004").totalLength, 10);
  assert.equal(header("424201ff0001").totalLength, 7);
  assert.match(header("414201810004").reason, /magic/);
  assert.match(header("424202810004").reason, /version/);
  assert.match(header("424201770004").reason, /type/);
  assert.match(header("424201810005").reason, /length/); // SUM_RESPONSE의 length는 4여야 한다
  assert.match(header("424201ff0002").reason, /length/);
  assert.throws(() => header("4242"), RangeError); // 헤더를 다 모으기 전에는 해석하지 않는다
});

test("decodeResponse: 프레임 길이가 헤더와 다르면 거절", () => {
  assert.equal(decodeResponse(spec, Buffer.from("424201810004000000", "hex")).ok, false);
  assert.equal(decodeResponse(spec, Buffer.from("42420181000400000006ff", "hex")).ok, false);
});

test("validateSpec: 깨진 명세를 거절한다", () => {
  const clone = () => JSON.parse(JSON.stringify(spec));
  const broken = clone();
  broken.header.fields[1].offset = 5;
  assert.throws(() => validateSpec(broken), SpecError);
  const noLength = clone();
  noLength.header.fields = noLength.header.fields.filter((f) => f.kind !== "length");
  assert.throws(() => validateSpec(noLength), SpecError);
  const little = clone();
  little.transport.byte_order = "little";
  assert.throws(() => validateSpec(little), SpecError);
  assert.equal(validateSpec(clone()).name, "n06-practice-sum");
});

test("명세 JSON: 연습 자료임이 명시돼 있고 예시가 인코더와 일치한다", () => {
  assert.equal(spec.experiment_score, false);
  assert.equal(spec.classification, "practice");
  assert.equal(spec.source.kind, "human-transcribed");
  assert.equal(spec.source.restored_from_traffic, false);
  for (const example of spec.examples) {
    assert.equal(toHex(encodeRequest(spec, example.input, { minCount: 1 }).bytes), example.request_hex);
    assert.equal(decodeResponse(spec, Buffer.from(example.response_hex, "hex")).ok, true);
  }
});
