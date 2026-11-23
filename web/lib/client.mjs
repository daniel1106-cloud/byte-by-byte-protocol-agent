// N08: 명세를 따르는 TCP 클라이언트. 요청 하나를 보내고 응답 프레임 하나를 읽는다.
// TCP는 메시지 경계가 없으므로 data 이벤트 하나를 응답 하나로 가정하지 않는다.
// 헤더 크기만큼 모은 뒤 헤더의 length만큼 더 모아서 프레임을 완성한다.
import net from "node:net";
import { decodeResponse, encodeRequest, headerSize, parseResponseHeader, toHex } from "./protocol.mjs";

export const OUTCOME_TEXT = {
  ok: "정상 응답",
  error_frame: "서버가 오류 프레임을 보냄",
  timeout: "시간 초과 (응답이 끝까지 오지 않음)",
  eof_no_response: "응답 없이 서버가 연결을 닫음 (EOF)",
  truncated: "응답이 도중에 끊김 (EOF)",
  protocol_violation: "명세와 다른 응답",
  connection_error: "연결 오류 (연결 뒤 끊김)",
  connect_failed: "연결 실패",
};

// 서버가 이보다 많이 보내면 명세와 다른 서버로 보고 끊는다.
const MAX_RECEIVED_BYTES = 4096;

/**
 * 반환값은 항상 객체이며 네트워크 문제로 reject하지 않는다. 입력이 잘못된 경우만 InputError를 던진다.
 * 결과의 outcome이 무슨 일이 있었는지를 말한다(OUTCOME_TEXT 참고).
 */
export async function sendRequest({ spec, numbers, host, port, timeoutMs = 3000, settleMs = 500, minCount }) {
  const request = encodeRequest(spec, numbers, { minCount });
  return new Promise((resolve) => {
    const started = process.hrtime.bigint();
    const socket = net.createConnection({ host, port });
    socket.setNoDelay(true);

    let received = Buffer.alloc(0);
    let connected = false;
    let serverClosed = false;
    let frame = null; // 헤더를 해석한 결과(parseResponseHeader)
    let complete = null; // 프레임을 다 모은 뒤의 해석 결과
    let finished = false;
    let settleTimer = null;
    const notes = [];

    const elapsedMs = () => Math.round(Number(process.hrtime.bigint() - started) / 1e4) / 100;

    const finish = (outcome, extra = {}) => {
      if (finished) return;
      finished = true;
      clearTimeout(deadline);
      clearTimeout(settleTimer);
      socket.destroy();
      const response = { bytes_received: received.length, hex: toHex(received) };
      if (complete) {
        response.frame_hex = complete.decoded.hex;
        response.decoded = complete.decoded;
        const trailing = received.subarray(complete.total);
        if (trailing.length) {
          response.trailing_hex = toHex(trailing);
          notes.push(`응답 프레임 뒤에 ${trailing.length}바이트가 더 왔습니다.`);
        }
      }
      resolve({
        outcome,
        outcome_text: OUTCOME_TEXT[outcome],
        ok: outcome === "ok",
        request: { message: request.message, hex: request.hex, fields: request.fields },
        response,
        connection: {
          host, port, connected,
          closed_by_server: connected ? serverClosed : null,
          ...(extra.error_code ? { error_code: extra.error_code } : {}),
        },
        ...(extra.violation ? { violation: extra.violation } : {}),
        ...(extra.error_message ? { error_message: extra.error_message } : {}),
        elapsed_ms: elapsedMs(),
        notes,
      });
    };

    const finishComplete = () => {
      const isError = complete.message.role === "error";
      finish(isError ? "error_frame" : "ok");
    };

    const consume = () => {
      if (received.length > MAX_RECEIVED_BYTES) {
        finish("protocol_violation", { violation: `서버가 ${MAX_RECEIVED_BYTES}바이트가 넘게 보냈습니다.` });
        return;
      }
      const size = headerSize(spec);
      if (!frame && received.length >= size) {
        const parsed = parseResponseHeader(spec, received.subarray(0, size));
        if (!parsed.ok) {
          finish("protocol_violation", { violation: parsed.reason });
          return;
        }
        frame = parsed;
      }
      if (frame && !complete && received.length >= frame.totalLength) {
        const decoded = decodeResponse(spec, received.subarray(0, frame.totalLength));
        if (!decoded.ok) {
          finish("protocol_violation", { violation: decoded.reason });
          return;
        }
        complete = { decoded, total: frame.totalLength, message: frame.message };
        // 프레임은 다 왔다. 서버가 연결을 닫는지, 뒤에 바이트가 더 오는지 잠깐만 지켜본다.
        if (serverClosed) finishComplete();
        else settleTimer = setTimeout(finishComplete, settleMs);
      }
    };

    const deadline = setTimeout(() => finish("timeout"), timeoutMs);

    socket.on("connect", () => {
      connected = true;
      socket.write(request.bytes);
    });
    socket.on("data", (chunk) => {
      if (finished) return;
      received = Buffer.concat([received, chunk]);
      consume();
    });
    socket.on("end", () => {
      if (finished) return;
      serverClosed = true;
      if (complete) finishComplete();
      else if (received.length === 0) finish("eof_no_response");
      else finish("truncated");
    });
    socket.on("error", (error) => {
      if (finished) return;
      if (complete) {
        // 응답은 이미 다 받았다. 그 뒤의 리셋은 기록만 한다.
        notes.push(`응답을 다 받은 뒤 연결 오류가 있었습니다 (${error.code ?? error.message}).`);
        finishComplete();
        return;
      }
      finish(connected ? "connection_error" : "connect_failed", { error_code: error.code, error_message: error.message });
    });
    socket.on("close", () => {
      if (finished) return;
      serverClosed = true;
      if (complete) finishComplete();
      else if (received.length === 0) finish("eof_no_response");
      else finish("truncated");
    });
  });
}
